import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as connectionPlugin from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it } from 'vitest'
import * as git from '../src/index.ts'
import { canonicalPath } from '../src/path-identity.ts'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import { localSubprocess } from './harness/local-subprocess.ts'

describe('/git channel registration contract', () => {
  it('serves authenticated discovery with sibling providers and removes the channel on unload', { timeout: 20_000 }, async ({ onTestFinished }) => {
    type Route = {
      kind: string
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
    }
    const root = new Context()
    const routes = new Map<string, Route>()
    const webProvider = {
      name: 'test-web',
      apply(ctx: Context) {
        ctx.provide('webServer', {
          register(route: Route) {
            expect(routes.has(route.path)).toBe(false)
            routes.set(route.path, route)
            return () => { routes.delete(route.path) }
          },
        } as never)
      },
    }
    const repository = mkdtempSync(join(tmpdir(), 'dsh-git-rpc-'))
    onTestFinished(() => rm(repository, { recursive: true, force: true }))
    execFileSync('git', ['init', '--quiet'], { cwd: repository })
    const workspace = join(repository, 'nested')
    mkdirSync(workspace)
    root.provide('subprocess', localSubprocess() as never)
    root.provide('credentials', {
      modifyRecord: async (_key: string, initialize: (current: undefined) => Promise<CredentialRecord>) => initialize(undefined),
    } as never)
    const connection = await root.plugin(connectionPlugin, {})
    onTestFinished(() => connection.dispose())
    const plugin = await root.plugin(git, {})
    try {
      const service = root.get('git')
      expect(service).toBeDefined()
      expect(routes.size).toBe(0)

      const web = await root.plugin(webProvider)
      try {
        await new Promise(resolve => setImmediate(resolve))
        const route = routes.get('/git')
        assert(route, 'Git RPC route was not registered')
        expect(route.kind).toBe('prefix')
        const host = root.get('connection')
        assert(host)
        const server = createServer((request, response) => {
          if (request.url?.startsWith('/?')) {
            if (host.authorizeIndex(request, response)) response.end()
          } else if (request.url === '/git/discover') {
            void route.handler(request, response).catch(error => response.destroy(error))
          } else {
            response.writeHead(404).end()
          }
        })
        await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
        onTestFinished(() => server[Symbol.asyncDispose]())
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const headers = new Headers({ 'content-type': 'application/json' })
        const discover = () => fetch(`${origin}/git/discover`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            type: 'client-request', rpcId: 'discover-test', method: 'discover', payload: { path: workspace },
          }),
        })

        const denied = await discover()
        expect(denied.status).toBe(401)
        await denied.text()

        const login = await fetch(host.authenticatedUrl(`${origin}/`), { redirect: 'manual' })
        expect(login.status).toBe(303)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]
        assert(cookie, 'DSH did not issue a browser session cookie')
        await login.text()
        headers.set('cookie', cookie)

        const discovered = await discover()
        expect(discovered.status).toBe(200)
        const reply = await discovered.json()
        expect(reply).toMatchObject({ type: 'server-response', rpcId: 'discover-test', result: { ok: true, value: expect.any(String) } })
        expect(canonicalPath(reply.result.value, repository)).toBe(canonicalPath(repository, repository))
      } finally {
        await web.dispose()
      }
      expect(routes.size).toBe(0)
      expect(root.get('git')).toBe(service)

      const reloadedWeb = await root.plugin(webProvider)
      try {
        await new Promise(resolve => setImmediate(resolve))
        expect(routes.has('/git')).toBe(true)
        await plugin.dispose()
        expect(routes.has('/git')).toBe(false)
      } finally {
        await reloadedWeb.dispose()
      }
    } finally {
      await plugin.dispose()
    }
  })

  it('stays unmounted while the route table service is absent', async () => {
    const ctx = new Context()
    ctx.provide('subprocess', {} as never)
    const channels: string[] = []
    ctx.provide('connection', {
      rpc: { handle: (channel: string) => { channels.push(channel); return () => {} } },
    } as never)
    git.apply(ctx, {})
    await new Promise((resolve) => setImmediate(resolve))
    expect(channels).toEqual([])
  })
})
