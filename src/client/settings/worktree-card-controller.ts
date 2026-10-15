/**
 * Staged editor for the Worktrees section: the local-mode enable toggle plus
 * the checkout pool directory. Mirrors the commit-message card's draft/save
 * lifecycle without the model catalog.
 */

import type { CommitMessageSettingsForm, GitSettingsMutation } from './commit-message-card-controller.ts'

/** Settings namespace; spelled here so the Client half never imports Host modules. */
export const GIT_WORKTREE_SETTINGS_NAMESPACE = 'git-worktrees'

/** Stored fields this card edits. */
export interface WorktreeCardSettings {
  /** Local checkout mode on hosts without the upstream worktree runtime. */
  enabled?: boolean
  /** Checkout pool: relative to the repository root, or absolute. Empty keeps the default. */
  directory?: string
}

/** State rendered by the worktree settings card. */
export interface WorktreeSettingsCardState {
  available: boolean
  writable: boolean
  dirty: boolean
  saving: boolean
  failed: boolean
  enabled: boolean
  directory: string
}

interface Draft {
  enabled: boolean
  directory: string
  revision: number | undefined
}

/** Bridges the `git-worktrees` scope onto a staged card. */
export class WorktreeSettingsCardController {
  private draft: Draft | undefined
  private saving = false
  private failed = false
  private disposed = false
  private saveGeneration = 0
  private snapshot: WorktreeSettingsCardState
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `git-worktrees` settings scope.
   * @param onSaved - invoked after a save lands; the plugin uses it to re-poll
   *   `worktree-capability` so the tab registration tracks the toggle.
   */
  constructor(
    private readonly scope: CommitMessageSettingsForm<WorktreeCardSettings>,
    private readonly onSaved: (() => void) | undefined = undefined,
  ) {
    this.snapshot = this.projection()
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** Stop observing settings and suppress late write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.unsubscribe()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * @returns the current card snapshot (stable until the next change).
   */
  getSnapshot = (): WorktreeSettingsCardState => this.snapshot

  /**
   * Stage the local-mode toggle.
   * @param enabled - Whether local creation is enabled when no upstream runtime exists.
   */
  setEnabled(enabled: boolean): void {
    if (this.disposed || !this.scope.getSnapshot().writable || this.saving) return
    this.beginDraft().enabled = enabled
    this.failed = false
    this.publish()
  }

  /**
   * Stage the checkout directory; empty text clears it back to the default pool.
   * @param directory - Draft directory text.
   */
  setDirectory(directory: string): void {
    if (this.disposed || !this.scope.getSnapshot().writable || this.saving) return
    this.beginDraft().directory = directory
    this.failed = false
    this.publish()
  }

  /** Persist every staged field; resolve after success or a retryable failure. */
  save(): Promise<void> {
    return this.commit()
  }

  /** Drop every staged edit. */
  discard(): void {
    if (this.saving) return
    this.draft = undefined
    this.failed = false
    this.publish()
  }

  private current(): WorktreeCardSettings {
    return this.scope.getSnapshot().value ?? {}
  }

  private enabled(): boolean {
    return this.draft?.enabled ?? this.current().enabled === true
  }

  private directory(): string {
    return this.draft?.directory ?? this.current().directory ?? ''
  }

  private beginDraft(): Draft {
    if (this.draft === undefined) {
      const snapshot = this.scope.getSnapshot()
      const current = this.current()
      this.draft = {
        enabled: current.enabled === true,
        directory: current.directory ?? '',
        revision: snapshot.revision,
      }
    }
    return this.draft
  }

  private async commit(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const enabled = this.enabled()
    const directory = this.directory().trim()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    if (!this.dirty()) return
    // Another section sharing this form (or an external write) bumps the
    // revision without touching the staged field values, so rebase the draft
    // onto it instead of deadlocking the save. The mutate call's revision
    // fence still rejects a write that lands between this read and the save.
    if (this.draft !== undefined) this.draft.revision = snapshot.revision
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.publish()
    // False must override a composition layer that enables local mode. Only
    // the blank directory means clearing an override back to its base value.
    const ops: GitSettingsMutation[] = [
      { op: 'set', path: ['enabled'], value: enabled },
      directory === '' ? { op: 'unset', path: ['directory'] } : { op: 'set', path: ['directory'], value: directory },
    ]
    try {
      const accepted = await this.scope.mutate(ops, this.draft?.revision)
      if (generation !== this.saveGeneration) return
      const landed = accepted !== false && this.matches(enabled, directory)
      this.failed = !landed
      if (landed) {
        this.draft = undefined
        this.onSaved?.()
      }
    } catch {
      if (generation !== this.saveGeneration) return
      this.failed = true
    } finally {
      if (generation === this.saveGeneration) {
        this.saving = false
        this.publish()
      }
    }
  }

  private matches(enabled: boolean, directory: string): boolean {
    const current = this.current()
    return (current.enabled === true) === enabled && (current.directory ?? '') === directory
  }

  private dirty(): boolean {
    const current = this.current()
    return this.enabled() !== (current.enabled === true)
      || this.directory().trim() !== (current.directory ?? '')
  }

  private projection(): WorktreeSettingsCardState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.dirty(),
      saving: this.saving,
      failed: this.failed,
      enabled: this.enabled(),
      directory: this.directory(),
    }
  }

  private publish(): void {
    this.snapshot = this.projection()
    for (const listener of this.listeners) listener()
  }
}
