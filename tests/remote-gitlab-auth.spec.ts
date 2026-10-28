import { describe, expect, it, vi } from 'vitest'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import { GitLabAuth } from '../src/remote/gitlab-auth.ts'
import { GitRemoteHttp, GitRemoteTransportNotSent } from '../src/remote/http.ts'
import { gitLabGrantKey, resolveGitLabInstances } from '../src/remote/instances.ts'
import { resolveRemoteSettings } from '../src/remote/settings.ts'

const SIG = new AbortController().signal
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function store() {
  const records = new Map<string, CredentialRecord>()
  const refs = new Map<string, { value: string; source: string }>()
  const resolve = vi.fn(async (ref: string) => refs.get(ref))
  let chain: Promise<unknown> = Promise.resolve()
  const service: GitRemoteCredentialService = {
    readRecord: async key => records.get(key),
    modifyRecord: (key, mutate) => { const run = chain.then(async () => { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) }); chain = run.catch(() => {}); return run },
    deleteRecord: async key => { records.delete(key) }, resolve,
    describe: async () => ({ configured: false, writable: true }),
    describeRecord: async key => ({ configured: records.has(key), writable: true }),
  }
  return { service, records, refs, resolve }
}
let serial = 0
function fixture(s: ReturnType<typeof store>, url = 'https://one.example/gitlab', options: { ref?: string; clientId?: string; exclusive?: boolean; fetch?: typeof fetch; discover?: (signal: AbortSignal) => Promise<string | undefined> } = {}) {
  const instance = resolveGitLabInstances([{ url, ...(options.ref === undefined ? {} : { credentialRef: options.ref }), ...(options.clientId === undefined ? {} : { clientId: options.clientId }) }])[0]!
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = options.fetch ?? (async () => json({ id: 9, username: 'same' }))
  const http = new GitRemoteHttp({ gitlabInstance: instance.instance, fetch: async (url, init) => { calls.push({ url, init }); return fetch(url, init) } })
  let now = 1000
  const engine = new GitLabAuth({ credentials: s.service, instance, http, settings: resolveRemoteSettings({ refreshStoreExclusive: options.exclusive }), now: () => now, uuid: () => `id-${++serial}`, sleep: async ms => { now += ms }, ...(options.discover === undefined ? {} : { discoverGlab: options.discover }) })
  return { engine, instance, calls }
}
const payload = (instance: string, extra: Record<string, unknown> = {}): CredentialRecord => ({ kind: 'grant', payload: { v: 2, provider: 'gitlab', instance, revision: 'old', state: 'authenticated', clientId: 'app', accessToken: 'old-token', refreshToken: 'old-refresh', expiresAt: 1, ...extra } })

