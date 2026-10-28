/** Portable remote owner: protocol dispatch and instance lifecycle only. */
import type { GitService } from '../service.ts'
import { createGitHubOwner, type LegacyRemoteChannel } from './assembly.ts'
import type { GitRemoteCredentialService } from './credentials.ts'
import { GitRemoteError } from './errors.ts'
import { canonicalGitLabInstance } from './instance-url.ts'
import { resolveGitLabInstances, sameGitLabInstanceConfiguration } from './instances.ts'
import type { GitRemoteSubprocess } from './probe.ts'
import { createGitLabProvider, GitLabProviderRegistry } from './registry.ts'
import { scopedRepositories } from './scoped-git.ts'
import { resolveRemoteSettings, validateRemoteSettings, type RemoteSettings } from './settings.ts'

export class GitRemoteRuntime {
  private readonly legacy: LegacyRemoteChannel
  private readonly registry: GitLabProviderRegistry
  private readonly owner = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly configurationTimer: ReturnType<typeof setInterval>
  constructor(credentials: GitRemoteCredentialService, subprocess: GitRemoteSubprocess, private readonly service: GitService, source?: RemoteSettings) {
    // Invalid GitLab configuration must not disable the existing GitHub channel.
    const legacySettings = { ...source }; delete legacySettings.instances
    validateRemoteSettings(legacySettings)
    const settings = resolveRemoteSettings(legacySettings)
    this.legacy = createGitHubOwner(credentials, subprocess, settings, service)
    this.registry = new GitLabProviderRegistry(credentials, source, instance => createGitLabProvider(instance, credentials, subprocess, settings, (root, args, signal) => service.remoteCommand(root, args, signal), () => {
      try { const current = resolveGitLabInstances(source?.instances).find(item => item.instance === instance.instance); return current !== undefined && sameGitLabInstanceConfiguration(current, instance) } catch { return true } // Invalid updates leave the last accepted snapshot active.
    }))
    // Volatile references have no change subscription: reconcile on a timer and before replies.
    this.configurationTimer = setInterval(() => { void this.registry.reconcile().catch(() => {}) }, 1000)
    this.configurationTimer.unref?.()
  }
  capability() { return this.legacy.capability() }
  invalidateRecord(key: string): void { this.legacy.invalidateRecord(key); this.registry.invalidateRecord(key) }
  invalidateReference(ref: string): void { this.legacy.invalidateReference(ref); this.registry.invalidateReference(ref) }
  handle(endpoint: string, payload: unknown, caller: AbortSignal, assertSession: (request: Record<string, unknown>, signal: AbortSignal) => Promise<void>): Promise<unknown> {
    const signal = AbortSignal.any([this.owner.signal, caller])
    const run = async () => {
      signal.throwIfAborted()
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !('remoteProtocol' in payload)) return this.legacy.handle(endpoint, payload, signal, assertSession)
      const request = payload as Record<string, unknown>
      if (request['remoteProtocol'] !== 2) throw new GitRemoteError('git/remote-unavailable', 'git-remote: unsupported scoped protocol', { reason: 'unsupported-protocol' })
      if (endpoint === 'remote-repositories') {
        if (typeof request['repository'] !== 'string' || request['repository'].length > 16384) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid repository')
        await assertSession(request, signal)
        const instances = await this.registry.list()
        const value = await scopedRepositories((cwd, args, inner) => this.service.remoteCommand(cwd, args, inner), request['repository'], instances, signal)
        signal.throwIfAborted()
        return { remoteProtocol: 2, value }
      }
      if (request['provider'] === 'gitlab' && endpoint === 'remote-retire-grant') {
        if (Object.keys(request).some(key => key !== 'remoteProtocol' && key !== 'provider' && key !== 'instance')) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid retirement request', { reason: 'invalid-request' })
        return this.registry.retire(request['instance'])
      }
      const provider = request['provider'] === 'github' ? this.legacy.scoped : request['provider'] === 'gitlab' ? await this.registry.provider(request['instance']) : undefined
      if (provider === undefined) throw new GitRemoteError('git/remote-unavailable', 'git-remote: scoped provider unavailable', { reason: 'provider-unavailable' })
      if (provider.scope.provider === 'github') {
        let instance: string
        try { instance = canonicalGitLabInstance(request['instance'] as string) } catch { throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid scoped instance', { reason: 'invalid-scope' }) }
        if (instance !== provider.scope.instance) throw new GitRemoteError('git/remote-unavailable', 'git-remote: scoped provider mismatch', { reason: 'provider-unavailable' })
      }
      const result = await provider.handle(endpoint, request, signal, {
        assertSession,
        assertRepository: async (scope, path, target, inner, requiredRemote) => {
          const root = target['repository']
          if (typeof root !== 'string' || root.length === 0 || root.length > 16384 || typeof path !== 'string') throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: invalid repository identity')
          await assertSession(target, inner)
          inner.throwIfAborted()
          const instances = await this.registry.list()
          inner.throwIfAborted()
          const found = await scopedRepositories((cwd, args, scopedSignal) => this.service.remoteCommand(cwd, args, scopedSignal), root, instances, inner)
          const allowed = found.remotes.find(({ identity, name }) => (requiredRemote === undefined || requiredRemote === name) && identity.provider === scope.provider && identity.scope.instance === scope.instance && ('path' in identity ? identity.path : `${identity.owner}/${identity.repo}`) === path)
          if (allowed === undefined) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: project is not an allowed local remote')
          return { name: allowed.name }
        },
      })
      try {
        if (provider.scope.provider === 'gitlab') await this.registry.guard(provider)
        signal.throwIfAborted()
        provider.assertGeneration?.(result.generation)
      } catch (error) { throw provider.interruptedResult?.(endpoint, request, result.value) ?? error }
      return { remoteProtocol: 2, scope: provider.scope, generation: result.generation, value: result.value }
    }
    const task = run().catch(error => {
      if (error instanceof GitRemoteError) throw error
      throw new GitRemoteError('git/remote-unavailable', 'git-remote: operation failed or was cancelled')
    }).finally(() => this.pending.delete(task))
    this.pending.add(task); return task
  }
  async dispose(): Promise<void> {
    this.owner.abort(); clearInterval(this.configurationTimer)
    await Promise.allSettled([this.legacy.dispose(), this.registry.dispose(), ...this.pending])
  }
}
