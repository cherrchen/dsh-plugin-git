/** GrantRecord payload v1: parser at the disk boundary plus CAS payload builders (ADR-0004 clause 2). */

import type { CredentialRecord } from './credentials-types.ts'

export const GIT_REMOTE_HOST = 'github.com'
export const GIT_REMOTE_GRANT_KEY = 'dsh-plugin-git/github-com'

export type GitRemoteGrantState = 'authorizing' | 'authenticated' | 'refreshing' | 'signed-out' | 'reauth-required'

export interface GitRemoteGrantBase {
  readonly v: 1
  readonly state: GitRemoteGrantState
  readonly revision: string
  readonly host: string
  readonly clientId: string
  readonly at?: string
}

export interface GitRemoteAuthorizingGrant extends GitRemoteGrantBase {
  readonly state: 'authorizing'
  readonly attemptId: string
}

export interface GitRemoteAuthenticatedGrant extends GitRemoteGrantBase {
  readonly state: 'authenticated'
  readonly accessToken: string
  readonly refreshToken?: string
  readonly tokenType?: string
  readonly scope?: string
  readonly expiresAt?: number
  readonly userId?: string
  readonly login?: string
}

export interface GitRemoteRefreshingGrant extends GitRemoteGrantBase {
  readonly state: 'refreshing'
  readonly accessToken: string
  readonly refreshToken: string
  readonly tokenType?: string
  readonly scope?: string
  readonly expiresAt?: number
  readonly userId?: string
  readonly login?: string
  readonly refreshId: string
  readonly basedOnRevision: string
  readonly refreshExpiresAt: number
}

export interface GitRemoteSuppressingGrant extends GitRemoteGrantBase {
  readonly state: 'signed-out' | 'reauth-required'
}

export type GitRemoteGrant =
  | GitRemoteAuthorizingGrant
  | GitRemoteAuthenticatedGrant
  | GitRemoteRefreshingGrant
  | GitRemoteSuppressingGrant

export type GitRemoteGrantParse =
  | { readonly ok: true; readonly grant: GitRemoteGrant }
  | { readonly ok: false; readonly reason: 'malformed' | 'unsupported' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function optStr(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optNum(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

export function parseGrantRecord(record: CredentialRecord | undefined): GitRemoteGrantParse {
  if (record === undefined) return { ok: false, reason: 'malformed' }
  if (record.kind !== 'grant' || !isRecord(record.payload)) return { ok: false, reason: 'malformed' }
  const payload = record.payload
  if (payload['v'] !== 1 || payload['host'] !== GIT_REMOTE_HOST) return { ok: false, reason: 'unsupported' }
  if (!str(payload['revision']) || !str(payload['clientId'])) return { ok: false, reason: 'malformed' }
  if (payload['at'] !== undefined && typeof payload['at'] !== 'string') return { ok: false, reason: 'malformed' }
  const base = {
    v: 1 as const,
    revision: payload['revision'],
    host: GIT_REMOTE_HOST,
    clientId: payload['clientId'],
    ...(payload['at'] === undefined ? {} : { at: payload['at'] as string }),
  }
  switch (payload['state']) {
    case 'authorizing':
      if (!str(payload['attemptId'])) return { ok: false, reason: 'malformed' }
      return { ok: true, grant: { ...base, state: 'authorizing', attemptId: payload['attemptId'] } }
    case 'authenticated': {
      if (!str(payload['accessToken'])) return { ok: false, reason: 'malformed' }
      if (!optStr(payload['refreshToken']) || !optStr(payload['tokenType']) || !optStr(payload['scope'])) return { ok: false, reason: 'malformed' }
      if (!optNum(payload['expiresAt'])) return { ok: false, reason: 'malformed' }
      if (!optStr(payload['userId']) || !optStr(payload['login'])) return { ok: false, reason: 'malformed' }
      return { ok: true, grant: { ...base, state: 'authenticated', ...pickAuth(payload) } }
    }
    case 'refreshing': {
      if (!str(payload['accessToken']) || !str(payload['refreshToken'])) return { ok: false, reason: 'malformed' }
      if (!str(payload['refreshId']) || !str(payload['basedOnRevision'])) return { ok: false, reason: 'malformed' }
      if (typeof payload['refreshExpiresAt'] !== 'number' || !Number.isFinite(payload['refreshExpiresAt'])) return { ok: false, reason: 'malformed' }
      if (!optStr(payload['tokenType']) || !optStr(payload['scope']) || !optStr(payload['userId']) || !optStr(payload['login'])) return { ok: false, reason: 'malformed' }
      if (!optNum(payload['expiresAt'])) return { ok: false, reason: 'malformed' }
      return {
        ok: true,
        grant: {
          ...base,
          state: 'refreshing',
          ...pickAuth(payload),
          refreshToken: payload['refreshToken'],
          refreshId: payload['refreshId'],
          basedOnRevision: payload['basedOnRevision'],
          refreshExpiresAt: payload['refreshExpiresAt'],
        },
      }
    }
    case 'signed-out':
    case 'reauth-required':
      return { ok: true, grant: { ...base, state: payload['state'] } }
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

function pickAuth(payload: Record<string, unknown>) {
  return {
    accessToken: payload['accessToken'] as string,
    ...(payload['refreshToken'] === undefined ? {} : { refreshToken: payload['refreshToken'] as string }),
    ...(payload['tokenType'] === undefined ? {} : { tokenType: payload['tokenType'] as string }),
    ...(payload['scope'] === undefined ? {} : { scope: payload['scope'] as string }),
    ...(payload['expiresAt'] === undefined ? {} : { expiresAt: payload['expiresAt'] as number }),
    ...(payload['userId'] === undefined ? {} : { userId: payload['userId'] as string }),
    ...(payload['login'] === undefined ? {} : { login: payload['login'] as string }),
  }
}

export function grantRecord(payload: GitRemoteGrant): CredentialRecord {
  return { kind: 'grant', payload }
}
