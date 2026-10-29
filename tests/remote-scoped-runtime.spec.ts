import { describe, expect, it, vi } from 'vitest'
import { GitRemoteRuntime } from '../src/remote/runtime.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { GitService } from '../src/service.ts'
import { gitLabGrantKey } from '../src/remote/instances.ts'
const signal = new AbortController().signal
function fixture() {
  const records = new Map<string, CredentialRecord>()
  const credentials: GitRemoteCredentialService = { readRecord: async k => records.get(k), modifyRecord: async (k, fn) => { const next = await fn(records.get(k)); if (next !== undefined) records.set(k, next); return records.get(k) }, deleteRecord: async k => { records.delete(k) }, resolve: vi.fn(async () => undefined), describe: async () => ({ configured: false, writable: true }), describeRecord: async k => ({ configured: records.has(k), writable: true }) }
  const subprocess = { spawn: vi.fn(() => { throw Error('unexpected subprocess') }), resolveExecutable: vi.fn(async () => { throw Error('unexpected subprocess') }) }
  const service = { remoteCommand: vi.fn(async (_root: string, args: readonly string[]) => args[1] === 'get-url' ? 'https://git.example.com/gitlab/group/repo.git\n' : 'origin\n') } as unknown as GitService
  const settings = { instances: [{ url: 'https://git.example.com/gitlab', clientId: 'app' }] }
  const runtime = new GitRemoteRuntime(credentials, subprocess, service, settings)
  return { records, credentials, subprocess, service, runtime, settings }
}
describe('scoped Host protocol', () => {
  it('announces v2 on the existing GitHub capability while retaining v1 shape', async () => {
    const f = fixture(); expect(await f.runtime.capability()).toMatchObject({ state: 'on', remoteProtocol: 2, authScopes: [{ provider: 'github', instance: 'https://github.com' }, { provider: 'gitlab', instance: 'https://git.example.com/gitlab' }, { provider: 'gitlab', instance: 'https://gitlab.com' }], auth: { state: 'unauthenticated' } }); expect(f.subprocess.spawn).not.toHaveBeenCalled(); await f.runtime.dispose()
  })
  it('echoes a canonical scope with matching capability generations without network or subprocess', async () => {
    const f = fixture(), fetch = vi.spyOn(globalThis, 'fetch')
    const answer = await f.runtime.handle('remote-capability', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://GIT.EXAMPLE.COM:443/gitlab/' }, signal, async () => {}) as any
    expect(answer).toMatchObject({ remoteProtocol: 2, scope: { provider: 'gitlab', instance: 'https://git.example.com/gitlab' }, value: { state: 'on', actions: { canComment: false } } })
    expect(answer.generation).toEqual(answer.value.generation); expect(answer.generation.instanceId).not.toBe(answer.scope.instance)
    expect(fetch).not.toHaveBeenCalled(); expect(f.subprocess.spawn).not.toHaveBeenCalled(); fetch.mockRestore(); await f.runtime.dispose()
  })
  it.each(['github', 'gitlab'] as const)('reads %s account status without repository access or secret output', async provider => {
    const f = fixture()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 9, login: 'viewer', username: 'viewer', avatar_url: 'https://avatars.githubusercontent.com/u/9' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.mocked(f.credentials.resolve).mockResolvedValue({ value: 'private-token', source: 'fixture' })
    try {
      const answer = await f.runtime.handle('remote-auth-status', { remoteProtocol: 2, provider, instance: provider === 'github' ? 'https://github.com' : 'https://gitlab.com' }, signal, async () => { throw Error('no session') }) as any
      expect(answer.value).toMatchObject({ state: 'on', auth: { state: 'authenticated' }, viewer: { login: 'viewer' } })
      expect(answer.generation).toEqual(answer.value.generation)
      expect(JSON.stringify(answer)).not.toContain('private-token')
      expect(f.service.remoteCommand).not.toHaveBeenCalled()
      expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/user'))).toBe(true)
    } finally { fetch.mockRestore(); await f.runtime.dispose() }
  })
  it('rejects missing, unknown and wrong scope, wrong protocol, and unimplemented business before side effects', async () => {
    const f = fixture(), fetch = vi.spyOn(globalThis, 'fetch')
    for (const payload of [{ remoteProtocol: 1 }, { remoteProtocol: 2 }, { remoteProtocol: 2, provider: 'gitlab' }, { remoteProtocol: 2, provider: 'github', instance: 'https://git.example.com/gitlab' }, { remoteProtocol: 2, provider: 'gitlab', instance: 'https://unknown.example' }]) await expect(f.runtime.handle('remote-capability', payload, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-unavailable' })
    await expect(f.runtime.handle('remote-inline-comment', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab', body: 'x' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'not-implemented' } })
    await expect(f.runtime.handle('remote-retire-grant', {}, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'protocol-required' } })
    expect(fetch).not.toHaveBeenCalled(); expect(f.subprocess.spawn).not.toHaveBeenCalled(); fetch.mockRestore(); await f.runtime.dispose()
  })
  it('discovers mixed-instance identities without auth and retires orphan grants with null generation', async () => {
    const f = fixture(), orphan = 'https://old.example', key = gitLabGrantKey(orphan)
    const found = await f.runtime.handle('remote-repositories', { remoteProtocol: 2, repository: '/repo' }, signal, async () => {})
    expect(found).toMatchObject({ remoteProtocol: 2, value: { state: 'supported', remotes: [{ identity: { path: 'group/repo', scope: { provider: 'gitlab' } } }] } })
    f.records.set(key, { kind: 'grant', payload: { v: 2, provider: 'gitlab', instance: orphan, revision: 'old', state: 'authenticated', clientId: 'app', accessToken: 'secret', expiresAt: 1 } })
    const retired = await f.runtime.handle('remote-retire-grant', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://OLD.EXAMPLE/' }, signal, async () => {})
    expect(retired).toMatchObject({ generation: null, value: { disposition: 'retired' }, scope: { instance: orphan } })
    expect(JSON.stringify(f.records.get(key))).not.toContain('secret'); expect(f.credentials.resolve).not.toHaveBeenCalled(); await f.runtime.dispose()
  })
  it('keeps GitHub available if an instance configuration is invalid', async () => {
    const f = fixture(); f.settings.instances.push({ url: 'https://GIT.EXAMPLE.COM/gitlab/', clientId: 'app' })
    expect((await f.runtime.capability()).state).toBe('on')
    await expect(f.runtime.handle('remote-capability', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-instance-config' } })
    await f.runtime.dispose()
  })
})

describe('scoped runtime lifecycle', () => {
  it.each(['remove', 'reconfigure'] as const)('finishes a business request, discovery and unload after %s during the session guard', async change => {
    const f = fixture(), fetch = vi.spyOn(globalThis, 'fetch')
    let checks = 0
    try {
      const pending = f.runtime.handle('remote-pr', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab', repository: '/repo', path: 'group/repo', number: 7 }, signal, async () => {
        if (++checks === 1) f.settings.instances = change === 'remove' ? [] : [{ url: 'https://git.example.com/gitlab', clientId: 'replacement-app' }]
      })
      await expect(pending).rejects.toMatchObject({ code: 'git/remote-unavailable' })
      const found = await f.runtime.handle('remote-repositories', { remoteProtocol: 2, repository: '/repo' }, signal, async () => {}) as any
      expect(found.value.state).toBe(change === 'remove' ? 'unsupported' : 'supported')
      if (change === 'reconfigure') {
        const fresh = await f.runtime.handle('remote-capability', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab' }, signal, async () => {}) as any
        expect(fresh.value.state).toBe('on')
      }
      expect(fetch).not.toHaveBeenCalled()
      await f.runtime.dispose()
    } finally { fetch.mockRestore(); void f.runtime.dispose() }
  }, 1500)
  it('unloads while a cancelled business request is about to reenter the registry', async () => {
    const f = fixture(), fetch = vi.spyOn(globalThis, 'fetch')
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), resume = new Promise<void>(resolve => { release = resolve })
    try {
      const pending = f.runtime.handle('remote-pr', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab', repository: '/repo', path: 'group/repo', number: 7 }, signal, async () => { entered(); await resume })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'git/remote-unavailable' })
      await waiting
      const disposal = f.runtime.dispose()
      release()
      await Promise.all([rejected, disposal])
      expect(fetch).not.toHaveBeenCalled()
      expect(f.records.size).toBe(0)
    } finally { release(); fetch.mockRestore(); void f.runtime.dispose() }
  }, 1500)
  it('does not accept another instance’s login attempt', async () => {
    const f = fixture(); f.settings.instances.push({ url: 'https://second.example', clientId: 'other-app' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ device_code: 'device-secret', user_code: 'ABCD', verification_uri: 'https://git.example.com/gitlab/oauth/device', expires_in: 60, interval: 1 }), { headers: { 'content-type': 'application/json' } }))
    const first = await f.runtime.handle('remote-login', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab' }, signal, async () => {}) as any
    await expect(f.runtime.handle('remote-cancel-login', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://second.example', attemptId: first.value.attemptId }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'unknown-attempt' } })
    const cancelled = await f.runtime.handle('remote-cancel-login', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab', attemptId: first.value.attemptId }, signal, async () => {}) as any
    expect(cancelled.value).toBeNull(); expect(JSON.stringify(first)).not.toContain('device-secret')
    fetch.mockRestore(); await f.runtime.dispose()
  })
  it('cancels and drains an old instance before admitting its replacement', async () => {
    const f = fixture(); let started!: () => void
    const sent = new Promise<void>(resolve => { started = resolve })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise((_resolve, reject) => { started(); init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) }))
    const scope = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab' }
    const old = f.runtime.handle('remote-login', scope, signal, async () => {})
    const rejected = expect(old).rejects.toBeDefined()
    await sent; f.settings.instances[0] = { url: scope.instance, clientId: 'replacement-app' }
    const fresh = await f.runtime.handle('remote-capability', scope, signal, async () => {}) as any
    await rejected; expect(fresh.value.state).toBe('on'); expect(fresh.generation.instanceId).not.toBe(scope.instance)
    fetch.mockRestore(); await f.runtime.dispose()
  })
})

describe('scoped GitHub compatibility', () => {
  it('shares the GitHub v1 owner and captures the post-auth generation with null void value', async () => {
    const f = fixture(), scope = { remoteProtocol: 2, provider: 'github', instance: 'https://GITHUB.COM:443/' }
    const before = await f.runtime.handle('remote-capability', scope, signal, async () => {}) as any
    expect(before.scope).toEqual({ provider: 'github', instance: 'https://github.com' }); expect(before.generation).toEqual(before.value.generation)
    const signed = await f.runtime.handle('remote-sign-out', scope, signal, async () => {}) as any
    expect(signed.value).toBeNull(); expect(signed.generation.instanceId).toBe(before.generation.instanceId); expect(signed.generation.revision).toBeGreaterThan(before.generation.revision)
    expect(f.records.get('dsh-plugin-git/github-com')).toMatchObject({ payload: { v: 1, state: 'signed-out' } })
    expect((await f.runtime.capability()).auth.state).toBe('signed-out')
    await f.runtime.dispose()
  })
})

describe('orphan grant request validation', () => {
  it('rejects client supplied record keys, refs or client IDs instead of accepting them', async () => {
    const f = fixture()
    for (const extra of [{ key: 'other/key' }, { credentialRef: 'OTHER_REF' }, { clientId: 'other-app' }]) {
      await expect(f.runtime.handle('remote-retire-grant', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://old.example', ...extra }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-request' } })
    }
    expect(f.records.size).toBe(0); await f.runtime.dispose()
  })
})

describe('scoped GitLab device flow wiring', () => {
  it('completes a mock authorization with per-instance scope and never puts secrets on the wire', async () => {
    const f = fixture()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const address = String(url)
      const body = address.endsWith('/oauth/authorize_device') ? { device_code: 'device-private', user_code: 'ABCD', verification_uri: 'https://git.example.com/gitlab/oauth/device', expires_in: 60, interval: 0.001 } : address.endsWith('/oauth/token') ? { access_token: 'access-private', refresh_token: 'refresh-private', expires_in: 60 } : { id: 9, username: 'viewer' }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    })
    const scope = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab' }
    const start = await f.runtime.handle('remote-login', scope, signal, async () => {}) as any
    const done = await f.runtime.handle('remote-poll-login', { ...scope, attemptId: start.value.attemptId }, signal, async () => {}) as any
    const cap = await f.runtime.handle('remote-capability', scope, signal, async () => {}) as any
    expect(done.value).toEqual({ state: 'authenticated' }); expect(done.generation).toEqual(cap.generation); expect(cap.value.generation).toEqual(cap.generation)
    expect(cap.value.viewer).toMatchObject({ host: 'git.example.com', userId: '9' })
    expect(JSON.stringify([start, done, cap])).not.toMatch(/device-private|access-private|refresh-private/)
    const oauthCalls = fetch.mock.calls.filter(([url]) => String(url).includes('/oauth/'))
    expect(oauthCalls.every(([, init]) => !Object.keys((init?.headers ?? {}) as object).some(name => name.toLowerCase() === 'authorization'))).toBe(true)
    fetch.mockRestore(); await f.runtime.dispose()
  })
})

describe('scoped runtime unload', () => {
  it('aborts and drains pending instance work on owner disposal', async () => {
    const f = fixture(); let started!: () => void
    const sent = new Promise<void>(resolve => { started = resolve })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise((_resolve, reject) => { started(); init?.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true }) }))
    const pending = f.runtime.handle('remote-login', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab' }, signal, async () => {})
    const rejected = expect(pending).rejects.toBeDefined(); await sent; await f.runtime.dispose(); await rejected
    fetch.mockRestore()
  })
})

describe('configuration fencing before credential commit', () => {
  it('does not adopt or persist an OAuth token if the instance changes while the token response is in flight', async () => {
    const f = fixture(); let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/oauth/authorize_device')) return new Response(JSON.stringify({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://git.example.com/gitlab/oauth/device', expires_in: 60, interval: 0.001 }), { headers: { 'content-type': 'application/json' } })
      started(); await resume
      return new Response(JSON.stringify({ access_token: 'new-private', refresh_token: 'new-refresh', expires_in: 60 }), { headers: { 'content-type': 'application/json' } })
    })
    const scope = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab' }
    const start = await f.runtime.handle('remote-login', scope, signal, async () => {}) as any
    const pending = f.runtime.handle('remote-poll-login', { ...scope, attemptId: start.value.attemptId }, signal, async () => {}), rejected = expect(pending).rejects.toBeDefined()
    await waiting; f.settings.instances[0] = { url: scope.instance, clientId: 'replacement-app' }; release(); await rejected
    expect(JSON.stringify(f.records.get(gitLabGrantKey(scope.instance)))).not.toContain('new-private')
    expect(fetch).toHaveBeenCalledTimes(2); fetch.mockRestore(); await f.runtime.dispose()
  })
})

