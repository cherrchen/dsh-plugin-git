// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RemoteAuthSection } from '../src/client/remote/RemoteAuthSection.tsx'
import type { GitRemoteCapabilityOn, ScopedRemoteCapabilityOn } from '../src/remote/types.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const capability: GitRemoteCapabilityOn = {
  state: 'on', generation: { instanceId: 'test', revision: 1 },
  credential: { configured: true, writable: true }, auth: { state: 'authenticated' },
  actions: { canComment: 'unknown', canReview: 'unknown', canMerge: 'unknown', canClose: 'unknown', canCreatePr: 'unknown' },
  loginAvailable: true, automaticRefreshAvailable: false,
}
function mount(auth: GitRemoteCapabilityOn['auth'], options: { loginAvailable?: boolean; busy?: boolean; authSelection?: GitRemoteCapabilityOn['authSelection'] } = {}) {
  const onAuth = vi.fn()
  const onLogin = vi.fn()
  const onSelectMethod = vi.fn()
  const onLogoutOAuth = vi.fn()
  const view = render(<RemoteAuthSection capability={{ ...capability, auth, ...(options.authSelection === undefined ? {} : { authSelection: options.authSelection }), loginAvailable: options.loginAvailable ?? true }}
    viewer={{ host: 'github.com', userId: '1', login: 'alice' }} busy={options.busy ?? false} login={undefined}
    onAuth={onAuth} onSelectMethod={onSelectMethod} onLogoutOAuth={onLogoutOAuth} onLogin={onLogin} onCancelLogin={vi.fn()} t={key => en[key]} />)
  return { onAuth, onLogin, onSelectMethod, onLogoutOAuth, view }
}
const cli = () => screen.getByRole('radio', { name: en['remote.authSourceGh'] })
const oauth = () => screen.getByRole('radio', { name: en['remote.authSourceOAuth'].replace('{platform}', 'GitHub') })

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
      expect(screen.getByText(messages[headline].replace('{platform}', 'GitHub'), { exact: true })).not.toBeNull()
      view.unmount()
    }
  })
  it.each([
    [{ state: 'authenticated', source: 'ref' }, 'settings.accounts.sourceRef'],
    [{ state: 'authenticated', source: 'git-credential' }, 'settings.accounts.sourceGitCredential'],
    [{ state: 'authenticated', source: 'gh' }, 'settings.accounts.sourceGh'],
    [{ state: 'authenticated', source: 'grant' }, 'settings.accounts.sourceOauth'],
  ] as const)('shows %j with a localized source subline', (auth, label) => {
    const { view } = mount(auth as GitRemoteCapabilityOn['auth'])
    expect(screen.getByText(`Connected to GitHub · ${en[label]}`, { exact: true })).not.toBeNull()
    expect(view.container.textContent).not.toContain('future-provider')
  })
  it('omits the source label when it is unknown or the state is not authenticated', () => {
    for (const auth of [
      { state: 'authenticated' },
      { state: 'authenticated', source: 'future-provider' },
      { state: 'anonymous' },
      { state: 'signed-out' },
    ] as GitRemoteCapabilityOn['auth'][]) {
      const { view } = mount(auth)
      for (const key of ['settings.accounts.sourceRef', 'settings.accounts.sourceGitCredential'] as const) {
        expect(view.container.textContent).not.toContain(en[key])
      }
      expect(view.container.textContent).not.toContain('future-provider')
      view.unmount()
    }
  })
  it('keeps hint lines for non-authenticated states and drops the removed footer/disconnect hints', () => {
    const { view } = mount({ state: 'anonymous' } as GitRemoteCapabilityOn['auth'])
    expect(screen.getByText(en['remote.authStatusAnonymousHint'].replace('{platform}', 'GitHub'), { exact: true })).not.toBeNull()
    expect(view.container.textContent).not.toContain('git fetch')
    view.unmount()
  })
  it('shows OAuth logout for an active grant and never offers CLI logout', () => {
    for (const source of ['gh', 'ref', 'grant'] as const) {
      const { view } = mount({ state: 'authenticated', source })
      expect(screen.queryByRole('button', { name: en['remote.oauthLogout'] }) !== null).toBe(source === 'grant')
      view.unmount()
    }
  })
  it('allows OAuth logout during an in-flight operation while method changes are disabled', () => {
    mount({ state: 'authenticated', source: 'grant' }, { busy: true })
    expect((screen.getByRole('button', { name: en['remote.oauthLogout'] }) as HTMLButtonElement).disabled).toBe(false)
    expect((cli() as HTMLInputElement).disabled).toBe(true)
    expect((oauth() as HTMLInputElement).disabled).toBe(true)
  })
})

