/** Browser-safe Git domain records shared by the Host and Client halves. */

export type * from './remote/types.ts'

/** One normalized path change reported by Git. */
export interface GitFileChange {
  /** Repository-relative current path. */
  readonly path: string
  /** Repository-relative source path for a rename or copy. */
  readonly originalPath?: string
  /** Two-character porcelain-v2 index/worktree status. */
  readonly status: string
}

/** One local branch. */
export interface GitBranch {
  readonly name: string
  readonly head: string
  readonly current: boolean
}

/** How the current checkout relates to the repository's common Git directory. */
export type GitCheckoutKind = 'main' | 'linked' | 'bare' | 'unknown'

/** Identity of the checkout Git commands are running in. */
export interface GitCheckout {
  readonly kind: GitCheckoutKind
  /** Canonical git directory of this checkout, when Git reported one. */
  readonly gitDir?: string
  /** Canonical common git directory shared by the repository's checkouts. */
  readonly commonDir?: string
}

/** One checkout from `git worktree list`. */
export interface GitWorktree {
  /** Checkout directory Git reported. */
  readonly path: string
  /** Checked-out commit, or null for a bare record. */
  readonly head: string | null
  /** Short branch name, when the checkout is attached to one. */
  readonly branch: string | null
  readonly detached: boolean
  readonly bare: boolean
  /** True when this record is the checkout the snapshot was read from. */
  readonly current: boolean
}

/** How the Worktrees feature is backed for the `worktree-capability` answer. */
export type GitWorktreeMode =
  /** Feature hidden: no upstream runtime and the user toggle is off. */
  | 'off'
  /** Creation goes through the host's experimental `ctx.worktrees` service. */
  | 'upstream'
  /** Creation runs the plugin's own `git worktree add`; the user opted in. */
  | 'local'

/** Capability answer for the `worktree-capability` endpoint. */
export interface GitWorktreeCapability {
  /** Effective mode after combining upstream presence and the user toggle. */
  readonly mode: GitWorktreeMode
  /** Pool directory applied to local-mode creation, host-resolved. */
  readonly directory: string
}

/** A checkout created by the `create-worktree` endpoint. */
export interface GitCreatedWorktree {
  /** Checkout directory Git registered. */
  readonly path: string
  /** Newly created branch name. */
  readonly branch: string
  /** Resolved commit the branch starts at. */
  readonly baseCommit: string
  /** Whether the calling session's directory already moved to the checkout. */
  readonly entered?: boolean
}

/** Complete repository state required by the first Git client experience. */
export interface GitRepositorySnapshot {
  readonly root: string
  readonly version: string
  readonly branch: string | null
  readonly head: string | null
  readonly staged: readonly GitFileChange[]
  readonly unstaged: readonly GitFileChange[]
  readonly untracked: readonly string[]
  readonly branches: readonly GitBranch[]
  /** Current checkout identity. Absent only on snapshots built by older callers. */
  readonly checkout?: GitCheckout
  /** Other and current checkouts of the same repository. */
  readonly worktrees?: readonly GitWorktree[]
  /** Sync-only hint when the configured push remote was stable and identifiable. */
  readonly pushedRemote?: 'origin' | 'upstream'
}

/** History scope of a `git log` query. */
export type GitLogScope =
  /** HEAD ancestry (default `git log` behavior). */
  | 'auto'
  /** All refs and their ancestry (`git log --all`). */
  | 'all'
  /** First-parent chain of HEAD (`git log --first-parent`). */
  | 'first-parent'

/** Diff text with its normalized repository identity. */
export interface GitDiff {
  readonly repository: string
  readonly staged: boolean
  readonly path?: string
  readonly text: string
}

/** One parsed commit from `git log`, in topological/date order. */
export interface GitCommitSummary {
  /** Full commit hash. */
  readonly hash: string
  /** Abbreviated commit hash. */
  readonly shortHash: string
  /** Parent hashes, oldest first; empty for a root commit. */
  readonly parents: readonly string[]
  /** Commit subject line. */
  readonly subject: string
  /** Author name. */
  readonly author: string
  /** Author date, ISO-8601. */
  readonly date: string
  /** Decorations for the commit: branch names, tags, and `HEAD`. */
  readonly refs: readonly string[]
}

/** Why commit message generation currently has no usable backend. */
export type GitGenerationUnavailableReason =
  /** No selection source is configured and no host default model exists. */
  | 'not-configured'
  /** The LLM runtime is not present in this host. */
  | 'llm-unavailable'
  /** Inherit mode with a live LLM runtime, but no model selection resolves. */
  | 'default-model-missing'

/** Capability answer for the `commit-message-capability` endpoint. */
export interface GitCommitMessageCapability {
  /** Whether a generation backend is usable right now. */
  readonly available: boolean
  /** Why generation is unavailable; absent when available. */
  readonly reason?: GitGenerationUnavailableReason
}

export type * from './remote/provider.ts'
export type { BoundRemote, RemoteRepositorySet, RemoteCheckoutReceipt } from './remote/git.ts'
export type { RemoteDiffAnchor, RemoteDiffLine, RemoteDiff } from './remote/diff.ts'