describe('GitLab CLI identity discovery lifecycle', () => {
  it.each(['sequential', 'concurrent'] as const)('shares one probe and verified viewer across %s snapshots', async mode => {
    const discover = vi.fn(async () => 'cli-token'), f = fixture(store(), 'https://gitlab.com', { discover })
    const snapshots = []
    if (mode === 'concurrent') snapshots.push(...await Promise.all(Array.from({ length: 5 }, () => f.engine.snapshot(SIG))))
    else for (let i = 0; i < 5; i++) snapshots.push(await f.engine.snapshot(SIG))
    const first = snapshots[0]!
    expect(discover).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(1)
    for (const snapshot of snapshots) {
      expect(snapshot.generation).toEqual(first.generation)
      expect(snapshot.viewer).toEqual(first.viewer); expect(snapshot.state).toBe('authenticated')
    }
    await f.engine.dispose()
  })
  it.each(['missing', 'empty', 'failed'] as const)('caches a %s probe until explicit retry', async mode => {
    const discover = vi.fn(async (): Promise<string | undefined> => { if (mode === 'failed') throw Error('CLI unavailable'); return mode === 'empty' ? '' : undefined })
    const f = fixture(store(), 'https://gitlab.com', { discover })
    for (let i = 0; i < 5; i++) expect((await f.engine.snapshot(SIG)).state).toBe('anonymous')
    expect(discover).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(0)
    discover.mockResolvedValue('new-cli-token')
    expect((await f.engine.retry(SIG)).value.auth.state).toBe('authenticated')
    await f.engine.snapshot(SIG)
    expect(discover).toHaveBeenCalledTimes(2)
    expect(f.calls.filter(call => call.url.endsWith('/user'))).toHaveLength(1)
    await f.engine.dispose()
  })
  it.each(['record', 'reference'] as const)('reprobes and revalidates after a %s invalidation', async kind => {
    const discover = vi.fn(async () => 'cli-token'), f = fixture(store(), 'https://gitlab.com', { discover })
    const first = await f.engine.snapshot(SIG)
    f.engine.invalidate(kind)
    expect(first.signal.aborted).toBe(true)
    expect(discover).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(1)
    const second = await f.engine.snapshot(SIG)
    await f.engine.snapshot(SIG)
    expect(second.generation.revision).toBeGreaterThan(first.generation.revision)
    expect(discover).toHaveBeenCalledTimes(2); expect(f.calls).toHaveLength(2)
    await f.engine.dispose()
  })
  it.each(['verification', 'business'] as const)('keeps a %s 401 on the selected CLI token until explicit repair', async stage => {
    const s = store(), discover = vi.fn(async () => 'old-cli-token')
    let rejectUser = stage === 'verification'
    const f = fixture(s, 'https://gitlab.com', { discover, fetch: async () => rejectUser ? json({}, 401) : json({ id: 9, username: 'viewer' }) })
    if (rejectUser) await expect(f.engine.snapshot(SIG)).rejects.toMatchObject({ details: { reason: 'invalid-token' } })
    else f.engine.markInvalid(await f.engine.snapshot(SIG))
    discover.mockResolvedValue('new-cli-token')
    s.refs.set('GITLAB_TOKEN', { value: 'other-account', source: 'fixture' })
    await expect(f.engine.snapshot(SIG)).rejects.toMatchObject({ details: { reason: 'invalid-token' } })
    expect(discover).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(1)
    rejectUser = false
    expect((await f.engine.retry(SIG)).value.auth.state).toBe('authenticated')
    expect((await f.engine.snapshot(SIG)).token).toBe('new-cli-token')
    expect(discover).toHaveBeenCalledTimes(2)
    await f.engine.dispose()
  })
  it('does not fall through when an adopted CLI source disappears after invalidation', async () => {
    const s = store(), discover = vi.fn(async (): Promise<string | undefined> => 'cli-token'), f = fixture(s, 'https://gitlab.com', { discover })
    await f.engine.snapshot(SIG)
    discover.mockResolvedValue(undefined); s.refs.set('GITLAB_TOKEN', { value: 'other-account', source: 'fixture' })
    f.engine.invalidate()
    for (let i = 0; i < 2; i++) await expect(f.engine.snapshot(SIG)).rejects.toMatchObject({ details: { reason: 'source-lost' } })
    expect(discover).toHaveBeenCalledTimes(2); expect(f.calls).toHaveLength(1)
    await f.engine.dispose()
  })
  it('retries transient user verification with the cached candidate', async () => {
    const discover = vi.fn(async () => 'cli-token'); let available = false
    const f = fixture(store(), 'https://gitlab.com', { discover, fetch: async () => available ? json({ id: 9, username: 'viewer' }) : json({}, 503) })
    await expect(f.engine.snapshot(SIG)).rejects.toMatchObject({ details: { reason: 'verification-retryable' } })
    available = true
    expect((await f.engine.snapshot(SIG)).state).toBe('authenticated')
    expect(discover).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(2)
    await f.engine.dispose()
  })
  it.each(['caller', 'invalidation', 'disposal'] as const)('discards a late probe after %s cancellation', async mode => {
    let started!: () => void, release!: (token: string) => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const result = new Promise<string>(resolve => { release = resolve })
    const discover = vi.fn(async (_signal: AbortSignal) => 'fresh-token').mockImplementationOnce(async () => { started(); return result })
    const f = fixture(store(), 'https://gitlab.com', { discover }), caller = new AbortController()
    const pending = f.engine.snapshot(caller.signal), rejected = expect(pending).rejects.toBeDefined()
    await entered
    let disposal: Promise<void> | undefined
    if (mode === 'caller') caller.abort()
    else if (mode === 'invalidation') f.engine.invalidate()
    else disposal = f.engine.dispose()
    expect(discover.mock.calls[0]?.[0].aborted).toBe(true)
    release('stale-token'); await rejected
    if (disposal !== undefined) {
      await disposal
      await expect(f.engine.snapshot(SIG)).rejects.toMatchObject({ details: { reason: 'disposed' } })
      expect(f.calls).toHaveLength(0)
    } else {
      expect((await f.engine.snapshot(SIG)).token).toBe('fresh-token')
      expect(discover).toHaveBeenCalledTimes(2); expect(f.calls).toHaveLength(1)
      await f.engine.dispose()
    }
  })
  it('fences invalidation during user verification before adopting the CLI identity', async () => {
    const discover = vi.fn(async () => 'new-token').mockResolvedValueOnce('old-token')
    let invalidate = true
    const f = fixture(store(), 'https://gitlab.com', { discover, fetch: async () => {
      if (invalidate) { invalidate = false; f.engine.invalidate() }
      return json({ id: 9, username: 'viewer' })
    } })
    await expect(f.engine.snapshot(SIG)).rejects.toBeDefined()
    expect((await f.engine.capability()).value.viewer).toBeUndefined()
    expect((await f.engine.snapshot(SIG)).token).toBe('new-token')
    expect(discover).toHaveBeenCalledTimes(2)
    await f.engine.dispose()
  })
  it('suppresses CLI discovery after sign-out and clears its cache when the grant is cleared', async () => {
    const discover = vi.fn(async () => 'old-token'), f = fixture(store(), 'https://gitlab.com', { discover })
    await f.engine.snapshot(SIG); await f.engine.signOut(SIG)
    discover.mockResolvedValue('new-token'); f.engine.invalidate('reference')
    expect((await f.engine.snapshot(SIG)).state).toBe('signed-out')
    expect(discover).toHaveBeenCalledOnce()
    await f.engine.clearGrant(SIG)
    expect((await f.engine.snapshot(SIG)).token).toBe('new-token')
    expect(discover).toHaveBeenCalledTimes(2)
    await f.engine.dispose()
  })
  it.each(['grant', 'ref'] as const)('still discovers a newly available %s after caching CLI absence', async source => {
    const s = store(), discover = vi.fn(async () => undefined), f = fixture(s, 'https://gitlab.com', { discover, clientId: 'app' })
    expect((await f.engine.snapshot(SIG)).state).toBe('anonymous')
    if (source === 'grant') s.records.set(gitLabGrantKey(f.instance.instance), payload(f.instance.instance, { accessToken: 'new-token', expiresAt: 60_000 }))
    else s.refs.set('GITLAB_TOKEN', { value: 'new-token', source: 'fixture' })
    expect((await f.engine.snapshot(SIG)).token).toBe('new-token')
    expect(discover).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(1)
    await f.engine.dispose()
  })
  it('keeps CLI caches isolated between instance owners and disables discovery for Self-Managed', async () => {
    const discover = vi.fn(async () => 'cli-token'), s = store()
    const a = fixture(s, 'https://gitlab.com', { discover }), b = fixture(s, 'https://gitlab.com', { discover }), self = fixture(s, undefined, { discover })
    const first = await a.engine.snapshot(SIG), second = await b.engine.snapshot(SIG)
    expect(first.generation.instanceId).not.toBe(second.generation.instanceId)
    expect((await self.engine.snapshot(SIG)).state).toBe('anonymous')
    expect(discover).toHaveBeenCalledTimes(2)
    await Promise.all([a.engine.dispose(), b.engine.dispose(), self.engine.dispose()])
  })
})

