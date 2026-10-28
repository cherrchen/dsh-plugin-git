import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteFeature } from '../src/client/remote.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
const scope = { provider: 'gitlab', instance: 'https://git.example.com' } as const
const generation = { instanceId: 'gitlab', revision: 2 }, viewer = { host: 'git.example.com', userId: '9', login: 'alice' }, sha = 'a'.repeat(40)
const target = { provider: 'gitlab', instance: scope.instance, path: 'group/repo', scope }
const actions = { canComment: true, canReview: true, canMerge: true, canClose: true, canCreatePr: true }
const support = Object.fromEntries(['comment', 'inline-comment', 'review', 'close-pr', 'merge-pr', 'create-pr'].map(key => [key, { supported: key !== 'inline-comment' }]))
const owners: GitRemoteFeature[] = []
afterEach(() => owners.splice(0).forEach(owner => owner.dispose()))
function fixture(provider: 'gitlab' | 'github' | 'mixed' = 'gitlab') {
  const call = vi.fn(async (_channel: string, endpoint: string, payload: any) => {
    if (endpoint === 'remote-capability' && payload.remoteProtocol !== 2) return { ok: true, value: { state: 'on', remoteProtocol: 2, generation: { instanceId: 'github', revision: 1 }, auth: { state: 'anonymous' } } }
    if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: provider === 'gitlab' ? target : { provider: 'github', host: 'github.com', owner: 'o', repo: 'r', scope: { provider: 'github', instance: 'https://github.com' } } }, ...(provider === 'mixed' ? [{ name: 'upstream', identity: target }] : [])] } } }
    const values: Record<string, unknown> = {
      'remote-capability': { state: 'on', generation, auth: { state: 'authenticated' }, viewer, actions, loginAvailable: false },
      'remote-repository': { actionScope: { path: target.path, projectId: '42' }, viewer, permissions: {}, actions, operationSupport: support, supportedMergeMethods: ['merge'], supportedReviewEvents: ['COMMENT'] },
      'remote-list-prs': { items: [], truncated: false },
    }
    return { ok: true, value: { remoteProtocol: 2, scope, generation, value: values[endpoint] } }
  })
  const feature = new GitRemoteFeature({ call } as unknown as GitRpcClient); owners.push(feature); feature.refresh()
  return { feature, call }
}
describe('post-push remote suggestions', () => {
  it('binds GitLab suggestions to the verified origin project and keeps the GitHub notice list separate', async () => {
    const f = fixture(); const native = vi.fn(); f.feature.setNotify(native)
    await vi.waitFor(() => expect(f.feature.scoped.available).toBe(true))
    await f.feature.pushed('/repo', sha, 's', 'GitHub suggestion', 'origin')
    const controller = f.feature.gitlabControllerFor('s')
    await vi.waitFor(() => expect(controller.getSnapshot().notices).toHaveLength(1))
    expect(controller.getSnapshot().notices[0]).toMatchObject({ kind: 'create-pr', projectId: '42', title: sha })
    expect(f.feature.getNotices()).toEqual([]); expect(native).toHaveBeenCalledTimes(1)
    await f.feature.pushed('/repo', sha, 's', 'GitHub suggestion', 'origin')
    expect(native).toHaveBeenCalledTimes(1)
  })
  it('retains the existing GitHub suggestion for a GitHub origin', async () => {
    const f = fixture('github'); await vi.waitFor(() => expect(f.feature.scoped.available).toBe(true))
    await f.feature.pushed('/repo', sha, 's', 'GitHub suggestion', 'origin')
    expect(f.feature.getNotices()).toMatchObject([{ kind: 'create-pr', title: 'GitHub suggestion' }])
  })
  it('uses the actual upstream rather than origin for a verified sync push', async () => {
    const f = fixture('mixed'); await vi.waitFor(() => expect(f.feature.scoped.available).toBe(true))
    await f.feature.pushed('/repo', sha, 's', 'GitHub suggestion', 'upstream')
    await vi.waitFor(() => expect(f.feature.gitlabControllerFor('s').getSnapshot().notices).toHaveLength(1))
    expect(f.feature.getNotices()).toEqual([])
  })
  it('drops a pending suggestion if the session changes directory', async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.feature.scoped.available).toBe(true))
    let checks = 0; await f.feature.pushed('/repo', sha, 's', 'GitHub suggestion', 'origin', () => ++checks < 2)
    expect(f.feature.getNotices()).toEqual([]); expect(f.call.mock.calls.some(args => args[1] === 'remote-repository')).toBe(false)
  })
  it('does not attribute an ambiguous sync push to origin', async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.feature.scoped.available).toBe(true))
    await f.feature.pushed('/repo', sha, 's', 'GitHub suggestion', undefined)
    expect(f.call.mock.calls.some(args => args[1] === 'remote-repositories')).toBe(false)
    expect(f.feature.getNotices()).toEqual([])
  })
})
