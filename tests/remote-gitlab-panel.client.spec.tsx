// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { GitRemoteItemSurface } from '../src/client/surfaces/GitRemoteItemSurface.tsx'
import { GitRemoteSurface } from '../src/client/surfaces/GitRemoteSurface.tsx'
import { GitRemoteFeature } from '../src/client/remote.ts'
import { GitSessionControllers } from '../src/client/session-controllers.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
const scope = { provider: 'gitlab', instance: 'https://git.example.com' } as const
const generation = { instanceId: 'fixture', revision: 1 }, sha = 'a'.repeat(40)
const viewer = { host: 'git.example.com', userId: '9', login: 'alice' }
const target = { provider: 'gitlab', instance: scope.instance, path: 'team/repo', scope }
const actions = { canComment: true, canReview: true, canMerge: true, canClose: true, canCreatePr: true }
const operationSupport = { comment: { supported: true }, 'inline-comment': { supported: false }, review: { supported: true }, 'close-pr': { supported: true }, 'merge-pr': { supported: true }, 'create-pr': { supported: true } }
const navigation = {
  address: `dsh-resource://git-remote/gitlab/${encodeURIComponent(scope.instance)}/${encodeURIComponent('team/repo')}/pulls/7`,
  params: { provider: 'gitlab', instance: scope.instance, path: 'team/repo', kind: 'pulls', number: 7 },
  revision: 0,
}
const resources: { dispose(): void }[] = []
afterEach(() => { cleanup(); resources.splice(0).forEach(resource => resource.dispose()) })
function fixture(rawState = 'opened') {
  const call = vi.fn(async (_channel: string, endpoint: string, payload: any) => {
    if (endpoint === 'remote-capability' && payload?.remoteProtocol !== 2) return { ok: true, value: { state: 'on', remoteProtocol: 2, generation, auth: { state: 'authenticated' }, credential: { configured: true, writable: true }, actions, loginAvailable: false } }
    if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }] } } }
    if (endpoint === 'discover') return { ok: true, value: '/repo' }
    if (endpoint === 'status') return { ok: true, value: { root: '/repo', version: '2.43', branch: 'main', head: sha, staged: [], unstaged: [], untracked: [], branches: [] } }
    const facts = { actionScope: { path: 'team/repo', projectId: '42', ...(payload?.object === undefined ? {} : { object: payload.object }) }, viewer, permissions: {}, actions, operationSupport, supportedMergeMethods: ['merge'], supportedReviewEvents: ['COMMENT'], reviewPermissions: { COMMENT: true, APPROVE: false, REQUEST_CHANGES: false } }
    const pull = { id: '100', number: 7, title: 'Fixture MR', body: 'Description', author: null, state: 'open', rawState, head: { projectId: '42', ref: 'feature', sha }, base: { projectId: '42', ref: 'main', sha }, draft: false }
    const page = { items: [], truncated: false }
    const values: Record<string, unknown> = { 'remote-capability': { state: 'on', generation, viewer, auth: { state: 'authenticated' }, credential: { configured: true, writable: true }, actions, loginAvailable: false, automaticRefreshAvailable: true, authMethods: { deviceFlow: { supported: true } } }, 'remote-repository': facts, 'remote-list-prs': { items: [pull], truncated: false }, 'remote-pr': pull, 'remote-comments': page, 'remote-discussions': page, 'remote-commits': page, 'remote-approvals': { approved: false, approvedBy: [] }, 'remote-close-pr': { outcome: 'succeeded', steps: [{ kind: 'close-pr', state: 'succeeded' }] }, 'remote-merge-pr': { outcome: 'partial', steps: [{ kind: 'merge-pr', state: 'succeeded' }, { kind: 'merge-verification', state: 'failed' }], receipt: { merged: true, error: 'merge-method-mismatch' } } }
    return { ok: true, value: { remoteProtocol: 2, scope, generation, value: values[endpoint] } }
  })
  const rpc = { call } as unknown as GitRpcClient
  const feature = new GitRemoteFeature(rpc); resources.push(feature); feature.refresh()
  const sessions = new GitSessionControllers(rpc); resources.push(sessions)
  const base = { gitSessions: sessions, remoteFeature: feature, sessionId: 's', useSessions: (selector: (value: unknown) => unknown) => selector({ byId: { s: { cwd: '/repo' } } }), t: (key: keyof typeof en) => en[key] }
  return { call, feature, base }
}
function mountItem(base: ReturnType<typeof fixture>['base']) {
  const props = { ...base, useTabInfo: () => ({ tab: { navigation } }) } as unknown as ComponentProps<typeof GitRemoteItemSurface>
  render(<GitRemoteItemSurface {...props} />)
}
describe('GitLab remote detail on the shared surfaces', () => {
  it('keeps notification coverage inside platform authentication and explains unavailable OAuth', async () => {
    const f = fixture()
    render(<GitRemoteSurface {...{ ...f.base, openRemoteItem: vi.fn() } as unknown as ComponentProps<typeof GitRemoteSurface>} />)
    await screen.findByRole('button', { name: /Fixture MR/ })
    expect(screen.queryByText(en['gitlab.noticeLimit'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['remote.auth'], exact: true }))
    const dialog = within(screen.getByRole('dialog', { name: en['remote.auth'] }))
    expect(dialog.getByText(en['gitlab.noticeLimit'])).not.toBeNull()
    expect(dialog.getByText('Connected to GitLab')).not.toBeNull()
    expect(dialog.getByRole('radio', { name: en['remote.authSourceGlab'] })).not.toBeNull()
    expect((dialog.getByRole('radio', { name: 'GitLab OAuth (device login)' }) as HTMLInputElement).disabled).toBe(true)
    expect(dialog.getByText(en['remote.oauthNotConfigured'])).not.toBeNull()
    expect(screen.getByRole('dialog').textContent).not.toMatch(/GitHub|GH_TOKEN|GITHUB_TOKEN/)
  })
  it('uses actual method and review-event facts and confirms the selected identity', async () => {
    const f = fixture()
    mountItem(f.base)
    await screen.findByText('Description')
    expect(screen.queryByRole('button', { name: en['remote.approve'] })).toBeNull()
    expect((screen.getByRole('button', { name: en['remote.merge'] }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en['remote.close'] }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain(sha.slice(0, 12)); expect(dialog.textContent).toContain('alice')
    expect(f.call.mock.calls.some(args => args[1] === 'remote-close-pr')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: en['remote.confirm'] }))
    await waitFor(() => expect(f.call.mock.calls.filter(args => args[1] === 'remote-close-pr')).toHaveLength(1))
    expect((screen.getByRole('button', { name: en['remote.close'] }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('keeps a locked MR read-only even if stale facts claim actions are supported', async () => {
    const f = fixture('locked')
    mountItem(f.base)
    await screen.findByText('Description')
    for (const name of [en['remote.comment'], en['remote.close'], en['remote.merge'], en['remote.checkout']]) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    expect(f.call.mock.calls.some(args => args[1] === 'remote-comment')).toBe(false)
  })
  it('shows the verified merge and a localized policy mismatch while blocking another write', async () => {
    const f = fixture()
    mountItem(f.base)
    await screen.findByText('Description')
    fireEvent.click(screen.getByRole('button', { name: en['remote.merge'] }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en['remote.confirm'] }))
    await screen.findByText(en['gitlab.mergeMethodMismatch'])
    expect(screen.getByText(`${en['gitlab.stepMerge']}: ${en['gitlab.succeeded']}`)).not.toBeNull()
    expect((screen.getByRole('button', { name: en['remote.merge'] }) as HTMLButtonElement).disabled).toBe(true)
    expect(f.call.mock.calls.filter(args => args[1] === 'remote-merge-pr')).toHaveLength(1)
  })
  it('lists merge requests on the unified list surface and reports unresolved remotes', async () => {
    const f = fixture()
    const openRemoteItem = vi.fn()
    render(<GitRemoteSurface {...{ ...f.base, openRemoteItem } as unknown as ComponentProps<typeof GitRemoteSurface>} />)
    fireEvent.click(await screen.findByRole('button', { name: /Fixture MR/ }))
    expect(openRemoteItem).toHaveBeenCalledWith({ ...target, projectId: '42' }, 'pulls', 7)
    expect(screen.getByRole('button', { name: en['gitlab.mergeRequests'], exact: true })).not.toBeNull()
  })
})