describe('GitLab per-instance authentication', () => {
  it('fences a host-only snapshot when the account changes or the owner unloads', async () => {
    const s = store(); s.refs.set('OFFICE', { value: 'first-secret', source: 'test' })
    const f = fixture(s, undefined, { ref: 'OFFICE' })
    const first = await f.engine.snapshot(SIG)
    expect(first.viewer?.userId).toBe('9'); expect(first.signal.aborted).toBe(false)
    s.refs.set('OFFICE', { value: 'second-secret', source: 'test' })
    f.engine.invalidate('reference')
    expect(first.signal.aborted).toBe(true)
    const second = await f.engine.snapshot(SIG)
    expect(second.generation.revision).toBeGreaterThan(first.generation.revision)
    f.engine.markInvalid(first)
    expect(second.signal.aborted).toBe(false)
    await f.engine.dispose()
    expect(second.signal.aborted).toBe(true)
  })
  it('keeps capability zero network/process and independent from store writability and actions', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app' })
    const cap = await f.engine.capability()
    expect(f.calls).toHaveLength(0)
    expect(cap.value).toMatchObject({ auth: { state: 'unauthenticated' }, loginAvailable: true, automaticRefreshAvailable: false, actions: { canComment: false }, authMethods: { deviceFlow: { supported: 'unknown' } } })
    expect(cap.value.generation).toEqual(cap.generation)
    await f.engine.dispose()
  })
  it('validates identical viewer IDs against each instance and isolates generations and refs', async () => {
    const s = store(); s.refs.set('FIRST', { value: 'one-token', source: 'test' }); s.refs.set('SECOND', { value: 'two-token', source: 'test' })
    const a = fixture(s, 'https://one.example/gitlab', { ref: 'FIRST' }), b = fixture(s, 'https://two.example/gitlab', { ref: 'SECOND' })
    await a.engine.establish(SIG); await b.engine.establish(SIG)
    const ca = await a.engine.capability(), cb = await b.engine.capability()
    expect(ca.value.viewer).toMatchObject({ host: 'one.example', userId: '9' }); expect(cb.value.viewer).toMatchObject({ host: 'two.example', userId: '9' })
    expect(ca.generation.instanceId).not.toBe(cb.generation.instanceId)
    expect(a.calls[0]?.url).toBe('https://one.example/gitlab/api/v4/user'); expect(b.calls[0]?.url).toBe('https://two.example/gitlab/api/v4/user')
    expect(JSON.stringify([ca, cb])).not.toContain('token')
    await Promise.all([a.engine.dispose(), b.engine.dispose()])
  })
  it('distinguishes first missing ref from invalid, vanished and failed sources without falling through', async () => {
    const s = store(), f = fixture(s, undefined, { ref: 'OFFICE' })
    await f.engine.establish(SIG); expect((await f.engine.capability()).value.auth.state).toBe('anonymous')
    s.refs.set('OFFICE', { value: 'good', source: 'test' }); await f.engine.establish(SIG)
    s.refs.delete('OFFICE'); await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason: 'source-lost' } })
    s.refs.set('OFFICE', { value: 'bad token', source: 'test' }); await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason: 'invalid-token' } })
    s.resolve.mockRejectedValueOnce(new Error('secret store error'))
    await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason: 'store-read-failed' } })
    expect(f.calls).toHaveLength(1); await f.engine.dispose()
  })
  it.each([[401, 'invalid-token'], [429, 'verification-retryable'], [503, 'verification-retryable']])('classifies verification HTTP %s without another identity', async (status, reason) => {
    const s = store(); s.refs.set('OFFICE', { value: 'token', source: 'test' })
    const f = fixture(s, undefined, { ref: 'OFFICE', fetch: async () => json({}, status) })
    await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason } })
    expect(f.calls).toHaveLength(1); await f.engine.dispose()
  })
  it('uses per-instance device endpoints and never commits a token without expiry', async () => {
    const s = store()
    const f = fixture(s, undefined, { clientId: 'app', fetch: async url => url.endsWith('authorize_device') ? json({ device_code: 'device-secret', user_code: 'ABCD', verification_uri: 'https://one.example/gitlab/oauth/device', verification_uri_complete: 'https://one.example/gitlab/oauth/device?user_code=ABCD', expires_in: 100, interval: 1 }) : json({ access_token: 'secret' }) })
    const start = await f.engine.startLogin(SIG)
    expect(JSON.stringify(start)).not.toContain('device-secret')
    await expect(f.engine.pollLogin(start.value.attemptId, SIG)).rejects.toMatchObject({ details: { reason: 'invalid-oauth-response' } })
    expect(JSON.stringify(s.records.get(gitLabGrantKey(f.instance.instance)))).not.toContain('secret')
    await f.engine.dispose()
  })
  it.each([true, false])('commits a validated OAuth token with refresh token present=%s', async withRefresh => {
    const s = store()
    const f = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch: async url => url.endsWith('authorize_device') ? json({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://one.example/gitlab/oauth/device', expires_in: 100, interval: 1 }) : url.endsWith('/oauth/token') ? json({ access_token: 'access', expires_in: 100, ...(withRefresh ? { refresh_token: 'refresh' } : {}) }) : json({ id: 9, username: 'same' }) })
    const start = await f.engine.startLogin(SIG); const result = await f.engine.pollLogin(start.value.attemptId, SIG)
    expect(result.value.state).toBe('authenticated')
    expect((await f.engine.capability()).value.automaticRefreshAvailable).toBe(withRefresh)
    await f.engine.dispose()
  })
  it('does not replay a refresh token after a 5xx or missing expiry', async () => {
    for (const response of [json({}, 503), json({ access_token: 'new', refresh_token: 'new-refresh' })]) {
      const s = store(), f = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch: async () => response })
      const key = gitLabGrantKey(f.instance.instance); s.records.set(key, payload(f.instance.instance))
      await f.engine.establish(SIG); await f.engine.establish(SIG)
      expect(f.calls).toHaveLength(1)
      expect(s.records.get(key)).toMatchObject({ payload: { state: 'reauth-required' } })
      expect(JSON.stringify(s.records.get(key))).not.toContain('old-refresh')
      await f.engine.dispose()
    }
  })
  it('never retains the consumed old refresh token when the new response omits one', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch: async url => url.endsWith('/oauth/token') ? json({ access_token: 'new', expires_in: 100 }) : json({ id: 9, username: 'same' }) })
    const key = gitLabGrantKey(f.instance.instance); s.records.set(key, payload(f.instance.instance))
    await f.engine.establish(SIG)
    expect(s.records.get(key)).toMatchObject({ payload: { state: 'authenticated', accessToken: 'new' } })
    expect(JSON.stringify(s.records.get(key))).not.toContain('old-refresh')
    expect((await f.engine.capability()).value.automaticRefreshAvailable).toBe(false)
    await f.engine.dispose()
  })
})

