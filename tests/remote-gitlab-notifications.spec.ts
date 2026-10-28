import { describe, expect, it } from 'vitest'
import { GitLabAuth } from '../src/remote/gitlab-auth.ts'
import { GitLabProjectReader } from '../src/remote/gitlab-project.ts'
import { GitRemoteHttp } from '../src/remote/http.ts'
import { resolveGitLabInstances } from '../src/remote/instances.ts'
import { resolveRemoteSettings } from '../src/remote/settings.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
const sha = 'a'.repeat(40), signal = new AbortController().signal
function fixture(instanceUrl = 'https://git.example.com/gitlab') {
  const instance = resolveGitLabInstances([{ url: instanceUrl, credentialRef: 'OFFICE' }]).find(item => item.instance === instanceUrl)!
  const calls: { url: string; method: string }[] = [], todos: unknown[] = []
  const credentials: GitRemoteCredentialService = { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {}, resolve: async () => ({ value: 'fixture-secret', source: 'fixture' }), describe: async () => ({ configured: false, writable: true }), describeRecord: async () => ({ configured: false, writable: true }) }
  const response = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } })
  const http = new GitRemoteHttp({ gitlabInstance: instance.instance, fetch: async (url, init) => {
    calls.push({ url, method: init.method }); const path = new URL(url).pathname
    if (path.endsWith('/user')) return response({ id: 9, username: 'alice' })
    if (path.endsWith('/projects/group%2Fsub%2Frepo')) return response({ id: 42, path_with_namespace: 'group/sub/repo' })
    if (path.endsWith('/todos')) return response(todos, { 'x-next-page': '' })
    throw Error('unexpected route')
  } })
  const auth = new GitLabAuth({ credentials, instance, http, settings: resolveRemoteSettings({}) })
  let now = 1000
  const reader = new GitLabProjectReader(instance, auth, http, async () => '', () => now)
  const request = { repository: '/repo', sessionId: 'session', path: 'group/sub/repo', projectId: '42', automatic: true }
  const context = { assertSession: async () => {}, assertRepository: async (_scope: unknown, path: string) => { if (path !== request.path) throw Error('not allowed'); return { name: 'origin' as const } } }
  const todo = { id: 11, action_name: 'review_requested', state: 'pending', project: { id: 42, path_with_namespace: 'group/sub/repo' }, target_type: 'MergeRequest', target: { id: 99, iid: 7, project_id: 42, target_project_id: 42, title: 'Review this', state: 'opened', sha }, target_url: `${instanceUrl}/group/sub/repo/-/merge_requests/7`, updated_at: '2026-10-27T01:02:03Z' }
  return { reader, auth, calls, todos, request, context, todo, setNow(value: number) { now = value }, async dispose() { reader.dispose(); await auth.dispose() } }
}
describe('GitLab review-requested notifications', () => {
  it('uses only pending, structured, project-bound todos and never writes or exposes credentials', async () => {
    const f = fixture(); f.todos.push(f.todo, { ...f.todo, id: 12, action_name: 'mentioned' }, { ...f.todo, id: 13, project: { id: 99, path_with_namespace: 'evil/repo' } }, { ...f.todo, id: 14, target: { ...f.todo.target, target_project_id: 99 } }, { ...f.todo, id: 15, state: 'done' })
    try {
      const result = await f.reader.notifications(f.request, signal, f.context)
      expect(result.value.items).toEqual([{ id: '11', projectId: '42', objectId: '99', number: 7, kind: 'review-requested', title: 'Review this', state: 'pending', updatedAt: '2026-10-27T01:02:03Z', url: f.todo.target_url }])
      expect(f.calls.every(call => call.method === 'GET')).toBe(true)
      expect(f.calls.find(call => call.url.includes('/todos?'))?.url).toContain('project_id=42&state=pending&action=review_requested&type=MergeRequest')
      expect(JSON.stringify(result)).not.toContain('fixture-secret')
    } finally { await f.dispose() }
  })
  it('enforces a one-minute minimum for authenticated automatic polling', async () => {
    const f = fixture(); f.todos.push(f.todo)
    try {
      await f.reader.notifications(f.request, signal, f.context)
      await expect(f.reader.notifications(f.request, signal, f.context)).rejects.toMatchObject({ code: 'git/rate-limited' })
      f.setNow(61_001); expect((await f.reader.notifications(f.request, signal, f.context)).value.items).toHaveLength(1)
    } finally { await f.dispose() }
  })
  it('does not let a client-supplied project id expand notification access', async () => {
    const f = fixture()
    try { await expect(f.reader.notifications({ ...f.request, projectId: '99' }, signal, f.context)).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' }); expect(f.calls.some(call => call.url.includes('/todos?'))).toBe(false) } finally { await f.dispose() }
  })
})
