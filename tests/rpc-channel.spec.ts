import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import * as git from '../src/index.ts'

describe('/git channel registration contract', () => {
  it('mounts the authenticated channel with sibling providers and removes it on unload', async () => {
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
    root.provide('subprocess', {} as never)
    const connection = await root.plugin({
      name: 'test-connection',
      apply(ctx: Context) {
        new HostConnectionService(ctx, [], {
          isAuthenticated: () => false,
          authenticateApi: () => undefined,
        } as never)
      },
    })
    const plugin = await root.plugin(git, {})
    try {
      const service = root.get('git')
      expect(service).toBeDefined()
      expect(routes.size).toBe(0)

      const web = await root.plugin(webProvider)
      try {
        await new Promise(resolve => setImmediate(resolve))
        const route = routes.get('/git')
        expect(route?.kind).toBe('prefix')
        const statuses: number[] = []
        await route!.handler({ method: 'POST', url: '/git/discover', headers: { host: '127.0.0.1' } } as IncomingMessage, {
          writeHead: (status: number) => { statuses.push(status) },
          end: () => {},
        } as unknown as ServerResponse)
        expect(statuses).toEqual([401])
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
        expect(routes.size).toBe(0)
      } finally {
        await reloadedWeb.dispose()
      }
    } finally {
      await plugin.dispose()
      await connection.dispose()
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
