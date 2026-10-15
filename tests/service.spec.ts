import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '../src/path-identity.ts'
import { GitService } from '../src/service.ts'
import { GitSessionControllers } from '../src/client/session-controllers.ts'
import type { GitRpcClient } from '../src/client/controller.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function service(executable = 'git', maxOutputBytes = 1024 * 1024): Promise<{ dispose: () => Promise<void>; git: GitService }> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalSubprocessRuntime)
  await fiber.await()
  return {
    dispose: () => fiber.dispose(),
    git: new GitService(ctx.subprocess, { executable, maxOutputBytes, graceMs: 1000 }),
  }
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-'))
  roots.push(root)
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Git Plugin Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'git-plugin@example.invalid'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'initial\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root })
  return root
}

describe('portable Git service', { timeout: 20_000 }, () => {
  it('recovers executable discovery after a cancelled first request', async () => {
    const repo = repository()
    const { dispose, git } = await service()
    try {
      const cancelled = new AbortController()
      const first = git.discover(repo, cancelled.signal)
      const independent = git.discover(repo)
      cancelled.abort()
      await Promise.all([
        expect(first).rejects.toMatchObject({ name: 'AbortError' }),
        expect(independent).resolves.toBe(realpathSync(repo)),
      ])
      expect(await git.discover(repo)).toBe(realpathSync(repo))
      expect((await git.status(repo)).branch).toBe('main')
      expect((await git.log(repo, 10, 0))[0]?.subject).toBe('initial')
    } finally {
      await dispose()
    }
  })

  it('loads shared session UI data through real Git during overlapping tab mounts', async () => {
    const repo = repository()
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    const { dispose, git } = await service()
    const rpc: GitRpcClient = {
      call: async (_channel, endpoint, payload, signal) => {
        const request = payload as Record<string, string>
        try {
          let value: unknown
          switch (endpoint) {
            case 'discover': value = await git.discover(request['path']!, signal); break
            case 'status': value = await git.status(request['repository']!, signal); break
            case 'log': value = await git.log(request['repository']!, 25, 0, 'auto', signal); break
            case 'worktree-capability': value = { mode: 'local', directory: '.agents/worktrees' }; break
            default: value = { available: false }
          }
          return { ok: true, value }
        } catch (error) {
          return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        }
      },
    }
    const sessions = new GitSessionControllers(rpc)
    try {
      const composer = sessions.controllerFor('session-a')
      const worktrees = sessions.controllerFor('session-a')
      const otherSession = sessions.controllerFor('session-b')
      const binding = composer.setWorkspace(repo)
      composer.setCommitMessage('saved draft')
      const refresh = worktrees.refresh()
      await Promise.all([binding, refresh, worktrees.setWorkspace(repo), otherSession.setWorkspace(repo)])
      await Promise.all([composer.loadGraph(), otherSession.loadGraph()])
      for (const controller of [composer, otherSession]) {
        const state = controller.getSnapshot()
        expect(state.error).toBeUndefined()
        expect(state.repository?.branch).toBe('main')
        expect(state.repository?.branches.map(branch => branch.name)).toContain('main')
        expect(state.repository?.unstaged.map(change => change.path)).toContain('tracked.txt')
        expect(state.repository?.untracked).toContain('new.txt')
        expect(state.repository?.worktrees?.some(entry => entry.current)).toBe(true)
        expect(state.graph[0]?.subject).toBe('initial')
        expect(state.worktreeMode).toBe('local')
      }
      expect(composer.getSnapshot().commitMessage).toBe('saved draft')
    } finally {
      sessions.dispose()
      await dispose()
    }
  })

  it('detects non-repositories and reads clean repositories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-empty-'))
    roots.push(root)
    const { dispose, git } = await service()
    expect(await git.discover(root)).toBeNull()
    const repo = repository()
    const snapshot = await git.status(repo)
    expect(snapshot.root).toBe(realpathSync(repo))
    expect(snapshot.branch).toBe('main')
    expect(snapshot.staged).toEqual([])
    expect(snapshot.unstaged).toEqual([])
    expect(snapshot.untracked).toEqual([])
    await dispose()
  })

  it('stages, unstages, commits, creates branches, switches, and reads diffs', async () => {
    const repo = repository()
    const { dispose, git } = await service()
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    let snapshot = await git.status(repo)
    expect(snapshot.unstaged.map(change => change.path)).toContain('tracked.txt')
    expect(snapshot.untracked).toContain('new.txt')
    expect((await git.diff(repo, false, 'tracked.txt')).text).toContain('+changed')
    snapshot = await git.stage(repo, { path: 'tracked.txt', status: ' M' })
    expect(snapshot.staged.map(change => change.path)).toContain('tracked.txt')
    snapshot = await git.unstage(repo, { path: 'tracked.txt', status: 'M ' })
    expect(snapshot.unstaged.map(change => change.path)).toContain('tracked.txt')
    await git.stage(repo)
    expect((await git.diff(repo, true)).text).toContain('+changed')
    snapshot = await git.commit(repo, 'update files')
    expect(snapshot.staged).toEqual([])
    snapshot = await git.createBranch(repo, 'feature/test')
    expect(snapshot.branches.map(branch => branch.name)).toContain('feature/test')
    snapshot = await git.switchBranch(repo, 'feature/test')
    expect(snapshot.branch).toBe('feature/test')
    await dispose()
  })

  it('reports an invalid Git executable', async () => {
    const repo = repository()
    const { dispose, git } = await service('definitely-not-a-git-executable')
    await expect(git.status(repo)).rejects.toThrow()
    await dispose()
  })

  it('represents a detached HEAD without inventing a branch', async () => {
    const repo = repository()
    execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: repo })
    const { dispose, git } = await service()
    const snapshot = await git.status(repo)
    expect(snapshot.branch).toBeNull()
    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/u)
    await dispose()
  })

  it('reports an empty branch list after git init before the first commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-unborn-'))
    roots.push(root)
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    const { dispose, git } = await service()
    const snapshot = await git.status(root)
    expect(snapshot.branch).toBe('main')
    expect(snapshot.head).toBeNull()
    expect(snapshot.branches).toEqual([])
    await expect(git.createBranch(root, 'feature')).rejects.toThrow(/not a valid object name/iu)
    await dispose()
  })

  it('preserves Git command failures instead of reporting a missing repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-failing-'))
    roots.push(root)
    const executable = join(root, 'failing-git')
    writeFileSync(executable, '#!/bin/sh\nprintf permission-denied >&2\nexit 42\n')
    chmodSync(executable, 0o755)
    const { dispose, git } = await service(executable, 1024)
    await expect(git.discover(root)).rejects.toMatchObject({ exitCode: 42, stderr: 'permission-denied' })
    await dispose()
  })

  it('reads paged history and discards unstaged changes', async () => {
    const { dispose, git } = await service()
    try {
      const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-log-'))
      roots.push(root)
      execFileSync('git', ['init', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Git Plugin Test'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'git-plugin@example.invalid'], { cwd: root })
      execFileSync('git', ['commit', '--allow-empty', '-m', 'first'], { cwd: root })
      execFileSync('git', ['commit', '--allow-empty', '-m', 'second'], { cwd: root })

      const page = await git.log(root, 10, 0)
      expect(page.map(commit => commit.subject)).toEqual(['second', 'first'])
      const skipped = await git.log(root, 10, 1)
      expect(skipped.map(commit => commit.subject)).toEqual(['first'])

      writeFileSync(join(root, 'tracked.txt'), 'initial\nchanged\n')
      execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
      await git.discard(root, { path: 'tracked.txt', status: 'MM' })
      const snapshot = await git.status(root)
      expect(snapshot.unstaged).toEqual([])
      expect(snapshot.staged.map(change => change.path)).toEqual(['tracked.txt'])
    } finally {
      await dispose()
    }
  })

  it('applies the history scope to the log command', async () => {
    const { dispose, git } = await service()
    try {
      const root = repository()
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root })
      writeFileSync(join(root, 'feature.txt'), 'feature\n')
      execFileSync('git', ['add', 'feature.txt'], { cwd: root })
      execFileSync('git', ['commit', '-m', 'feature work'], { cwd: root })
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root })
      writeFileSync(join(root, 'main.txt'), 'main\n')
      execFileSync('git', ['add', 'main.txt'], { cwd: root })
      execFileSync('git', ['commit', '-m', 'main work'], { cwd: root })
      execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'], { cwd: root })

      const auto = await git.log(root, 10, 0)
      expect(auto.map(commit => commit.subject)).toEqual(['merge feature', 'main work', 'feature work', 'initial'])
      // First-parent scope mirrors `git log --first-parent`: the side branch
      // commit is not part of the queried history at all.
      const firstParent = await git.log(root, 10, 0, 'first-parent')
      expect(firstParent.map(commit => commit.subject)).toEqual(['merge feature', 'main work', 'initial'])
      // All-refs scope keeps both parents' ancestry (and stays valid).
      const all = await git.log(root, 10, 0, 'all')
      expect(all.map(commit => commit.subject)).toEqual(['merge feature', 'main work', 'feature work', 'initial'])
    } finally {
      await dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('discards one magic pathspec filename without resetting other files', async () => {
    // Windows rejects `:` in a basename, so this Git magic filename cannot be created there.
    const { dispose, git } = await service()
    try {
      const root = repository()
      const magicName = ':(glob)*.txt'
      writeFileSync(join(root, magicName), 'magic\n')
      writeFileSync(join(root, 'other.txt'), 'other\n')
      execFileSync('git', ['add', '--', magicName, 'other.txt'], { cwd: root })
      execFileSync('git', ['commit', '-m', 'special names'], { cwd: root })
      writeFileSync(join(root, magicName), 'magic-changed\n')
      writeFileSync(join(root, 'other.txt'), 'other-changed\n')

      await git.discard(root, { path: magicName, status: ' M' })
      expect(readFileSync(join(root, magicName), 'utf8')).toBe('magic\n')
      expect(readFileSync(join(root, 'other.txt'), 'utf8')).toBe('other-changed\n')
    } finally {
      await dispose()
    }
  })

  it('parses unmerged conflict paths without object hashes', async () => {
    const { dispose, git } = await service()
    try {
      const root = repository()
      writeFileSync(join(root, 'conflict.txt'), 'base\n')
      execFileSync('git', ['add', 'conflict.txt'], { cwd: root })
      execFileSync('git', ['commit', '-m', 'base conflict'], { cwd: root })
      execFileSync('git', ['checkout', '-b', 'other'], { cwd: root })
      writeFileSync(join(root, 'conflict.txt'), 'other\n')
      execFileSync('git', ['commit', '-am', 'other'], { cwd: root })
      execFileSync('git', ['checkout', 'main'], { cwd: root })
      writeFileSync(join(root, 'conflict.txt'), 'main\n')
      execFileSync('git', ['commit', '-am', 'main'], { cwd: root })
      try {
        execFileSync('git', ['merge', '--no-ff', 'other'], { cwd: root })
      } catch {
        // The merge stops on the UU conflict under test.
      }

      const snapshot = await git.status(root)
      expect(snapshot.unstaged.map(change => change.path)).toEqual(['conflict.txt'])
    } finally {
      await dispose()
    }
  })

  it('amends HEAD, pushes to a bare origin, and discards an untracked path', async () => {
    const { dispose, git } = await service()
    try {
      const root = repository()
      writeFileSync(join(root, 'tracked.txt'), 'changed\n')
      await git.stage(root, { path: 'tracked.txt', status: ' M' })
      await git.commit(root, 'first change')
      writeFileSync(join(root, 'tracked.txt'), 'changed again\n')
      await git.stage(root, { path: 'tracked.txt', status: ' M' })
      await git.commit(root, 'amended', undefined, true)
      const log = await git.log(root, 10, 0)
      expect(log.map(commit => commit.subject)).toEqual(['amended', 'initial'])

      const bare = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-bare-'))
      roots.push(bare)
      execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare })
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: root })
      await git.push(root)
      const remoteLog = execFileSync('git', ['-C', bare, 'log', '--format=%s'], { encoding: 'utf8' })
      expect(remoteLog).toContain('amended')

      writeFileSync(join(root, 'scratch.txt'), 'temp\n')
      expect(existsSync(join(root, 'scratch.txt'))).toBe(true)
      await git.discard(root, { path: 'scratch.txt', status: '??' }, undefined, 'untracked')
      expect(existsSync(join(root, 'scratch.txt'))).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('discards staged additions and renames after their working-tree content changes', async () => {
    const { dispose, git } = await service()
    try {
      const root = repository()
      writeFileSync(join(root, 'added.txt'), 'added\n')
      await git.stage(root, { path: 'added.txt', status: '??' })
      writeFileSync(join(root, 'added.txt'), 'edited after staging\n')
      const added = (await git.status(root)).staged.find(change => change.path === 'added.txt')
      expect(added).toMatchObject({ status: 'AM' })
      await git.discard(root, added, undefined, 'head')
      expect(existsSync(join(root, 'added.txt'))).toBe(false)
      expect((await git.status(root)).staged).toEqual([])

      execFileSync('git', ['mv', 'tracked.txt', 'renamed.txt'], { cwd: root })
      writeFileSync(join(root, 'renamed.txt'), 'edited after staging\n')
      const renamed = (await git.status(root)).staged.find(change => change.path === 'renamed.txt')
      expect(renamed).toMatchObject({ status: 'RM', originalPath: 'tracked.txt' })
      await git.discard(root, renamed, undefined, 'head')
      expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('initial\n')
      expect(existsSync(join(root, 'renamed.txt'))).toBe(false)
      const afterDiscard = await git.status(root)
      expect(afterDiscard.staged).toEqual([])
      expect(afterDiscard.unstaged).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('follows a subdirectory, a linked worktree, and a missing directory', async () => {
    const repo = repository()
    const linked = `${repo}-linked`
    roots.push(linked)
    execFileSync('git', ['worktree', 'add', '-b', 'feature', linked, 'HEAD'], { cwd: repo })
    mkdirSync(join(repo, 'nested'))
    mkdirSync(join(linked, 'nested'))
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
    const git = new GitService(runtime, { executable: 'git', maxOutputBytes: 1024 * 1024, graceMs: 1000 })
    try {
      const nested = await git.status(join(repo, 'nested'))
      expect(nested.root).toBe(realpathSync(repo))
      expect(nested.checkout?.kind).toBe('main')
      expect(nested.branch).toBe('main')
      const mainHead = nested.head
      const linkedStatus = await git.status(join(linked, 'nested'))
      expect(linkedStatus.root).toBe(realpathSync(linked))
      expect(linkedStatus.checkout?.kind).toBe('linked')
      expect(linkedStatus.branch).toBe('feature')
      expect(linkedStatus.worktrees?.filter(entry => entry.current).map(entry => entry.path)).toEqual([realpathSync(linked)])
      expect(linkedStatus.worktrees?.map(entry => entry.branch).sort()).toEqual(['feature', 'main'])
      writeFileSync(join(linked, 'tracked.txt'), 'worktree\n')
      expect((await git.diff(linked, false, 'tracked.txt')).text).toContain('+worktree')
      await git.stage(linked, { path: 'tracked.txt', status: ' M' })
      const committed = await git.commit(linked, 'in worktree')
      expect(committed.branch).toBe('feature')
      expect(committed.head).not.toBe(mainHead)
      const mainAfter = await git.status(repo)
      expect(mainAfter.head).toBe(mainHead)
      expect(mainAfter.branch).toBe('main')
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('initial\n')
      const commitCalls = calls.filter(call => call.argv.includes('commit'))
      expect(commitCalls.length).toBeGreaterThan(0)
      expect(commitCalls.every(call => canonicalPath(call.cwd, repo) === realpathSync(linked))).toBe(true)
      await expect(git.discover(join(repo, 'missing'))).rejects.toThrow()
      expect((await git.status(repo)).head).toBe(mainHead)
      const aborted = new AbortController()
      aborted.abort()
      await expect(git.status(repo, aborted.signal)).rejects.toThrow()
      const notGit = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-not-git-'))
      roots.push(notGit)
      expect(await git.discover(notGit)).toBeNull()
    } finally {
      await fiber.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('fails instead of parsing truncated Git output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-git-lossy-'))
    roots.push(root)
    const executable = join(root, 'lossy-git')
    writeFileSync(executable, '#!/bin/sh\nyes x | head -c 2048\n')
    chmodSync(executable, 0o755)
    const { dispose, git } = await service(executable, 1024)
    try {
      await expect(git.discover(root)).rejects.toThrow(/output exceeded 1024 bytes/)
    } finally {
      await dispose()
    }
  })
})
