/**
 * Settings seam for the Worktrees tab. The namespace and schema are installed
 * whenever a settings provider is mounted (composition entry is the base
 * layer). The Client half registers the matching card beside the
 * commit-message card on every settings surface the host declares.
 */
import z from '@deepseek-ai/schemastery'

/** Settings namespace carrying the Worktrees section. */
export const GIT_WORKTREE_SETTINGS_NAMESPACE = 'git-worktrees'

/**
 * Checkout pool used when neither the user nor the composition overrides it.
 * Matches the upstream experimental worktree service's convention so checkouts
 * created through either path land in the same pool.
 */
export const DEFAULT_WORKTREE_DIRECTORY = '.agents/worktrees'

/** Stored shape of the Worktrees settings section. */
export interface WorktreeSettings {
  /**
   * Show the Worktrees tab and enable local creation even when the host has
   * no upstream `worktrees` service. When the service is present the feature
   * follows it regardless of this flag.
   */
  enabled?: boolean
  /**
   * Checkout directory for locally created worktrees. A relative path resolves
   * against the repository root; an absolute path is used as-is.
   */
  directory?: string
}

/** Schema of the Worktrees settings section. */
export const GIT_WORKTREE_SETTINGS_SCHEMA: z<WorktreeSettings> = z.object({
  enabled: z.boolean(),
  directory: z.string(),
})

/**
 * Reject a stored directory this implementation cannot act on: an empty value
 * would place checkouts at the repository root itself.
 * @param value - Schema-valid resolved section.
 * @throws {Error} when `directory` is blank.
 */
export function validateWorktreeSettings(value: WorktreeSettings): void {
  const directory = value.directory
  if (directory !== undefined && directory.trim().length === 0) {
    throw new Error('worktree directory must not be empty')
  }
}

/**
 * Whether a configured directory keeps checkouts inside the repository.
 * Absolute paths and `..` segments are legal — they deliberately place
 * checkouts outside the checkout — but they never get the pool `.gitignore`.
 * @param directory - User- or composition-supplied directory.
 * @returns True for an in-repository relative directory.
 */
export function isPoolDirectory(directory: string): boolean {
  if (directory.length === 0 || directory.startsWith('/') || directory.startsWith('~')) return false
  if (/^[a-zA-Z]:[/\\]/u.test(directory) || directory.includes('\\') || directory.includes(':')) return false
  return directory.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/**
 * Effective checkout pool for a resolved section.
 * @param value - Resolved settings section.
 * @returns The configured directory, or the upstream-matching default.
 */
export function resolveWorktreeDirectory(value: WorktreeSettings | undefined): string {
  const directory = value?.directory
  return directory !== undefined && directory.trim().length > 0 ? directory.trim() : DEFAULT_WORKTREE_DIRECTORY
}