describe('GitLab refresh and lifecycle safety', () => {
  it('never refreshes without a positive store exclusion guarantee', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app', exclusive: false })
    const key = gitLabGrantKey(f.instance.instance); s.records.set(key, payload(f.instance.instance))
    await f.engine.establish(SIG)
    expect(f.calls).toHaveLength(0); expect(s.records.get(key)).toMatchObject({ payload: { state: 'reauth-required' } }); await f.engine.dispose()
  })
  it('treats a stale refreshing marker as consumed and does not replay it', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app', exclusive: true })
    const key = gitLabGrantKey(f.instance.instance)
    s.records.set(key, payload(f.instance.instance, { state: 'refreshing', refreshId: 'other', basedOnRevision: 'old', refreshExpiresAt: 1 }))
    await f.engine.establish(SIG); expect(f.calls).toHaveLength(0); expect(s.records.get(key)).toMatchObject({ payload: { state: 'reauth-required' } }); await f.engine.dispose()
  })
  it('does not overwrite a concurrent retirement after a refresh was sent', async () => {
    const s = store(); let key = ''
    const f = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch: async () => {
      s.records.set(key, { kind: 'grant', payload: { v: 2, provider: 'gitlab', instance: f.instance.instance, revision: 'retired-rev', state: 'signed-out', retired: true } })
      return json({ access_token: 'new-secret', refresh_token: 'new-refresh', expires_in: 10 })
    } })
    key = gitLabGrantKey(f.instance.instance); s.records.set(key, payload(f.instance.instance))
    await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { stage: 'complete', remoteUpdated: true, localCommitted: false } })
    expect(s.records.get(key)).toMatchObject({ payload: { revision: 'retired-rev', retired: true } }); expect(JSON.stringify(s.records.get(key))).not.toContain('secret'); await f.engine.dispose()
  })
  it.each(['https://one.example/gitlab/oauth/a/../device', 'https://one.example/gitlab/oauth/%64evice', 'https://one.example/oauth/device', 'https://other.example/gitlab/oauth/device'])('rejects dangerous verification URL %s', async verification_uri => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app', fetch: async () => json({ device_code: 'device', user_code: 'ABCD', verification_uri, expires_in: 100 }) })
    await expect(f.engine.startLogin(SIG)).rejects.toMatchObject({ details: { reason: 'invalid-device-response' } }); await f.engine.dispose()
  })
  it('keeps a failed token source selected rather than falling through after it disappears', async () => {
    const s = store(); s.refs.set('GITLAB_TOKEN', { value: 'bad', source: 'test' }); s.refs.set('GL_TOKEN', { value: 'other', source: 'test' })
    const f = fixture(s, 'https://gitlab.com', { fetch: async () => json({}, 401) })
    await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason: 'invalid-token' } })
    s.refs.delete('GITLAB_TOKEN')
    await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason: 'source-lost' } }); expect(f.calls).toHaveLength(1); await f.engine.dispose()
  })
})

