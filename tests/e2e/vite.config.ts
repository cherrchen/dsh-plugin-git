/** Test-only loopback host. No personal credentials or external network access. */
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { GitRemoteRuntime } from '../../src/remote/runtime.ts'
import { GitService } from '../../src/service.ts'
import { grantRecord } from '../../src/remote/grant.ts'
import { gitLabGrantKey } from '../../src/remote/instances.ts'
import type { GitRemoteCredentialService } from '../../src/remote/credentials.ts'
import type { CredentialRecord } from '../../src/remote/credentials-types.ts'
import type { GitRemoteSubprocess } from '../../src/remote/probe.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const fixtures = new Map<string, Fixture>()
const CLIENT = 'isolated-e2e-client'
const scenarios = ['gh', 'ref', 'oauth', 'anonymous', 'orphan', 'gitlab', 'gitlab-approval-unknown']
const ORPHAN = 'https://old.example'
const GITLAB = 'https://git.example.test/gitlab'
const SHA = 'a'.repeat(40)
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

class Fixture {
  readonly id = randomUUID()
  readonly root = mkdtempSync(join(tmpdir(), 'dsh-git-auth-e2e-'))
  readonly runtime: GitRemoteRuntime
  private readonly records = new Map<string, CredentialRecord>()
  private queue: Promise<unknown> = Promise.resolve()
  approved = false
  notes: string[] = []
  readonly calls: string[] = []
  readonly env = {
    PATH: process.env['PATH'], HOME: this.root, USERPROFILE: this.root,
    XDG_CONFIG_HOME: this.root, GH_CONFIG_DIR: join(this.root, 'gh'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(this.root, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '',
  }
  constructor(readonly scenario: string) {
    execFileSync('git', ['init', '-b', 'main'], { cwd: this.root, env: this.env, stdio: 'ignore' })
    execFileSync('git', ['remote', 'add', 'origin', scenario.startsWith('gitlab') ? `${GITLAB}/group/sub/repo.git` : 'https://github.com/fixture/repo.git'], { cwd: this.root, env: this.env })
    if (scenario === 'oauth') this.records.set('dsh-plugin-git/github-com', grantRecord({ v: 1, state: 'authenticated', revision: randomUUID(), host: 'github.com', clientId: CLIENT, accessToken: this.token('oauth') }))
    if (scenario === 'orphan') this.records.set(gitLabGrantKey(ORPHAN), { kind: 'grant', payload: { v: 2, provider: 'gitlab', instance: ORPHAN, revision: randomUUID(), state: 'authenticated', clientId: 'fixture-app', accessToken: this.token('orphan'), refreshToken: this.token('refresh'), expiresAt: 1000 } })
    const credentials: GitRemoteCredentialService = {
      readRecord: async key => this.records.get(key),
      modifyRecord: (key, mutate) => {
        const work = this.queue.then(async () => { const next = await mutate(this.records.get(key)); if (next !== undefined) this.records.set(key, next); return this.records.get(key) })
        this.queue = work.catch(() => {}); return work
      },
      deleteRecord: async key => { this.records.delete(key) },
      resolve: async ref => scenario === 'ref' && ref === 'GH_TOKEN' ? { value: this.token('ref'), source: 'fixture' } : scenario.startsWith('gitlab') && ref === 'OFFICE' ? { value: this.token('gitlab'), source: 'fixture' } : undefined,
      describe: async () => ({ configured: false, writable: true }),
      describeRecord: async key => ({ configured: this.records.has(key), writable: true }),
    }
    const reader = (read: () => string) => ({ readFrom: (from: number) => ({ text: read().slice(from), nextOffset: read().length, lossy: false }) })
    const subprocess: GitRemoteSubprocess = {
      resolveExecutable: async command => command === 'gh' ? '/e2e/gh' : 'git',
      spawn: spec => {
        let stdout = ''; let stderr = ''
        // Only the external credential providers are substituted; Git repository reads run for real.
        const probe = spec.argv[0] === '/e2e/gh' ? 'gh' : spec.argv.includes('credential') && spec.argv.includes('fill') ? 'helper' : undefined
        const done = probe === undefined ? new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
          execFile('git', [...spec.argv.slice(1)], { cwd: spec.cwd, env: { ...this.env, ...spec.env }, signal: spec.signal, encoding: 'utf8', maxBuffer: 1_048_576 }, (error, out, err) => {
            stdout = out; stderr = err
            if (error !== null && typeof error.code !== 'number') { reject(error); return }
            resolve({ exitCode: error?.code as number | undefined ?? 0, signal: null })
          })
        }) : Promise.resolve().then(() => {
          this.calls.push(`probe:${probe}`)
          stdout = probe === 'gh' ? (scenario === 'gh' ? this.token('gh') : '') : `protocol=https\nhost=github.com\npassword=${this.token('helper')}\n`
          return { exitCode: 0, signal: null }
        })
        return { collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) }, done }
      },
    }
    const service = new GitService(subprocess as SubprocessRuntime, { executable: 'git', maxOutputBytes: 1_048_576, graceMs: 1000 })
    this.runtime = new GitRemoteRuntime(credentials, subprocess, service, { clientId: CLIENT, ...(scenario.startsWith('gitlab') ? { instances: [{ url: GITLAB, credentialRef: 'OFFICE' }] } : {}) })
  }
  get orphanRetired(): boolean { const record = this.records.get(gitLabGrantKey(ORPHAN)); const payload = record?.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null ? record.payload as Record<string, unknown> : undefined; return payload?.['state'] === 'signed-out' && payload['retired'] === true && payload['accessToken'] === undefined && payload['refreshToken'] === undefined }
  token(channel: string) { return `e2e-sentinel-${this.id}-${channel}` }
  async call(endpoint: string, payload: Record<string, unknown>) {
    this.calls.push(endpoint)
    if (endpoint === 'remote-capability' && !('remoteProtocol' in payload)) return this.runtime.capability()
    return this.runtime.handle(endpoint, payload, new AbortController().signal, async () => {})
  }
  async dispose() { await this.runtime.dispose(); await rm(this.root, { recursive: true, force: true }) }
}

