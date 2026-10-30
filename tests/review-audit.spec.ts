/** Temporary audit reproductions — verifies review findings. */
import { describe, expect, it, vi } from 'vitest'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import { GitLabAuth } from '../src/remote/gitlab-auth.ts'
import { gitLabDiscussion, gitLabIndividualNote } from '../src/remote/gitlab-model.ts'
import { GitRemoteHttp } from '../src/remote/http.ts'
import { gitLabGrantKey, resolveGitLabInstances } from '../src/remote/instances.ts'
import { resolveRemoteSettings } from '../src/remote/settings.ts'
import { remoteTimeline } from '../src/client/remote/timeline.ts'
import { projectGitLabDiscussion, projectGitLabNote } from '../src/client/remote/remote-view.ts'
import { GitRemoteRuntime } from '../src/remote/runtime.ts'
import type { GitService } from '../src/service.ts'

const SIG = new AbortController().signal
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('audit: GitLab comment duplication (notes vs discussions overlap)', () => {
  it('a plain MR comment is rendered once by the shared timeline', () => {
    const instance = 'https://gitlab.com'
    // Realistic GitLab payloads: POST /notes creates a note AND an individual_note discussion.
    const notesPayload = [
      { id: 501, type: null, body: 'hello world', author: { id: 9, username: 'viewer' }, system: false, resolvable: false, created_at: '2026-10-29T01:00:00Z' },
      { id: 503, type: 'DiffNote', body: 'diff note', author: { id: 9, username: 'viewer' }, system: false, resolvable: true, created_at: '2026-10-29T01:01:00Z' },
    ]
    const discussionsPayload = [
      { id: 'disc-abc', individual_note: true, notes: [{ id: 501, type: null, body: 'hello world', author: { id: 9, username: 'viewer' }, system: false, resolvable: false, created_at: '2026-10-29T01:00:00Z' }] },
    ]
    const comments = notesPayload.flatMap(raw => { const n = gitLabIndividualNote(raw, instance); return n === null ? [] : projectGitLabNote(n) })
    const inline = discussionsPayload.flatMap(raw => { const d = gitLabDiscussion(raw, instance); return d === null ? [] : projectGitLabDiscussion(d) })
    const entries = remoteTimeline({ comments, inline, commits: [], reviews: [] })
    const renderedIds = entries.flatMap(e => e.kind === 'comment' ? [e.comment.id] : e.kind === 'thread' ? [e.thread.root.id, ...e.thread.replies.map(r => r.id)] : [])
    expect(renderedIds.filter(id => id === '501')).toHaveLength(1)
  })

  it('end-to-end through GitRemoteRuntime: discussions echo notes back to the client', async () => {
    const records = new Map<string, CredentialRecord>(), refs = new Map<string, { value: string; source: string }>()
    const credentials: GitRemoteCredentialService = {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, fn) => { const next = await fn(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) },
      deleteRecord: async key => { records.delete(key) },
      resolve: async ref => refs.get(ref),
      describe: async () => ({ configured: false, writable: true }),
      describeRecord: async key => ({ configured: records.has(key), writable: true }),
    }
    const subprocess = { spawn: () => { throw Error('no') }, resolveExecutable: async () => { throw Error('no') } }
    const service = { remoteCommand: async (_root: string, args: readonly string[]) => args[1] === 'get-url' ? 'https://gitlab.com/group/repo.git\n' : 'origin\n' } as unknown as GitService
    const runtime = new GitRemoteRuntime(credentials, subprocess, service, undefined)
    refs.set('GITLAB_TOKEN', { value: 'token', source: 'test' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/user')) return json({ id: 9, username: 'viewer' })
      if (pathname.endsWith('/projects/group%2Frepo')) return json({ id: 42, path_with_namespace: 'group/repo' })
      if (pathname.endsWith('/notes')) return json([{ id: 501, type: null, body: 'c', author: null, system: false }, { id: 503, type: 'DiffNote', body: 'diff c', author: null, system: false, resolvable: true }], 200, { 'x-next-page': '' })
      if (pathname.endsWith('/discussions')) return json([
        { id: 'd1', individual_note: true, notes: [{ id: 501, type: null, body: 'c', author: null, system: false }] },
        { id: 'd2', individual_note: false, notes: [{ id: 502, type: 'DiscussionNote', body: 'thread reply', author: null, system: false, resolvable: true, resolved: false }] },
      ], 200, { 'x-next-page': '' })
      throw Error(`unexpected ${String(url)}`)
    })
    const request = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://gitlab.com', repository: '/repo', sessionId: 's', path: 'group/repo', number: 7, objectKind: 'pull' }
    try {
      const comments = await runtime.handle('remote-comments', request, SIG, async () => {}) as any
      const discussions = await runtime.handle('remote-discussions', request, SIG, async () => {}) as any
      const commentIds = comments.value.items.map((n: any) => n.id)
      const discussionNoteIds = discussions.value.items.flatMap((d: any) => d.notes.map((n: any) => n.id))
      // Fixed: comments serve individual notes only; discussions drop individual_note wrappers and DiffNotes.
      expect(commentIds).toEqual(['501'])
      expect(discussionNoteIds).toEqual(['502'])
    } finally { await runtime.dispose() }
  })
})

