import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRemoteSettings } from '../src/remote/settings.ts'
import { resolveGitLabInstances } from '../src/remote/instances.ts'
afterEach(() => vi.unstubAllGlobals())
describe('public OAuth release defaults', () => {
  it('uses explicit overrides and empty disable markers ahead of release defaults, isolated per platform', () => {
    vi.stubGlobal('__DSH_GIT_OAUTH_CLIENT_IDS__', { github: 'publisher-gh', gitlab: 'publisher-gl' })
    expect(resolveRemoteSettings(undefined).clientId).toBe('publisher-gh')
    expect(resolveRemoteSettings({ clientId: 'own-gh' }).clientId).toBe('own-gh')
    expect(resolveRemoteSettings({ clientId: '' }).clientId).toBeUndefined()
    expect(resolveGitLabInstances(undefined)[0]?.clientId).toBe('publisher-gl')
    const instances = resolveGitLabInstances([{ url: 'https://gitlab.com', clientId: '' }, { url: 'https://office.example' }])
    expect(instances.every(instance => instance.clientId === undefined)).toBe(true)
    expect(resolveGitLabInstances([{ url: 'https://gitlab.com', clientId: 'own-gl' }])[0]?.clientId).toBe('own-gl')
  })
  it('keeps source-only tests without injected publisher IDs unconfigured and rejects malformed application IDs', () => {
    expect(resolveRemoteSettings(undefined).clientId).toBeUndefined()
    expect(resolveGitLabInstances(undefined)[0]?.clientId).toBeUndefined()
    expect(() => resolveRemoteSettings({ clientId: 'bad id' })).toThrow('invalid OAuth client ID')
  })
})
