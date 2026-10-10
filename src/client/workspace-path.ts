/**
 * Choose the directory Git should follow for one session.
 * The host projection `workingDirectory` is the effective directory when the
 * working-directory service is mounted. Older hosts, and hosts without that
 * service, keep the session header `cwd`.
 */

/** Fields this plugin reads from one session list row. */
export interface WorkspaceSessionSummary {
  /** Original project directory recorded on the session header. */
  readonly cwd?: string
  /** Host projection values. Only `workingDirectory` is consulted. */
  readonly projectionValues?: object
}

/**
 * Effective directory for Git discovery.
 * A non-empty projected directory wins. A null or absent projection falls
 * back to the header directory. Neither value means there is no workspace.
 * @param summary - Session list row, when the session is known.
 * @returns Absolute directory, or undefined when the session has none.
 */
export function effectiveWorkspacePath(summary: WorkspaceSessionSummary | undefined): string | undefined {
  if (summary === undefined) return undefined
  const projected = projectedDirectory(summary.projectionValues)
  if (projected !== undefined) return projected
  if (typeof summary.cwd === 'string' && summary.cwd.length > 0) return summary.cwd
  return undefined
}

function projectedDirectory(values: object | undefined): string | undefined {
  if (values === undefined || !('workingDirectory' in values)) return undefined
  const projected = values.workingDirectory
  return typeof projected === 'string' && projected.length > 0 ? projected : undefined
}
