import { describe, expect, it, vi } from 'vitest'
import { GitRemoteAuth, GIT_REMOTE_GRANT_RECORD_KEY } from '../src/remote/auth.ts'
import { GitLabAuth } from '../src/remote/gitlab-auth.ts'
import { GitRemoteHttp } from '../src/remote/http.ts'
import { resolveRemoteSettings } from '../src/remote/settings.ts'
import { gitLabGrantKey, resolveGitLabInstances } from '../src/remote/instances.ts'
import { authSelectionKey } from '../src/remote/auth-selection.ts'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'

const signal = new AbortController().signal
async function capability(auth: GitRemoteAuth | GitLabAuth) { const result = await auth.capability(); return 'value' in result ? result.value : result }
function fixture(gitlab: boolean) {
  const instance = resolveGitLabInstances([{ url: 'https://gitlab.com', clientId: 'app' }])[0]!
  const key = gitlab ? gitLabGrantKey(instance.instance) : GIT_REMOTE_GRANT_RECORD_KEY
  const records = new Map<string, CredentialRecord>()
  let chain: Promise<unknown> = Promise.resolve()
  const store: GitRemoteCredentialService = {
    readRecord: async key => records.get(key),
    modifyRecord: (key, mutate) => {
      const operation = chain.then(async () => { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) })
      chain = operation.catch(() => {}); return operation
    }, deleteRecord: async key => { records.delete(key) }, resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }), describeRecord: async key => ({ configured: records.has(key), writable: true }),
  }
  const grant = gitlab
    ? { v: 2, provider: 'gitlab', instance: instance.instance, revision: 'saved', state: 'authenticated', clientId: 'app', accessToken: 'oauth-token', refreshToken: 'oauth-refresh', expiresAt: Date.now() + 60_000 }
    : { v: 1, host: 'github.com', revision: 'saved', state: 'authenticated', clientId: 'app', accessToken: 'oauth-token', refreshToken: 'oauth-refresh', expiresAt: Date.now() + 60_000 }
  records.set(key, { kind: 'grant', payload: grant })
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const cli = new Headers(init?.headers).get('authorization') === 'Bearer cli-token'
    return new Response(JSON.stringify({ id: cli ? 2 : 1, username: cli ? 'cli-user' : 'oauth-user' }), { headers: { 'content-type': 'application/json' } })
  })
  const cli = vi.fn(async () => 'cli-token')
  const make = () => gitlab
    ? new GitLabAuth({ credentials: store, instance, settings: resolveRemoteSettings({}), http: new GitRemoteHttp({ gitlabInstance: instance.instance, fetch }), discoverGlab: cli })
    : new GitRemoteAuth({ credentials: store, settings: resolveRemoteSettings({ clientId: 'app' }), http: new GitRemoteHttp({ fetch }), discoverGh: cli })
  return { records, key, make, grant, fetch, cli }
}
describe.each([false, true])('persisted OAuth cache gitlab=%s', gitlab => {
  it('retains OAuth tokens across CLI selection and owner restart, then reuses them without device login', async () => {
    const f = fixture(gitlab)
    const first = f.make()
    await first.selectMethod('cli', signal)
    expect((await capability(first)).authSelection).toMatchObject({ method: 'cli', oauthCached: true })
    expect(f.records.get(f.key)?.kind).toBe('grant')
    expect((f.records.get(f.key) as { payload: unknown }).payload).toEqual(f.grant)
    await first.dispose()
    const second = f.make()
    await second.establish(signal)
    expect((await capability(second)).auth.source).toBe(gitlab ? 'glab' : 'gh')
    await second.selectMethod('oauth', signal)
    expect((await capability(second)).auth).toMatchObject({ state: 'authenticated', source: 'grant' })
    expect(f.records.get(f.key)).toEqual({ kind: 'grant', payload: f.grant })
    expect(f.fetch.mock.calls.every(([url]) => !url.includes('/oauth/token') && !url.includes('device'))).toBe(true)
    await second.dispose()
  })
  it('logs out only the saved OAuth while CLI remains authenticated after restart', async () => {
    const f = fixture(gitlab), first = f.make()
    await first.selectMethod('cli', signal)
    await first.logoutOAuth(signal)
    expect((await capability(first)).auth).toMatchObject({ state: 'authenticated', source: gitlab ? 'glab' : 'gh' })
    expect((await capability(first)).authSelection).toMatchObject({ method: 'cli', oauthCached: false })
    expect(JSON.stringify([...f.records.values()])).not.toMatch(/oauth-token|oauth-refresh|cli-token/)
    await first.dispose()
    const second = f.make(); await second.establish(signal)
    expect((await capability(second)).auth.source).toBe(gitlab ? 'glab' : 'gh')
    await second.selectMethod('oauth', signal)
    expect((await capability(second)).auth.state).not.toBe('authenticated')
    await second.dispose()
  })
  it('requires reauthorization for an expired grant without weakening the refresh exclusivity gate', async () => {
    const f = fixture(gitlab)
    f.records.set(f.key, { kind: 'grant', payload: { ...f.grant, expiresAt: 1 } })
    const auth = f.make(); await auth.selectMethod('cli', signal)
    await auth.selectMethod('oauth', signal)
    expect((await capability(auth)).auth.state).toBe('invalid')
    expect(f.fetch.mock.calls.every(([url]) => !url.includes('/oauth/token') && !url.includes('access_token'))).toBe(true)
    await auth.dispose()
  })
  it('fails closed on a malformed persisted method and never silently changes account', async () => {
    const f = fixture(gitlab)
    f.records.set(authSelectionKey(f.key), { kind: 'grant', payload: { v: 1, provider: 'other', method: 'cli' } })
    const auth = f.make()
    await expect(auth.establish(signal)).rejects.toMatchObject({ details: { reason: 'invalid-auth-selection' } })
    expect(f.cli).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
    await auth.dispose()
  })
  it('does not invalidate the initiating client when starting device login for the selected OAuth method', async () => {
    const f = fixture(gitlab); f.records.delete(f.key)
    const auth = f.make(); await auth.selectMethod('oauth', signal)
    const before = (await capability(auth)).generation
    f.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ device_code: 'device-secret', user_code: 'CACHE-CODE', expires_in: 30, interval: 1,
      verification_uri: gitlab ? 'https://gitlab.com/oauth/device' : 'https://github.com/login/device' }), { headers: { 'content-type': 'application/json' } }))
    await auth.startLogin(signal)
    expect((await capability(auth)).generation).toEqual(before)
    await auth.dispose()
  })
  if (gitlab) it('rejects identity adoption if another owner changes the selected method during user verification', async () => {
    const f = fixture(true), auth = f.make()
    f.fetch.mockImplementationOnce(async () => {
      f.records.set(authSelectionKey(f.key), { kind: 'grant', payload: { v: 1, provider: 'gitlab', instance: 'https://gitlab.com', method: 'oauth', revision: 'another-owner' } })
      return new Response(JSON.stringify({ id: 2, username: 'cli-user' }), { headers: { 'content-type': 'application/json' } })
    })
    await expect(auth.selectMethod('cli', signal)).rejects.toMatchObject({ details: { reason: 'source-changed' } })
    expect((await capability(auth)).auth.state).not.toBe('authenticated')
    expect(f.records.get(f.key)).toEqual({ kind: 'grant', payload: f.grant })
    await auth.dispose()
  })
})
