import { describe, expect, it, vi } from 'vitest'
import type { GitRepositorySnapshot } from '../src/types.ts'
import { GitClientController, type GitRpcClient } from '../src/client/controller.ts'
import { decodeWorktreeCapability, GitWorktreeFeature } from '../src/client/worktree-feature.ts'
import {
  GIT_WORKTREE_SETTINGS_NAMESPACE,
  WorktreeSettingsCardController,
  type WorktreeCardSettings,
} from '../src/client/settings/worktree-card-controller.ts'
import type {
  CommitMessageSettingsForm,
  GitSettingsMutation,
} from '../src/client/settings/commit-message-card-controller.ts'

function snapshot(overrides: Partial<GitRepositorySnapshot> = {}): GitRepositorySnapshot {
  return {
    root: '/repo',
    version: '2.43.0',
    branch: 'main',
    head: 'abc123',
    staged: [],
    unstaged: [],
    untracked: [],
    branches: [{ name: 'main', head: 'abc123', current: true }],
    ...overrides,
  }
}

function rpc(answers: Record<string, unknown>): GitRpcClient & { calls: Array<{ endpoint: string; payload: unknown }> } {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  return {
    calls,
    call: vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      const answer = answers[endpoint]
      if (answer instanceof Error) return { ok: false as const, error: { message: answer.message } }
      return { ok: true as const, value: answer ?? null }
    }),
  }
}

const BIND: Record<string, unknown> = {
  discover: '/repo',
  status: snapshot(),
  log: [],
  'commit-message-capability': { available: false },
  'directory-capability': { available: false },
}

describe('decodeWorktreeCapability', () => {
  it('maps only the known modes and keeps the directory string', () => {
    expect(decodeWorktreeCapability(undefined)).toEqual({ mode: 'off', directory: '' })
    expect(decodeWorktreeCapability({ mode: 'sideways', directory: 7 })).toEqual({ mode: 'off', directory: '' })
    expect(decodeWorktreeCapability({ mode: 'upstream', directory: '.agents/worktrees' })).toEqual({ mode: 'upstream', directory: '.agents/worktrees' })
    expect(decodeWorktreeCapability({ mode: 'local' })).toEqual({ mode: 'local', directory: '' })
  })
})

describe('GitWorktreeFeature', () => {
  it('publishes the polled capability to subscribers', async () => {
    const client = rpc({ 'worktree-capability': { mode: 'local', directory: '.wt' } })
    const feature = new GitWorktreeFeature(client)
    const seen: Array<string | undefined> = []
    feature.subscribe(() => seen.push(feature.getSnapshot().mode))
    feature.refresh()
    await vi.waitFor(() => expect(feature.getSnapshot().mode).toBe('local'))
    expect(feature.getSnapshot().directory).toBe('.wt')
    expect(seen).toEqual(['local'])
    feature.dispose()
  })

  it('shares one in-flight poll between concurrent refreshes', async () => {
    let calls = 0
    const client: GitRpcClient = {
      call: async () => {
        calls += 1
        return { ok: true as const, value: { mode: 'upstream', directory: '' } }
      },
    }
    const feature = new GitWorktreeFeature(client)
    feature.refresh()
    feature.refresh()
    await vi.waitFor(() => expect(feature.getSnapshot().mode).toBe('upstream'))
    expect(calls).toBe(1)
    feature.dispose()
  })

  it('keeps the last known mode when a poll fails', async () => {
    let fail = false
    const client: GitRpcClient = {
      call: async () => {
        if (fail) throw new Error('transport down')
        return { ok: true as const, value: { mode: 'local', directory: '' } }
      },
    }
    const feature = new GitWorktreeFeature(client)
    feature.refresh()
    await vi.waitFor(() => expect(feature.getSnapshot().mode).toBe('local'))
    fail = true
    feature.refresh()
    await vi.waitFor(() => expect(feature.getSnapshot().mode).toBe('local'))
    feature.dispose()
  })

  it('ignores late answers and further refreshes after dispose', async () => {
    let resolve: ((value: { ok: true; value: unknown }) => void) | undefined
    const client: GitRpcClient = {
      call: () => new Promise<{ ok: true; value: unknown }>((inner) => { resolve = inner }),
    }
    const feature = new GitWorktreeFeature(client)
    feature.refresh()
    feature.dispose()
    resolve?.({ ok: true, value: { mode: 'local', directory: '' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(feature.getSnapshot().mode).toBeUndefined()
  })
})

describe('GitClientController worktrees', () => {
  it('adopts the host worktree mode during workspace bind', async () => {
    const client = rpc({ ...BIND, 'worktree-capability': { mode: 'local', directory: '.wt' } })
    const controller = new GitClientController(client)
    await controller.setWorkspace('/workspace')
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ worktreeMode: 'local', worktreeDirectory: '.wt' }))
  })

  it('reports off when the host predates the capability endpoint', async () => {
    const client = rpc({
      ...BIND,
      'worktree-capability': new Error('unknown Git endpoint "worktree-capability"'),
    })
    const controller = new GitClientController(client)
    await controller.setWorkspace('/workspace')
    await vi.waitFor(() => expect(controller.getSnapshot().worktreeMode).toBe('off'))
  })

  it('posts create-worktree with the session id and reloads the repository', async () => {
    const created = { path: '/repo/.agents/worktrees/w1', branch: 'w1', baseCommit: 'abc123' }
    const client = rpc({ ...BIND, 'worktree-capability': { mode: 'local', directory: '' }, 'create-worktree': created })
    const controller = new GitClientController(client, 'session-a')
    await controller.setWorkspace('/workspace')
    const before = client.calls.filter(call => call.endpoint === 'status').length
    const result = await controller.createWorktree('w1', 'HEAD~1')
    const request = client.calls.find(call => call.endpoint === 'create-worktree')
    expect(request?.payload).toEqual({ repository: '/repo', name: 'w1', from: 'HEAD~1', sessionId: 'session-a' })
    expect(result).toEqual(created)
    expect(client.calls.filter(call => call.endpoint === 'status').length).toBeGreaterThan(before)
    expect(controller.getSnapshot().creatingWorktree).toBe(false)
  })

  it('surfaces a creation failure without losing repository state', async () => {
    const client = rpc({
      ...BIND,
      'worktree-capability': { mode: 'local', directory: '' },
      'create-worktree': new Error('git: worktree branch already exists: w1'),
    })
    const controller = new GitClientController(client)
    await controller.setWorkspace('/workspace')
    await expect(controller.createWorktree('w1')).rejects.toThrow(/already exists/u)
    expect(controller.getSnapshot().worktreeCreateError).toMatch(/already exists/u)
    expect(controller.getSnapshot().repository?.branch).toBe('main')
    expect(controller.getSnapshot().creatingWorktree).toBe(false)
  })
})

