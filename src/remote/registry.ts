/** Scoped provider factory and registry. Configuration and orphan retirement serialize together. */
import type { GitRemoteCredentialService } from './credentials.ts'
import { GitRemoteError } from './errors.ts'
import { GitLabAuth } from './gitlab-auth.ts'
import { GitLabProjectReader, interruptedGitLabMutation } from './gitlab-project.ts'
import { retireGitLabGrant } from './gitlab-grant.ts'
import { GitRemoteHttp } from './http.ts'
import { canonicalGitLabInstance, GITLAB_COM, gitLabGrantKey, resolveGitLabInstances, sameGitLabInstanceConfiguration, type GitLabInstance } from './instances.ts'
import { glabAuthToken, type GitRemoteSubprocess } from './probe.ts'
import { authSelectionKey } from './auth-selection.ts'
import type { RemoteGitRun } from './git.ts'
import type { RemoteSettings, ResolvedRemoteSettings } from './settings.ts'
import type { ScopedRemoteScope } from './types.ts'

/** All instance behavior is behind this internal interface, assembled at the boundary. */
export interface ScopedRequestContext {
  readonly assertSession: (request: Record<string, unknown>, signal: AbortSignal) => Promise<void>
  readonly assertRepository: (scope: ScopedRemoteScope, path: string, request: Record<string, unknown>, signal: AbortSignal, requiredRemote?: 'origin' | 'upstream') => Promise<{ readonly name: 'origin' | 'upstream' }>
}
export interface ScopedRemoteProvider {
  readonly scope: ScopedRemoteScope
  handle(endpoint: string, request: Record<string, unknown>, signal: AbortSignal, context?: ScopedRequestContext): Promise<{ generation: import('./types.ts').GitRemoteGeneration; value: unknown }>
  dispose(): Promise<void>
  invalidate?(kind: 'record' | 'reference'): void
  assertGeneration?(generation: import('./types.ts').GitRemoteGeneration): void
  interruptedResult?(endpoint: string, request: Record<string, unknown>, value: unknown): GitRemoteError | undefined
}
function unavailable(reason: string): GitRemoteError { return new GitRemoteError('git/remote-unavailable', 'git-remote: scoped operation unavailable', { reason }) }
function attemptId(request: Record<string, unknown>): string {
  const value = request['attemptId']
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw unavailable('invalid-attempt')
  return value
}
class GitLabScopedProvider implements ScopedRemoteProvider {
  readonly scope: ScopedRemoteScope
  private readonly owner = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  constructor(instance: GitLabInstance, private readonly auth: GitLabAuth, private readonly projects: GitLabProjectReader) { this.scope = { provider: 'gitlab', instance: instance.instance } }
  handle(endpoint: string, request: Record<string, unknown>, caller: AbortSignal, context?: ScopedRequestContext) {
    if (this.owner.signal.aborted) return Promise.reject(unavailable('instance-removed'))
    const signal = AbortSignal.any([caller, this.owner.signal])
    const run = async () => {
      signal.throwIfAborted()
      if (['remote-account', 'remote-select-auth', 'remote-oauth-logout', 'remote-login', 'remote-poll-login', 'remote-cancel-login', 'remote-sign-out', 'remote-clear-grant', 'remote-retry-auth'].includes(endpoint) && ['credentialRef', 'ref', 'key', 'clientId', 'accessToken', 'refreshToken'].some(key => Object.hasOwn(request, key))) throw unavailable('invalid-request')
      let result
      switch (endpoint) {
        case 'remote-account':
          try { await this.auth.establish(signal) } catch (error) {
            // A rejected stored credential already marks the state invalid; the read still reports it.
            if (!(error instanceof GitRemoteError) || error.details?.['reason'] !== 'invalid-token') throw error
          }
          result = await this.auth.capability(signal); break
        case 'remote-capability': result = await this.auth.capability(signal); break
        case 'remote-login': result = await this.auth.startLogin(signal); break
        case 'remote-poll-login': result = await this.auth.pollLogin(attemptId(request), signal); break
        case 'remote-cancel-login': result = await this.auth.cancelLogin(attemptId(request)); break
        case 'remote-sign-out': result = await this.auth.signOut(signal); break
        case 'remote-select-auth': result = await this.auth.selectMethod(request['method'], signal); break
        case 'remote-oauth-logout': result = await this.auth.logoutOAuth(signal); break
        case 'remote-clear-grant': result = await this.auth.clearGrant(signal); break
        case 'remote-retry-auth': result = await this.auth.retry(signal); break
        case 'remote-repository': result = await this.projects.repository(request, signal, context); break
        case 'remote-list-prs': result = await this.projects.list('pulls', request, signal, context); break
        case 'remote-list-issues': result = await this.projects.list('issues', request, signal, context); break
        case 'remote-pr': result = await this.projects.detail('pulls', request, signal, context); break
        case 'remote-issue': result = await this.projects.detail('issues', request, signal, context); break
        case 'remote-commits': result = await this.projects.collection('commits', request, signal, context); break
        case 'remote-comments': result = await this.projects.collection('comments', request, signal, context); break
        case 'remote-discussions': result = await this.projects.collection('discussions', request, signal, context); break
        case 'remote-approvals': result = await this.projects.approvals(request, signal, context); break
        case 'remote-notifications': result = await this.projects.notifications(request, signal, context); break
        case 'remote-files': result = await this.projects.files(request, signal, context); break
        case 'remote-checkout-pr': result = await this.projects.checkout(request, signal, context); break
        case 'remote-issue-branch': result = await this.projects.issueBranch(request, signal, context); break
        case 'remote-comment': case 'remote-review': case 'remote-close-pr': case 'remote-merge-pr': case 'remote-create-pr': result = await this.projects.write(endpoint, request, signal, context); break
        default: throw unavailable('not-implemented')
      }
      try { signal.throwIfAborted() } catch (error) { throw interruptedGitLabMutation(endpoint, request, result.value) ?? error }
      return result
    }
    const task = run().finally(() => this.pending.delete(task))
    this.pending.add(task); return task
  }
  invalidate(kind: 'record' | 'reference'): void { this.auth.invalidate(kind) }
  assertGeneration(generation: import('./types.ts').GitRemoteGeneration): void { this.auth.assertGeneration(generation) }
  interruptedResult(endpoint: string, request: Record<string, unknown>, value: unknown): GitRemoteError | undefined { return interruptedGitLabMutation(endpoint, request, value) }
  async dispose(): Promise<void> { this.owner.abort(); await Promise.allSettled([this.auth.dispose(), ...this.pending]); this.projects.dispose() }
}
export function createGitLabProvider(instance: GitLabInstance, credentials: GitRemoteCredentialService, subprocess: GitRemoteSubprocess, settings: ResolvedRemoteSettings, run: RemoteGitRun, isCurrent?: () => boolean): ScopedRemoteProvider {
  const http = new GitRemoteHttp({ requestTimeoutMs: settings.requestTimeoutMs, maxResponseBytes: settings.maxResponseBytes, gitlabInstance: instance.instance })
  const auth = new GitLabAuth({ credentials, instance, http, settings, ...(isCurrent === undefined ? {} : { isCurrent }), ...(instance.instance === GITLAB_COM ? { discoverGlab: (signal: AbortSignal) => glabAuthToken({ subprocess, probeTimeoutMs: settings.probeTimeoutMs }, signal) } : {}) })
  return new GitLabScopedProvider(instance, auth, new GitLabProjectReader(instance, auth, http, run))
}