describe('audit: GitLab auth method switching', () => {
  function store() {
    const records = new Map<string, CredentialRecord>()
    const refs = new Map<string, { value: string; source: string }>()
    let chain: Promise<unknown> = Promise.resolve()
    const service: GitRemoteCredentialService = {
      readRecord: async key => records.get(key),
      modifyRecord: (key, mutate) => { const run = chain.then(async () => { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) }); chain = run.catch(() => {}); return run },
      deleteRecord: async key => { records.delete(key) }, resolve: async ref => refs.get(ref),
      describe: async () => ({ configured: false, writable: true }),
      describeRecord: async key => ({ configured: records.has(key), writable: true }),
    }
    return { service, records, refs }
  }
  function fixture(s: ReturnType<typeof store>, url: string, options: { ref?: string; clientId?: string; fetch?: typeof fetch; discover?: (signal: AbortSignal) => Promise<string | undefined> } = {}) {
    const instance = resolveGitLabInstances([{ url, ...(options.ref === undefined ? {} : { credentialRef: options.ref }), ...(options.clientId === undefined ? {} : { clientId: options.clientId }) }])[0]!
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = options.fetch ?? (async () => json({ id: 9, username: 'same' }))
    const http = new GitRemoteHttp({ gitlabInstance: instance.instance, fetch: async (url, init) => { calls.push({ url, init }); return fetch(url, init) } })
    const engine = new GitLabAuth({ credentials: s.service, instance, http, settings: resolveRemoteSettings({}), ...(options.discover === undefined ? {} : { discoverGlab: options.discover }) })
    return { engine, instance, calls }
  }

  it('cli -> oauth -> cli with all credentials present does not cross tokens', async () => {
    const s = store()
    s.refs.set('GITLAB_TOKEN', { value: 'env-token', source: 'env' })
    const discover = vi.fn(async () => 'glab-token')
    const users: string[] = []
    const f = fixture(s, 'https://gitlab.com', {
      discover, clientId: 'app',
      fetch: async (url, init) => { users.push(`${String(url)} ${new Headers(init?.headers).get('authorization')}`); return json({ id: 9, username: 'same' }) },
    })
    // Pre-seed an authenticated OAuth grant with a different clientId-matching token.
    s.records.set(gitLabGrantKey(f.instance.instance), { kind: 'grant', payload: { v: 2, provider: 'gitlab', instance: f.instance.instance, revision: 'r1', state: 'authenticated', clientId: 'app', accessToken: 'oauth-token', expiresAt: Date.now() + 3600_000 } })
    // auto: the stored OAuth grant wins over env/glab credentials.
    let snap = await f.engine.snapshot(SIG)
    expect(snap.state).toBe('authenticated')
    expect(snap.token).toBe('oauth-token')
    // select cli: switches to the glab-probed token, never the grant token.
    await f.engine.selectMethod('cli', SIG)
    snap = await f.engine.snapshot(SIG)
    expect(snap.state).toBe('authenticated')
    expect(snap.token).toBe('glab-token')
    // select oauth: re-verifies the stored grant token.
    await f.engine.selectMethod('oauth', SIG)
    snap = await f.engine.snapshot(SIG)
    expect(snap.state).toBe('authenticated')
    expect(snap.token).toBe('oauth-token')
    // Every /user verification carried the token of the selected source only.
    expect(users.filter(u => u.includes('Bearer oauth-token'))).toHaveLength(2)
    expect(users.filter(u => u.includes('Bearer glab-token'))).toHaveLength(1)
    await f.engine.dispose()
  })

  it('selectMethod aborts an in-flight device poll instead of blocking behind it', async () => {
    const s = store()
    const discover = vi.fn(async () => 'glab-token')
    const f = fixture(s, 'https://gitlab.com', {
      discover, clientId: 'app',
      fetch: async url => {
        const u = String(url)
        if (u.endsWith('authorize_device')) return json({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://gitlab.com/oauth/device', expires_in: 900, interval: 0.001 })
        if (u.endsWith('/oauth/token')) return new Promise<Response>(() => {}) // never resolves until aborted
        return json({ id: 9, username: 'viewer' })
      },
    })
    const start = await f.engine.startLogin(SIG)
    const poll = f.engine.pollLogin(start.value.attemptId, SIG)
    const pollOutcome = poll.then(() => 'resolved', (e: unknown) => e)
    // Give the poll a tick to reach its first /oauth/token request.
    await new Promise(r => setTimeout(r, 200))
    const switching = f.engine.selectMethod('cli', SIG)
    const finished = await Promise.race([switching.then(() => 'done'), new Promise(r => setTimeout(() => r('still-blocked'), 2000))])
    expect(finished).toBe('done')
    await switching
    expect(await pollOutcome).not.toBe('resolved')
    const snap = await f.engine.snapshot(SIG)
    expect(snap.state).toBe('authenticated')
    expect(snap.token).toBe('glab-token')
    await f.engine.dispose()
  })

  it('a stale authorizing record is superseded by the next login', async () => {
    const s = store()
    const f = fixture(s, 'https://gitlab.com', { clientId: 'app', fetch: async url => String(url).endsWith('authorize_device') ? json({ device_code: 'd', user_code: 'ABCD', verification_uri: 'https://gitlab.com/oauth/device', expires_in: 900, interval: 1 }) : json({ id: 9, username: 'viewer' }) })
    // Simulate a host crash mid-login: the persisted grant is stuck in 'authorizing'.
    s.records.set(gitLabGrantKey(f.instance.instance), { kind: 'grant', payload: { v: 2, provider: 'gitlab', instance: f.instance.instance, revision: 'r1', state: 'authorizing', clientId: 'app', attemptId: 'dead-attempt' } })
    const snap = await f.engine.snapshot(SIG)
    expect(snap.state).toBe('invalid')
    const start = await f.engine.startLogin(SIG)
    expect(start.value.attemptId).not.toBe('dead-attempt')
    expect(s.records.get(gitLabGrantKey(f.instance.instance))?.payload).toMatchObject({ state: 'authorizing', attemptId: start.value.attemptId })
    await f.engine.dispose()
  })

  it('a live authorizing attempt still blocks a second login', async () => {
    const s = store()
    const f = fixture(s, 'https://gitlab.com', { clientId: 'app', fetch: async url => String(url).endsWith('authorize_device') ? json({ device_code: 'd', user_code: 'ABCD', verification_uri: 'https://gitlab.com/oauth/device', expires_in: 900, interval: 1 }) : json({ id: 9, username: 'viewer' }) })
    const first = await f.engine.startLogin(SIG)
    await expect(f.engine.startLogin(SIG)).rejects.toMatchObject({ details: { reason: 'login-already-running' } })
    await f.engine.cancelLogin(first.value.attemptId)
    await f.engine.dispose()
  })
})