describe('credential change fencing', () => {
  it('does not adopt a ref that changes while user validation is in flight', async () => {
    const s = store(); s.refs.set('OFFICE', { value: 'first', source: 'store' })
    const f = fixture(s, undefined, { ref: 'OFFICE', fetch: async () => { s.refs.set('OFFICE', { value: 'second', source: 'store' }); return json({ id: 9, username: 'same' }) } })
    await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason: 'source-changed' } })
    expect((await f.engine.capability()).value.viewer).toBeUndefined(); await f.engine.dispose()
  })
  it('invalidates only the cached identity without network or subprocess activity', async () => {
    const s = store(); s.refs.set('OFFICE', { value: 'first', source: 'store' })
    const f = fixture(s, undefined, { ref: 'OFFICE' }); await f.engine.establish(SIG)
    const previous = await f.engine.capability(); f.engine.invalidate(); const next = await f.engine.capability()
    expect(next.value.auth.state).toBe('unauthenticated'); expect(next.value.viewer).toBeUndefined(); expect(next.generation.revision).toBeGreaterThan(previous.generation.revision); expect(f.calls).toHaveLength(1)
    await f.engine.dispose()
  })
})


describe('refresh send classification', () => {
  it('burns a refresh token on a lost response and never replays it', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch: async () => { throw new Error('synthetic lost response') } })
    const key = gitLabGrantKey(f.instance.instance); s.records.set(key, payload(f.instance.instance))
    await f.engine.establish(SIG); await f.engine.establish(SIG)
    expect(f.calls).toHaveLength(1); expect(s.records.get(key)).toMatchObject({ payload: { state: 'reauth-required' } }); await f.engine.dispose()
  })
  it('restores but does not use an expired token when transport proves nothing was sent', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch: async () => { throw new GitRemoteTransportNotSent() } })
    const key = gitLabGrantKey(f.instance.instance); s.records.set(key, payload(f.instance.instance))
    await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason: 'refresh-not-sent' } })
    expect(s.records.get(key)).toMatchObject({ payload: { state: 'authenticated', refreshToken: 'old-refresh' } })
    expect((await f.engine.capability()).value.auth.state).not.toBe('authenticated'); await f.engine.dispose()
  })
})

