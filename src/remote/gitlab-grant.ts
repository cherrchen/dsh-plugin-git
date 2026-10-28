/** Independent GitLab grant v2 and atomic, storage-only orphan retirement. */
import { randomUUID } from 'node:crypto'
import type { CredentialRecord } from './credentials-types.ts'
import type { GitRemoteCredentialService } from './credentials.ts'
import { GitRemoteError } from './errors.ts'
import { canonicalGitLabInstance, gitLabGrantKey } from './instances.ts'

interface Base { readonly v: 2; readonly provider: 'gitlab'; readonly instance: string; readonly revision: string }
export type GitLabGrant =
  | (Base & { readonly state: 'authorizing'; readonly clientId: string; readonly attemptId: string })
  | (Base & { readonly state: 'authenticated'; readonly clientId: string; readonly accessToken: string; readonly expiresAt: number; readonly refreshToken?: string })
  | (Base & { readonly state: 'refreshing'; readonly clientId: string; readonly accessToken: string; readonly expiresAt: number; readonly refreshToken: string; readonly refreshId: string; readonly basedOnRevision: string; readonly refreshExpiresAt: number })
  | (Base & { readonly state: 'signed-out' | 'reauth-required'; readonly clientId?: string; readonly retired?: boolean })

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/u.test(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
export function parseGitLabGrant(record: CredentialRecord | undefined, instance: string): GitLabGrant | undefined {
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) return undefined
  const p = record.payload as Record<string, unknown>
  if (p['v'] !== 2 || p['provider'] !== 'gitlab' || p['instance'] !== instance || !nonempty(p['revision'])) return undefined
  const base = { v: 2 as const, provider: 'gitlab' as const, instance, revision: p['revision'] }
  const only = (...extra: string[]) => Object.keys(p).every(key => ['v', 'provider', 'instance', 'revision', 'state', ...extra].includes(key))
  if (p['state'] === 'signed-out' || p['state'] === 'reauth-required') {
    if (!only('clientId', 'retired')) return undefined
    if (p['clientId'] !== undefined && !nonempty(p['clientId'])) return undefined
    if (p['retired'] !== undefined && (p['retired'] !== true || p['state'] !== 'signed-out' || p['clientId'] !== undefined)) return undefined
    if (['accessToken', 'refreshToken', 'attemptId', 'refreshId', 'basedOnRevision', 'refreshExpiresAt', 'expiresAt'].some(key => p[key] !== undefined)) return undefined
    return { ...base, state: p['state'], ...(p['clientId'] === undefined ? {} : { clientId: p['clientId'] as string }), ...(p['retired'] === true ? { retired: true } : {}) }
  }
  if (!nonempty(p['clientId'])) return undefined
  const clientId = p['clientId']
  if (p['state'] === 'authorizing') {
    if (!only('clientId', 'attemptId') || !nonempty(p['attemptId'])) return undefined
    return { ...base, state: 'authorizing', clientId, attemptId: p['attemptId'] }
  }
  if ((p['state'] !== 'authenticated' && p['state'] !== 'refreshing') || !nonempty(p['accessToken']) || !finite(p['expiresAt'])) return undefined
  if (p['refreshToken'] !== undefined && !nonempty(p['refreshToken'])) return undefined
  const token = { accessToken: p['accessToken'], expiresAt: p['expiresAt'] }
  if (p['state'] === 'authenticated' && !only('clientId', 'accessToken', 'expiresAt', 'refreshToken')) return undefined
  if (p['state'] === 'authenticated') return { ...base, state: 'authenticated', clientId, ...token, ...(p['refreshToken'] === undefined ? {} : { refreshToken: p['refreshToken'] as string }) }
  if (!only('clientId', 'accessToken', 'expiresAt', 'refreshToken', 'refreshId', 'basedOnRevision', 'refreshExpiresAt') || !nonempty(p['refreshToken']) || !nonempty(p['refreshId']) || !nonempty(p['basedOnRevision']) || !finite(p['refreshExpiresAt'])) return undefined
  return { ...base, state: 'refreshing', clientId, ...token, refreshToken: p['refreshToken'], refreshId: p['refreshId'], basedOnRevision: p['basedOnRevision'], refreshExpiresAt: p['refreshExpiresAt'] }
}
export function gitLabGrantRecord(grant: GitLabGrant): CredentialRecord { return { kind: 'grant', payload: grant } }

export async function retireGitLabGrant(credentials: GitRemoteCredentialService, rawInstance: string, uuid: () => string = randomUUID): Promise<{ instance: string; disposition: 'retired' | 'already-retired' | 'absent' }> {
  const instance = canonicalGitLabInstance(rawInstance)
  const revision = uuid()
  let disposition: 'retired' | 'already-retired' | 'absent' | 'record-mismatch' = 'record-mismatch'
  const saved = await credentials.modifyRecord(gitLabGrantKey(instance), async current => {
    if (current === undefined) { disposition = 'absent'; return undefined }
    const grant = parseGitLabGrant(current, instance)
    if (grant === undefined) { disposition = 'record-mismatch'; return undefined }
    if (grant.state === 'signed-out' && grant.retired === true) { disposition = 'already-retired'; return undefined }
    disposition = 'retired'
    return gitLabGrantRecord({ v: 2, provider: 'gitlab', instance, revision, state: 'signed-out', retired: true })
  })
  if (disposition === 'record-mismatch') throw new GitRemoteError('git/remote-unavailable', 'git-remote: grant binding does not match', { reason: 'record-mismatch' })
  if (disposition === 'retired') {
    const grant = parseGitLabGrant(saved, instance)
    if (grant?.state !== 'signed-out' || grant.retired !== true || grant.revision !== revision) throw new GitRemoteError('git/remote-unavailable', 'git-remote: grant retirement was not committed', { reason: 'store-failed' })
  }
  return { instance, disposition }
}
