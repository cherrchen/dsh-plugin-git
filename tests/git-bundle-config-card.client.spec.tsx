// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CommitMessageSettingsCardController, type CommitMessageSettingsCardState, type CommitMessageSettingsForm, type GitSettingsMutation } from '../src/client/settings/commit-message-card-controller.ts'
import { WorktreeSettingsCardController, type WorktreeSettingsCardState } from '../src/client/settings/worktree-card-controller.ts'
import { GitBundleConfigCard } from '../src/client/settings/GitBundleConfigCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

const locale: PropsLocale<'git'> = { t: (key) => en[key] }

function commitReady(overrides: Partial<CommitMessageSettingsCardState> = {}): CommitMessageSettingsCardState {
  return {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    mode: 'inherit',
    provider: '',
    model: '',
    systemPrompt: '',
    candidates: [],
    catalogStatus: 'idle',
    catalogPartial: false,
    ...overrides,
  }
}

function worktreeReady(overrides: Partial<WorktreeSettingsCardState> = {}): WorktreeSettingsCardState {
  return {
    available: true,
    writable: true,
    dirty: false,
    saving: false,
    failed: false,
    enabled: false,
    directory: '',
    ...overrides,
  }
}

function commitControllerOf(state: CommitMessageSettingsCardState): CommitMessageSettingsCardController {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    setMode: vi.fn(),
    setModel: vi.fn(),
    setProviderText: vi.fn(),
    setModelText: vi.fn(),
    setSystemPrompt: vi.fn(),
    retryCatalog: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    dispose: vi.fn(),
  } as unknown as CommitMessageSettingsCardController
}

function worktreeControllerOf(state: WorktreeSettingsCardState): WorktreeSettingsCardController {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    setEnabled: vi.fn(),
    setDirectory: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    dispose: vi.fn(),
  } as unknown as WorktreeSettingsCardController
}

