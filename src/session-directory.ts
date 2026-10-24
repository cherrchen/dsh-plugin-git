/**
 * Structural adapter for the host working-directory service.
 * Older hosts omit the service; a present service is detected by method shape,
 * not by comparing DSH versions.
 */

import type { GitService } from './service.ts'
import { samePath } from './path-identity.ts'

/** Live agent handle consumed by directory get/set. */
export interface DirectoryAgent {
  readonly session: object
}

/** Registry shape this plugin needs from `ctx.agents`. */
interface AgentRegistryLike {
  get(sessionId: string): DirectoryAgent | undefined
}

/** Directory service shape this plugin needs from `ctx.workingDirectory`. */
interface WorkingDirectoryLike {
  get(session: object): unknown
  set(agent: DirectoryAgent, path: string, signal?: AbortSignal): Promise<unknown>
}

/** Session directory operations used by Git RPC. */
export interface SessionDirectory {
  /**
   * Read the committed directory of a live session.
   * @param sessionId - Session whose agent must already be live.
   * @returns Absolute directory, or undefined when the session has no live agent.
   */
  get(sessionId: string): string | undefined
  /**
   * Change one live session's directory through the host service.
   * @param sessionId - Session the change applies to.
   * @param path - Existing absolute directory.
   * @param signal - Cancellation before the host commits the change.
   * @returns The directory the host committed.
   */
  set(sessionId: string, path: string, signal: AbortSignal): Promise<string>
  /**
   * Whether this session has a live agent that can accept a directory change.
   * Cold and archived sessions do not, and `set` rejects them.
   * @param sessionId - Session the capability would apply to.
   * @returns True when `agents.get` currently returns that session.
   */
  hasLiveAgent(sessionId: string): boolean
  /**
   * The live agent handle itself, for host runtimes that consume an Agent
   * directly (the upstream worktree service).
   * @param sessionId - Session whose agent must already be live.
   * @returns The opaque agent handle, or undefined when the session is not live.
   */
  agent(sessionId: string): DirectoryAgent | undefined
}

const WRITE_ENDPOINTS = new Set([
  'remote-comment',
  'remote-inline-comment',
  'remote-review',
  'remote-create-pr',
  'remote-close-pr',
  'remote-merge-pr',
  'remote-checkout-pr',
  'remote-issue-branch',
  'stage',
  'unstage',
  'discard',
  'commit',
  'push',
  'sync',
  'create-branch',
  'switch-branch',
  'create-worktree',
])

/**
 * Whether a Git endpoint mutates the repository.
 * @param endpoint - Channel-relative Git endpoint.
 * @returns True for index, commit, branch, and remote writes.
 */
export function isRepositoryWrite(endpoint: string): boolean {
  return WRITE_ENDPOINTS.has(endpoint)
}

/**
 * Bind directory operations when both host services expose the methods Git uses.
 * Missing services and lookalike objects without those methods bind nothing.
 * @param agents - Host agent registry, or any other value.
 * @param workingDirectory - Host working-directory service, or any other value.
 * @returns A binder, or undefined when the capability is absent.
 */
export function bindSessionDirectory(agents: unknown, workingDirectory: unknown): SessionDirectory | undefined {
  if (!isAgentRegistry(agents) || !isWorkingDirectory(workingDirectory)) return undefined
  return {
    get(sessionId: string): string | undefined {
      const agent = agents.get(sessionId)
      if (agent?.session === undefined) return undefined
      const cwd = workingDirectory.get(agent.session)
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    },
    async set(sessionId: string, path: string, signal: AbortSignal): Promise<string> {
      const agent = agents.get(sessionId)
      if (agent === undefined) throw new Error('git: this session has no live agent')
      const cwd = await workingDirectory.set(agent, path, signal)
      if (typeof cwd !== 'string' || cwd.length === 0) {
        throw new Error('git: working directory service returned no directory')
      }
      return cwd
    },
    hasLiveAgent(sessionId: string): boolean {
      return agents.get(sessionId) !== undefined
    },
    agent(sessionId: string): DirectoryAgent | undefined {
      return agents.get(sessionId)
    },
  }
}

