/** Method choice is persisted separately from OAuth secrets. */
import { randomUUID } from 'node:crypto'
import { gitRemoteCredentialKey, type GitRemoteCredentialService } from './credentials.ts'
import { remoteAuthError } from './errors.ts'
import type { CredentialKey, CredentialRecord } from './credentials-types.ts'
import type { RemoteAuthMethod, RemoteAuthSelection } from './types.ts'

export function authSelectionKey(grantKey: string): CredentialKey {
  return gitRemoteCredentialKey('dsh-plugin-git-auth', grantKey.split('/')[1]!)
}
export function authMethod(value: unknown): 'cli' | 'oauth' {
  if (value !== 'cli' && value !== 'oauth') throw remoteAuthError('invalid-auth-method')
  return value
}
export function hasOAuthRecord(record: CredentialRecord | undefined): boolean {
  const p = record?.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null ? record.payload as { state?: unknown } : undefined
  return p !== undefined && p.state !== 'signed-out'
}
export class AuthSelectionStore {
  private currentMethod: RemoteAuthMethod = 'auto'
  readonly key: CredentialKey
  constructor(private readonly store: GitRemoteCredentialService, grantKey: CredentialKey, private readonly provider: 'github' | 'gitlab', private readonly instance: string, private readonly guard: () => void = () => {}) {
    this.key = authSelectionKey(grantKey)
  }
  async read(): Promise<{ method: RemoteAuthMethod; revision?: string }> {
    const record = await this.store.readRecord(this.key)
    if (record === undefined) { this.currentMethod = 'auto'; return { method: 'auto' } }
    const p = record.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null ? record.payload as Record<string, unknown> : undefined
    if (p === undefined || p['v'] !== 1 || p['provider'] !== this.provider || p['instance'] !== this.instance
      || (p['method'] !== 'auto' && p['method'] !== 'cli' && p['method'] !== 'oauth') || typeof p['revision'] !== 'string' || p['revision'] === ''
      || Object.keys(p).some(key => !['v', 'provider', 'instance', 'method', 'revision'].includes(key))) throw remoteAuthError('invalid-auth-selection')
    this.currentMethod = p['method'] as RemoteAuthMethod
    return { method: this.currentMethod, revision: p['revision'] }
  }
  async write(method: RemoteAuthMethod): Promise<void> {
    this.guard()
    if (method === 'auto' && await this.store.readRecord(this.key) === undefined) { this.currentMethod = 'auto'; return }
    const revision = randomUUID()
    const saved = await this.store.modifyRecord(this.key, async () => {
      this.guard()
      return { kind: 'grant', payload: { v: 1, provider: this.provider, instance: this.instance, method, revision } }
    })
    if (saved?.kind !== 'grant' || (saved.payload as { revision?: unknown })?.revision !== revision) throw remoteAuthError('store-write-failed')
    this.currentMethod = method
  }
  capability(cliAvailable: boolean, oauthCached: boolean): RemoteAuthSelection {
    return { method: this.currentMethod, cliAvailable, oauthCached }
  }
}
