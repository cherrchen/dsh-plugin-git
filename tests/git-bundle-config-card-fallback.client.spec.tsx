// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitMessageSettingsCardController, CommitMessageSettingsCardState } from '../src/client/settings/commit-message-card-controller.ts'
import type { WorktreeSettingsCardController, WorktreeSettingsCardState } from '../src/client/settings/worktree-card-controller.ts'
import { GitBundleConfigCard } from '../src/client/settings/GitBundleConfigCard.tsx'
import { en } from '../src/client/locales.ts'

// Hosts before DSH 0.1.7 serve the bundle-config page without exporting
// SettingsForm, so the card falls back to its own frame with the same chrome.
vi.mock('../src/compat/dsh-settings-form.tsx', () => ({ NativeSettingsForm: undefined }))

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

describe('GitBundleConfigCard on hosts without SettingsForm', () => {
  it('renders every section inside one form with a single save', async () => {
    const commitMessage = commitControllerOf(commitReady({ dirty: true }))
    const worktrees = worktreeControllerOf(worktreeReady({ dirty: true }))
    render(<GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />)
    expect(screen.getByRole('button', { name: `${en['settings.model']} ${en['settings.modelInherit']}` })).toBeTruthy()
    expect(screen.getByRole('switch', { name: en['settings.worktrees.enable'] })).toBeTruthy()
    const saves = screen.getAllByRole('button', { name: en['settings.save'] })
    expect(saves).toHaveLength(1)
    fireEvent.click(saves[0]!)
    expect(commitMessage.save).toHaveBeenCalled()
    await waitFor(() => expect(worktrees.save).toHaveBeenCalled())
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

  it('shows the unavailable line when no namespace is served', () => {
    const commitMessage = commitControllerOf(commitReady({ available: false }))
    const worktrees = worktreeControllerOf(worktreeReady({ available: false }))
    render(<GitBundleConfigCard commitMessage={commitMessage} worktrees={worktrees} view="page" {...locale} />)
    expect(screen.getByText(en['settings.unavailable'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['settings.save'] })).toBeNull()
  })
})