describe('GitBundleConfigCard', () => {
  it('renders every section inside one form with a single save', () => {
    const commitMessage = commitControllerOf(commitReady())
    const worktrees = worktreeControllerOf(worktreeReady())
    render(<GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />)
    expect(screen.getByRole('button', { name: `${en['settings.model']} ${en['settings.modelInherit']}` })).toBeTruthy()
    expect(screen.getByRole('switch', { name: en['settings.worktrees.enable'] })).toBeTruthy()
    expect(screen.getByLabelText(en['settings.worktrees.directory'])).toBeTruthy()
    const saves = screen.getAllByRole('button', { name: en['settings.save'] })
    expect(saves).toHaveLength(1)
    expect((saves[0] as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: en['settings.discard'] })).toBeNull()
  })

  it('saves every section from the one save control', async () => {
    const commitMessage = commitControllerOf(commitReady({ dirty: true }))
    const worktrees = worktreeControllerOf(worktreeReady({ dirty: true }))
    render(<GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />)
    fireEvent.click(screen.getByRole('button', { name: en['settings.save'] }))
    expect(commitMessage.save).toHaveBeenCalled()
    await waitFor(() => expect(worktrees.save).toHaveBeenCalled())
  })

  it('persists both sections through one asynchronous revision-fenced Config form', async () => {
    // ConfigForms.get returns one shared queue/revision for the whole entry.
    // Enforce the fence after a wire turn, unlike a synchronous card mock.
    let value: Record<string, Record<string, unknown>> = { commitMessage: {}, worktrees: {} }
    let revision = 0
    let tail: Promise<unknown> = Promise.resolve()
    const listeners = new Set<() => void>()
    const fences: number[] = []
    const section = <T,>(key: string): CommitMessageSettingsForm<T> => ({
      getSnapshot: () => ({ status: 'ready', value: value[key] as T, revision, writable: true, mode: 'host' }),
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      mutate: (ops: readonly GitSettingsMutation[], expected) => {
        const task = tail.then(async () => {
          await Promise.resolve()
          fences.push(expected!)
          if (expected !== revision) return false
          const next = { ...value[key] }
          for (const op of ops) {
            if (op.op === 'set') next[op.path[0]!] = op.value
            else delete next[op.path[0]!]
          }
          value = { ...value, [key]: next }
          revision += 1
          for (const listener of listeners) listener()
          return true
        })
        tail = task
        return task
      },
    })
    const commitMessage = new CommitMessageSettingsCardController(section('commitMessage'))
    const worktrees = new WorktreeSettingsCardController(section('worktrees'))
    commitMessage.setSystemPrompt('Write concise commits.')
    worktrees.setEnabled(true)
    render(<GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />)
    fireEvent.click(screen.getByRole('button', { name: en['settings.save'] }))
    await waitFor(() => expect(worktrees.getSnapshot()).toMatchObject({ dirty: false, failed: false, saving: false }))
    expect(commitMessage.getSnapshot()).toMatchObject({ dirty: false, failed: false, saving: false })
    expect(value).toEqual({ commitMessage: { mode: 'inherit', systemPrompt: 'Write concise commits.' }, worktrees: { enabled: true } })
    expect(fences).toEqual([0, 1])
    commitMessage.dispose()
    worktrees.dispose()
  })

  it('discards every section when the page unmounts', () => {
    const commitMessage = commitControllerOf(commitReady())
    const worktrees = worktreeControllerOf(worktreeReady())
    const { unmount } = render(
      <GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />,
    )
    unmount()
    expect(commitMessage.discard).toHaveBeenCalled()
    expect(worktrees.discard).toHaveBeenCalled()
  })

  it('finishes the requested save of both sections after the page unmounts', async () => {
    const state = commitReady({ dirty: true })
    const commitMessage = commitControllerOf(state)
    const worktrees = worktreeControllerOf(worktreeReady({ dirty: true }))
    let finish: (() => void) | undefined
    vi.mocked(commitMessage.save).mockImplementation(() => {
      state.saving = true
      return new Promise<void>(resolve => { finish = () => { state.saving = false; resolve() } })
    })
    const { unmount } = render(
      <GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />,
    )
    fireEvent.click(screen.getByRole('button', { name: en['settings.save'] }))
    expect(worktrees.save).not.toHaveBeenCalled()
    unmount()
    expect(commitMessage.discard).not.toHaveBeenCalled()
    expect(worktrees.discard).not.toHaveBeenCalled()
    finish!()
    await waitFor(() => expect(worktrees.save).toHaveBeenCalled())
  })

  it('shows the unavailable line only when no namespace is served', () => {
    const commitMessage = commitControllerOf(commitReady({ available: false }))
    const worktrees = worktreeControllerOf(worktreeReady())
    const partial = render(
      <GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />,
    )
    expect(partial.queryByText(en['settings.unavailable'])).toBeNull()
    expect(screen.getByRole('switch', { name: en['settings.worktrees.enable'] })).toBeTruthy()
    partial.unmount()
    const unavailableCommit = commitControllerOf(commitReady({ available: false }))
    const unavailableWorktrees = worktreeControllerOf(worktreeReady({ available: false }))
    render(
      <GitBundleConfigCard commitMessage={unavailableCommit} worktrees={unavailableWorktrees} view="page" {...locale} />,
    )
    expect(screen.getByText(en['settings.unavailable'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['settings.save'] })).toBeNull()
  })

  it('announces read-only while a served section cannot be written', () => {
    const commitMessage = commitControllerOf(commitReady({ writable: false }))
    const worktrees = worktreeControllerOf(worktreeReady())
    render(<GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />)
    expect(screen.getByText(en['settings.readOnly'])).toBeTruthy()
    expect((screen.getByRole('switch', { name: en['settings.worktrees.enable'] }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the two sections as separate cards when no view is given', () => {
    const commitMessage = commitControllerOf(commitReady())
    const worktrees = worktreeControllerOf(worktreeReady())
    render(<GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} {...locale} />)
    expect(screen.getByRole('button', { name: `${en['settings.expand']}: ${en['settings.title']}` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `${en['settings.expand']}: ${en['settings.worktrees.title']}` })).toBeTruthy()
  })
})
