// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RemoteAuthSection } from '../src/client/remote/RemoteAuthSection.tsx'
import type { GitRemoteCapabilityOn } from '../src/remote/types.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const capability: GitRemoteCapabilityOn = {
  state: 'on', generation: { instanceId: 'test', revision: 1 },
  credential: { configured: true, writable: true }, auth: { state: 'authenticated' },
  actions: { canComment: 'unknown', canReview: 'unknown', canMerge: 'unknown', canClose: 'unknown', canCreatePr: 'unknown' },
  loginAvailable: true, automaticRefreshAvailable: false,
}
function mount(auth: GitRemoteCapabilityOn['auth'], options: { loginAvailable?: boolean; busy?: boolean } = {}) {
  const onAuth = vi.fn()
  const onLogin = vi.fn()
  const view = render(<RemoteAuthSection capability={{ ...capability, auth, loginAvailable: options.loginAvailable ?? true }}
    viewer={{ host: 'github.com', userId: '1', login: 'alice' }} busy={options.busy ?? false} login={undefined}
    onAuth={onAuth} onLogin={onLogin} onCancelLogin={vi.fn()} t={key => en[key]} />)
  return { onAuth, onLogin, view }
}
const cli = () => screen.getByRole('radio', { name: en['remote.authSourceGh'] })
const oauth = () => screen.getByRole('radio', { name: en['remote.authSourceOAuth'] })

describe('authentication status card', () => {
  it.each([
    [{ state: 'authenticated', source: 'gh' }, 'remote.authStatusConnected'],
    [{ state: 'authenticated', source: 'grant' }, 'remote.authStatusConnected'],
    [{ state: 'anonymous' }, 'remote.authStatusAnonymous'],
    [{ state: 'unauthenticated' }, 'remote.authStatusAnonymous'],
    [{ state: 'signed-out' }, 'remote.authStatusSignedOut'],
    [{ state: 'invalid' }, 'remote.authStatusInvalid'],
  ] as const)('shows %j headline in both locales', (auth, headline) => {
    for (const messages of [en, zh]) {
      const view = render(<RemoteAuthSection capability={{ ...capability, auth: auth as GitRemoteCapabilityOn['auth'] }}
        viewer={undefined} busy={false} login={undefined} onAuth={vi.fn()} onLogin={vi.fn()} onCancelLogin={vi.fn()}
        t={key => messages[key]} />)
      expect(screen.getByText(messages[headline], { exact: true })).not.toBeNull()
      view.unmount()
    }
  })
  it.each([
    [{ state: 'authenticated', source: 'ref' }, 'remote.authSourceRef'],
    [{ state: 'authenticated', source: 'git-credential' }, 'remote.authSourceGitCredential'],
    [{ state: 'authenticated' }, 'remote.authSourceUnknown'],
    [{ state: 'authenticated', source: 'future-provider' }, 'remote.authSourceUnknown'],
  ] as const)('shows %j with a localized source subline', (auth, label) => {
    const { view } = mount(auth as GitRemoteCapabilityOn['auth'])
    expect(screen.getByText(en[label], { exact: true })).not.toBeNull()
    expect(view.container.textContent).not.toContain('future-provider')
  })
  it('shows no source subline for gh/grant sources or non-authenticated states', () => {
    for (const auth of [
      { state: 'authenticated', source: 'gh' },
      { state: 'authenticated', source: 'grant' },
      { state: 'anonymous' },
      { state: 'signed-out' },
    ] as GitRemoteCapabilityOn['auth'][]) {
      const { view } = mount(auth)
      for (const key of ['remote.authSourceRef', 'remote.authSourceGitCredential', 'remote.authSourceUnknown'] as const) {
        expect(view.container.textContent).not.toContain(en[key])
      }
      view.unmount()
    }
  })
  it('keeps hint lines for non-authenticated states and drops the removed footer/disconnect hints', () => {
    const { view } = mount({ state: 'anonymous' } as GitRemoteCapabilityOn['auth'])
    expect(screen.getByText(en['remote.authStatusAnonymousHint'], { exact: true })).not.toBeNull()
    expect(view.container.textContent).not.toContain('git fetch')
    view.unmount()
  })
  it('shows disconnect only for authenticated and invalid states', () => {
    const states = { anonymous: false, unauthenticated: false, 'signed-out': false, authenticated: true, invalid: true } as const
    for (const [state, shown] of Object.entries(states)) {
      const { view } = mount({ state } as GitRemoteCapabilityOn['auth'])
      expect(screen.queryByRole('button', { name: en['remote.disconnect'] }) !== null).toBe(shown)
      view.unmount()
    }
  })
  it('never disables disconnect while busy', () => {
    mount({ state: 'authenticated', source: 'gh' } as GitRemoteCapabilityOn['auth'], { busy: true })
    expect((screen.getByRole('button', { name: en['remote.disconnect'] }) as HTMLButtonElement).disabled).toBe(false)
    expect((cli() as HTMLInputElement).disabled).toBe(true)
    expect((oauth() as HTMLInputElement).disabled).toBe(true)
  })
})

describe('authentication method radios', () => {
  it.each([
    [{ state: 'authenticated', source: 'gh' }, true, false],
    [{ state: 'authenticated', source: 'grant' }, false, true],
    [{ state: 'authenticated', source: 'ref' }, false, false],
    [{ state: 'anonymous' }, false, false],
  ] as const)('checks the active method for %j', (auth, cliChecked, oauthChecked) => {
    mount(auth as GitRemoteCapabilityOn['auth'])
    expect((cli() as HTMLInputElement).checked).toBe(cliChecked)
    expect((oauth() as HTMLInputElement).checked).toBe(oauthChecked)
  })
  it.each([
    [{ state: 'anonymous' }, []],
    [{ state: 'authenticated', source: 'ref' }, []],
    [{ state: 'signed-out', source: 'gh' }, ['remote-clear-grant']],
    [{ state: 'invalid', source: 'gh' }, ['remote-clear-grant']],
    [{ state: 'authenticated', source: 'grant' }, ['remote-clear-grant']],
  ] as const)('selecting GitHub CLI for %j sends %j + retry-auth', (auth, reset) => {
    const { onAuth } = mount(auth as GitRemoteCapabilityOn['auth'])
    fireEvent.click(cli())
    expect(onAuth).toHaveBeenCalledWith(...reset, 'remote-retry-auth')
  })
  it('selecting OAuth calls onLogin and hides the option without loginAvailable', () => {
    const { onLogin } = mount({ state: 'anonymous' } as GitRemoteCapabilityOn['auth'])
    fireEvent.click(oauth())
    expect(onLogin).toHaveBeenCalledTimes(1)
    cleanup()
    mount({ state: 'anonymous' } as GitRemoteCapabilityOn['auth'], { loginAvailable: false })
    expect(screen.queryByRole('radio', { name: en['remote.authSourceOAuth'] })).toBeNull()
    expect(cli()).not.toBeNull()
  })
  it('shows the gh login hint only when not authenticated', () => {
    const shown = { anonymous: true, 'signed-out': true, invalid: true, authenticated: false } as const
    for (const [state, expectHint] of Object.entries(shown)) {
      const { view } = mount({ state } as GitRemoteCapabilityOn['auth'])
      expect(screen.queryByText(en['remote.ghLoginHint'], { exact: true }) !== null).toBe(expectHint)
      view.unmount()
    }
  })
})
