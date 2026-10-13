/**
 * Ref-badge classification for graph rows: `%D` decorations carry plain
 * names (`HEAD`, `feat/x`, `origin/x`, `tag: v1`), so the kind is inferred —
 * `HEAD` and `tag:` are explicit, a ref listed among the repository's local
 * heads is a branch, and anything else is a remote-tracking ref.
 */

/** Visual kind of one ref decoration on a commit row. */
export type GitRefKind = 'head' | 'branch' | 'remote' | 'tag'

/** A ref decoration resolved to its chip kind and display name. */
export interface GitRefBadge {
  readonly kind: GitRefKind
  readonly name: string
}

/**
 * Classify one decoration against the repository's local branch names.
 * @param ref - One entry of `GitCommitSummary.refs`.
 * @param localBranches - Names from `GitRepositorySnapshot.branches`.
 * @returns Chip kind and display name.
 */
export function classifyRef(ref: string, localBranches: ReadonlySet<string>): GitRefBadge {
  if (ref === 'HEAD') return { kind: 'head', name: 'HEAD' }
  if (ref.startsWith('tag: ')) return { kind: 'tag', name: ref.slice('tag: '.length) }
  if (localBranches.has(ref)) return { kind: 'branch', name: ref }
  return { kind: 'remote', name: ref }
}

/** Stable display order shared with VS Code: head, branches, remotes, tags. */
const KIND_ORDER: Record<GitRefKind, number> = { head: 0, branch: 1, remote: 2, tag: 3 }

/**
 * Resolve the chips for one commit's decorations. Like VS Code, an attached
 * `HEAD -> branch` folds into a single head-colored chip named after the
 * current branch instead of a bare `HEAD` chip plus a duplicate branch chip;
 * a detached HEAD keeps the literal `HEAD` name. Remaining refs are ordered
 * head, local branches, remote refs, tags so cheap kinds clip first.
 * @param refs - `GitCommitSummary.refs` for the row.
 * @param localBranches - Names from `GitRepositorySnapshot.branches`.
 * @param currentBranch - The repository's checked-out branch, when attached.
 * @returns Ordered chips for the row.
 */
export function refBadges(refs: readonly string[], localBranches: ReadonlySet<string>, currentBranch: string | null | undefined): GitRefBadge[] {
  const hasHead = refs.includes('HEAD')
  const headName = currentBranch !== null && currentBranch !== undefined && refs.includes(currentBranch) ? currentBranch : 'HEAD'
  const badges: GitRefBadge[] = []
  if (hasHead) badges.push({ kind: 'head', name: headName })
  for (const ref of refs) {
    if (ref === 'HEAD') continue
    const badge = classifyRef(ref, localBranches)
    if (hasHead && badge.kind === 'branch' && badge.name === headName) continue
    badges.push(badge)
  }
  return badges.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
}