interface ScopeHost {
  scope: CommitMessageSettingsForm<WorktreeCardSettings>
  mutate: ReturnType<typeof vi.fn>
  publish: (next: Record<string, unknown>) => void
}

function fakeScope(initial: Record<string, unknown> = {}): ScopeHost {
  let snapshot: Record<string, unknown> = {
    status: 'ready',
    value: {},
    revision: 0,
    writable: true,
    mode: 'host',
    ...initial,
  }
  const listeners = new Set<() => void>()
  const mutate = vi.fn(async (ops: readonly GitSettingsMutation[]) => {
    const next = { ...(snapshot['value'] as WorktreeCardSettings) }
    for (const op of ops) {
      const field = op.path[0]
      if (typeof field !== 'string') continue
      if (op.op === 'set') {
        next[field as keyof WorktreeCardSettings] = op.value as never
      } else {
        delete next[field as keyof WorktreeCardSettings]
      }
    }
    snapshot = { ...snapshot, value: next, revision: (snapshot['revision'] as number) + 1 }
    for (const listener of listeners) listener()
  })
  return {
    mutate,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
    scope: {
      getSnapshot: () => snapshot as never,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      mutate: mutate as CommitMessageSettingsForm<WorktreeCardSettings>['mutate'],
    },
  }
}

describe('WorktreeSettingsCardController', () => {
  it('edits the git-worktrees namespace', () => {
    expect(GIT_WORKTREE_SETTINGS_NAMESPACE).toBe('git-worktrees')
  })

  it('hides while the namespace is unavailable and stays read-only when not writable', () => {
    const host = fakeScope({ status: 'unavailable', value: undefined })
    const subject = new WorktreeSettingsCardController(host.scope)
    expect(subject.getSnapshot().available).toBe(false)
    subject.dispose()
    const locked = fakeScope({ writable: false })
    const card = new WorktreeSettingsCardController(locked.scope)
    card.setEnabled(true)
    expect(card.getSnapshot().enabled).toBe(false)
    expect(locked.mutate).not.toHaveBeenCalled()
    card.dispose()
  })

  it('stages edits without writing and discards them', () => {
    const host = fakeScope()
    const subject = new WorktreeSettingsCardController(host.scope)
    subject.setEnabled(true)
    subject.setDirectory('.wt')
    expect(subject.getSnapshot()).toMatchObject({ enabled: true, directory: '.wt', dirty: true })
    expect(host.mutate).not.toHaveBeenCalled()
    subject.discard()
    expect(subject.getSnapshot()).toMatchObject({ enabled: false, directory: '', dirty: false })
    subject.dispose()
  })

  it('writes enabled and a custom directory as one mutation and fires onSaved', async () => {
    const host = fakeScope()
    const onSaved = vi.fn()
    const subject = new WorktreeSettingsCardController(host.scope, onSaved)
    subject.setEnabled(true)
    subject.setDirectory('.wt')
    subject.save()
    await vi.waitFor(() => expect(subject.getSnapshot().dirty).toBe(false))
    expect(host.mutate.mock.calls[0]![0]).toEqual([
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['directory'], value: '.wt' },
    ])
    expect(onSaved).toHaveBeenCalledTimes(1)
    subject.dispose()
  })

  it('unsets fields back to defaults and fires onSaved when the clear lands', async () => {
    const host = fakeScope({ value: { enabled: true, directory: '.wt' } })
    const onSaved = vi.fn()
    const subject = new WorktreeSettingsCardController(host.scope, onSaved)
    subject.setEnabled(false)
    subject.setDirectory('')
    subject.save()
    await vi.waitFor(() => expect(subject.getSnapshot().dirty).toBe(false))
    expect(host.mutate.mock.calls[0]![0]).toEqual([
      { op: 'unset', path: ['enabled'] },
      { op: 'unset', path: ['directory'] },
    ])
    expect(onSaved).toHaveBeenCalledTimes(1)
    subject.dispose()
  })

  it('marks the save failed when the scope moved past the staged revision', async () => {
    const host = fakeScope()
    const subject = new WorktreeSettingsCardController(host.scope)
    subject.setEnabled(true)
    host.publish({ revision: 7 })
    subject.save()
    await Promise.resolve()
    expect(host.mutate).not.toHaveBeenCalled()
    expect(subject.getSnapshot().failed).toBe(true)
    subject.dispose()
  })
})
