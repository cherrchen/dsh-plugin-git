// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { GitRpcClient } from '../src/client/controller.ts'
import { GitRemoteFeature } from '../src/client/remote.ts'
import { RemoteAccountsSettings } from '../src/client/settings/RemoteAccountsSettings.tsx'
import { GitBundleConfigCard } from '../src/client/settings/GitBundleConfigCard.tsx'
import { en } from '../src/client/locales.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(cleanup)

const t = (key: Parameters<PropsLocale<'git'>['t']>[0]) => en[key]
const generation = { instanceId: 'gen', revision: 1 }
const actions = { canComment: false, canReview: false, canMerge: false, canClose: false, canCreatePr: false }
const cap = (auth: Record<string, unknown>, viewer?: unknown) => ({ state: 'on', generation, auth, viewer, credential: { configured: true, writable: true }, actions, loginAvailable: true, automaticRefreshAvailable: false, authMethods: { deviceFlow: { supported: true } }, authSelection: { method: 'oauth', cliAvailable: false, oauthCached: false } })

function fixture(options: { auth?: Record<string, unknown>; viewer?: unknown; accounts?: unknown; scopedAvailable?: boolean; fail?: boolean; accountFail?: boolean; account?: (request: Record<string, unknown>) => ReturnType<typeof cap> } = {}) {
  const scope = { provider: 'gitlab', instance: 'https://git.example.com' }
  const call = vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
    const request = payload as Record<string, unknown>
    if (endpoint === 'remote-capability' && request['remoteProtocol'] !== 2) return { ok: true, value: { state: 'on', remoteProtocol: 2, generation, auth: { state: 'anonymous' }, credential: { configured: false, writable: true }, actions, loginAvailable: false } }
    if (endpoint === 'remote-accounts') {
      if (options.fail) return { ok: false, error: { code: 'git/remote-unavailable' } }
      return { ok: true, value: { remoteProtocol: 2, value: { accounts: options.accounts ?? [
        { provider: 'github', instance: 'https://github.com' },
        { provider: 'gitlab', instance: 'https://gitlab.com' },
        { provider: 'gitlab', instance: 'https://git.example.com/gitlab', label: 'Self-hosted' },
      ] } } }
    }
    const instance = request['instance']
    const echo = { remoteProtocol: 2, scope: { provider: request['provider'] ?? 'gitlab', instance: instance ?? scope.instance }, generation }
    if (endpoint === 'remote-account' || endpoint === 'remote-capability') {
      if (options.accountFail) return { ok: false, error: { code: 'git/remote-unavailable' } }
      const value = options.account?.(request) ?? cap(options.auth ?? { state: 'anonymous' }, options.viewer)
      return { ok: true, value: { ...echo, generation: value.generation, value } }
    }
    return { ok: true, value: { ...echo, value: cap({ state: 'anonymous' }) } }
  })
  const feature = new GitRemoteFeature({ call } as unknown as GitRpcClient)
  feature.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
  if (options.scopedAvailable === false) feature.scoped.observeCapability({ state: 'off', remoteProtocol: 2 })
  else feature.refresh()
  feature.loadAccounts()
  return { feature, call }
}

