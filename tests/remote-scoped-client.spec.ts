import { describe, expect, it, vi } from 'vitest'
import { ScopedRemoteClient } from '../src/client/remote-protocol.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
const scope = { provider: 'gitlab', instance: 'https://git.example.com' } as const
const gen = { instanceId: 'opaque', revision: 1 }
const answer = (extra: Record<string, unknown> = {}) => ({ remoteProtocol: 2, scope, generation: gen, value: { generation: gen }, ...extra })
function client(value: unknown = answer()) {
  const call = vi.fn(async () => ({ ok: true, value }))
  return { scoped: new ScopedRemoteClient({ call } as unknown as GitRpcClient), call }
}
describe('scoped Client negotiation', () => {
  it('does not send a scoped operation to an old Host or an off seam', async () => {
    const c = client(); c.scoped.observeCapability({ state: 'on' })
    await expect(c.scoped.call('remote-comment', scope)).rejects.toMatchObject({ reason: 'host-not-negotiated' }); expect(c.call).not.toHaveBeenCalled()
    c.scoped.observeCapability({ state: 'off', remoteProtocol: 2 })
    await expect(c.scoped.call('remote-login', scope)).rejects.toMatchObject({ reason: 'host-not-negotiated' }); expect(c.call).not.toHaveBeenCalled()
  })
  it('accepts only the echoed scope and both identical capability generations', async () => {
    for (const invalid of [{ generation: gen, value: {} }, answer({ scope: { provider: 'gitlab', instance: 'https://other.example' } }), answer({ value: { generation: { ...gen, revision: 2 } } }), answer({ generation: null })]) {
      const c = client(invalid); c.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
      await expect(c.scoped.call('remote-capability', scope)).rejects.toBeDefined()
    }
    const c = client(); c.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
    expect((await c.scoped.call('remote-capability', scope)).generation).toEqual(gen)
  })
  it('does not take generation from control errors or accept a null generation as a write confirmation', async () => {
    const rpc = { call: vi.fn(async () => ({ ok: false, error: { code: 'git/remote-unavailable', details: { generation: gen } } })) }
    const c = new ScopedRemoteClient(rpc as unknown as GitRpcClient); c.observeCapability({ state: 'on', remoteProtocol: 2 })
    await expect(c.call('remote-comment', scope)).rejects.toMatchObject({ reason: 'control-error' })
    const n = client(answer({ generation: null })); n.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
    await expect(n.scoped.call('remote-comment', scope)).rejects.toMatchObject({ reason: 'generation-missing' })
  })
  it('retains only allowlisted write-result details for reconciliation', async () => {
    const rpc = { call: vi.fn(async () => ({ ok: false, error: { code: 'git/write-result-unknown', details: { action: 'review', number: 7, stage: 'approve', commentId: '600', commentSucceeded: true, token: 'private-secret', body: 'raw' } } })) }
    const c = new ScopedRemoteClient(rpc as unknown as GitRpcClient); c.observeCapability({ state: 'on', remoteProtocol: 2 })
    try { await c.call('remote-review', scope); throw Error('expected failure') } catch (error) {
      expect(error).toMatchObject({ code: 'git/write-result-unknown', details: { action: 'review', number: 7, stage: 'approve', commentId: '600', commentSucceeded: true } })
      expect(JSON.stringify(error)).not.toContain('private-secret')
    }
  })
  it('allows only normalized orphan retirement with null generation', async () => {
    const c = client({ remoteProtocol: 2, scope, generation: null, value: { disposition: 'retired' } }); c.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
    expect(await c.scoped.retire('https://GIT.EXAMPLE.COM:443/')).toEqual({ disposition: 'retired' })
    expect(c.call).toHaveBeenCalledWith('/git', 'remote-retire-grant', { remoteProtocol: 2, ...scope }, undefined)
  })
  it('drops an older in-flight response after a newer one in the same scope', async () => {
    let first!: (value: unknown) => void
    const call = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValueOnce({ ok: true, value: answer() })
    const c = new ScopedRemoteClient({ call } as unknown as GitRpcClient); c.observeCapability({ state: 'on', remoteProtocol: 2 })
    const stale = c.call('remote-login', scope); await c.call('remote-sign-out', scope)
    first({ ok: true, value: answer() }); await expect(stale).rejects.toMatchObject({ reason: 'stale-response' })
  })
  it('keeps independent sessions from invalidating each other while sharing generation checks', async () => {
    let first!: (value: unknown) => void
    const call = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValueOnce({ ok: true, value: answer() })
    const c = new ScopedRemoteClient({ call } as unknown as GitRpcClient); c.observeCapability({ state: 'on', remoteProtocol: 2 })
    const pending = c.call('remote-pr', scope, {}, undefined, 'session-a')
    await c.call('remote-pr', scope, {}, undefined, 'session-b')
    first({ ok: true, value: answer() }); await expect(pending).resolves.toMatchObject({ generation: gen })
  })
  it('rejects replies from an old negotiation even after the seam is enabled again', async () => {
    let first!: (value: unknown) => void
    const call = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValueOnce({ ok: true, value: answer() })
    const c = new ScopedRemoteClient({ call } as unknown as GitRpcClient); c.observeCapability({ state: 'on', remoteProtocol: 2 })
    const pending = c.call('remote-pr', scope); c.observeCapability({ state: 'off' }); c.observeCapability({ state: 'on', remoteProtocol: 2 })
    await c.call('remote-pr', scope); first({ ok: true, value: answer() })
    await expect(pending).rejects.toMatchObject({ reason: 'stale-response' })
  })
  it('rejects a delayed reply from a replaced instance generation across sessions', async () => {
    let first!: (value: unknown) => void
    const newer = { instanceId: 'replacement', revision: 0 }
    const call = vi.fn().mockResolvedValueOnce({ ok: true, value: answer() }).mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValueOnce({ ok: true, value: answer({ generation: newer }) })
    const c = new ScopedRemoteClient({ call } as unknown as GitRpcClient); c.observeCapability({ state: 'on', remoteProtocol: 2 })
    await c.call('remote-pr', scope, {}, undefined, 'session-a')
    const old = c.call('remote-pr', scope, {}, undefined, 'session-a')
    await c.call('remote-pr', scope, {}, undefined, 'session-b'); first({ ok: true, value: answer() })
    await expect(old).rejects.toMatchObject({ reason: 'stale-generation' })
  })
})