describe('cross-owner refresh exclusion', () => {
  it('allows only one exchange and refuses a late completion after an observer times out', async () => {
    const s = store(); let release!: () => void, started!: () => void
    const sent = new Promise<void>(resolve => { started = resolve })
    const finish = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.fn(async () => { started(); await finish; return json({ access_token: 'new', refresh_token: 'next', expires_in: 60 }) })
    const a = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch }), b = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch })
    const key = gitLabGrantKey(a.instance.instance); s.records.set(key, payload(a.instance.instance))
    const pending = a.engine.establish(SIG), late = expect(pending).rejects.toMatchObject({ details: { stage: 'complete' } })
    await sent; await b.engine.establish(SIG); release(); await late
    expect(fetch).toHaveBeenCalledTimes(1); expect(s.records.get(key)).toMatchObject({ payload: { state: 'reauth-required' } })
    await Promise.all([a.engine.dispose(), b.engine.dispose()])
  })
  it('does not persist an expiry that overflows the finite timestamp range', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app', exclusive: true, fetch: async () => json({ access_token: 'new', refresh_token: 'next', expires_in: 1e308 }) })
    const key = gitLabGrantKey(f.instance.instance); s.records.set(key, payload(f.instance.instance))
    await f.engine.establish(SIG); expect(s.records.get(key)).toMatchObject({ payload: { state: 'reauth-required' } }); await f.engine.dispose()
  })
})

