import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteRuntime } from '../src/remote/runtime.ts'
import { isRepositoryWrite } from '../src/session-directory.ts'
import type { GitService } from '../src/service.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
const repo = { provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' } as const
const signal = new AbortController().signal
const sha = 'a'.repeat(40)
const branch = { ref: 'main', sha, repo: { owner: { login: 'owner' }, name: 'repo' } }
const pr = { number: 1, state: 'open', title: 'PR', body: '', user: { id: 1, login: 'alice' }, head: branch, base: branch }
const file = { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())
function fixture(handler?: (url: string, init: RequestInit) => Promise<Response>) {
  const writes: RequestInit[] = []
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== 'GET') { writes.push(init); if (handler !== undefined) return handler(url, init); return json({ id: 1 }) }
    reads.push(url)
    return json(url.endsWith('/user') ? { id: 1, login: 'alice' } : url.includes('/pulls/1/files') ? [file] : url.endsWith('/pulls/1') ? pr : url.includes('/pulls?') ? [pr] : { permissions: { push: true } })
  }))
  const credentials: GitRemoteCredentialService = { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {}, resolve: async () => ({ value: 'SENTINEL_TOKEN', source: 'env' }), describe: async () => ({ configured: true, writable: false }), describeRecord: async () => ({ configured: false, writable: false }) }
  const service = { remoteCommand: async (_root: string, args: string[]) => args[1] === 'get-url' ? 'git@github.com:owner/repo.git\n' : 'origin\n' } as unknown as GitService
  const runtime = new GitRemoteRuntime(credentials, { spawn: () => { throw new Error('unexpected subprocess') }, resolveExecutable: async () => { throw new Error('unexpected subprocess') } }, service)
  return { runtime, writes, reads }
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
  it('classifies all remote repository mutators as writes', () => {
    for (const endpoint of ['remote-comment', 'remote-inline-comment', 'remote-review', 'remote-create-pr', 'remote-close-pr', 'remote-merge-pr', 'remote-checkout-pr', 'remote-issue-branch']) expect(isRepositoryWrite(endpoint)).toBe(true)
    for (const endpoint of ['remote-capability', 'remote-list-prs', 'remote-pr', 'remote-list-issues', 'remote-issue', 'remote-comments', 'remote-files', 'remote-notifications']) expect(isRepositoryWrite(endpoint)).toBe(false)
  })
})
