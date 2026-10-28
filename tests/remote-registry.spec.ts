import { describe, expect, it, vi } from 'vitest'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import { GitLabProviderRegistry, type ScopedRemoteProvider } from '../src/remote/registry.ts'
import type { RemoteSettings } from '../src/remote/settings.ts'
import { gitLabGrantKey } from '../src/remote/instances.ts'

function fixture() {
  const records = new Map<string, CredentialRecord>()
  const service: GitRemoteCredentialService = { readRecord: async key => records.get(key), modifyRecord: async (key, mutate) => { const result = await mutate(records.get(key)); if (result !== undefined) records.set(key, result); return records.get(key) }, deleteRecord: async key => { records.delete(key) }, resolve: vi.fn(), describe: vi.fn(), describeRecord: vi.fn() }
  const source: RemoteSettings = { instances: [{ url: 'https://one.example', clientId: 'one' }, { url: 'https://two.example', clientId: 'two' }] }
  const created: { instance: string; dispose: ReturnType<typeof vi.fn> }[] = []
  const registry = new GitLabProviderRegistry(service, source, instance => {
    const dispose = vi.fn(async () => {})
    created.push({ instance: instance.instance, dispose })
    return { scope: { provider: 'gitlab', instance: instance.instance }, handle: async () => ({ generation: { instanceId: 'opaque', revision: 0 }, value: null }), dispose } satisfies ScopedRemoteProvider
  })
  return { source, service, records, created, registry }
}
describe('GitLab scoped registry', () => {
  it('keeps discovery and guards responsive while a replacement waits for the old owner to drain', async () => {
    const f = fixture(), old = await f.registry.provider('https://one.example')
    let release!: () => void
    const resume = new Promise<void>(resolve => { release = resolve })
    f.created[0]!.dispose.mockImplementation(async () => { await resume })
    f.source.instances = [{ url: old.scope.instance, clientId: 'replacement' }]
    const replacement = f.registry.provider(old.scope.instance)
    try {
      await vi.waitFor(() => expect(f.created[0]!.dispose).toHaveBeenCalledOnce())
      expect((await f.registry.list()).some(instance => instance.instance === old.scope.instance)).toBe(true)
      await expect(f.registry.guard(old)).rejects.toMatchObject({ details: { reason: 'instance-removed' } })
      expect(f.created).toHaveLength(1)
      release()
      expect(await replacement).not.toBe(old)
      await f.registry.dispose()
    } finally { release(); void f.registry.dispose() }
  }, 1500)
  it('joins already removed owners on unload without blocking their late registry guards', async () => {
    const f = fixture(), old = await f.registry.provider('https://one.example')
    let release!: () => void, disposed = false
    const resume = new Promise<void>(resolve => { release = resolve })
    f.created[0]!.dispose.mockImplementation(async () => { await resume; await expect(f.registry.list()).rejects.toMatchObject({ details: { reason: 'disposed' } }) })
    f.source.instances = []
    try {
      await f.registry.reconcile()
      const disposal = f.registry.dispose().then(() => { disposed = true })
      await expect(f.registry.guard(old)).rejects.toMatchObject({ details: { reason: 'disposed' } })
      expect(disposed).toBe(false)
      release(); await disposal
      expect(disposed).toBe(true)
    } finally { release(); void f.registry.dispose() }
  }, 1500)
  it('reuses unchanged owners, drains only changed/removed owners, and rejects unknown scopes', async () => {
    const f = fixture(), a = await f.registry.provider('https://one.example'), b = await f.registry.provider('https://two.example')
    expect(await f.registry.provider('https://ONE.EXAMPLE/')).toBe(a)
    f.source.instances = [{ url: 'https://one.example', clientId: 'changed' }]
    const replacement = await f.registry.provider('https://one.example')
    expect(replacement).not.toBe(a); expect(f.created[0]?.dispose).toHaveBeenCalledOnce(); expect(f.created[1]?.dispose).toHaveBeenCalledOnce()
    await expect(f.registry.provider('https://two.example')).rejects.toMatchObject({ details: { reason: 'instance-unknown' } })
    await f.registry.dispose(); expect(f.created[2]?.dispose).toHaveBeenCalledOnce()
    void b
  })
  it('validates complete changes before touching existing contexts', async () => {
    const f = fixture(), original = await f.registry.provider('https://one.example')
    f.source.instances = [{ url: 'https://one.example' }, { url: 'https://ONE.EXAMPLE/' }]
    expect(await f.registry.provider('https://one.example')).toBe(original)
    await expect(f.registry.retire('https://new.example')).rejects.toMatchObject({ details: { reason: 'invalid-instance-config' } })
    expect(f.created[0]?.dispose).not.toHaveBeenCalled()
    f.source.instances = [{ url: 'https://one.example', clientId: 'one' }]
    expect(await f.registry.provider('https://one.example')).toBe(original)
    await f.registry.dispose()
  })
  it('retirement rejects re-registered instances and touches only the derived key', async () => {
    const f = fixture()
    await expect(f.registry.retire('https://ONE.EXAMPLE/')).rejects.toMatchObject({ details: { reason: 'instance-registered' } })
    expect(f.created).toHaveLength(0)
    const removed = 'https://old.example'; const key = gitLabGrantKey(removed)
    f.records.set(key, { kind: 'grant', payload: { v: 2, state: 'authenticated', provider: 'gitlab', instance: removed, revision: 'before', clientId: 'app', accessToken: 'secret', expiresAt: 123 } })
    expect(await f.registry.retire('https://OLD.EXAMPLE:443/')).toMatchObject({ remoteProtocol: 2, scope: { provider: 'gitlab', instance: removed }, generation: null, value: { disposition: 'retired' } })
    expect(JSON.stringify(f.records.get(key))).not.toContain('secret'); expect(f.created).toHaveLength(0)
    await f.registry.dispose()
  })
  it('serializes registration against a retirement already in progress', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void
    const enteredPromise = new Promise<void>(r => { entered = r })
    const resume = new Promise<void>(r => { release = r })
    const original = f.service.modifyRecord
    f.service.modifyRecord = async (key, mutate) => { entered(); await resume; return original(key, mutate) }
    const retirement = f.registry.retire('https://old.example'); await enteredPromise
    f.source.instances = [{ url: 'https://old.example' }]
    const registration = f.registry.provider('https://old.example')
    release(); expect((await retirement).value.disposition).toBe('absent'); expect((await registration).scope.instance).toBe('https://old.example')
    await f.registry.dispose()
  })
})


it('does not change security identity or rebuild an owner when only its label changes', async () => {
  const f = fixture(), original = await f.registry.provider('https://one.example')
  f.source.instances = [{ url: 'https://one.example', clientId: 'one', label: 'Office' }, { url: 'https://two.example', clientId: 'two' }]
  expect(await f.registry.provider('https://one.example')).toBe(original); expect(f.created[0]?.dispose).not.toHaveBeenCalled()
  await f.registry.dispose()
})
