import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteRuntime } from '../src/remote/runtime.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { GitService } from '../src/service.ts'

const signal = new AbortController().signal
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
function fixture() {
  const records = new Map<string, CredentialRecord>(), refs = new Map<string, { value: string; source: string }>()
  const credentials: GitRemoteCredentialService = { readRecord: async key => records.get(key), modifyRecord: async (key, fn) => { const next = await fn(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) }, deleteRecord: async key => { records.delete(key) }, resolve: async ref => refs.get(ref), describe: async () => ({ configured: false, writable: true }), describeRecord: async key => ({ configured: records.has(key), writable: true }) }
  const subprocess = { spawn: vi.fn(() => { throw Error('unexpected subprocess') }), resolveExecutable: vi.fn(async () => { throw Error('unexpected subprocess') }) }
  let origin = 'https://git.example.com/gitlab/group/sub/repo.git'
  const service = { remoteCommand: vi.fn(async (_root: string, args: readonly string[]) => args[1] === 'get-url' ? `${origin}\n` : 'origin\n') } as unknown as GitService
  const runtime = new GitRemoteRuntime(credentials, subprocess, service, { instances: [
    { url: 'https://git.example.com/gitlab', credentialRef: 'FIRST' },
    { url: 'https://other.example', credentialRef: 'SECOND' },
  ] })
  const request = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab', repository: '/repo', sessionId: 'session', path: 'group/sub/repo' }
  return { runtime, refs, request, setOrigin: (value: string) => { origin = value } }
}
afterEach(() => vi.restoreAllMocks())

