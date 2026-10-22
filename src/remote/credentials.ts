/** Structural probe of the optional `ctx.credentials` seam and local credential key/ref grammar (ADR-0004 clause 1/11). */

import type { CredentialKey, CredentialRef } from './credentials-types.ts'

export const GIT_REMOTE_CREDENTIAL_MEMBERS = [
  'readRecord',
  'modifyRecord',
  'deleteRecord',
  'resolve',
  'describe',
  'describeRecord',
  'notifyRecordUpdated',
] as const

export type GitRemoteCredentialMember = (typeof GIT_REMOTE_CREDENTIAL_MEMBERS)[number]

export type GitRemoteCredentialProbe =
  | { readonly state: 'missing' }
  | { readonly state: 'incomplete'; readonly missing: readonly GitRemoteCredentialMember[] }
  | { readonly state: 'supported' }

export function probeCredentialsService(value: unknown): GitRemoteCredentialProbe {
  if (value === undefined || value === null) return { state: 'missing' }
  if (typeof value !== 'object' && typeof value !== 'function') {
    return { state: 'incomplete', missing: GIT_REMOTE_CREDENTIAL_MEMBERS }
  }
  const members = value as Record<GitRemoteCredentialMember, unknown>
  const missing = GIT_REMOTE_CREDENTIAL_MEMBERS.filter((member) => {
    try {
      return typeof members[member] !== 'function'
    } catch {
      return true
    }
  })
  return missing.length === 0 ? { state: 'supported' } : { state: 'incomplete', missing }
}

const GIT_REMOTE_CREDENTIAL_KEY_SEGMENT = /^[a-z][a-z0-9-]*$/
const GIT_REMOTE_CREDENTIAL_REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function gitRemoteCredentialKey(scope: string, id: string): CredentialKey {
  for (const segment of [scope, id]) {
    if (!GIT_REMOTE_CREDENTIAL_KEY_SEGMENT.test(segment)) {
      throw new TypeError(`credential key segment ${JSON.stringify(segment)} must match ${String(GIT_REMOTE_CREDENTIAL_KEY_SEGMENT)}`)
    }
  }
  return `${scope}/${id}` as CredentialKey
}

export function gitRemoteCredentialRef(value: string): CredentialRef {
  if (!GIT_REMOTE_CREDENTIAL_REF_NAME.test(value)) {
    throw new TypeError(`credential ref ${JSON.stringify(value)} must match ${String(GIT_REMOTE_CREDENTIAL_REF_NAME)}`)
  }
  return value as CredentialRef
}

export interface GitRemoteCredentialService {
  readRecord(key: CredentialKey): Promise<import('./credentials-types.ts').CredentialRecord | undefined>
  modifyRecord(key: CredentialKey, mutate: (current: import('./credentials-types.ts').CredentialRecord | undefined) => Promise<import('./credentials-types.ts').CredentialRecord | undefined>): Promise<import('./credentials-types.ts').CredentialRecord | undefined>
  deleteRecord(key: CredentialKey): Promise<void>
  resolve(ref: CredentialRef): Promise<import('./credentials-types.ts').ResolvedCredential | undefined>
  describe(ref: CredentialRef): Promise<import('./credentials-types.ts').CredentialInfo>
  describeRecord(key: CredentialKey): Promise<import('./credentials-types.ts').CredentialRecordInfo>
}

export function asCredentialService(value: unknown): GitRemoteCredentialService | undefined {
  return probeCredentialsService(value).state === 'supported' ? (value as GitRemoteCredentialService) : undefined
}
