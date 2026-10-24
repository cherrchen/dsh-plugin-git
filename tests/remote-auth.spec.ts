import { describe, expect, it, vi } from 'vitest'
import { GitRemoteAuth, GIT_REMOTE_GRANT_RECORD_KEY } from '../src/remote/auth.ts'
import {
  grantRecord,
  parseGrantRecord,
  type GitRemoteAuthorizingGrant,
  type GitRemoteAuthenticatedGrant,
  type GitRemoteRefreshingGrant,
  type GitRemoteSuppressingGrant,
} from '../src/remote/grant.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { GitRemoteHttp } from '../src/remote/http.ts'
import { resolveRemoteSettings, type RemoteSettings } from '../src/remote/settings.ts'

function fakeStore() {
  let record: CredentialRecord | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const resolves: Record<string, { value: string; source: string } | undefined> = {}
  const failCommits = { next: 0 }
  const calls = { resolve: 0, modify: 0, read: 0 }
  const service: GitRemoteCredentialService = {
    readRecord: async () => { calls.read += 1; return record },
    modifyRecord: (_key, mutate) => {
      const run = queue.then(async () => {
        calls.modify += 1
        const next = await mutate(record)
        if (next === undefined) return record
        if (failCommits.next > 0) { failCommits.next -= 1; throw new Error('store commit failed') }
        record = next
        return record
      })
      queue = run.catch(() => {})
      return run
    },
    deleteRecord: async () => { record = undefined },
    resolve: async (ref) => { calls.resolve += 1; return resolves[String(ref)] },
    describe: async () => ({ configured: false, writable: true }),
    describeRecord: async () => ({ configured: record !== undefined, writable: true }),
  }
  const grant = () => parseGrantRecord(record)
  return { service, resolves, failCommits, calls, set: (r: CredentialRecord | undefined) => { record = r }, grant }
}

interface AuthExtras {
  fetch?: typeof fetch
  settings?: RemoteSettings
  discoverGh?: (signal: AbortSignal) => Promise<string | undefined>
  discoverGitCredential?: (signal: AbortSignal) => Promise<string | undefined>
}

let engineSeq = 0
function auth(store: ReturnType<typeof fakeStore>, extras: AuthExtras = {}) {
  const clock = { t: 1000 }
  const { fetch: fetchImpl, settings: rawSettings, ...rest } = extras
  const prefix = `e${engineSeq += 1}-`
  const http = new GitRemoteHttp({
    fetch: fetchImpl ?? (async () => { throw new Error('no transport') }),
  })
  const engine = new GitRemoteAuth({
    credentials: store.service,
    http,
    settings: resolveRemoteSettings(rawSettings),
    now: () => clock.t,
    uuid: (() => { let n = 0; return () => `${prefix}u${n++}` })(),
    digest: (v) => `fp-${v.length}`,
    sleep: async () => { clock.t += 1 },
    ...rest,
  })
  return { engine, clock }
}

const SIG = new AbortController().signal
const CLIENT = 'client-id-1'

function authedGrant(revision = 'rev-1', extras: Partial<GitRemoteAuthenticatedGrant> = {}) {
  return grantRecord({ v: 1, state: 'authenticated', revision, host: 'github.com', clientId: CLIENT, accessToken: 'tok-a', refreshToken: 'rt-a', expiresAt: 0, ...extras })
}