describe('RemoteAccountsSettings', () => {
  it('renders a connected GitHub row and labelled GitLab rows with status', async () => {
    const f = fixture({ auth: { state: 'authenticated', source: 'grant' }, viewer: { host: 'github.com', userId: '42', login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/42' } })
    render(<RemoteAccountsSettings feature={f.feature} t={t} />)
    await waitFor(() => expect(screen.getAllByText('@octocat · OAuth').length).toBeGreaterThan(0))
    expect(document.querySelector('img')).not.toBeNull()
    expect(screen.getAllByText('Manage').length).toBeGreaterThan(0)
    expect(screen.getByText('Self-hosted')).toBeTruthy()
    f.feature.dispose()
  })
  it('shows Connect for anonymous rows and opens the shared auth dialog', async () => {
    const f = fixture({ auth: { state: 'anonymous' } })
    render(<RemoteAccountsSettings feature={f.feature} t={t} />)
    await waitFor(() => expect(screen.getAllByText('Connect').length).toBeGreaterThan(0))
    // GitLab.com's friendly name is its host, so no host prefix is rendered.
    expect(screen.getAllByText('Not connected', { exact: true }).length).toBeGreaterThan(0)
    expect(screen.queryByText(/gitlab\.com ·/)).toBeNull()
    screen.getAllByText('Connect')[0]!.click()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    f.feature.dispose()
  })
  it('offers a retry after a failed account read', async () => {
    const f = fixture({ accountFail: true })
    render(<RemoteAccountsSettings feature={f.feature} t={t} />)
    await waitFor(() => expect(screen.getAllByText("Couldn't read status").length).toBeGreaterThan(0))
    const retries = screen.getAllByRole('button', { name: 'Retry' })
    const before = f.call.mock.calls.filter(call => call[1] === 'remote-account').length
    retries[0]!.click()
    await waitFor(() => expect(f.call.mock.calls.filter(call => call[1] === 'remote-account').length).toBeGreaterThan(before))
    f.feature.dispose()
  })
  it('re-discovers instances on capability polls even when the GitHub generation is unchanged', async () => {
    const options: { accounts?: unknown } = { accounts: [
      { provider: 'github', instance: 'https://github.com' },
      { provider: 'gitlab', instance: 'https://gitlab.com' },
    ] }
    const f = fixture(options)
    render(<RemoteAccountsSettings feature={f.feature} t={t} />)
    await waitFor(() => expect(screen.getByText('GitLab.com')).toBeTruthy())
    const requests = () => f.call.mock.calls.filter(call => call[1] === 'remote-accounts').length
    const before = requests()
    // The registry reconciles a new instance without changing the unscoped GitHub generation.
    options.accounts = [
      { provider: 'github', instance: 'https://github.com' },
      { provider: 'gitlab', instance: 'https://gitlab.com' },
      { provider: 'gitlab', instance: 'https://git.example.com' },
    ]
    f.feature.refresh()
    await waitFor(() => expect(requests()).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByText('git.example.com')).toBeTruthy())
    f.feature.dispose()
  })
  it('refreshes an existing GitLab owner after App configuration changes without changing the account descriptor', async () => {
    const scope = { provider: 'gitlab', instance: 'https://self.example' } as const
    let configured = false
    const f = fixture({ accounts: [scope], account: request => ({
      ...cap({ state: 'anonymous' }),
      generation: request['provider'] === 'gitlab' ? { instanceId: configured ? 'new-owner' : 'old-owner', revision: 0 } : generation,
      loginAvailable: configured && request['provider'] === 'gitlab',
    }) })
    try {
      render(<RemoteAccountsSettings feature={f.feature} t={t} />)
      const controller = f.feature.accountControllerFor(scope)
      await waitFor(() => expect(controller.getSnapshot().scopedCapability?.loginAvailable).toBe(false))
      const accounts = f.feature.getAccounts()
      configured = true
      act(() => { f.feature.refresh() })
      await waitFor(() => expect(controller.getSnapshot()).toMatchObject({ busy: false, generation: { instanceId: 'new-owner' }, scopedCapability: { loginAvailable: true } }))
      expect(f.feature.getAccounts()).toBe(accounts)
      const polls = () => f.call.mock.calls.filter(entry => entry[1] === 'remote-capability' && (entry[2] as Record<string, unknown>)['remoteProtocol'] !== 2).length
      const before = polls()
      // Background account reads must not feed back into another global poll / accounts read.
      await act(async () => { await controller.refreshAccount(true) })
      expect(polls()).toBe(before)
    } finally { f.feature.dispose() }
  })
  it('revalidates retained GitLab rows on settings reentry but leaves unmounted rows idle', async () => {
    const scope = { provider: 'gitlab', instance: 'https://self.example' } as const
    let login = 'old-viewer'
    const f = fixture({ accounts: [scope], account: request => request['provider'] === 'gitlab' ? cap({ state: 'authenticated', source: 'ref' }, { host: 'self.example', userId: '1', login }) : cap({ state: 'anonymous' }) })
    try {
      const view = render(<RemoteAccountsSettings feature={f.feature} t={t} />)
      await screen.findByText(/@old-viewer/)
      view.unmount()
      const reads = () => f.call.mock.calls.filter(entry => entry[1] === 'remote-account' && (entry[2] as Record<string, unknown>)['provider'] === 'gitlab').length
      const before = reads()
      login = 'new-viewer'
      await act(async () => { f.feature.loadAccounts() })
      expect(reads()).toBe(before)
      render(<RemoteAccountsSettings feature={f.feature} t={t} />)
      await screen.findByText(/@new-viewer/)
      expect(reads()).toBeGreaterThan(before)
    } finally { f.feature.dispose() }
  })
  it('does not interrupt a device login when rediscovering the same account', async () => {
    const scope = { provider: 'gitlab', instance: 'https://self.example' } as const
    const f = fixture({ accounts: [scope] })
    try {
      render(<RemoteAccountsSettings feature={f.feature} t={t} />)
      const controller = f.feature.accountControllerFor(scope)
      await waitFor(() => expect(controller.getSnapshot().scopedCapability).toBeDefined())
      const original = f.call.getMockImplementation()!
      let finish!: (reply: { ok: boolean; value: unknown }) => void
      f.call.mockImplementation(async (...args) => {
        const [, endpoint] = args
        const envelope = (value: unknown) => ({ ok: true, value: { remoteProtocol: 2, scope, generation, value } })
        if (endpoint === 'remote-login') return envelope({ attemptId: 'active', userCode: 'CODE', verificationUri: `${scope.instance}/oauth/device`, expiresAt: Date.now() + 60_000 })
        if (endpoint === 'remote-poll-login') return new Promise(resolve => { finish = resolve })
        return original(...args)
      })
      await act(async () => { await controller.login() })
      expect(controller.getSnapshot().login?.attemptId).toBe('active')
      const before = f.call.mock.calls.filter(entry => entry[1] === 'remote-account').length
      await act(async () => { f.feature.loadAccounts() })
      expect(f.call.mock.calls.filter(entry => entry[1] === 'remote-account')).toHaveLength(before)
      expect(controller.getSnapshot().login?.attemptId).toBe('active')
      await act(async () => { await controller.cancelLogin() })
      finish({ ok: true, value: { remoteProtocol: 2, scope, generation, value: { state: 'authenticated' } } })
    } finally { f.feature.dispose() }
  })
  it('keeps a row whose account read runs ahead of the capability poll and re-reads after a real change', async () => {
    const scope = { provider: 'github', instance: 'https://github.com' }
    const viewer = { host: 'github.com', userId: '42', login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/42' }
    let capabilityRevision = 1, accountRevision = 2
    const call = vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
      const request = payload as Record<string, unknown>
      if (endpoint === 'remote-capability' && request['remoteProtocol'] !== 2) {
        return { ok: true, value: { state: 'on', remoteProtocol: 2, generation: { ...generation, revision: capabilityRevision }, auth: { state: 'anonymous' }, credential: { configured: false, writable: true }, actions, loginAvailable: false } }
      }
      if (endpoint === 'remote-accounts') return { ok: true, value: { remoteProtocol: 2, value: { accounts: [scope] } } }
      if (endpoint === 'remote-account') {
        // The account read established the credential and bumped the auth revision, so its
        // envelope is legitimately newer than the unscoped capability snapshot.
        const accountGeneration = { ...generation, revision: accountRevision }
        return { ok: true, value: { remoteProtocol: 2, scope, generation: accountGeneration, value: { ...cap({ state: 'authenticated', source: 'grant' }, viewer), generation: accountGeneration } } }
      }
      return { ok: false, error: { code: 'git/remote-unavailable' } }
    })
    const feature = new GitRemoteFeature({ call } as unknown as GitRpcClient)
    feature.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
    feature.refresh()
    render(<RemoteAccountsSettings feature={feature} t={t} />)
    await waitFor(() => expect(screen.getByText('@octocat · OAuth')).toBeTruthy())
    // A poll still reporting the older unscoped revision must not wipe the fresher row.
    feature.refresh()
    await waitFor(() => expect(call.mock.calls.filter(entry => entry[1] === 'remote-capability').length).toBeGreaterThanOrEqual(2))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.getByText('@octocat · OAuth')).toBeTruthy()
    // A genuinely newer identity (the poll moved past what the row holds) clears it, and the
    // row re-reads itself instead of sticking on Checking.
    capabilityRevision = 3; accountRevision = 3
    feature.refresh()
    await waitFor(() => expect(call.mock.calls.filter(entry => entry[1] === 'remote-account').length).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(screen.getByText('@octocat · OAuth')).toBeTruthy())
    feature.dispose()
  })
  it('shows the invalid credential status and the unavailable line when the seam is off', async () => {
    const f = fixture({ auth: { state: 'invalid' } })
    render(<RemoteAccountsSettings feature={f.feature} t={t} />)
    await waitFor(() => expect(screen.getAllByText('Credential expired. Reconnect to continue').length).toBeGreaterThan(0))
    f.feature.dispose()
    const off = fixture({ scopedAvailable: false })
    render(<RemoteAccountsSettings feature={off.feature} t={t} />)
    expect(screen.getByText('Platform accounts are unavailable on this host.')).toBeTruthy()
    off.feature.dispose()
  })
})

