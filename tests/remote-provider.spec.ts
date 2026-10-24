import { describe, expect, it, vi } from 'vitest'
import { GitHubProvider } from '../src/remote/github.ts'
import { GitRemoteHttp } from '../src/remote/http.ts'
import { GitRemoteAuth } from '../src/remote/auth.ts'
import { resolveRemoteSettings } from '../src/remote/settings.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import { apiPath, avatarUrl, browserUrl } from '../src/remote/github-model.ts'

const REPO = { provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' } as const
const SIG = new AbortController().signal
const sha = 'a'.repeat(40)
const issue = { number: 1, title: 'Example', body: null, state: 'open', user: { id: 1, login: 'alice' }, html_url: 'https://github.com/owner/repo/issues/1', created_at: '2024-01-01T00:00:00Z' }
const branch = { ref: 'main', sha, repo: { owner: { login: 'owner' }, name: 'repo' } }
const pull = { ...issue, head: branch, base: branch, draft: false }
function response(body: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }) }
function setup(handler: (path: string, init: { headers: Record<string, string> | undefined; signal: AbortSignal; method: string; body: string | undefined }) => Promise<Response> = async () => response([]), pageLimit = 10) {
  let token: string | undefined = 'token-a'
  let t = 1000
  const calls: { path: string; headers: Record<string, string> | undefined }[] = []
  const service: GitRemoteCredentialService = { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {}, resolve: async ref => String(ref) === 'GH_TOKEN' && token !== undefined ? { value: token, source: 'env' } : undefined, describe: async () => ({ configured: true, writable: true }), describeRecord: async () => ({ configured: false, writable: true }) }
  const http = new GitRemoteHttp({ fetch: async (url, init) => { const path = new URL(url).pathname + new URL(url).search; calls.push({ path, headers: init.headers }); return path === '/user' ? response({ id: token === 'token-a' ? 1 : 2, login: 'same-login' }) : handler(path, init) } })
  const auth = new GitRemoteAuth({ credentials: service, http, settings: resolveRemoteSettings(undefined) })
  const provider = new GitHubProvider(auth, http, { now: () => t, pageLimit })
  return { provider, calls, auth, token: (value: string | undefined) => { token = value }, advance: (ms: number) => { t += ms } }
}