it('never accepts a client-supplied credential reference on scoped authentication', async () => {
  const f = fixture()
  await expect(f.runtime.handle('remote-retry-auth', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab', credentialRef: 'OTHER_REF' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-request' } })
  expect(f.credentials.resolve).not.toHaveBeenCalled(); await f.runtime.dispose()
})

it('checks instance configuration again inside the grant lock before committing an attempt', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void
  const locked = new Promise<void>(resolve => { entered = resolve }), resume = new Promise<void>(resolve => { release = resolve })
  const original = f.credentials.modifyRecord
  f.credentials.modifyRecord = async (key, mutate) => { entered(); await resume; return original(key, mutate) }
  const fetch = vi.spyOn(globalThis, 'fetch')
  const scope = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab' }
  const pending = f.runtime.handle('remote-login', scope, signal, async () => {}), rejected = expect(pending).rejects.toBeDefined()
  await locked; f.settings.instances[0] = { url: scope.instance, clientId: 'replacement-app' }; release(); await rejected
  expect(f.records.size).toBe(0); expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore(); await f.runtime.dispose()
})

it('keeps built-in GitLab capability and GitHub discovery usable when the initial explicit configuration is invalid', async () => {
  const f = fixture(); f.settings.instances.push({ url: 'https://GIT.EXAMPLE.COM/gitlab/', clientId: 'duplicate' })
  const service = f.service as unknown as { remoteCommand: ReturnType<typeof vi.fn> }
  service.remoteCommand.mockImplementation(async (_root: string, args: readonly string[]) => args[1] === 'get-url' ? 'https://github.com/owner/repo.git\n' : 'origin\n')
  const github = await f.runtime.handle('remote-repositories', { remoteProtocol: 2, repository: '/repo' }, signal, async () => {}) as any
  expect(github.value.remotes[0].identity.scope).toEqual({ provider: 'github', instance: 'https://github.com' })
  const builtin = await f.runtime.handle('remote-capability', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://gitlab.com' }, signal, async () => {}) as any
  expect(builtin.value.state).toBe('on'); expect(builtin.value.loginAvailable).toBe(false)
  await expect(f.runtime.handle('remote-retire-grant', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://old.example' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-instance-config' } })
  await f.runtime.dispose()
})
