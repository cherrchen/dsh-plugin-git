import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { canonicalPath } from '../src/path-identity.ts'
import { GitClientController } from '../src/client/controller.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-wtep-'))
  roots.push(root)
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Git Plugin Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'git-plugin@example.invalid'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'initial\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root })
  return root
}

type Reply = { ok: true; value: unknown } | { ok: false; error: { message: string } }

interface Mounted {
  call(endpoint: string, payload: unknown): Promise<Reply>
  dispose(): Promise<void>
}

async function mounted(options: {
  config?: Record<string, unknown>
  cwd?: string
  upstream?: Record<string, unknown>
  fs?: Record<string, unknown>
} = {}): Promise<Mounted> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalSubprocessRuntime)
  await fiber.await()
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
  if (options.cwd !== undefined) {
    ctx.provide('agents', {
      get: (sessionId: string) => sessionId === 'session-a' ? { session: { id: sessionId } } : undefined,
    } as never)
    ctx.provide('workingDirectory', {
      get: () => options.cwd,
      set: async (_agent: unknown, path: string) => path,
    } as never)
  }
  if (options.upstream !== undefined) ctx.provide('worktrees', options.upstream as never)
  if (options.fs !== undefined) ctx.provide('fs', options.fs as never)
  apply(ctx, (options.config ?? {}) as never)
  await new Promise((resolve) => setImmediate(resolve))
  if (captured === undefined) throw new Error('git RPC was not registered')
  return { call: captured, dispose: () => fiber.dispose() }
}

