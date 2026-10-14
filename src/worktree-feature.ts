/**
 * Worktree feature assembly: probe the host's optional upstream runtime,
 * resolve the user's settings toggle, and route creation accordingly.
 * Everything here is cordis-free so tests exercise it directly.
 */

import type { GitService, WorktreePoolFs } from './service.ts'
import type { SessionDirectory } from './session-directory.ts'
import type { GitCreatedWorktree, GitWorktreeMode } from './types.ts'
import { resolveWorktreeDirectory, type WorktreeSettings } from './worktree-settings.ts'

/**
 * Structural subset of the upstream experimental `ctx.worktrees` runtime
 * (`@deepseek-ai/dsh-experimental-worktree`, mounted by the Git Worktrees
 * bundle). The caller's Agent travels opaquely; the result mirrors
 * `GitCreatedWorktree` plus the source repository root this plugin discards.
 */
export interface UpstreamWorktrees {
  create(
    agent: object,
    request?: { name?: string; from?: string },
    signal?: AbortSignal,
  ): Promise<{ path: string; branch: string; baseCommit: string }>
}

/**
 * Detect the upstream runtime by method shape, never by package version.
 * @param value - Service read from the host service store.
 * @returns True when the value offers `create`.
 */
export function isUpstreamWorktrees(value: unknown): value is UpstreamWorktrees {
  return typeof value === 'object' && value !== null
    && typeof (value as UpstreamWorktrees).create === 'function'
}

/**
 * Detect a filesystem service by the methods the local pool marker consumes.
 * @param value - Service read from the host service store.
 * @returns True when the value offers `lstat`, `resolve`, and `writeText`.
 */
export function isWorktreePoolFs(value: unknown): value is WorktreePoolFs {
  if (typeof value !== 'object' || value === null) return false
  const service = value as WorktreePoolFs
  return typeof service.lstat === 'function'
    && typeof service.resolve === 'function'
    && typeof service.writeText === 'function'
}

/**
 * Effective Worktrees feature mode. A mounted upstream runtime always wins so
 * creation shares its sandbox and directory handling; the user toggle only
 * unlocks the local fallback on hosts without it.
 * @param upstream - Upstream runtime, when mounted.
 * @param settings - Resolved settings section.
 * @returns `upstream`, `local`, or `off`.
 */
export function worktreeMode(upstream: UpstreamWorktrees | undefined, settings: WorktreeSettings): GitWorktreeMode {
  if (upstream !== undefined) return 'upstream'
  return settings.enabled === true ? 'local' : 'off'
}

/** Live dependencies of one `create-worktree` request. */
export interface CreateWorktreeSupport {
  /** Portable repository service (local mode). */
  readonly service: GitService
  /** Bound session directory services, when the host mounts them. */
  readonly directory: SessionDirectory | undefined
  /** Upstream runtime, resolved at call time. */
  readonly upstream: UpstreamWorktrees | undefined
  /** Filesystem slice for the local-mode pool marker, when the host mounts it. */
  readonly fs: WorktreePoolFs | undefined
  /** Resolved settings at call time. */
  readonly settings: () => WorktreeSettings
}

/**
 * Create a worktree through the active mode and enter it when the session can.
 * Upstream creation already changes the calling session's directory; the local
 * path performs the same switch through the bound directory service. Without a
 * live session the local path still creates the checkout — the list simply
 * keeps showing it — while the upstream path cannot run at all.
 * @param support - Live dependencies.
 * @param request - RPC fields: `sessionId`, `repository`, optional `name`/`from`.
 * @param signal - Cancellation for resolution, creation, and the directory change.
 * @returns The created checkout and whether the session already entered it.
 */
export async function createSessionWorktree(
  support: CreateWorktreeSupport,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<GitCreatedWorktree> {
  const upstream = support.upstream
  const sessionId = optionalField(request, 'sessionId')
  const name = optionalField(request, 'name')
  const from = optionalField(request, 'from')
  if (upstream !== undefined) {
    if (sessionId === undefined) throw new Error('git: worktree creation through the host runtime needs a session')
    const agent = support.directory?.agent(sessionId)
    if (agent === undefined) throw new Error('git: this session has no live agent')
    const created = await upstream.create(agent, {
      ...(name === undefined ? {} : { name }),
      ...(from === undefined ? {} : { from }),
    }, signal)
    return { path: created.path, branch: created.branch, baseCommit: created.baseCommit, entered: true }
  }
  if (support.settings().enabled !== true) {
    throw new Error('git: worktree creation is disabled; enable the upstream Git Worktrees bundle or the plugin worktrees setting')
  }
  const repository = requiredField(request, 'repository')
  const created = await support.service.createWorktree(repository, {
    ...(name === undefined ? {} : { name }),
    ...(from === undefined ? {} : { from }),
    directory: resolveWorktreeDirectory(support.settings()),
  }, support.fs, signal)
  if (sessionId !== undefined && support.directory?.hasLiveAgent(sessionId) === true) {
    const cwd = await support.directory.set(sessionId, created.path, signal)
    return { ...created, path: cwd, entered: true }
  }
  return created
}

function requiredField(request: Record<string, unknown>, key: string): string {
  const value = request[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Git request ${key} must be a non-empty string`)
  return value
}

function optionalField(request: Record<string, unknown>, key: string): string | undefined {
  const value = request[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Git request ${key} must be a non-empty string`)
  return value
}
