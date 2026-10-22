// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { GitRemoteSurface } from '../src/client/surfaces/GitRemoteSurface.tsx'
import { GitRemoteItemSurface } from '../src/client/surfaces/GitRemoteItemSurface.tsx'
import { GitRemoteFeature } from '../src/client/remote.ts'
import { GitSessionControllers } from '../src/client/session-controllers.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
const generation = { instanceId: 'host', revision: 1 }
const repo = { provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' } as const
const sha = 'a'.repeat(40)
const pull = { number: 1, title: 'Example PR', body: 'Description', author: { userId: '1', login: 'alice' }, state: 'open', rawState: 'open', head: { repository: repo, ref: 'topic', sha }, base: { repository: repo, ref: 'main', sha }, draft: false }
const resources: { dispose(): void }[] = []
afterEach(() => { cleanup(); resources.splice(0).forEach(resource => resource.dispose()) })
function fixture(unknown = false) {
  const actions = { canComment: true, canReview: true, canMerge: true, canClose: true, canCreatePr: true }
  const call = vi.fn(async (_channel: string, endpoint: string) => {
    let value: unknown
    if (endpoint === 'remote-capability') value = { state: 'on', generation, auth: { state: 'authenticated' }, credential: { configured: true, writable: false }, actions, loginAvailable: false }
    else if (endpoint === 'discover') value = '/repo'
    else if (endpoint === 'status') value = { root: '/repo', version: '2.43', branch: 'main', head: sha, staged: [], unstaged: [], untracked: [], branches: [] }
    else if (endpoint === 'remote-repositories') value = { state: 'supported', remotes: [{ name: 'origin', identity: repo }] }
    else if (endpoint === 'remote-repository') value = { generation, value: { viewer: { host: 'github.com', userId: '1', login: 'alice' }, permissions: { push: true }, actions } }
    else if (endpoint === 'remote-list-prs') value = { generation, value: { items: [pull], truncated: false } }
    else if (endpoint === 'remote-pr') value = { generation, value: pull }
    else if (endpoint === 'remote-comments') value = { generation, value: { items: [], truncated: false } }
    else if (endpoint === 'remote-files') value = { generation, value: { baseSha: sha, headSha: sha, files: { items: [{ path: 'file', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }], truncated: false } } }
    else if (endpoint === 'remote-close-pr' && unknown) return { ok: false, error: { code: 'git/write-result-unknown', message: 'Unknown result' } }
    else value = {}
    return { ok: true, value }
  })
  const rpc = { call } as GitRpcClient
  const feature = new GitRemoteFeature(rpc); resources.push(feature); feature.refresh()
  const sessions = new GitSessionControllers(rpc); resources.push(sessions)
  const base = { gitSessions: sessions, remoteFeature: feature, sessionId: 's', useSessions: (selector: (value: unknown) => unknown) => selector({ byId: { s: { cwd: '/repo' } } }), t: (key: keyof typeof en) => en[key] }
  return { call, base }
}
function mountList() {
  const { call, base } = fixture()
  const openRemoteItem = vi.fn()
  render(<GitRemoteSurface {...{ ...base, openRemoteItem } as unknown as ComponentProps<typeof GitRemoteSurface>} />)
  return { call, openRemoteItem }
}
function mountItem(unknown = false) {
  const { call, base } = fixture(unknown)
  const navigation = { address: 'dsh-resource://git-remote/owner/repo/pulls/1', params: { owner: 'owner', repo: 'repo', kind: 'pulls', number: 1 }, revision: 0 }
  const props = { ...base, useTabInfo: () => ({ tab: { navigation } }) } as unknown as ComponentProps<typeof GitRemoteItemSurface>
  render(<GitRemoteItemSurface {...props} />)
  return { call }
}
describe('portable remote surface', () => {
  it('opens a pull request detail tab from the list row', async () => {
    const { openRemoteItem } = mountList()
    fireEvent.click(await screen.findByRole('button', { name: /Example PR/ }))
    expect(openRemoteItem).toHaveBeenCalledWith(repo, 'pulls', 1)
  })
  it('requires two steps before closing the displayed commit', async () => {
    const { call } = mountItem()
    await screen.findByText('Description')
    fireEvent.click(screen.getByRole('button', { name: en['remote.close'] }))
    const dialog = screen.getByRole('alertdialog')
    expect(call.mock.calls.some(args => args[1] === 'remote-close-pr')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: en['remote.confirm'] }))
    await waitFor(() => expect(call.mock.calls.filter(args => args[1] === 'remote-close-pr')).toHaveLength(1))
  })
  it('shows unknown outcomes without automatically enabling another write', async () => {
    mountItem(true)
    await screen.findByText('Description')
    fireEvent.click(screen.getByRole('button', { name: en['remote.close'] }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en['remote.confirm'] }))
    await screen.findByText(en['remote.unknown'])
    expect((screen.getByRole('button', { name: en['remote.comment'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})
