// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { GitRemoteSurface } from '../src/client/surfaces/GitRemoteSurface.tsx'
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
function mount(unknown = false) {
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
  const props = { gitSessions: sessions, remoteFeature: feature, sessionId: 's', useSessions: (selector: (value: unknown) => unknown) => selector({ byId: { s: { cwd: '/repo' } } }), t: (key: keyof typeof en) => en[key] } as unknown as ComponentProps<typeof GitRemoteSurface>
  render(<GitRemoteSurface {...props} />)
  return { call }
}
describe('portable remote surface', () => {
  it('browses PRs and requires two steps before closing the displayed commit', async () => {
    const { call } = mount()
    fireEvent.click(await screen.findByText('#1 Example PR · open'))
    await screen.findByText('Description')
    expect(screen.queryByText(en['remote.login'])).toBeNull()
    fireEvent.click(screen.getByText(en['remote.close']))
    const dialog = screen.getByRole('alertdialog')
    expect(call.mock.calls.some(args => args[1] === 'remote-close-pr')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: en['remote.confirm'] }))
    await waitFor(() => expect(call.mock.calls.filter(args => args[1] === 'remote-close-pr')).toHaveLength(1))
  })
  it('shows unknown outcomes without automatically enabling another write', async () => {
    mount(true)
    fireEvent.click(await screen.findByText('#1 Example PR · open')); await screen.findByText('Description')
    fireEvent.click(screen.getByText(en['remote.close']))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en['remote.confirm'] }))
    await screen.findByText(en['remote.unknown'])
    expect((screen.getByRole('button', { name: en['remote.comment'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})
