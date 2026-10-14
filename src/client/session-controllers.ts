/** One Git controller per session, so two checkouts never share repository state. */

import { GitClientController, type GitDesktopCapability, type GitRpcClient } from './controller.ts'
import type { GitWorktreeFeature } from './worktree-feature.ts'

/** Shared optional capabilities copied onto every session controller. */
interface SharedGitCapabilities {
  desktop: GitDesktopCapability | undefined
  diffNavigator: ((path: string, staged: boolean) => void) | undefined
}

/**
 * Session-keyed Git controllers.
 * Creating a controller for a new session does not reset another session.
 */
export class GitSessionControllers {
  private readonly controllers = new Map<string, GitClientController>()
  private readonly shared: SharedGitCapabilities = {
    desktop: undefined,
    diffNavigator: undefined,
  }

  /**
   * @param rpc - Connection caller shared by every session controller.
   * @param worktreeFeature - Plugin-wide capability store, when mounted.
   */
  constructor(private readonly rpc: GitRpcClient, private readonly worktreeFeature?: GitWorktreeFeature) {}

  /**
   * Return the controller for one session, creating it on first use.
   * @param sessionId - Session whose Git state is requested.
   * @returns The stable controller for that session.
   */
  controllerFor(sessionId: string): GitClientController {
    const existing = this.controllers.get(sessionId)
    if (existing !== undefined) return existing
    const controller = new GitClientController(this.rpc, sessionId, this.worktreeFeature)
    if (this.shared.desktop !== undefined) controller.setDesktop(this.shared.desktop)
    if (this.shared.diffNavigator !== undefined) controller.setDiffNavigator(this.shared.diffNavigator)
    this.controllers.set(sessionId, controller)
    return controller
  }

  /**
   * Install or clear the optional Desktop capability on every session.
   * @param desktop - Desktop service, or undefined after provider unload.
   */
  setDesktop(desktop: GitDesktopCapability | undefined): void {
    this.shared.desktop = desktop
    for (const controller of this.controllers.values()) controller.setDesktop(desktop)
  }

  /**
   * Install diff navigation used by every session's changes list.
   * @param navigator - Opens one diff tab, or undefined when the sidebar is gone.
   */
  setDiffNavigator(navigator: ((path: string, staged: boolean) => void) | undefined): void {
    this.shared.diffNavigator = navigator
    for (const controller of this.controllers.values()) controller.setDiffNavigator(navigator)
  }

  /** Cancel every session's in-flight Git RPC. */
  dispose(): void {
    for (const controller of this.controllers.values()) controller.dispose()
    this.controllers.clear()
  }
}

/**
 * Resolve the controller a surface should bind.
 * Production passes the session registry. Tests may pass one controller directly.
 * @param source - Injected registry and/or an explicit controller, plus the surface session.
 * @returns The controller whose workspace follows that session.
 */
export function resolveGitController(source: {
  readonly controller?: GitClientController | undefined
  readonly gitSessions?: GitSessionControllers | undefined
  readonly sessionId: string
}): GitClientController {
  if (source.gitSessions !== undefined) return source.gitSessions.controllerFor(source.sessionId)
  if (source.controller !== undefined) return source.controller
  throw new Error('git: missing session controller')
}
