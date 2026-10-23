import { describe, expect, it, vi } from 'vitest'
import { GitRemoteController, GitRemoteFeature } from '../src/client/remote.ts'
import { remoteDiff, validRange } from '../src/remote/diff.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
const generation = { instanceId: 'host', revision: 1 }
const repo = { provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' } as const
const on = { state: 'on', generation, auth: { state: 'authenticated' }, credential: { configured: true, writable: false }, actions: {}, loginAvailable: false, automaticRefreshAvailable: false }
const facts = { viewer: { host: 'github.com', userId: '1', login: 'alice' }, permissions: {}, actions: {} }
function rpc(handler?: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>) {
  const call = vi.fn(async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
    const value = await handler?.(endpoint, payload, signal)
    if (value !== undefined) return value
    if (endpoint === 'remote-capability') return { ok: true, value: on }
    if (endpoint === 'remote-repositories') return { ok: true, value: { state: 'supported', remotes: [{ name: 'origin', identity: repo }] } }
    if (endpoint === 'remote-repository') return { ok: true, value: { generation, value: facts } }
    return { ok: true, value: { generation, value: { items: [], truncated: false } } }
  })
  return { call } as GitRpcClient & { call: typeof call }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const item = (number: number) => ({ number, title: `Item ${number}`, body: '', state: 'open' as const, rawState: 'open', author: null })
describe('remote client lifecycle', () => {
  it('aborts an old workspace and ignores a reply delivered after rebinding', async () => {
    let release: ((value: unknown) => void) | undefined
    let signal: AbortSignal | undefined
    const transport = rpc(async (endpoint, payload, sig) => {
      if (endpoint === 'remote-repositories' && (payload as { repository: string }).repository === '/old') { signal = sig; return new Promise(resolve => { release = resolve }) }
    })
    const feature = new GitRemoteFeature(transport); feature.refresh(); await tick()
    const controller = new GitRemoteController(feature, 'session')
    controller.setRepository('/old'); await tick()
    controller.setRepository('/new'); await tick()
    release?.({ ok: true, value: { state: 'supported', remotes: [{ name: 'origin', identity: { ...repo, owner: 'stale' } }] } }); await tick()
    expect(signal?.aborted).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ repository: '/new', target: repo })
    controller.dispose(); feature.dispose()
  })
  it('clears data and cancels on off or changed generation; teardown stops polling', async () => {
    vi.useFakeTimers()
    try {
      let capability: unknown = on
      const transport = rpc(async endpoint => endpoint === 'remote-capability' ? { ok: true, value: capability } : undefined)
      const feature = new GitRemoteFeature(transport); feature.start(); await vi.advanceTimersByTimeAsync(0)
      const controller = new GitRemoteController(feature)
      controller.setRepository('/repo'); await vi.advanceTimersByTimeAsync(0)
      expect(controller.getSnapshot().facts).toEqual(facts)
      capability = { state: 'off', auth: { state: 'off' }, reason: 'credentials-missing' }
      feature.refresh(); await vi.advanceTimersByTimeAsync(0)
      expect(controller.getSnapshot().facts).toBeUndefined()
      controller.dispose(); feature.dispose()
      const count = transport.call.mock.calls.length
      await vi.advanceTimersByTimeAsync(30000)
      expect(transport.call).toHaveBeenCalledTimes(count)
    } finally { vi.useRealTimers() }
  })
  it('binds writes to stable viewer and generation, blocks duplicate clicks and unknown retries', async () => {
    let release: ((value: unknown) => void) | undefined
    const transport = rpc(async endpoint => endpoint === 'remote-comment' ? new Promise(resolve => { release = resolve }) : undefined)
    const feature = new GitRemoteFeature(transport); feature.refresh(); await tick()
    const controller = new GitRemoteController(feature, 'session')
    controller.setRepository('/repo'); await tick()
    const first = controller.write('remote-comment', { number: 1, body: 'hi' })
    await controller.write('remote-comment', { number: 1, body: 'hi' })
    const writes = transport.call.mock.calls.filter(call => call[1] === 'remote-comment')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[2]).toMatchObject({ expectedGeneration: generation, expectedViewer: facts.viewer, repository: '/repo', sessionId: 'session' })
    release?.({ ok: false, error: { code: 'git/write-result-unknown', message: 'Unknown result' } }); await first
    await controller.write('remote-comment', { number: 1, body: 'hi' })
    expect(controller.getSnapshot().unknown).toBe(true)
    expect(transport.call.mock.calls.filter(call => call[1] === 'remote-comment')).toHaveLength(1)
    await controller.load()
    expect(controller.getSnapshot().unknown).toBe(false)
    controller.dispose(); feature.dispose()
  })
})
describe('remote progressive lists', () => {
  it('streams remaining pages in the background and deduplicates by number', async () => {
    const transport = rpc(async (endpoint, payload) => {
      if (endpoint === 'remote-list-prs') {
        const cursor = (payload as { cursor?: string }).cursor
        return {
          ok: true as const,
          value: {
            generation,
            value: cursor === undefined
              ? { items: [item(1)], truncated: true, next: '/p2' }
              : { items: [item(1), item(2)], truncated: false },
          },
        }
      }
      return undefined
    })
    const feature = new GitRemoteFeature(transport); feature.refresh(); await tick()
    const controller = new GitRemoteController(feature, 'session')
    controller.setRepository('/repo')
    await vi.waitFor(() => { expect(controller.getSnapshot().items.map(entry => entry.number)).toEqual([1, 2]) })
    expect(controller.getSnapshot().itemsNext).toBeUndefined()
    expect(controller.getSnapshot().streaming).toBe(false)
    const pages = transport.call.mock.calls.filter(call => call[1] === 'remote-list-prs')
    expect(pages).toHaveLength(2)
    expect(pages[0]?.[2]).toMatchObject({ pages: 1 })
    expect(pages[1]?.[2]).toMatchObject({ cursor: '/p2' })
    controller.dispose(); feature.dispose()
  })
  it('streams comment, inline, commit and review pages for the open detail', async () => {
    const head = { repository: repo, ref: 'topic', sha: 'a'.repeat(40) }
    const base = { repository: repo, ref: 'main', sha: 'a'.repeat(40) }
    const detail = { ...item(1), head, base, draft: false }
    const paged = (request: { cursor?: string }, first: unknown[], rest: unknown[], next: string) =>
      request.cursor === undefined
        ? { items: first, truncated: true, next }
        : { items: rest, truncated: false }
    const transport = rpc(async (endpoint, payload) => {
      if (endpoint === 'remote-pr') return { ok: true as const, value: { generation, value: detail } }
      if (endpoint === 'remote-comments') {
        const request = payload as { cursor?: string; inline?: boolean }
        const page = request.inline === true
          ? paged(request, [{ id: 'i1', body: 'inline one', author: null, outdated: false, reviewId: '7', path: 'a.ts', line: 3 }], [{ id: 'i1', body: 'inline one', author: null, outdated: false, reviewId: '7' }, { id: 'i2', body: 'inline two', author: null, outdated: false, reviewId: '7' }], '/i2')
          : paged(request, [{ id: '1', body: 'one', author: null, outdated: false }], [{ id: '2', body: 'two', author: null, outdated: false }], '/c2')
        return { ok: true as const, value: { generation, value: page } }
      }
      if (endpoint === 'remote-commits') {
        const request = payload as { cursor?: string }
        return { ok: true as const, value: { generation, value: paged(request, [{ sha: 'c'.repeat(40), subject: 'one', author: null }], [{ sha: 'c'.repeat(40), subject: 'one', author: null }, { sha: 'd'.repeat(40), subject: 'two', author: null }], '/k2') } }
      }
      if (endpoint === 'remote-reviews') {
        const request = payload as { cursor?: string }
        return { ok: true as const, value: { generation, value: paged(request, [{ id: '7', author: null, state: 'approved', rawState: 'APPROVED', body: 'ok' }], [{ id: '8', author: null, state: 'commented', rawState: 'COMMENTED', body: 'note' }], '/r2') } }
      }
      return undefined
    })
    const feature = new GitRemoteFeature(transport); feature.refresh(); await tick()
    const controller = new GitRemoteController(feature, 'session')
    controller.setRepository('/repo')
    await vi.waitFor(() => { expect(controller.getSnapshot().target).toBeDefined() })
    await controller.open(1, 'pulls')
    await vi.waitFor(() => {
      const snapshot = controller.getSnapshot()
      expect(snapshot.comments.map(comment => comment.id)).toEqual(['1', '2'])
      expect(snapshot.inline.map(comment => comment.id)).toEqual(['i1', 'i2'])
      expect(snapshot.commits.map(entry => entry.sha)).toEqual(['c'.repeat(40), 'd'.repeat(40)])
      expect(snapshot.reviews.map(entry => entry.id)).toEqual(['7', '8'])
    })
    expect(transport.call.mock.calls.filter(call => call[1] === 'remote-files')).toHaveLength(0)
    expect(controller.getSnapshot().streaming).toBe(false)
    controller.dispose(); feature.dispose()
  })
  it('stops the stream on error and resumes once after a bounded rate-limit reset', async () => {
    vi.useFakeTimers()
    try {
      let resumed = 0
      const transport = rpc(async (endpoint, payload) => {
        if (endpoint === 'remote-list-prs') {
          const cursor = (payload as { cursor?: string }).cursor
          if (cursor === undefined) return { ok: true as const, value: { generation, value: { items: [item(1)], truncated: true, next: '/p2' } } }
          resumed += 1
          if (resumed === 1) return { ok: false as const, error: { code: 'git/rate-limited', message: 'slow down', details: { resetAt: Date.now() + 60_000 } } }
          return { ok: true as const, value: { generation, value: { items: [item(2)], truncated: false } } }
        }
        return undefined
      })
      const feature = new GitRemoteFeature(transport); feature.refresh(); await vi.advanceTimersByTimeAsync(0)
      const controller = new GitRemoteController(feature, 'session')
      controller.setRepository('/repo')
      for (let i = 0; i < 10 && controller.getSnapshot().streamError === undefined; i += 1) await vi.advanceTimersByTimeAsync(0)
      expect(controller.getSnapshot().streamError).toBe('slow down')
      expect(controller.getSnapshot().streaming).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      for (let i = 0; i < 10 && controller.getSnapshot().items.length < 2; i += 1) await vi.advanceTimersByTimeAsync(0)
      expect(controller.getSnapshot().items.map(entry => entry.number)).toEqual([1, 2])
      expect(controller.getSnapshot().streamError).toBeUndefined()
      controller.dispose(); feature.dispose()
    } finally { vi.useRealTimers() }
  })
})
describe('safe diff anchors', () => {
  it('keeps original old/new lines and prevents ranges across hunks or sides', () => {
    const diff = remoteDiff({ path: 'file', status: 'modified', additions: 1, deletions: 1, patch: '@@ -2,2 +2,2 @@\n-old\n+new\n same\n@@ -20,1 +20,1 @@\n tail' }, 'base', 'head')
    expect(diff.safe).toBe(true)
    const removed = diff.lines[1]?.anchor!; const added = diff.lines[2]?.anchor!; const context = diff.lines[3]?.anchor!; const last = diff.lines[5]?.anchor!
    expect(removed).toMatchObject({ line: 2, side: 'LEFT', commitSha: 'head' })
    expect(added).toMatchObject({ line: 2, side: 'RIGHT' })
    expect(validRange(added, context)).toBe(true)
    expect(validRange(removed, added)).toBe(false)
    expect(validRange(added, last)).toBe(false)
  })
  it.each(['renamed', 'removed', 'modified'])('disables ambiguous or truncated %s patches', status => {
    const diff = remoteDiff({ path: 'file', status, additions: 3, deletions: 1, patch: '@@ -1 +1,3 @@\n-old\n+new' }, 'base', 'head')
    expect(diff.safe).toBe(false)
    expect(diff.lines.every(line => line.anchor === undefined)).toBe(true)
  })
})

describe('remote notification enhancement', () => {
  it('deduplicates by event id and keeps portable notices after native unload', async () => {
    const transport = rpc()
    const feature = new GitRemoteFeature(transport); feature.refresh(); await tick()
    const show = vi.fn(async () => {})
    feature.setNotify(show)
    const notice = { id: 'event-1', kind: 'merged', title: 'Merged PR' } as const
    feature.ingest([notice, notice]); await tick()
    expect(show).toHaveBeenCalledTimes(1)
    feature.setNotify(undefined)
    feature.ingest([{ ...notice, id: 'event-2' }])
    expect(feature.getNotices()).toHaveLength(2)
    expect(show).toHaveBeenCalledTimes(1)
    feature.dispose()
  })
})
