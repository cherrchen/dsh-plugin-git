import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteFeature } from '../src/client/remote.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
import { readLoginAttempt } from '../src/client/remote/login.ts'

const generation = { instanceId: 'fixture', revision: 1 }
const owners: GitRemoteFeature[] = []
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers() })
const rawLogin = (gitlab: boolean) => ({ attemptId: 'attempt', userCode: 'CODE', verificationUri: gitlab ? 'https://git.example/gitlab/oauth/device' : 'https://github.com/login/device', expiresAt: Date.now() + 60_000, intervalMs: 1000 })

function fixture(gitlab: boolean, login = rawLogin(gitlab)) {
  const scope = { provider: 'gitlab', instance: 'https://git.example/gitlab' }
  const target = gitlab ? { ...scope, path: 'team/repo', scope } : { provider: 'github', host: 'github.com', owner: 'team', repo: 'repo' }
  const cap = { state: 'on', remoteProtocol: 2, generation, credential: { configured: true, writable: true }, auth: { state: 'authenticated', source: gitlab ? 'glab' : 'gh' }, loginAvailable: true, authMethods: { deviceFlow: { supported: true } }, actions: {} }
  let resolvePoll!: (value: unknown) => void
  const call = vi.fn(async (_channel: string, endpoint: string, payload: any) => {
    const envelope = (value: unknown) => ({ ok: true, value: gitlab && payload?.remoteProtocol === 2 ? { remoteProtocol: 2, scope, generation, value } : value })
    if (endpoint === 'remote-capability') return envelope(cap)
    if (endpoint === 'remote-repositories') return gitlab ? { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }] } } } : envelope({ state: 'supported', remotes: [{ name: 'origin', identity: target }] })
    if (endpoint === 'remote-repository') {
      const facts = { viewer: { host: gitlab ? 'git.example' : 'github.com', userId: '1', login: 'alice' }, actionScope: { path: 'team/repo', projectId: '12' }, actions: {} }
      return gitlab ? envelope(facts) : envelope({ generation, value: facts })
    }
    if (endpoint === 'remote-list-prs') return gitlab ? envelope({ items: [], truncated: false }) : envelope({ generation, value: { items: [], truncated: false } })
    if (endpoint === 'remote-login') return envelope(login)
    if (endpoint === 'remote-poll-login') return new Promise(resolve => { resolvePoll = () => resolve(envelope({ state: 'authenticated' })) })
    return envelope(null)
  })
  const feature = new GitRemoteFeature({ call } as unknown as GitRpcClient); owners.push(feature)
  const controller = feature.controllerFor('session')
  return { call, feature, controller, ready: async () => {
    feature.refresh(); await vi.waitFor(() => expect(feature.getSnapshot().state).toBe('on'))
    if (!gitlab) feature.scoped.observeCapability({ state: 'on' })
    controller.setRepository('/repo', false); await controller.load()
  }, finish: () => resolvePoll(undefined) }
}

describe.each([false, true])('device login lifecycle gitlab=%s', gitlab => {
  it('opens once, copies only the user code, cancels and ignores a late success', async () => {
    const f = fixture(gitlab), openExternal = vi.fn(async () => {}), copyText = vi.fn(async () => {})
    f.feature.setAuthDesktop({ openExternal, copyText }); await f.ready()
    await f.controller.login(); await f.controller.login()
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(rawLogin(gitlab).verificationUri)
    await f.controller.copyLoginCode()
    expect(copyText).toHaveBeenCalledWith('CODE')
    expect(f.controller.getSnapshot().loginCopy).toBe('copied')
    await f.controller.cancelLogin()
    f.finish(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.controller.getSnapshot()).toMatchObject({ login: undefined, loginStatus: 'cancelled' })
    expect(f.call.mock.calls.filter(args => args[1] === 'remote-retry-auth')).toHaveLength(0)
  })
  it('expires locally and cancels the owned attempt without starting another login', async () => {
    const login = { ...rawLogin(gitlab), expiresAt: Date.now() + 10_000 }
    const f = fixture(gitlab, login); await f.ready()
    vi.useFakeTimers()
    await f.controller.login()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.controller.getSnapshot()).toMatchObject({ login: undefined, loginStatus: 'expired' })
    expect(f.call.mock.calls.filter(args => args[1] === 'remote-cancel-login')).toHaveLength(1)
    expect(f.call.mock.calls.filter(args => args[1] === 'remote-login')).toHaveLength(1)
  })
  it('keeps manual authorization when native operations fail or unload', async () => {
    const f = fixture(gitlab); await f.ready()
    f.feature.setAuthDesktop({ openExternal: async () => { throw Error('failed') }, copyText: async () => { throw Error('failed') } })
    await f.controller.login(); await vi.waitFor(() => expect(f.controller.getSnapshot().loginBrowser).toBe('failed'))
    await f.controller.copyLoginCode()
    expect(f.controller.getSnapshot().loginCopy).toBe('failed')
    f.feature.setAuthDesktop(undefined)
    expect(f.controller.getSnapshot()).toMatchObject({ loginBrowser: 'manual', login: { userCode: 'CODE' } })
    await f.controller.cancelLogin()
  })
  it('cleans the attempt through its original transport when the entire feature unloads', async () => {
    const f = fixture(gitlab); await f.ready(); await f.controller.login()
    f.feature.dispose()
    const cancel = f.call.mock.calls.find(args => args[1] === 'remote-cancel-login')
    expect(cancel?.[2]).toMatchObject(gitlab ? { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example/gitlab', attemptId: 'attempt' } : { attemptId: 'attempt' })
    f.finish(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.call.mock.calls.some(args => args[1] === 'remote-retry-auth')).toBe(false)
  })
})

describe('authorization URL boundary', () => {
  const instance = 'https://git.example/gitlab'
  it('uses the validated complete URL but remains compatible with old Host login results', () => {
    const raw = { ...rawLogin(true), verificationUriComplete: `${instance}/oauth/device?user_code=CODE` }
    expect(readLoginAttempt(raw, instance, true).verificationUriComplete).toBe(raw.verificationUriComplete)
    expect(readLoginAttempt({ attemptId: 'a', userCode: 'CODE', verificationUri: raw.verificationUri }, instance, true)).toEqual({ attemptId: 'a', userCode: 'CODE', verificationUri: raw.verificationUri })
  })
  it.each([
    'https://evil.example/gitlab/oauth/device?user_code=CODE',
    `${instance}/oauth/device?user_code=OTHER`, `${instance}/oauth/device?user_code=CODE&user_code=CODE`,
    `${instance}/oauth/device?user_code=CODE&redirect_uri=https://evil.example`,
    'https://git.example/oauth/device?user_code=CODE', `${instance}/oauth/x/../device?user_code=CODE`,
    `${instance}/oauth/%64evice?user_code=CODE`, `${instance}/oauth/device?user_code=CODE#fragment`,
  ])('never opens an invalid complete URL %s and cleans up the rejected attempt', async verificationUriComplete => {
    const f = fixture(true, { ...rawLogin(true), verificationUriComplete } as ReturnType<typeof rawLogin>)
    const openExternal = vi.fn(async () => {}); f.feature.setAuthDesktop({ openExternal }); await f.ready()
    await f.controller.login()
    expect(openExternal).not.toHaveBeenCalled()
    expect(f.controller.getSnapshot()).toMatchObject({ login: undefined, loginStatus: 'failed' })
    expect(f.call.mock.calls.some(args => args[1] === 'remote-cancel-login')).toBe(true)
  })
})
