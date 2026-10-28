/** Provider construction belongs at the Host assembly boundary. */
import { GitRemoteAuth } from './auth.ts'
import type { GitRemoteCredentialService } from './credentials.ts'
import { GitHubProvider, type GitHubScopedFactsProvider } from './github.ts'
import { GitRemoteHttp } from './http.ts'
import { ghAuthToken, gitCredentialFill, type GitRemoteSubprocess } from './probe.ts'
import type { ResolvedRemoteSettings } from './settings.ts'
import type { GitService } from '../service.ts'
import type { GitRemoteCapabilityOn } from './types.ts'
import type { ScopedRemoteProvider } from './registry.ts'
import { GitHubLegacyOwner } from './github-legacy.ts'

export function createGitHubProvider(credentials: GitRemoteCredentialService, subprocess: GitRemoteSubprocess, settings: ResolvedRemoteSettings): { auth: GitRemoteAuth; provider: GitHubScopedFactsProvider } {
  const http = new GitRemoteHttp(settings)
  const auth = new GitRemoteAuth({ credentials, http, settings, discoverGh: async signal => { try { return await ghAuthToken({ subprocess, probeTimeoutMs: settings.probeTimeoutMs }, signal) } catch { signal.throwIfAborted(); return undefined } }, discoverGitCredential: signal => gitCredentialFill({ subprocess, probeTimeoutMs: settings.probeTimeoutMs }, signal) })
  return { auth, provider: new GitHubProvider(auth, http) }
}

/** Stable v1 projection and the scoped provider share one GitHub owner. */
export interface LegacyRemoteChannel {
  readonly scoped: ScopedRemoteProvider
  capability(): Promise<GitRemoteCapabilityOn & { remoteProtocol: 2 }>
  handle(endpoint: string, payload: unknown, signal: AbortSignal, assertSession: (request: Record<string, unknown>, signal: AbortSignal) => Promise<void>, scoped?: boolean): Promise<unknown>
  invalidateRecord(key: string): void
  invalidateReference(ref: string): void
  dispose(): Promise<void>
}
export function createGitHubOwner(credentials: GitRemoteCredentialService, subprocess: GitRemoteSubprocess, settings: ResolvedRemoteSettings, service: GitService): LegacyRemoteChannel {
  const core = createGitHubProvider(credentials, subprocess, settings)
  return new GitHubLegacyOwner(core.auth, core.provider, service)
}
