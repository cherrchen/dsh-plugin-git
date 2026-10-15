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
 * Concurrent refreshes request one trailing poll so a settings save cannot be
 * hidden by an older in-flight answer. Failures retain the previous answer.
 */
export class GitWorktreeFeature {
  private state: GitWorktreeFeatureState = { mode: undefined, directory: undefined }
  private readonly listeners = new Set<() => void>()
  private pending: Promise<void> | undefined
  private refreshAgain = false
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  /** Consecutive failed polls; resets on the first successful answer. */
  private failures = 0
  private ticks = 0

  /**
   * @param rpc - Connection caller for the `/git` channel.
   */
  constructor(private readonly rpc: GitRpcClient) {}

  /** Poll immediately and every five seconds until plugin teardown. */
  startPolling(): void {
    if (this.disposed || this.timer !== undefined) return
    this.refresh()
    this.timer = setInterval(() => {
      this.ticks += 1
      // After three consecutive failures drop to one poll per six ticks (30s):
      // a permanently unreachable endpoint stops dominating channel traffic,
      // and a recovering host is still picked up within half a minute. Manual
      // refreshes bypass the gate so a settings save stays responsive.
      if (this.failures >= 3 && this.ticks % 6 !== 0) return
      this.refresh()
    }, 5_000)
  }

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
   * Poll the host, scheduling one trailing poll when a request is in flight.
   * Failures keep the current mode: a transient transport error must not make
   * an open Worktrees tab type flicker off and back on.
   */
  refresh(): void {
    if (this.disposed) return
    if (this.pending !== undefined) {
      this.refreshAgain = true
      return
    }
    const run = (async () => {
      try {
        const result = await this.rpc.call('/git', 'worktree-capability', {})
        if (this.disposed) return
        if (!result.ok) {
          this.failures += 1
          return
        }
        const capability = decodeWorktreeCapability(result.value)
        this.failures = 0
        this.patch({ mode: capability.mode, directory: capability.directory })
      } catch {
        // Transport or host failure: keep the last known mode.
        this.failures += 1
      }
    })()
    this.pending = run
    void run.finally(() => {
      if (this.pending !== run) return
      this.pending = undefined
      if (this.refreshAgain) {
        this.refreshAgain = false
        this.refresh()
      }
    })
  }

  /** Stop polling and release listeners (plugin fiber teardown). */
  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.timer = undefined
    this.refreshAgain = false
    this.failures = 0
    this.ticks = 0
    this.listeners.clear()
  }

  private patch(patch: Partial<GitWorktreeFeatureState>): void {
    if (patch.mode === this.state.mode && patch.directory === this.state.directory) return
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}
