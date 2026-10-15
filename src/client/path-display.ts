/** Split a repository-relative path into filename and directory parts. */

/**
 * Split one repository-relative path for compact display.
 * @param path - Repository-relative path.
 * @returns Filename and optional directory prefix.
 */
export function splitRepoPath(path: string): { readonly name: string; readonly dir: string } {
  const index = path.lastIndexOf('/')
  if (index === -1) return { name: path, dir: '' }
  return { name: path.slice(index + 1), dir: path.slice(0, index + 1) }
}

/**
 * Read the repository folder name from an absolute root path.
 * @param root - Repository root path.
 * @returns Final path segment for display.
 */
export function repoFolderName(root: string): string {
  const normalized = root.replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/**
 * Shorten one checkout path for list display: inside the repository root the
 * root-relative path, the root itself as its folder name, anything else as-is.
 * @param path - Checkout directory Git reported.
 * @param root - Repository root the checkout belongs to.
 * @returns Compact display path; the full path stays on `title` tooltips.
 */
export function checkoutPathLabel(path: string, root: string): string {
  if (path === root) return `${repoFolderName(root)}/`
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  return path
}
