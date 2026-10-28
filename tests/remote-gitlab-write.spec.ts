import { describe, expect, it, vi } from 'vitest'
import { GitLabAuth } from '../src/remote/gitlab-auth.ts'
import { GitLabProjectReader } from '../src/remote/gitlab-project.ts'
import { GitRemoteHttp, GitRemoteTransportNotSent } from '../src/remote/http.ts'
import { resolveGitLabInstances } from '../src/remote/instances.ts'
import { resolveRemoteSettings } from '../src/remote/settings.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { ScopedRequestContext } from '../src/remote/registry.ts'

const signal = new AbortController().signal, sha = 'a'.repeat(40)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function fixture() {
  const records = new Map<string, CredentialRecord>()
  const credentials: GitRemoteCredentialService = { readRecord: async key => records.get(key), modifyRecord: async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); return records.get(key) }, deleteRecord: async key => { records.delete(key) }, resolve: async () => ({ value: 'fixture-secret', source: 'fixture' }), describe: async () => ({ configured: false, writable: true }), describeRecord: async key => ({ configured: records.has(key), writable: true }) }
  const instance = resolveGitLabInstances([{ url: 'https://git.example.com/gitlab', credentialRef: 'OFFICE' }]).find(item => item.instance.includes('git.example.com'))!
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = []
  const state: { reauth: boolean; approveStatus: number; noteStatus: number; noteFailure: 'none' | 'not-sent' | 'unknown'; mergeStatus: number; rawState: string; head: string; canMerge: boolean; canApprove: boolean; sourceAllowed: boolean; squashOnMerge: boolean | undefined; mergeReceipt: 'match' | 'mismatch' | 'missing' | 'source-removed' | 'missing-source-removed' } = { reauth: false, approveStatus: 200, noteStatus: 201, noteFailure: 'none', mergeStatus: 200, rawState: 'opened', head: sha, canMerge: true, canApprove: true, sourceAllowed: true, squashOnMerge: false, mergeReceipt: 'match' }
  const project = { id: 42, path_with_namespace: 'group/repo', merge_requests_access_level: 'enabled', merge_method: 'merge', squash_option: 'default_off' }
  const http = new GitRemoteHttp({ gitlabInstance: instance.instance, fetch: async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname, body = init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path, method: init.method, ...(body === undefined ? {} : { body }) })
    if (path.endsWith('/user')) return json({ id: 9, username: 'viewer' })
    if (path.includes('/projects/group%2Frepo')) return json(project)
    if (path.includes('/projects/group%2Ffork')) return json({ ...project, id: 99, path_with_namespace: 'group/fork' })
    if (path.endsWith('/projects/42/approvals')) return json({ require_reauthentication_to_approve: state.reauth })
    if (path.endsWith('/merge_requests/7/approvals')) return json({ project_id: 42, iid: 7, approved_by: [], user_can_approve: state.canApprove, user_has_approved: false })
    if (path.endsWith('/merge_requests/7') && init.method === 'GET') return json({ id: 123, iid: 7, title: 'MR', description: '', state: state.rawState, author: null, source_project_id: 42, target_project_id: 42, source_branch: 'topic', target_branch: 'main', sha: state.head, draft: false, detailed_merge_status: 'mergeable', squash_on_merge: state.squashOnMerge, user: { can_merge: state.canMerge } })
    if (path.includes('/repository/branches/')) return json({ name: decodeURIComponent(path.split('/').at(-1)!), commit: { id: sha } })
    if (path.endsWith('/merge_requests/7/notes') && init.method === 'POST') {
      if (state.noteFailure === 'not-sent') throw new GitRemoteTransportNotSent()
      if (state.noteFailure === 'unknown') throw Error('fixture transport lost response')
      return json({ id: 600, body: 'untrusted raw response' }, state.noteStatus)
    }
    if (path.endsWith('/merge_requests/7/approve') && init.method === 'POST') return json({ id: 123, iid: 7, project_id: 42 }, state.approveStatus)
    if (path.endsWith('/merge_requests/7/merge') && init.method === 'PUT') return json({ iid: 7, state: 'merged', ...(['missing', 'missing-source-removed'].includes(state.mergeReceipt) ? {} : { squash_on_merge: state.mergeReceipt === 'mismatch' ? !body?.['squash'] : body?.['squash'] }), should_remove_source_branch: ['source-removed', 'missing-source-removed'].includes(state.mergeReceipt) }, state.mergeStatus)
    if (path.endsWith('/merge_requests/7') && init.method === 'PUT') return json({ iid: 7, state: 'closed' })
    if (path.endsWith('/projects/99/merge_requests') && init.method === 'POST') return json({ id: 777, iid: 8, source_project_id: 99, target_project_id: 42 }, 201)
    throw Error(`unexpected fixture route ${path}`)
  } })
  const auth = new GitLabAuth({ credentials, instance, http, settings: resolveRemoteSettings({}) })
  const run = vi.fn(async () => '')
  const reader = new GitLabProjectReader(instance, auth, http, run)
  const context: ScopedRequestContext = { assertSession: async () => {}, assertRepository: async (_scope, path) => { if (path !== 'group/repo' && (path !== 'group/fork' || !state.sourceAllowed)) throw Error('not a local remote'); return { name: path === 'group/repo' ? 'origin' : 'upstream' } } }
  const base = { repository: '/repo', sessionId: 'session-1', path: 'group/repo', projectId: '42', expectedInstance: instance.instance, objectKind: 'pull' }
  const confirmed = async (id: string) => { const snapshot = await auth.snapshot(signal); return { ...base, expectedGeneration: snapshot.generation, expectedViewer: { host: 'git.example.com', userId: '9' }, requestId: id } }
  const dispose = async () => { reader.dispose(); await auth.dispose() }
  return { reader, context, state, project, calls, confirmed, dispose, run }
}
const writes = (calls: ReturnType<typeof fixture>['calls']) => calls.filter(call => call.method !== 'GET')

