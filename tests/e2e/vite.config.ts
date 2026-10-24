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
import type { GitRemoteCredentialService } from '../../src/remote/credentials.ts'
import type { CredentialRecord } from '../../src/remote/credentials-types.ts'
import type { GitRemoteSubprocess } from '../../src/remote/probe.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const fixtures = new Map<string, Fixture>()
const CLIENT = 'isolated-e2e-client'
const scenarios = ['gh', 'ref', 'oauth', 'anonymous']
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

class Fixture {
  readonly id = randomUUID()
  readonly root = mkdtempSync(join(tmpdir(), 'dsh-git-auth-e2e-'))
  readonly runtime: GitRemoteRuntime
  private record: CredentialRecord | undefined
  private queue: Promise<unknown> = Promise.resolve()
  approved = false
  readonly calls: string[] = []
  readonly env = {
    PATH: process.env['PATH'], HOME: this.root, USERPROFILE: this.root,
    XDG_CONFIG_HOME: this.root, GH_CONFIG_DIR: join(this.root, 'gh'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(this.root, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '',
  }
  constructor(readonly scenario: string) {
    execFileSync('git', ['init', '-b', 'main'], { cwd: this.root, env: this.env, stdio: 'ignore' })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git'], { cwd: this.root, env: this.env })
    if (scenario === 'oauth') this.record = grantRecord({ v: 1, state: 'authenticated', revision: randomUUID(), host: 'github.com', clientId: CLIENT, accessToken: this.token('oauth') })
    const credentials: GitRemoteCredentialService = {
      readRecord: async () => this.record,
      modifyRecord: (_key, mutate) => {
        const work = this.queue.then(async () => { this.record = await mutate(this.record) ?? this.record; return this.record })
        this.queue = work.catch(() => {}); return work
      },
      deleteRecord: async () => { this.record = undefined },
      resolve: async ref => scenario === 'ref' && ref === 'GH_TOKEN' ? { value: this.token('ref'), source: 'fixture' } : undefined,
      describe: async () => ({ configured: false, writable: true }),
      describeRecord: async () => ({ configured: this.record !== undefined, writable: true }),
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
    this.runtime = new GitRemoteRuntime(credentials, subprocess, service, { clientId: CLIENT })
  }
  token(channel: string) { return `e2e-sentinel-${this.id}-${channel}` }
  async call(endpoint: string, payload: Record<string, unknown>) {
    this.calls.push(endpoint)
    if (endpoint === 'remote-capability') return this.runtime.capability()
    return this.runtime.handle(endpoint, payload, new AbortController().signal, async () => {})
  }
  async dispose() { await this.runtime.dispose(); await rm(this.root, { recursive: true, force: true }) }
}

const originalFetch = globalThis.fetch
// The production transport keeps its pinned GitHub origins. Every outbound request is intercepted here.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
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
          if (request.url === '/inspect') { response.end(JSON.stringify({ calls: fixture.calls, capability: await fixture.runtime.capability() })); return }
          if (request.url !== '/rpc' || !data.endpoint.startsWith('remote-')) throw new Error('Unsupported fixture endpoint')
          try { response.end(JSON.stringify({ ok: true, value: await fixture.call(data.endpoint, data.payload ?? {}) })) }
          catch (error) {
            const failure = error as { code?: string }
            response.end(JSON.stringify({ ok: false, error: { code: failure.code ?? 'git/remote-unavailable', message: 'Isolated authentication request failed' } }))
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
