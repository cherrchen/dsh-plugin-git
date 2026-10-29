import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteFeature } from '../src/client/remote.ts'
import type { GitRpcClient } from '../src/client/controller.ts'
const scope = { provider: 'gitlab', instance: 'https://git.example.com' } as const
const generation = { instanceId: 'instance', revision: 4 }
const sha = 'a'.repeat(40), laterSha = 'b'.repeat(40)
const viewer = { host: 'git.example.com', userId: '9', login: 'alice' }
const target = { provider: 'gitlab', instance: scope.instance, path: 'group/sub/repo', scope } as const
const actions = { canComment: true, canReview: true, canMerge: true, canClose: true, canCreatePr: true }
const support = Object.fromEntries(['comment', 'inline-comment', 'review', 'close-pr', 'merge-pr', 'create-pr'].map(name => [name, { supported: name !== 'inline-comment' }]))
const pull = { id: '99', number: 7, title: 'Example MR', body: 'Body', state: 'open', rawState: 'opened', author: null, draft: false, head: { projectId: '12', ref: 'topic', sha }, base: { projectId: '12', ref: 'main', sha }, url: 'https://git.example.com/group/sub/repo/-/merge_requests/7' }
type Reply = { ok: boolean; value?: unknown; error?: unknown }
type Override = (endpoint: string, payload: Record<string, unknown>) => Reply | Promise<Reply | undefined> | undefined
const owners: GitRemoteFeature[] = []
afterEach(() => owners.splice(0).forEach(owner => owner.dispose()))
function fixture(override?: Override, negotiated = true) {
  const call = vi.fn(async (_channel: string, endpoint: string, raw: unknown): Promise<Reply> => {
    const payload = raw as Record<string, unknown>, custom = payload?.['remoteProtocol'] === 2 ? await override?.(endpoint, payload) : undefined
    if (custom !== undefined) return custom
    if (endpoint === 'remote-capability' && payload?.['remoteProtocol'] !== 2) return { ok: true, value: { state: 'on', remoteProtocol: 2, generation, auth: { state: 'authenticated' }, credential: { configured: true, writable: true }, actions, loginAvailable: false } }
    if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }] } } }
    const object = payload?.['object']
    const facts = { actionScope: { path: target.path, projectId: '12', ...(object === undefined ? {} : { object }) }, viewer, permissions: { push: true }, actions, operationSupport: support, supportedMergeMethods: ['merge', 'squash'], supportedReviewEvents: ['COMMENT', 'APPROVE'], reviewPermissions: { COMMENT: true, APPROVE: true, REQUEST_CHANGES: false } }
    const page = { items: [], truncated: false }
    const values: Record<string, unknown> = {
      'remote-capability': { state: 'on', generation, viewer, auth: { state: 'authenticated' }, credential: { configured: true, writable: true }, actions, loginAvailable: false, automaticRefreshAvailable: true, authMethods: { deviceFlow: { supported: true } } },
      'remote-repository': facts, 'remote-list-prs': { items: [pull], truncated: false }, 'remote-list-issues': page, 'remote-pr': pull, 'remote-comments': page, 'remote-discussions': page, 'remote-commits': page,
      'remote-approvals': { approved: false, userCanApprove: true, approvedBy: [] }, 'remote-files': { files: page, baseSha: sha, startSha: sha, headSha: sha, serverCompleteness: 'unknown' },
      'remote-close-pr': { outcome: 'succeeded', steps: [{ kind: 'close-pr', state: 'succeeded' }] }, 'remote-merge-pr': { outcome: 'succeeded', steps: [{ kind: 'merge-pr', state: 'succeeded' }] }, 'remote-review': { outcome: 'succeeded', steps: [{ kind: 'approve', state: 'succeeded' }] },
    }
    return { ok: true, value: { remoteProtocol: 2, scope, generation, value: values[endpoint] } }
  })
  const feature = new GitRemoteFeature({ call } as unknown as GitRpcClient); owners.push(feature)
  if (negotiated) feature.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
  const controller = feature.controllerFor('session')
  return { call, feature, controller }
}
async function ready(controller: ReturnType<typeof fixture>['controller']) {
  controller.setRepository('/repo')
  await vi.waitFor(() => expect(controller.getSnapshot().items).toHaveLength(1))
  await controller.open(7, 'pulls')
  expect(controller.getSnapshot().detail?.number).toBe(7)
}
describe('GitLab scoped controller', () => {
  it('executes clear-grant before retry when switching an OAuth grant back to CLI discovery', async () => {
    const f = fixture()
    await ready(f.controller)
    f.call.mockClear()
    await f.controller.authAction('remote-clear-grant', 'remote-retry-auth')
    const endpoints = f.call.mock.calls.map(args => args[1])
    expect(endpoints.slice(0, 2)).toEqual(['remote-clear-grant', 'remote-retry-auth'])
    expect(f.controller.getSnapshot().error).toBeUndefined()
  })
  describe.each(['pulls', 'issues'] as const)('%s target changes', kind => {
    it.each(['pagination', 'failure'] as const)('clears the previous target rows before %s on an uncached target', async mode => {
      const other = { ...target, path: 'group/other' }
      const oldItem = kind === 'pulls' ? pull : { number: 7, title: 'Old issue', state: 'open' }
      const newItem = { ...oldItem, number: 8, title: 'New repository item' }
      const envelope = (value: unknown): Reply => ({ ok: true, value: { remoteProtocol: 2, scope, generation, value } })
      let finishList!: (reply: Reply) => void, finishPage!: (reply: Reply) => void
      const f = fixture((endpoint, payload) => {
        if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }, { name: 'upstream', identity: other }] } } }
        if (endpoint === 'remote-repository') return envelope({ actionScope: { path: payload['path'], projectId: '12' }, viewer, actions })
        if (endpoint === (kind === 'pulls' ? 'remote-list-prs' : 'remote-list-issues')) {
          if (payload['path'] === target.path) return envelope({ items: [oldItem], truncated: false })
          return new Promise<Reply>(resolve => { if (payload['cursor'] === undefined) finishList = resolve; else finishPage = resolve })
        }
        return undefined
      })
      f.controller.setRepository('/repo', false)
      await f.controller.load(kind, target)
      expect(f.controller.getSnapshot().items.map(item => item.number)).toEqual([7])
      const switching = f.controller.load(kind, other)
      await vi.waitFor(() => expect(finishList).toBeDefined())
      expect(f.controller.getSnapshot()).toMatchObject({ target: other, items: [], itemsNext: undefined })
      if (mode === 'failure') {
        finishList({ ok: false, error: { code: 'git/remote-unavailable', details: { reason: 'fixture-failure' } } })
        await switching
        expect(f.controller.getSnapshot()).toMatchObject({ items: [], error: 'git/remote-unavailable' })
      } else {
        finishList(envelope({ items: [newItem], truncated: true, next: 'next-page' }))
        await switching
        await vi.waitFor(() => expect(finishPage).toBeDefined())
        expect(f.controller.getSnapshot().items.map(item => item.number)).toEqual([8])
        finishPage(envelope({ items: [], truncated: false }))
        await vi.waitFor(() => expect(f.controller.getSnapshot().streaming).toBe(false))
        expect(f.controller.getSnapshot().items.map(item => item.number)).toEqual([8])
      }
      await f.controller.ensureList(kind, target)
      expect(f.controller.getSnapshot()).toMatchObject({ target, items: [oldItem] })
    })
  })
  it('skips notification polling during device authorization and reloads after successful login', async () => {
    const envelope = (value: unknown): Reply => ({ ok: true, value: { remoteProtocol: 2, scope, generation, value } })
    let finishLogin!: (reply: Reply) => void
    const f = fixture(endpoint => {
      if (endpoint === 'remote-capability') return envelope({ state: 'on', generation, viewer, auth: { state: 'authenticated' }, actions, loginAvailable: true })
      if (endpoint === 'remote-login') return envelope({ attemptId: 'attempt', userCode: 'CODE', verificationUri: `${scope.instance}/oauth/device` })
      if (endpoint === 'remote-poll-login') return new Promise<Reply>(resolve => { finishLogin = resolve })
      return undefined
    })
    await ready(f.controller)
    await f.controller.login()
    expect(f.controller.getSnapshot()).toMatchObject({ busy: false, login: { attemptId: 'attempt' } })
    const callsBeforePoll = f.call.mock.calls.length
    await f.controller.pollNotices()
    expect(f.call.mock.calls).toHaveLength(callsBeforePoll)
    finishLogin(envelope({ state: 'authenticated' }))
    await vi.waitFor(() => expect(f.call.mock.calls.some(call => call[1] === 'remote-retry-auth')).toBe(true))
    await vi.waitFor(() => expect(f.controller.getSnapshot()).toMatchObject({ busy: false, login: undefined, error: undefined, items: [pull] }))
  })
  it.each(['remote-pr', 'remote-comment'] as const)('signs out of the original scope while %s is in flight and ignores its late response', async endpoint => {
    let pending = false, finish!: (reply: Reply) => void, signedOut = false
    const envelope = (value: unknown): Reply => ({ ok: true, value: { remoteProtocol: 2, scope, generation, value } })
    const f = fixture(name => {
      if (name === endpoint && pending) return new Promise<Reply>(resolve => { finish = resolve })
      if (name === 'remote-sign-out') { signedOut = true; return envelope(null) }
      if (name === 'remote-capability' && signedOut) return envelope({ state: 'on', generation, auth: { state: 'signed-out' }, actions, loginAvailable: true })
      return undefined
    })
    await ready(f.controller)
    pending = true
    const operation = endpoint === 'remote-pr' ? f.controller.open(7, 'pulls') : f.controller.write(endpoint, { body: 'Comment' })
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(f.controller.getSnapshot().busy).toBe(true)
    await f.controller.authAction('remote-sign-out')
    expect(f.call.mock.calls.filter(call => call[1] === 'remote-sign-out').map(call => call[2])).toEqual([expect.objectContaining({ remoteProtocol: 2, provider: 'gitlab', instance: scope.instance, path: target.path, projectId: '12', repository: '/repo', sessionId: 'session' })])
    expect(f.controller.getSnapshot()).toMatchObject({ target, scopedCapability: { auth: { state: 'signed-out' } }, busy: false, detail: undefined, items: [], error: undefined })
    finish(envelope(endpoint === 'remote-pr' ? pull : { outcome: 'succeeded', steps: [] }))
    await operation
    expect(f.controller.getSnapshot()).toMatchObject({ scopedCapability: { auth: { state: 'signed-out' } }, busy: false, detail: undefined, items: [], error: undefined })
  })
  it('keeps a new login usable while old cancellation on the same instance is still pending', async () => {
    const other = { ...target, path: 'group/other' }
    let releaseCancel!: (reply: Reply) => void, finishLogin!: (reply: Reply) => void, attempt = 0
    const envelope = (value: unknown): Reply => ({ ok: true, value: { remoteProtocol: 2, scope, generation, value } })
    const f = fixture((endpoint, payload) => {
      if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }, { name: 'upstream', identity: other }] } } }
      if (endpoint === 'remote-capability') return envelope({ state: 'on', generation, viewer, auth: { state: 'authenticated' }, actions, loginAvailable: true })
      if (endpoint === 'remote-repository') return envelope({ actionScope: { path: payload['path'], projectId: '12' }, viewer, actions })
      if (endpoint === 'remote-login') return envelope({ attemptId: `attempt-${++attempt}`, userCode: `CODE${attempt}`, verificationUri: `${scope.instance}/oauth/device` })
      if (endpoint === 'remote-poll-login') return new Promise<Reply>(resolve => { finishLogin = resolve })
      if (endpoint === 'remote-cancel-login') return new Promise<Reply>(resolve => { releaseCancel = resolve })
      return undefined
    })
    f.controller.setRepository('/repo')
    await vi.waitFor(() => expect(f.controller.getSnapshot().items).toHaveLength(1))
    await f.controller.login()
    const finishOldLogin = finishLogin
    await f.controller.load('pulls', other)
    expect(f.controller.getSnapshot()).toMatchObject({ login: undefined, error: undefined, target: other })
    await f.controller.login()
    releaseCancel(envelope(null))
    finishOldLogin(envelope({ state: 'authenticated' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.controller.getSnapshot().login?.userCode).toBe('CODE2')
    finishLogin(envelope({ state: 'authenticated' }))
    await vi.waitFor(() => expect(f.call.mock.calls.some(call => call[1] === 'remote-retry-auth')).toBe(true))
    expect(f.controller.getSnapshot()).toMatchObject({ login: undefined, error: undefined })
  })
  it.each(['resolve', 'reject'] as const)('cancels login on its original instance and ignores a late %s after switching', async completion => {
    const otherScope = { provider: 'gitlab', instance: 'https://second.example' } as const
    const other = { ...target, instance: otherScope.instance, scope: otherScope }
    const polls = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>()
    const f = fixture((endpoint, payload) => {
      const instance = String(payload['instance']), currentScope = instance === otherScope.instance ? otherScope : scope
      const envelope = (value: unknown): Reply => ({ ok: true, value: { remoteProtocol: 2, scope: currentScope, generation, value } })
      if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }, { name: 'upstream', identity: other }] } } }
      if (endpoint === 'remote-capability') return envelope({ state: 'on', generation, viewer, auth: { state: 'authenticated' }, actions, loginAvailable: true })
      if (endpoint === 'remote-login') return envelope({ attemptId: instance, userCode: instance === scope.instance ? 'AAAA' : 'BBBB', verificationUri: `${instance}/oauth/device` })
      if (endpoint === 'remote-poll-login') return new Promise<Reply>((resolve, reject) => { polls.set(instance, { resolve, reject }) })
      if (endpoint === 'remote-cancel-login') return envelope(null)
      if (instance === otherScope.instance) return envelope(endpoint === 'remote-repository' ? { actionScope: { path: other.path, projectId: '12' }, viewer, actions } : { items: [], truncated: false })
      return undefined
    })
    await ready(f.controller); await f.controller.login()
    expect(f.controller.getSnapshot().login?.userCode).toBe('AAAA')
    await f.controller.load('pulls', other)
    expect(f.controller.getSnapshot()).toMatchObject({ target: other, login: undefined, busy: false })
    const cancellations = () => f.call.mock.calls.filter(call => call[1] === 'remote-cancel-login').map(call => call[2])
    expect(cancellations()).toEqual([expect.objectContaining({ instance: scope.instance, attemptId: scope.instance })])
    await f.controller.login()
    expect(f.controller.getSnapshot().login).toMatchObject({ userCode: 'BBBB', verificationUri: `${otherScope.instance}/oauth/device` })
    if (completion === 'resolve') polls.get(scope.instance)!.resolve({ ok: true, value: { remoteProtocol: 2, scope, generation, value: { state: 'authenticated' } } })
    else polls.get(scope.instance)!.reject(Error('late failure'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.controller.getSnapshot()).toMatchObject({ login: { userCode: 'BBBB' }, error: undefined })
    await f.controller.cancelLogin()
    expect(f.controller.getSnapshot().login).toBeUndefined()
    expect(cancellations()).toEqual([expect.objectContaining({ instance: scope.instance, attemptId: scope.instance }), expect.objectContaining({ instance: otherScope.instance, attemptId: otherScope.instance })])
    polls.get(otherScope.instance)!.reject(Error('cancelled'))
  })
  it('never sends GitLab operations without v2 negotiation', async () => {
    const f = fixture(undefined, false)
    expect(f.controller.scopedAvailable).toBe(false)
    f.controller.setRepository('/repo')
    await vi.waitFor(() => expect(f.controller.getSnapshot().busy).toBe(false))
    expect(f.call.mock.calls.some(call => call[1] === 'remote-list-prs' || call[1] === 'remote-discussions')).toBe(false)
    expect(f.controller.getSnapshot().items).toHaveLength(0)
  })
  it('accepts the first authenticated generation when resolving a previously uninitialized instance', async () => {
    let first = true
    const old = { ...generation, revision: 3 }
    const f = fixture(endpoint => {
      if (endpoint !== 'remote-capability' || !first) return undefined
      first = false
      return { ok: true, value: { remoteProtocol: 2, scope, generation: old, value: { state: 'on', generation: old, auth: { state: 'unauthenticated' }, credential: { configured: true, writable: true }, actions, loginAvailable: false, automaticRefreshAvailable: false, authMethods: { deviceFlow: { supported: true } } } } }
    })
    f.controller.setRepository('/repo')
    await vi.waitFor(() => expect(f.controller.getSnapshot().items).toHaveLength(1))
    expect(f.controller.getSnapshot().generation).toEqual(generation)
  })
  it('binds instance, project, directory, object and viewer to the two-step confirmation', async () => {
    const f = fixture(); await ready(f.controller)
    f.controller.prepare('merge', 'squash'); expect(f.controller.getSnapshot().confirmation?.sha).toBe(sha)
    await f.controller.confirm()
    const sent = f.call.mock.calls.find(call => call[1] === 'remote-merge-pr')?.[2] as Record<string, unknown>
    expect(sent).toMatchObject({ remoteProtocol: 2, provider: 'gitlab', instance: scope.instance, repository: '/repo', sessionId: 'session', projectId: '12', number: 7, expectedInstance: scope.instance, expectedGeneration: generation, expectedViewer: { host: viewer.host, userId: viewer.userId }, expectedHeadSha: sha, method: 'squash' })
    expect(f.controller.getSnapshot().blocked).toBe(true)
  })
  it('drops a confirmation when a refreshed head changes', async () => {
    let changed = false
    const f = fixture(endpoint => endpoint === 'remote-pr' && changed ? { ok: true, value: { remoteProtocol: 2, scope, generation, value: { ...pull, head: { ...pull.head, sha: laterSha } } } } : undefined)
    await ready(f.controller); f.controller.prepare('close'); expect(f.controller.getSnapshot().confirmation).toBeDefined()
    changed = true; await f.controller.refresh(); await f.controller.confirm()
    expect(f.controller.getSnapshot().confirmation).toBeUndefined()
    expect(f.call.mock.calls.some(call => call[1] === 'remote-close-pr')).toBe(false)
  })
  it('invalidates an old confirmation when the instance generation changes', async () => {
    let changed = false
    const newer = { ...generation, revision: generation.revision + 1 }
    const f = fixture(endpoint => endpoint === 'remote-pr' && changed ? { ok: true, value: { remoteProtocol: 2, scope, generation: newer, value: pull } } : undefined)
    await ready(f.controller); f.controller.prepare('merge', 'merge'); changed = true
    await f.controller.refresh(); await f.controller.confirm()
    expect(f.controller.getSnapshot().confirmation).toBeUndefined()
    expect(f.call.mock.calls.some(call => call[1] === 'remote-merge-pr')).toBe(false)
  })
  it('invalidates a removed instance and its outstanding confirmation', async () => {
    let removed = false
    const f = fixture(endpoint => endpoint === 'remote-capability' && removed ? { ok: false, error: { code: 'git/remote-unavailable', details: { reason: 'instance-removed' } } } : undefined)
    await ready(f.controller); f.controller.prepare('close'); removed = true; await f.controller.pollNotices()
    expect(f.controller.getSnapshot()).toMatchObject({ detail: undefined, facts: undefined, confirmation: undefined, blocked: false })
    expect(f.feature.getNotices()).toEqual([])
    await f.controller.confirm(); expect(f.call.mock.calls.some(call => call[1] === 'remote-close-pr')).toBe(false)
  })
  it('requires refreshed notes, approvals and explicit acknowledgement after an unknown approval', async () => {
    const f = fixture((endpoint, payload) => {
      if (endpoint === 'remote-review') return { ok: false, error: { code: 'git/write-result-unknown', details: { action: 'review', number: 7, stage: 'approve', commentSucceeded: true, commentId: '55' } } }
      if (endpoint === 'remote-comments' && payload['cursor'] === undefined) return { ok: true, value: { remoteProtocol: 2, scope, generation, value: { items: [], truncated: true, next: 'opaque' } } }
      return undefined
    })
    await ready(f.controller); await f.controller.write('remote-review', { event: 'APPROVE', body: 'A comment' })
    expect(f.controller.getSnapshot()).toMatchObject({ blocked: true, error: 'git/write-result-unknown', errorDetails: { commentSucceeded: true } })
    await f.controller.write('remote-review', { event: 'APPROVE', body: 'A comment' })
    await f.controller.load('pulls', target, 'all')
    expect(f.call.mock.calls.filter(call => call[1] === 'remote-review')).toHaveLength(1)
    await f.controller.refresh()
    await vi.waitFor(() => expect(f.controller.getSnapshot().reconciled).toBe(true))
    expect(f.controller.getSnapshot().errorDetails?.['commentSucceeded']).toBe(true)
    expect(f.controller.getSnapshot().blocked).toBe(true)
    f.controller.acknowledgeReconciliation(); expect(f.controller.getSnapshot().blocked).toBe(false)
  })
  it('refuses unsupported events and accounts, and preserves blocking across sidebar remounts', async () => {
    const f = fixture((endpoint, payload) => endpoint === 'remote-repository' ? { ok: true, value: { remoteProtocol: 2, scope, generation, value: { actionScope: { path: target.path, projectId: '12', ...(payload['object'] === undefined ? {} : { object: payload['object'] }) }, viewer, permissions: {}, actions, operationSupport: support, supportedMergeMethods: ['merge'], supportedReviewEvents: ['COMMENT'], reviewPermissions: { COMMENT: true, APPROVE: false, REQUEST_CHANGES: false } } } } : undefined)
    await ready(f.controller); await f.controller.write('remote-review', { event: 'APPROVE', body: '' }); f.controller.prepare('merge', 'squash')
    expect(f.controller.getSnapshot().confirmation).toBeUndefined(); expect(f.call.mock.calls.some(call => call[1] === 'remote-review')).toBe(false)
    expect(f.feature.controllerFor('session')).toBe(f.controller)
  })
  it('polls scoped review todos and notices state changes only for a loaded own MR', async () => {
    let merged = false
    const own = { ...pull, author: { userId: viewer.userId, login: viewer.login } }
    const f = fixture(endpoint => {
      const value = endpoint === 'remote-list-prs' ? { items: [own], truncated: false } : endpoint === 'remote-pr' ? { ...own, ...(merged ? { state: 'merged', rawState: 'merged', updatedAt: '2026-10-27T00:00:00Z' } : {}) } : endpoint === 'remote-notifications' ? { items: [{ id: '11', projectId: '12', objectId: '99', number: 7, kind: 'review-requested', title: 'Review', state: 'pending' }], truncated: false } : undefined
      return value === undefined ? undefined : { ok: true, value: { remoteProtocol: 2, scope, generation, value } }
    })
    const native = vi.fn(); f.feature.setNotify(native)
    f.controller.subscribe(() => {}); f.controller.setRepository('/repo'); await vi.waitFor(() => expect(f.controller.getSnapshot().items).toHaveLength(1))
    const poll = () => f.controller.pollNotices()
    merged = true; await poll(); await poll()
    expect(f.feature.getNotices().map(item => item.kind)).toEqual(['review-requested', 'merged'])
    expect(native).toHaveBeenCalledTimes(2)
    expect(f.call.mock.calls.filter(call => call[1] === 'remote-notifications').every(call => (call[2] as Record<string, unknown>)['automatic'] === true)).toBe(true)
    f.feature.setNotify(undefined); expect(f.feature.getNotices()).toHaveLength(2)
  })
  it('deduplicates pushed-branch suggestions within the verified project context', async () => {
    const f = fixture(); await ready(f.controller); const native = vi.fn(); f.feature.setNotify(native)
    f.controller.receivePush(target, '12', viewer, generation, sha)
    f.controller.receivePush(target, '12', viewer, generation, sha)
    expect(f.feature.getNotices().map(item => item.kind)).toEqual(['create-pr'])
    expect(native).toHaveBeenCalledTimes(1)
  })
  it('does not accept a substituted project or a missing scope echo', async () => {
    const f = fixture(endpoint => endpoint === 'remote-repository' ? { ok: true, value: { remoteProtocol: 2, scope: { ...scope, instance: 'https://evil.example' }, generation, value: {} } } : undefined)
    f.controller.setRepository('/repo'); await vi.waitFor(() => expect(f.controller.getSnapshot().error).toBe('scope-mismatch'))
    expect(f.controller.getSnapshot().items).toHaveLength(0)
  })
  it('removes old write facts and confirmations if a later scoped read omits its echo', async () => {
    let missing = false
    const f = fixture(endpoint => endpoint === 'remote-pr' && missing ? { ok: true, value: { remoteProtocol: 2, generation, value: pull } } : undefined)
    await ready(f.controller); f.controller.prepare('close'); missing = true; await f.controller.refresh()
    expect(f.controller.getSnapshot()).toMatchObject({ error: 'scope-mismatch', facts: undefined, generation: undefined, detail: undefined, confirmation: undefined })
    await f.controller.write('remote-comment', { body: 'Do not send' }); await f.controller.confirm()
    expect(f.call.mock.calls.some(call => call[1] === 'remote-comment' || call[1] === 'remote-close-pr')).toBe(false)
  })
  it.each(['missing-echo', 'malformed-receipt', 'lost-rpc'] as const)('blocks a repeat after %s on a submitted mutation until targeted reconciliation', async mode => {
    const f = fixture(endpoint => {
      if (endpoint !== 'remote-comment') return undefined
      if (mode === 'lost-rpc') throw new Error('fixture lost the response')
      return mode === 'missing-echo' ? { ok: true, value: { remoteProtocol: 2, generation, value: { outcome: 'succeeded', steps: [] } } } : { ok: true, value: { remoteProtocol: 2, scope, generation, value: {} } }
    })
    await ready(f.controller); await f.controller.write('remote-comment', { body: 'Only once' })
    expect(f.controller.getSnapshot()).toMatchObject({ error: 'git/write-result-unknown', blocked: true, facts: undefined, generation: undefined, detail: { number: 7 } })
    await f.controller.write('remote-comment', { body: 'Only once' })
    expect(f.call.mock.calls.filter(call => call[1] === 'remote-comment')).toHaveLength(1)
    await f.controller.refresh(); expect(f.controller.getSnapshot().reconciled).toBe(true)
    f.controller.acknowledgeReconciliation(); expect(f.controller.getSnapshot().blocked).toBe(false)
  })
  it('discards an old discovery reply when the workspace changes', async () => {
    let release!: (value: Reply) => void
    const f = fixture((endpoint, payload) => endpoint === 'remote-repositories' && payload['repository'] === '/repo' ? new Promise(resolve => { release = resolve }) : undefined)
    f.controller.setRepository('/repo'); await vi.waitFor(() => expect(release).toBeDefined())
    f.controller.setRepository('/new'); await vi.waitFor(() => expect(f.controller.getSnapshot().repository).toBe('/new'))
    release({ ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: [{ name: 'origin', identity: target }] } } })
    await vi.waitFor(() => expect(f.controller.getSnapshot().items).toHaveLength(1))
    expect(f.controller.getSnapshot().repository).toBe('/new')
  })
  it('discards in-flight replies when the portable feature unloads', async () => {
    let release!: (value: Reply) => void
    const f = fixture(endpoint => endpoint === 'remote-pr' ? new Promise(resolve => { release = resolve }) : undefined)
    f.controller.setRepository('/repo'); await vi.waitFor(() => expect(f.controller.getSnapshot().items).toHaveLength(1))
    const pending = f.controller.open(7, 'pulls'); await vi.waitFor(() => expect(release).toBeDefined())
    f.feature.dispose(); release({ ok: true, value: { remoteProtocol: 2, scope, generation, value: pull } }); await pending
    expect(f.controller.getSnapshot().detail).toBeUndefined()
  })
})
