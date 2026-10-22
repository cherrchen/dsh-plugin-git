/** Fail-closed Host boundary for the remote-platform surface (ADR-0004 clause 1). */

import { probeCredentialsService } from './credentials.ts'
import type { GitRemoteCredentialMember } from './credentials.ts'
import type { GitRemoteCapability, GitRemoteErrorCode, GitRemoteUnavailableReason } from './types.ts'

export function remoteCapability(credentials: unknown): GitRemoteCapability {
  const probe = probeCredentialsService(credentials)
  switch (probe.state) {
    case 'missing':
      return { state: 'off', reason: 'credentials-missing', auth: { state: 'off' } }
    case 'incomplete':
      return {
        state: 'off',
        reason: 'credentials-incomplete',
        missing: probe.missing,
        auth: { state: 'off' },
      }
    case 'supported':
      return { state: 'off', reason: 'implementation-pending', auth: { state: 'off' } }
  }
}

export class GitRemoteUnavailableError extends Error {
  readonly code: GitRemoteErrorCode = 'git/remote-unavailable'
  readonly details: {
    readonly reason: GitRemoteUnavailableReason
    readonly missing?: readonly GitRemoteCredentialMember[]
  }

  constructor(capability: GitRemoteCapability) {
    super('git remote platform integration is unavailable')
    this.name = 'GitRemoteUnavailableError'
    this.details =
      capability.state === 'off'
        ? {
            reason: capability.reason,
            ...(capability.missing === undefined ? {} : { missing: capability.missing }),
          }
        : { reason: 'implementation-pending' }
  }
}
