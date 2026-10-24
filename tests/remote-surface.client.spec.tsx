// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { GitRemoteSurface } from '../src/client/surfaces/GitRemoteSurface.tsx'
import { GitRemoteItemSurface } from '../src/client/surfaces/GitRemoteItemSurface.tsx'
import { GitRemoteFeature } from '../src/client/remote.ts'
import { GitSessionControllers } from '../src/client/session-controllers.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import { RemoteLoading } from '../src/client/remote/RemoteLoading.tsx'
const generation = { instanceId: 'host', revision: 1 }
const repo = { provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' } as const
const sha = 'a'.repeat(40)
const pull = { number: 1, title: 'Example PR', body: 'Description', author: { userId: '1', login: 'alice' }, state: 'open', rawState: 'open', head: { repository: repo, ref: 'topic', sha }, base: { repository: repo, ref: 'main', sha }, draft: false, url: 'https://github.com/owner/repo/pull/1' }
const resources: { dispose(): void }[] = []
afterEach(() => { cleanup(); resources.splice(0).forEach(resource => resource.dispose()) })
type Reply = { ok: boolean; value?: unknown; error?: unknown }
function fixture(unknown = false, handler?: (endpoint: string, payload: unknown) => Reply | undefined | Promise<Reply | undefined>) {
  const actions = { canComment: true, canReview: true, canMerge: true, canClose: true, canCreatePr: true }
  const call = vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
    const override = await handler?.(endpoint, payload)
    if (override !== undefined) return override as { ok: boolean; value?: unknown }
    let value: unknown
    if (endpoint === 'remote-capability') value = { state: 'on', generation, auth: { state: 'authenticated' }, credential: { configured: true, writable: false }, actions, loginAvailable: false }
    else if (endpoint === 'discover') value = '/repo'
    else if (endpoint === 'status') value = { root: '/repo', version: '2.43', branch: 'main', head: sha, staged: [], unstaged: [], untracked: [], branches: [] }
    else if (endpoint === 'remote-repositories') value = { state: 'supported', remotes: [{ name: 'origin', identity: repo }] }
    else if (endpoint === 'remote-repository') value = { generation, value: { viewer: { host: 'github.com', userId: '1', login: 'alice' }, permissions: { push: true }, actions } }
    else if (endpoint === 'remote-list-prs') value = { generation, value: { items: [pull], truncated: false } }
    else if (endpoint === 'remote-pr') value = { generation, value: pull }
    else if (endpoint === 'remote-comments') value = { generation, value: { items: [], truncated: false } }
    else if (endpoint === 'remote-commits' || endpoint === 'remote-reviews') value = { generation, value: { items: [], truncated: false } }
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
  it('keeps lists, selected filters and completed pages across tab unmount/remount without reads', async () => {
    const { base, call } = fixture(false, endpoint => endpoint === 'remote-list-issues'
      ? { ok: true, value: { generation, value: { items: [{ number: 2, title: 'Example issue', body: '', state: 'open', rawState: 'open', author: null }], truncated: false } } } : undefined)
    const props = { ...base, openRemoteItem: vi.fn() } as unknown as ComponentProps<typeof GitRemoteSurface>
    const first = render(<GitRemoteSurface {...props} />)
    await screen.findByRole('button', { name: /Example PR/ })
    fireEvent.click(screen.getByRole('button', { name: en['remote.issues'], exact: true }))
    await screen.findByRole('button', { name: /Example issue/ })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    first.unmount()
    const before = call.mock.calls.length
    const next = render(<GitRemoteSurface {...props} />)
    expect(screen.getByRole('button', { name: /Example issue/ })).not.toBeNull()
    await act(async () => {})
    expect(call.mock.calls).toHaveLength(before)
    fireEvent.click(screen.getByRole('button', { name: en['remote.pulls'], exact: true }))
    expect(screen.getByRole('button', { name: /Example PR/ })).not.toBeNull()
    await act(async () => {})
    expect(call.mock.calls).toHaveLength(before)
    next.unmount()
  })
  it('reuses detail on tab return, validates it when stale and honors explicit navigation refresh', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const { base, call } = fixture()
      const navigation = { address: 'dsh-resource://git-remote/owner/repo/pulls/1', params: { owner: 'owner', repo: 'repo', kind: 'pulls', number: 1 }, revision: 0 }
      const props = { ...base, useTabInfo: () => ({ tab: { navigation } }) } as unknown as ComponentProps<typeof GitRemoteItemSurface>
      const first = render(<GitRemoteItemSurface {...props} />)
      await screen.findByText('Description')
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
      first.unmount()
      const reads = () => call.mock.calls.filter(args => args[1] === 'remote-pr').length
      const before = reads()
      const second = render(<GitRemoteItemSurface {...props} />)
      expect(screen.getByText('Description')).not.toBeNull()
      await act(async () => {})
      expect(reads()).toBe(before)
      navigation.revision += 1; second.rerender(<GitRemoteItemSurface {...props} />)
      await waitFor(() => expect(reads()).toBe(before + 1))
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
      second.unmount(); now.mockReturnValue(61_001)
      render(<GitRemoteItemSurface {...props} />)
      expect(screen.getByText('Description')).not.toBeNull()
      await waitFor(() => expect(reads()).toBe(before + 2))
    } finally { now.mockRestore() }
  })
  it('shows connection feedback and skeletons without an empty-remote warning, then recovers from failure', async () => {
    let release!: (reply: Reply) => void
    const { base } = fixture(false, endpoint => endpoint === 'remote-repository' ? new Promise(resolve => { release = resolve }) : undefined)
    const { container } = render(<GitRemoteSurface {...{ ...base, openRemoteItem: vi.fn() } as unknown as ComponentProps<typeof GitRemoteSurface>} />)
    await screen.findByText(en['remote.connecting'])
    expect(container.querySelector('[data-git-remote-skeleton]')).not.toBeNull()
    expect(screen.queryByText(en['remote.noRemote'])).toBeNull()
    await act(async () => { release({ ok: false, error: { code: 'git/remote-unavailable', message: 'Connection timed out' } }) })
    await screen.findByRole('alert')
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('[data-git-remote-skeleton]')).toBeNull()
    expect((screen.getByRole('button', { name: en['details.refresh'] }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('keeps existing pulls readable with their original kind while an issue list is loading', async () => {
    let release!: (reply: Reply) => void
    const { base } = fixture(false, endpoint => endpoint === 'remote-list-issues' ? new Promise(resolve => { release = resolve }) : undefined)
    const openRemoteItem = vi.fn()
    render(<GitRemoteSurface {...{ ...base, openRemoteItem } as unknown as ComponentProps<typeof GitRemoteSurface>} />)
    await screen.findByRole('button', { name: /Example PR/ })
    fireEvent.click(screen.getByRole('button', { name: en['remote.issues'], exact: true }))
    await screen.findByText(en['remote.loadingItems'])
    fireEvent.click(screen.getByRole('button', { name: /Example PR/ }))
    expect(openRemoteItem).toHaveBeenCalledWith(repo, 'pulls', 1)
    await act(async () => { release({ ok: true, value: { generation, value: { items: [], truncated: false } } }) })
    await screen.findByText(en['remote.noItems'])
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('explains a slow connection after eight seconds and cleans up when loading ends', async () => {
    vi.useFakeTimers()
    try {
      const t = (key: keyof typeof en) => en[key]
      const view = render(<RemoteLoading pending="repository" t={t} />)
      expect(screen.queryByText(en['remote.slowConnection'])).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
      expect(screen.getByText(en['remote.slowConnection'])).not.toBeNull()
      view.rerender(<RemoteLoading t={t} />)
      expect(screen.queryByRole('status')).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      view.rerender(<RemoteLoading pending="authorization" t={t} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
      expect(screen.getByText(en['remote.waitingAuth'])).not.toBeNull()
      expect(screen.queryByText(en['remote.slowConnection'])).toBeNull()
    } finally { vi.useRealTimers() }
  })
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
  it('links to the GitHub files page and renders commit and review history without fetching diffs', async () => {
    const { base, call } = fixture(false, (endpoint, payload) => {
      if (endpoint === 'remote-commits') return { ok: true, value: { generation, value: { items: [{ sha, subject: 'Add the feature', author: { userId: '1', login: 'alice' }, date: '2024-01-01T00:00:00Z' }], truncated: false } } }
      if (endpoint === 'remote-reviews') return { ok: true, value: { generation, value: { items: [{ id: '9', author: { userId: '2', login: 'bob' }, state: 'approved', rawState: 'APPROVED', body: 'LGTM' }], truncated: false } } }
      if (endpoint === 'remote-comments') {
        const inline = (payload as { inline?: boolean }).inline === true
        return { ok: true, value: { generation, value: { items: inline ? [{ id: 'i1', body: 'line note', author: { userId: '2', login: 'bob' }, outdated: false, reviewId: '9', path: 'a.ts', line: 3 }] : [], truncated: false } } }
      }
      return undefined
    })
    const navigation = { address: 'dsh-resource://git-remote/owner/repo/pulls/1', params: { owner: 'owner', repo: 'repo', kind: 'pulls', number: 1 }, revision: 0 }
    render(<GitRemoteItemSurface {...{ ...base, useTabInfo: () => ({ tab: { navigation } }) } as unknown as ComponentProps<typeof GitRemoteItemSurface>} />)
    const files = await screen.findByRole('link', { name: new RegExp(en['remote.filesChanged']) })
    expect(files.getAttribute('href')).toBe('https://github.com/owner/repo/pull/1/files')
    await screen.findByText('Add the feature')
    await screen.findByText('LGTM')
    await screen.findByText(/a\.ts:3/)
    expect(screen.queryByRole('button', { name: en['remote.approve'] })).not.toBeNull()
    expect(call.mock.calls.some(args => args[1] === 'remote-files')).toBe(false)
  })
  it('appends streamed pages into the open list', async () => {
    const { base } = fixture(false, (endpoint, payload) => {
      if (endpoint !== 'remote-list-prs') return undefined
      const cursor = (payload as { cursor?: string }).cursor
      return {
        ok: true,
        value: {
          generation,
          value: cursor === undefined
            ? { items: [pull], truncated: true, next: '/p2' }
            : { items: [{ ...pull, number: 2, title: 'Second PR' }], truncated: false },
        },
      }
    })
    render(<GitRemoteSurface {...{ ...base, openRemoteItem: vi.fn() } as unknown as ComponentProps<typeof GitRemoteSurface>} />)
    await screen.findByRole('button', { name: /Example PR/ })
    await screen.findByRole('button', { name: /Second PR/ })
  })
})
