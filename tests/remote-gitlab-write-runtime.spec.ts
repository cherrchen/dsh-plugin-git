import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteRuntime } from '../src/remote/runtime.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { GitService } from '../src/service.ts'

const signal = new AbortController().signal, sha = 'a'.repeat(40)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function fixture() {
  const records = new Map<string, CredentialRecord>()
  const credentials: GitRemoteCredentialService = { readRecord: async key => records.get(key), modifyRecord: async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); return records.get(key) }, deleteRecord: async key => { records.delete(key) }, resolve: async ref => ref === 'OFFICE' ? { value: 'private-sentinel', source: 'fixture' } : undefined, describe: async () => ({ configured: false, writable: true }), describeRecord: async key => ({ configured: records.has(key), writable: true }) }
  const subprocess = { spawn: vi.fn(() => { throw Error('unexpected probe') }), resolveExecutable: vi.fn(async () => { throw Error('unexpected probe') }) }
  const commands: string[][] = []
  const service = { remoteCommand: async (_root: string, args: readonly string[]) => { commands.push([...args]); if (args[0] === 'remote' && args[1] === 'get-url') return args[3] === 'origin' ? 'https://git.example.com/gitlab/group/repo.git\n' : 'https://git.example.com/gitlab/group/fork.git\n'; return args[0] === 'remote' ? 'origin\nupstream\n' : '' } } as unknown as GitService
  const settings = { instances: [{ url: 'https://git.example.com/gitlab', credentialRef: 'OFFICE' }] }
  const runtime = new GitRemoteRuntime(credentials, subprocess, service, settings)
  const state = { rawState: 'opened', canApprove: true, reauth: false, notes: 0, invalidateOnPolicy: false }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/user')) return json({ id: 9, username: 'viewer' })
    if (path.includes('/projects/group%2Frepo')) return json({ id: 42, path_with_namespace: 'group/repo', merge_requests_access_level: 'enabled', merge_method: 'merge', squash_option: 'default_off' })
    if (path.includes('/projects/group%2Ffork')) return json({ id: 99, path_with_namespace: 'group/fork', merge_requests_access_level: 'enabled', merge_method: 'merge', squash_option: 'default_off' })
    if (path.endsWith('/projects/42/approvals')) { if (state.invalidateOnPolicy) runtime.invalidateReference('OFFICE'); return json({ require_reauthentication_to_approve: state.reauth }) }
    if (path.endsWith('/merge_requests/7/approvals')) return json({ project_id: 42, iid: 7, approved_by: [], user_can_approve: state.canApprove, user_has_approved: false })
    if (path.endsWith('/merge_requests/7') && init?.method === 'GET') return json({ id: 123, iid: 7, title: 'MR', description: '', state: state.rawState, author: null, source_project_id: 42, target_project_id: 42, source_branch: 'topic', target_branch: 'main', sha, draft: false, detailed_merge_status: 'mergeable', squash_on_merge: false, user: { can_merge: true } })
    if (path.endsWith('/merge_requests/7/notes') && init?.method === 'POST') { state.notes++; return json({ id: 600 }, 201) }
    throw Error(`unexpected fixture route ${path}`)
  })
  const request = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab', repository: '/repo', sessionId: 'session', path: 'group/repo', projectId: '42' }
  const confirmed = async (requestId: string) => { const facts = await runtime.handle('remote-repository', request, signal, async () => {}) as any; return { ...request, objectKind: 'pull', number: 7, body: 'Hello', expectedInstance: request.instance, expectedGeneration: facts.generation, expectedViewer: { host: 'git.example.com', userId: '9' }, requestId } }
  return { runtime, request, confirmed, state, fetch, commands, settings }
}
afterEach(() => vi.restoreAllMocks())

