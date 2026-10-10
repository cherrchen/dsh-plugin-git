/** Parse `git worktree list --porcelain` without invoking Git. */

/** One checkout reported by `git worktree list`. */
export interface ParsedWorktree {
  /** Absolute or Git-reported checkout path. */
  readonly path: string
  /** Checked-out commit, or null for a bare record. */
  readonly head: string | null
  /** Short local branch name, when the checkout is attached to one. */
  readonly branch: string | null
  /** True when the record is detached from any branch. */
  readonly detached: boolean
  /** True when the record is a bare repository. */
  readonly bare: boolean
}

/**
 * Parse porcelain worktree output in either NUL or newline form.
 * @param text - Output of `git worktree list --porcelain` or the `-z` form.
 * @returns Checkout records in Git's output order.
 */
export function parseWorktreeList(text: string): readonly ParsedWorktree[] {
  if (text.includes('\0')) return parseSeparated(text.split('\0\0'), '\0')
  return parseSeparated(text.split(/\n\n/u), '\n')
}

function parseSeparated(records: readonly string[], separator: string): readonly ParsedWorktree[] {
  const parsed: ParsedWorktree[] = []
  for (const record of records) {
    const entry = parseRecord(record.split(separator))
    if (entry !== undefined) parsed.push(entry)
  }
  return parsed
}

function parseRecord(lines: readonly string[]): ParsedWorktree | undefined {
  let path: string | undefined
  let head: string | null = null
  let branch: string | null = null
  let detached = false
  let bare = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('locked') || line.startsWith('prunable ')) continue
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
      continue
    }
    if (line.startsWith('HEAD ')) {
      head = line.slice('HEAD '.length)
      continue
    }
    if (line.startsWith('branch ')) {
      branch = shortBranch(line.slice('branch '.length))
      continue
    }
    if (line === 'detached') {
      detached = true
      continue
    }
    if (line === 'bare') bare = true
  }
  if (path === undefined || path.length === 0) return undefined
  return { path, head, branch, detached, bare }
}

function shortBranch(ref: string): string {
  const prefix = 'refs/heads/'
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
}
