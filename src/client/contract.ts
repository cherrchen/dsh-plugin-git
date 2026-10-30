/** Stable Git right-sidebar tab identities shared by registration and `ctx.sidebarRight`. */
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RemoteRepository, ScopedGitLabRepository } from '../remote/provider.ts'

/** Implementation id (body-seat key) of the Git Changes tab type. */
export const GIT_CHANGES_ID = '@dsh-electron/dsh-plugin-git/changes' as const

/** Implementation id (body-seat key) of the Git Diff tab type. */
export const GIT_DIFF_ID = '@dsh-electron/dsh-plugin-git/diff' as const

/** Implementation id (body-seat key) of the Git Graph tab type. */
export const GIT_GRAPH_ID = '@dsh-electron/dsh-plugin-git/graph' as const

/** Implementation id (body-seat key) of the Git Worktrees tab type. */
export const GIT_WORKTREES_ID = '@dsh-electron/dsh-plugin-git/worktrees' as const

/** Tab kind (`openTab` discriminator) of the Git Changes page. */
export const GIT_CHANGES_KIND = 'git.changes' as const

/** Tab kind claimed by Git diff resource addresses. */
export const GIT_DIFF_KIND = 'git.diff' as const

/** Tab kind (`openTab` discriminator) of the Git Graph page. */
export const GIT_GRAPH_KIND = 'git.graph' as const

/** Tab kind (`openTab` discriminator) of the Git Worktrees page. */
export const GIT_WORKTREES_KIND = 'git.worktrees' as const

/** Implementation id (body-seat key) of the remote pull/issue detail tab type. */
export const GIT_REMOTE_ITEM_ID = '@dsh-electron/dsh-plugin-git/remote-item' as const

/** Tab kind claimed by remote item resource addresses. */
export const GIT_REMOTE_ITEM_KIND = 'git.remote.item' as const

/** Which sides of the comparison a Diff tab shows. */
export type GitDiffMode = 'worktree' | 'staged'

/** Open arguments for the Changes page; the repository follows the workspace. */
export interface GitChangesPayload {}

/** Open arguments for one Diff tab. */
export interface GitDiffPayload {
  /** Repository-relative changed path. */
  readonly path: string
  /** `true` compares index↔HEAD; `false` compares working tree↔index. */
  readonly staged: boolean
}

/** Open arguments for the Graph page; the repository follows the workspace. */
export interface GitGraphPayload {}

/** Open arguments for the Worktrees page; the repository follows the workspace. */
export interface GitWorktreesPayload {}

/** The resource type (host segment after `dsh-resource://`) Git diffs are addressed under. */
export const GIT_DIFF_RESOURCE_PROTOCOL = 'git' as const

const DIFF_PATH_PREFIX = '/diff/'
const STAGED_SEGMENT = '/staged'

/**
 * Address of one diff tab: the path is percent-encoded, and the trailing
 * segment names the compared side. The exact address is the tab identity, so
 * re-opening the same file and side reveals the existing tab.
 * @param path - Repository-relative changed path.
 * @param staged - `true` for index↔HEAD, `false` for working tree↔index.
 * @returns The `dsh-resource://git/...` address.
 */
export function gitDiffAddress(path: string, staged: boolean): string {
  return `dsh-resource://git${DIFF_PATH_PREFIX}${encodeURIComponent(path)}/${staged ? 'staged' : 'worktree'}`
}

/**
 * Decode a diff address back into its open payload.
 * @param address - The tab's navigation address.
 * @returns The payload, or `undefined` when the address is not a Git diff.
 */
export function parseGitDiffAddress(address: string): GitDiffPayload | undefined {
  const prefix = `dsh-resource://${GIT_DIFF_RESOURCE_PROTOCOL}${DIFF_PATH_PREFIX}`
  if (!address.startsWith(prefix)) return undefined
  const tail = address.slice(prefix.length)
  const slash = tail.lastIndexOf('/')
  if (slash <= 0) return undefined
  const side = tail.slice(slash + 1)
  if (side !== 'staged' && side !== 'worktree') return undefined
  let path: string
  try {
    path = decodeURIComponent(tail.slice(0, slash))
  } catch {
    return undefined
  }
  if (path.length === 0) return undefined
  return { path, staged: side === 'staged' }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    [GIT_DIFF_RESOURCE_PROTOCOL]: GitDiffPayload
  }
}

