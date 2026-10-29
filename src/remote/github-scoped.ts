/** Scoped facade for the existing GitHub auth owner; v1 and its grant remain unchanged. */
import type { GitRemoteAuth } from './auth.ts'
import { GitRemoteError } from './errors.ts'
import { sameGeneration } from './github.ts'
import type { GitRemoteGeneration, ScopedRemoteCapabilityOn } from './types.ts'
import type { RemoteRepositoryFacts } from './provider.ts'

export class GitHubScopedProvider {
  readonly scope = { provider: 'github', instance: 'https://github.com' } as const
  constructor(private readonly auth: GitRemoteAuth) {}
  async handle(endpoint: string, request: Record<string, unknown>, signal: AbortSignal, legacy?: (endpoint: string, request: Record<string, unknown>) => Promise<unknown>): Promise<{ generation: GitRemoteGeneration; value: unknown }> {
    signal.throwIfAborted()
    if (endpoint === 'remote-capability') {
      const cap = await this.auth.capability()
      return { generation: cap.generation, value: this.project(cap) }
    }
    if (endpoint === 'remote-account' && legacy !== undefined) {
      const { remoteProtocol: _marker, ...rest } = request
      const result = await legacy(endpoint, rest) as { generation: GitRemoteGeneration; value: Awaited<ReturnType<GitRemoteAuth['capability']>> }
      return { generation: result.generation, value: this.project(result.value) }
    }
    if (!['remote-select-auth', 'remote-oauth-logout', 'remote-login', 'remote-poll-login', 'remote-cancel-login', 'remote-sign-out', 'remote-clear-grant', 'remote-retry-auth', 'remote-use-git-credential'].includes(endpoint)) {
      if (legacy === undefined) throw new GitRemoteError('git/remote-unavailable', 'git-remote: scoped operation not implemented', { reason: 'not-implemented' })
      return this.business(endpoint, request, legacy)
    }
    let generation: GitRemoteGeneration | undefined
    const capture = (value: GitRemoteGeneration) => { generation = value }
    let value: unknown = null
    switch (endpoint) {
      case 'remote-login': value = await this.auth.startLogin(signal, capture); break
      case 'remote-poll-login': value = await this.auth.pollLogin(this.attempt(request), signal, capture); break
      case 'remote-cancel-login': {
        const attempt = this.attempt(request)
        if (!this.auth.ownsLogin(attempt)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: unknown scoped attempt', { reason: 'unknown-attempt' })
        await this.auth.cancelLogin(attempt, capture); break
      }
      case 'remote-sign-out': await this.auth.signOut(signal, capture); break
      case 'remote-select-auth': await this.auth.selectMethod(request['method'], signal, capture); value = await this.auth.capability(); break
      case 'remote-oauth-logout': await this.auth.logoutOAuth(signal, capture); value = await this.auth.capability(); break
      case 'remote-clear-grant': await this.auth.clearLocalGrant(signal, capture); break
      case 'remote-retry-auth': await this.auth.retry(signal, capture); value = await this.auth.capability(); break
      case 'remote-use-git-credential': await this.auth.useGitCredential(signal, capture); value = await this.auth.capability(); break
      default: throw new GitRemoteError('git/remote-unavailable', 'git-remote: scoped operation not implemented', { reason: 'not-implemented' })
    }
    signal.throwIfAborted()
    if (generation === undefined) throw new GitRemoteError('git/remote-unavailable', 'git-remote: missing operation generation', { reason: 'generation-missing' })
    if (endpoint === 'remote-select-auth' || endpoint === 'remote-oauth-logout' || endpoint === 'remote-retry-auth' || endpoint === 'remote-use-git-credential') {
      const cap = value as Awaited<ReturnType<GitRemoteAuth['capability']>>
      if (!sameGeneration(generation, cap.generation)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: authentication changed during response')
      value = this.project(cap)
    }
    return { generation, value }
  }
  private async business(endpoint: string, request: Record<string, unknown>, legacy: (endpoint: string, request: Record<string, unknown>) => Promise<unknown>): Promise<{ generation: GitRemoteGeneration; value: unknown }> {
    const reads = ['remote-repository', 'remote-list-prs', 'remote-pr', 'remote-list-issues', 'remote-issue', 'remote-comments', 'remote-files', 'remote-commits', 'remote-reviews', 'remote-notifications']
    const writes = ['remote-comment', 'remote-inline-comment', 'remote-review', 'remote-close-pr', 'remote-merge-pr', 'remote-create-pr', 'remote-checkout-pr', 'remote-issue-branch']
    if (!reads.includes(endpoint) && !writes.includes(endpoint)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: scoped operation not implemented', { reason: 'not-implemented' })
    if (request['host'] !== undefined && request['host'] !== 'github.com') throw new GitRemoteError('git/remote-unavailable', 'git-remote: scoped provider mismatch', { reason: 'provider-unavailable' })
    if (writes.includes(endpoint) && request['expectedInstance'] !== this.scope.instance) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: scoped confirmation mismatch')
    if (writes.includes(endpoint) && request['object'] !== undefined) {
      const object = request['object']
      if (typeof object !== 'object' || object === null || Array.isArray(object)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid action scope')
      const data = object as Record<string, unknown>
      const kind = endpoint === 'remote-issue-branch' ? 'issue' : 'pull'
      if (data['kind'] !== kind || (endpoint !== 'remote-create-pr' && data['number'] !== request['number'])) throw new GitRemoteError('git/remote-unavailable', 'git-remote: action is unsupported for this object', { reason: 'not-supported' })
    }
    if (endpoint === 'remote-merge-pr' && request['method'] !== undefined && request['method'] !== 'merge' && request['method'] !== 'squash') throw new GitRemoteError('git/remote-unavailable', 'git-remote: merge method is unsupported', { reason: 'not-supported' })
    let actionObject: { kind: 'pull' | 'issue'; number: number } | undefined
    if (endpoint === 'remote-repository' && request['object'] !== undefined) {
      const raw = request['object']
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid action scope')
      const data = raw as Record<string, unknown>
      if ((data['kind'] !== 'pull' && data['kind'] !== 'issue') || typeof data['number'] !== 'number' || !Number.isSafeInteger(data['number']) || data['number'] <= 0) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid action scope')
      actionObject = { kind: data['kind'], number: data['number'] }
    }
    // This is an explicit scoped adapter, reached only after v2 negotiation and scope validation.
    // The legacy executor retains its existing repository and viewer guards.
    const { remoteProtocol: _marker, ...rest } = request
    let head: Record<string, unknown> | undefined
    if (endpoint === 'remote-create-pr') {
      const value = request['head']
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: invalid source scope')
      head = value as Record<string, unknown>
      if ((head['provider'] !== undefined && head['provider'] !== 'github') || (head['host'] !== undefined && head['host'] !== 'github.com') || (head['instance'] !== undefined && head['instance'] !== this.scope.instance)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: invalid source scope')
      if (head['scope'] !== undefined) {
        const scope = head['scope'] as Record<string, unknown> | null
        if (scope === null || typeof scope !== 'object' || Array.isArray(scope) || scope['provider'] !== 'github' || scope['instance'] !== this.scope.instance) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: invalid source scope')
      }
    }
    const result = await legacy(endpoint, { ...rest, host: 'github.com', ...(head === undefined ? {} : { head: { ...head, host: 'github.com' } }) }) as { generation?: GitRemoteGeneration; value?: unknown }
    if (result?.generation === undefined || !Object.hasOwn(result, 'value')) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid operation result')
    if (endpoint === 'remote-repository') {
      const { supportedMergeMethods, ...facts } = result.value as RemoteRepositoryFacts & { supportedMergeMethods: readonly ('merge' | 'squash')[] }
      const cautious = (value: boolean | 'unknown') => value === false ? false : 'unknown' as const
      const owner = request['owner'], repo = request['repo']
      if (typeof owner !== 'string' || typeof repo !== 'string') throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid action scope')
      const issue = actionObject?.kind === 'issue'
      const supported = issue ? { supported: false, reason: 'not-supported' } : { supported: true }
      const merge = issue || supportedMergeMethods.length === 0 ? { supported: false, reason: issue ? 'not-supported' : 'capability-pending' } : { supported: true }
      return { generation: result.generation, value: {
        ...facts,
        actions: issue ? { canComment: false, canReview: false, canMerge: false, canClose: false, canCreatePr: false } : { canComment: cautious(facts.actions.canComment), canReview: cautious(facts.actions.canReview), canMerge: merge.supported ? cautious(facts.actions.canMerge) : false, canClose: cautious(facts.actions.canClose), canCreatePr: cautious(facts.actions.canCreatePr) },
        actionScope: { path: `${owner}/${repo}`, ...(actionObject === undefined ? {} : { object: actionObject }) },
        operationSupport: { comment: supported, 'inline-comment': supported, review: supported, 'close-pr': supported, 'merge-pr': merge, 'create-pr': supported },
        supportedMergeMethods: issue ? [] : supportedMergeMethods, supportedReviewEvents: issue ? [] : ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'],
      } }
    }
    if (endpoint === 'remote-checkout-pr' || endpoint === 'remote-issue-branch') return { generation: result.generation, value: result.value }
    if (writes.includes(endpoint)) {
      const receipt = result.value as { id?: string }
      return { generation: result.generation, value: { outcome: 'succeeded', steps: [{ kind: endpoint.slice('remote-'.length), state: 'succeeded', ...(typeof receipt?.id === 'string' ? { id: receipt.id } : {}) }], receipt: result.value } }
    }
    return { generation: result.generation, value: result.value }
  }
  private project(cap: Awaited<ReturnType<GitRemoteAuth['capability']>>): ScopedRemoteCapabilityOn {
    return { ...cap, authMethods: { deviceFlow: { supported: true } }, loginAvailable: cap.loginAvailable && cap.credential.writable }
  }
  private attempt(request: Record<string, unknown>): string {
    const value = request['attemptId']
    if (typeof value !== 'string' || value === '' || value.length > 200) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid scoped attempt', { reason: 'invalid-attempt' })
    return value
  }
  async dispose(): Promise<void> { /* v1 runtime owns the shared GitHub auth engine. */ }
}
