/** Owner-scoped GitHub REST reads: one auth snapshot per operation, identity-isolated caches and bounded pagination. */
import { remoteDiff, validRange } from './diff.ts'
import type { GitRemoteAuth, GitRemoteSnapshot } from './auth.ts'
import { GitRemoteError } from './errors.ts'
import { GitRemoteHttp, GitRemoteHttpError, GIT_REMOTE_API_ORIGIN, GIT_REMOTE_WEB_ORIGIN, type GitRemoteHttpResponse } from './http.ts'
import { apiPath, avatarUrl, browserUrl, comment, commit, file, invalidResponse, issue, number, object, objectNumber, pull, repositoryPath, review, string } from './github-model.ts'
import type { RemotePage, RemotePageRequest, RemoteProvider, RemoteReadContext, RemoteRepository, RemoteRepositoryFacts, RemoteResult, RemoteWrite, RemoteWriteReceipt, RemoteNotice } from './provider.ts'
import type { GitRemoteGeneration, GitRemoteViewer, GitRemoteWriteContext } from './types.ts'

export function sameGeneration(a: GitRemoteGeneration, b: GitRemoteGeneration): boolean { return a.instanceId === b.instanceId && a.revision === b.revision }
interface CacheEntry { body: unknown; etag?: string; link: string | null }
interface Operation { snapshot: GitRemoteSnapshot; signal: AbortSignal; viewer?: GitRemoteViewer }
export class GitHubProvider implements RemoteProvider {
  readonly id = 'github'
  readonly apiOrigin = GIT_REMOTE_API_ORIGIN
  readonly webOrigin = GIT_REMOTE_WEB_ORIGIN
  private readonly cache = new Map<string, CacheEntry>()
  private viewer: Promise<GitRemoteViewer> | undefined
  private generation: GitRemoteGeneration | undefined
  private readonly pending = new Set<Promise<unknown>>()
  private readonly owner = new AbortController()
  private chain: Promise<unknown> = Promise.resolve()
  private blockedUntil = 0
  private failures = 0
  private pollIntervalMs = 60_000
  private readonly pollAfter = new Map<string, number>()
  private readonly now: () => number
  private readonly pageLimit: number

  constructor(private readonly auth: GitRemoteAuth, private readonly http: GitRemoteHttp, options: { now?: () => number; pageLimit?: number } = {}) {
    this.now = options.now ?? Date.now
    this.pageLimit = Math.max(1, Math.min(20, options.pageLimit ?? 10))
  }

  headRefspec(n: number): string { return `refs/pull/${objectNumber(n)}/head` }

  private operation<T>(repo: RemoteRepository, context: RemoteReadContext, work: (op: Operation) => Promise<T>, checkAfter = true): Promise<RemoteResult<T>> {
    if (this.owner.signal.aborted) return Promise.reject(new GitRemoteError('git/remote-unavailable', 'git-remote: provider is disposed'))
    repositoryPath(repo)
    const signal = AbortSignal.any([this.owner.signal, context.signal])
    const run = this.chain.then(async () => {
      signal.throwIfAborted()
      const snapshot = await this.auth.snapshot(signal)
      if (snapshot.state !== 'authenticated' && snapshot.state !== 'anonymous') throw new GitRemoteError(snapshot.state === 'signed-out' ? 'git/signed-out' : 'git/unauthenticated', 'git-remote: authentication needs repair')
      if (this.generation === undefined || !sameGeneration(this.generation, snapshot.generation)) {
        this.cache.clear(); this.pollAfter.clear(); this.viewer = undefined; this.blockedUntil = 0; this.failures = 0; this.generation = snapshot.generation
      }
      const key = repositoryPath(repo).toLowerCase()
      if (context.automatic === true) {
        if (snapshot.state === 'anonymous') throw new GitRemoteError('git/remote-unavailable', 'git-remote: anonymous reads require manual refresh')
        if (this.now() < (this.pollAfter.get(key) ?? 0)) throw this.rateError(this.pollAfter.get(key) ?? 0)
      }
      const op: Operation = { snapshot, signal }
      if (snapshot.state === 'authenticated') {
        this.viewer ??= this.loadViewer(op).catch(error => {
          this.viewer = undefined
          throw error
        })
        op.viewer = await this.viewer
      }
      const value = await work(op)
      if (checkAfter) signal.throwIfAborted()
      const current = checkAfter ? await this.auth.snapshot(signal) : snapshot
      if (!sameGeneration(snapshot.generation, current.generation)) {
        this.cache.clear(); this.viewer = undefined; this.generation = undefined
        throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: credentials changed during the operation')
      }
      this.pollAfter.set(key, Math.max(this.pollAfter.get(key) ?? 0, this.now() + this.pollIntervalMs))
      return { generation: snapshot.generation, value }
    })
    this.chain = run.catch(() => {})
    this.pending.add(run)
    void run.finally(() => this.pending.delete(run)).catch(() => {})
    return run
  }

