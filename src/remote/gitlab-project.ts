/** GitLab reads are authorized against local remotes and one credential snapshot. */
import { createHash } from 'node:crypto'
import type { GitLabAuth, GitLabAuthSnapshot } from './gitlab-auth.ts'
import { GitRemoteError } from './errors.ts'
import { GitRemoteGit, type RemoteCheckoutReceipt, type RemoteGitRun } from './git.ts'
import { gitLabPrivateRef } from './gitlab-git.ts'
import { GitRemoteHttpError, gitLabContinuation, type GitRemoteHttp, type GitRemoteHttpResponse } from './http.ts'
import { gitLabApprovals, gitLabCommit, gitLabDiscussion, gitLabFile, gitLabIssue, gitLabNote, gitLabPull, gitLabWebUrl } from './gitlab-model.ts'
import { gitLabRepositoryFacts } from './gitlab-facts.ts'
import { GitLabCursorStore, type GitLabCursorBinding } from './gitlab-read-boundaries.ts'
import type { GitLabInstance } from './instances.ts'
import type { ScopedRequestContext } from './registry.ts'
import type { RemotePage, ScopedRemoteApprovalFacts, ScopedRemoteCommit, ScopedRemoteDiscussion, ScopedRemoteFile, ScopedRemoteIssue, ScopedRemoteNote, ScopedRemoteNotice, ScopedRemotePull, ScopedRemoteRepositoryFacts } from './provider.ts'
import type { ScopedRemoteResult } from './types.ts'

