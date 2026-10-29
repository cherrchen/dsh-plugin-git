import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteFeature } from '../src/client/remote.ts'
import type { GitRpcClient } from '../src/client/controller.ts'

const generation = { instanceId: 'host', revision: 1 }
const scope = { provider: 'github', instance: 'https://github.com' } as const
const target = { provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo', scope } as const
const viewer = { host: 'github.com', userId: '1', login: 'alice' }
const actions = { canComment: true, canReview: true, canMerge: true, canClose: true, canCreatePr: true }
const sha = 'a'.repeat(40)
const pull = { number: 1, title: 'PR', body: '', state: 'open', rawState: 'open', head: { repository: target, ref: 'topic', sha }, base: { repository: target, ref: 'main', sha } }
const capability = { state: 'on', remoteProtocol: 2, generation, viewer, auth: { state: 'authenticated' }, credential: { configured: true, writable: true }, actions, loginAvailable: false }
const page = { items: [], truncated: false }
type Reply = { ok: boolean; value?: unknown; error?: unknown }
type Collection = 'comments' | 'inline' | 'commits' | 'reviews'
const envelope = (value: unknown): Reply => ({ ok: true, value: { remoteProtocol: 2, scope, generation, value } })
const owners: GitRemoteFeature[] = []
afterEach(() => owners.splice(0).forEach(owner => owner.dispose()))

async function fixture() {
  const paginated = new Set<Collection>()
  const pending: { collection: Collection; finish: (reply: Reply) => void }[] = []
  const call = vi.fn(async (_channel: string, endpoint: string, raw: unknown): Promise<Reply> => {
    const request = raw as Record<string, unknown>
    if (endpoint === 'remote-capability' && request['remoteProtocol'] !== 2) return { ok: true, value: capability }
    if (endpoint === 'remote-accounts') return { ok: true, value: { remoteProtocol: 2, value: { accounts: [scope] } } }
    if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }] } } }
    if (endpoint === 'remote-comment' || endpoint === 'remote-review') return { ok: false, error: { code: 'git/write-result-unknown', details: { action: endpoint.slice(7), number: 1 } } }
    const collection = endpoint === 'remote-comments' ? request['inline'] === true ? 'inline' : 'comments' : endpoint === 'remote-commits' ? 'commits' : endpoint === 'remote-reviews' ? 'reviews' : undefined
    if (collection !== undefined && paginated.has(collection)) {
      if (request['cursor'] !== undefined) return new Promise(resolve => { pending.push({ collection, finish: resolve }) })
      return envelope({ items: [], truncated: true, next: `next-${collection}` })
    }
    const facts = { viewer, actions, permissions: {}, actionScope: { path: 'owner/repo', ...(request['object'] === undefined ? {} : { object: request['object'] }) }, operationSupport: { comment: { supported: true }, review: { supported: true } }, supportedMergeMethods: [], supportedReviewEvents: ['COMMENT'] }
    return envelope(({ 'remote-capability': capability, 'remote-repository': facts, 'remote-list-prs': { ...page, items: [pull] }, 'remote-pr': pull, 'remote-comments': page, 'remote-commits': page, 'remote-reviews': page } as Record<string, unknown>)[endpoint])
  })
  const feature = new GitRemoteFeature({ call } as unknown as GitRpcClient)
  owners.push(feature)
  feature.refresh()
  await vi.waitFor(() => expect(feature.getSnapshot().state).toBe('on'))
  const controller = feature.controllerFor('s')
  controller.setRepository('/repo', false)
  await controller.load()
  await controller.open(1, 'pulls')
  return { controller, call, paginated, pending }
}

describe('GitHub scoped write reconciliation', () => {
  it.each(['comments', 'inline', 'commits', 'reviews'] as const)('waits for the refreshed %s continuation before acknowledgement', async collection => {
    const f = await fixture()
    await f.controller.write('remote-comment', { body: 'hello' })
    f.paginated.add(collection)
    await f.controller.refresh()
    await vi.waitFor(() => expect(f.pending).toHaveLength(1))
    expect(f.controller.getSnapshot()).toMatchObject({ blocked: true, reconciled: false, streaming: true })
    f.controller.acknowledgeReconciliation()
    expect(f.controller.getSnapshot().blocked).toBe(true)
    f.pending[0]!.finish(envelope(page))
    await vi.waitFor(() => expect(f.controller.getSnapshot()).toMatchObject({ blocked: true, reconciled: true, streaming: false }))
    f.controller.acknowledgeReconciliation()
    expect(f.controller.getSnapshot().blocked).toBe(false)
  })

  it.each(['remote-comment', 'remote-review'])('keeps %s blocked after comments drain while reviews remain', async endpoint => {
    const f = await fixture()
    await f.controller.write(endpoint, { body: 'hello', event: 'COMMENT' })
    f.paginated.add('comments'); f.paginated.add('reviews')
    await f.controller.refresh()
    await vi.waitFor(() => expect(f.pending).toHaveLength(1))
    f.pending[0]!.finish(envelope(page))
    await vi.waitFor(() => expect(f.pending).toHaveLength(2))
    expect(f.pending[1]!.collection).toBe('reviews')
    expect(f.controller.getSnapshot()).toMatchObject({ blocked: true, reconciled: false })
    f.pending[1]!.finish(envelope(page))
    await vi.waitFor(() => expect(f.controller.getSnapshot().reconciled).toBe(true))
  })

  it('keeps a failed continuation locked until a successful targeted refresh', async () => {
    const f = await fixture()
    await f.controller.write('remote-review', { body: 'hello', event: 'COMMENT' })
    f.paginated.add('reviews')
    await f.controller.refresh()
    await vi.waitFor(() => expect(f.pending).toHaveLength(1))
    f.pending[0]!.finish({ ok: false, error: { code: 'git/remote-unavailable' } })
    await vi.waitFor(() => expect(f.controller.getSnapshot().streamError).toBeDefined())
    f.controller.acknowledgeReconciliation()
    expect(f.controller.getSnapshot()).toMatchObject({ blocked: true, reconciled: false })
    f.paginated.clear()
    await f.controller.refresh()
    expect(f.controller.getSnapshot()).toMatchObject({ blocked: true, reconciled: true })
  })

  it('ignores the last page of a superseded reconciliation refresh', async () => {
    const f = await fixture()
    await f.controller.write('remote-comment', { body: 'hello' })
    f.paginated.add('comments')
    await f.controller.refresh()
    await vi.waitFor(() => expect(f.pending).toHaveLength(1))
    await f.controller.refresh()
    await vi.waitFor(() => expect(f.pending).toHaveLength(2))
    f.pending[0]!.finish(envelope(page))
    await Promise.resolve()
    expect(f.controller.getSnapshot()).toMatchObject({ blocked: true, reconciled: false, commentsNext: 'next-comments' })
    f.pending[1]!.finish(envelope(page))
    await vi.waitFor(() => expect(f.controller.getSnapshot().reconciled).toBe(true))
  })
})