describe('bound applications and flow support', () => {
  it('does not overwrite a grant bound to a different OAuth application', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'new-app' })
    const key = gitLabGrantKey(f.instance.instance), before = payload(f.instance.instance, { clientId: 'old-app' }); s.records.set(key, before)
    await expect(f.engine.startLogin(SIG)).rejects.toMatchObject({ details: { reason: 'record-mismatch' } })
    expect(s.records.get(key)).toBe(before); expect(f.calls).toHaveLength(0); await f.engine.dispose()
  })
  it('narrows device-flow support after an explicit unsupported response without probing in capability', async () => {
    const s = store(), f = fixture(s, undefined, { clientId: 'app', fetch: async () => json({}, 404) })
    expect((await f.engine.capability()).value.authMethods.deviceFlow.supported).toBe('unknown'); expect(f.calls).toHaveLength(0)
    await expect(f.engine.startLogin(SIG)).rejects.toBeDefined()
    const cap = await f.engine.capability(); expect(cap.value.authMethods.deviceFlow.supported).toBe(false); expect(cap.value.loginAvailable).toBe(false); expect(f.calls).toHaveLength(1)
    await f.engine.dispose()
  })
  it('clears the previous viewer while a changed ref cannot be validated', async () => {
    const s = store(); s.refs.set('OFFICE', { value: 'first', source: 'store' }); let available = true
    const f = fixture(s, undefined, { ref: 'OFFICE', fetch: async () => available ? json({ id: 9, username: 'old' }) : json({}, 503) })
    await f.engine.establish(SIG); available = false; s.refs.set('OFFICE', { value: 'second', source: 'store' })
    await expect(f.engine.establish(SIG)).rejects.toMatchObject({ details: { reason: 'verification-retryable' } })
    const cap = await f.engine.capability(); expect(cap.value.auth.state).toBe('unauthenticated'); expect(cap.value.viewer).toBeUndefined(); await f.engine.dispose()
  })
})

