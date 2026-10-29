/** GitHub v1 executor and scoped adapter; no GitLab platform code lives here. */
import { createHash } from 'node:crypto'
import type { GitService } from '../service.ts'
import { GIT_REMOTE_GRANT_RECORD_KEY, type GitRemoteAuth } from './auth.ts'
import { GitRemoteError } from './errors.ts'
import { sameGeneration, type GitHubScopedFactsProvider } from './github.ts'
import { GitHubScopedProvider } from './github-scoped.ts'
import { GitRemoteGit } from './git.ts'
import { object, objectNumber, repositoryPath, string } from './github-model.ts'
import type { RemoteRepository, RemoteWrite } from './provider.ts'
import type { GitRemoteWriteContext } from './types.ts'
import type { LegacyRemoteChannel } from './assembly.ts'
import type { ScopedRemoteProvider } from './registry.ts'
import { authSelectionKey } from './auth-selection.ts'

function text(data: Record<string, unknown>, key: string, max = 65536): string { const value = string(data[key]); if (value.length > max) throw new GitRemoteError('git/remote-unavailable', 'git-remote: request text exceeds limit'); return value }
function sha(data: Record<string, unknown>, key = 'expectedHeadSha'): string { const value = text(data, key, 64); if (!/^[a-f0-9]{40,64}$/.test(value)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid expected commit'); return value }
function paging(data: Record<string, unknown>): { cursor?: string; pages?: number } {
  return {
    ...(data['cursor'] === undefined ? {} : { cursor: text(data, 'cursor', 4096) }),
    ...(data['pages'] === undefined ? {} : { pages: objectNumber(Number(data['pages'])) }),
  }
}
export function remoteTarget(data: Record<string, unknown>): RemoteRepository {
  const target: RemoteRepository = { provider: 'github', host: 'github.com', owner: text(data, 'owner', 100), repo: text(data, 'repo', 100) }
  if (data['host'] !== target.host) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: unsupported host')
  repositoryPath(target); return target
}
function writeContext(data: Record<string, unknown>, target: RemoteRepository): GitRemoteWriteContext {
  const generation = object(data['expectedGeneration'])
  const viewer = object(data['expectedViewer'])
  if (typeof generation['revision'] !== 'number' || !Number.isSafeInteger(generation['revision']) || generation['revision'] < 0) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: invalid generation')
  return { ...target, expectedGeneration: { instanceId: string(generation['instanceId']), revision: generation['revision'] }, expectedViewer: { host: string(viewer['host']), userId: string(viewer['userId']) } }
}
/** A scoped request ID may never identify two different commands. */
function submissionFingerprint(endpoint: string, request: Record<string, unknown>): string {
  const keys = ['number', 'body', 'expectedHeadSha', 'path', 'line', 'side', 'startLine', 'startSide', 'event', 'method', 'title', 'headRef', 'baseRef', 'draft', 'branch']
  const values = keys.map(key => {
    const value = request[key]
    if (typeof value === 'string' && value.length > 65536) throw new GitRemoteError('git/remote-unavailable', 'git-remote: submission text exceeds limit', { reason: 'invalid-request' })
    if (value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value ?? null
    throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid submission content', { reason: 'invalid-request' })
  })
  const rawHead = request['head']
  let head: readonly unknown[] | null = null
  if (rawHead !== undefined) {
    const data = object(rawHead)
    head = [data['host'], data['owner'], data['repo']]
    if (head.some(value => value !== undefined && typeof value !== 'string')) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid submission content', { reason: 'invalid-request' })
  }
  return createHash('sha256').update(JSON.stringify([endpoint, values, head])).digest('hex')
}
export class GitHubLegacyOwner implements LegacyRemoteChannel {
  readonly scoped: ScopedRemoteProvider
  readonly git: GitRemoteGit
  private readonly owner = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly submissions = new Map<string, { promise: Promise<unknown>; fingerprint?: string }>()
  private initialized: Promise<unknown> | undefined
  constructor(private readonly auth: GitRemoteAuth, private readonly provider: GitHubScopedFactsProvider, private readonly service: GitService) {
    this.git = new GitRemoteGit((root, args, signal) => service.remoteCommand(root, args, signal))
    const adapter = new GitHubScopedProvider(auth)
    this.scoped = {
      scope: adapter.scope,
      handle: (endpoint, request, signal, context) => adapter.handle(endpoint, request, signal, (name, payload) => this.handle(name, payload, signal, context?.assertSession ?? (async () => { throw new GitRemoteError('git/remote-unavailable', 'git-remote: session guard is unavailable') }), true)),
      dispose: () => adapter.dispose(),
    }
  }
  async capability() { return { ...await this.auth.capability(), remoteProtocol: 2 as const } }
  invalidateRecord(key: string): void { if (key === GIT_REMOTE_GRANT_RECORD_KEY || key === authSelectionKey(GIT_REMOTE_GRANT_RECORD_KEY)) this.initialized = undefined }
  invalidateReference(ref: string): void { if (ref === 'GH_TOKEN' || ref === 'GITHUB_TOKEN') this.initialized = undefined }
  handle(endpoint: string, payload: unknown, caller: AbortSignal, assertSession: (request: Record<string, unknown>, signal: AbortSignal) => Promise<void>, scoped = false): Promise<unknown> {
    const signal = AbortSignal.any([this.owner.signal, caller])
    const run = async () => {
      signal.throwIfAborted()
      const request = object(payload)
      if (endpoint === 'remote-retire-grant') throw new GitRemoteError('git/remote-unavailable', 'git-remote: scoped protocol required', { reason: 'protocol-required' })
      if (endpoint === 'remote-login') return this.auth.startLogin(signal)
      if (endpoint === 'remote-poll-login') return this.auth.pollLogin(text(request, 'attemptId', 200), signal)
      if (endpoint === 'remote-cancel-login') return this.auth.cancelLogin(text(request, 'attemptId', 200))
      if (endpoint === 'remote-sign-out') return this.auth.signOut(signal)
      if (endpoint === 'remote-select-auth') { this.initialized = undefined; await this.auth.selectMethod(request['method'], signal); return this.capability() }
      if (endpoint === 'remote-oauth-logout') { this.initialized = undefined; await this.auth.logoutOAuth(signal); return this.capability() }
      if (endpoint === 'remote-clear-grant') { await this.auth.clearLocalGrant(signal); this.initialized = undefined; return }
      if (endpoint === 'remote-retry-auth') { this.initialized = this.auth.retry(signal); await this.initialized; return this.capability() }
      if (endpoint === 'remote-use-git-credential') { await this.auth.useGitCredential(signal); return this.capability() }
      this.initialized ??= this.auth.establish(signal).catch(error => { this.initialized = undefined; throw error })
      await this.initialized
      if (endpoint === 'remote-account') return this.provider.account({ signal, automatic: request['automatic'] === true })
      const root = text(request, 'repository', 16384)
      if (endpoint === 'remote-repositories') return this.git.repositories(root, signal)
      const target = remoteTarget(request)
      await this.git.assertRepository(root, target, signal)
      if (scoped && endpoint === 'remote-create-pr') await this.git.assertRepository(root, remoteTarget(object(request['head'])), signal)
      const context = { signal, automatic: request['automatic'] === true }
      const n = () => objectNumber(Number(request['number']))
      switch (endpoint) {
        case 'remote-notifications': return this.provider.notifications(target, context)
        case 'remote-repository': return scoped ? this.provider.scopedRepository(target, context) : this.provider.repository(target, context)
        case 'remote-list-prs': return this.provider.pulls(target, request['state'] === 'closed' || request['state'] === 'all' ? request['state'] : 'open', paging(request), context)
        case 'remote-pr': return this.provider.pull(target, n(), context)
        case 'remote-list-issues': return this.provider.issues(target, request['state'] === 'closed' || request['state'] === 'all' ? request['state'] : 'open', paging(request), context)
        case 'remote-issue': return this.provider.issue(target, n(), context)
        case 'remote-comments': return this.provider.comments(target, n(), request['inline'] === true, paging(request), context)
        case 'remote-commits': return this.provider.commits(target, n(), paging(request), context)
        case 'remote-reviews': return this.provider.reviews(target, n(), paging(request), context)
        case 'remote-files': {
          // Pin file data to a single API head/base snapshot; head races invalidate the whole comparison.
          const page = paging(request)
          if (page.cursor !== undefined) {
            const probe = await this.provider.pull(target, n(), context)
            if (probe.value.head.sha !== sha(request) || probe.value.base.sha !== sha(request, 'expectedBaseSha')) throw new GitRemoteError('git/head-moved', 'git-remote: comparison changed during loading')
            const files = await this.provider.files(target, n(), page, context)
            if (!sameGeneration(probe.generation, files.generation)) throw new GitRemoteError('git/head-moved', 'git-remote: comparison changed during loading')
            return { generation: files.generation, value: { files: files.value, baseSha: probe.value.base.sha, headSha: probe.value.head.sha } }
          }
          const before = await this.provider.pull(target, n(), context)
          const files = await this.provider.files(target, n(), page, context)
          const after = await this.provider.pull(target, n(), context)
          if (!sameGeneration(before.generation, after.generation) || before.value.head.sha !== after.value.head.sha || before.value.base.sha !== after.value.base.sha) throw new GitRemoteError('git/head-moved', 'git-remote: comparison changed during loading')
          return { generation: after.generation, value: { files: files.value, baseSha: after.value.base.sha, headSha: after.value.head.sha } }
        }
      }
      await assertSession(request, signal)
      const expected = writeContext(request, target)
      const requestId = text(request, 'requestId', 200)
      if (!/^[A-Za-z0-9-]{8,200}$/.test(requestId)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid submission id')
      const key = scoped
        ? JSON.stringify([root, request['sessionId'] ?? null, 'github', 'https://github.com', target.owner.toLowerCase(), target.repo.toLowerCase(), expected.expectedGeneration, expected.expectedViewer, requestId])
        : JSON.stringify([root, expected.expectedGeneration, expected.expectedViewer, requestId])
      const fingerprint = scoped ? submissionFingerprint(endpoint, request) : undefined
      const previous = this.submissions.get(key)
      if (previous !== undefined) {
        if (scoped && previous.fingerprint !== fingerprint) throw new GitRemoteError('git/remote-unavailable', 'git-remote: submission id reused with different content', { reason: 'submission-conflict' })
        return previous.promise
      }
      if (this.submissions.size >= 512) throw new GitRemoteError('git/remote-unavailable', 'git-remote: submission budget exhausted; reopen remote integration')
      const submit = async () => {
        if (scoped && endpoint === 'remote-merge-pr') {
          const facts = await this.provider.scopedRepository(target, context)
          const method = request['method'] === 'squash' ? 'squash' : 'merge'
          if (!sameGeneration(facts.generation, expected.expectedGeneration)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: merge confirmation changed')
          if (!facts.value.supportedMergeMethods.includes(method)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: merge method is not supported by this repository', { reason: 'not-supported' })
        }
        if (endpoint === 'remote-checkout-pr' || endpoint === 'remote-issue-branch') {
          const facts = await this.provider.repository(target, context)
          if (!sameGeneration(facts.generation, expected.expectedGeneration) || facts.value.viewer?.userId !== expected.expectedViewer.userId || facts.value.viewer.host !== expected.expectedViewer.host) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: local action confirmation is stale')
          await assertSession(request, signal)
          if (endpoint === 'remote-checkout-pr') {
            const pr = await this.provider.pull(target, n(), context)
            if (!sameGeneration(pr.generation, expected.expectedGeneration)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: checkout credentials changed')
            if (pr.value.head.sha !== sha(request)) throw new GitRemoteError('git/head-moved', 'git-remote: pull head changed')
            const receipt = await this.git.checkout(root, target, pr.value, typeof request['branch'] === 'string' ? request['branch'] : undefined, signal, async () => { await assertSession(request, signal); const current = await this.auth.snapshot(signal); if (!sameGeneration(current.generation, expected.expectedGeneration)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: checkout confirmation changed') })
            if (!scoped) return receipt
            return { generation: pr.generation, value: { outcome: receipt.error === undefined ? 'succeeded' : 'partial', steps: [{ kind: 'checkout', state: receipt.error === undefined ? 'succeeded' : 'unknown' }], receipt } }
          }
          const issue = await this.provider.issue(target, n(), context)
          if (!sameGeneration(issue.generation, expected.expectedGeneration)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: issue confirmation changed')
          const slug = issue.value.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'issue'
          const branch = `issue-${n()}-${slug}`
          if (!scoped) { await this.service.createBranch(root, branch, signal); return this.service.switchBranch(root, branch, signal) }
          let createSent = false, created = false, switchSent = false
          try {
            await assertSession(request, signal)
            const beforeCreate = await this.auth.snapshot(signal)
            if (!sameGeneration(beforeCreate.generation, issue.generation)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: issue confirmation changed')
            createSent = true; await this.service.createBranch(root, branch, signal); created = true
            await assertSession(request, signal)
            const beforeSwitch = await this.auth.snapshot(signal)
            if (!sameGeneration(beforeSwitch.generation, issue.generation)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: issue confirmation changed')
            switchSent = true; await this.service.switchBranch(root, branch, signal)
            return { generation: issue.generation, value: { outcome: 'succeeded', steps: [{ kind: 'create-branch', state: 'succeeded' }, { kind: 'switch-branch', state: 'succeeded' }], receipt: { branch } } }
          } catch (error) {
            if (!createSent) throw error
            if (!created) throw new GitRemoteError('git/write-result-unknown', 'git-remote: branch creation result is unknown', { action: 'issue-branch' })
            return { generation: issue.generation, value: { outcome: 'partial', steps: [{ kind: 'create-branch', state: 'succeeded' }, { kind: 'switch-branch', state: switchSent ? 'unknown' : 'not-sent' }], receipt: { branch } } }
          }
        }
        let command: RemoteWrite
        switch (endpoint) {
          case 'remote-comment': command = { kind: 'comment', number: n(), body: text(request, 'body') }; break
          case 'remote-inline-comment': command = { kind: 'inline-comment', number: n(), body: text(request, 'body'), expectedHeadSha: sha(request), path: text(request, 'path', 4096), line: Number(request['line']), side: request['side'] === 'LEFT' ? 'LEFT' : request['side'] === 'RIGHT' ? 'RIGHT' : (() => { throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid diff side') })(), ...(request['startLine'] === undefined ? {} : { startLine: Number(request['startLine']), startSide: request['startSide'] === 'LEFT' ? 'LEFT' as const : 'RIGHT' as const }) }; break
          case 'remote-review': {
            const event = request['event']; if (event !== 'APPROVE' && event !== 'COMMENT' && event !== 'REQUEST_CHANGES') throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid review event')
            command = { kind: 'review', number: n(), body: text(request, 'body'), expectedHeadSha: sha(request), event }; break
          }
          case 'remote-close-pr': command = { kind: 'close-pr', number: n(), expectedHeadSha: sha(request) }; break
          case 'remote-merge-pr': command = { kind: 'merge-pr', number: n(), expectedHeadSha: sha(request), method: request['method'] === 'squash' || request['method'] === 'rebase' ? request['method'] : 'merge' }; break
          case 'remote-create-pr': command = { kind: 'create-pr', title: text(request, 'title', 256), body: text(request, 'body'), head: remoteTarget(object(request['head'])), headRef: text(request, 'headRef', 1024), baseRef: text(request, 'baseRef', 1024), draft: request['draft'] === true }; break
          default: throw new GitRemoteError('git/remote-unavailable', 'git-remote: unknown endpoint')
        }
        await assertSession(request, signal)
        return this.provider.write(target, expected, command, { ...context, beforeSend: () => assertSession(request, signal) })
      }
      const submission = submit()
      this.submissions.set(key, { promise: submission, ...(fingerprint === undefined ? {} : { fingerprint }) })
      return submission
    }
    const task = run().catch(error => {
      if (error instanceof GitRemoteError) throw error
      throw new GitRemoteError('git/remote-unavailable', 'git-remote: operation failed or was cancelled')
    }).finally(() => this.pending.delete(task))
    this.pending.add(task); return task
  }
  async dispose(): Promise<void> {
    this.owner.abort()
    await Promise.allSettled([this.provider.dispose(), this.auth.dispose(), ...this.pending])
    this.submissions.clear()
  }
}