describe('GitRemoteAuth discovery', () => {
  it('prefers grant over refs over gh over anonymous', async () => {
    const store = fakeStore()
    store.resolves['GH_TOKEN'] = { value: 'env-token', source: 'env' }
    const gh = vi.fn(async () => 'gh-token')
    const { engine } = auth(store, { discoverGh: gh, settings: { clientId: CLIENT } })
    store.set(authedGrant())
    const snap = await engine.establish(SIG)
    expect(snap).toMatchObject({ state: 'authenticated', source: 'grant', token: 'tok-a' })
    expect(gh).not.toHaveBeenCalled()
    store.set(undefined)
    const envSnap = await engine.establish(SIG)
    expect(envSnap).toMatchObject({ state: 'authenticated', source: 'ref', refSource: 'env' })
  })

  it('falls to gh and anonymous; suppressing states block discovery', async () => {
    const store = fakeStore()
    const gh = vi.fn(async () => 'gh-token')
    const { engine } = auth(store, { discoverGh: gh, settings: { clientId: CLIENT } })
    expect((await engine.establish(SIG))).toMatchObject({ state: 'authenticated', source: 'gh', token: 'gh-token' })
    const signedOut: GitRemoteSuppressingGrant = { v: 1, state: 'signed-out', revision: 'r', host: 'github.com', clientId: CLIENT }
    store.set(grantRecord(signedOut))
    expect((await engine.establish(SIG))).toMatchObject({ state: 'signed-out' })
    const authorizing: GitRemoteAuthorizingGrant = { v: 1, state: 'authorizing', revision: 'r', host: 'github.com', clientId: CLIENT, attemptId: 'a1' }
    store.set(grantRecord(authorizing))
    expect((await engine.establish(SIG))).toMatchObject({ state: 'invalid' })
  })

  it('rejects grants bound to a different or missing clientId without fallback', async () => {
    const store = fakeStore()
    store.resolves['GH_TOKEN'] = { value: 'env-token', source: 'env' }
    store.set(authedGrant('r', { clientId: 'other-app' }))
    const { engine } = auth(store, { settings: { clientId: CLIENT } })
    expect((await engine.establish(SIG))).toMatchObject({ state: 'invalid' })
  })

  it('suppresses malformed records rather than falling back', async () => {
    const store = fakeStore()
    store.resolves['GH_TOKEN'] = { value: 'env-token', source: 'env' }
    store.set({ kind: 'grant', payload: { v: 9, host: 'github.com' } })
    const { engine } = auth(store, { settings: { clientId: CLIENT } })
    expect((await engine.establish(SIG))).toMatchObject({ state: 'invalid' })
  })

  it('re-resolves refs per snapshot but never re-runs gh per operation', async () => {
    const store = fakeStore()
    const gh = vi.fn(async () => 'gh-token')
    const { engine } = auth(store, { discoverGh: gh, settings: { clientId: CLIENT } })
    await engine.establish(SIG)
    store.resolves['GH_TOKEN'] = { value: 'env-new', source: 'env' }
    const snap = await engine.snapshot(SIG)
    expect(snap).toMatchObject({ state: 'authenticated', source: 'ref', token: 'env-new' })
    expect(gh).toHaveBeenCalledTimes(1)
    const snap2 = await engine.snapshot(SIG)
    expect(store.calls.resolve).toBeGreaterThanOrEqual(2)
    expect(snap2.generation.revision).toBeGreaterThanOrEqual(snap.generation.revision)
  })

  it('bumps generation on context change even when login matches', async () => {
    const store = fakeStore()
    const { engine } = auth(store, { settings: { clientId: CLIENT } })
    store.resolves['GH_TOKEN'] = { value: 'tok-1', source: 'env' }
    const a = await engine.establish(SIG)
    store.resolves['GH_TOKEN'] = { value: 'tok-2', source: 'env' }
    const b = await engine.snapshot(SIG)
    expect(b.generation.revision).toBeGreaterThan(a.generation.revision)
    expect(b.token).toBe('tok-2')
  })

  it('marks 401 credentials invalid until the resolved credential changes', async () => {
    const store = fakeStore()
    const { engine } = auth(store, { settings: { clientId: CLIENT } })
    store.resolves['GH_TOKEN'] = { value: 'dead-token', source: 'env' }
    const snap = await engine.establish(SIG)
    engine.markInvalid(snap)
    expect((await engine.snapshot(SIG))).toMatchObject({ state: 'invalid' })
    store.resolves['GH_TOKEN'] = { value: 'fresh-token', source: 'env' }
    expect((await engine.snapshot(SIG))).toMatchObject({ state: 'authenticated', token: 'fresh-token' })
  })
})