describe('GitLab guarded remote writes', () => {
  it('posts a normal comment once and rejects request-id reuse with different content', async () => {
    const f = fixture()
    try {
      const request = { ...await f.confirmed('comment-0001'), number: 7, body: 'Hello' }
      const first = await f.reader.write('remote-comment', request, signal, f.context)
      const second = await f.reader.write('remote-comment', request, signal, f.context)
      expect(first.value).toMatchObject({ outcome: 'succeeded', receipt: { id: '600' } }); expect(second.value).toEqual(first.value)
      expect(writes(f.calls)).toHaveLength(1); expect(JSON.stringify(first)).not.toContain('fixture-secret')
      await expect(f.reader.write('remote-comment', { ...request, body: 'Different' }, signal, f.context)).rejects.toMatchObject({ details: { reason: 'submission-conflict' } })
    } finally { await f.dispose() }
  })
  it('does not send the comment when approval reauthentication is known to be required', async () => {
    const f = fixture(); f.state.reauth = true
    try {
      const request = { ...await f.confirmed('review-0001'), number: 7, body: 'Feedback', event: 'APPROVE', expectedHeadSha: sha }
      await expect(f.reader.write('remote-review', request, signal, f.context)).rejects.toMatchObject({ details: { reason: 'approval-reauth-or-policy' } })
      expect(writes(f.calls)).toEqual([])
    } finally { await f.dispose() }
  })
  it('rejects a known approval permission denial without disabling ordinary comments', async () => {
    const f = fixture(); f.state.canApprove = false
    try {
      const request = { ...await f.confirmed('review-0004'), number: 7, body: 'Feedback', event: 'APPROVE', expectedHeadSha: sha }
      await expect(f.reader.write('remote-review', request, signal, f.context)).rejects.toMatchObject({ code: 'git/insufficient-scope' })
      expect(writes(f.calls)).toEqual([])
      const comment = await f.reader.write('remote-comment', { ...request, requestId: 'comment-0004' }, signal, f.context)
      expect(comment.value.outcome).toBe('succeeded')
    } finally { await f.dispose() }
  })
  it('reports a successful comment and known approval failure without replaying the comment', async () => {
    const f = fixture(); f.state.approveStatus = 403
    try {
      const request = { ...await f.confirmed('review-0002'), number: 7, body: 'Feedback', event: 'APPROVE', expectedHeadSha: sha }
      const result = await f.reader.write('remote-review', request, signal, f.context)
      expect(result.value).toMatchObject({ outcome: 'partial', steps: [{ kind: 'comment', state: 'succeeded', id: '600' }, { kind: 'approve', state: 'failed', reason: 'git/insufficient-scope' }] })
      expect((await f.reader.write('remote-review', request, signal, f.context)).value).toEqual(result.value)
      expect(writes(f.calls).map(call => call.path.split('/').at(-1))).toEqual(['notes', 'approve'])
    } finally { await f.dispose() }
  })
  it('keeps an unknown approval result and never replays a successful comment', async () => {
    const f = fixture(); f.state.approveStatus = 500
    try {
      const request = { ...await f.confirmed('review-0003'), number: 7, body: 'Feedback', event: 'APPROVE', expectedHeadSha: sha }
      for (let attempt = 0; attempt < 2; attempt++) await expect(f.reader.write('remote-review', request, signal, f.context)).rejects.toMatchObject({ code: 'git/write-result-unknown', details: { action: 'review', stage: 'approve', commentSucceeded: true, commentId: '600' } })
      expect(writes(f.calls).map(call => call.path.split('/').at(-1))).toEqual(['notes', 'approve'])
    } finally { await f.dispose() }
  })
  it.each([['not-sent', 'git/remote-unavailable'], ['unknown', 'git/write-result-unknown']] as const)('distinguishes a %s transport outcome and does not replay the submission', async (failure, code) => {
    const f = fixture(); f.state.noteFailure = failure
    try {
      const request = { ...await f.confirmed(`comment-${failure}`), number: 7, body: 'Feedback' }
      for (let attempt = 0; attempt < 2; attempt++) await expect(f.reader.write('remote-comment', request, signal, f.context)).rejects.toMatchObject({ code, ...(failure === 'not-sent' ? { details: { reason: 'not-sent' } } : { details: { action: 'comment', number: 7 } }) })
      expect(writes(f.calls)).toHaveLength(1)
    } finally { await f.dispose() }
  })
  it('enforces merge SHA, project method policy and known permission before sending', async () => {
    const f = fixture()
    try {
      const request = { ...await f.confirmed('merge-0001'), number: 7, method: 'merge', expectedHeadSha: sha }
      f.state.canMerge = false
      await expect(f.reader.write('remote-merge-pr', request, signal, f.context)).rejects.toMatchObject({ details: { reason: 'action-not-supported' } })
      f.state.canMerge = true; f.state.head = 'b'.repeat(40)
      await expect(f.reader.write('remote-merge-pr', { ...request, requestId: 'merge-0002' }, signal, f.context)).rejects.toMatchObject({ code: 'git/head-moved' })
      expect(writes(f.calls)).toEqual([])
      f.state.head = sha
      const result = await f.reader.write('remote-merge-pr', { ...request, requestId: 'merge-0003' }, signal, f.context)
      expect(result.value).toMatchObject({ outcome: 'succeeded', receipt: { merged: true, number: 7 } })
      expect(writes(f.calls)[0]?.body).toEqual({ sha, squash: false, should_remove_source_branch: false })
    } finally { await f.dispose() }
  })
  it('rechecks effective squash policy before sending and sends the selected value explicitly', async () => {
    const f = fixture()
    try {
      const request = { ...await f.confirmed('squash-0001'), number: 7, method: 'merge', expectedHeadSha: sha }
      f.project.squash_option = 'always'; f.state.squashOnMerge = true
      await expect(f.reader.write('remote-merge-pr', request, signal, f.context)).rejects.toMatchObject({ details: { reason: 'unsupported-merge-method' } })
      f.state.squashOnMerge = undefined
      await expect(f.reader.write('remote-merge-pr', { ...request, requestId: 'squash-0002', method: 'squash' }, signal, f.context)).rejects.toMatchObject({ details: { reason: 'action-not-supported' } })
      f.state.squashOnMerge = true
      const result = await f.reader.write('remote-merge-pr', { ...request, requestId: 'squash-0003', method: 'squash' }, signal, f.context)
      expect(result.value.outcome).toBe('succeeded')
      expect(writes(f.calls)).toHaveLength(1)
      expect(writes(f.calls)[0]?.body).toEqual({ sha, squash: true, should_remove_source_branch: false })
    } finally { await f.dispose() }
  })
  it.each([['mismatch', 'merge-method-mismatch', 'failed'], ['missing', 'merge-method-unverified', 'unknown'], ['source-removed', 'source-removal-reported', 'failed'], ['missing-source-removed', 'source-removal-reported', 'failed']] as const)('reports a merged but %s receipt without retrying', async (receipt, reason, verification) => {
    const f = fixture(); f.state.mergeReceipt = receipt
    try {
      const request = { ...await f.confirmed(`merge-${receipt}`), number: 7, method: 'merge', expectedHeadSha: sha }
      const result = await f.reader.write('remote-merge-pr', request, signal, f.context)
      expect(result.value).toMatchObject({ outcome: 'partial', steps: [{ kind: 'merge-pr', state: 'succeeded' }, { kind: 'merge-verification', state: verification, reason }], receipt: { merged: true, number: 7, error: reason } })
      expect((await f.reader.write('remote-merge-pr', request, signal, f.context)).value).toEqual(result.value)
      expect(writes(f.calls)).toHaveLength(1)
    } finally { await f.dispose() }
  })
  it('treats an atomic merge SHA conflict as head-moved and closes with a best-effort precheck', async () => {
    const f = fixture(); f.state.mergeStatus = 409
    try {
      const request = { ...await f.confirmed('merge-409'), number: 7, method: 'merge', expectedHeadSha: sha }
      await expect(f.reader.write('remote-merge-pr', request, signal, f.context)).rejects.toMatchObject({ code: 'git/head-moved' })
      const closed = await f.reader.write('remote-close-pr', { ...request, requestId: 'close-0001' }, signal, f.context)
      expect(closed.value).toMatchObject({ outcome: 'succeeded', receipt: { number: 7 } })
      expect(writes(f.calls).at(-1)?.body).toEqual({ state_event: 'close' })
    } finally { await f.dispose() }
  })
  it('creates only from separately authorized, verified remote branches without push', async () => {
    const f = fixture()
    try {
      const request = { ...await f.confirmed('create-0001'), head: { provider: 'gitlab', instance: 'https://git.example.com/gitlab', path: 'group/fork', projectId: '99' }, headRef: 'feature/topic', baseRef: 'main', title: 'New MR', body: 'Description', draft: false }
      const result = await f.reader.write('remote-create-pr', request, signal, f.context)
      expect(result.value).toMatchObject({ outcome: 'succeeded', receipt: { id: '777', number: 8 } })
      expect(writes(f.calls)).toEqual([{ path: '/gitlab/api/v4/projects/99/merge_requests', method: 'POST', body: { source_branch: 'feature/topic', target_branch: 'main', target_project_id: 42, title: 'New MR', description: 'Description' } }])
      expect(f.run.mock.calls.every(call => call[1][0] !== 'push')).toBe(true)
      f.state.sourceAllowed = false
      await expect(f.reader.write('remote-create-pr', { ...request, requestId: 'create-0002' }, signal, f.context)).rejects.toBeDefined()
      expect(writes(f.calls)).toHaveLength(1)
    } finally { await f.dispose() }
  })
  it('rejects locked or unknown states and deliberately deferred actions', async () => {
    const f = fixture()
    try {
      const request = { ...await f.confirmed('closed-0001'), number: 7, expectedHeadSha: sha, body: 'Comment' }
      for (const state of ['locked', 'unexpected']) { f.state.rawState = state; await expect(f.reader.write('remote-comment', { ...request, requestId: `comment-${state}` }, signal, f.context)).rejects.toMatchObject({ code: 'git/remote-unavailable' }) }
      await expect(f.reader.write('remote-review', { ...request, event: 'REQUEST_CHANGES' }, signal, f.context)).rejects.toMatchObject({ details: { reason: 'unsupported-review-event' } })
      await expect(f.reader.write('remote-merge-pr', { ...request, method: 'rebase' }, signal, f.context)).rejects.toMatchObject({ details: { reason: 'unsupported-merge-method' } })
      expect(writes(f.calls)).toEqual([])
    } finally { await f.dispose() }
  })
})