describe('GitLab scoped write Host guards', () => {
  it.each(['remove', 'reconfigure'] as const)('rejects an old confirmed write without sending it after %s in the session guard', async change => {
    const f = fixture()
    try {
      const request = await f.confirmed(`instance-${change}`)
      let checks = 0
      await expect(f.runtime.handle('remote-comment', request, signal, async () => {
        if (++checks === 1) f.settings.instances = change === 'remove' ? [] : [{ url: f.request.instance, credentialRef: 'REPLACEMENT' }]
      })).rejects.toMatchObject({ code: 'git/remote-unavailable' })
      expect(checks).toBe(1)
      expect(f.state.notes).toBe(0)
      expect(f.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
      await f.runtime.dispose()
    } finally { void f.runtime.dispose() }
  }, 1500)
  it('returns object-scoped facts with separate approval permission and supported event sets', async () => {
    const f = fixture(); f.state.canApprove = false
    try {
      const facts = await f.runtime.handle('remote-repository', { ...f.request, object: { kind: 'pull', number: 7 } }, signal, async () => {}) as any
      expect(facts.value).toMatchObject({ actionScope: { path: 'group/repo', projectId: '42', object: { kind: 'pull', number: 7 } }, operationSupport: { comment: { supported: true }, 'inline-comment': { supported: false } }, supportedReviewEvents: ['COMMENT', 'APPROVE'], reviewPermissions: { APPROVE: false }, actions: { canComment: 'unknown' } })
      f.state.rawState = 'locked'
      const locked = await f.runtime.handle('remote-repository', { ...f.request, object: { kind: 'pull', number: 7 } }, signal, async () => {}) as any
      expect(locked.value.actions).toMatchObject({ canComment: false, canClose: false, canMerge: false })
    } finally { await f.runtime.dispose() }
  })
  it('rejects malicious project ids, wrong viewer and wrong instance before writing', async () => {
    const f = fixture()
    try {
      const request = await f.confirmed('guard-0001')
      for (const changed of [{ projectId: '99' }, { expectedInstance: 'https://other.example' }, { expectedViewer: { host: 'git.example.com', userId: '10' } }, { objectKind: 'issue' }]) await expect(f.runtime.handle('remote-comment', { ...request, ...changed }, signal, async () => {})).rejects.toBeDefined()
      expect(f.state.notes).toBe(0)
      expect(JSON.stringify(f.commands)).not.toContain('private-sentinel')
    } finally { await f.runtime.dispose() }
  })
  it('deduplicates concurrent requests and rejects a changed body for the same id', async () => {
    const f = fixture()
    try {
      const request = await f.confirmed('concurrent-0001')
      const [a, b] = await Promise.all([f.runtime.handle('remote-comment', request, signal, async () => {}), f.runtime.handle('remote-comment', request, signal, async () => {})])
      expect(a).toEqual(b); expect(f.state.notes).toBe(1)
      await expect(f.runtime.handle('remote-comment', { ...request, body: 'Different' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'submission-conflict' } })
      expect(JSON.stringify([a, b])).not.toContain('private-sentinel')
    } finally { await f.runtime.dispose() }
  })
  it('does not send a write after the session or credential changes', async () => {
    const f = fixture()
    try {
      const request = await f.confirmed('stale-0001'); let checks = 0
      await expect(f.runtime.handle('remote-comment', request, signal, async () => { if (++checks >= 3) throw Error('session moved') })).rejects.toBeDefined()
      expect(f.state.notes).toBe(0)
      f.state.invalidateOnPolicy = true
      await expect(f.runtime.handle('remote-comment', { ...request, requestId: 'stale-0002' }, signal, async () => {})).rejects.toBeDefined()
      expect(f.state.notes).toBe(0)
    } finally { await f.runtime.dispose() }
  })
  it('reports an unknown result if the session moves after a comment was accepted, without replaying it', async () => {
    const f = fixture()
    try {
      const request = await f.confirmed('after-send-0001')
      await expect(f.runtime.handle('remote-comment', request, signal, async () => { if (f.state.notes > 0) throw Error('session moved after send') })).rejects.toMatchObject({ code: 'git/write-result-unknown', details: { action: 'comment', number: 7 } })
      expect(f.state.notes).toBe(1)
      const replay = await f.runtime.handle('remote-comment', request, signal, async () => {}) as any
      expect(replay.value.outcome).toBe('succeeded'); expect(f.state.notes).toBe(1)
    } finally { await f.runtime.dispose() }
  })
  it('retains the successful comment identity if the context changes between comment and approval', async () => {
    const f = fixture()
    try {
      const request = { ...await f.confirmed('review-after-send-0001'), event: 'APPROVE', expectedHeadSha: sha }
      await expect(f.runtime.handle('remote-review', request, signal, async () => { if (f.state.notes > 0) throw Error('session moved after comment') })).rejects.toMatchObject({ code: 'git/write-result-unknown', details: { action: 'review', number: 7, stage: 'approve', commentSucceeded: true, commentId: '600' } })
      expect(f.state.notes).toBe(1)
      const replay = await f.runtime.handle('remote-review', request, signal, async () => {}) as any
      expect(replay.value.outcome).toBe('partial'); expect(f.state.notes).toBe(1)
    } finally { await f.runtime.dispose() }
  })
})
