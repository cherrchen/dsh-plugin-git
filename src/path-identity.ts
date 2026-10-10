/** Compare filesystem paths without consulting the process working directory. */

import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * Resolve one Git-reported path against an explicit base directory.
 * Relative values use `base`; absolute values stay absolute. Existing paths
 * are canonicalized so macOS `/var` and `/private/var` compare equal.
 * @param value - Path from Git or a caller.
 * @param base - Directory that relative paths are resolved against.
 * @returns A comparable absolute path.
 */
export function canonicalPath(value: string, base: string): string {
  const trimmed = value.trim()
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(base, trimmed)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/**
 * Whether two paths name the same directory or file.
 * @param left - First path.
 * @param right - Second path.
 * @param base - Directory used to resolve either path when it is relative.
 * @returns True when both paths canonicalize to the same absolute path.
 */
export function samePath(left: string, right: string, base: string): boolean {
  return canonicalPath(left, base) === canonicalPath(right, base)
}
