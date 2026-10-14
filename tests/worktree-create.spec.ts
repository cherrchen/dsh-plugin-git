import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService, type WorktreePoolFs } from '../src/service.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function tempdir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function repository(): string {
  const root = tempdir('dsh-plugin-git-wt-')
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Git Plugin Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'git-plugin@example.invalid'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'initial\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root })
  return root
}

async function service(): Promise<{ dispose: () => Promise<void>; git: GitService }> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalSubprocessRuntime)
  await fiber.await()
  return {
    dispose: () => fiber.dispose(),
    git: new GitService(ctx.subprocess, { executable: 'git', maxOutputBytes: 1024 * 1024, graceMs: 1000 }),
  }
}

/** Filesystem slice backed by the host fs so the pool marker lands for real. */
function hostFs(): { fs: WorktreePoolFs; writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn(async (target: { displayPath: string }, content: string) => {
    writeFileSync(target.displayPath, content, { flag: 'wx' })
    return {}
  })
  return {
    writeText,
    fs: {
      lstat: async (path: string) => (existsSync(path) ? { type: 'directory' } : undefined),
      resolve: async (path: string) => ({ displayPath: path, targetKey: path }),
      writeText: writeText as WorktreePoolFs['writeText'],
    },
  }
}

describe('GitService.createWorktree', { timeout: 20_000 }, () => {
  it('creates a branch and checkout in the default pool at HEAD', async () => {
    const repo = repository()
    const { dispose, git } = await service()
    try {
      const created = await git.createWorktree(repo)
      expect(created.branch).toMatch(/^worktree-[0-9a-f-]{36}$/u)
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
      expect(created.baseCommit).toBe(head)
      expect(created.path).toBe(`${realpathSync(repo)}/.agents/worktrees/${created.branch}`)
      expect(existsSync(join(created.path, 'tracked.txt'))).toBe(true)
      expect(readFileSync(join(created.path, 'tracked.txt'), 'utf8')).toBe('initial\n')
      const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
      expect(listed).toContain(`branch refs/heads/${created.branch}`)
      const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: repo, encoding: 'utf8' })
      expect(branches).toContain(created.branch)
    } finally {
      await dispose()
    }
  })

  it('honors an explicit name, a non-HEAD base, and a custom relative pool', async () => {
    const repo = repository()
    const { dispose, git } = await service()
    try {
      execFileSync('git', ['commit', '--allow-empty', '-m', 'second'], { cwd: repo })
      const first = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repo, encoding: 'utf8' }).trim()
      const created = await git.createWorktree(repo, { name: 'feature/wt', from: first, directory: '.wt' })
      expect(created.branch).toBe('feature/wt')
      expect(created.baseCommit).toBe(first)
      expect(created.path).toBe(`${realpathSync(repo)}/.wt/feature/wt`)
      // The checkout pins the older commit, not HEAD.
      const checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.path, encoding: 'utf8' }).trim()
      expect(checkoutHead).toBe(first)
      const headBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
      expect(headBranch).toBe('main')
    } finally {
      await dispose()
    }
  })

  it('supports an absolute pool outside the repository', async () => {
    const repo = repository()
    const pool = tempdir('dsh-plugin-git-pool-')
    const { dispose, git } = await service()
    try {
      const created = await git.createWorktree(repo, { name: 'outside', directory: pool })
      expect(created.path).toBe(join(pool, 'outside'))
      expect(existsSync(join(created.path, 'tracked.txt'))).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('rejects an existing branch, an invalid name, and an unknown base', async () => {
    const repo = repository()
    const { dispose, git } = await service()
    try {
      await expect(git.createWorktree(repo, { name: 'main' })).rejects.toThrow(/already exists/u)
      await expect(git.createWorktree(repo, { name: 'a..b' })).rejects.toThrow()
      await expect(git.createWorktree(repo, { name: 'foo\\bar' })).rejects.toThrow(/relative Git branch name/u)
      await expect(git.createWorktree(repo, { name: 'foo:bar' })).rejects.toThrow(/relative Git branch name/u)
      await expect(git.createWorktree(repo, { name: '-bad' })).rejects.toThrow(/relative Git branch name/u)
      await expect(git.createWorktree(repo, { name: 'fresh', from: 'no-such-ref' })).rejects.toThrow()
      // Rejected names leave no branch or checkout behind.
      expect(execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('main')
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).match(/worktree /gu)).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('rejects an occupied destination reported by the filesystem slice', async () => {
    const repo = repository()
    const occupied = tempdir('dsh-plugin-git-occupied-')
    mkdirSync(join(occupied, 'taken'))
    const { dispose, git } = await service()
    const { fs } = hostFs()
    try {
      await expect(git.createWorktree(repo, { name: 'taken', directory: occupied }, fs)).rejects.toThrow(/already exists/u)
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).match(/worktree /gu)).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it.each([
    String.raw`\\server\share\worktrees`,
    String.raw`\worktrees`,
    String.raw`C:\worktrees`,
    'C:/worktrees',
    '//server/share/worktrees',
    '/worktrees',
  ])('keeps absolute pool %s when checking the destination', async (directory) => {
    const repo = repository()
    const { dispose, git } = await service()
    const lstat = vi.fn(async () => ({ type: 'directory' }))
    const fs: WorktreePoolFs = {
      lstat,
      resolve: vi.fn(),
      writeText: vi.fn(),
    }
    try {
      // Stop at the occupied destination so Windows paths are exercised on any
      // test platform without trying to create a remote checkout.
      await expect(git.createWorktree(repo, { name: 'taken', directory }, fs)).rejects.toThrow(/already exists/u)
      expect(lstat).toHaveBeenCalledWith(`${directory}/taken`, undefined, undefined)
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).match(/worktree /gu)).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('marks a fresh in-repository pool with a self-ignoring .gitignore', async () => {
    const repo = repository()
    const { dispose, git } = await service()
    const { fs, writeText } = hostFs()
    try {
      await git.createWorktree(repo, { name: 'first' }, fs)
      const marker = join(realpathSync(repo), '.agents', 'worktrees', '.gitignore')
      expect(readFileSync(marker, 'utf8')).toBe('*\n')
      // A second checkout into the existing pool does not rewrite the marker.
      await git.createWorktree(repo, { name: 'second' }, fs)
      expect(writeText).toHaveBeenCalledTimes(1)
      // An absolute pool outside the repository gets no marker.
      const pool = tempdir('dsh-plugin-git-outside-pool-')
      const poolTarget = join(pool, 'sub')
      await git.createWorktree(repo, { name: 'third', directory: poolTarget }, fs)
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(existsSync(join(poolTarget, '.gitignore'))).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('keeps the created checkout when the pool marker write fails', async () => {
    const repo = repository()
    const { dispose, git } = await service()
    const fs: WorktreePoolFs = {
      lstat: async () => undefined,
      resolve: async path => ({ displayPath: path, targetKey: path }),
      writeText: async () => {
        throw new Error('fs: read-only pool')
      },
    }
    try {
      const created = await git.createWorktree(repo, { name: 'kept' }, fs)
      expect(existsSync(join(created.path, 'tracked.txt'))).toBe(true)
      const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: repo, encoding: 'utf8' })
      expect(branches).toContain('kept')
    } finally {
      await dispose()
    }
  })

  it('surfaces the created checkout in listWorktrees', async () => {
    const repo = repository()
    const { dispose, git } = await service()
    try {
      const created = await git.createWorktree(repo, { name: 'listed' })
      const worktrees = await git.listWorktrees(repo)
      const entry = worktrees.find(worktree => worktree.path === created.path)
      expect(entry).toMatchObject({ branch: 'listed', current: false, bare: false })
    } finally {
      await dispose()
    }
  })
})
