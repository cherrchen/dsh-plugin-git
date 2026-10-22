/** Host remote owner. All RPC input is projected/validated here; tokens stay inside auth/provider. */
import type { GitService } from '../service.ts'
import type { GitRemoteCredentialService } from './credentials.ts'
import { GitRemoteAuth } from './auth.ts'
import { GitRemoteHttp } from './http.ts'
import { GitRemoteError } from './errors.ts'
import { GitHubProvider, sameGeneration } from './github.ts'
import { GitRemoteGit } from './git.ts'
import { ghAuthToken, gitCredentialFill, type GitRemoteSubprocess } from './probe.ts'
import { resolveRemoteSettings, validateRemoteSettings, type RemoteSettings } from './settings.ts'
import { object, objectNumber, repositoryPath, string } from './github-model.ts'
import type { RemoteRepository, RemoteWrite } from './provider.ts'
import type { GitRemoteGeneration, GitRemoteWriteContext } from './types.ts'

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
export class GitRemoteRuntime {
  readonly auth: GitRemoteAuth
  readonly provider: GitHubProvider
  readonly git: GitRemoteGit
  private readonly owner = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly submissions = new Map<string, Promise<unknown>>()
  private initialized: Promise<unknown> | undefined
  constructor(credentials: GitRemoteCredentialService, subprocess: GitRemoteSubprocess, private readonly service: GitService, source?: RemoteSettings) {
    validateRemoteSettings(source)
    const settings = resolveRemoteSettings(source)
    const http = new GitRemoteHttp(settings)
    this.auth = new GitRemoteAuth({ credentials, http, settings, discoverGh: async signal => { try { return await ghAuthToken({ subprocess, probeTimeoutMs: settings.probeTimeoutMs }, signal) } catch { signal.throwIfAborted(); return undefined } }, discoverGitCredential: signal => gitCredentialFill({ subprocess, probeTimeoutMs: settings.probeTimeoutMs }, signal) })
    this.provider = new GitHubProvider(this.auth, http)
    this.git = new GitRemoteGit((root, args, signal) => service.remoteCommand(root, args, signal))
  }
  capability() { return this.auth.capability() }
  invalidate(): void { this.initialized = undefined }
  handle(endpoint: string, payload: unknown, caller: AbortSignal, assertSession: (request: Record<string, unknown>, signal: AbortSignal) => Promise<void>): Promise<unknown> {
    const signal = AbortSignal.any([this.owner.signal, caller])
    const run = async () => {
      signal.throwIfAborted()
      const request = object(payload)
      if (endpoint === 'remote-login') return this.auth.startLogin(signal)
      if (endpoint === 'remote-poll-login') return this.auth.pollLogin(text(request, 'attemptId', 200), signal)
      if (endpoint === 'remote-cancel-login') return this.auth.cancelLogin(text(request, 'attemptId', 200))
      if (endpoint === 'remote-sign-out') return this.auth.signOut(signal)
      if (endpoint === 'remote-clear-grant') { await this.auth.clearLocalGrant(signal); this.initialized = undefined; return }
      if (endpoint === 'remote-retry-auth') { this.initialized = this.auth.retry(signal); await this.initialized; return this.capability() }
      if (endpoint === 'remote-use-git-credential') { await this.auth.useGitCredential(signal); return this.capability() }
      this.initialized ??= this.auth.establish(signal).catch(error => { this.initialized = undefined; throw error })
      await this.initialized
      const root = text(request, 'repository', 16384)
      if (endpoint === 'remote-repositories') return this.git.repositories(root, signal)
      const target = remoteTarget(request)
      await this.git.assertRepository(root, target, signal)
      const context = { signal, automatic: request['automatic'] === true }
      const n = () => objectNumber(Number(request['number']))
      switch (endpoint) {
        case 'remote-notifications': return this.provider.notifications(target, context)
        case 'remote-repository': return this.provider.repository(target, context)
        case 'remote-list-prs': return this.provider.pulls(target, request['state'] === 'closed' || request['state'] === 'all' ? request['state'] : 'open', paging(request), context)
        case 'remote-pr': return this.provider.pull(target, n(), context)
        case 'remote-list-issues': return this.provider.issues(target, request['state'] === 'closed' || request['state'] === 'all' ? request['state'] : 'open', paging(request), context)
        case 'remote-issue': return this.provider.issue(target, n(), context)
        case 'remote-comments': return this.provider.comments(target, n(), request['inline'] === true, paging(request), context)
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
      const key = JSON.stringify([root, expected.expectedGeneration, expected.expectedViewer, requestId])
      const previous = this.submissions.get(key)
      if (previous !== undefined) return previous
      if (this.submissions.size >= 512) throw new GitRemoteError('git/remote-unavailable', 'git-remote: submission budget exhausted; reopen remote integration')
      const submit = async () => {
        if (endpoint === 'remote-checkout-pr' || endpoint === 'remote-issue-branch') {
          const facts = await this.provider.repository(target, context)
          if (!sameGeneration(facts.generation, expected.expectedGeneration) || facts.value.viewer?.userId !== expected.expectedViewer.userId || facts.value.viewer.host !== expected.expectedViewer.host) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: local action confirmation is stale')
          await assertSession(request, signal)
          if (endpoint === 'remote-checkout-pr') {
            const pr = await this.provider.pull(target, n(), context)
            if (!sameGeneration(pr.generation, expected.expectedGeneration)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: checkout credentials changed')
            if (pr.value.head.sha !== sha(request)) throw new GitRemoteError('git/head-moved', 'git-remote: pull head changed')
            return this.git.checkout(root, target, pr.value, typeof request['branch'] === 'string' ? request['branch'] : undefined, signal, async () => { await assertSession(request, signal); const current = await this.auth.snapshot(signal); if (!sameGeneration(current.generation, expected.expectedGeneration)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: checkout confirmation changed') })
          }
          const issue = await this.provider.issue(target, n(), context)
          const slug = issue.value.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'issue'
          const branch = `issue-${n()}-${slug}`
          await this.service.createBranch(root, branch, signal)
          return this.service.switchBranch(root, branch, signal)
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
      this.submissions.set(key, submission)
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