describe('explicit server initialization', () => {
  it('reads a sanitized version only during explicit retry and keeps it unverified', async () => {
    const s = store(); s.refs.set('OFFICE', { value: 'token', source: 'test' })
    const f = fixture(s, undefined, { ref: 'OFFICE', fetch: async url => String(url).endsWith('/metadata') ? json({ version: '19.5.1-ee' }) : json({ id: 9, username: 'viewer' }) })
    expect((await f.engine.capability()).value.serverVersion).toBeUndefined(); expect(f.calls).toHaveLength(0)
    const initialized = await f.engine.retry(SIG)
    expect(initialized.value.serverVersion).toEqual({ value: '19.5.1-ee', support: 'unknown', reason: 'not-verified' })
    expect(f.calls.map(call => call.url)).toEqual(['https://one.example/gitlab/api/v4/user', 'https://one.example/gitlab/api/v4/metadata'])
    await f.engine.capability(); expect(f.calls).toHaveLength(2); await f.engine.dispose()
  })
  it('keeps a verified identity when optional metadata is unavailable', async () => {
    const s = store(); s.refs.set('OFFICE', { value: 'token', source: 'test' })
    const f = fixture(s, undefined, { ref: 'OFFICE', fetch: async url => String(url).endsWith('/metadata') ? json({}, 503) : json({ id: 9, username: 'viewer' }) })
    const result = await f.engine.retry(SIG); expect(result.value.auth.state).toBe('authenticated'); expect(result.value.serverVersion).toBeUndefined(); await f.engine.dispose()
  })
})

it('classifies a 401 during explicit metadata initialization as invalid without changing source', async () => {
  const s = store(); s.refs.set('OFFICE', { value: 'token', source: 'test' })
  const f = fixture(s, undefined, { ref: 'OFFICE', fetch: async url => String(url).endsWith('/metadata') ? json({}, 401) : json({ id: 9, username: 'viewer' }) })
  await expect(f.engine.retry(SIG)).rejects.toMatchObject({ details: { reason: 'invalid-token' } })
  expect((await f.engine.capability()).value.auth.state).toBe('invalid'); await f.engine.dispose()
})

describe('provider credential events', () => {
  it('revalidates and retains successful OAuth identity when its own record write emits an event', async () => {
    const s = store()
    const f = fixture(s, undefined, { clientId: 'app', fetch: async url => String(url).endsWith('authorize_device') ? json({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://one.example/gitlab/oauth/device', expires_in: 100, interval: 1 }) : String(url).endsWith('/oauth/token') ? json({ access_token: 'access', expires_in: 100 }) : json({ id: 9, username: 'viewer' }) })
    const original = s.service.modifyRecord
    s.service.modifyRecord = async (key, mutate) => { const before = s.records.get(key), result = await original(key, mutate); if (s.records.get(key) !== before) f.engine.invalidate('record'); return result }
    const start = await f.engine.startLogin(SIG), done = await f.engine.pollLogin(start.value.attemptId, SIG), cap = await f.engine.capability()
    expect(done.generation).toEqual(cap.generation); expect(cap.value.auth.state).toBe('authenticated'); expect(cap.value.viewer?.userId).toBe('9')
    await f.engine.dispose()
  })
  it('keeps an explicit signed-out marker when only an external reference changes', async () => {
    const s = store(), f = fixture(s, undefined, { ref: 'OFFICE' })
    await f.engine.signOut(SIG); f.engine.invalidate('reference')
    expect((await f.engine.capability()).value.auth.state).toBe('signed-out'); await f.engine.dispose()
  })
})

describe('capability and queued cancellation', () => {
  it('answers capability without waiting for a user authorization poll and cancels queued work promptly', async () => {
    const s = store(), instance = resolveGitLabInstances([{ url: 'https://one.example/gitlab', clientId: 'app' }])[0]!
    const http = new GitRemoteHttp({ gitlabInstance: instance.instance, fetch: async () => json({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://one.example/gitlab/oauth/device', expires_in: 100, interval: 1 }) })
    const engine = new GitLabAuth({ credentials: s.service, instance, http, settings: resolveRemoteSettings(undefined), sleep: async (_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })) })
    const start = await engine.startLogin(SIG), polling = engine.pollLogin(start.value.attemptId, SIG)
    const pollRejected = expect(polling).rejects.toBeDefined()
    expect((await engine.capability()).value.state).toBe('on')
    const caller = new AbortController(), queued = engine.retry(caller.signal), queuedRejected = expect(queued).rejects.toMatchObject({ details: { reason: 'cancelled' } })
    caller.abort(); await queuedRejected
    await engine.cancelLogin(start.value.attemptId); await pollRejected; await engine.dispose()
  })
})