describe('GitHub provider reads', () => {
  it('projects merged state, explicit fork identities and drops foreign browser URLs and raw fields', async () => {
    const s = setup(async () => response({ ...pull, state: 'closed', merged_at: 'today', html_url: 'https://evil.example/token', access_token: 'should-never-cross-wire', head: { ...branch, repo: { owner: { login: 'fork' }, name: 'fork' } } }))
    const result = await s.provider.pull(REPO, 1, { signal: SIG })
    expect(result.value).toMatchObject({ state: 'merged', rawState: 'closed', createdAt: '2024-01-01T00:00:00Z', head: { repository: { owner: 'fork' } }, base: { repository: { owner: 'owner' } } })
    expect(JSON.stringify(result)).not.toMatch(/evil|should-never|access_token/)
    expect(s.calls[1]?.headers).toMatchObject({ authorization: 'Bearer token-a', 'X-GitHub-Api-Version': '2022-11-28' })
  })
  it('validates viewer once per generation and isolates caches for same login with different stable ids', async () => {
    let conditional = false
    const s = setup(async (_path, init) => { conditional = init.headers?.['if-none-match'] !== undefined; return conditional ? response(null, 304) : response([pull], 200, { etag: 'etag-a' }) })
    await s.provider.pulls(REPO, 'open', {}, { signal: SIG })
    expect((await s.provider.pulls(REPO, 'open', {}, { signal: SIG })).value.items).toHaveLength(1)
    expect(conditional).toBe(true)
    expect(s.calls.filter(c => c.path === '/user')).toHaveLength(1)
    s.token('token-b')
    await s.provider.pulls(REPO, 'open', {}, { signal: SIG })
    expect(conditional).toBe(false)
    expect(s.calls.filter(c => c.path === '/user')).toHaveLength(2)
  })
  it('bounds pages per request, resumes from the next cursor, excludes PRs from issues and rejects malicious Link before sending credentials', async () => {
    const s = setup(async path => response([issue, { ...issue, pull_request: {} }], 200, { link: `<https://api.github.com${path.includes('page=2') ? '/third' : '/repos/owner/repo/issues?page=2'}>; rel="next"` }), 2)
    const first = await s.provider.issues(REPO, 'open', {}, { signal: SIG })
    expect(first.value).toMatchObject({ items: [{ number: 1 }], truncated: true, next: '/repos/owner/repo/issues?page=2' })
    const burst = await s.provider.issues(REPO, 'open', { pages: 2 }, { signal: SIG })
    expect(burst.value).toMatchObject({ items: [{ number: 1 }, { number: 1 }], truncated: true, next: '/third' })
    const resumed = await s.provider.issues(REPO, 'open', { cursor: '/third' }, { signal: SIG })
    expect(resumed.value.items).toHaveLength(1)
    const evil = setup(async () => response([], 200, { link: '<https://evil.example/x>; rel="next"' }))
    await expect(evil.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toMatchObject({ code: 'git/remote-unavailable' })
    expect(evil.calls).toHaveLength(2)
  })
  it('projects pull commits and reviews, resuming each from its own cursor', async () => {
    const s = setup(async path => {
      if (path.includes('/commits')) return response([{ sha, commit: { message: 'Subject line\n\nbody', author: { date: '2024-01-01T00:00:00Z' }, committer: { date: '2024-01-03T00:00:00Z' } }, author: { id: 5, login: 'bob' }, html_url: `https://github.com/owner/repo/commit/${sha}` }], 200, path.includes('page=2') ? {} : { link: '<https://api.github.com/repos/owner/repo/pulls/1/commits?page=2>; rel="next"' })
      return response([{ id: 9, user: { id: 2, login: 'carol' }, state: 'CHANGES_REQUESTED', body: 'fix it', html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-9', submitted_at: '2024-01-02T00:00:00Z', commit_id: sha }])
    })
    const commits = await s.provider.commits(REPO, 1, {}, { signal: SIG })
    expect(commits.value.items[0]).toMatchObject({ sha, subject: 'Subject line', author: { login: 'bob' }, date: '2024-01-01T00:00:00Z', committedAt: '2024-01-03T00:00:00Z', url: `https://github.com/owner/repo/commit/${sha}` })
    expect(commits.value.next).toBe('/repos/owner/repo/pulls/1/commits?page=2')
    const reviews = await s.provider.reviews(REPO, 1, {}, { signal: SIG })
    expect(reviews.value.items[0]).toMatchObject({ id: '9', author: { login: 'carol' }, state: 'changes-requested', rawState: 'CHANGES_REQUESTED', body: 'fix it', submittedAt: '2024-01-02T00:00:00Z', commitSha: sha })
    const continued = await s.provider.commits(REPO, 1, { cursor: commits.value.next }, { signal: SIG })
    expect(s.calls.some(call => call.path === '/repos/owner/repo/pulls/1/commits?page=2')).toBe(true)
    expect(continued.value.next).toBeUndefined()
  })
  it('admits avatars only from the GitHub avatar host', async () => {
    const good = 'https://avatars.githubusercontent.com/u/7?v=4'
    for (const bad of ['https://github.com/avatar.png', 'http://avatars.githubusercontent.com/u/7', 'https://user:pw@avatars.githubusercontent.com/u/7', 'javascript:x', 7, null]) {
      expect(avatarUrl(bad)).toBeUndefined()
    }
    expect(avatarUrl(good)).toBe(good)
    const s = setup(async () => response([{ id: 3, body: 'note', user: { id: 7, login: 'dan', avatar_url: good }, created_at: '2024-01-04T00:00:00Z' }]))
    expect((await s.provider.comments(REPO, 1, false, {}, { signal: SIG })).value.items[0]?.author?.avatarUrl).toBe(good)
    const b = setup(async () => response([{ id: 4, body: 'x', user: { id: 8, login: 'eve', avatar_url: 'https://evil.example/a.png' } }]))
    expect((await b.provider.comments(REPO, 1, false, {}, { signal: SIG })).value.items[0]?.author?.avatarUrl).toBeUndefined()
  })
  it('projects comment timestamps when present', async () => {
    const s = setup(async () => response([{ id: 3, body: 'note', user: { id: 7, login: 'dan' }, created_at: '2024-01-04T00:00:00Z' }]))
    const comments = await s.provider.comments(REPO, 1, false, {}, { signal: SIG })
    expect(comments.value.items[0]).toMatchObject({ id: '3', createdAt: '2024-01-04T00:00:00Z' })
  })
  it('keeps missing permission bits unknown and never derives actions from writable storage', async () => {
    const s = setup(async () => response({ permissions: { pull: true, push: false } }))
    expect((await s.provider.repository(REPO, { signal: SIG })).value).toMatchObject({ viewer: { userId: '1' }, permissions: { push: false }, actions: { canMerge: false, canComment: true, canClose: 'unknown' } })
    const anonymous = setup(async () => response({}))
    anonymous.token(undefined)
    expect((await anonymous.provider.repository(REPO, { signal: SIG })).value.actions.canComment).toBe(false)
  })
  it('makes anonymous reads manual and enforces authenticated poll intervals', async () => {
    const s = setup(async () => response([], 200, { 'x-poll-interval': '120' }))
    await s.provider.pulls(REPO, 'open', {}, { signal: SIG })
    s.advance(60_000)
    await expect(s.provider.pulls(REPO, 'open', {}, { signal: SIG, automatic: true })).rejects.toMatchObject({ code: 'git/rate-limited' })
    s.advance(60_000)
    await s.provider.pulls(REPO, 'open', {}, { signal: SIG, automatic: true })
    const a = setup(); a.token(undefined)
    await expect(a.provider.pulls(REPO, 'open', {}, { signal: SIG, automatic: true })).rejects.toMatchObject({ code: 'git/remote-unavailable' })
    expect(a.calls).toHaveLength(0)
  })
  it.each([429, 403])('backs off status %s without automatic retries', async status => {
    const s = setup(async () => response({ message: 'secondary rate limit' }, status, { 'retry-after': '120' }))
    await expect(s.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toMatchObject({ code: 'git/rate-limited', details: { resetAt: 121000 } })
    await expect(s.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toMatchObject({ code: 'git/rate-limited' })
    expect(s.calls).toHaveLength(2)
  })
  it('normalizes SSO and invalid credentials with no response body leakage', async () => {
    const sso = setup(async () => response({ message: 'private-secret' }, 403, { 'x-github-sso': 'required; url=private' }))
    await expect(sso.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toMatchObject({ code: 'git/insufficient-scope', details: { reason: 'sso-required' } })
    const invalid = setup(async () => response({ message: 'private-secret' }, 401))
    await expect(invalid.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toMatchObject({ code: 'git/unauthenticated' })
    await expect(invalid.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toMatchObject({ code: 'git/unauthenticated' })
    expect(invalid.calls).toHaveLength(2)
  })
  it('rejects a stale result after account changes during transport', async () => {
    const s = setup(async () => { s.token('token-b'); return response([pull]) })
    await expect(s.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
  })
  it('cancels and drains requests and queued operations on unload', async () => {
    let entered: (() => void) | undefined
    const ready = new Promise<void>(resolve => { entered = resolve })
    const s = setup(async () => { entered?.(); return new Promise<Response>(() => {}) })
    const first = expect(s.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toBeDefined()
    const queued = expect(s.provider.issues(REPO, 'open', {}, { signal: SIG })).rejects.toBeDefined()
    await ready
    await s.provider.dispose()
    await Promise.all([first, queued])
    expect(s.calls).toHaveLength(2)
    await expect(s.provider.pulls(REPO, 'open', {}, { signal: SIG })).rejects.toBeDefined()
  })
  it('keeps browser and API allowlists separate', () => {
    expect(browserUrl('https://api.github.com/user')).toBeUndefined()
    expect(browserUrl('https://github.com.evil.example/x')).toBeUndefined()
    expect(() => apiPath('https://github.com/user')).toThrow()
    expect(() => apiPath('https://api.github.com@evil.example/x')).toThrow()
  })
})


describe('protected provider writes', () => {
  async function expected(s: ReturnType<typeof setup>) {
    const result = await s.provider.repository(REPO, { signal: SIG })
    return { ...REPO, expectedGeneration: result.generation, expectedViewer: { host: 'github.com', userId: result.value.viewer!.userId } }
  }
  it('sends the checked token and merge SHA and rejects stale stable viewer ids', async () => {
    let sent: { body: string | undefined; token: string | undefined } | undefined
    const s = setup(async (path, init) => {
      if (init.method !== 'GET') { sent = { body: init.body, token: init.headers?.['authorization'] }; return response({ merged: true }) }
      return response(path.endsWith('/pulls/1') ? pull : { permissions: { push: true } })
    })
    const e = await expected(s)
    await s.provider.write(REPO, e, { kind: 'merge-pr', number: 1, expectedHeadSha: sha, method: 'squash' }, { signal: SIG })
    expect(sent).toEqual({ body: JSON.stringify({ sha, merge_method: 'squash' }), token: 'Bearer token-a' })
    sent = undefined; s.token('token-b')
    await expect(s.provider.write(REPO, e, { kind: 'comment', number: 1, body: 'hello' }, { signal: SIG })).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
    expect(sent).toBeUndefined()
  })
  it('rejects head races and credential changes after validation without sending', async () => {
    let writes = 0; let change = false
    const s = setup(async (path, init) => {
      if (init.method !== 'GET') writes += 1
      if (change && path.endsWith('/pulls/1')) s.token('token-b')
      return response(path.endsWith('/pulls/1') ? pull : {})
    })
    const e = await expected(s)
    await expect(s.provider.write(REPO, e, { kind: 'review', number: 1, body: '', expectedHeadSha: 'b'.repeat(40), event: 'APPROVE' }, { signal: SIG })).rejects.toMatchObject({ code: 'git/head-moved' })
    change = true
    await expect(s.provider.write(REPO, e, { kind: 'comment', number: 1, body: 'hi' }, { signal: SIG })).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
    expect(writes).toBe(0)
  })
  it('returns unknown for sent failures and never retries a mutating request', async () => {
    let writes = 0
    const s = setup(async (path, init) => {
      if (init.method !== 'GET') { writes += 1; throw new Error('secret response lost') }
      return response(path.endsWith('/pulls/1') ? pull : {})
    })
    await expect(s.provider.write(REPO, await expected(s), { kind: 'comment', number: 1, body: 'hello' }, { signal: SIG })).rejects.toMatchObject({ code: 'git/write-result-unknown' })
    expect(writes).toBe(1)
  })
  it('binds review and inline coordinates to the same commit and uses modern line/side fields', async () => {
    let payload: Record<string, unknown> | undefined
    const s = setup(async (path, init) => { if (init.method !== 'GET') { payload = JSON.parse(init.body!); return response({ id: 4 }) }; return response(path.endsWith('/files?per_page=100') ? [{ filename: 'a.ts', status: 'modified', additions: 0, deletions: 0, patch: '@@ -3,3 +3,3 @@\n a\n b\n c' }] : path.endsWith('/pulls/1') ? pull : {}) })
    await s.provider.write(REPO, await expected(s), { kind: 'inline-comment', number: 1, body: 'hello', expectedHeadSha: sha, path: 'a.ts', line: 5, side: 'RIGHT', startLine: 3, startSide: 'RIGHT' }, { signal: SIG })
    expect(payload).toEqual({ body: 'hello', path: 'a.ts', commit_id: sha, line: 5, side: 'RIGHT', start_line: 3, start_side: 'RIGHT' })
    expect(payload).not.toHaveProperty('position')
  })
})

describe('remote notifications', () => {
  it('projects review requests and own closed PR events with stable ids', async () => {
    const s = setup(async path => {
      if (path.includes('/notifications')) return response([{ id: 'n1', updated_at: 'today', reason: 'review_requested', subject: { type: 'PullRequest', url: 'https://api.github.com/repos/owner/repo/pulls/1' } }])
      return response({ ...pull, state: 'closed', merged_at: 'today' })
    })
    const notices = await s.provider.notifications(REPO, { signal: SIG })
    expect(notices.value.items.map(item => item.kind)).toEqual(['review-requested', 'merged'])
    expect(notices.value.items[0]?.id).toBe('n1/today/review')
  })
})
