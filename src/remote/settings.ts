/** `Config.remote` shape, validation, and volatile-safe resolution (ADR-0004 clause 5/6). */

import { readVolatile } from '../compat/dsh-schema.ts'

export interface RemoteSettings {
  clientId?: string
  requestTimeoutMs?: number
  probeTimeoutMs?: number
  refreshTtlMs?: number
  refreshPollMs?: number
  refreshStoreExclusive?: boolean
  maxResponseBytes?: number
}

export interface ResolvedRemoteSettings {
  clientId?: string
  requestTimeoutMs: number
  probeTimeoutMs: number
  refreshTtlMs: number
  refreshPollMs: number
  refreshStoreExclusive: boolean
  maxResponseBytes: number
}

export function resolveRemoteSettings(source: RemoteSettings | undefined): ResolvedRemoteSettings {
  const clientId = readVolatile(source?.clientId)
  const requestTimeoutMs = readVolatile(source?.requestTimeoutMs)
  const probeTimeoutMs = readVolatile(source?.probeTimeoutMs)
  const refreshTtlMs = readVolatile(source?.refreshTtlMs)
  const refreshPollMs = readVolatile(source?.refreshPollMs)
  const refreshStoreExclusive = readVolatile(source?.refreshStoreExclusive)
  const maxResponseBytes = readVolatile(source?.maxResponseBytes)
  return {
    ...(typeof clientId === 'string' && clientId !== '' ? { clientId } : {}),
    requestTimeoutMs: typeof requestTimeoutMs === 'number' ? requestTimeoutMs : 15_000,
    probeTimeoutMs: typeof probeTimeoutMs === 'number' ? probeTimeoutMs : 5_000,
    refreshTtlMs: typeof refreshTtlMs === 'number' ? refreshTtlMs : 30_000,
    refreshPollMs: typeof refreshPollMs === 'number' ? refreshPollMs : 250,
    refreshStoreExclusive: refreshStoreExclusive === true,
    maxResponseBytes: typeof maxResponseBytes === 'number' ? maxResponseBytes : 4 * 1024 * 1024,
  }
}

export function validateRemoteSettings(value: RemoteSettings | undefined): void {
  const resolved = resolveRemoteSettings(value)
  for (const key of ['requestTimeoutMs', 'probeTimeoutMs', 'refreshTtlMs', 'refreshPollMs', 'maxResponseBytes'] as const) {
    if (!Number.isSafeInteger(resolved[key])) throw new Error(`git-remote: ${key} must be a finite integer`)
  }
  if (resolved.requestTimeoutMs <= 0) throw new Error('git-remote: requestTimeoutMs must be positive')
  if (resolved.probeTimeoutMs < 1 || resolved.probeTimeoutMs > 5_000) throw new Error('git-remote: probeTimeoutMs must be within 1..5000')
  if (resolved.refreshTtlMs <= 0) throw new Error('git-remote: refreshTtlMs must be positive')
  if (resolved.refreshPollMs <= 0 || resolved.refreshPollMs > resolved.refreshTtlMs) {
    throw new Error('git-remote: refreshPollMs must be positive and no larger than refreshTtlMs')
  }
  if (resolved.maxResponseBytes <= 0) throw new Error('git-remote: maxResponseBytes must be positive')
}