describe('worktree endpoints', { timeout: 20_000 }, () => {
  it.each(['local', 'upstream'])('accepts %s creation when its directory projection arrives before the RPC reply', async (mode) => {
    const repo = repository()
    const ctx = new Context()
    const fiber = ctx.plugin(LocalSubprocessRuntime)
    await fiber.await()
    let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<Reply>) | undefined
    let cwd = repo
    let rebound: Promise<void> | undefined
    let controller: GitClientController | undefined
    ctx.provide('webServer', {} as never)
    ctx.provide('connection', { rpc: {
      handle(_channel: string, call: NonNullable<typeof handler>) { handler = call; return () => {} },
    } } as never)
    ctx.provide('agents', { get: () => ({ session: { id: 'session-a' } }) } as never)
    ctx.provide('workingDirectory', {
      get: () => cwd,
      set: async (_agent: unknown, path: string, signal: AbortSignal) => {
        signal.throwIfAborted()
        cwd = path
        // The Host publishes the committed session directory before replying.
        rebound = controller!.setWorkspace(cwd)
        await new Promise(resolve => setImmediate(resolve))
        return cwd
      },
    } as never)
    apply(ctx, { worktrees: { enabled: true } } as never)
    if (mode === 'upstream') {
      ctx.provide('worktrees', {
        create: async (_agent: unknown, request: { name?: string }, signal: AbortSignal) => {
          const created = await ctx.git.createWorktree(cwd, request, undefined, signal)
          cwd = created.path
          rebound = controller!.setWorkspace(cwd)
          await new Promise(resolve => setImmediate(resolve))
          return created
        },
      } as never)
    }
    await new Promise(resolve => setImmediate(resolve))
    controller = new GitClientController({
      call: (_channel, endpoint, payload, signal) => handler!(endpoint, payload, signal ?? new AbortController().signal),
    }, 'session-a')
    try {
      await controller.setWorkspace(repo)
      const created = await controller.createWorktree('projected')
      await rebound
      expect(created).toMatchObject({ branch: 'projected', entered: true, path: cwd })
      expect(existsSync(join(cwd, 'tracked.txt'))).toBe(true)
      expect(controller.getSnapshot()).toMatchObject({ workspacePath: cwd, creatingWorktree: false, repository: { root: cwd } })
    } finally {
      controller.dispose()
      await rebound
      await fiber.dispose()
    }
  })

  it('reports off and refuses creation with no runtime and no toggle', async () => {
    const host = await mounted()
    try {
      expect(await host.call('worktree-capability', {})).toEqual({
        ok: true,
        value: { mode: 'off', directory: '.agents/worktrees' },
      })
      const denied = await host.call('create-worktree', { repository: '/repo' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.message).toMatch(/disabled/u)
    } finally {
      await host.dispose()
    }
  })

  it('creates locally under the default pool once the toggle is on', async () => {
    const repo = repository()
    const host = await mounted({ config: { worktrees: { enabled: true } } })
    try {
      const capability = await host.call('worktree-capability', {})
      expect(capability).toEqual({ ok: true, value: { mode: 'local', directory: '.agents/worktrees' } })
      const created = await host.call('create-worktree', { repository: repo, name: 'wt-local' })
      expect(created.ok).toBe(true)
      if (created.ok) {
        const value = created.value as { path: string; branch: string; baseCommit: string }
        expect(value.branch).toBe('wt-local')
        expect(canonicalPath(value.path, repo)).toBe(`${realpathSync(repo)}/.agents/worktrees/wt-local`)
        expect(value).not.toHaveProperty('entered')
        expect(existsSync(join(value.path, 'tracked.txt'))).toBe(true)
      }
      // A custom relative pool overrides the default.
      const custom = await host.call('create-worktree', { repository: repo })
      expect(custom.ok).toBe(true)
      if (custom.ok) {
        const value = custom.value as { path: string; branch: string }
        expect(value.branch).toMatch(/^worktree-/u)
        expect(canonicalPath(value.path, repo)).toBe(`${realpathSync(repo)}/.agents/worktrees/${value.branch}`)
      }
    } finally {
      await host.dispose()
    }
  })

  it('enters the new checkout for a live session in local mode', async () => {
    const repo = repository()
    const entered: string[] = []
    const ctx = new Context()
    const fiber = ctx.plugin(LocalSubprocessRuntime)
    await fiber.await()
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
    ctx.provide('agents', {
      get: (sessionId: string) => sessionId === 'session-a' ? { session: { id: sessionId } } : undefined,
    } as never)
    ctx.provide('workingDirectory', {
      get: () => repo,
      set: async (_agent: unknown, path: string) => {
        entered.push(path)
        return path
      },
    } as never)
    apply(ctx, { worktrees: { enabled: true } } as never)
    await new Promise((resolve) => setImmediate(resolve))
    try {
      if (captured === undefined) throw new Error('git RPC was not registered')
      const created = await captured('create-worktree', { sessionId: 'session-a', repository: repo, name: 'wt-enter' })
      expect(created.ok).toBe(true)
      if (created.ok) {
        const value = created.value as { path: string; entered?: boolean }
        expect(value.entered).toBe(true)
        expect(canonicalPath(value.path, repo)).toBe(`${realpathSync(repo)}/.agents/worktrees/wt-enter`)
      }
      expect(entered.map(path => canonicalPath(path, repo))).toEqual([`${realpathSync(repo)}/.agents/worktrees/wt-enter`])
    } finally {
      await fiber.dispose()
    }
  })

  it('delegates creation to a mounted upstream runtime with the session agent', async () => {
    const repo = repository()
    const create = vi.fn(async (_agent: unknown, request: { name?: string; from?: string } | undefined) => ({
      path: `${repo}/.agents/worktrees/${request?.name ?? 'up'}`,
      branch: request?.name ?? 'up',
      baseCommit: 'c0',
    }))
    const host = await mounted({ cwd: repo, upstream: { create } })
    try {
      expect(await host.call('worktree-capability', {})).toEqual({
        ok: true,
        value: { mode: 'upstream', directory: '.agents/worktrees' },
      })
      const created = await host.call('create-worktree', {
        sessionId: 'session-a',
        repository: repo,
        name: 'up-branch',
        from: 'HEAD',
      })
      expect(created.ok).toBe(true)
      if (created.ok) {
        expect(created.value).toEqual({
          path: `${repo}/.agents/worktrees/up-branch`,
          branch: 'up-branch',
          baseCommit: 'c0',
          entered: true,
        })
      }
      expect(create).toHaveBeenCalledTimes(1)
      const [agent, request] = create.mock.calls[0]!
      expect(agent).toEqual({ session: { id: 'session-a' } })
      expect(request).toEqual({ name: 'up-branch', from: 'HEAD' })
      // No local checkout was created.
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).match(/worktree /gu)).toHaveLength(1)
      // Upstream creation cannot run without a session.
      const denied = await host.call('create-worktree', { repository: repo, name: 'no-session' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.message).toMatch(/needs a session/u)
    } finally {
      await host.dispose()
    }
  })

  it('rejects a local create when the live session points at a different repository', async () => {
    const repo = repository()
    const other = repository()
    const host = await mounted({ cwd: repo, config: { worktrees: { enabled: true } } })
    try {
      const denied = await host.call('create-worktree', { sessionId: 'session-a', repository: other, name: 'cross' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.message).toMatch(/does not match the session working directory/u)
    } finally {
      await host.dispose()
    }
  })
})
