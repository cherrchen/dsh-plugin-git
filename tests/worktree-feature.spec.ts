import { describe, expect, it, vi } from 'vitest'
import type { GitService } from '../src/service.ts'
import type { DirectoryAgent, SessionDirectory } from '../src/session-directory.ts'
import type { GitCreatedWorktree } from '../src/types.ts'
import {
  createSessionWorktree,
  isUpstreamWorktrees,
  isWorktreePoolFs,
  worktreeMode,
  type UpstreamWorktrees,
} from '../src/worktree-feature.ts'
import {
  DEFAULT_WORKTREE_DIRECTORY,
  isPoolDirectory,
  resolveWorktreeDirectory,
  validateWorktreeSettings,
  type WorktreeSettings,
} from '../src/worktree-settings.ts'

describe('worktree settings', () => {
  it('rejects a blank directory and accepts the unset and custom cases', () => {
    expect(() => validateWorktreeSettings({ directory: '  ' })).toThrow(/must not be empty/u)
    expect(() => validateWorktreeSettings({})).not.toThrow()
    expect(() => validateWorktreeSettings({ directory: '.wt' })).not.toThrow()
  })

  it('marks only in-repository relative directories as pool directories', () => {
    expect(isPoolDirectory('.agents/worktrees')).toBe(true)
    expect(isPoolDirectory('.wt/nested')).toBe(true)
    expect(isPoolDirectory('')).toBe(false)
    expect(isPoolDirectory('/abs/pool')).toBe(false)
    expect(isPoolDirectory('~/pool')).toBe(false)
    expect(isPoolDirectory('C:\\pool')).toBe(false)
    expect(isPoolDirectory('../outside')).toBe(false)
    expect(isPoolDirectory('./dot')).toBe(false)
    expect(isPoolDirectory('pool/')).toBe(false)
    expect(isPoolDirectory('a:b')).toBe(false)
  })

  it('resolves the configured directory or the upstream-matching default', () => {
    expect(resolveWorktreeDirectory(undefined)).toBe(DEFAULT_WORKTREE_DIRECTORY)
    expect(resolveWorktreeDirectory({})).toBe(DEFAULT_WORKTREE_DIRECTORY)
    expect(resolveWorktreeDirectory({ directory: '   ' })).toBe(DEFAULT_WORKTREE_DIRECTORY)
    expect(resolveWorktreeDirectory({ directory: ' .wt ' })).toBe('.wt')
  })
})

describe('upstream and fs probes', () => {
  it('detects the upstream runtime by its create method', () => {
    expect(isUpstreamWorktrees(undefined)).toBe(false)
    expect(isUpstreamWorktrees({})).toBe(false)
    expect(isUpstreamWorktrees({ create: 'not-a-function' })).toBe(false)
    expect(isUpstreamWorktrees({ create: async () => {} })).toBe(true)
  })

  it('detects the pool filesystem slice by its three methods', () => {
    expect(isWorktreePoolFs(undefined)).toBe(false)
    expect(isWorktreePoolFs({ lstat: async () => {}, resolve: async () => {} })).toBe(false)
    expect(isWorktreePoolFs({ lstat: async () => {}, resolve: async () => {}, writeText: async () => {} })).toBe(true)
  })
})

describe('worktreeMode', () => {
  it('lets a mounted upstream runtime win over the user toggle', () => {
    const upstream: UpstreamWorktrees = { create: async () => ({ path: '/p', branch: 'b', baseCommit: 'c' }) }
    expect(worktreeMode(upstream, {})).toBe('upstream')
    expect(worktreeMode(upstream, { enabled: false })).toBe('upstream')
  })

  it('maps the user toggle to local or off without upstream', () => {
    expect(worktreeMode(undefined, { enabled: true })).toBe('local')
    expect(worktreeMode(undefined, { enabled: false })).toBe('off')
    expect(worktreeMode(undefined, {})).toBe('off')
  })
})

