/**
 * Host-reported Worktrees feature mode, polled through `worktree-capability`.
 * One plugin-scope store drives the tab-type registration so the Worktrees
 * page appears exactly when the host can create checkouts (upstream runtime
 * mounted, or the local fallback enabled in settings) — and disappears when
 * the capability withdraws.
 */

import type { GitRpcClient } from './controller.ts'
import type { GitWorktreeCapability, GitWorktreeMode } from '../types.ts'

/** Snapshot consumed by the tab registration subscriber. */
export interface GitWorktreeFeatureState {
  /** Reported mode; `undefined` until the first answer lands. */
  readonly mode: GitWorktreeMode | undefined
  /** Pool directory reported for local-mode creation hints. */
  readonly directory: string | undefined
}

/** Decode the host's capability answer; unknown payloads stay `off`. */
export function decodeWorktreeCapability(value: unknown): GitWorktreeCapability {
  if (typeof value !== 'object' || value === null) return { mode: 'off', directory: '' }
  const record = value as Partial<GitWorktreeCapability>
  const mode = record.mode === 'upstream' || record.mode === 'local' ? record.mode : 'off'
  return { mode, directory: typeof record.directory === 'string' ? record.directory : '' }
}

/**
 * One observable answer for `worktree-capability`, shared by every consumer.
 * `refresh()` is safe to call liberally: concurrent calls share the in-flight
 * request and failures retain the previous answer instead of dropping the tab.
 */
export class GitWorktreeFeature {
  private state: GitWorktreeFeatureState = { mode: undefined, directory: undefined }
  private readonly listeners = new Set<() => void>()
  private pending: Promise<void> | undefined
  private disposed = false

  /**
   * @param rpc - Connection caller for the `/git` channel.
   */
  constructor(private readonly rpc: GitRpcClient) {}

  /**
   * @returns The latest capability snapshot (stable between polls).
   */
  readonly getSnapshot = (): GitWorktreeFeatureState => this.state

  /**
   * @param listener - Invoked after a capability answer replaces the snapshot.
   * @returns Disposer removing the listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Poll the host unless a poll is already in flight.
   * Failures keep the current mode: a transient transport error must not make
   * an open Worktrees tab type flicker off and back on.
   */
  refresh(): void {
    if (this.disposed || this.pending !== undefined) return
    const run = (async () => {
      try {
        const result = await this.rpc.call('/git', 'worktree-capability', {})
        if (this.disposed || !result.ok) return
        const capability = decodeWorktreeCapability(result.value)
        this.patch({ mode: capability.mode, directory: capability.directory })
      } catch {
        // Transport or host failure: keep the last known mode.
      }
    })()
    this.pending = run
    void run.finally(() => { if (this.pending === run) this.pending = undefined })
  }

  /** Stop polling and release listeners (plugin fiber teardown). */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private patch(patch: Partial<GitWorktreeFeatureState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}
