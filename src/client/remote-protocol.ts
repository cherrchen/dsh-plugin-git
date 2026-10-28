/** Fail-closed v2 negotiation and scoped-response validation for portable Clients. */
import { canonicalGitLabInstance } from '../remote/instance-url.ts'
import type { GitRemoteGeneration, ScopedRemoteEnvelope, ScopedRemoteScope } from '../remote/types.ts'
import type { GitRpcClient } from './controller.ts'

export class ScopedProtocolError extends Error {
  constructor(readonly reason: string, readonly code?: string, readonly details?: Readonly<Record<string, string | number | boolean>>) { super(`git remote scoped protocol unavailable (${reason})`) }
}
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function generation(value: unknown): GitRemoteGeneration | undefined {
  const data = record(value)
  if (typeof data?.['instanceId'] !== 'string' || data['instanceId'] === '' || typeof data['revision'] !== 'number' || !Number.isSafeInteger(data['revision']) || data['revision'] < 0) return undefined
  return { instanceId: data['instanceId'], revision: data['revision'] }
}
function controlError(value: unknown): ScopedProtocolError {
  const data = record(value), code = data?.['code']
  const allowed = ['git/remote-unavailable', 'git/unauthenticated', 'git/signed-out', 'git/insufficient-scope', 'git/head-moved', 'git/rate-limited', 'git/write-result-unknown', 'git/remote-identity-mismatch']
  const safeCode = typeof code === 'string' && allowed.includes(code) ? code : 'git/remote-unavailable'
  const raw = record(data?.['details']), details: Record<string, string | number | boolean> = {}
  for (const key of ['reason', 'action', 'stage', 'number', 'commentId', 'commentSucceeded', 'projectId', 'resetAt']) {
    const item = raw?.[key]
    if (typeof item === 'boolean' || typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 || typeof item === 'string' && /^[A-Za-z0-9_/-]{1,200}$/u.test(item)) details[key] = item
  }
  return new ScopedProtocolError('control-error', safeCode, details)
}
export class ScopedRemoteClient {
  private enabled = false
  private capabilityEpoch = 0
  private readonly sequence = new Map<string, number>()
  private readonly generations = new Map<string, GitRemoteGeneration>()
  private readonly retiredGenerations = new Map<string, Set<string>>()
  constructor(private readonly rpc: GitRpcClient) {}
  get available(): boolean { return this.enabled }
  invalidate(inputScope: ScopedRemoteScope, lane?: string): void {
    const scope = normalizeScope(inputScope), scopeKey = JSON.stringify(scope), key = lane === undefined ? scopeKey : JSON.stringify([scope, lane])
    this.sequence.set(key, (this.sequence.get(key) ?? 0) + 1)
  }
  observeCapability(value: unknown): void {
    const cap = record(value)
    const next = cap?.['state'] === 'on' && cap['remoteProtocol'] === 2
    if (this.enabled !== next) { this.capabilityEpoch++; this.sequence.clear(); this.generations.clear(); this.retiredGenerations.clear() }
    this.enabled = next
    // The unscoped capability is the GitHub v1 owner’s authoritative generation.
    if (next) {
      const actual = generation(cap?.['generation'])
      const key = JSON.stringify({ provider: 'github', instance: 'https://github.com' })
      const previous = this.generations.get(key)
      if (actual !== undefined && (previous === undefined || previous.instanceId !== actual.instanceId || previous.revision !== actual.revision)) {
        this.sequence.set(key, (this.sequence.get(key) ?? 0) + 1)
        this.generations.set(key, actual)
      }
    }
  }
  async call<T>(endpoint: string, inputScope: ScopedRemoteScope, payload: Record<string, unknown> = {}, signal?: AbortSignal, lane?: string): Promise<ScopedRemoteEnvelope<T>> {
    if (!this.enabled) throw new ScopedProtocolError('host-not-negotiated')
    const scope = normalizeScope(inputScope)
    const scopeKey = JSON.stringify(scope), key = lane === undefined ? scopeKey : JSON.stringify([scope, lane]), seq = (this.sequence.get(key) ?? 0) + 1, epoch = this.capabilityEpoch
    this.sequence.set(key, seq)
    const reply = await this.rpc.call('/git', endpoint, { ...payload, remoteProtocol: 2, provider: scope.provider, instance: scope.instance }, signal)
    if (!this.enabled || this.capabilityEpoch !== epoch || this.sequence.get(key) !== seq) throw new ScopedProtocolError('stale-response')
    if (!reply.ok) throw controlError(reply.error)
    const data = record(reply.value), echoed = record(data?.['scope'])
    if (record(reply.value)?.['state'] === 'off') throw new ScopedProtocolError('seam-off')
    if (data === undefined || !Object.hasOwn(data, 'value') || data['remoteProtocol'] !== 2 || echoed?.['provider'] !== scope.provider || echoed['instance'] !== scope.instance) throw new ScopedProtocolError('scope-mismatch')
    const actual = generation(data['generation'])
    if (actual === undefined) throw new ScopedProtocolError('generation-missing')
    const previous = this.generations.get(scopeKey)
    if (previous?.instanceId === actual.instanceId && actual.revision < previous.revision) throw new ScopedProtocolError('stale-generation')
    if (previous !== undefined && previous.instanceId !== actual.instanceId) {
      const retired = this.retiredGenerations.get(scopeKey) ?? new Set<string>()
      if (retired.has(actual.instanceId)) throw new ScopedProtocolError('stale-generation')
      retired.add(previous.instanceId); this.retiredGenerations.set(scopeKey, retired)
    }
    const candidate = record(data['value'])
    if (endpoint === 'remote-capability' || candidate?.['state'] === 'on') {
      const nested = generation(candidate?.['generation'])
      if (nested?.instanceId !== actual.instanceId || nested.revision !== actual.revision) throw new ScopedProtocolError('generation-mismatch')
    }
    this.generations.set(scopeKey, actual)
    return { remoteProtocol: 2, scope, generation: actual, value: data['value'] as T }
  }
  async discover(repository: string, sessionId?: string, signal?: AbortSignal): Promise<{ state: 'supported' | 'no-remotes' | 'unsupported'; remotes: readonly { name: 'origin' | 'upstream'; identity: import('../remote/provider.ts').ScopedRemoteRepository }[]; unresolved?: readonly { name: 'origin' | 'upstream'; reason: 'unregistered' | 'ambiguous' }[] }> {
    if (!this.enabled) throw new ScopedProtocolError('host-not-negotiated')
    const key = JSON.stringify(['discovery', repository, sessionId ?? '']), seq = (this.sequence.get(key) ?? 0) + 1, epoch = this.capabilityEpoch
    this.sequence.set(key, seq)
    const reply = await this.rpc.call('/git', 'remote-repositories', { remoteProtocol: 2, repository, ...(sessionId === undefined ? {} : { sessionId }) }, signal)
    if (!this.enabled || this.capabilityEpoch !== epoch || this.sequence.get(key) !== seq) throw new ScopedProtocolError('stale-response')
    if (!reply.ok) throw new ScopedProtocolError('control-error')
    const data = record(reply.value), value = record(data?.['value'])
    if (data?.['remoteProtocol'] !== 2 || data['scope'] !== undefined || data['generation'] !== undefined || !['supported', 'no-remotes', 'unsupported'].includes(String(value?.['state'])) || !Array.isArray(value?.['remotes'])) throw new ScopedProtocolError('invalid-discovery')
    const remotes = value['remotes'].map((raw: unknown): { name: 'origin' | 'upstream'; identity: import('../remote/provider.ts').ScopedRemoteRepository } => {
      const entry = record(raw), identity = record(entry?.['identity']), rawScope = record(identity?.['scope'])
      const name = entry?.['name']
      if ((name !== 'origin' && name !== 'upstream') || (rawScope?.['provider'] !== 'github' && rawScope?.['provider'] !== 'gitlab') || typeof rawScope['instance'] !== 'string') throw new ScopedProtocolError('invalid-discovery')
      const scope = normalizeScope({ provider: rawScope['provider'], instance: rawScope['instance'] })
      if (scope.instance !== rawScope['instance'] || identity?.['provider'] !== scope.provider) throw new ScopedProtocolError('invalid-discovery')
      if (scope.provider === 'gitlab') {
        if (identity['instance'] !== scope.instance || typeof identity['path'] !== 'string' || identity['path'] === '') throw new ScopedProtocolError('invalid-discovery')
        return { name, identity: { provider: 'gitlab' as const, instance: scope.instance, path: identity['path'], scope } }
      }
      if (identity['host'] !== 'github.com' || typeof identity['owner'] !== 'string' || typeof identity['repo'] !== 'string' || identity['owner'] === '' || identity['repo'] === '') throw new ScopedProtocolError('invalid-discovery')
      return { name, identity: { provider: 'github' as const, host: 'github.com' as const, owner: identity['owner'], repo: identity['repo'], scope } }
    })
    const unresolved = value['unresolved']
    if (unresolved !== undefined && !Array.isArray(unresolved)) throw new ScopedProtocolError('invalid-discovery')
    const safeUnresolved = (unresolved ?? []).map((raw: unknown): { name: 'origin' | 'upstream'; reason: 'unregistered' | 'ambiguous' } => {
      const entry = record(raw)
      if ((entry?.['name'] !== 'origin' && entry?.['name'] !== 'upstream') || (entry['reason'] !== 'unregistered' && entry['reason'] !== 'ambiguous')) throw new ScopedProtocolError('invalid-discovery')
      return { name: entry['name'], reason: entry['reason'] }
    })
    const state = value['state'] as 'supported' | 'no-remotes' | 'unsupported'
    if ((state === 'supported') !== (remotes.length > 0) || (state === 'no-remotes' && safeUnresolved.length > 0)) throw new ScopedProtocolError('invalid-discovery')
    return { state, remotes, ...(safeUnresolved.length ? { unresolved: safeUnresolved } : {}) }
  }
  async retire(rawInstance: string, signal?: AbortSignal): Promise<{ disposition: 'retired' | 'already-retired' | 'absent' }> {
    if (!this.enabled) throw new ScopedProtocolError('host-not-negotiated')
    const scope = normalizeScope({ provider: 'gitlab', instance: rawInstance })
    const key = `retire:${JSON.stringify(scope)}`, seq = (this.sequence.get(key) ?? 0) + 1, epoch = this.capabilityEpoch
    this.sequence.set(key, seq)
    const reply = await this.rpc.call('/git', 'remote-retire-grant', { remoteProtocol: 2, ...scope }, signal)
    if (!this.enabled || this.capabilityEpoch !== epoch || this.sequence.get(key) !== seq) throw new ScopedProtocolError('stale-response')
    if (!reply.ok) {
      const error = record(reply.error), details = record(error?.['details']), reason = details?.['reason']
      throw new ScopedProtocolError(reason === 'instance-registered' || reason === 'record-mismatch' || reason === 'store-failed' ? reason : 'control-error')
    }
    const data = record(reply.value), echoed = record(data?.['scope']), value = record(data?.['value'])
    if (data?.['remoteProtocol'] !== 2 || echoed?.['provider'] !== 'gitlab' || echoed['instance'] !== scope.instance || data['generation'] !== null || !['retired', 'already-retired', 'absent'].includes(String(value?.['disposition']))) throw new ScopedProtocolError('invalid-retirement')
    return { disposition: value?.['disposition'] as 'retired' | 'already-retired' | 'absent' }
  }
}
function normalizeScope(scope: ScopedRemoteScope): ScopedRemoteScope {
  if (scope.provider === 'github' && scope.instance === 'https://github.com') return scope
  if (scope.provider !== 'gitlab') throw new ScopedProtocolError('invalid-scope')
  try { return { provider: 'gitlab', instance: canonicalGitLabInstance(scope.instance) } } catch { throw new ScopedProtocolError('invalid-scope') }
}