describe('GitBundleConfigCard platform accounts', () => {
  const controller = (state: Record<string, unknown>) => ({ getSnapshot: () => state, subscribe: () => () => {}, setMode: vi.fn(), setModel: vi.fn(), setProviderText: vi.fn(), setModelText: vi.fn(), setSystemPrompt: vi.fn(), retryCatalog: vi.fn(), save: vi.fn(), discard: vi.fn(), dispose: vi.fn() })
  const commit = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false, mode: 'inherit', provider: '', model: '', systemPrompt: '', candidates: [], catalogStatus: 'idle', catalogPartial: false }
  const worktree = { available: true, writable: true, dirty: false, saving: false, failed: false, enabled: false, directory: '' }
  it('renders the accounts section above the form save button and a summary line', async () => {
    const f = fixture({ auth: { state: 'anonymous' } })
    const { container } = render(<GitBundleConfigCard commitMessage={controller(commit) as never} worktrees={controller(worktree) as never} remoteFeature={f.feature} view="page" t={t} />)
    await waitFor(() => expect(screen.getByText('Platform accounts')).toBeTruthy())
    const heading = screen.getByText('Platform accounts')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(heading.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('section[aria-labelledby]').length).toBeGreaterThan(0)
    f.feature.dispose()
    const s = fixture()
    render(<GitBundleConfigCard commitMessage={controller(commit) as never} worktrees={controller(worktree) as never} remoteFeature={s.feature} view="summary" t={t} />)
    expect(screen.getByText('GitHub and GitLab account connections')).toBeTruthy()
    s.feature.dispose()
  })
})