function support(overrides: Partial<Parameters<typeof createSessionWorktree>[0]> = {}) {
  const created: GitCreatedWorktree = { path: '/repo/.agents/worktrees/named', branch: 'named', baseCommit: 'c0' }
  const agent: DirectoryAgent = { session: {} }
  const directory = {
    get: vi.fn(() => '/repo'),
    set: vi.fn(async (_sessionId: string, path: string) => `${path}-committed`),
    hasLiveAgent: vi.fn(() => true),
    agent: vi.fn(() => agent),
  } satisfies SessionDirectory
  const service = {
    createWorktree: vi.fn(async () => created),
  } as unknown as GitService
  return {
    created,
    agent,
    directory,
    service,
    base: {
      service,
      directory,
      upstream: undefined,
      fs: undefined,
      settings: () => ({ enabled: true }) as WorktreeSettings,
      ...overrides,
    },
  }
}

const SIGNAL = new AbortController().signal

describe('createSessionWorktree', () => {
  it('delegates to the upstream runtime with the session agent', async () => {
    const upstream: UpstreamWorktrees = {
      create: vi.fn(async () => ({ path: '/repo/.agents/worktrees/up', branch: 'up', baseCommit: 'c1' })),
    }
    const { agent, base } = support({ upstream })
    const created = await createSessionWorktree(base, { sessionId: 's1', name: 'up', from: 'main' }, SIGNAL)
    expect(upstream.create).toHaveBeenCalledWith(agent, { name: 'up', from: 'main' }, SIGNAL)
    expect(base.directory.set).not.toHaveBeenCalled()
    expect(base.service.createWorktree).not.toHaveBeenCalled()
    expect(created).toEqual({ path: '/repo/.agents/worktrees/up', branch: 'up', baseCommit: 'c1', entered: true })
  })

  it('omits undefined request fields and refuses upstream creation without a session', async () => {
    const upstream: UpstreamWorktrees = {
      create: vi.fn(async () => ({ path: '/p', branch: 'b', baseCommit: 'c' })),
    }
    const { agent, base } = support({ upstream })
    const created = await createSessionWorktree(base, { sessionId: 's1', repository: '/repo' }, SIGNAL)
    expect(upstream.create).toHaveBeenCalledWith(agent, {}, SIGNAL)
    expect(created.entered).toBe(true)
    await expect(createSessionWorktree(base, { name: 'x' }, SIGNAL)).rejects.toThrow(/needs a session/u)
    expect(upstream.create).toHaveBeenCalledTimes(1)
  })

  it('creates locally with the resolved directory and enters the live session', async () => {
    const { base, directory, service } = support({ settings: () => ({ enabled: true, directory: '.wt' }) })
    const created = await createSessionWorktree(base, { sessionId: 's1', repository: '/repo', name: 'named' }, SIGNAL)
    expect(service.createWorktree).toHaveBeenCalledWith('/repo', { name: 'named', directory: '.wt' }, undefined, SIGNAL)
    expect(directory.set).toHaveBeenCalledWith('s1', '/repo/.agents/worktrees/named', SIGNAL)
    // The committed directory replaces the created path.
    expect(created).toEqual({ path: '/repo/.agents/worktrees/named-committed', branch: 'named', baseCommit: 'c0', entered: true })
  })

  it('creates without entering when the session is not live', async () => {
    const { base, directory, created } = support()
    directory.hasLiveAgent.mockReturnValue(false)
    const result = await createSessionWorktree(base, { sessionId: 's1', repository: '/repo' }, SIGNAL)
    expect(directory.set).not.toHaveBeenCalled()
    expect(result).toEqual(created)
    expect(result.entered).toBeUndefined()
  })

  it('creates without a session id at all', async () => {
    const { base, directory, created } = support()
    const result = await createSessionWorktree(base, { repository: '/repo' }, SIGNAL)
    expect(directory.set).not.toHaveBeenCalled()
    expect(result).toEqual(created)
  })

  it('rejects local creation while the toggle is off and malformed fields', async () => {
    const disabled = support({ settings: () => ({ enabled: false }) })
    await expect(createSessionWorktree(disabled.base, { repository: '/repo' }, SIGNAL)).rejects.toThrow(/disabled/u)
    const { base } = support()
    await expect(createSessionWorktree(base, { repository: '' }, SIGNAL)).rejects.toThrow(/repository/u)
    await expect(createSessionWorktree(base, { repository: '/repo', name: 7 }, SIGNAL)).rejects.toThrow(/name/u)
  })
})
