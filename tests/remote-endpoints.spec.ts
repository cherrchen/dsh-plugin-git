import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalPath } from '../src/path-identity.ts'
import { localSubprocess } from './harness/local-subprocess.ts'
import { apply } from '../src/index.ts'
import { GIT_REMOTE_CREDENTIAL_MEMBERS } from '../src/remote/credentials.ts'

const SECRET = 'gho_SENTINEL-TOKEN-n3v3r-w1r3'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-rmtep-'))
  roots.push(root)
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Git Plugin Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'git-plugin@example.invalid'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'initial\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root })
  return root
}



function completeProvider() {
  return {
    accessToken: SECRET,
    readRecord: vi.fn(async () => undefined),
    modifyRecord: vi.fn(async () => undefined),
    deleteRecord: vi.fn(async () => undefined),
    resolve: vi.fn(async () => ({ value: SECRET, source: 'store' })),
    describe: vi.fn(async () => ({ configured: true, writable: true })),
    describeRecord: vi.fn(async () => ({ configured: true, kind: 'grant', writable: true })),
    notifyRecordUpdated: vi.fn(),
  }
}

type Reply =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: unknown } }

interface Mounted {
  ctx: Context
  call(endpoint: string, payload: unknown): Promise<Reply>
  dispose(): Promise<void>
}

async function mounted(options: { subprocess?: unknown } = {}): Promise<Mounted> {
  const ctx = new Context()
  ctx.provide('subprocess', (options.subprocess ?? {}) as never)
  ctx.provide('webServer', {} as never)
  let captured: Mounted['call'] | undefined
  ctx.provide('connection', {
    rpc: {
      handle(_channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) {
        captured = (endpoint, payload) => handler(endpoint, payload, new AbortController().signal) as Promise<Reply>
        return () => {}
      },
    },
  } as never)
  const fiber = ctx.plugin((pluginCtx) => apply(pluginCtx, {} as never))
  await fiber.await()
  await new Promise((resolve) => setImmediate(resolve))
  if (captured === undefined) throw new Error('git RPC was not registered')
  return { ctx, call: captured, dispose: () => fiber.dispose() }
}