const originalFetch = globalThis.fetch
// The production transport keeps its pinned GitHub origins. Every outbound request is intercepted here.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.origin === 'https://git.example.test') {
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    const fixture = [...fixtures.values()].find(value => authorization === `Bearer ${value.token('gitlab')}`)
    if (fixture === undefined) throw new Error('E2E blocked an unrecognized GitLab credential')
    const path = url.pathname, method = init?.method ?? 'GET'
    fixture.calls.push(`gitlab:${method}:${path}`)
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-next-page': '' } })
    const mr = { id: 123, iid: 7, title: 'Fixture merge request', description: '**Safe** description', state: 'opened', author: null, source_project_id: 42, target_project_id: 42, source_branch: 'topic', target_branch: 'main', sha: SHA, draft: false, detailed_merge_status: 'mergeable', squash_on_merge: false, user: { can_merge: true }, diff_refs: { base_sha: SHA, start_sha: SHA, head_sha: SHA }, web_url: `${GITLAB}/group/sub/repo/-/merge_requests/7` }
    if (path === '/gitlab/api/v4/user') return response({ id: 9, username: 'fixture-gitlab-user' })
    if (path === '/gitlab/api/v4/metadata') return response({ version: 'fixture' })
    if (path === '/gitlab/api/v4/projects/group%2Fsub%2Frepo') return response({ id: 42, path_with_namespace: 'group/sub/repo', merge_requests_access_level: 'enabled', merge_method: 'merge', squash_option: 'default_off' })
    if (path === '/gitlab/api/v4/projects/42/approvals') return response({ require_reauthentication_to_approve: false })
    if (path === '/gitlab/api/v4/projects/42/merge_requests' && method === 'GET') return response([mr])
    if (path === '/gitlab/api/v4/projects/42/issues') return response([])
    if (path === '/gitlab/api/v4/projects/42/merge_requests/7' && method === 'GET') return response(mr)
    if (path === '/gitlab/api/v4/projects/42/merge_requests/7/approvals') return response({ project_id: 42, iid: 7, approved_by: [], approved: false, user_can_approve: true, user_has_approved: false })
    if (path === '/gitlab/api/v4/projects/42/merge_requests/7/notes' && method === 'GET') return response(fixture.notes.map((body, index) => ({ id: 600 + index, body, author: { id: 9, username: 'fixture-gitlab-user' }, system: false })))
    if (path === '/gitlab/api/v4/projects/42/merge_requests/7/notes' && method === 'POST') { const body = JSON.parse(String(init?.body)) as { body: string }; fixture.notes.push(body.body); return response({ id: 600 + fixture.notes.length - 1 }, 201) }
    if (path === '/gitlab/api/v4/todos' && method === 'GET') return response([{ id: 11, action_name: 'review_requested', state: 'pending', project: { id: 42, path_with_namespace: 'group/sub/repo' }, target_type: 'MergeRequest', target: { id: 123, iid: 7, project_id: 42, target_project_id: 42, title: 'Fixture review', state: 'opened' }, target_url: `${GITLAB}/group/sub/repo/-/merge_requests/7`, updated_at: '2026-10-27T00:00:00Z' }])
    if (path === '/gitlab/api/v4/projects/42/merge_requests/7/approve' && method === 'POST') {
      if (fixture.scenario === 'gitlab-approval-unknown') throw new Error('Fixture lost the approval response after send')
      return response({ id: 123, iid: 7, project_id: 42 })
    }
    if (path === '/gitlab/api/v4/projects/42/merge_requests/7/discussions' || path === '/gitlab/api/v4/projects/42/merge_requests/7/commits' || path === '/gitlab/api/v4/projects/42/merge_requests/7/diffs') return response([])
    throw new Error('E2E blocked an unexpected GitLab route')
  }
  if (url.origin === 'https://github.com') {
    const form = new URLSearchParams(String(init?.body))
    if (url.pathname === '/login/device/code' && form.get('client_id') === CLIENT) {
      // Device login is serialized by the single browser worker; fixture id is embedded in its device code.
      const fixture = [...fixtures.values()].at(-1)!
      return json({ device_code: fixture.id, user_code: 'E2E-CODE', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 0.05 })
    }
    const fixture = fixtures.get(form.get('device_code') ?? '')
    if (url.pathname === '/login/oauth/access_token' && fixture !== undefined) return json(fixture.approved
      ? { access_token: fixture.token('oauth'), token_type: 'bearer', scope: 'repo' }
      : { error: 'authorization_pending' })
  }
  if (url.origin === 'https://api.github.com') {
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    if (authorization === '') {
      if (url.pathname === '/repos/fixture/repo') return json({ permissions: {} })
      if (url.pathname === '/repos/fixture/repo/pulls') return json([])
    }
    const fixture = [...fixtures.values()].find(value => authorization.startsWith(`Bearer e2e-sentinel-${value.id}-`))
    if (fixture === undefined) throw new Error('E2E blocked an unrecognized credential')
    fixture.calls.push(`api:${url.pathname}`)
    if (url.pathname === '/user') return json({ id: 42, login: 'fixture-user' })
    if (url.pathname === '/repos/fixture/repo') return json({ permissions: { pull: true, push: false } })
    if (url.pathname === '/repos/fixture/repo/pulls') return json([])
  }
  throw new Error('E2E blocked an unexpected outbound request')
}

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: '127.0.0.1', port: 4179, strictPort: true, fs: { allow: [resolve('.')] } },
  plugins: [{
    name: 'isolated-auth-fixtures',
    configureServer(server) {
      server.middlewares.use('/__test', async (request, response) => {
        response.setHeader('content-type', 'application/json')
        try {
          let body = ''
          for await (const chunk of request) body += chunk
          const data = body ? JSON.parse(body) : {}
          if (request.url === '/fixture' && request.method === 'POST') {
            if (!scenarios.includes(data.scenario)) throw new Error('Unknown fixture scenario')
            const fixture = new Fixture(data.scenario); fixtures.set(fixture.id, fixture)
            response.end(JSON.stringify({ id: fixture.id, repository: fixture.root })); return
          }
          const fixture = fixtures.get(data.id)
          if (fixture === undefined) throw new Error('Unknown fixture')
          if (request.url === '/approve') { fixture.approved = true; response.end('{}'); return }
          if (request.url === '/inspect') { response.end(JSON.stringify({ calls: fixture.calls, capability: await fixture.runtime.capability(), orphanRetired: fixture.orphanRetired })); return }
          if (request.url !== '/rpc' || !data.endpoint.startsWith('remote-')) throw new Error('Unsupported fixture endpoint')
          try { response.end(JSON.stringify({ ok: true, value: await fixture.call(data.endpoint, data.payload ?? {}) })) }
          catch (error) {
            const failure = error as { code?: string; details?: unknown }
            response.end(JSON.stringify({ ok: false, error: { code: failure.code ?? 'git/remote-unavailable', message: 'Isolated authentication request failed', details: failure.details } }))
          }
        } catch { response.statusCode = 400; response.end(JSON.stringify({ error: 'Invalid fixture request' })) }
      })
    },
    async closeBundle() {
      globalThis.fetch = originalFetch
      await Promise.all([...fixtures.values()].map(fixture => fixture.dispose()))
      fixtures.clear()
    },
  }],
})