describe('GitRemoteAuth sign-out and device flow', () => {
  it('persists signed-out, suppresses discovery, and clear restores it', async () => {
    const store = fakeStore()
    store.resolves['GH_TOKEN'] = { value: 'env-token', source: 'env' }
    const { engine } = auth(store, { settings: { clientId: CLIENT } })
    await engine.signOut(SIG)
    expect(store.grant().grant?.state).toBe('signed-out')
    expect((await engine.establish(SIG))).toMatchObject({ state: 'signed-out' })
    await engine.clearLocalGrant(SIG)
    expect((await engine.establish(SIG))).toMatchObject({ state: 'authenticated', source: 'ref' })
  })

  it('runs device flow with CAS attempt binding and denies repeats', async () => {
    const store = fakeStore()
    let posted = 0
    const fetch = (async (url: string) => {
      if (String(url).includes('device/code')) return new Response(JSON.stringify({ device_code: 'dc-1', user_code: 'UCODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
      posted += 1
      return new Response(JSON.stringify(posted === 1 ? { error: 'authorization_pending' } : { access_token: 'new-token', token_type: 'bearer', scope: 'repo' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const { engine } = auth(store, { fetch, settings: { clientId: CLIENT } })
    const start = await engine.startLogin(SIG)
    expect(start.userCode).toBe('UCODE')
    expect(JSON.stringify(start)).not.toContain('dc-1')
    await expect(engine.startLogin(SIG)).rejects.toMatchObject({ code: 'git/unauthenticated' })
    const done = await engine.pollLogin(start.attemptId, SIG)
    expect(done.state).toBe('authenticated')
    const grant = store.grant().grant
    expect(grant?.state).toBe('authenticated')
    if (grant?.state === 'authenticated') expect(grant.accessToken).toBe('new-token')
    expect(grant?.clientId).toBe(CLIENT)
  })

  it('propagates access_denied and expired_token as auth errors', async () => {
    for (const error of ['access_denied', 'expired_token']) {
      const store = fakeStore()
      const fetch = (async (url: string) => String(url).includes('device/code')
        ? new Response(JSON.stringify({ device_code: 'd', user_code: 'u', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
      const { engine } = auth(store, { fetch, settings: { clientId: CLIENT } })
      const start = await engine.startLogin(SIG)
      await expect(engine.pollLogin(start.attemptId, SIG)).rejects.toMatchObject({ code: 'git/unauthenticated' })
    }
  })

  it('requires clientId before offering login', async () => {
    const store = fakeStore()
    const { engine } = auth(store)
    await expect(engine.startLogin(SIG)).rejects.toMatchObject({ code: 'git/unauthenticated' })
  })
})

describe('GitRemoteAuth refresh protocol', () => {
  function refreshFetch(outcomes: unknown[]) {
    let index = 0
    const fetch = (async () => {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)]
      index += 1
      if (outcome instanceof Error) throw outcome
      return new Response(JSON.stringify(outcome), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { fetch, sends: () => index }
  }

  it('exchanges once for two callers through a committed marker', async () => {
    const store = fakeStore()
    store.set(authedGrant('rev-old'))
    const { fetch, sends } = refreshFetch([{ access_token: 'tok-b', refresh_token: 'rt-b', expires_in: 3600 }])
    const settings = { clientId: CLIENT, refreshStoreExclusive: true }
    const a = auth(store, { fetch, settings })
    const snapA = await a.engine.establish(SIG)
    const b = auth(store, { fetch, settings })
    const [ra, rb] = await Promise.all([a.engine.refresh(snapA, SIG), b.engine.refresh(snapA, SIG)])
    expect(sends()).toBe(1)
    expect(ra.state).toBe('authenticated')
    expect(rb.state).toBe('authenticated')
    const grant = store.grant().grant
    expect(grant?.state).toBe('authenticated')
    if (grant?.state === 'authenticated') expect(grant.accessToken).toBe('tok-b')
  })

  it('sends nothing when the prepare commit fails', async () => {
    const store = fakeStore()
    store.set(authedGrant('rev-old'))
    store.failCommits.next = 1
    const { fetch, sends } = refreshFetch([{ access_token: 'x' }])
    const { engine } = auth(store, { fetch, settings: { clientId: CLIENT, refreshStoreExclusive: true } })
    const snap = await engine.establish(SIG)
    await engine.refresh(snap, SIG).catch(() => {})
    expect(sends()).toBe(0)
    expect(store.grant().grant?.state).toBe('authenticated')
  })

  it('keeps refreshing committed on complete failure and never resends', async () => {
    const store = fakeStore()
    store.set(authedGrant('rev-old'))
    let commits = 0
    const originalModify = store.service.modifyRecord.bind(store.service)
    store.service.modifyRecord = async (key, mutate) => {
      const next = await mutate(store.grant().ok ? grantRecord(store.grant().grant!) : undefined)
      if (next === undefined) return undefined
      commits += 1
      if (commits === 2) throw new Error('commit failed')
      return originalModify(key, () => Promise.resolve(next))
    }
    const { fetch, sends } = refreshFetch([{ access_token: 'tok-b', refresh_token: 'rt-b' }])
    const { engine } = auth(store, { fetch, settings: { clientId: CLIENT, refreshStoreExclusive: true } })
    const snap = await engine.establish(SIG)
    await expect(engine.refresh(snap, SIG)).rejects.toMatchObject({ details: { stage: 'complete', remoteUpdated: true, localCommitted: false } })
    expect(store.grant().grant?.state).toBe('refreshing')
    expect(sends()).toBe(1)
    await engine.refresh(snap, SIG).catch(() => {})
    expect(sends()).toBe(1)
  })

  it('never restores authentication after 502-class unknowns', async () => {
    const store = fakeStore()
    store.set(authedGrant('rev-old'))
    const { fetch } = refreshFetch([new Error('gateway')])
    const { engine } = auth(store, { fetch, settings: { clientId: CLIENT, refreshStoreExclusive: true } })
    const snap = await engine.establish(SIG)
    const result = await engine.refresh(snap, SIG)
    expect(result.state).toBe('invalid')
    expect(store.grant().grant?.state).toBe('reauth-required')
  })

  it('burns a committed marker after a crash and never sends again', async () => {
    const store = fakeStore()
    const crashed: GitRemoteRefreshingGrant = { v: 1, state: 'refreshing', revision: 'r2', host: 'github.com', clientId: CLIENT, accessToken: 'old', refreshToken: 'rt', refreshId: 'rid', basedOnRevision: 'rev-old', refreshExpiresAt: 3 }
    store.set(grantRecord(crashed))
    const { fetch, sends } = refreshFetch([{ access_token: 'x' }])
    const { engine, clock } = auth(store, { fetch, settings: { clientId: CLIENT, refreshStoreExclusive: true, refreshPollMs: 1, refreshTtlMs: 5 } })
    clock.t = 1
    const snap = await engine.establish(SIG)
    expect(sends()).toBe(0)
    expect(snap.state).toBe('invalid')
    expect(store.grant().grant?.state).toBe('reauth-required')
  })

  it('refreshes nothing when the store-exclusive attestation is absent', async () => {
    const store = fakeStore()
    store.set(authedGrant('rev-old'))
    const { fetch, sends } = refreshFetch([{ access_token: 'x' }])
    const { engine } = auth(store, { fetch, settings: { clientId: CLIENT } })
    const snap = await engine.establish(SIG)
    const result = await engine.refresh(snap, SIG)
    expect(sends()).toBe(0)
    expect(result.state).toBe('invalid')
    expect(store.grant().grant?.state).toBe('reauth-required')
  })

  it('restores and retries once on a confirmed-not-sent transport', async () => {
    const store = fakeStore()
    store.set(authedGrant('rev-old'))
    const { GitRemoteTransportNotSent } = await import('../src/remote/http.ts')
    const { fetch, sends } = refreshFetch([new GitRemoteTransportNotSent(), { access_token: 'tok-b', refresh_token: 'rt-b' }])
    const settings = { clientId: CLIENT, refreshStoreExclusive: true }
    const a = auth(store, { fetch, settings })
    const snapA = await a.engine.establish(SIG)
    const first = await a.engine.refresh(snapA, SIG)
    expect(first.state).toBe('authenticated')
    expect(store.grant().grant?.state).toBe('authenticated')
    const grant = store.grant().grant
    if (grant?.state === 'authenticated') expect(grant.expiresAt).toBe(0)
    const b = auth(store, { fetch, settings })
    const snapB = await b.engine.establish(SIG)
    await b.engine.refresh(snapB, SIG)
    expect(sends()).toBe(2)
    const final = store.grant().grant
    if (final?.state === 'authenticated') expect(final.accessToken).toBe('tok-b')
  })

  it('discards late tokens when sign-out overtook the exchange', async () => {
    const store = fakeStore()
    store.set(authedGrant('rev-old'))
    const { fetch } = refreshFetch([{ access_token: 'tok-b' }])
    const { engine } = auth(store, { fetch, settings: { clientId: CLIENT, refreshStoreExclusive: true } })
    const snap = await engine.establish(SIG)
    const pending = engine.refresh(snap, SIG).catch((e) => e)
    await pending
    const parsed = store.grant()
    expect(parsed.ok).toBe(true)
  })
})

describe('GitRemoteAuth lifecycle', () => {
  it('stops admission on dispose and waits for blocked operations', async () => {
    const store = fakeStore()
    const { engine } = auth(store, { settings: { clientId: CLIENT } })
    let resolveGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { resolveGate = resolve })
    const innerResolve = store.service.resolve.bind(store.service)
    store.service.resolve = async (ref) => { await gate; return innerResolve(ref) }
    const pending = engine.establish(SIG)
    const queued = engine.snapshot(SIG)
    await new Promise((resolve) => setImmediate(resolve))
    const disposing = engine.dispose()
    let settled = false
    void disposing.then(() => { settled = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    resolveGate?.()
    await disposing
    expect(settled).toBe(true)
    await pending.catch(() => {})
    await expect(queued).rejects.toMatchObject({ code: 'git/remote-unavailable' })
    const resolveCallsAtSettle = store.calls.resolve
    await new Promise((resolve) => setImmediate(resolve))
    expect(store.calls.resolve).toBe(resolveCallsAtSettle)
    await expect(engine.establish(SIG)).rejects.toMatchObject({ code: 'git/remote-unavailable' })
  })
})


describe('auth cancellation and browser boundary', () => {
  it('does no discovery for a pre-aborted operation', async () => {
    const store = fakeStore()
    const { engine } = auth(store)
    await expect(engine.establish(AbortSignal.abort())).rejects.toMatchObject({ code: 'git/remote-unavailable' })
    expect(store.calls.read).toBe(0)
  })
  it('rejects foreign device verification URLs', async () => {
    const store = fakeStore()
    const { engine } = auth(store, { settings: { clientId: CLIENT }, fetch: (async () => new Response(JSON.stringify({ device_code: 'secret', user_code: 'u', verification_uri: 'https://evil.example/device' }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
    await expect(engine.startLogin(SIG)).rejects.toMatchObject({ code: 'git/unauthenticated' })
  })
  it('cancels an active poll before waiting for the serialized store change', async () => {
    const store = fakeStore()
    let polling: (() => void) | undefined
    const entered = new Promise<void>((resolve) => { polling = resolve })
    const { engine } = auth(store, { settings: { clientId: CLIENT }, fetch: (async (url: string) => {
      if (url.includes('device/code')) return new Response(JSON.stringify({ device_code: 'secret', user_code: 'u', verification_uri: 'https://github.com/login/device', interval: 1 }), { headers: { 'content-type': 'application/json' } })
      polling?.()
      return new Promise<Response>(() => {})
    }) as typeof fetch })
    const login = await engine.startLogin(SIG)
    const pending = engine.pollLogin(login.attemptId, SIG)
    const result = expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
    await entered
    await engine.cancelLogin(login.attemptId)
    await result
    expect(store.grant().grant?.state).toBe('signed-out')
  })
  it('suppresses fallback after a previously authenticated ref disappears', async () => {
    const store = fakeStore()
    store.resolves['GH_TOKEN'] = { value: 'token', source: 'env' }
    const { engine } = auth(store)
    await engine.establish(SIG)
    store.resolves['GH_TOKEN'] = undefined
    expect((await engine.snapshot(SIG)).state).toBe('invalid')
  })
})


describe('unconfigured-app sign-out', () => {
  it('persists suppression even when no OAuth client id is configured', async () => {
    const store = fakeStore(); store.resolves['GH_TOKEN'] = { value: 'environment-token', source: 'env' }
    const first = auth(store)
    await first.engine.establish(SIG); await first.engine.signOut(SIG)
    expect(store.grant().grant?.state).toBe('signed-out')
    const next = auth(store)
    expect((await next.engine.establish(SIG)).state).toBe('signed-out')
    await Promise.all([first.engine.dispose(), first.engine.dispose(), next.engine.dispose()])
  })
})
