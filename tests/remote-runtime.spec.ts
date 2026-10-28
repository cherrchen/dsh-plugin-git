import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteRuntime } from '../src/remote/runtime.ts'
import { GitRemoteGit } from '../src/remote/git.ts'
import { isRepositoryWrite } from '../src/session-directory.ts'
import type { GitService } from '../src/service.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
const repo = { provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' } as const
const signal = new AbortController().signal
const sha = 'a'.repeat(40)
const branch = { ref: 'main', sha, repo: { owner: { login: 'owner' }, name: 'repo' } }
const pr = { number: 1, state: 'open', title: 'PR', body: '', user: { id: 1, login: 'alice' }, head: branch, base: branch }
const file = { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }
const commit = { sha, commit: { message: 'Subject line\n\nbody', author: { date: '2024-01-01T00:00:00Z' } }, author: { id: 5, login: 'bob' }, html_url: `https://github.com/owner/repo/commit/${sha}` }
const review = { id: 9, user: { id: 2, login: 'carol' }, state: 'CHANGES_REQUESTED', body: 'fix it', html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-9', submitted_at: '2024-01-02T00:00:00Z', commit_id: sha }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture(handler?: (url: string, init: RequestInit) => Promise<Response>) {
  const writes: RequestInit[] = []
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== 'GET') { writes.push(init); if (handler !== undefined) return handler(url, init); return json({ id: 1 }) }
    reads.push(url)
    return json(url.endsWith('/user') ? { id: 1, login: 'alice' } : url.includes('/pulls/1/files') ? [file] : url.includes('/pulls/1/commits') ? [commit] : url.includes('/pulls/1/reviews') ? [review] : url.endsWith('/pulls/1') ? pr : url.includes('/pulls?') ? [pr] : { permissions: { push: true }, allow_merge_commit: true, allow_squash_merge: true })
  }))
  const credentials: GitRemoteCredentialService = { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {}, resolve: async () => ({ value: 'SENTINEL_TOKEN', source: 'env' }), describe: async () => ({ configured: true, writable: false }), describeRecord: async () => ({ configured: false, writable: false }) }
  const service = { remoteCommand: async (_root: string, args: string[]) => args[1] === 'get-url' ? 'git@github.com:owner/repo.git\n' : 'origin\n' } as unknown as GitService
  const runtime = new GitRemoteRuntime(credentials, { spawn: () => { throw new Error('unexpected subprocess') }, resolveExecutable: async () => { throw new Error('unexpected subprocess') } }, service)
  return { runtime, writes, reads, service }
}
async function context(runtime: GitRemoteRuntime) {
  const facts = await runtime.handle('remote-repository', { ...repo, repository: '/repo' }, signal, async () => {}) as { generation: unknown; value: { viewer: unknown } }
  return { ...repo, repository: '/repo', expectedGeneration: facts.generation, expectedViewer: facts.value.viewer, number: 1, body: 'hello', requestId: 'submission-1234' }
}
describe('remote RPC owner', () => {
  it('checks the live local repository before send and deduplicates repeated submissions', async () => {
    const { runtime, writes } = fixture()
    const expected = await context(runtime)
    const check = vi.fn(async () => {})
    const [a, b] = await Promise.all([runtime.handle('remote-comment', expected, signal, check), runtime.handle('remote-comment', expected, signal, check)])
    expect(a).toEqual(b); expect(writes).toHaveLength(1)
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(a)).not.toContain('SENTINEL')
    await runtime.dispose()
  })
  it('holds unknown outcomes for the same submission id and never resends', async () => {
    const { runtime, writes } = fixture(async () => { throw new Error('SENTINEL_TOKEN: lost reply') })
    const expected = await context(runtime)
    for (let i = 0; i < 2; i += 1) await expect(runtime.handle('remote-comment', expected, signal, async () => {})).rejects.toMatchObject({ code: 'git/write-result-unknown' })
    expect(writes).toHaveLength(1)
    await runtime.dispose()
  })
  it('rejects changed session directories at the final pre-send check', async () => {
    const { runtime, writes } = fixture()
    const expected = await context(runtime)
    let checks = 0
    await expect(runtime.handle('remote-comment', expected, signal, async () => { checks += 1; if (checks >= 3) throw new Error('workspace moved') })).rejects.toMatchObject({ code: 'git/remote-unavailable' })
    expect(writes).toHaveLength(0)
    await runtime.dispose()
  })
  it('resumes paged reads from an opaque cursor and pins continued files to the confirmed snapshot', async () => {
    const { runtime, reads } = fixture()
    const expected = await context(runtime)
    const list = await runtime.handle('remote-list-prs', { ...expected, cursor: '/repos/owner/repo/pulls?page=2' }, signal, async () => {}) as { value: { items: unknown[] } }
    expect(list.value.items).toHaveLength(1)
    expect(reads.some(url => url.includes('/pulls?page=2'))).toBe(true)
    const page = await runtime.handle('remote-files', { ...expected, number: 1, cursor: '/repos/owner/repo/pulls/1/files?page=2', expectedHeadSha: sha, expectedBaseSha: sha }, signal, async () => {}) as { value: { files: { items: { path: string }[] } } }
    expect(page.value.files.items[0]?.path).toBe('a.ts')
    await expect(runtime.handle('remote-files', { ...expected, number: 1, cursor: '/repos/owner/repo/pulls/1/files?page=3', expectedHeadSha: 'b'.repeat(40), expectedBaseSha: sha }, signal, async () => {})).rejects.toMatchObject({ code: 'git/head-moved' })
    await expect(runtime.handle('remote-list-prs', { ...expected, cursor: 'https://evil.example/x' }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-unavailable' })
    await runtime.dispose()
  })
  it('dispatches commit and review reads with cursor forwarding and neutral projection', async () => {
    const { runtime, reads } = fixture()
    const expected = await context(runtime)
    const commits = await runtime.handle('remote-commits', { ...expected, number: 1 }, signal, async () => {}) as { value: { items: { sha: string; subject: string; author: { login: string } | null }[] } }
    expect(commits.value.items[0]).toMatchObject({ sha, subject: 'Subject line', author: { login: 'bob' } })
    const reviews = await runtime.handle('remote-reviews', { ...expected, number: 1, cursor: '/repos/owner/repo/pulls/1/reviews?page=2' }, signal, async () => {}) as { value: { items: { id: string; state: string; rawState: string; commitSha: string }[] } }
    expect(reviews.value.items[0]).toMatchObject({ id: '9', state: 'changes-requested', rawState: 'CHANGES_REQUESTED', commitSha: sha })
    expect(reads.some(url => url.includes('/pulls/1/commits'))).toBe(true)
    expect(reads.some(url => url.includes('/pulls/1/reviews?page=2'))).toBe(true)
    await runtime.dispose()
  })
  it('classifies all remote repository mutators as writes', () => {
    for (const endpoint of ['remote-comment', 'remote-inline-comment', 'remote-review', 'remote-create-pr', 'remote-close-pr', 'remote-merge-pr', 'remote-checkout-pr', 'remote-issue-branch']) expect(isRepositoryWrite(endpoint)).toBe(true)
    for (const endpoint of ['remote-capability', 'remote-list-prs', 'remote-pr', 'remote-list-issues', 'remote-issue', 'remote-comments', 'remote-files', 'remote-commits', 'remote-reviews', 'remote-notifications']) expect(isRepositoryWrite(endpoint)).toBe(false)
  })
})

describe('scoped GitHub adapter', () => {
  it('projects repository facts, binds writes to instance and content, and preserves v1 behavior', async () => {
    const { runtime, writes } = fixture()
    const scope = { remoteProtocol: 2, provider: 'github', instance: 'https://github.com', owner: repo.owner, repo: repo.repo, repository: '/repo' }
    const facts = await runtime.handle('remote-repository', scope, signal, async () => {}) as any
    expect(facts).toMatchObject({ remoteProtocol: 2, scope: { provider: 'github', instance: 'https://github.com' }, value: { actionScope: { path: 'owner/repo' }, operationSupport: { comment: { supported: true }, 'create-pr': { supported: true } }, actions: { canCreatePr: 'unknown', canMerge: 'unknown' } } })
    const command = { ...scope, expectedInstance: 'https://github.com', expectedGeneration: facts.generation, expectedViewer: facts.value.viewer, number: 1, body: 'hello', requestId: 'scoped-submission-1' }
    await expect(runtime.handle('remote-comment', { ...command, expectedInstance: 'https://other.example' }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
    expect(writes).toHaveLength(0)
    const result = await runtime.handle('remote-comment', command, signal, async () => {}) as any
    expect(result).toMatchObject({ remoteProtocol: 2, generation: facts.generation, value: { outcome: 'succeeded', steps: [{ kind: 'comment', state: 'succeeded' }] } })
    await runtime.handle('remote-comment', command, signal, async () => {})
    await expect(runtime.handle('remote-comment', { ...command, body: 'different' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'submission-conflict' } })
    expect(writes).toHaveLength(1)
    const legacy = await context(runtime)
    await runtime.handle('remote-comment', { ...legacy, requestId: command.requestId }, signal, async () => {})
    expect(writes).toHaveLength(2)
    await runtime.dispose()
  })
  it('rejects unsupported scoped actions before falling back or sending a write', async () => {
    const { runtime, writes } = fixture()
    const scope = { remoteProtocol: 2, provider: 'github', instance: 'https://github.com', owner: repo.owner, repo: repo.repo, repository: '/repo' }
    await expect(runtime.handle('remote-nonexistent-write', scope, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'not-implemented' } })
    await expect(runtime.handle('remote-merge-pr', { ...scope, expectedInstance: 'https://github.com', method: 'rebase' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'not-supported' } })
    expect(writes).toHaveLength(0); await runtime.dispose()
  })
})

describe('scoped GitHub pull creation', () => {
  it('requires an allowed local head remote before sending and keeps the expected instance', async () => {
    const { runtime, writes } = fixture()
    const scope = { remoteProtocol: 2, provider: 'github', instance: 'https://github.com', owner: repo.owner, repo: repo.repo, repository: '/repo' }
    const facts = await runtime.handle('remote-repository', scope, signal, async () => {}) as any
    const payload = { ...scope, expectedInstance: scope.instance, expectedGeneration: facts.generation, expectedViewer: facts.value.viewer, title: 'title', body: 'body', headRef: 'feature', baseRef: 'main', requestId: 'create-request-123' }
    await expect(runtime.handle('remote-create-pr', { ...payload, head: { provider: 'gitlab', owner: 'owner', repo: 'repo' } }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
    await expect(runtime.handle('remote-create-pr', { ...payload, head: { provider: 'github', owner: 'outsider', repo: 'repo' } }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
    expect(writes).toHaveLength(0)
    const answer = await runtime.handle('remote-create-pr', { ...payload, head: { provider: 'github', owner: 'owner', repo: 'repo' } }, signal, async () => {}) as any
    expect(answer.value.outcome).toBe('succeeded'); expect(writes).toHaveLength(1)
    await runtime.dispose()
  })
})

describe('scoped GitHub issue action facts', () => {
  it('does not project pull write support onto an issue', async () => {
    const { runtime } = fixture()
    const facts = await runtime.handle('remote-repository', { remoteProtocol: 2, provider: 'github', instance: 'https://github.com', owner: 'owner', repo: 'repo', repository: '/repo', object: { kind: 'issue', number: 1 } }, signal, async () => {}) as any
    expect(facts.value.actionScope.object).toEqual({ kind: 'issue', number: 1 })
    expect(facts.value.actions).toEqual({ canComment: false, canReview: false, canMerge: false, canClose: false, canCreatePr: false })
    expect(Object.values(facts.value.operationSupport).every((entry: any) => entry.supported === false)).toBe(true)
    expect(facts.value.supportedReviewEvents).toEqual([]); await runtime.dispose()
  })
})

describe('scoped GitHub action guards', () => {
  it('rejects an issue action even when the issue number collides with a pull number', async () => {
    const { runtime, writes } = fixture()
    const legacy = await context(runtime)
    await expect(runtime.handle('remote-comment', { ...legacy, remoteProtocol: 2, provider: 'github', instance: 'https://github.com', expectedInstance: 'https://github.com', object: { kind: 'issue', number: 1 } }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'not-supported' } })
    expect(writes).toHaveLength(0); await runtime.dispose()
  })
})


describe('scoped GitHub local receipts', () => {
  it('returns the checked checkout snapshot and preserves partial effects', async () => {
    const { runtime } = fixture()
    const confirmed = await context(runtime)
    vi.spyOn(GitRemoteGit.prototype, 'checkout').mockResolvedValue({ switched: false, privateRefWritten: true, trackingRefPrepared: false, fetchMappingAdded: false, upstreamNotConfigured: true, branch: 'feature', error: 'head-moved' })
    const result = await runtime.handle('remote-checkout-pr', { ...confirmed, remoteProtocol: 2, provider: 'github', instance: 'https://github.com', expectedInstance: 'https://github.com', expectedHeadSha: sha, requestId: 'checkout-123' }, signal, async () => {}) as any
    expect(result.generation).toEqual(confirmed.expectedGeneration)
    expect(result.value).toMatchObject({ outcome: 'partial', receipt: { privateRefWritten: true, switched: false, error: 'head-moved' } })
    await runtime.dispose()
  })
  it('reports branch creation when a later switch fails without repeating creation', async () => {
    const { runtime, service } = fixture()
    const methods = service as unknown as { createBranch: ReturnType<typeof vi.fn>; switchBranch: ReturnType<typeof vi.fn> }
    methods.createBranch = vi.fn(async () => ({})); methods.switchBranch = vi.fn(async () => { throw new Error('switch failed') })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/user') ? { id: 1, login: 'alice' } : url.endsWith('/issues/1') ? { number: 1, state: 'open', title: 'Issue task', body: '', user: { id: 1, login: 'alice' } } : { permissions: { push: true } })))
    const facts = await runtime.handle('remote-repository', { ...repo, repository: '/repo' }, signal, async () => {}) as any
    const request = { ...repo, repository: '/repo', remoteProtocol: 2, provider: 'github', instance: 'https://github.com', expectedInstance: 'https://github.com', expectedGeneration: facts.generation, expectedViewer: facts.value.viewer, number: 1, object: { kind: 'issue', number: 1 }, requestId: 'branch-request-123' }
    const result = await runtime.handle('remote-issue-branch', request, signal, async () => {}) as any
    expect(result).toMatchObject({ generation: facts.generation, value: { outcome: 'partial', steps: [{ kind: 'create-branch', state: 'succeeded' }, { kind: 'switch-branch', state: 'unknown' }], receipt: { branch: 'issue-1-issue-task' } } })
    await runtime.handle('remote-issue-branch', request, signal, async () => {})
    expect(methods.createBranch).toHaveBeenCalledOnce(); expect(methods.switchBranch).toHaveBeenCalledOnce(); await runtime.dispose()
  })
})

describe('scoped GitHub repository merge policy', () => {
  it('derives methods from the repository and rechecks the chosen method before writing', async () => {
    const { runtime } = fixture(); let squash = true; const writes: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (init.method !== 'GET') { writes.push(init); return json({ merged: true }) }
      return json(url.endsWith('/user') ? { id: 1, login: 'alice' } : url.endsWith('/pulls/1') ? pr : { permissions: { push: true }, allow_merge_commit: false, allow_squash_merge: squash })
    }))
    const scope = { remoteProtocol: 2, provider: 'github', instance: 'https://github.com', repository: '/repo', owner: 'owner', repo: 'repo' }
    const facts = await runtime.handle('remote-repository', scope, signal, async () => {}) as any
    expect(facts.value.supportedMergeMethods).toEqual(['squash'])
    const command = { ...scope, expectedInstance: scope.instance, expectedGeneration: facts.generation, expectedViewer: facts.value.viewer, number: 1, expectedHeadSha: sha, method: 'squash', requestId: 'merge-policy-123' }
    squash = false
    await expect(runtime.handle('remote-merge-pr', command, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'not-supported' } })
    expect(writes).toHaveLength(0)
    const updated = await runtime.handle('remote-repository', scope, signal, async () => {}) as any
    expect(updated.value).toMatchObject({ actions: { canMerge: false }, operationSupport: { 'merge-pr': { supported: false } }, supportedMergeMethods: [] })
    await runtime.dispose()
  })
})
