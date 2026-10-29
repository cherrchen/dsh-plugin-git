// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RetireGrantDialog } from '../src/client/settings/RetireGrantDialog.tsx'
import { RemoteAccountsSettings } from '../src/client/settings/RemoteAccountsSettings.tsx'
import type { GitRemoteFeature } from '../src/client/remote.ts'
import type { RemoteAccountDescriptor } from '../src/client/remote-protocol.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture(accounts: readonly RemoteAccountDescriptor[] = [], disposition: 'retired' | 'already-retired' | 'absent' = 'retired', fail?: { reason?: string; details?: Record<string, string | number | boolean> }) {
  const retireGrant = vi.fn(async (instance: string) => {
    if (fail !== undefined) {
      const { ScopedProtocolError } = await import('../src/client/remote-protocol.ts')
      throw new ScopedProtocolError(fail.reason ?? 'control-error', 'git/remote-unavailable', fail.details)
    }
    return { disposition }
  })
  const feature = { retireGrant, getAccounts: () => accounts } as unknown as GitRemoteFeature
  const onDone = vi.fn()
  const onClose = vi.fn()
  const onFailure = vi.fn()
  return { feature, retireGrant, onDone, onClose, onFailure }
}

describe('orphan-grant settings dialog', () => {
  it('requires a separate confirmation, normalizes the scope, and reports the disposition', async () => {
    const f = fixture()
    render(<RetireGrantDialog open feature={f.feature} onClose={f.onClose} onDone={f.onDone} onFailure={f.onFailure} t={key => en[key]} />)
    fireEvent.change(screen.getByPlaceholderText('https://gitlab.example.com'), { target: { value: 'https://GIT.EXAMPLE.COM:443/' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireNext'] }))
    expect(f.retireGrant).not.toHaveBeenCalled()
    expect(screen.getByText('https://git.example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireDelete'] }))
    await waitFor(() => expect(f.retireGrant).toHaveBeenCalledWith('https://git.example.com'))
    await waitFor(() => expect(f.onDone).toHaveBeenCalledWith('settings.accounts.retireDone'))
    expect(f.onClose).toHaveBeenCalled()
  })
  it('rejects a non-https address without calling the host', () => {
    const f = fixture()
    render(<RetireGrantDialog open feature={f.feature} onClose={f.onClose} onDone={f.onDone} onFailure={f.onFailure} t={key => en[key]} />)
    fireEvent.change(screen.getByPlaceholderText('https://gitlab.example.com'), { target: { value: 'ssh://git@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireNext'] }))
    expect(screen.getByRole('alert').textContent).toBe(en['settings.accounts.retireInvalid'])
    expect(f.retireGrant).not.toHaveBeenCalled()
  })
  it('points a registered instance back to the account list', () => {
    const f = fixture([{ provider: 'gitlab', instance: 'https://git.example.com' }])
    render(<RetireGrantDialog open feature={f.feature} onClose={f.onClose} onDone={f.onDone} onFailure={f.onFailure} t={key => en[key]} />)
    fireEvent.change(screen.getByPlaceholderText('https://gitlab.example.com'), { target: { value: 'https://git.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireNext'] }))
    expect(screen.getByRole('alert').textContent).toBe(en['settings.accounts.retireRegistered'])
    expect(f.retireGrant).not.toHaveBeenCalled()
  })
  it('keeps the input when Back is chosen on the confirm step', () => {
    const f = fixture()
    render(<RetireGrantDialog open feature={f.feature} onClose={f.onClose} onDone={f.onDone} onFailure={f.onFailure} t={key => en[key]} />)
    fireEvent.change(screen.getByPlaceholderText('https://gitlab.example.com'), { target: { value: 'https://git.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireNext'] }))
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireBack'] }))
    expect((screen.getByPlaceholderText('https://gitlab.example.com') as HTMLInputElement).value).toBe('https://git.example.com')
  })
  it('stays on the confirm step with an error line when the host rejects', async () => {
    const f = fixture([], 'retired', { details: { reason: 'record-mismatch' } })
    render(<RetireGrantDialog open feature={f.feature} onClose={f.onClose} onDone={f.onDone} onFailure={f.onFailure} t={key => en[key]} />)
    fireEvent.change(screen.getByPlaceholderText('https://gitlab.example.com'), { target: { value: 'https://git.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireNext'] }))
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireDelete'] }))
    await waitFor(() => expect(f.onFailure).toHaveBeenCalledWith({ summary: en['settings.accounts.retireMismatch'], detail: 'code: git/remote-unavailable' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(f.onClose).not.toHaveBeenCalled()
    expect(f.onDone).not.toHaveBeenCalled()
  })
  it('opens from the accounts section and surfaces the result as a toast', async () => {
    const retireGrant = vi.fn(async () => ({ disposition: 'absent' as const }))
    const rowState = { pending: undefined }
    const capOn = { state: 'on' }
    const accounts: readonly RemoteAccountDescriptor[] = []
    const controller = { subscribe: () => () => {}, getSnapshot: () => rowState, refreshAccount: async () => {} }
    const feature = {
      subscribe: () => () => {},
      getSnapshot: () => capOn,
      getAccounts: () => accounts,
      scoped: { available: true },
      retireGrant,
      accountControllerFor: () => controller,
    } as unknown as GitRemoteFeature
    render(<RemoteAccountsSettings feature={feature} t={key => en[key]} />)
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireButton'] }))
    expect(screen.getByRole('dialog', { name: en['settings.accounts.retireTitle'] })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('https://gitlab.example.com'), { target: { value: 'https://old.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireNext'] }))
    fireEvent.click(screen.getByRole('button', { name: en['settings.accounts.retireDelete'] }))
    await waitFor(() => expect(retireGrant).toHaveBeenCalledWith('https://old.example.com'))
    expect(await screen.findByText(en['settings.accounts.retireAbsent'])).toBeTruthy()
  })
})