/**
 * Whether this request may offer a session directory change.
 * The host services must be bound, and the named session must have a live agent.
 * A missing session id is not treated as a live session.
 * @param directory - Bound directory service, when the host has one.
 * @param request - RPC payload, including `sessionId` when the client has one.
 * @returns True only for a live session that `set` can address.
 */
export function sessionDirectoryAvailable(
  directory: SessionDirectory | undefined,
  request: Record<string, unknown>,
): boolean {
  if (directory === undefined) return false
  const sessionId = optionalString(request, 'sessionId')
  if (sessionId === undefined) return false
  return directory.hasLiveAgent(sessionId)
}

/**
 * Reject a repository write whose root is not the live session directory's checkout.
 * With no directory service, no session id, or no live agent, the caller-supplied
 * repository remains the existing contract.
 * @param service - Git service used to resolve the session directory.
 * @param directory - Bound directory service, when the host has one.
 * @param request - RPC payload.
 * @param signal - Cancellation for the resolution command.
 */
export async function assertSessionRepository(
  service: GitService,
  directory: SessionDirectory | undefined,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  const root = await sessionCheckoutRoot(service, directory, request, signal)
  if (root === undefined) return
  if (root === null) throw new Error('git: session working directory is not a Git repository')
  const requested = requiredString(request, 'repository')
  if (!samePath(root, requested, root)) {
    throw new Error('git: request repository does not match the session working directory')
  }
}

/**
 * Enter one existing worktree by changing that session's directory.
 * Creation, deletion, and pruning stay with the host worktree service and the user.
 * @param service - Git service used to list checkouts.
 * @param directory - Bound directory service.
 * @param request - Session, current repository, and target checkout path.
 * @param signal - Cancellation for listing and the directory change.
 * @returns The directory the host committed.
 */
export async function enterWorktreeDirectory(
  service: GitService,
  directory: SessionDirectory | undefined,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ cwd: string }> {
  if (directory === undefined) throw new Error('git: session directory changes are unavailable')
  const sessionId = requiredString(request, 'sessionId')
  const repository = requiredString(request, 'repository')
  const path = requiredString(request, 'path')
  await assertSessionRepository(service, directory, request, signal)
  const listed = await service.listWorktrees(repository, signal)
  if (!listed.some(entry => samePath(entry.path, path, repository))) {
    throw new Error('git: path is not a worktree of this repository')
  }
  return { cwd: await directory.set(sessionId, path, signal) }
}

/**
 * @returns `undefined` when no live directory is bound, `null` when that
 * directory is not a repository, or the checkout root Git reports.
 */
async function sessionCheckoutRoot(
  service: GitService,
  directory: SessionDirectory | undefined,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string | null | undefined> {
  if (directory === undefined) return undefined
  const sessionId = optionalString(request, 'sessionId')
  if (sessionId === undefined) return undefined
  const cwd = directory.get(sessionId)
  if (cwd === undefined) return undefined
  return service.discover(cwd, signal)
}

function requiredString(request: Record<string, unknown>, key: string): string {
  const value = request[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Git request ${key} must be a non-empty string`)
  return value
}

function optionalString(request: Record<string, unknown>, key: string): string | undefined {
  const value = request[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Git request ${key} must be a non-empty string`)
  return value
}

function isAgentRegistry(value: unknown): value is AgentRegistryLike {
  return typeof value === 'object' && value !== null && typeof (value as AgentRegistryLike).get === 'function'
}

function isWorkingDirectory(value: unknown): value is WorkingDirectoryLike {
  if (typeof value !== 'object' || value === null) return false
  const service = value as WorkingDirectoryLike
  return typeof service.get === 'function' && typeof service.set === 'function'
}
