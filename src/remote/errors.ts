/** Typed, wire-safe errors for the remote engine. Messages/details are fixed or allowlisted — provider and network bodies never propagate. */

import type { GitRemoteErrorCode } from './types.ts'

export class GitRemoteError extends Error {
  constructor(
    readonly code: GitRemoteErrorCode,
    message: string,
    readonly details?: Record<string, string | number | boolean | readonly string[] | undefined>,
  ) {
    super(message)
    this.name = 'GitRemoteError'
  }
}

export function remoteAuthError(reason: string, details?: GitRemoteError['details']): GitRemoteError {
  return new GitRemoteError('git/unauthenticated', `git remote authentication is not usable (${reason})`, { reason, ...details })
}