describe('scoped GitLab project identity', () => {
  it('resolves a subgroup path, fences projectId, and leaves every write disabled', async () => {
    const f = fixture(); f.refs.set('FIRST', { value: 'private-token', source: 'fixture' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/user') ? json({ id: 9, username: 'viewer' }) : json({ id: 42, path_with_namespace: 'group/sub/repo' }))
    try {
      const result = await f.runtime.handle('remote-repository', f.request, signal, async () => {}) as any
      expect(result).toMatchObject({ remoteProtocol: 2, scope: { provider: 'gitlab', instance: f.request.instance }, value: { actionScope: { path: 'group/sub/repo', projectId: '42' }, viewer: { userId: '9' }, actions: { canComment: false, canReview: false, canMerge: false }, operationSupport: { comment: { supported: false }, 'merge-pr': { supported: false } }, supportedMergeMethods: [], supportedReviewEvents: [] } })
      expect(JSON.stringify(result)).not.toContain('private-token')
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://git.example.com/gitlab/api/v4/user', 'https://git.example.com/gitlab/api/v4/projects/group%2Fsub%2Frepo'])
      await expect(f.runtime.handle('remote-repository', { ...f.request, projectId: '43' }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
      await expect(f.runtime.handle('remote-inline-comment', { ...f.request, projectId: '42' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'not-implemented' } })
    } finally { await f.runtime.dispose() }
  })
  it('rejects a client-selected path before network and rejects project migration or a changed remote after lookup', async () => {
    const f = fixture()
    let responsePath = 'group/sub/repo', changeRemote = false
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { if (changeRemote) f.setOrigin('https://git.example.com/gitlab/other/repo.git'); return json({ id: 42, path_with_namespace: responsePath }) })
    try {
      await expect(f.runtime.handle('remote-repository', { ...f.request, path: 'other/repo', projectId: '42' }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
      expect(fetch).not.toHaveBeenCalled()
      responsePath = 'moved/repo'
      await expect(f.runtime.handle('remote-repository', f.request, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
      responsePath = 'group/sub/repo'; changeRemote = true
      await expect(f.runtime.handle('remote-repository', f.request, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
    } finally { await f.runtime.dispose() }
  })
  it('keeps the same numeric project and viewer ids isolated across instances', async () => {
    const f = fixture(); f.refs.set('FIRST', { value: 'first-secret', source: 'fixture' }); f.refs.set('SECOND', { value: 'second-secret', source: 'fixture' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/user') ? json({ id: 9, username: 'viewer' }) : json({ id: 42, path_with_namespace: 'group/sub/repo' }))
    try {
      const first = await f.runtime.handle('remote-repository', f.request, signal, async () => {}) as any
      f.setOrigin('https://other.example/group/sub/repo.git')
      const second = await f.runtime.handle('remote-repository', { ...f.request, instance: 'https://other.example' }, signal, async () => {}) as any
      expect(first.generation.instanceId).not.toBe(second.generation.instanceId)
      expect(second.scope.instance).toBe('https://other.example')
      const headers = fetch.mock.calls.filter(([url]) => !String(url).endsWith('/user')).map(([, init]) => new Headers(init?.headers).get('authorization'))
      expect(headers).toEqual(['Bearer first-secret', 'Bearer second-secret'])
      expect(JSON.stringify([first, second])).not.toMatch(/first-secret|second-secret/)
    } finally { await f.runtime.dispose() }
  })
  it('rejects stale session work and anonymous automatic polling', async () => {
    const f = fixture(); let checks = 0
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ id: 42, path_with_namespace: 'group/sub/repo' }))
    try {
      await expect(f.runtime.handle('remote-repository', { ...f.request, automatic: true }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'anonymous-manual-only' } })
      expect(fetch).not.toHaveBeenCalled()
      await expect(f.runtime.handle('remote-repository', f.request, signal, async () => { if (++checks > 1) throw Error('session changed') })).rejects.toMatchObject({ code: 'git/remote-unavailable' })
      expect(fetch).toHaveBeenCalledOnce()
    } finally { await f.runtime.dispose() }
  })
  it('cancels an in-flight project lookup when its credential reference changes', async () => {
    const f = fixture(); f.refs.set('FIRST', { value: 'first-secret', source: 'fixture' })
    let started!: () => void
    const pendingLookup = new Promise<void>(resolve => { started = resolve })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/user')) return json({ id: 9, username: 'viewer' })
      started()
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }))
    })
    try {
      const work = f.runtime.handle('remote-repository', f.request, signal, async () => {})
      const rejected = expect(work).rejects.toMatchObject({ code: 'git/remote-unavailable' })
      await pendingLookup
      f.refs.set('FIRST', { value: 'other-secret', source: 'fixture' })
      f.runtime.invalidateReference('FIRST')
      await rejected
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { await f.runtime.dispose() }
  })
  it('rejects a generation change while the registry is checking the response', async () => {
    const f = fixture(); f.refs.set('FIRST', { value: 'first-secret', source: 'fixture' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/user') ? json({ id: 9, username: 'viewer' }) : json({ id: 42, path_with_namespace: 'group/sub/repo' }))
    const registry = (f.runtime as unknown as { registry: { guard: (provider: unknown) => Promise<void> } }).registry
    const guard = registry.guard.bind(registry)
    registry.guard = async provider => { await guard(provider); f.runtime.invalidateReference('FIRST') }
    try { await expect(f.runtime.handle('remote-repository', f.request, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' }) } finally { await f.runtime.dispose() }
  })
  it('honors a server rate limit without retrying the request', async () => {
    const f = fixture()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 429, { 'retry-after': '120' }))
    try {
      await expect(f.runtime.handle('remote-repository', f.request, signal, async () => {})).rejects.toMatchObject({ code: 'git/rate-limited' })
      await expect(f.runtime.handle('remote-repository', f.request, signal, async () => {})).rejects.toMatchObject({ code: 'git/rate-limited' })
      expect(fetch).toHaveBeenCalledOnce()
    } finally { await f.runtime.dispose() }
  })
  it('reserves the automatic polling interval before an in-flight request completes', async () => {
    const f = fixture(); f.refs.set('FIRST', { value: 'private-token', source: 'fixture' })
    let release!: () => void, started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve }), resume = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/user')) return json({ id: 9, username: 'viewer' })
      started(); await resume; return json({ id: 42, path_with_namespace: 'group/sub/repo' })
    })
    try {
      const first = f.runtime.handle('remote-repository', { ...f.request, automatic: true }, signal, async () => {})
      await entered
      await expect(f.runtime.handle('remote-repository', { ...f.request, automatic: true }, signal, async () => {})).rejects.toMatchObject({ code: 'git/rate-limited' })
      release(); await first
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { release(); await f.runtime.dispose() }
  })
})

describe('GitLab progressive list reads', () => {
  const issue = (id: number, iid: number, state: string) => ({ id, iid, project_id: 42, title: `Issue ${iid}`, description: null, state, author: null })
  it('uses opaque query-bound cursors and retains iid separately from global id', async () => {
    const f = fixture(), listPath = '/gitlab/api/v4/projects/42/issues'
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url))
      if (parsed.pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      if (parsed.pathname === listPath && parsed.searchParams.get('page') === '1') return json([issue(900, 7, 'opened')], 200, { link: `<https://git.example.com${listPath}?id=42&order_by=created_at&sort=desc&state=all&per_page=50&page=2&with_labels_details=false>; rel="next"`, 'x-next-page': '2' })
      if (parsed.pathname === listPath && parsed.searchParams.get('page') === '2') return json([issue(901, 8, 'closed')], 200, { link: `<https://git.example.com${listPath}?id=42&order_by=created_at&sort=desc&state=all&per_page=50&page=1&with_labels_details=false>; rel="first", <https://git.example.com${listPath}?id=42&order_by=created_at&sort=desc&state=all&per_page=50&page=2&with_labels_details=false>; rel="last"`, 'x-next-page': '' })
      throw Error('unexpected fixture request')
    })
    try {
      const first = await f.runtime.handle('remote-list-issues', { ...f.request, state: 'all' }, signal, async () => {}) as any
      expect(first.value).toMatchObject({ items: [{ id: '900', number: 7, state: 'open' }], truncated: true })
      expect(first.value.next).not.toContain('/api/')
      await expect(f.runtime.handle('remote-list-issues', { ...f.request, state: 'closed', cursor: first.value.next }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-cursor' } })
      const second = await f.runtime.handle('remote-list-issues', { ...f.request, state: 'all', cursor: first.value.next }, signal, async () => {}) as any
      expect(second.value).toEqual({ items: [expect.objectContaining({ id: '901', number: 8, state: 'closed' })], truncated: false })
      expect(fetch.mock.calls.filter(([url]) => String(url).includes(listPath))).toHaveLength(2)
      expect(String(fetch.mock.calls.at(-1)?.[0])).toBe(`https://git.example.com${listPath}?state=all&per_page=50&page=2`)
    } finally { await f.runtime.dispose() }
  })
  it.each([
    '<https://evil.example/gitlab/api/v4/projects/42/issues?state=all&per_page=50&page=2>; rel="next"',
    '<https://git.example.com/gitlab/api/v4/projects/43/issues?state=all&per_page=50&page=2>; rel="next"',
    '<https://git.example.com/gitlab/api/v4/projects/42/issues?state=closed&per_page=50&page=2>; rel="next"',
    '<https://git.example.com/gitlab/api/v4/projects/42/issues?state=all&per_page=50&page=1>; rel="next"',
    '<https://evil.example/gitlab/api/v4/projects/42/issues?state=all&per_page=50&page=10>; rel="last"',
  ])('rejects a malicious or non-advancing Link %s', async link => {
    const f = fixture()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/projects/group%2F') ? json({ id: 42, path_with_namespace: 'group/sub/repo' }) : json([issue(900, 7, 'opened')], 200, { link }))
    try {
      await expect(f.runtime.handle('remote-list-issues', { ...f.request, state: 'all' }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-unavailable' })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { await f.runtime.dispose() }
  })
  it('does not treat stripped pagination headers as a complete result', async () => {
    const f = fixture()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/projects/group%2F') ? json({ id: 42, path_with_namespace: 'group/sub/repo' }) : json([issue(900, 7, 'opened')]))
    try { await expect(f.runtime.handle('remote-list-issues', f.request, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'pagination-unavailable' } }) } finally { await f.runtime.dispose() }
  })
  it('projects locked fork merge requests and rejects a target outside the allowed project', async () => {
    const f = fixture(), sha = 'a'.repeat(40)
    let target = 42
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/projects/group%2F') ? json({ id: 42, path_with_namespace: 'group/sub/repo' }) : json([{ id: 901, iid: 7, title: 'Fork', description: '', state: 'locked', author: null, source_project_id: 99, target_project_id: target, source_branch: 'feature', target_branch: 'main', sha }], 200, { 'x-next-page': '' }))
    try {
      const result = await f.runtime.handle('remote-list-prs', { ...f.request, state: 'open' }, signal, async () => {}) as any
      expect(result.value).toMatchObject({ items: [{ id: '901', number: 7, state: 'open', rawState: 'locked', head: { projectId: '99', ref: 'feature', sha }, base: { projectId: '42', ref: 'main' } }], truncated: false })
      target = 43
      await expect(f.runtime.handle('remote-list-prs', f.request, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-response' } })
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally { await f.runtime.dispose() }
  })
  it('addresses details with the project-local iid and rejects a mismatched response', async () => {
    const f = fixture(); let iid = 7
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/projects/group%2F') ? json({ id: 42, path_with_namespace: 'group/sub/repo' }) : json(issue(1234, iid, 'opened')))
    try {
      const result = await f.runtime.handle('remote-issue', { ...f.request, number: 7 }, signal, async () => {}) as any
      expect(result.value).toMatchObject({ id: '1234', number: 7 })
      expect(String(fetch.mock.calls[1]?.[0])).toBe('https://git.example.com/gitlab/api/v4/projects/42/issues/7')
      iid = 8
      await expect(f.runtime.handle('remote-issue', { ...f.request, number: 7 }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-object' } })
    } finally { await f.runtime.dispose() }
  })
  it('bounds a single request without imposing a silent total item ceiling', async () => {
    const f = fixture()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url))
      if (parsed.pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      const page = Number(parsed.searchParams.get('page'))
      return json([issue(900 + page, page, 'opened')], 200, { 'x-next-page': page < 11 ? String(page + 1) : '' })
    })
    try {
      const first = await f.runtime.handle('remote-list-issues', { ...f.request, state: 'all', pages: 100 }, signal, async () => {}) as any
      expect(first.value.items).toHaveLength(10); expect(first.value.truncated).toBe(true)
      const second = await f.runtime.handle('remote-list-issues', { ...f.request, state: 'all', cursor: first.value.next }, signal, async () => {}) as any
      expect(second.value.items).toHaveLength(1); expect(second.value.truncated).toBe(false)
    } finally { await f.runtime.dispose() }
  })
  it('rechecks local remotes before each page when the repository changes mid-request', async () => {
    const f = fixture(), pages: number[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url))
      if (parsed.pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      pages.push(Number(parsed.searchParams.get('page')))
      f.setOrigin('https://git.example.com/gitlab/other/repo.git')
      return json([issue(901, 1, 'opened')], 200, { 'x-next-page': '2' })
    })
    try {
      await expect(f.runtime.handle('remote-list-issues', { ...f.request, pages: 2 }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
      expect(pages).toEqual([1])
    } finally { await f.runtime.dispose() }
  })
  it('rejects a cursor after a generation change even when the viewer id is unchanged', async () => {
    const f = fixture(); f.refs.set('FIRST', { value: 'first-secret', source: 'fixture' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/user')) return json({ id: 9, username: 'viewer' })
      if (parsed.pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      return json([issue(900, 7, 'opened')], 200, { 'x-next-page': '2' })
    })
    try {
      const first = await f.runtime.handle('remote-list-issues', { ...f.request, state: 'all' }, signal, async () => {}) as any
      f.refs.set('FIRST', { value: 'second-secret', source: 'fixture' }); f.runtime.invalidateReference('FIRST')
      await expect(f.runtime.handle('remote-list-issues', { ...f.request, state: 'all', cursor: first.value.next }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-cursor' } })
    } finally { await f.runtime.dispose() }
  })
  it('rejects a cursor from a different instance even when the project and viewer ids coincide', async () => {
    const f = fixture()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url))
      if (parsed.pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      return json([issue(900, 7, 'opened')], 200, { 'x-next-page': '2' })
    })
    try {
      const first = await f.runtime.handle('remote-list-issues', { ...f.request, state: 'all' }, signal, async () => {}) as any
      f.setOrigin('https://other.example/group/sub/repo.git')
      await expect(f.runtime.handle('remote-list-issues', { ...f.request, instance: 'https://other.example', state: 'all', cursor: first.value.next }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'invalid-cursor' } })
    } finally { await f.runtime.dispose() }
  })
  it('sends conditional requests only for a prior ETag and clears cached pages when the account changes', async () => {
    const f = fixture(); f.refs.set('FIRST', { value: 'first-secret', source: 'fixture' })
    const conditionals: (string | null)[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/user')) return json({ id: 9, username: 'viewer' })
      if (parsed.pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      const conditional = new Headers(init?.headers).get('if-none-match'); conditionals.push(conditional)
      if (conditional !== null) return new Response(null, { status: 304 })
      return json([issue(900, 7, 'opened')], 200, { etag: '"etag-1"', 'x-next-page': '' })
    })
    try {
      const first = await f.runtime.handle('remote-list-issues', f.request, signal, async () => {}) as any
      const second = await f.runtime.handle('remote-list-issues', f.request, signal, async () => {}) as any
      expect(second.value).toEqual(first.value)
      await f.runtime.handle('remote-list-issues', { ...f.request, state: 'closed' }, signal, async () => {})
      f.refs.set('FIRST', { value: 'second-secret', source: 'fixture' }); f.runtime.invalidateReference('FIRST')
      await f.runtime.handle('remote-list-issues', f.request, signal, async () => {})
      expect(conditionals).toEqual([null, '"etag-1"', null, null])
      expect(fetch).toHaveBeenCalled()
    } finally { await f.runtime.dispose() }
  })
})

describe('GitLab object collections and current approvals', () => {
  it('reads commits, issue notes and independently identified discussions without inventing review history', async () => {
    const f = fixture(), head = 'a'.repeat(40), base = 'b'.repeat(40), start = 'c'.repeat(40)
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url)); calls.push(parsed.pathname)
      if (parsed.pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      if (parsed.pathname.endsWith('/merge_requests/7/commits')) return json([{ id: head, title: 'Commit', author_name: 'Alice' }], 200, { 'x-next-page': '' })
      if (parsed.pathname.endsWith('/issues/7/notes')) return json([{ id: 101, body: 'Issue comment', author: null, system: false }], 200, { 'x-next-page': '' })
      if (parsed.pathname.endsWith('/merge_requests/7/discussions')) return json([{ id: 'thread-1', notes: [{ id: 102, body: 'Diff note', author: null, resolvable: true, resolved: false, position: { base_sha: base, start_sha: start, head_sha: head, old_path: 'old', new_path: 'new', old_line: 4, new_line: 5, line_range: { start: { old_line: 4, new_line: 5 }, end: { old_line: 6, new_line: 7 } } } }] }], 200, { 'x-next-page': '' })
      if (parsed.pathname.endsWith('/merge_requests/7/approvals')) return json({ project_id: 42, iid: 7, approved_by: [{ user: { id: 9, username: 'reviewer' } }], approvals_left: 1 })
      throw Error('unexpected fixture request')
    })
    try {
      const commits = await f.runtime.handle('remote-commits', { ...f.request, number: 7 }, signal, async () => {}) as any
      expect(commits.value.items).toEqual([{ sha: head, subject: 'Commit', authorName: 'Alice' }])
      const notes = await f.runtime.handle('remote-comments', { ...f.request, number: 7, objectKind: 'issue' }, signal, async () => {}) as any
      expect(notes.value.items[0]).toMatchObject({ id: '101', body: 'Issue comment' }); expect(notes.value.items[0]).not.toHaveProperty('discussionId')
      const threads = await f.runtime.handle('remote-discussions', { ...f.request, number: 7, objectKind: 'pull' }, signal, async () => {}) as any
      expect(threads.value.items[0]).toMatchObject({ id: 'thread-1', notes: [{ id: '102', discussionId: 'thread-1', resolved: false, position: { oldLine: 4, newLine: 5, lineRange: { end: { oldLine: 6, newLine: 7 } } } }] })
      const approvals = await f.runtime.handle('remote-approvals', { ...f.request, number: 7 }, signal, async () => {}) as any
      expect(approvals.value).toEqual({ approvedBy: [{ userId: '9', login: 'reviewer' }], approvalsLeft: 1 })
      expect(approvals.value).not.toHaveProperty('approved')
      expect(calls).toContain('/gitlab/api/v4/projects/42/issues/7/notes')
      expect(calls).toContain('/gitlab/api/v4/projects/42/merge_requests/7/discussions')
      const before = calls.length
      await expect(f.runtime.handle('remote-comments', { ...f.request, number: 7, objectKind: 'pull', inline: true }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-unavailable' })
      expect(calls).toHaveLength(before)
      await expect(f.runtime.handle('remote-reviews', { ...f.request, number: 7 }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'not-implemented' } })
    } finally { await f.runtime.dispose() }
  })
  it('does not turn denied approval data into an empty approval snapshot', async () => {
    const f = fixture()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/projects/group%2F') ? json({ id: 42, path_with_namespace: 'group/sub/repo' }) : json({}, 403))
    try { await expect(f.runtime.handle('remote-approvals', { ...f.request, number: 7 }, signal, async () => {})).rejects.toMatchObject({ code: 'git/insufficient-scope' }) } finally { await f.runtime.dispose() }
  })
})

describe('GitLab comparison snapshot', () => {
  it('binds continuation to base/start/head and reports unavailable large diffs honestly', async () => {
    const f = fixture(), base = 'a'.repeat(40), start = 'b'.repeat(40), head = 'c'.repeat(40)
    let currentHead = head
    const paths: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url)); paths.push(parsed.pathname)
      if (parsed.pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      if (parsed.pathname.endsWith('/merge_requests/7')) return json({ id: 900, iid: 7, title: 'MR', description: '', state: 'opened', author: null, source_project_id: 42, target_project_id: 42, source_branch: 'feature', target_branch: 'main', sha: currentHead, diff_refs: { base_sha: base, start_sha: start, head_sha: currentHead } })
      if (parsed.pathname.endsWith('/diffs') && parsed.searchParams.get('page') === '1') return json([{ old_path: 'old.txt', new_path: 'new.txt', renamed_file: true, new_file: false, deleted_file: false, diff: '@@ -1 +1 @@\n-old\n+new' }], 200, { 'x-next-page': '2' })
      if (parsed.pathname.endsWith('/diffs') && parsed.searchParams.get('page') === '2') return json([{ old_path: 'large.bin', new_path: 'large.bin', renamed_file: false, new_file: false, deleted_file: false, too_large: true }], 200, { 'x-next-page': '' })
      throw Error('unexpected fixture request')
    })
    try {
      const first = await f.runtime.handle('remote-files', { ...f.request, number: 7 }, signal, async () => {}) as any
      expect(first.value).toMatchObject({ baseSha: base, startSha: start, headSha: head, serverCompleteness: 'unknown', files: { items: [{ oldPath: 'old.txt', newPath: 'new.txt', status: 'renamed', content: 'available' }], truncated: true } })
      const cursor = first.value.files.next, expected = { expectedBaseSha: base, expectedStartSha: start, expectedHeadSha: head }
      const second = await f.runtime.handle('remote-files', { ...f.request, number: 7, cursor, ...expected }, signal, async () => {}) as any
      expect(second.value.files).toEqual({ items: [{ oldPath: 'large.bin', newPath: 'large.bin', status: 'modified', content: 'too-large' }], truncated: false })
      currentHead = 'd'.repeat(40)
      const before = paths.filter(path => path.endsWith('/diffs')).length
      await expect(f.runtime.handle('remote-files', { ...f.request, number: 7, cursor, ...expected }, signal, async () => {})).rejects.toMatchObject({ code: 'git/head-moved' })
      expect(paths.filter(path => path.endsWith('/diffs'))).toHaveLength(before)
    } finally { await f.runtime.dispose() }
  })
  it('discards files when the head changes during the comparison', async () => {
    const f = fixture(), base = 'a'.repeat(40), start = 'b'.repeat(40), head = 'c'.repeat(40), moved = 'd'.repeat(40)
    let diffLoaded = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const pathname = new URL(String(url)).pathname
      if (pathname.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/sub/repo' })
      if (pathname.endsWith('/merge_requests/7')) { const sha = diffLoaded ? moved : head; return json({ id: 900, iid: 7, title: 'MR', description: '', state: 'opened', author: null, source_project_id: 42, target_project_id: 42, source_branch: 'feature', target_branch: 'main', sha, diff_refs: { base_sha: base, start_sha: start, head_sha: sha } }) }
      if (pathname.endsWith('/diffs')) { diffLoaded = true; return json([{ old_path: 'a', new_path: 'a', new_file: false, renamed_file: false, deleted_file: false, diff: 'content' }], 200, { 'x-next-page': '' }) }
      throw Error('unexpected fixture request')
    })
    try { await expect(f.runtime.handle('remote-files', { ...f.request, number: 7 }, signal, async () => {})).rejects.toMatchObject({ code: 'git/head-moved' }) } finally { await f.runtime.dispose() }
  })
})
