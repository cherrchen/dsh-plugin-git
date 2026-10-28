import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { bindSessionDirectory } from '../src/session-directory.ts'
import { canonicalPath } from '../src/path-identity.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-dir-'))
  roots.push(root)
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Git Plugin Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'git-plugin@example.invalid'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'initial\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root })
  return root
}

interface Captured {
  call(endpoint: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>
  readonly calls: Array<{ cwd: string; argv: readonly string[] }>
  dispose(): Promise<void>
}

async function mounted(options: {
  cwd?: string
  live?: boolean
  onSet?: (path: string) => void
} = {}): Promise<Captured> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalSubprocessRuntime)
  await fiber.await()
  const calls: Array<{ cwd: string; argv: readonly string[] }> = []
  const runtime = ctx.subprocess
  const spawn = runtime.spawn.bind(runtime)
  runtime.spawn = (spec) => {
    calls.push({ cwd: spec.cwd, argv: [...spec.argv] })
    return spawn(spec)
  }
  ctx.provide('webServer', {} as never)
  let captured: Captured['call'] | undefined
  ctx.provide('connection', {
    rpc: {
      handle(_channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) {
        captured = (endpoint, payload) => handler(endpoint, payload, new AbortController().signal) as ReturnType<Captured['call']>
        return () => {}
      },
    },
  } as never)
  if (options.cwd !== undefined) {
    ctx.provide('agents', {
      get: (sessionId: string) => options.live === false ? undefined : sessionId === 'session-a' ? { session: { id: sessionId } } : undefined,
    } as never)
    ctx.provide('workingDirectory', {
      get: () => options.cwd,
      set: async (_agent: unknown, path: string) => {
        options.onSet?.(path)
        return path
      },
    } as never)
  }
  apply(ctx, {} as never)
  await new Promise((resolve) => setImmediate(resolve))
  if (captured === undefined) throw new Error('git RPC was not registered')
  return {
    call: captured,
    calls,
    dispose: () => fiber.dispose(),
  }
}

describe('session directory binding', { timeout: 20_000 }, () => {
  it('rejects lookalike services that do not expose get and set', () => {
    expect(bindSessionDirectory({}, {})).toBeUndefined()
    expect(bindSessionDirectory({ get: () => undefined }, { get: () => '/tmp' })).toBeUndefined()
    expect(bindSessionDirectory(
      { get: () => ({ session: {} }) },
      { get: () => '/repo', set: async () => '/repo' },
    )).toBeTypeOf('object')
  })

  it('refuses a write aimed at a different repository when the session directory is live', async () => {
    const repo = repository()
    const other = repository()
    const host = await mounted({ cwd: repo })
    try {
      const denied = await host.call('commit', { sessionId: 'session-a', repository: other, message: 'nope' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.message).toMatch(/does not match the session working directory/)
      expect(host.calls.some(call => call.argv.includes('commit'))).toBe(false)
      expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: other, encoding: 'utf8' }).trim()).toBe('initial')
      writeFileSync(join(repo, 'tracked.txt'), 'session\n')
      const staged = await host.call('stage', {
        sessionId: 'session-a',
        repository: repo,
        change: { path: 'tracked.txt', status: ' M' },
      })
      expect(staged.ok).toBe(true)
      expect(host.calls.some(call => call.argv.includes('add') && canonicalPath(call.cwd, repo) === canonicalPath(repo, repo))).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('keeps the previous write contract when no directory service is mounted', async () => {
    const repo = repository()
    const host = await mounted()
    try {
      const capability = await host.call('directory-capability', {})
      expect(capability).toEqual({ ok: true, value: { available: false } })
      const status = await host.call('status', { repository: repo })
      expect(status.ok).toBe(true)
      const denied = await host.call('set-directory', { sessionId: 'session-a', repository: repo, path: repo })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.message).toMatch(/unavailable/)
    } finally {
      await host.dispose()
    }
  })

  it('enters another worktree through the host directory service and does not create one', async () => {
    const repo = repository()
    const linked = `${repo}-linked`
    roots.push(linked)
    execFileSync('git', ['worktree', 'add', '-b', 'feature', linked, 'HEAD'], { cwd: repo })
    const entered: string[] = []
    const host = await mounted({ cwd: repo, onSet: (path) => { entered.push(path) } })
    try {
      const missingSession = await host.call('directory-capability', {})
      expect(missingSession).toEqual({ ok: true, value: { available: false } })
      const capability = await host.call('directory-capability', { sessionId: 'session-a' })
      expect(capability).toEqual({ ok: true, value: { available: true } })
      const otherSession = await host.call('directory-capability', { sessionId: 'session-b' })
      expect(otherSession).toEqual({ ok: true, value: { available: false } })
      const moved = await host.call('set-directory', {
        sessionId: 'session-a',
        repository: repo,
        path: linked,
      })
      expect(moved.ok).toBe(true)
      if (moved.ok) expect(canonicalPath((moved.value as { cwd: string }).cwd, repo)).toBe(canonicalPath(linked, repo))
      expect(entered.map(path => canonicalPath(path, repo))).toEqual([canonicalPath(linked, repo)])
      expect(host.calls.some(call => call.argv.includes('switch') || call.argv.includes('add'))).toBe(false)
      const outside = await host.call('set-directory', {
        sessionId: 'session-a',
        repository: repo,
        path: repo + '-nope',
      })
      expect(outside.ok).toBe(false)
      const cold = await mounted({ cwd: repo, live: false })
      try {
        const coldCapability = await cold.call('directory-capability', { sessionId: 'session-a' })
        expect(coldCapability).toEqual({ ok: true, value: { available: false } })
        writeFileSync(join(repo, 'tracked.txt'), 'cold\n')
        const unguarded = await cold.call('stage', {
          sessionId: 'session-a',
          repository: repo,
          change: { path: 'tracked.txt', status: ' M' },
        })
        expect(unguarded.ok).toBe(true)
        expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('cold\n')
      } finally {
        await cold.dispose()
      }
    } finally {
      await host.dispose()
    }
  })

  it('rejects writes when the live directory is not a repository', async () => {
    const repo = repository()
    const empty = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-empty-'))
    roots.push(empty)
    const host = await mounted({ cwd: empty })
    try {
      const denied = await host.call('commit', { sessionId: 'session-a', repository: repo, message: 'nope' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.message).toMatch(/not a Git repository/)
      expect(host.calls.some(call => call.argv.includes('commit'))).toBe(false)
    } finally {
      await host.dispose()
    }
  })
})
