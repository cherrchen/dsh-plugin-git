import type { RemoteLoginAttempt, RemoteLoginStatus } from './remote-view.ts'

/** Validate browser destinations independently of the Host, including raw path spelling. */
export function readLoginAttempt(raw: unknown, instance: string, gitlab: boolean): RemoteLoginAttempt {
  if (typeof raw !== 'object' || raw === null) throw new Error('invalid-login')
  const value = raw as Record<string, unknown>
  const bounded = (input: unknown): input is string => typeof input === 'string' && /^[^\s\x00-\x1f\x7f]{1,200}$/u.test(input)
  if (!bounded(value['attemptId']) || !bounded(value['userCode'])) throw new Error('invalid-login')
  const verify = (input: unknown, complete: boolean): string => {
    if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x20\x7f\\]/u.test(input)) throw new Error('invalid-login')
    const path = /^https:\/\/[^/]+(\/[^?#]*)(?:\?[^#]*)?$/i.exec(input)?.[1]
    if (path === undefined || path.includes('%') || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) throw new Error('invalid-login')
    const base = new URL(instance), url = new URL(input), prefix = base.pathname === '/' ? '' : base.pathname
    if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password || url.hash || url.pathname !== (gitlab ? `${prefix}/oauth/device` : '/login/device')) throw new Error('invalid-login')
    const query = [...url.searchParams.entries()]
    if (complete ? !gitlab || query.length !== 1 || query[0]?.[0] !== 'user_code' || query[0]?.[1] !== value['userCode'] : url.search !== '') throw new Error('invalid-login')
    return input
  }
  const verificationUri = verify(value['verificationUri'], false)
  const verificationUriComplete = value['verificationUriComplete'] === undefined ? undefined : verify(value['verificationUriComplete'], true)
  const expiresAt = value['expiresAt'], intervalMs = value['intervalMs']
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) throw new Error('invalid-login')
  if (intervalMs !== undefined && (typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647)) throw new Error('invalid-login')
  return { attemptId: value['attemptId'], userCode: value['userCode'], verificationUri,
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as number }),
    ...(intervalMs === undefined ? {} : { intervalMs: intervalMs as number }) }
}

export function loginFailure(error: unknown): RemoteLoginStatus {
  const value = error as { details?: { reason?: unknown }; reason?: unknown } | undefined
  const reason = value?.details?.reason ?? value?.reason
  if (reason === 'device-code-expired' || reason === 'expired_token') return 'expired'
  if (reason === 'access-denied' || reason === 'access_denied') return 'denied'
  if (reason === 'client-id-missing' || reason === 'device-flow-not-supported' || reason === 'store-read-only') return 'unavailable'
  return 'failed'
}