export class GitLabProviderRegistry {
  private readonly descriptors = new Map<string, GitLabInstance>()
  private readonly providers = new Map<string, ScopedRemoteProvider>()
  private readonly draining = new Map<string, Promise<void>>()
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false
  private invalidConfiguration = false
  private disposal: Promise<void> | undefined
  constructor(private readonly credentials: GitRemoteCredentialService, private readonly source: RemoteSettings | undefined, private readonly factory: (instance: GitLabInstance) => ScopedRemoteProvider) {}
  private lock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => { if (this.disposed) throw unavailable('disposed'); return work() })
    this.chain = next.catch(() => {}); return next
  }
  private drain(provider: ScopedRemoteProvider): void {
    const key = provider.scope.instance, previous = this.draining.get(key)
    // dispose aborts synchronously. Never join its requests while holding the registry lock:
    // a cancelled business request may still need list() to finish its repository guard.
    const task = Promise.allSettled([previous, provider.dispose()]).then(() => {}).finally(() => {
      if (this.draining.get(key) === task) this.draining.delete(key)
    })
    this.draining.set(key, task)
  }
  private async synchronize(): Promise<void> {
    let next: readonly GitLabInstance[]
    try { next = resolveGitLabInstances(this.source?.instances); this.invalidConfiguration = false } catch {
      this.invalidConfiguration = true
      if (this.descriptors.size === 0) {
        // An invalid first configuration cannot disable the built-in instance or GitHub discovery.
        for (const instance of resolveGitLabInstances(undefined)) this.descriptors.set(instance.instance, instance)
      }
      return // Reject the entire update and continue serving the last valid snapshot.
    }
    const incoming = new Map(next.map(instance => [instance.instance, instance]))
    const removed: ScopedRemoteProvider[] = []
    for (const [key, old] of this.descriptors) {
      const updated = incoming.get(key)
      if (updated === undefined || !sameGitLabInstanceConfiguration(old, updated)) {
        const provider = this.providers.get(key); if (provider !== undefined) removed.push(provider)
        this.providers.delete(key)
      }
    }
    // Publish the new snapshot and cancel old owners; drainage runs outside the lock.
    this.descriptors.clear(); for (const [key, item] of incoming) this.descriptors.set(key, item)
    for (const provider of removed) this.drain(provider)
  }
  invalidateRecord(key: string): void {
    for (const [instance, provider] of this.providers) if (gitLabGrantKey(instance) === key || authSelectionKey(gitLabGrantKey(instance)) === key) provider.invalidate?.('record')
  }
  invalidateReference(ref: string): void {
    for (const [instance, provider] of this.providers) {
      const descriptor = this.descriptors.get(instance)
      if (descriptor?.credentialRef === ref || (instance === GITLAB_COM && (ref === 'GITLAB_TOKEN' || ref === 'GL_TOKEN'))) provider.invalidate?.('reference')
    }
  }
  async reconcile(): Promise<void> { return this.lock(async () => { await this.synchronize() }) }
  async guard(provider: ScopedRemoteProvider): Promise<void> {
    return this.lock(async () => { await this.synchronize(); if (this.providers.get(provider.scope.instance) !== provider) throw unavailable('instance-removed') })
  }
  async list(): Promise<readonly GitLabInstance[]> { return this.lock(async () => { await this.synchronize(); return [...this.descriptors.values()] }) }
  async provider(raw: unknown): Promise<ScopedRemoteProvider> {
    if (typeof raw !== 'string') throw unavailable('scope-missing')
    let instance: string
    try { instance = canonicalGitLabInstance(raw) } catch { throw unavailable('invalid-scope') }
    for (;;) {
      const next = await this.lock(async () => {
        await this.synchronize()
        const descriptor = this.descriptors.get(instance)
        if (descriptor === undefined) throw unavailable(this.invalidConfiguration ? 'invalid-instance-config' : 'instance-unknown')
        const draining = this.draining.get(instance)
        if (draining !== undefined) return { draining }
        let provider = this.providers.get(instance)
        if (provider === undefined) { provider = this.factory(descriptor); this.providers.set(instance, provider) }
        return { provider }
      })
      if (next.provider !== undefined) return next.provider
      // Recheck configuration after draining: another update or disposal may have won.
      await next.draining
    }
  }
  async retire(raw: unknown): Promise<{ remoteProtocol: 2; scope: ScopedRemoteScope; generation: null; value: { disposition: 'retired' | 'already-retired' | 'absent' } }> {
    if (typeof raw !== 'string') throw unavailable('scope-missing')
    let instance: string
    try { instance = canonicalGitLabInstance(raw) } catch { throw unavailable('invalid-scope') }
    return this.lock(async () => {
      await this.synchronize()
      if (this.invalidConfiguration) throw unavailable('invalid-instance-config')
      if (this.descriptors.has(instance)) throw unavailable('instance-registered')
      let result
      try { result = await retireGitLabGrant(this.credentials, instance) } catch (error) { if (error instanceof GitRemoteError) throw error; throw unavailable('store-failed') }
      return { remoteProtocol: 2, scope: { provider: 'gitlab', instance }, generation: null, value: { disposition: result.disposition } }
    })
  }
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    const done = this.chain.then(() => {
      const all = [...this.providers.values()]; this.providers.clear(); this.descriptors.clear()
      for (const provider of all) this.drain(provider)
      return [...this.draining.values()]
    }).then(async tasks => { await Promise.allSettled(tasks) })
    // Keep the admission chain free so late guards reject as disposed instead of
    // waiting behind disposal, which itself joins those guards' requests.
    this.disposal = done; return done
  }
}
