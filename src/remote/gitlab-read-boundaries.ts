/** Internal GL2 boundaries. These helpers do not expose GitLab business RPCs. */
import { randomUUID } from 'node:crypto'
import { GitRemoteError } from './errors.ts'
import type { GitRemoteGeneration } from './types.ts'

/** The path must already come from a verified local origin/upstream identity. */
export function gitLabProjectLookupPath(prefix: string, path: string): string {
  if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > 2048 || /[\\%?#\x00-\x20\x7f]/u.test(path)) throw new Error('invalid project path')
  const segments = path.split('/')
  if (segments.length < 2 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) throw new Error('invalid project path')
  // An encoded slash is allowed only in this one generated project-lookup segment.
  const encoded = encodeURIComponent(path).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${prefix}/api/v4/projects/${encoded}`
}

/** The caller must also validate the branch with Git and bind projectId to a local remote. */
export function gitLabBranchLookupPath(prefix: string, projectId: string, branch: string): string {
  if (!/^[1-9][0-9]{0,39}$/u.test(projectId) || typeof branch !== 'string' || branch.length === 0 || Buffer.byteLength(branch, 'utf8') > 1024 || branch.startsWith('-') || branch === '@' || branch.includes('..') || branch.includes('@{') || branch.endsWith('.') || /[\x00-\x20\x7f~^:?*\[\\%]/u.test(branch)) throw new Error('invalid branch path')
  if (branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) throw new Error('invalid branch path')
  const encoded = encodeURIComponent(branch).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${prefix}/api/v4/projects/${projectId}/repository/branches/${encoded}`
}

export interface GitLabCursorBinding {
  readonly instance: string
  readonly projectId: string
  readonly path: string
  readonly viewer: string
  readonly generation: GitRemoteGeneration
  /** Complete normalized initial query, including endpoint and non-page parameters. */
  readonly query: string
  /** Immutable comparison identity, or an empty string for a non-comparison query. */
  readonly snapshot: string
  readonly root: string
  readonly session: string
}
function key(binding: GitLabCursorBinding): string {
  return JSON.stringify([binding.instance, binding.projectId, binding.path, binding.viewer, binding.generation.instanceId, binding.generation.revision, binding.query, binding.snapshot, binding.root, binding.session])
}
function invalidCursor(): GitRemoteError { return new GitRemoteError('git/remote-unavailable', 'git-remote: cursor is invalid or expired', { reason: 'invalid-cursor' }) }

/** Callers must validate every Link before issuing a handle. No URL is accepted from the Client. */
export class GitLabCursorStore {
  private readonly entries = new Map<string, { binding: string; path: string; expires: number }>()
  private readonly now: () => number
  private readonly ttl: number
  private readonly limit: number
  constructor(options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now
    this.ttl = options.ttlMs ?? 15 * 60_000
    this.limit = options.maxEntries ?? 1024
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || !Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error('invalid cursor limits')
  }
  issue(binding: GitLabCursorBinding, validatedNextPath: string): string {
    const now = this.now()
    for (const [handle, entry] of this.entries) if (entry.expires <= now) this.entries.delete(handle)
    if (this.entries.size >= this.limit) throw new GitRemoteError('git/remote-unavailable', 'git-remote: cursor capacity exhausted', { reason: 'cursor-capacity' })
    if (!validatedNextPath.startsWith('/') || validatedNextPath.length > 8192) throw invalidCursor()
    const handle = randomUUID()
    this.entries.set(handle, { binding: key(binding), path: validatedNextPath, expires: now + this.ttl })
    return handle
  }
  resolve(handle: string, binding: GitLabCursorBinding): string {
    const entry = this.entries.get(handle)
    if (entry === undefined || entry.expires <= this.now() || entry.binding !== key(binding)) {
      if (entry !== undefined && entry.expires <= this.now()) this.entries.delete(handle)
      throw invalidCursor()
    }
    return entry.path
  }
  clear(): void { this.entries.clear() }
}
