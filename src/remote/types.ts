/** Browser-safe wire contracts for the remote-platform surface (ADR-0004); never carries tokens, codes, or fingerprints. */

import type { GitRemoteCredentialMember } from './credentials.ts'

export type { GitRemoteCredentialMember } from './credentials.ts'

export interface GitRemoteGeneration {
  readonly instanceId: string
  readonly revision: number
}

export interface GitRemoteViewer {
  readonly host: string
  readonly userId: string
  readonly login: string
  readonly name?: string
  readonly avatarUrl?: string
}

export interface GitRemoteCredentialInfo {
  readonly configured: boolean
  readonly writable: boolean
  readonly source?: string
}

export type GitRemoteAuthState =
  | 'off'
  | 'anonymous'
  | 'unauthenticated'
  | 'signed-out'
  | 'authenticated'
  | 'invalid'

export type GitRemoteAuthSource = 'grant' | 'ref' | 'gh' | 'git-credential'

export interface GitRemotePermissions {
  readonly pull?: boolean
  readonly triage?: boolean
  readonly push?: boolean
  readonly maintain?: boolean
  readonly admin?: boolean
}

export type GitRemoteActionAvailability = boolean | 'unknown'

export interface GitRemoteActions {
  readonly canComment: GitRemoteActionAvailability
  readonly canReview: GitRemoteActionAvailability
  readonly canMerge: GitRemoteActionAvailability
  readonly canClose: GitRemoteActionAvailability
  readonly canCreatePr: GitRemoteActionAvailability
}

export type GitRemoteUnavailableReason =
  | 'credentials-missing'
  | 'credentials-incomplete'
  | 'implementation-pending'

export interface GitRemoteCapabilityOff {
  readonly state: 'off'
  readonly reason: GitRemoteUnavailableReason
  readonly missing?: readonly GitRemoteCredentialMember[]
  readonly auth: { readonly state: 'off' }
}

export type RemoteAuthMethod = 'auto' | 'cli' | 'oauth'
export interface RemoteAuthSelection { readonly method: RemoteAuthMethod; readonly cliAvailable: boolean; readonly oauthCached: boolean }

export interface GitRemoteCapabilityOn {
  readonly authSelection?: RemoteAuthSelection
  readonly state: 'on'
  readonly generation: GitRemoteGeneration
  readonly credential: GitRemoteCredentialInfo
  readonly auth: {
    readonly state: Exclude<GitRemoteAuthState, 'off'>
    readonly source?: GitRemoteAuthSource
  }
  readonly viewer?: GitRemoteViewer
  readonly permissions?: GitRemotePermissions
  readonly actions: GitRemoteActions
  readonly loginAvailable: boolean
  readonly automaticRefreshAvailable: boolean
}

export type GitRemoteCapability = GitRemoteCapabilityOff | GitRemoteCapabilityOn

export type GitRemoteErrorCode =
  | 'git/remote-unavailable'
  | 'git/unauthenticated'
  | 'git/signed-out'
  | 'git/insufficient-scope'
  | 'git/head-moved'
  | 'git/rate-limited'
  | 'git/write-result-unknown'
  | 'git/remote-identity-mismatch'

export interface GitRemoteWriteContext {
  readonly host: string
  readonly owner: string
  readonly repo: string
  readonly expectedGeneration: GitRemoteGeneration
  readonly expectedViewer: {
    readonly host: string
    readonly userId: string
  }
}

/** Additive v2 contracts; published v1 types above retain their original meaning. */
export interface ScopedRemoteScope { readonly provider: 'github' | 'gitlab'; readonly instance: string }
export interface ScopedRemoteResult<T> { readonly generation: GitRemoteGeneration; readonly value: T }
export interface ScopedRemoteEnvelope<T> extends ScopedRemoteResult<T> { readonly remoteProtocol: 2; readonly scope: ScopedRemoteScope }
export interface ScopedRemoteCapabilityOn {
  readonly authSelection?: RemoteAuthSelection
  readonly state: 'on'
  readonly generation: GitRemoteGeneration
  readonly credential: GitRemoteCredentialInfo
  readonly auth: { readonly state: Exclude<GitRemoteAuthState, 'off'>; readonly source?: 'grant' | 'ref' | 'gh' | 'glab' | 'git-credential' }
  readonly viewer?: GitRemoteViewer
  readonly actions: GitRemoteActions
  readonly authMethods: { readonly deviceFlow: { readonly supported: boolean | 'unknown'; readonly reason?: string } }
  readonly serverVersion?: { readonly value: string; readonly support: 'unknown'; readonly reason: 'not-verified' }
  readonly loginAvailable: boolean
  readonly automaticRefreshAvailable: boolean
}