describe('authentication method radios', () => {
  it.each(['github', 'gitlab'] as const)('keeps CLI and OAuth selectable for an authenticated %s CLI user in both locales', provider => {
    for (const messages of [en, zh]) {
      const cliLabel = messages[provider === 'gitlab' ? 'remote.authSourceGlab' : 'remote.authSourceGh']
      const oauthLabel = messages['remote.authSourceOAuth'].replace('{platform}', provider === 'gitlab' ? 'GitLab' : 'GitHub')
      const onLogin = vi.fn(), onAuth = vi.fn()
      const renderSection = (source: 'gh' | 'glab' | 'grant') => <RemoteAuthSection
        capability={{ ...capability, auth: { state: 'authenticated', source }, authMethods: { deviceFlow: { supported: true } } }} viewer={undefined}
        gitlab={provider === 'gitlab'} busy={false} login={undefined} onAuth={onAuth} onLogin={onLogin} onCancelLogin={vi.fn()} t={key => messages[key]} />
      const view = render(renderSection(provider === 'gitlab' ? 'glab' : 'gh'))
      const cliRadio = screen.getByRole('radio', { name: cliLabel }) as HTMLInputElement
      const oauthRadio = screen.getByRole('radio', { name: oauthLabel }) as HTMLInputElement
      expect(cliRadio.checked).toBe(true)
      expect(oauthRadio.disabled).toBe(false)
      fireEvent.click(oauthRadio)
      expect(onLogin).toHaveBeenCalledTimes(1)
      view.rerender(renderSection('grant'))
      expect(oauthRadio.checked).toBe(true)
      expect(cliRadio.disabled).toBe(false)
      fireEvent.click(cliRadio)
      expect(onAuth).toHaveBeenCalledWith('remote-clear-grant', 'remote-retry-auth')
      view.unmount()
    }
  })
  it.each([
    [false, true, false, 'remote.oauthUnsupported'],
    [true, false, false, 'remote.oauthReadOnly'],
    [true, true, false, 'remote.oauthNotConfigured'],
    ['unknown', true, true, 'remote.oauthUnverified'],
  ] as const)('explains OAuth availability for flow=%s, writable=%s, loginAvailable=%s', (supported, writable, loginAvailable, hint) => {
    const onLogin = vi.fn()
    const scoped: ScopedRemoteCapabilityOn = { ...capability, auth: { state: 'authenticated', source: 'glab' }, credential: { configured: true, writable }, authMethods: { deviceFlow: { supported } }, loginAvailable }
    render(<RemoteAuthSection capability={scoped} gitlab viewer={undefined} busy={false} login={undefined} onAuth={vi.fn()} onLogin={onLogin} onCancelLogin={vi.fn()} t={key => en[key]} />)
    const oauthRadio = screen.getByRole('radio', { name: 'GitLab OAuth (device login)' }) as HTMLInputElement
    expect(oauthRadio.disabled).toBe(!loginAvailable)
    expect(screen.getByText(en[hint]).id).toBe(oauthRadio.getAttribute('aria-describedby'))
    fireEvent.click(oauthRadio)
    expect(onLogin).toHaveBeenCalledTimes(loginAvailable ? 1 : 0)
  })
  it('uses GitLab copy throughout pending device login and blocks competing method changes', () => {
    const onCancelLogin = vi.fn()
    render(<RemoteAuthSection capability={capability} gitlab viewer={undefined} busy={false}
      login={{ attemptId: 'attempt', userCode: 'TEST-CODE', verificationUri: 'https://gitlab.com/oauth/device' }}
      onAuth={vi.fn()} onLogin={vi.fn()} onCancelLogin={onCancelLogin} t={key => zh[key]} />)
    expect(screen.getByRole('link', { name: '打开 GitLab 并输入代码' }).getAttribute('href')).toBe('https://gitlab.com/oauth/device')
    expect(screen.getByText('在 GitLab 页面输入此代码：')).not.toBeNull()
    expect(document.body.textContent).not.toContain('GitHub')
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['branch.cancel'] }))
    expect(onCancelLogin).toHaveBeenCalledWith('attempt')
  })
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
  it('selecting OAuth calls onLogin and keeps a disabled option without loginAvailable', () => {
    const { onLogin } = mount({ state: 'anonymous' } as GitRemoteCapabilityOn['auth'])
    fireEvent.click(oauth())
    expect(onLogin).toHaveBeenCalledTimes(1)
    cleanup()
    mount({ state: 'anonymous' } as GitRemoteCapabilityOn['auth'], { loginAvailable: false })
    expect((oauth() as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(en['remote.oauthNotConfigured'])).not.toBeNull()
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


describe('persisted authentication selection', () => {
  it('uses method selection without clearing the saved OAuth and offers OAuth-only logout while CLI is active', () => {
    const { onAuth, onLogin, onSelectMethod, onLogoutOAuth } = mount({ state: 'authenticated', source: 'gh' }, { authSelection: { method: 'cli', cliAvailable: true, oauthCached: true } })
    expect(screen.getByText(en['remote.oauthSaved'])).not.toBeNull()
    fireEvent.click(oauth())
    expect(onSelectMethod).toHaveBeenCalledWith('oauth')
    expect(onLogin).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en['remote.oauthLogout'] }))
    expect(onLogoutOAuth).toHaveBeenCalledOnce()
    expect(onAuth).not.toHaveBeenCalled()
  })
  it('switches from OAuth to CLI through the new method endpoint', () => {
    const { onAuth, onSelectMethod } = mount({ state: 'authenticated', source: 'grant' }, { authSelection: { method: 'oauth', cliAvailable: true, oauthCached: true } })
    fireEvent.click(cli())
    expect(onSelectMethod).toHaveBeenCalledWith('cli')
    expect(onAuth).not.toHaveBeenCalled()
  })
})
