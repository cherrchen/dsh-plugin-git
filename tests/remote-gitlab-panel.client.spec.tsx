// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GitLabRemotePanel } from '../src/client/remote/GitLabRemotePanel.tsx'
import { GitRemoteFeature } from '../src/client/remote.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
const scope = { provider: 'gitlab', instance: 'https://git.example.com' } as const
const generation = { instanceId: 'fixture', revision: 1 }, sha = 'a'.repeat(40)
const viewer = { host: 'git.example.com', userId: '9', login: 'alice' }
const target = { provider: 'gitlab', instance: scope.instance, path: 'team/repo', scope }
const actions = { canComment: true, canReview: true, canMerge: true, canClose: true, canCreatePr: true }
const operationSupport = { comment: { supported: true }, 'inline-comment': { supported: false }, review: { supported: true }, 'close-pr': { supported: true }, 'merge-pr': { supported: true }, 'create-pr': { supported: true } }
const owners: GitRemoteFeature[] = []
afterEach(() => { cleanup(); owners.splice(0).forEach(owner => owner.dispose()) })
function fixture(rawState = 'opened', negotiated = true) {
  const call = vi.fn(async (_channel: string, endpoint: string, payload: any) => {
    if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }] } } }
    const facts = { actionScope: { path: 'team/repo', projectId: '42', ...(payload?.object === undefined ? {} : { object: payload.object }) }, viewer, permissions: {}, actions, operationSupport, supportedMergeMethods: ['merge'], supportedReviewEvents: ['COMMENT'], reviewPermissions: { COMMENT: true, APPROVE: false, REQUEST_CHANGES: false } }
    const pull = { id: '100', number: 7, title: 'Fixture MR', body: 'Description', author: null, state: 'open', rawState, head: { projectId: '42', ref: 'feature', sha }, base: { projectId: '42', ref: 'main', sha }, draft: false }
    const page = { items: [], truncated: false }
    const values: Record<string, unknown> = { 'remote-capability': { state: 'on', generation, viewer, auth: { state: 'authenticated' }, credential: { configured: true, writable: true }, actions, loginAvailable: false, automaticRefreshAvailable: true, authMethods: { deviceFlow: { supported: true } } }, 'remote-repository': facts, 'remote-list-prs': { items: [pull], truncated: false }, 'remote-pr': pull, 'remote-comments': page, 'remote-discussions': page, 'remote-commits': page, 'remote-approvals': { approved: false, approvedBy: [] }, 'remote-files': { files: page, baseSha: sha, startSha: sha, headSha: sha, serverCompleteness: 'unknown' }, 'remote-close-pr': { outcome: 'succeeded', steps: [{ kind: 'close-pr', state: 'succeeded' }] }, 'remote-merge-pr': { outcome: 'partial', steps: [{ kind: 'merge-pr', state: 'succeeded' }, { kind: 'merge-verification', state: 'failed' }], receipt: { merged: true, error: 'merge-method-mismatch' } } }
    return { ok: true, value: { remoteProtocol: 2, scope, generation, value: values[endpoint] } }
  })
  const feature = new GitRemoteFeature({ call } as unknown as GitRpcClient); owners.push(feature)
  if (negotiated) feature.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
  const controller = feature.gitlabControllerFor('s')
  render(<GitLabRemotePanel controller={controller} repository="/repo" t={key => en[key]} />)
  return { call, controller }
}
describe('portable GitLab panel', () => {
  it('explains an old Host without making scoped calls', () => {
    const f = fixture('opened', false)
    expect(screen.getByText(en['gitlab.oldHost'])).not.toBeNull(); expect(f.call).not.toHaveBeenCalled()
  })
  it('uses actual method and review-event facts and confirms the selected identity', async () => {
    const f = fixture(); fireEvent.click(await screen.findByRole('button', { name: /Fixture MR/ }))
    await screen.findByText('Description')
    expect((screen.getByRole('button', { name: en['remote.approve'] }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: en['gitlab.squashMerge'] }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en['remote.close'] }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('https://git.example.com'); expect(dialog.textContent).toContain(sha); expect(dialog.textContent).toContain('alice')
    expect(f.call.mock.calls.some(args => args[1] === 'remote-close-pr')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: en['remote.confirm'] }))
    await waitFor(() => expect(f.call.mock.calls.filter(args => args[1] === 'remote-close-pr')).toHaveLength(1))
    expect((screen.getByRole('button', { name: en['remote.close'] }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('keeps a locked MR read-only even if stale facts claim actions are supported', async () => {
    const f = fixture('locked'); fireEvent.click(await screen.findByRole('button', { name: /Fixture MR/ }))
    await screen.findByText('Description')
    for (const name of [en['remote.comment'], en['remote.approve'], en['remote.close'], en['gitlab.directMerge'], en['remote.checkout']]) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    expect(f.call.mock.calls.some(args => args[1] === 'remote-comment')).toBe(false)
  })
  it('shows the verified merge and a localized policy mismatch while blocking another write', async () => {
    const f = fixture(); fireEvent.click(await screen.findByRole('button', { name: /Fixture MR/ }))
    await screen.findByText('Description')
    fireEvent.click(screen.getByRole('button', { name: en['gitlab.directMerge'] }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en['remote.confirm'] }))
    await screen.findByText(en['gitlab.mergeMethodMismatch'])
    expect(screen.getByText(`${en['gitlab.stepMerge']}: ${en['gitlab.succeeded']}`)).not.toBeNull()
    expect((screen.getByRole('button', { name: en['gitlab.directMerge'] }) as HTMLButtonElement).disabled).toBe(true)
    expect(f.call.mock.calls.filter(args => args[1] === 'remote-merge-pr')).toHaveLength(1)
  })
})
