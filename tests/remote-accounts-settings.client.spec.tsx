// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteAccountsSettings } from '../src/client/settings/RemoteAccountsSettings.tsx'
import { GitRemoteFeature } from '../src/client/remote.ts'
import { en } from '../src/client/locales.ts'
import type { GitRpcClient } from '../src/client/controller.ts'

const owners: GitRemoteFeature[] = []
afterEach(() => { cleanup(); owners.splice(0).forEach(f => f.dispose()) })
it('manages instance authentication from settings without a repository or session', async () => {
  const scope = { provider: 'gitlab', instance: 'https://gitlab.com' } as const
  const generation = { instanceId: 'settings', revision: 1 }
  let source = 'grant'
  const cap = () => ({ state: 'on', generation, credential: { configured: true, writable: true }, auth: { state: 'authenticated', source }, viewer: { host: 'gitlab.com', userId: '7', login: 'settings-user' }, loginAvailable: true,
    authSelection: { method: source === 'glab' ? 'cli' : 'oauth', cliAvailable: true, oauthCached: true }, authMethods: { deviceFlow: { supported: true } } })
  const call = vi.fn(async (_channel: string, endpoint: string, payload: any) => {
    if (payload.remoteProtocol !== 2) return { ok: true, value: { ...cap(), remoteProtocol: 2, authScopes: [{ provider: 'github', instance: 'https://github.com' }, scope] } }
    if (endpoint === 'remote-select-auth') source = 'glab'
    return { ok: true, value: { remoteProtocol: 2, scope: { provider: payload.provider, instance: payload.instance }, generation, value: cap() } }
  })
  const feature = new GitRemoteFeature({ call } as unknown as GitRpcClient); owners.push(feature)
  feature.refresh()
  await vi.waitFor(() => expect(feature.getSnapshot().state).toBe('on'))
  render(<RemoteAccountsSettings feature={feature} t={key => en[key]} />)
  await screen.findAllByText('@settings-user')
  const buttons = screen.getAllByRole('button', { name: en['settings.accountsManage'] })
  fireEvent.click(buttons[1]!)
  fireEvent.click(screen.getByRole('radio', { name: en['remote.authSourceGlab'] }))
  await waitFor(() => expect((screen.getByRole('radio', { name: en['remote.authSourceGlab'] }) as HTMLInputElement).checked).toBe(true))
  const scoped = call.mock.calls.filter(args => args[2].remoteProtocol === 2)
  expect(scoped.some(args => args[1] === 'remote-select-auth')).toBe(true)
  expect(scoped.every(args => !('repository' in args[2]) && !('sessionId' in args[2]))).toBe(true)
  expect(scoped.every(args => ['remote-auth-status', 'remote-capability', 'remote-select-auth'].includes(args[1]))).toBe(true)
})