  private rateError(resetAt: number): GitRemoteError { return new GitRemoteError('git/rate-limited', 'git-remote: request budget is temporarily exhausted', { resetAt }) }

  private async get(path: string, op: Operation): Promise<CacheEntry> {
    op.signal.throwIfAborted()
    if (this.now() < this.blockedUntil) throw this.rateError(this.blockedUntil)
    const safePath = apiPath(path)
    const key = JSON.stringify([this.apiOrigin, op.viewer?.userId ?? (op.snapshot.token === undefined ? 'anonymous' : 'viewer'), op.snapshot.generation, safePath])
    const cached = op.snapshot.token === undefined ? undefined : this.cache.get(key)
    const response = await this.http.request({ role: 'api', method: 'GET', path: safePath, signal: op.signal, headers: {
      accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(op.snapshot.token === undefined ? {} : { authorization: `Bearer ${op.snapshot.token}` }),
      ...(cached?.etag === undefined ? {} : { 'if-none-match': cached.etag }),
    } })
    this.checkStatus(response, op.snapshot)
    const interval = Number(response.headers.get('x-poll-interval'))
    if (interval > 0) this.pollIntervalMs = Math.max(this.pollIntervalMs, interval * 1000)
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      this.blockedUntil = Math.max(this.blockedUntil, Number.isFinite(reset) ? reset : this.now() + 60_000)
    }
    if (response.status === 304) return cached ?? invalidResponse()
    const etag = response.headers.get('etag')
    const entry: CacheEntry = { body: response.body, link: response.headers.get('link'), ...(etag === null ? {} : { etag }) }
    if (op.snapshot.token !== undefined) {
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value ?? '')
      this.cache.set(key, entry)
    }
    return entry
  }

  private checkStatus(response: GitRemoteHttpResponse, snapshot: GitRemoteSnapshot): void {
    const { status, headers } = response
    if (status === 401) {
      this.auth.markInvalid(snapshot); this.cache.clear()
      throw new GitRemoteError('git/unauthenticated', 'git-remote: credential rejected; repair authentication')
    }
    if (status === 429 || (status === 403 && (headers.get('retry-after') !== null || headers.get('x-ratelimit-remaining') === '0' || (typeof response.body === 'object' && response.body !== null && /secondary rate|rate limit/i.test(String(object(response.body)['message'])))))) {
      this.failures += 1
      const retry = headers.get('retry-after')
      const parsed = retry === null ? 0 : (/^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry))
      const reset = Number(headers.get('x-ratelimit-reset')) * 1000
      this.blockedUntil = Math.max(this.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(this.failures - 1, 6)), Number.isFinite(parsed) ? parsed : 0, Number.isFinite(reset) ? reset : 0)
      throw this.rateError(this.blockedUntil)
    }
    if (status === 403) throw new GitRemoteError('git/insufficient-scope', 'git-remote: provider denied access', { reason: headers.get('x-github-sso') === null ? 'permissions-or-scope' : 'sso-required' })
    if (status !== 304 && (status < 200 || status >= 300)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: provider read failed', { status })
    this.failures = 0
  }

  private async loadViewer(op: Operation): Promise<GitRemoteViewer> {
    const data = object((await this.get('/user', op)).body)
    const avatar = avatarUrl(data['avatar_url'])
    return { host: 'github.com', userId: String(number(data['id'])), login: string(data['login']), ...(typeof data['name'] !== 'string' ? {} : { name: data['name'] }), ...(avatar === undefined ? {} : { avatarUrl: avatar }) }
  }

  private async pages<T>(path: string, op: Operation, project: (value: unknown) => T, request: { include?: (value: unknown) => boolean; perPage?: number; cursor?: string; pages?: number } = {}): Promise<RemotePage<T>> {
    const items: T[] = []
    let next: string | undefined = request.cursor !== undefined ? apiPath(request.cursor) : path + (path.includes('?') ? '&' : '?') + `per_page=${request.perPage ?? 100}`
    const seen = new Set<string>()
    const budget = Math.max(1, Math.min(this.pageLimit, Math.floor(request.pages ?? 1)))
    for (let page = 0; next !== undefined && page < budget; page += 1) {
      const current = apiPath(next)
      if (seen.has(current)) return invalidResponse()
      seen.add(current)
      const result = await this.get(current, op)
      if (!Array.isArray(result.body)) return invalidResponse()
      items.push(...result.body.filter(request.include ?? (() => true)).map(project))
      next = undefined
      for (const link of (result.link ?? '').split(',')) {
        const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(link)
        if (match?.[1] !== undefined) next = apiPath(match[1])
      }
    }
    return { items, truncated: next !== undefined, ...(next === undefined ? {} : { next }) }
  }

  repository(repo: RemoteRepository, context: RemoteReadContext): Promise<RemoteResult<RemoteRepositoryFacts>> {
    return this.operation(repo, context, async (op) => {
      const data = object((await this.get(repositoryPath(repo), op)).body)
      const source = data['permissions'] == null ? {} : object(data['permissions'])
      const permissions = Object.fromEntries(['pull', 'triage', 'push', 'maintain', 'admin'].flatMap(key => typeof source[key] === 'boolean' ? [[key, source[key]]] : []))
      const authenticated = op.viewer !== undefined
      return { ...(op.viewer === undefined ? {} : { viewer: op.viewer }), permissions, actions: {
        canComment: authenticated ? true : false, canReview: authenticated ? true : false,
        canMerge: authenticated ? permissions['push'] as boolean | undefined ?? 'unknown' : false,
        canClose: authenticated ? permissions['push'] === true ? true : 'unknown' : false,
        canCreatePr: authenticated ? true : false,
      } }
    })
  }
  pulls(repo: RemoteRepository, state: 'open' | 'closed' | 'all', page: RemotePageRequest, context: RemoteReadContext) {
    return this.operation(repo, context, op => this.pages(`${repositoryPath(repo)}/pulls?state=${encodeURIComponent(state)}`, op, pull, page))
  }
  pull(repo: RemoteRepository, n: number, context: RemoteReadContext) {
    return this.operation(repo, context, async op => pull((await this.get(`${repositoryPath(repo)}/pulls/${objectNumber(n)}`, op)).body))
  }
  issues(repo: RemoteRepository, state: 'open' | 'closed' | 'all', page: RemotePageRequest, context: RemoteReadContext) {
    return this.operation(repo, context, op => this.pages(`${repositoryPath(repo)}/issues?state=${encodeURIComponent(state)}`, op, issue, { ...page, include: value => object(value)['pull_request'] === undefined }))
  }
  issue(repo: RemoteRepository, n: number, context: RemoteReadContext) {
    return this.operation(repo, context, async op => issue((await this.get(`${repositoryPath(repo)}/issues/${objectNumber(n)}`, op)).body))
  }
  comments(repo: RemoteRepository, n: number, inline: boolean, page: RemotePageRequest, context: RemoteReadContext) {
    return this.operation(repo, context, op => this.pages(`${repositoryPath(repo)}/${inline ? 'pulls' : 'issues'}/${objectNumber(n)}/comments`, op, comment, page))
  }
  files(repo: RemoteRepository, n: number, page: RemotePageRequest, context: RemoteReadContext) {
    return this.operation(repo, context, op => this.pages(`${repositoryPath(repo)}/pulls/${objectNumber(n)}/files`, op, file, page))
  }
  commits(repo: RemoteRepository, n: number, page: RemotePageRequest, context: RemoteReadContext) {
    return this.operation(repo, context, op => this.pages(`${repositoryPath(repo)}/pulls/${objectNumber(n)}/commits`, op, commit, page))
  }
  reviews(repo: RemoteRepository, n: number, page: RemotePageRequest, context: RemoteReadContext) {
    return this.operation(repo, context, op => this.pages(`${repositoryPath(repo)}/pulls/${objectNumber(n)}/reviews`, op, review, page))
  }
  notifications(repo: RemoteRepository, context: RemoteReadContext): Promise<RemoteResult<RemotePage<RemoteNotice>>> {
    return this.operation(repo, context, async op => {
      if (op.viewer === undefined) return { items: [], truncated: false }
      const prefix = repositoryPath(repo)
      const threads = await this.pages(`${prefix}/notifications`, op, object, { perPage: 50, pages: this.pageLimit })
      const items: RemoteNotice[] = []
      for (const thread of threads.items.slice(0, 10)) {
        const subject = object(thread['subject'])
        if (subject['type'] !== 'PullRequest' || typeof subject['url'] !== 'string') continue
        const path = apiPath(subject['url'])
        const match = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/pulls/([0-9]+)$', 'i').exec(path)
        if (match?.[1] === undefined) continue
        const pr = pull((await this.get(path, op)).body)
        const id = string(thread['id']) + '/' + string(thread['updated_at'])
        const base = { title: pr.title, ...(pr.url === undefined ? {} : { url: pr.url }) }
        if (thread['reason'] === 'review_requested') items.push({ ...base, id: id + '/review', kind: 'review-requested' })
        if (pr.author?.userId === op.viewer.userId) {
          if (pr.state === 'merged' || pr.state === 'closed') items.push({ ...base, id: id + '/' + pr.state, kind: pr.state })
          else {
            const reviews = await this.pages(`${path}/reviews`, op, object)
            for (const review of reviews.items) if (review['state'] === 'CHANGES_REQUESTED') items.push({ ...base, id: 'review/' + String(number(review['id'])), kind: 'changes-requested' })
          }
        }
      }
      return { items, truncated: threads.truncated || threads.items.length > 10 }
    })
  }
  write(repo: RemoteRepository, expected: GitRemoteWriteContext, command: RemoteWrite, context: RemoteReadContext): Promise<RemoteResult<RemoteWriteReceipt>> {
    return this.operation(repo, context, async op => {
      if (op.snapshot.token === undefined || op.viewer === undefined) throw new GitRemoteError('git/unauthenticated', 'git-remote: sign in before writing')
      if (!sameGeneration(expected.expectedGeneration, op.snapshot.generation) || expected.expectedViewer.host !== op.viewer.host || expected.expectedViewer.userId !== op.viewer.userId || expected.host !== repo.host || expected.owner.toLowerCase() !== repo.owner.toLowerCase() || expected.repo.toLowerCase() !== repo.repo.toLowerCase()) {
        throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: confirmation identity is stale')
      }
      const prefix = repositoryPath(repo)
      let path: string
      let method = 'POST'
      let payload: Record<string, unknown>
      if (command.kind === 'create-pr') {
        repositoryPath(command.head)
        if (command.head.host !== repo.host) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: unsupported fork host')
        // Require already pushed head/base branches. This path never pushes or creates a fork.
        await this.get(`${repositoryPath(command.head)}/branches/${encodeURIComponent(command.headRef)}`, op)
        await this.get(`${prefix}/branches/${encodeURIComponent(command.baseRef)}`, op)
        path = `${prefix}/pulls`
        payload = { title: command.title, body: command.body, head: `${command.head.owner}:${command.headRef}`, head_repo: command.head.repo, base: command.baseRef, draft: command.draft }
      } else {
        objectNumber(command.number)
        const pr = pull((await this.get(`${prefix}/pulls/${command.number}`, op)).body)
        if ('expectedHeadSha' in command && command.expectedHeadSha !== pr.head.sha) throw new GitRemoteError('git/head-moved', 'git-remote: pull head changed; refresh and confirm again')
        if (command.kind === 'merge-pr' || command.kind === 'close-pr') {
          const repoData = object((await this.get(prefix, op)).body)
          const permission = repoData['permissions'] == null ? {} : object(repoData['permissions'])
          if (permission['push'] === false && (command.kind === 'merge-pr' || pr.author?.userId !== op.viewer.userId)) throw new GitRemoteError('git/insufficient-scope', 'git-remote: repository permission denies this action')
        }
        path = `${prefix}/pulls/${command.number}`
        switch (command.kind) {
          case 'comment': path = `${prefix}/issues/${command.number}/comments`; payload = { body: command.body }; break
          case 'inline-comment':
            if (command.line < 1 || !Number.isSafeInteger(command.line) || (command.side !== 'LEFT' && command.side !== 'RIGHT') || command.path === '' || (command.startLine !== undefined && (!Number.isSafeInteger(command.startLine) || command.startLine < 1 || command.startLine > command.line || command.startSide !== command.side))) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid inline coordinates')
            {
              const files = await this.pages(`${prefix}/pulls/${command.number}/files`, op, file, { pages: this.pageLimit })
              const selected = files.items.find(entry => entry.path === command.path)
              const diff = selected === undefined ? undefined : remoteDiff(selected, pr.base.sha, pr.head.sha)
              const end = diff?.lines.find(line => line.anchor?.line === command.line && line.anchor.side === command.side)?.anchor
              const start = command.startLine === undefined ? end : diff?.lines.find(line => line.anchor?.line === command.startLine && line.anchor?.side === command.startSide)?.anchor
              if (files.truncated || !diff?.safe || end === undefined || start === undefined || !validRange(start, end)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: inline coordinates are ambiguous or incomplete')
            }
            path += '/comments'
            payload = { body: command.body, path: command.path, commit_id: command.expectedHeadSha, line: command.line, side: command.side, ...(command.startLine === undefined ? {} : { start_line: command.startLine, start_side: command.startSide }) }; break
          case 'review': path += '/reviews'; payload = { body: command.body, event: command.event, commit_id: command.expectedHeadSha }; break
          case 'close-pr': method = 'PATCH'; payload = { state: 'closed' }; break
          case 'merge-pr': method = 'PUT'; path += '/merge'; payload = { sha: command.expectedHeadSha, merge_method: command.method }; break
        }
      }
      // Resolve only to compare with the checked snapshot. The HTTP call below always uses op.snapshot.token.
      await context.beforeSend?.()
      const current = await this.auth.snapshot(op.signal)
      if (!sameGeneration(current.generation, op.snapshot.generation) || current.token !== op.snapshot.token) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: credentials changed before sending')
      op.signal.throwIfAborted()
      let response: GitRemoteHttpResponse
      let sent = false
      try {
        response = await this.http.request({ role: 'api', method, path, signal: op.signal, onSend: () => { sent = true }, headers: { accept: 'application/vnd.github+json', 'content-type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', authorization: `Bearer ${op.snapshot.token}` }, body: JSON.stringify(payload) })
      } catch (error) {
        if (!sent || error instanceof GitRemoteHttpError && error.kind === 'not-sent') throw error
        throw new GitRemoteError('git/write-result-unknown', 'git-remote: write result is unknown; refresh the affected object before continuing', { action: command.kind, ...('number' in command ? { number: command.number } : {}) })
      }
      if (response.status >= 500) throw new GitRemoteError('git/write-result-unknown', 'git-remote: provider write result is unknown', { action: command.kind })
      if (command.kind === 'merge-pr' && (response.status === 409 || response.status === 422)) throw new GitRemoteError('git/head-moved', 'git-remote: merge precondition rejected; refresh and confirm again')
      this.checkStatus(response, op.snapshot)
      this.cache.clear()
      let body: Record<string, unknown>
      try { body = object(response.body) } catch { throw new GitRemoteError('git/write-result-unknown', 'git-remote: write succeeded without a usable receipt; refresh the affected object') }
      const url = browserUrl(body['html_url'])
      return { ...(typeof body['id'] !== 'number' ? {} : { id: String(number(body['id'])) }), ...(typeof body['number'] !== 'number' ? {} : { number: number(body['number']) }), ...(url === undefined ? {} : { url }), ...(typeof body['merged'] !== 'boolean' ? {} : { merged: body['merged'] }) }
    }, false)
  }
  async dispose(): Promise<void> {
    this.owner.abort()
    await Promise.allSettled([...this.pending])
    this.cache.clear(); this.viewer = undefined; this.pollAfter.clear()
  }
}