function invalid(reason: string): GitRemoteError { return new GitRemoteError('git/remote-unavailable', 'git-remote: GitLab read failed', { reason }) }
function projectId(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
  return typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value) ? value : undefined
}
function limitDeadline(headers: { get(name: string): string | null }, now: number): number {
  const retry = headers.get('retry-after'), seconds = retry === null ? NaN : Number(retry), date = retry === null ? NaN : Date.parse(retry)
  const reset = Number(headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset')) * 1000
  return Math.max(now + 60_000, Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : 0, Number.isFinite(date) ? date : 0, Number.isFinite(reset) ? reset : 0)
}
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
interface Operation { readonly snapshot: GitLabAuthSnapshot; readonly signal: AbortSignal; readonly projectId: string; readonly path: string; readonly project: Record<string, unknown>; readonly query: string; readonly revalidate: (name?: 'origin' | 'upstream') => Promise<'origin' | 'upstream'>; readonly authorizePath: (path: string, name?: 'origin' | 'upstream') => Promise<'origin' | 'upstream'>; readonly comparison?: string }
interface RequestBudget { blockedUntil: number; failures: number; pollInterval: number }
interface CacheEntry { readonly body: unknown; readonly link: string | null; readonly nextPage: string | null; readonly etag?: string }
interface Submission { readonly fingerprint: string; readonly projectId: string; readonly result: Promise<unknown>; state: 'pending' | 'completed' | 'failed' | 'unknown' }
interface ExpectedMutation { readonly instanceId: string; readonly revision: number; readonly host: string; readonly userId: string; readonly requestId: string }
interface CheckoutOutcome { readonly outcome: 'succeeded' | 'partial' | 'unknown'; readonly steps: readonly { readonly kind: string; readonly state: 'succeeded' | 'failed' | 'unknown' | 'not-sent' }[]; readonly receipt: RemoteCheckoutReceipt }
interface IssueBranchOutcome { readonly outcome: 'succeeded' | 'partial'; readonly steps: readonly { readonly kind: string; readonly state: 'succeeded' | 'failed' | 'unknown' | 'not-sent' }[]; readonly receipt: { readonly branch: string; readonly created: boolean; readonly switched: boolean; readonly head?: string; readonly error?: 'dirty' | 'branch-conflict' | 'head-moved' | 'git-transport-or-local-failure' } }
interface WriteOutcome { readonly outcome: 'succeeded' | 'partial'; readonly steps: readonly { readonly kind: string; readonly state: 'succeeded' | 'failed' | 'unknown' | 'not-sent'; readonly id?: string; readonly reason?: string }[]; readonly receipt?: { readonly id?: string; readonly number?: number; readonly url?: string; readonly merged?: boolean; readonly error?: string } }

/** Do not turn a completed side effect into a retryable ordinary error when its context changes. */
export function interruptedGitLabMutation(endpoint: string, request: Record<string, unknown>, value: unknown): GitRemoteError | undefined {
  const actions: Readonly<Record<string, string>> = { 'remote-comment': 'comment', 'remote-review': 'review', 'remote-close-pr': 'close-pr', 'remote-merge-pr': 'merge-pr', 'remote-create-pr': 'create-pr', 'remote-checkout-pr': 'remote-checkout-pr', 'remote-issue-branch': 'remote-issue-branch' }
  const action = actions[endpoint], result = record(value)
  if (action === undefined || !Array.isArray(result?.['steps'])) return undefined
  const steps = result['steps'].map(record).filter((step): step is Record<string, unknown> => step !== undefined)
  if (!steps.some(step => step['state'] === 'succeeded' || step['state'] === 'unknown')) return undefined
  const comment = endpoint === 'remote-review' ? steps.find(step => step['kind'] === 'comment' && step['state'] === 'succeeded') : undefined
  const commentId = projectId(comment?.['id']), number = request['number']
  return new GitRemoteError('git/write-result-unknown', 'git-remote: operation completed but its context changed; refresh the affected object', { action, ...(typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? { number } : {}), ...(comment === undefined ? {} : { stage: 'approve', commentSucceeded: true, ...(commentId === undefined ? {} : { commentId }) }) })
}

export class GitLabProjectReader {
  private readonly budgets = new Map<string, RequestBudget>()
  private generationKey = ''
  private readonly pollAfter = new Map<string, number>()
  private readonly cache = new Map<string, CacheEntry>()
  private readonly cursors = new GitLabCursorStore()
  private readonly submissions = new Map<string, Submission>()
  private readonly submissionIndex = new Map<string, string>()
  private readonly git: GitRemoteGit
  constructor(private readonly instance: GitLabInstance, private readonly auth: GitLabAuth, private readonly http: GitRemoteHttp, private readonly run: RemoteGitRun, private readonly now: () => number = Date.now) { this.git = new GitRemoteGit(run) }

  private budget(snapshot: GitLabAuthSnapshot): RequestBudget {
    // Never retain a raw token as a map key or expose this Host-only fingerprint.
    const key = snapshot.token === undefined ? 'anonymous' : createHash('sha256').update(snapshot.token).digest('hex')
    const current = this.budgets.get(key)
    if (current !== undefined) return current
    // Keep the same budget across generation changes and in-flight credential switches.
    const budget = { blockedUntil: 0, failures: 0, pollInterval: 60_000 }
    this.budgets.set(key, budget)
    return budget
  }
  private checkBudget(snapshot: GitLabAuthSnapshot): void {
    const budget = this.budget(snapshot)
    if (this.now() < budget.blockedUntil) throw new GitRemoteError('git/rate-limited', 'git-remote: request budget is temporarily exhausted', { resetAt: budget.blockedUntil })
  }
  private checkResponse(response: GitRemoteHttpResponse, snapshot: GitLabAuthSnapshot): void {
    if (response.status === 401 && snapshot.token !== undefined) { this.auth.markInvalid(snapshot); throw new GitRemoteError('git/unauthenticated', 'git-remote: authentication needs repair') }
    const budget = this.budget(snapshot)
    const now = this.now(), remaining = response.headers.get('ratelimit-remaining') ?? response.headers.get('x-ratelimit-remaining')
    if (response.status === 429 || response.status >= 500 || (response.status === 403 && (remaining === '0' || response.headers.get('retry-after') !== null))) {
      budget.failures++
      budget.blockedUntil = Math.max(budget.blockedUntil, limitDeadline(response.headers, now), now + Math.min(3_600_000, 60_000 * 2 ** Math.min(budget.failures - 1, 6)))
      throw new GitRemoteError('git/rate-limited', 'git-remote: request budget is temporarily exhausted', { resetAt: budget.blockedUntil })
    }
    if (remaining === '0') budget.blockedUntil = Math.max(budget.blockedUntil, limitDeadline(response.headers, now))
    const interval = Number(response.headers.get('x-poll-interval'))
    if (Number.isFinite(interval) && interval > 0) budget.pollInterval = Math.max(budget.pollInterval, interval * 1000)
    if (response.status === 403) throw new GitRemoteError('git/insufficient-scope', 'git-remote: provider denied access')
    if (response.status !== 304 && response.status !== 200) throw invalid('read-failed')
    budget.failures = 0
  }
  private headers(snapshot: GitLabAuthSnapshot): Record<string, string> {
    return { accept: 'application/json', ...(snapshot.token === undefined ? {} : { authorization: `Bearer ${snapshot.token}` }) }
  }
  private async operation<T>(request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined, pollKey: string, work: (op: Operation) => Promise<T>, interrupted?: (value: T) => GitRemoteError | undefined): Promise<ScopedRemoteResult<T>> {
    if (context === undefined) throw invalid('session-guard-missing')
    const path = request['path']
    if (typeof path !== 'string' || path.length === 0) throw invalid('invalid-request')
    const suppliedId = request['projectId'] === undefined ? undefined : projectId(request['projectId'])
    if (request['projectId'] !== undefined && suppliedId === undefined) throw invalid('invalid-project-id')
    const scope = { provider: 'gitlab' as const, instance: this.instance.instance }
    await context.assertRepository(scope, path, request, signal)
    const snapshot = await this.auth.snapshot(signal)
    if (snapshot.state !== 'authenticated' && snapshot.state !== 'anonymous') throw new GitRemoteError(snapshot.state === 'signed-out' ? 'git/signed-out' : 'git/unauthenticated', 'git-remote: authentication needs repair')
    const operationSignal = AbortSignal.any([signal, snapshot.signal]), generationKey = JSON.stringify(snapshot.generation)
    if (generationKey !== this.generationKey) { this.generationKey = generationKey; this.pollAfter.clear(); this.cache.clear(); this.cursors.clear() }
    if (request['automatic'] === true && snapshot.state === 'anonymous') throw invalid('anonymous-manual-only')
    const key = JSON.stringify([path, pollKey]), waitUntil = request['automatic'] === true ? this.pollAfter.get(key) ?? 0 : 0
    if (this.now() < waitUntil) throw new GitRemoteError('git/rate-limited', 'git-remote: request budget is temporarily exhausted', { resetAt: waitUntil })
    this.checkBudget(snapshot)
    // Reserve the interval before the first await so simultaneous polls cannot bypass it.
    this.pollAfter.set(key, Math.max(this.pollAfter.get(key) ?? 0, this.now() + this.budget(snapshot).pollInterval))
    const response = await this.http.gitLabProjectLookup(path, this.headers(snapshot), operationSignal)
    operationSignal.throwIfAborted(); this.checkResponse(response, snapshot)
    if (response.status !== 200 || typeof response.body !== 'object' || response.body === null || Array.isArray(response.body)) throw invalid('invalid-project-response')
    const body = response.body as Record<string, unknown>, resolvedId = projectId(body['id'])
    if (resolvedId === undefined || body['path_with_namespace'] !== path) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: project identity changed')
    if (suppliedId !== undefined && suppliedId !== resolvedId) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: project identifier does not match the local remote')
    const authorizePath = async (remotePath: string, name?: 'origin' | 'upstream') => { const remote = await context.assertRepository(scope, remotePath, request, operationSignal, name); operationSignal.throwIfAborted(); this.auth.assertGeneration(snapshot.generation); return remote.name }
    const revalidate = (name?: 'origin' | 'upstream') => authorizePath(path, name)
    const value = await work({ snapshot, signal: operationSignal, projectId: resolvedId, path, project: body, query: pollKey, revalidate, authorizePath })
    try {
      await context.assertRepository(scope, path, request, operationSignal)
      const current = await this.auth.snapshot(operationSignal)
      if (current.generation.instanceId !== snapshot.generation.instanceId || current.generation.revision !== snapshot.generation.revision) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: credentials changed during the operation')
      operationSignal.throwIfAborted()
    } catch (error) { throw interrupted?.(value) ?? error }
    this.pollAfter.set(key, Math.max(this.pollAfter.get(key) ?? 0, this.now() + this.budget(snapshot).pollInterval))
    return { generation: snapshot.generation, value }
  }
  private async get(path: string, op: Operation, fresh = false): Promise<CacheEntry> {
    await op.revalidate()
    this.checkBudget(op.snapshot)
    const cacheKey = JSON.stringify([this.instance.instance, op.snapshot.viewer?.userId ?? 'anonymous', op.snapshot.generation, op.projectId, op.path, op.query, path, op.comparison ?? ''])
    const previous = fresh || op.snapshot.token === undefined ? undefined : this.cache.get(cacheKey)
    const response = await this.http.request({ role: 'api', method: 'GET', path, signal: op.signal, headers: { ...this.headers(op.snapshot), ...(previous?.etag === undefined ? {} : { 'if-none-match': previous.etag }) } })
    op.signal.throwIfAborted(); this.checkResponse(response, op.snapshot)
    if (response.status === 304) {
      if (previous === undefined || previous.etag === undefined) throw invalid('invalid-not-modified')
      const refreshed: CacheEntry = { ...previous, link: response.headers.get('link') ?? previous.link, nextPage: response.headers.get('x-next-page') ?? previous.nextPage }
      this.cache.set(cacheKey, refreshed)
      return refreshed
    }
    const rawTag = response.headers.get('etag'), etag = rawTag !== null && /^(?:W\/)?"[^"\x00-\x1f\x7f]{1,512}"$/u.test(rawTag) ? rawTag : undefined
    const entry: CacheEntry = { body: response.body, link: response.headers.get('link'), nextPage: response.headers.get('x-next-page'), ...(etag === undefined ? {} : { etag }) }
    if (op.snapshot.token !== undefined) {
      this.cache.delete(cacheKey); this.cache.set(cacheKey, entry)
      if (this.cache.size > 128) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest) }
    }
    return entry
  }
  private next(current: string, entry: CacheEntry): string | undefined {
    // A stripped pagination header must not masquerade as a complete list.
    if (entry.link === null && entry.nextPage === null) throw invalid('pagination-unavailable')
    let next: string | undefined
    if (entry.link !== null && entry.link !== '') {
      for (const part of entry.link.split(',')) {
        const match = /^\s*<([^>]+)>\s*;\s*rel="([a-z]+)"\s*$/u.exec(part)
        if (match === null || match[1] === undefined) throw invalid('invalid-link')
        const validated = gitLabContinuation(this.instance.instance, current, match[1], match[2] === 'next' ? 'next' : 'any')
        if (match[2] === 'next') {
          if (next !== undefined) throw invalid('invalid-link')
          next = validated
        }
      }
    }
    if (entry.nextPage !== null && entry.nextPage !== '') {
      if (!/^[1-9][0-9]*$/u.test(entry.nextPage)) throw invalid('invalid-link')
      const url = new URL(current, this.instance.instance); url.searchParams.set('page', entry.nextPage)
      const fromHeader = gitLabContinuation(this.instance.instance, current, url.pathname + url.search)
      if (next !== undefined && next !== fromHeader) throw invalid('invalid-link')
      next = fromHeader
    }
    return next
  }
  private async approvalPolicy(op: Operation): Promise<boolean | 'unknown'> {
    if (op.snapshot.token === undefined) return 'unknown'
    await op.revalidate(); this.checkBudget(op.snapshot)
    let response: GitRemoteHttpResponse
    try { response = await this.http.request({ role: 'api', method: 'GET', path: `${this.instance.prefix}/api/v4/projects/${op.projectId}/approvals`, headers: this.headers(op.snapshot), signal: op.signal }) }
    catch { op.signal.throwIfAborted(); return 'unknown' }
    op.signal.throwIfAborted()
    const remaining = response.headers.get('ratelimit-remaining') ?? response.headers.get('x-ratelimit-remaining')
    if (response.status === 404 || (response.status === 403 && remaining !== '0' && response.headers.get('retry-after') === null)) return 'unknown'
    this.checkResponse(response, op.snapshot)
    const data = record(response.body)
    if (response.status !== 200 || data === undefined) return 'unknown'
    const newer = data['require_reauthentication_to_approve'], older = data['require_password_to_approve']
    if (newer === true || older === true) return true
    if (newer === false || older === false) return false
    return 'unknown'
  }
  private async approvalPermission(op: Operation, number: number): Promise<{ permission: boolean | 'unknown'; reauthentication: boolean | 'unknown' }> {
    if (op.snapshot.token === undefined) return { permission: false, reauthentication: 'unknown' }
    await op.revalidate(); this.checkBudget(op.snapshot)
    let response: GitRemoteHttpResponse
    try { response = await this.http.request({ role: 'api', method: 'GET', path: `${this.instance.prefix}/api/v4/projects/${op.projectId}/merge_requests/${number}/approvals`, headers: this.headers(op.snapshot), signal: op.signal }) }
    catch { op.signal.throwIfAborted(); return { permission: 'unknown', reauthentication: 'unknown' } }
    op.signal.throwIfAborted()
    const remaining = response.headers.get('ratelimit-remaining') ?? response.headers.get('x-ratelimit-remaining')
    if (response.status === 404 || (response.status === 403 && remaining !== '0' && response.headers.get('retry-after') === null)) return { permission: 'unknown', reauthentication: 'unknown' }
    this.checkResponse(response, op.snapshot)
    const data = record(response.body)
    if (response.status !== 200 || data === undefined || (data['project_id'] !== undefined && projectId(data['project_id']) !== op.projectId) || (data['iid'] !== undefined && data['iid'] !== number)) return { permission: 'unknown', reauthentication: 'unknown' }
    const permission = data['user_has_approved'] === true ? false : typeof data['user_can_approve'] === 'boolean' ? data['user_can_approve'] : 'unknown'
    return { permission, reauthentication: data['require_password_to_approve'] === true ? true : 'unknown' }
  }
  private async actionFacts(op: Operation, target?: { readonly kind: 'pull' | 'issue'; readonly number: number }): Promise<ScopedRemoteRepositoryFacts> {
    let objectFact: Parameters<typeof gitLabRepositoryFacts>[0]['object']
    if (target !== undefined) {
      const path = `${this.instance.prefix}/api/v4/projects/${op.projectId}/${target.kind === 'pull' ? 'merge_requests' : 'issues'}/${target.number}`
      const raw = record((await this.get(path, op, true)).body)
      if (raw === undefined) throw invalid('invalid-response')
      if (target.kind === 'pull') {
        const value = gitLabPull(raw, this.instance.instance, op.projectId)
        if (value.number !== target.number) throw invalid('invalid-object')
        objectFact = { kind: 'pull', value, raw }
      } else {
        const value = gitLabIssue(raw, this.instance.instance, op.projectId)
        if (value.number !== target.number) throw invalid('invalid-object')
        objectFact = { kind: 'issue', value, raw }
      }
    }
    const featureEnabled = ['enabled', 'private', 'public'].includes(String(op.project['merge_requests_access_level']))
    let approvalReauthentication: boolean | 'unknown' = featureEnabled ? await this.approvalPolicy(op) : 'unknown'
    const approval = featureEnabled && target?.kind === 'pull' ? await this.approvalPermission(op, target.number) : { permission: 'unknown' as const, reauthentication: 'unknown' as const }
    if (approval.reauthentication === true) approvalReauthentication = true
    return gitLabRepositoryFacts({ path: op.path, projectId: op.projectId, project: op.project, ...(op.snapshot.viewer === undefined ? {} : { viewer: op.snapshot.viewer }), ...(objectFact === undefined ? {} : { object: objectFact }), approvalReauthentication, approvalPermission: approval.permission })
  }
  repository(request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<ScopedRemoteRepositoryFacts>> {
    const rawObject = request['object'] === undefined ? undefined : record(request['object'])
    if (request['object'] !== undefined && (rawObject === undefined || (rawObject['kind'] !== 'pull' && rawObject['kind'] !== 'issue') || typeof rawObject['number'] !== 'number' || !Number.isSafeInteger(rawObject['number']) || rawObject['number'] < 1)) throw invalid('invalid-request')
    const target = rawObject === undefined ? undefined : { kind: rawObject['kind'] as 'pull' | 'issue', number: rawObject['number'] as number }
    return this.operation(request, signal, context, JSON.stringify(['repository', target ?? null]), op => this.actionFacts(op, target))
  }
  detail(kind: 'pulls' | 'issues', request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<ScopedRemotePull | ScopedRemoteIssue>> {
    const number = request['number']
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw invalid('invalid-object')
    return this.operation(request, signal, context, JSON.stringify([kind, number]), async op => {
      const apiPath = `${this.instance.prefix}/api/v4/projects/${op.projectId}/${kind === 'pulls' ? 'merge_requests' : 'issues'}/${number}`
      const entry = await this.get(apiPath, op)
      const value = kind === 'pulls' ? gitLabPull(entry.body, this.instance.instance, op.projectId) : gitLabIssue(entry.body, this.instance.instance, op.projectId)
      if (value.number !== number) throw invalid('invalid-object')
      return value
    })
  }
  private async page<T>(op: Operation, request: Record<string, unknown>, initial: string, query: string, project: (value: unknown) => T, include: (value: T) => boolean = () => true, snapshot = ''): Promise<RemotePage<T>> {
    const rawPages = request['pages'] === undefined ? 1 : request['pages']
    if (typeof rawPages !== 'number' || !Number.isSafeInteger(rawPages) || rawPages < 1) throw invalid('invalid-query')
    const pages = Math.min(rawPages, 10), cursor = request['cursor'], root = request['repository'], session = request['sessionId']
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 200)) throw invalid('invalid-cursor')
    if (typeof root !== 'string' || (session !== undefined && (typeof session !== 'string' || session.length > 1024))) throw invalid('invalid-request')
    const binding: GitLabCursorBinding = { instance: this.instance.instance, projectId: op.projectId, path: op.path, viewer: op.snapshot.viewer?.userId ?? 'anonymous', generation: op.snapshot.generation, query: JSON.stringify([initial, query]), snapshot, root, session: session ?? '' }
    let current: string | undefined = typeof cursor === 'string' ? this.cursors.resolve(cursor, binding) : initial
    const items: T[] = [], seen = new Set<string>()
    for (let page = 0; current !== undefined && page < pages; page++) {
      if (seen.has(current)) throw invalid('invalid-link')
      seen.add(current)
      const entry = await this.get(current, op)
      if (!Array.isArray(entry.body) || entry.body.length > 50) throw invalid('invalid-response')
      for (const raw of entry.body) { const item = project(raw); if (include(item)) items.push(item) }
      current = this.next(current, entry)
    }
    const next = current === undefined ? undefined : this.cursors.issue(binding, current)
    return { items, truncated: next !== undefined, ...(next === undefined ? {} : { next }) }
  }
  list(kind: 'pulls' | 'issues', request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<RemotePage<ScopedRemotePull | ScopedRemoteIssue>>> {
    const state = request['state'] === undefined ? 'open' : request['state']
    if (state !== 'open' && state !== 'closed' && state !== 'all') throw invalid('invalid-query')
    return this.operation(request, signal, context, JSON.stringify([kind, state]), async op => {
      const initial = `${this.instance.prefix}/api/v4/projects/${op.projectId}/${kind === 'pulls' ? 'merge_requests' : 'issues'}?state=all&per_page=50&page=1`
      return this.page<ScopedRemotePull | ScopedRemoteIssue>(op, request, initial, state,
        raw => kind === 'pulls' ? gitLabPull(raw, this.instance.instance, op.projectId) : gitLabIssue(raw, this.instance.instance, op.projectId),
        item => state === 'all' || (state === 'open' && item.state === 'open') || (state === 'closed' && (item.state === 'closed' || item.state === 'merged')))
    })
  }
  collection(kind: 'commits' | 'comments' | 'discussions', request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<RemotePage<ScopedRemoteCommit | ScopedRemoteNote | ScopedRemoteDiscussion>>> {
    const number = request['number'], objectKind = kind === 'commits' ? 'pull' : request['objectKind']
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || (objectKind !== 'pull' && objectKind !== 'issue') || (kind === 'comments' && request['inline'] === true)) throw invalid('invalid-object')
    return this.operation(request, signal, context, JSON.stringify([kind, objectKind, number]), async op => {
      const initial = `${this.instance.prefix}/api/v4/projects/${op.projectId}/${objectKind === 'pull' ? 'merge_requests' : 'issues'}/${number}/${kind === 'comments' ? 'notes' : kind}?per_page=50&page=1`
      return this.page<ScopedRemoteCommit | ScopedRemoteNote | ScopedRemoteDiscussion>(op, request, initial, JSON.stringify([kind, objectKind, number]), raw => kind === 'commits' ? gitLabCommit(raw, this.instance.instance) : kind === 'comments' ? gitLabNote(raw, this.instance.instance) : gitLabDiscussion(raw, this.instance.instance))
    })
  }
  approvals(request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<ScopedRemoteApprovalFacts>> {
    const number = request['number']
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw invalid('invalid-object')
    return this.operation(request, signal, context, JSON.stringify(['approvals', number]), async op => {
      const path = `${this.instance.prefix}/api/v4/projects/${op.projectId}/merge_requests/${number}/approvals`
      return gitLabApprovals((await this.get(path, op)).body, this.instance.instance, op.projectId, number)
    })
  }
  notifications(request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<RemotePage<ScopedRemoteNotice>>> {
    return this.operation(request, signal, context, JSON.stringify(['review-requested']), async op => {
      if (op.snapshot.state !== 'authenticated' || op.snapshot.viewer === undefined) throw new GitRemoteError('git/unauthenticated', 'git-remote: authentication is required for notifications')
      const initial = `${this.instance.prefix}/api/v4/todos?project_id=${op.projectId}&state=pending&action=review_requested&type=MergeRequest&per_page=50&page=1`
      const projected = await this.page<ScopedRemoteNotice | null>(op, request, initial, 'review-requested', raw => {
        const todo = record(raw), project = record(todo?.['project']), target = record(todo?.['target'])
        if (todo?.['action_name'] !== 'review_requested' || todo['state'] !== 'pending' || todo['target_type'] !== 'MergeRequest' || projectId(project?.['id']) !== op.projectId || project?.['path_with_namespace'] !== op.path || projectId(target?.['project_id']) !== op.projectId || (target?.['target_project_id'] !== undefined && projectId(target['target_project_id']) !== op.projectId) || target?.['state'] !== 'opened') return null
        const id = projectId(todo['id']), objectId = projectId(target['id']), number = target['iid'], title = target['title'], updatedAt = todo['updated_at']
        if (id === undefined || objectId === undefined || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || typeof title !== 'string' || title.length > 65536 || (updatedAt !== undefined && (typeof updatedAt !== 'string' || updatedAt.length > 100 || /[\x00-\x1f\x7f]/u.test(updatedAt)))) return null
        const url = gitLabWebUrl(this.instance.instance, todo['target_url'])
        return { id, projectId: op.projectId, objectId, number, kind: 'review-requested', title, state: 'pending', ...(typeof updatedAt === 'string' ? { updatedAt } : {}), ...(url === undefined ? {} : { url }) }
      })
      return { ...projected, items: projected.items.filter((item): item is ScopedRemoteNotice => item !== null) }
    })
  }
  files(request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<{ files: RemotePage<ScopedRemoteFile>; baseSha: string; startSha: string; headSha: string; serverCompleteness: 'unknown' }>> {
    const number = request['number']
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw invalid('invalid-object')
    const expected = [request['expectedBaseSha'], request['expectedStartSha'], request['expectedHeadSha']]
    if (expected.some(value => value !== undefined && (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))) || (request['cursor'] !== undefined && expected.some(value => value === undefined))) throw invalid('invalid-comparison')
    return this.operation(request, signal, context, JSON.stringify(['files', number]), async op => {
      const mrPath = `${this.instance.prefix}/api/v4/projects/${op.projectId}/merge_requests/${number}`
      const readSnapshot = async () => {
        const pull = gitLabPull((await this.get(mrPath, op)).body, this.instance.instance, op.projectId)
        if (pull.number !== number) throw invalid('invalid-object')
        const refs = pull.diffRefs
        if (refs?.baseSha == null || refs.startSha == null || refs.headSha == null || pull.head.sha == null) throw invalid('comparison-unavailable')
        if (refs.headSha !== pull.head.sha) throw new GitRemoteError('git/head-moved', 'git-remote: comparison is not ready')
        return { baseSha: refs.baseSha, startSha: refs.startSha, headSha: refs.headSha }
      }
      const before = await readSnapshot()
      if ((expected[0] !== undefined && expected[0] !== before.baseSha) || (expected[1] !== undefined && expected[1] !== before.startSha) || (expected[2] !== undefined && expected[2] !== before.headSha)) throw new GitRemoteError('git/head-moved', 'git-remote: comparison changed during loading')
      const snapshot = JSON.stringify([before.baseSha, before.startSha, before.headSha])
      const initial = `${mrPath}/diffs?per_page=50&page=1`
      const files = await this.page({ ...op, comparison: snapshot }, request, initial, JSON.stringify(['files', number]), gitLabFile, () => true, snapshot)
      const after = await readSnapshot()
      if (before.baseSha !== after.baseSha || before.startSha !== after.startSha || before.headSha !== after.headSha) throw new GitRemoteError('git/head-moved', 'git-remote: comparison changed during loading')
      // GitLab may cap diff results independently of pagination without an overflow flag here.
      return { files, ...before, serverCompleteness: 'unknown' as const }
    })
  }
  private expected(request: Record<string, unknown>): ExpectedMutation {
    const generation = record(request['expectedGeneration']), viewer = record(request['expectedViewer']), requestId = request['requestId']
    if (request['expectedInstance'] !== this.instance.instance || typeof generation?.['instanceId'] !== 'string' || !generation['instanceId'] || typeof generation['revision'] !== 'number' || !Number.isSafeInteger(generation['revision']) || generation['revision'] < 0 || typeof viewer?.['host'] !== 'string' || typeof viewer['userId'] !== 'string' || !viewer['userId'] || typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,200}$/u.test(requestId)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: invalid mutation confirmation')
    return { instanceId: generation['instanceId'], revision: generation['revision'], host: viewer['host'], userId: viewer['userId'], requestId }
  }
  private assertExpected(op: Operation, expected: ExpectedMutation): void {
    if (op.snapshot.state !== 'authenticated' || op.snapshot.viewer === undefined || op.snapshot.generation.instanceId !== expected.instanceId || op.snapshot.generation.revision !== expected.revision || op.snapshot.viewer.host !== expected.host || op.snapshot.viewer.userId !== expected.userId) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: mutation confirmation changed')
  }
  private async guardMutation(op: Operation, expected: ExpectedMutation, remoteName: 'origin' | 'upstream'): Promise<Record<string, unknown>> {
    await op.revalidate(remoteName)
    const current = await this.auth.snapshot(op.signal)
    if (current.generation.instanceId !== expected.instanceId || current.generation.revision !== expected.revision || current.viewer?.host !== expected.host || current.viewer.userId !== expected.userId) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: mutation confirmation changed')
    this.checkBudget(op.snapshot)
    const response = await this.http.gitLabProjectLookup(op.path, this.headers(op.snapshot), op.signal)
    this.checkResponse(response, op.snapshot)
    const project = record(response.body)
    if (response.status !== 200 || projectId(project?.['id']) !== op.projectId || project?.['path_with_namespace'] !== op.path) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: project identity changed')
    await op.revalidate(remoteName)
    return project
  }
  private submit<T>(endpoint: string, request: Record<string, unknown>, op: Operation, expected: ExpectedMutation, contents: readonly unknown[], work: () => Promise<T>): Promise<T> {
    const root = request['repository'], session = request['sessionId']
    if (typeof root !== 'string' || (session !== undefined && (typeof session !== 'string' || session.length > 1024))) throw invalid('invalid-request')
    const key = JSON.stringify([root, session ?? '', this.instance.instance, op.projectId, expected.instanceId, expected.revision, expected.host, expected.userId, expected.requestId])
    const fingerprint = createHash('sha256').update(JSON.stringify([endpoint, op.path, ...contents])).digest('hex')
    const index = JSON.stringify([root, session ?? '', this.instance.instance, op.path, expected.instanceId, expected.revision, expected.host, expected.userId, expected.requestId])
    const priorKey = this.submissionIndex.get(index)
    if (priorKey !== undefined && priorKey !== key) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: submission project changed')
    const previous = this.submissions.get(key)
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) throw invalid('submission-conflict')
      return previous.result as Promise<T>
    }
    if (this.submissions.size >= 512) throw invalid('submission-capacity')
    const result = work()
    const entry: Submission = { fingerprint, projectId: op.projectId, result, state: 'pending' }
    this.submissions.set(key, entry); this.submissionIndex.set(index, key)
    void result.then(() => { entry.state = 'completed' }, error => { entry.state = error instanceof GitRemoteError && error.code === 'git/write-result-unknown' ? 'unknown' : 'failed' })
    return result
  }
  private async prior<T>(endpoint: string, request: Record<string, unknown>, expected: ExpectedMutation, contents: readonly unknown[], context: ScopedRequestContext | undefined, signal: AbortSignal): Promise<ScopedRemoteResult<T> | undefined> {
    const root = request['repository'], path = request['path'], session = request['sessionId']
    if (typeof root !== 'string' || typeof path !== 'string' || (session !== undefined && typeof session !== 'string')) throw invalid('invalid-request')
    const index = JSON.stringify([root, session ?? '', this.instance.instance, path, expected.instanceId, expected.revision, expected.host, expected.userId, expected.requestId])
    const key = this.submissionIndex.get(index), entry = key === undefined ? undefined : this.submissions.get(key)
    if (entry === undefined) return undefined
    const fingerprint = createHash('sha256').update(JSON.stringify([endpoint, path, ...contents])).digest('hex')
    if (fingerprint !== entry.fingerprint) throw invalid('submission-conflict')
    if (request['projectId'] !== undefined && projectId(request['projectId']) !== entry.projectId) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: submission project changed')
    if (context === undefined) throw invalid('session-guard-missing')
    const scope = { provider: 'gitlab' as const, instance: this.instance.instance }
    await context.assertRepository(scope, path, request, signal)
    const snapshot = await this.auth.snapshot(signal)
    if (snapshot.state !== 'authenticated' || snapshot.generation.instanceId !== expected.instanceId || snapshot.generation.revision !== expected.revision || snapshot.viewer?.host !== expected.host || snapshot.viewer.userId !== expected.userId) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: mutation confirmation changed')
    // An unknown result is returned as an error without attempting another network call.
    if (entry.state === 'unknown') return { generation: snapshot.generation, value: await entry.result as T }
    this.checkBudget(snapshot)
    const response = await this.http.gitLabProjectLookup(path, this.headers(snapshot), AbortSignal.any([signal, snapshot.signal]))
    this.checkResponse(response, snapshot)
    const project = record(response.body)
    if (response.status !== 200 || projectId(project?.['id']) !== entry.projectId || project?.['path_with_namespace'] !== path) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: submission project changed')
    await context.assertRepository(scope, path, request, signal)
    if (endpoint === 'remote-create-pr') {
      const source = record(request['head']), sourcePath = source?.['path'], sourceId = projectId(source?.['projectId'])
      if (typeof sourcePath !== 'string' || sourceId === undefined) throw invalid('invalid-request')
      await context.assertRepository(scope, sourcePath, request, signal)
      this.checkBudget(snapshot)
      const sourceResponse = await this.http.gitLabProjectLookup(sourcePath, this.headers(snapshot), AbortSignal.any([signal, snapshot.signal]))
      this.checkResponse(sourceResponse, snapshot)
      const sourceProject = record(sourceResponse.body)
      if (sourceResponse.status !== 200 || projectId(sourceProject?.['id']) !== sourceId || sourceProject?.['path_with_namespace'] !== sourcePath) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: submission source project changed')
      await context.assertRepository(scope, sourcePath, request, signal)
    }
    this.auth.assertGeneration(snapshot.generation)
    return { generation: snapshot.generation, value: await entry.result as T }
  }
  async checkout(request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<CheckoutOutcome>> {
    const expected = this.expected(request), number = request['number'], expectedSha = request['expectedHeadSha'], requestedBranch = request['branch']
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || typeof expectedSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(expectedSha) || (requestedBranch !== undefined && (typeof requestedBranch !== 'string' || requestedBranch.length > 1024 || requestedBranch.length === 0))) throw invalid('invalid-request')
    const contents = [number, expectedSha, requestedBranch ?? null]
    const previous = await this.prior<CheckoutOutcome>('remote-checkout-pr', request, expected, contents, context, signal)
    if (previous !== undefined) return previous
    return this.operation(request, signal, context, JSON.stringify(['checkout', number]), async op => {
      this.assertExpected(op, expected)
      return this.submit('remote-checkout-pr', request, op, expected, contents, async () => {
        const remoteName = await op.revalidate(), root = request['repository'] as string
        const mrPath = `${this.instance.prefix}/api/v4/projects/${op.projectId}/merge_requests/${number}`
        const readPull = async () => {
          const pull = gitLabPull((await this.get(mrPath, op)).body, this.instance.instance, op.projectId)
          if (pull.number !== number || pull.rawState === 'locked' || pull.state === 'unknown') throw invalid('object-read-only')
          if (pull.head.sha !== expectedSha) throw new GitRemoteError('git/head-moved', 'git-remote: merge request head changed')
          return pull
        }
        const pull = await readPull(), sameRepository = pull.head.projectId === op.projectId
        const branch = requestedBranch ?? (sameRepository ? pull.head.ref : `mr-${number}`)
        const receipt = await this.git.checkoutBound(root, { remoteName, remoteHeadRef: `refs/merge-requests/${number}/head`, privateRef: gitLabPrivateRef(this.instance.instance, op.projectId, number), sourceRef: pull.head.ref, expectedSha, sameRepository, branch, rejectExistingBranch: !sameRepository && requestedBranch === undefined }, op.signal, {
          beforeSideEffect: async () => { await this.guardMutation(op, expected, remoteName) },
          beforeEnter: async () => { await readPull() },
        })
        const failed = receipt.error !== undefined
        const outcome = !failed ? 'succeeded' : receipt.privateRefWritten || receipt.trackingRefPrepared || receipt.fetchMappingAdded || receipt.switched ? 'partial' : receipt.error === 'git-transport-or-local-failure' ? 'unknown' : 'partial'
        return { outcome, steps: [
          { kind: 'private-ref', state: receipt.privateRefWritten ? 'succeeded' : receipt.error === 'dirty' ? 'not-sent' : 'unknown' },
          { kind: 'tracking-ref', state: receipt.trackingRefPrepared ? 'succeeded' : !sameRepository || !receipt.privateRefWritten ? 'not-sent' : failed ? 'unknown' : 'not-sent' },
          { kind: 'fetch-mapping', state: receipt.fetchMappingAdded ? 'succeeded' : 'not-sent' },
          { kind: 'switch', state: receipt.switched ? 'succeeded' : receipt.worktreeConflict === true ? 'not-sent' : receipt.error === 'git-transport-or-local-failure' && receipt.privateRefWritten ? 'unknown' : 'not-sent' },
          { kind: 'upstream', state: sameRepository && !receipt.upstreamNotConfigured ? 'succeeded' : 'not-sent' },
        ], receipt }
      })
    }, value => interruptedGitLabMutation('remote-checkout-pr', request, value))
  }
  async issueBranch(request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<IssueBranchOutcome>> {
    const expected = this.expected(request), number = request['number']
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw invalid('invalid-request')
    const previous = await this.prior<IssueBranchOutcome>('remote-issue-branch', request, expected, [number], context, signal)
    if (previous !== undefined) return previous
    return this.operation(request, signal, context, JSON.stringify(['issue-branch', number]), async op => {
      this.assertExpected(op, expected)
      return this.submit('remote-issue-branch', request, op, expected, [number], async () => {
        const remoteName = await op.revalidate(), root = request['repository'] as string
        const path = `${this.instance.prefix}/api/v4/projects/${op.projectId}/issues/${number}`
        const issue = gitLabIssue((await this.get(path, op)).body, this.instance.instance, op.projectId)
        if (issue.number !== number || issue.state === 'unknown') throw invalid('object-read-only')
        const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'issue'
        const branch = `issue-${number}-${slug}`
        await this.run(root, ['check-ref-format', '--branch', branch], op.signal)
        const failed = (error: 'dirty' | 'branch-conflict' | 'head-moved'): IssueBranchOutcome => ({ outcome: 'partial', steps: [{ kind: 'create-branch', state: 'failed' }, { kind: 'switch-branch', state: 'not-sent' }], receipt: { branch, created: false, switched: false, error } })
        if ((await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], op.signal)) !== '') return failed('dirty')
        const head = (await this.run(root, ['rev-parse', '--verify', 'HEAD'], op.signal)).trim()
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) throw invalid('invalid-local-head')
        const existing = (await this.run(root, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`], op.signal)).split('\n').includes(`refs/heads/${branch}`)
        if (existing) return failed('branch-conflict')
        let createSent = false, created = false, switchSent = false, switched = false
        try {
          await this.guardMutation(op, expected, remoteName)
          if ((await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], op.signal)) !== '') return failed('dirty')
          if ((await this.run(root, ['rev-parse', '--verify', 'HEAD'], op.signal)).trim() !== head) return failed('head-moved')
          createSent = true
          await this.run(root, ['branch', '--', branch, head], op.signal)
          created = true
          await this.guardMutation(op, expected, remoteName)
          if ((await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], op.signal)) !== '') return { outcome: 'partial', steps: [{ kind: 'create-branch', state: 'succeeded' }, { kind: 'switch-branch', state: 'not-sent' }], receipt: { branch, created: true, switched: false, error: 'dirty' } }
          if ((await this.run(root, ['rev-parse', '--verify', 'HEAD'], op.signal)).trim() !== head) return { outcome: 'partial', steps: [{ kind: 'create-branch', state: 'succeeded' }, { kind: 'switch-branch', state: 'not-sent' }], receipt: { branch, created: true, switched: false, error: 'head-moved' } }
          switchSent = true
          await this.run(root, ['switch', '--', branch], op.signal)
          switched = true
          const actual = (await this.run(root, ['rev-parse', '--verify', 'HEAD'], op.signal)).trim()
          return { outcome: actual === head ? 'succeeded' : 'partial', steps: [{ kind: 'create-branch', state: 'succeeded' }, { kind: 'switch-branch', state: 'succeeded' }], receipt: { branch, created: true, switched: true, head: actual, ...(actual === head ? {} : { error: 'head-moved' as const }) } }
        } catch (error) {
          if (!createSent) throw error
          if (!created) throw new GitRemoteError('git/write-result-unknown', 'git-remote: branch creation result is unknown', { action: 'issue-branch' })
          let actual: string | undefined
          if (switchSent) try { actual = (await this.run(root, ['rev-parse', '--verify', 'HEAD'], AbortSignal.timeout(3000))).trim() } catch { /* Keep the known completed stages. */ }
          return { outcome: 'partial', steps: [{ kind: 'create-branch', state: 'succeeded' }, { kind: 'switch-branch', state: switched ? 'succeeded' : switchSent ? 'unknown' : 'not-sent' }], receipt: { branch, created, switched, ...(actual === undefined ? {} : { head: actual }), error: 'git-transport-or-local-failure' } }
        }
      })
    }, value => interruptedGitLabMutation('remote-issue-branch', request, value))
  }
  private async sendWrite(op: Operation, method: 'POST' | 'PUT', path: string, payload: Record<string, unknown>, action: string, number?: number): Promise<Record<string, unknown>> {
    this.checkBudget(op.snapshot)
    const budget = this.budget(op.snapshot)
    let sent = false, response: GitRemoteHttpResponse
    try {
      response = await this.http.request({ role: 'api', method, path, headers: { ...this.headers(op.snapshot), 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: op.signal, onSend: () => { sent = true } })
    } catch (error) {
      if (!sent || error instanceof GitRemoteHttpError && error.kind === 'not-sent') throw invalid('not-sent')
      throw new GitRemoteError('git/write-result-unknown', 'git-remote: write result is unknown; refresh the affected object', { action, ...(number === undefined ? {} : { number }) })
    }
    if (response.status >= 500) {
      budget.blockedUntil = Math.max(budget.blockedUntil, limitDeadline(response.headers, this.now()))
      throw new GitRemoteError('git/write-result-unknown', 'git-remote: write result is unknown; refresh the affected object', { action, ...(number === undefined ? {} : { number }) })
    }
    if (response.status === 401) { this.auth.markInvalid(op.snapshot); throw new GitRemoteError('git/unauthenticated', 'git-remote: authentication needs repair') }
    const remaining = response.headers.get('ratelimit-remaining') ?? response.headers.get('x-ratelimit-remaining')
    if (response.status === 429 || (response.status === 403 && (remaining === '0' || response.headers.get('retry-after') !== null))) { budget.blockedUntil = Math.max(budget.blockedUntil, limitDeadline(response.headers, this.now())); throw new GitRemoteError('git/rate-limited', 'git-remote: provider rate limited the write', { resetAt: budget.blockedUntil }) }
    if (response.status === 403) throw new GitRemoteError('git/insufficient-scope', 'git-remote: provider denied the write')
    if (response.status === 409 && (action === 'approve' || action === 'merge-pr')) throw new GitRemoteError('git/head-moved', 'git-remote: merge request head changed')
    if (response.status < 200 || response.status >= 300) throw invalid(action === 'approve' ? 'approval-rejected-or-reauth-required' : 'provider-rejected')
    const body = record(response.body)
    if (body === undefined) throw new GitRemoteError('git/write-result-unknown', 'git-remote: write receipt is unavailable; refresh the affected object', { action, ...(number === undefined ? {} : { number }) })
    this.cache.clear(); this.cursors.clear()
    return body
  }
  private async sourceProject(op: Operation, path: string, suppliedId?: string, requiredRemote?: 'origin' | 'upstream'): Promise<{ id: string; name: 'origin' | 'upstream' }> {
    const name = await op.authorizePath(path, requiredRemote)
    this.checkBudget(op.snapshot)
    const response = await this.http.gitLabProjectLookup(path, this.headers(op.snapshot), op.signal)
    this.checkResponse(response, op.snapshot)
    const data = record(response.body), id = projectId(data?.['id'])
    if (response.status !== 200 || id === undefined || data?.['path_with_namespace'] !== path || (suppliedId !== undefined && suppliedId !== id)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: source project identity changed')
    await op.authorizePath(path, name)
    return { id, name }
  }
  private async verifyBranch(op: Operation, project: string, branch: string): Promise<void> {
    this.checkBudget(op.snapshot)
    const response = await this.http.gitLabBranchLookup(project, branch, this.headers(op.snapshot), op.signal)
    this.checkResponse(response, op.snapshot)
    const value = record(response.body), commit = record(value?.['commit'])
    if (response.status !== 200 || value?.['name'] !== branch || typeof commit?.['id'] !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit['id'])) throw invalid('branch-not-verified')
  }
  async write(endpoint: 'remote-comment' | 'remote-review' | 'remote-close-pr' | 'remote-merge-pr' | 'remote-create-pr', request: Record<string, unknown>, signal: AbortSignal, context: ScopedRequestContext | undefined): Promise<ScopedRemoteResult<WriteOutcome>> {
    const expected = this.expected(request), number = request['number'], event = request['event'], method = request['method'], expectedSha = request['expectedHeadSha']
    const body = request['body'] === undefined ? '' : request['body']
    if (typeof body !== 'string' || body.length > 65536 || (endpoint !== 'remote-create-pr' && request['objectKind'] !== 'pull') || (endpoint === 'remote-create-pr' && request['objectKind'] !== undefined && request['objectKind'] !== 'pull')) throw invalid('invalid-request')
    if (endpoint !== 'remote-create-pr' && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)) throw invalid('invalid-object')
    if ((endpoint === 'remote-comment' || endpoint === 'remote-review' && event === 'COMMENT') && body.trim() === '') throw invalid('invalid-request')
    if (endpoint === 'remote-review' && event !== 'COMMENT' && event !== 'APPROVE') throw invalid('unsupported-review-event')
    if (endpoint === 'remote-merge-pr' && method !== 'merge' && method !== 'squash') throw invalid('unsupported-merge-method')
    if ((endpoint === 'remote-merge-pr' || endpoint === 'remote-close-pr' || endpoint === 'remote-review' && event === 'APPROVE') && (typeof expectedSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(expectedSha))) throw invalid('invalid-comparison')
    const head = endpoint === 'remote-create-pr' ? record(request['head']) : undefined
    const title = request['title'], headRef = request['headRef'], baseRef = request['baseRef'], draft = request['draft']
    if (endpoint === 'remote-create-pr' && (head?.['provider'] !== 'gitlab' || head['instance'] !== this.instance.instance || typeof head['path'] !== 'string' || !head['path'] || projectId(head['projectId']) === undefined || typeof title !== 'string' || !title.trim() || title.length > 256 || typeof headRef !== 'string' || !headRef || headRef.length > 1024 || typeof baseRef !== 'string' || !baseRef || baseRef.length > 1024 || (draft !== undefined && typeof draft !== 'boolean'))) throw invalid('invalid-request')
    const content = [number ?? null, body, event ?? null, method ?? null, expectedSha ?? null, title ?? null, headRef ?? null, baseRef ?? null, draft ?? null, head?.['path'] ?? null, head?.['projectId'] ?? null]
    const previous = await this.prior<WriteOutcome>(endpoint, request, expected, content, context, signal)
    if (previous !== undefined) return previous
    return this.operation(request, signal, context, JSON.stringify(['write', endpoint, number ?? null]), async op => {
      this.assertExpected(op, expected)
      return this.submit(endpoint, request, op, expected, content, async () => {
        const remote = await op.revalidate(), objectNumber = typeof number === 'number' ? number : undefined
        const mrPath = objectNumber === undefined ? '' : `${this.instance.prefix}/api/v4/projects/${op.projectId}/merge_requests/${objectNumber}`
        const verifyIdentity = async () => {
          await op.revalidate(remote)
          const current = await this.auth.snapshot(op.signal)
          if (current.generation.instanceId !== expected.instanceId || current.generation.revision !== expected.revision || current.viewer?.host !== expected.host || current.viewer.userId !== expected.userId || current.token !== op.snapshot.token) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: mutation confirmation changed')
        }
        const confirm = async (operation: 'comment' | 'review' | 'close-pr' | 'merge-pr' | 'create-pr', reviewEvent?: 'COMMENT' | 'APPROVE') => {
          const project = await this.guardMutation(op, expected, remote)
          const fresh = { ...op, project }
          const facts = await this.actionFacts(fresh, objectNumber === undefined ? undefined : { kind: 'pull', number: objectNumber })
          const action = operation === 'comment' ? facts.actions.canComment : operation === 'review' ? facts.actions.canReview : operation === 'close-pr' ? facts.actions.canClose : operation === 'merge-pr' ? facts.actions.canMerge : facts.actions.canCreatePr
          if (!facts.operationSupport[operation].supported || action === false) throw invalid('action-not-supported')
          if (reviewEvent !== undefined && !facts.supportedReviewEvents.includes(reviewEvent)) throw invalid(reviewEvent === 'APPROVE' ? 'approval-reauth-or-policy' : 'unsupported-review-event')
          if (reviewEvent === 'APPROVE' && facts.reviewPermissions?.APPROVE === false) throw new GitRemoteError('git/insufficient-scope', 'git-remote: approval is not permitted')
          if (operation === 'merge-pr' && !facts.supportedMergeMethods.includes(method as 'merge' | 'squash')) throw invalid('unsupported-merge-method')
          if (expectedSha !== undefined && objectNumber !== undefined) {
            const raw = (await this.get(mrPath, fresh, true)).body
            const pull = gitLabPull(raw, this.instance.instance, op.projectId)
            if (pull.number !== objectNumber || pull.head.sha !== expectedSha) throw new GitRemoteError('git/head-moved', 'git-remote: merge request head changed')
            if (operation === 'merge-pr' && record(raw)?.['squash_on_merge'] !== (method === 'squash')) throw invalid('unsupported-merge-method')
          }
          await verifyIdentity()
        }
        const note = async (): Promise<{ id: string; url?: string }> => {
          await confirm(endpoint === 'remote-review' ? 'review' : 'comment', endpoint === 'remote-review' ? 'COMMENT' : undefined)
          const result = await this.sendWrite(op, 'POST', `${mrPath}/notes`, { body }, 'comment', objectNumber)
          const id = projectId(result['id']), url = gitLabWebUrl(this.instance.instance, result['web_url'])
          if (id === undefined) throw new GitRemoteError('git/write-result-unknown', 'git-remote: comment receipt is unavailable; refresh the affected object', { action: 'comment', ...(objectNumber === undefined ? {} : { number: objectNumber }) })
          return { id, ...(url === undefined ? {} : { url }) }
        }
        if (endpoint === 'remote-comment' || endpoint === 'remote-review' && event === 'COMMENT') {
          const receipt = await note()
          return { outcome: 'succeeded', steps: [{ kind: 'comment', state: 'succeeded', id: receipt.id }], receipt }
        }
        if (endpoint === 'remote-review') {
          // Do not create a comment if an already-known policy disallows the approval.
          await confirm('review', 'APPROVE')
          const comment = body.trim() === '' ? undefined : await note()
          try {
            await confirm('review', 'APPROVE')
            const result = await this.sendWrite(op, 'POST', `${mrPath}/approve`, { sha: expectedSha }, 'approve', objectNumber)
            if (result['iid'] !== objectNumber) throw new GitRemoteError('git/write-result-unknown', 'git-remote: approval receipt is unavailable; refresh the affected object', { action: 'approve', ...(objectNumber === undefined ? {} : { number: objectNumber }) })
            return { outcome: 'succeeded', steps: [...(comment === undefined ? [] : [{ kind: 'comment', state: 'succeeded' as const, id: comment.id }]), { kind: 'approve', state: 'succeeded' }], receipt: { ...(objectNumber === undefined ? {} : { number: objectNumber }) } }
          } catch (error) {
            if (comment === undefined) throw error
            if (error instanceof GitRemoteError && error.code === 'git/write-result-unknown') throw new GitRemoteError('git/write-result-unknown', 'git-remote: comment succeeded but approval result is unknown; refresh the affected object', { action: 'review', ...(objectNumber === undefined ? {} : { number: objectNumber }), stage: 'approve', commentSucceeded: true, commentId: comment.id })
            return { outcome: 'partial', steps: [{ kind: 'comment', state: 'succeeded', id: comment.id }, { kind: 'approve', state: 'failed', reason: error instanceof GitRemoteError ? error.code : 'git/remote-unavailable' }], receipt: { id: comment.id, ...(objectNumber === undefined ? {} : { number: objectNumber }) } }
          }
        }
        if (endpoint === 'remote-close-pr' || endpoint === 'remote-merge-pr') {
          const action = endpoint === 'remote-close-pr' ? 'close-pr' : 'merge-pr'
          await confirm(action)
          const result = await this.sendWrite(op, 'PUT', endpoint === 'remote-close-pr' ? mrPath : `${mrPath}/merge`, endpoint === 'remote-close-pr' ? { state_event: 'close' } : { sha: expectedSha, squash: method === 'squash', should_remove_source_branch: false }, action, objectNumber)
          if (result['iid'] !== objectNumber || result['state'] !== (action === 'close-pr' ? 'closed' : 'merged')) throw new GitRemoteError('git/write-result-unknown', 'git-remote: write receipt is not final; refresh the affected object', { action, ...(objectNumber === undefined ? {} : { number: objectNumber }) })
          const url = gitLabWebUrl(this.instance.instance, result['web_url'])
          if (action === 'merge-pr') {
            const squash = result['squash_on_merge']
            const error = result['should_remove_source_branch'] === true ? 'source-removal-reported' : typeof squash !== 'boolean' ? 'merge-method-unverified' : squash !== (method === 'squash') ? 'merge-method-mismatch' : undefined
            if (error !== undefined) return { outcome: 'partial', steps: [{ kind: action, state: 'succeeded' }, { kind: 'merge-verification', state: error === 'merge-method-unverified' ? 'unknown' : 'failed', reason: error }], receipt: { ...(objectNumber === undefined ? {} : { number: objectNumber }), ...(url === undefined ? {} : { url }), merged: true, error } }
          }
          return { outcome: 'succeeded', steps: [{ kind: action, state: 'succeeded' }], receipt: { ...(objectNumber === undefined ? {} : { number: objectNumber }), ...(url === undefined ? {} : { url }), ...(action === 'merge-pr' ? { merged: true } : {}) } }
        }
        const sourcePath = head?.['path'] as string, sourceId = head?.['projectId'] === undefined ? undefined : projectId(head['projectId'])
        const source = await this.sourceProject(op, sourcePath, sourceId)
        const localRoot = request['repository'] as string
        await this.run(localRoot, ['check-ref-format', `refs/heads/${headRef as string}`], op.signal)
        await this.run(localRoot, ['check-ref-format', `refs/heads/${baseRef as string}`], op.signal)
        await this.verifyBranch(op, source.id, headRef as string); await this.verifyBranch(op, op.projectId, baseRef as string)
        await confirm('create-pr')
        const checkedSource = await this.sourceProject(op, sourcePath, source.id, source.name)
        await this.verifyBranch(op, checkedSource.id, headRef as string); await this.verifyBranch(op, op.projectId, baseRef as string)
        await op.authorizePath(sourcePath, source.name); await verifyIdentity()
        const targetId = Number(op.projectId)
        if (!Number.isSafeInteger(targetId)) throw invalid('invalid-project-id')
        const result = await this.sendWrite(op, 'POST', `${this.instance.prefix}/api/v4/projects/${source.id}/merge_requests`, { source_branch: headRef, target_branch: baseRef, target_project_id: targetId, title: draft === true && !/^draft:/iu.test(title as string) ? `Draft: ${title as string}` : title, description: body }, 'create-pr')
        const newNumber = result['iid'], id = projectId(result['id'])
        if (id === undefined || typeof newNumber !== 'number' || !Number.isSafeInteger(newNumber) || newNumber < 1 || projectId(result['source_project_id']) !== source.id || projectId(result['target_project_id']) !== op.projectId) throw new GitRemoteError('git/write-result-unknown', 'git-remote: creation receipt is unavailable; refresh the affected project', { action: 'create-pr', projectId: op.projectId })
        const url = gitLabWebUrl(this.instance.instance, result['web_url'])
        return { outcome: 'succeeded', steps: [{ kind: 'create-pr', state: 'succeeded', id }], receipt: { id, number: newNumber, ...(url === undefined ? {} : { url }) } }
      })
    }, value => interruptedGitLabMutation(endpoint, request, value))
  }
  dispose(): void { this.cache.clear(); this.pollAfter.clear(); this.cursors.clear(); this.submissions.clear(); this.submissionIndex.clear() }
}