describe('cross-instance discovery response', () => {
  it('requires negotiation and a versioned unscoped response, projecting only safe fields', async () => {
    const c = client({ remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: { provider: 'gitlab', instance: scope.instance, path: 'group/repo', scope, ignoredSecret: 'secret' } }] } })
    await expect(c.scoped.discover('/repo')).rejects.toMatchObject({ reason: 'host-not-negotiated' })
    c.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
    expect(JSON.stringify(await c.scoped.discover('/repo'))).not.toContain('secret')
    const old = client({ state: 'supported', remotes: [] }); old.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
    await expect(old.scoped.discover('/repo')).rejects.toMatchObject({ reason: 'invalid-discovery' })
  })
})

it('drops an old GitHub scoped response when the v1 capability announces a new generation', async () => {
  let resolve!: (value: unknown) => void
  const call = vi.fn(() => new Promise(done => { resolve = done }))
  const c = new ScopedRemoteClient({ call } as unknown as GitRpcClient)
  const gh = { provider: 'github', instance: 'https://github.com' } as const
  c.observeCapability({ state: 'on', remoteProtocol: 2, generation: { instanceId: 'old', revision: 1 } })
  const pending = c.call('remote-pr', gh)
  c.observeCapability({ state: 'on', remoteProtocol: 2, generation: { instanceId: 'new', revision: 0 } })
  resolve({ ok: true, value: { remoteProtocol: 2, scope: gh, generation: { instanceId: 'old', revision: 1 }, value: {} } })
  await expect(pending).rejects.toMatchObject({ reason: 'stale-response' })
})

describe('platform accounts list', () => {
  const accounts = (entries: unknown[]): unknown => ({ remoteProtocol: 2, value: { accounts: entries } })
  it('accepts a valid list and drops duplicates', async () => {
    const c = client(accounts([
      { provider: 'github', instance: 'https://github.com' },
      { provider: 'gitlab', instance: 'https://git.example.com' },
      { provider: 'gitlab', instance: 'https://git.example.com' },
      { provider: 'gitlab', instance: 'https://self.example', label: 'Mine' },
    ]))
    c.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
    expect(await c.scoped.accounts()).toEqual([
      { provider: 'github', instance: 'https://github.com' },
      { provider: 'gitlab', instance: 'https://git.example.com' },
      { provider: 'gitlab', instance: 'https://self.example', label: 'Mine' },
    ])
    expect(c.call).toHaveBeenCalledWith('/git', 'remote-accounts', { remoteProtocol: 2 }, undefined)
  })
  it.each([
    { remoteProtocol: 2, scope: scope, value: { accounts: [] } },
    { remoteProtocol: 2, generation: gen, value: { accounts: [] } },
    accounts([{ provider: 'github', instance: 'https://ghe.example.com' }]),
    accounts([{ provider: 'github', instance: 'https://github.com', label: 'x' }]),
    accounts([{ provider: 'gitlab', instance: 'https://GIT.EXAMPLE.COM/' }]),
    accounts([{ provider: 'gitlab', instance: 'not-a-url' }]),
    accounts([{ provider: 'gitlab', instance: 'https://git.example.com', label: 'bad\nlabel' }]),
    accounts([{ provider: 'gitlab', instance: 'https://git.example.com', label: 3 }]),
    accounts(new Array(18).fill({ provider: 'gitlab', instance: 'https://git.example.com' })),
    accounts(['https://git.example.com']),
  ])('rejects a malformed accounts reply %j', async value => {
    const c = client(value); c.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
    await expect(c.scoped.accounts()).rejects.toMatchObject({ reason: 'invalid-accounts' })
  })
  it('refuses to ask an old host for accounts', async () => {
    const c = client()
    await expect(c.scoped.accounts()).rejects.toMatchObject({ reason: 'host-not-negotiated' })
    expect(c.call).not.toHaveBeenCalled()
  })
})