describe('remote-capability endpoint', { timeout: 20_000 }, () => {
  it.each([undefined, null, 42, 'text', { repository: '/repo' }])(
    'answers a structured off for payload %j without a credentials seam',
    async (payload) => {
      const host = await mounted()
      try {
        expect(await host.call('remote-capability', payload)).toEqual({
          ok: true,
          value: { state: 'off', reason: 'credentials-missing', auth: { state: 'off' } },
        })
      } finally {
        await host.dispose()
      }
    },
  )

  it('reports credentials-incomplete with allowlisted member names', async () => {
    const host = await mounted()
    try {
      const provider = { ...completeProvider() } as Record<string, unknown>
      delete provider['modifyRecord']
      const fiber = host.ctx.plugin((c) => { c.provide('credentials', provider) })
      await fiber.await()
      try {
        expect(await host.call('remote-capability', {})).toEqual({
          ok: true,
          value: {
            state: 'off',
            reason: 'credentials-incomplete',
            missing: ['modifyRecord'],
            auth: { state: 'off' },
          },
        })
      } finally {
        await fiber.dispose()
      }
    } finally {
      await host.dispose()
    }
  })

  it('reports on for a complete seam without implying authentication and leaks no secret fields', async () => {
    const host = await mounted()
    const provider = completeProvider()
    const fiber = host.ctx.plugin((c) => { c.provide('credentials', provider) })
    await fiber.await()
    try {
      const reply = await host.call('remote-capability', {})
      expect(reply).toEqual({
        ok: true,
        value: expect.objectContaining({ state: 'on', auth: { state: 'unauthenticated' } }),
      })
      expect(JSON.stringify(reply)).not.toContain('SENTINEL')
      expect(provider.describeRecord).toHaveBeenCalledTimes(1)
      for (const member of GIT_REMOTE_CREDENTIAL_MEMBERS.filter(name => name !== 'describeRecord')) expect(provider[member as keyof typeof provider]).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
      await host.dispose()
    }
  })

  it('spawns no subprocess and opens no network request while answering', async () => {
    let spawns = 0
    const inner = localSubprocess()
    const counted = {
      ...inner,
      spawn(spec: Parameters<typeof inner.spawn>[0]) {
        spawns++
        return inner.spawn(spec)
      },
    }
    const realFetch = globalThis.fetch
    let fetches = 0
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetches++
      return realFetch(...args)
    }) as typeof fetch
    try {
      const host = await mounted({ subprocess: counted })
      const fiber = host.ctx.plugin((c) => { c.provide('credentials', completeProvider()) })
      await fiber.await()
      try {
        await host.call('remote-capability', {})
        await host.call('remote-merge-pr', {})
        expect(spawns).toBe(0)
        expect(fetches).toBe(0)
      } finally {
        await fiber.dispose()
        await host.dispose()
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('remote-* rejection', () => {
  it.each(['remote-list-prs', 'remote-checkout-pr', 'remote-merge-pr', 'remote-future-endpoint'])(
    'rejects %s with git/remote-unavailable and a structured reason',
    async (endpoint) => {
      const host = await mounted()
      try {
        const reply = await host.call(endpoint, null)
        expect(reply.ok).toBe(false)
        if (reply.ok) return
        expect(reply.error.code).toBe('git/remote-unavailable')
        expect(reply.error.details).toEqual({ reason: 'credentials-missing' })
        expect(reply.error.message).not.toContain('SENTINEL')
        expect(JSON.stringify(reply)).not.toContain(endpoint)
      } finally {
        await host.dispose()
      }
    },
  )

  it('rejects remote writes without touching the local Git path', async () => {
    let spawns = 0
    const inner = localSubprocess()
    const counted = {
      ...inner,
      spawn(spec: Parameters<typeof inner.spawn>[0]) {
        spawns++
        return inner.spawn(spec)
      },
    }
    const host = await mounted({ subprocess: counted })
    try {
      const denied = await host.call('remote-create-pr', { repository: '/repo', accessToken: SECRET })
      expect(denied.ok).toBe(false)
      if (!denied.ok) {
        expect(denied.error.code).toBe('git/remote-unavailable')
        expect(JSON.stringify(denied)).not.toContain('SENTINEL')
      }
      expect(spawns).toBe(0)
    } finally {
      await host.dispose()
    }
  })

  it('re-evaluates the seam as a credentials provider mounts and unmounts', async () => {
    const host = await mounted()
    try {
      expect(await host.call('remote-capability', {})).toEqual({
        ok: true,
        value: { state: 'off', reason: 'credentials-missing', auth: { state: 'off' } },
      })
      const provider = host.ctx.plugin((c) => { c.provide('credentials', completeProvider()) })
      await provider.await()
      expect(await host.call('remote-capability', {})).toEqual({
        ok: true,
        value: expect.objectContaining({ state: 'on', auth: { state: 'unauthenticated' } }),
      })
      await provider.dispose()
      expect(await host.call('remote-capability', {})).toEqual({
        ok: true,
        value: { state: 'off', reason: 'credentials-missing', auth: { state: 'off' } },
      })
    } finally {
      await host.dispose()
    }
  })

  it('keeps local Git status usable after remote rejections and seam unmount', async () => {
    const repo = repository()
    const host = await mounted({ subprocess: localSubprocess() })
    const provider = host.ctx.plugin((c) => { c.provide('credentials', completeProvider()) })
    await provider.await()
    try {
      const denied = await host.call('remote-merge-pr', { repository: repo })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.code).toBe('git/remote-unavailable')
      await provider.dispose()
      const status = await host.call('status', { repository: repo })
      expect(status.ok).toBe(true)
      if (status.ok) expect(canonicalPath((status.value as { root: string }).root, repo)).toBe(canonicalPath(repo, repo))
    } finally {
      await host.dispose()
    }
  })
})

describe('v2 negotiation at the Host boundary', () => {
  it('returns global off without a seam and echoes scope only after a complete seam is present', async () => {
    const host = await mounted()
    const payload = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://gitlab.com' }
    try {
      expect(await host.call('remote-capability', payload)).toEqual({ ok: true, value: { state: 'off', reason: 'credentials-missing', auth: { state: 'off' } } })
      const fiber = host.ctx.plugin(c => { c.provide('credentials', completeProvider()) }); await fiber.await()
      try {
        const legacy = await host.call('remote-capability', {})
        expect(legacy).toMatchObject({ ok: true, value: { state: 'on', remoteProtocol: 2 } })
        const scoped = await host.call('remote-capability', payload)
        expect(scoped).toMatchObject({ ok: true, value: { remoteProtocol: 2, scope: { provider: 'gitlab', instance: 'https://gitlab.com' }, value: { state: 'on' } } })
      } finally { await fiber.dispose() }
    } finally { await host.dispose() }
  })
})