/** The resource type remote pull/issue detail tabs are addressed under. */
export const GIT_REMOTE_ITEM_RESOURCE_PROTOCOL = 'git-remote' as const

/** Open arguments for one GitHub remote pull/issue detail tab. */
export interface GitHubRemoteItemPayload {
  /** Remote owner login; the repository follows the workspace binding. */
  readonly owner: string
  /** Remote repository name. */
  readonly repo: string
  /** List kind the item was opened from. */
  readonly kind: 'pulls' | 'issues'
  /** Pull/issue number on the remote. */
  readonly number: number
}

/** Open arguments for one GitLab remote merge-request/issue detail tab. */
export interface GitLabRemoteItemPayload {
  readonly provider: 'gitlab'
  /** Canonical GitLab instance origin (including any sub-path prefix). */
  readonly instance: string
  /** Project path with namespace. */
  readonly path: string
  /** List kind the item was opened from. */
  readonly kind: 'pulls' | 'issues'
  /** Merge-request/issue iid inside the project. */
  readonly number: number
}

/** Open arguments for one remote pull/issue detail tab. */
export type GitRemoteItemPayload = GitHubRemoteItemPayload | GitLabRemoteItemPayload

const REMOTE_ITEM_PREFIX = `dsh-resource://${GIT_REMOTE_ITEM_RESOURCE_PROTOCOL}/`
const GITLAB_ITEM_SEGMENT = 'gitlab'

/**
 * Address of one remote detail tab: remote identity plus item number. The exact
 * address is the tab identity, so re-opening the same item reveals its tab.
 * GitHub identities keep the original four-segment form; GitLab identities add
 * a `gitlab` marker segment so the two grammars never collide.
 * @param target - Remote repository identity owning the item.
 * @param kind - `pulls` or `issues`.
 * @param number - Remote pull/issue number.
 * @returns The `dsh-resource://git-remote/...` address.
 */
export function gitRemoteItemAddress(target: RemoteRepository | ScopedGitLabRepository, kind: 'pulls' | 'issues', number: number): string {
  if (target.provider === 'gitlab') return `${REMOTE_ITEM_PREFIX}${GITLAB_ITEM_SEGMENT}/${encodeURIComponent(target.instance)}/${encodeURIComponent(target.path)}/${kind}/${number}`
  return `${REMOTE_ITEM_PREFIX}${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${kind}/${number}`
}

/**
 * Decode a remote item address back into its open payload.
 * @param address - The tab's navigation address.
 * @returns The payload, or `undefined` when the address is not a remote item.
 */
export function parseGitRemoteItemAddress(address: string): GitRemoteItemPayload | undefined {
  if (!address.startsWith(REMOTE_ITEM_PREFIX)) return undefined
  const parts = address.slice(REMOTE_ITEM_PREFIX.length).split('/')
  const numberPart = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined
    const number = Number(raw)
    return Number.isInteger(number) && number > 0 ? number : undefined
  }
  const decode = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined
    try { return decodeURIComponent(raw) } catch { return undefined }
  }
  const kind = parts[parts.length - 2]
  if (kind !== 'pulls' && kind !== 'issues') return undefined
  const number = numberPart(parts[parts.length - 1])
  if (number === undefined) return undefined
  if (parts.length === 5 && parts[0] === GITLAB_ITEM_SEGMENT) {
    const instance = decode(parts[1])
    const path = decode(parts[2])
    if (instance === undefined || instance === '' || path === undefined || path === '') return undefined
    return { provider: 'gitlab', instance, path, kind, number }
  }
  if (parts.length !== 4) return undefined
  const owner = decode(parts[0])
  const repo = decode(parts[1])
  if (owner === undefined || owner === '' || repo === undefined || repo === '') return undefined
  return { owner, repo, kind, number }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    [GIT_REMOTE_ITEM_RESOURCE_PROTOCOL]: GitRemoteItemPayload
  }
}
