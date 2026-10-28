/** Published v1 type consumer: this file compiles against the built package exports. */
import type { GitRemoteCapabilityOn, GitRemoteWriteContext, RemoteCheckoutReceipt, RemoteProvider, RemotePull, RemoteRepository } from '@dsh-electron/dsh-plugin-git/types'
const repo: RemoteRepository = { provider: 'github', host: 'github.com', owner: 'alice', repo: 'repo' }
const sha = 'a'.repeat(40)
const pull: RemotePull = { number: 7, title: 'Existing', body: '', state: 'open', rawState: 'open', author: null, head: { repository: repo, ref: 'topic', sha }, base: { repository: repo, ref: 'main', sha }, draft: false }
const writeContext: GitRemoteWriteContext = { host: 'github.com', owner: 'alice', repo: 'repo', expectedGeneration: { instanceId: 'g', revision: 1 }, expectedViewer: { host: 'github.com', userId: '9' } }
const receipt: RemoteCheckoutReceipt = { switched: true, privateRefWritten: true, trackingRefPrepared: true, fetchMappingAdded: false, upstreamNotConfigured: false, branch: 'topic' }
const actions = { canComment: true, canReview: 'unknown', canClose: true, canMerge: false, canCreatePr: true } as const
const capability: GitRemoteCapabilityOn = { state: 'on', generation: writeContext.expectedGeneration, credential: { configured: true, writable: true }, auth: { state: 'authenticated', source: 'grant' }, actions, loginAvailable: true, automaticRefreshAvailable: false }
// GitHub v1 callers do not need to handle an expanded provider union.
const providerName: 'github' = repo.provider
// @ts-expect-error GitLab is carried by the additive scoped model, not the v1 repository type.
const invalid: RemoteRepository = { provider: 'gitlab', host: 'git.example', owner: 'group', repo: 'repo' }
export function callLegacy(provider: RemoteProvider, signal: AbortSignal) { return provider.pull(repo, pull.number, { signal }) }
void [receipt, capability, providerName, invalid]
