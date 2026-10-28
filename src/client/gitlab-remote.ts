/** Workspace-scoped GitLab controller. Every business request uses negotiated scoped RPC. */
import type { GitRemoteFeature } from './remote.ts'
import { ScopedProtocolError } from './remote-protocol.ts'
import { GitLabNotices } from './gitlab-notices.ts'
import type { GitRemoteGeneration, GitRemoteViewer, ScopedRemoteCapabilityOn, ScopedRemoteScope } from '../remote/types.ts'
import type { RemotePage, ScopedGitLabRepository, ScopedRemoteApprovalFacts, ScopedRemoteCommit, ScopedRemoteDiscussion, ScopedRemoteFile, ScopedRemoteIssue, ScopedRemoteNote, ScopedRemoteNotice, ScopedRemotePull, ScopedRemoteRepositoryFacts } from '../remote/provider.ts'

type Kind = 'pulls' | 'issues'
type Filter = 'open' | 'closed' | 'all'
type Item = ScopedRemotePull | ScopedRemoteIssue
type PageKey = 'items' | 'comments' | 'discussions' | 'commits' | 'files'
export interface GitLabLogin { readonly attemptId: string; readonly userCode: string; readonly verificationUri: string }
export interface GitLabConfirmation { readonly action: 'close' | 'merge'; readonly method?: 'merge' | 'squash'; readonly identity: string; readonly number: number; readonly sha: string }
export interface GitLabRemoteState {
  readonly hostSupported: boolean
  readonly repository?: string | undefined
  readonly targets: readonly { readonly name: 'origin' | 'upstream'; readonly identity: ScopedGitLabRepository }[]
  readonly unresolved: boolean
  readonly target?: ScopedGitLabRepository | undefined
  readonly capability?: ScopedRemoteCapabilityOn | undefined
  readonly generation?: GitRemoteGeneration | undefined
  readonly facts?: ScopedRemoteRepositoryFacts | undefined
  readonly kind: Kind
  readonly filter: Filter
  readonly items: readonly Item[]
  readonly itemsNext?: string | undefined
  readonly detail?: Item | undefined
  readonly comments?: RemotePage<ScopedRemoteNote> | undefined
  readonly discussions?: RemotePage<ScopedRemoteDiscussion> | undefined
  readonly commits?: RemotePage<ScopedRemoteCommit> | undefined
  readonly approvals?: ScopedRemoteApprovalFacts | undefined
  readonly files?: { readonly files: RemotePage<ScopedRemoteFile>; readonly baseSha: string; readonly startSha: string; readonly headSha: string; readonly serverCompleteness: 'unknown' } | undefined
  readonly unavailable: readonly string[]
  readonly notices: readonly ScopedRemoteNotice[]
  readonly busy: boolean
  readonly blocked: boolean
  readonly reconciled: boolean
  readonly blockedAction?: string | undefined
  readonly error?: string | undefined
  readonly errorDetails?: Readonly<Record<string, string | number | boolean>> | undefined
  readonly outcome?: unknown
  readonly confirmation?: GitLabConfirmation | undefined
  readonly login?: GitLabLogin | undefined
}
const same = (a: GitRemoteGeneration | undefined, b: GitRemoteGeneration | undefined) => a !== undefined && b !== undefined && a.instanceId === b.instanceId && a.revision === b.revision
function page<T>(value: unknown): RemotePage<T> {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { items?: unknown }).items)) throw new ScopedProtocolError('invalid-response')
  const raw = value as { items: T[]; truncated?: unknown; next?: unknown }
  if (typeof raw.truncated !== 'boolean' || (raw.next !== undefined && typeof raw.next !== 'string') || raw.truncated !== (raw.next !== undefined)) throw new ScopedProtocolError('invalid-response')
  return { items: raw.items, truncated: raw.truncated, ...(raw.next === undefined ? {} : { next: raw.next }) }
}
function validVerification(instance: string, userCode: string, raw: string): boolean {
  try {
    const base = new URL(instance), url = new URL(raw), prefix = base.pathname === '/' ? '' : base.pathname
    return url.protocol === 'https:' && url.origin === base.origin && !url.username && !url.password && url.pathname === `${prefix}/oauth/device` && !url.search && !url.hash && /^[^\s\x00-\x1f\x7f]{1,200}$/u.test(userCode)
  } catch { return false }
}
const acceptedAction = (value: unknown) => value === true || value === 'unknown'
const removedInstance = (error: ScopedProtocolError | undefined) => error?.details?.['reason'] === 'instance-removed' || error?.details?.['reason'] === 'provider-unavailable'
const invalidProtocol = (error: ScopedProtocolError | undefined) => error !== undefined && ['scope-mismatch', 'generation-missing', 'generation-mismatch', 'invalid-response', 'invalid-facts', 'host-not-negotiated', 'seam-off', 'write-response-lost'].includes(error.reason)

export class GitLabRemoteController {
  private state: GitLabRemoteState
  private readonly listeners = new Set<() => void>()
  private readonly notifications = new GitLabNotices()
  private epoch = 0
  private active = new AbortController()
  private disposed = false
  private readonly unsubscribe: () => void
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly feature: GitRemoteFeature, private readonly sessionId: string) {
    this.state = { hostSupported: feature.scoped.available, targets: [], unresolved: false, kind: 'pulls', filter: 'open', items: [], unavailable: [], notices: [], busy: false, blocked: false, reconciled: false }
    this.unsubscribe = feature.subscribe(() => {
      const available = this.feature.scoped.available
      const wasAvailable = this.state.hostSupported
      if (!available && this.state.hostSupported) this.clear(this.state.repository)
      this.patch({ hostSupported: available })
      if (available && !wasAvailable && this.state.repository !== undefined) void this.discover()
    })
    this.timer = setInterval(() => { if (this.listeners.size > 0 && !this.state.busy && this.state.login === undefined && this.state.target !== undefined) void this.pollNotices() }, 60_000)
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.state
  get idle(): boolean { return this.listeners.size === 0 && !this.state.busy && !this.state.blocked && this.state.login === undefined }
  private patch(value: Partial<GitLabRemoteState>): void { if (this.disposed) return; this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener() }
  private cancel(): Promise<void> {
    const scope = this.state.target?.scope, login = this.state.login
    this.epoch++; this.active.abort(); this.active = new AbortController()
    this.state = { ...this.state, busy: false, login: undefined }
    if (scope !== undefined) this.feature.scoped.invalidate(scope, this.sessionId)
    if (scope === undefined || login === undefined) return Promise.resolve()
    // Cleanup belongs to the original instance and must survive the old UI signal.
    // Its own lane cannot invalidate new reads/login when switching within an instance.
    return this.feature.scoped.call('remote-cancel-login', scope, { attemptId: login.attemptId }, undefined, `${this.sessionId}:cancel-login`).then(() => {}, () => {})
  }
  private clear(repository?: string): void {
    this.cancel()
    this.notifications.clear()
    this.state = { hostSupported: this.feature.scoped.available, ...(repository === undefined ? {} : { repository }), targets: [], unresolved: false, kind: 'pulls', filter: 'open', items: [], unavailable: [], notices: [], busy: false, blocked: false, reconciled: false }
  }
  setRepository(repository: string | undefined): void {
    if (repository === this.state.repository) return
    this.clear(repository); this.patch({})
    if (repository !== undefined && this.feature.scoped.available) void this.discover()
  }
  private async run(work: (epoch: number) => Promise<void>, allowBlocked = false): Promise<void> {
    if (this.disposed || this.state.busy || (!allowBlocked && this.state.blocked)) return
    const epoch = this.epoch; this.patch({ busy: true, ...(this.state.blocked ? {} : { error: undefined, errorDetails: undefined }) })
    try { await work(epoch) } catch (error) {
      if (epoch === this.epoch && !this.disposed) {
        const scoped = error instanceof ScopedProtocolError ? error : undefined
        const changedIdentity = scoped?.code === 'git/remote-identity-mismatch' || scoped?.code === 'git/unauthenticated' || scoped?.code === 'git/signed-out' || scoped?.reason === 'stale-generation' || removedInstance(scoped)
        const invalidScope = invalidProtocol(scoped)
        if ((changedIdentity || invalidScope) && this.state.target !== undefined) this.notifications.clearInstance(this.state.target.scope.instance)
        const details = this.state.blocked && !changedIdentity ? { ...this.state.errorDetails, ...scoped?.details } : scoped?.details
        const blocked = changedIdentity ? false : this.state.blocked || scoped?.code === 'git/write-result-unknown'
        const keepReconciliationTarget = invalidScope && blocked && !changedIdentity
        if (changedIdentity || invalidScope) this.cancel()
        this.patch({ error: scoped?.code ?? scoped?.reason ?? 'git/remote-unavailable', errorDetails: details, blocked, blockedAction: changedIdentity ? undefined : scoped?.code === 'git/write-result-unknown' ? String(scoped.details?.['action'] ?? 'unknown') : this.state.blockedAction, reconciled: false, confirmation: undefined, ...((changedIdentity || invalidScope) ? { facts: undefined, detail: keepReconciliationTarget ? this.state.detail : undefined, generation: undefined, capability: undefined, items: [], itemsNext: undefined, comments: undefined, discussions: undefined, commits: undefined, approvals: undefined, files: undefined, notices: [] } : {}) })
      }
    } finally { if (epoch === this.epoch) this.patch({ busy: false }) }
  }
  private async call<T>(endpoint: string, payload: Record<string, unknown>, epoch: number, expected?: GitRemoteGeneration): Promise<{ generation: GitRemoteGeneration; value: T }> {
    const target = this.state.target, repository = this.state.repository
    if (target === undefined || repository === undefined) throw new ScopedProtocolError('invalid-target')
    const response = await this.feature.scoped.call<T>(endpoint, target.scope, { ...payload, repository, sessionId: this.sessionId, path: target.path, ...(target.projectId === undefined ? {} : { projectId: target.projectId }) }, this.active.signal, this.sessionId)
    if (epoch !== this.epoch || this.disposed) throw new ScopedProtocolError('stale-response')
    if (expected !== undefined && !same(expected, response.generation)) { this.patch({ confirmation: undefined, facts: undefined }); throw new ScopedProtocolError('stale-generation') }
    return response
  }
  private async mutation(endpoint: string, payload: Record<string, unknown>, epoch: number, generation: GitRemoteGeneration | undefined, action: string, number?: number): Promise<{ generation: GitRemoteGeneration; value: { outcome: 'succeeded' | 'partial' | 'unknown'; steps: readonly unknown[] } }> {
    try {
      const result = await this.call<unknown>(endpoint, payload, epoch, generation)
      const value = result.value
      if (typeof value !== 'object' || value === null || !('outcome' in value) || !['succeeded', 'partial', 'unknown'].includes(String(value.outcome)) || !('steps' in value) || !Array.isArray(value.steps)) throw new ScopedProtocolError('invalid-response')
      return { generation: result.generation, value: value as { outcome: 'succeeded' | 'partial' | 'unknown'; steps: readonly unknown[] } }
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) throw error
      if (error instanceof ScopedProtocolError) {
        if (error.reason === 'host-not-negotiated' || error.code === 'git/write-result-unknown' || error.code === 'git/head-moved' || error.code === 'git/insufficient-scope' || error.code === 'git/rate-limited' || error.code === 'git/unauthenticated' || error.code === 'git/signed-out') throw error
        const known = ['not-sent', 'provider-rejected', 'approval-rejected-or-reauth-required', 'action-not-supported', 'invalid-request', 'invalid-comparison', 'object-read-only', 'unsupported-review-event', 'unsupported-merge-method']
        if (error.code === 'git/remote-unavailable' && known.includes(String(error.details?.['reason'] ?? ''))) throw error
      }
      const reason = error instanceof ScopedProtocolError && invalidProtocol(error) ? error.reason : 'write-response-lost'
      throw new ScopedProtocolError(reason, 'git/write-result-unknown', { action, ...(number === undefined ? {} : { number }) })
    }
  }
  private validateFacts(value: ScopedRemoteRepositoryFacts, object?: { kind: 'pull' | 'issue'; number: number }): void {
    const scope = value?.actionScope, target = this.state.target
    if (target === undefined || scope?.path !== target.path || typeof scope.projectId !== 'string' || !/^[1-9][0-9]{0,39}$/u.test(scope.projectId) || (target.projectId !== undefined && target.projectId !== scope.projectId) || (object === undefined ? scope.object !== undefined : scope.object?.kind !== object.kind || scope.object.number !== object.number)) throw new ScopedProtocolError('invalid-facts')
  }
  async discover(): Promise<void> {
    if (this.state.blocked) return
    if (this.state.repository === undefined || !this.feature.scoped.available) { this.patch({ hostSupported: this.feature.scoped.available }); return }
    this.cancel()
    await this.run(async epoch => {
      const discovered = await this.feature.scoped.discover(this.state.repository!, this.sessionId, this.active.signal)
      if (epoch !== this.epoch) return
      const targets = discovered.remotes.filter((item): item is { name: 'origin' | 'upstream'; identity: ScopedGitLabRepository } => item.identity.provider === 'gitlab')
      this.patch({ targets, unresolved: (discovered.unresolved?.length ?? 0) > 0, target: targets[0]?.identity, items: [], detail: undefined, facts: undefined, confirmation: undefined, blocked: false, reconciled: false, blockedAction: undefined })
      if (targets[0] !== undefined) await this.loadList(epoch, 'pulls', 'open')
    }, true)
  }
  async select(target: ScopedGitLabRepository): Promise<void> {
    if (!this.state.targets.some(item => item.identity.scope.instance === target.scope.instance && item.identity.path === target.path)) return
    if (this.state.blocked) return
    this.cancel(); this.notifications.deactivate(); this.patch({ target, generation: undefined, capability: undefined, facts: undefined, items: [], notices: [], detail: undefined, confirmation: undefined, blocked: false, reconciled: false, blockedAction: undefined, outcome: undefined })
    await this.run(epoch => this.loadList(epoch, this.state.kind, this.state.filter), true)
  }
  private async loadList(epoch: number, kind: Kind, filter: Filter, reconcile = false): Promise<void> {
    const initialCapability = await this.call<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
    this.patch({ capability: initialCapability.value, generation: initialCapability.generation })
    const facts = await this.call<ScopedRemoteRepositoryFacts>('remote-repository', {}, epoch)
    this.validateFacts(facts.value)
    const target = this.state.target!
    this.patch({ target: { ...target, projectId: facts.value.actionScope.projectId! }, generation: facts.generation, facts: facts.value })
    if (facts.value.viewer === undefined) this.notifications.deactivate()
    else this.notifications.activate({ instance: target.scope.instance, projectId: facts.value.actionScope.projectId!, viewer: facts.value.viewer, generation: facts.generation })
    const result = await this.call<RemotePage<Item>>(kind === 'pulls' ? 'remote-list-prs' : 'remote-list-issues', { state: filter, pages: 1 }, epoch, facts.generation)
    const capability = await this.call<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch, facts.generation)
    const list = page<Item>(result.value)
    for (const item of list.items) if ('head' in item) this.observePull(item)
    this.patch({ kind, filter, items: list.items, itemsNext: list.next, detail: undefined, capability: capability.value, generation: facts.generation, notices: [...this.notifications.items], confirmation: undefined, unavailable: [], ...(reconcile && this.state.blocked ? { reconciled: list.next === undefined } : { blocked: false, reconciled: false, blockedAction: undefined, outcome: undefined }) })
  }
  async list(kind: Kind, filter: Filter): Promise<void> {
    if (this.state.blocked) return
    this.cancel(); this.patch({ detail: undefined, confirmation: undefined })
    await this.run(epoch => this.loadList(epoch, kind, filter), true)
  }
  async open(number: number, kind: Kind = this.state.kind, reconcile = false): Promise<void> {
    if (!Number.isSafeInteger(number) || number < 1) return
    this.cancel(); this.patch({ confirmation: undefined })
    await this.run(async epoch => {
      const previous = this.state.generation
      const detail = await this.call<Item>(kind === 'pulls' ? 'remote-pr' : 'remote-issue', { number }, epoch, previous)
      if (detail.value.number !== number) throw new ScopedProtocolError('invalid-response')
      if ('head' in detail.value) this.observePull(detail.value)
      const object = { kind: kind === 'pulls' ? 'pull' as const : 'issue' as const, number }
      const facts = await this.call<ScopedRemoteRepositoryFacts>('remote-repository', { object }, epoch, detail.generation); this.validateFacts(facts.value, object)
      const unavailable: string[] = []
      const optional = async <T,>(name: string, endpoint: string, payload: Record<string, unknown>): Promise<T | undefined> => {
        try { return (await this.call<T>(endpoint, payload, epoch, detail.generation)).value } catch (error) {
          if (error instanceof ScopedProtocolError && (error.reason === 'stale-response' || error.reason === 'stale-generation' || invalidProtocol(error) || error.code === 'git/remote-identity-mismatch' || error.code === 'git/unauthenticated' || error.code === 'git/signed-out' || removedInstance(error))) throw error
          unavailable.push(name); return undefined
        }
      }
      const commentsRaw = await optional<RemotePage<ScopedRemoteNote>>('comments', 'remote-comments', { number, objectKind: object.kind, pages: 1 })
      const discussionsRaw = await optional<RemotePage<ScopedRemoteDiscussion>>('discussions', 'remote-discussions', { number, objectKind: object.kind, pages: 1 })
      const commitsRaw = kind === 'pulls' ? await optional<RemotePage<ScopedRemoteCommit>>('commits', 'remote-commits', { number, pages: 1 }) : undefined
      const approvals = kind === 'pulls' ? await optional<ScopedRemoteApprovalFacts>('approvals', 'remote-approvals', { number }) : undefined
      const files = kind === 'pulls' ? await optional<GitLabRemoteState['files']>('files', 'remote-files', { number, pages: 1 }) : undefined
      const comments = commentsRaw === undefined ? undefined : page<ScopedRemoteNote>(commentsRaw)
      const needsComments = this.state.blockedAction === 'comment' || this.state.blockedAction === 'remote-comment' || this.state.blockedAction === 'review' || this.state.blockedAction === 'remote-review'
      const needsApprovals = this.state.blockedAction === 'review' || this.state.blockedAction === 'approve' || this.state.blockedAction === 'remote-review'
      const reconciled = (!needsComments || comments !== undefined && comments.next === undefined) && (!needsApprovals || approvals !== undefined)
      this.patch({ kind, detail: detail.value, facts: facts.value, generation: detail.generation, comments, discussions: discussionsRaw === undefined ? undefined : page<ScopedRemoteDiscussion>(discussionsRaw), commits: commitsRaw === undefined ? undefined : page<ScopedRemoteCommit>(commitsRaw), approvals, files, unavailable, confirmation: undefined, ...(reconcile && this.state.blocked ? { reconciled } : {}) })
    }, reconcile)
  }
  async more(which: PageKey): Promise<void> {
    const detail = this.state.detail, current = which === 'items' ? undefined : which === 'files' ? this.state.files?.files : this.state[which]
    const cursor = which === 'items' ? this.state.itemsNext : current?.next
    if (cursor === undefined || this.state.generation === undefined) return
    await this.run(async epoch => {
      const kind = this.state.kind, objectKind = kind === 'pulls' ? 'pull' : 'issue'
      const endpoint = which === 'items' ? kind === 'pulls' ? 'remote-list-prs' : 'remote-list-issues' : which === 'comments' ? 'remote-comments' : which === 'discussions' ? 'remote-discussions' : which === 'commits' ? 'remote-commits' : 'remote-files'
      const payload: Record<string, unknown> = which === 'items' ? { state: this.state.filter, cursor } : { number: detail?.number, cursor, ...(which === 'comments' || which === 'discussions' ? { objectKind } : {}), ...(which === 'files' && this.state.files !== undefined ? { expectedBaseSha: this.state.files.baseSha, expectedStartSha: this.state.files.startSha, expectedHeadSha: this.state.files.headSha } : {}) }
      const result = await this.call<unknown>(endpoint, payload, epoch, this.state.generation)
      if (which === 'items') { const next = page<Item>(result.value); for (const item of next.items) if ('head' in item) this.observePull(item); this.patch({ items: [...this.state.items, ...next.items], itemsNext: next.next, ...(this.state.blocked && this.state.blockedAction === 'create-pr' ? { reconciled: next.next === undefined } : {}) }); return }
      if (which === 'files') {
        const value = result.value as NonNullable<GitLabRemoteState['files']>, previous = this.state.files
        if (previous === undefined || value.baseSha !== previous.baseSha || value.startSha !== previous.startSha || value.headSha !== previous.headSha) throw new ScopedProtocolError('stale-comparison')
        const next = page<ScopedRemoteFile>(value.files); this.patch({ files: { ...value, files: { ...next, items: [...previous.files.items, ...next.items] } } }); return
      }
      const next = page<ScopedRemoteNote | ScopedRemoteDiscussion | ScopedRemoteCommit>(result.value)
      const prior = current?.items ?? []
      const reviewBlocked = this.state.blockedAction === 'review' || this.state.blockedAction === 'remote-review'
      const commentBlocked = reviewBlocked || this.state.blockedAction === 'comment' || this.state.blockedAction === 'remote-comment'
      this.patch({ [which]: { ...next, items: [...prior, ...next.items] }, ...(which === 'comments' && this.state.blocked && commentBlocked ? { reconciled: next.next === undefined && (!reviewBlocked || this.state.approvals !== undefined) } : {}) })
    }, true)
  }
  private confirmationIdentity(): string | undefined {
    const target = this.state.target, facts = this.state.facts, detail = this.state.detail, generation = this.state.generation, viewer = facts?.viewer
    if (target === undefined || facts === undefined || detail === undefined || !('head' in detail) || detail.head.sha === null || generation === undefined || viewer === undefined || facts.actionScope.object?.kind !== 'pull' || facts.actionScope.object.number !== detail.number || facts.actionScope.projectId !== target.projectId) return undefined
    return JSON.stringify([target.scope, target.path, target.projectId, detail.number, detail.head.sha, detail.state, detail.rawState, generation, viewer.host, viewer.userId])
  }
  prepare(action: 'close' | 'merge', method?: 'merge' | 'squash'): void {
    const identity = this.confirmationIdentity(), detail = this.state.detail, facts = this.state.facts
    if (identity === undefined || detail === undefined || !('head' in detail) || detail.head.sha === null || facts === undefined || this.state.busy || this.state.blocked) return
    if (action === 'close' && (!facts.operationSupport['close-pr'].supported || !acceptedAction(facts.actions.canClose))) return
    if (action === 'merge' && (method === undefined || !facts.operationSupport['merge-pr'].supported || !facts.supportedMergeMethods.includes(method) || !acceptedAction(facts.actions.canMerge))) return
    this.patch({ confirmation: { action, ...(method === undefined ? {} : { method }), identity, number: detail.number, sha: detail.head.sha } })
  }
  cancelConfirmation(): void { this.patch({ confirmation: undefined }) }
  private expected(): Record<string, unknown> | undefined {
    const target = this.state.target, generation = this.state.generation, facts = this.state.facts, viewer = facts?.viewer
    if (target?.projectId === undefined || generation === undefined || viewer === undefined || facts?.actionScope.path !== target.path || facts.actionScope.projectId !== target.projectId) return undefined
    return { expectedInstance: target.scope.instance, expectedGeneration: generation, expectedViewer: { host: viewer.host, userId: viewer.userId }, requestId: globalThis.crypto.randomUUID() }
  }
  async write(endpoint: 'remote-comment' | 'remote-review' | 'remote-checkout-pr' | 'remote-issue-branch', values: Record<string, unknown> = {}): Promise<void> {
    const detail = this.state.detail, facts = this.state.facts, expected = this.expected()
    if (detail === undefined || facts === undefined || expected === undefined || this.state.blocked) return
    const pull = 'head' in detail
    if (facts.actionScope.object?.kind !== (pull ? 'pull' : 'issue') || facts.actionScope.object.number !== detail.number) return
    if (pull && (detail.rawState === 'locked' || detail.state === 'unknown')) return
    if (!pull && detail.state === 'unknown') return
    if (endpoint === 'remote-comment' && (!pull || !facts.operationSupport.comment.supported || !acceptedAction(facts.actions.canComment))) return
    if (endpoint === 'remote-review') {
      const event = values['event']
      if (!pull || (event !== 'COMMENT' && event !== 'APPROVE') || !facts.operationSupport.review.supported || !facts.supportedReviewEvents.includes(event) || !acceptedAction(facts.actions.canReview) || (event === 'APPROVE' && facts.reviewPermissions?.APPROVE !== true && facts.reviewPermissions?.APPROVE !== 'unknown')) return
    }
    if (endpoint === 'remote-checkout-pr' && (!pull || detail.head.sha === null)) return
    if (endpoint === 'remote-issue-branch' && pull) return
    await this.run(async epoch => {
      const result = await this.mutation(endpoint, { ...values, ...expected, number: detail.number, objectKind: pull ? 'pull' : 'issue', ...(pull && (endpoint === 'remote-checkout-pr' || endpoint === 'remote-review' && values['event'] === 'APPROVE') ? { expectedHeadSha: detail.head.sha } : {}) }, epoch, this.state.generation, endpoint, detail.number)
      const blocked = result.value.outcome === 'partial' || result.value.outcome === 'unknown' || endpoint === 'remote-review' && values['event'] === 'APPROVE'
      this.patch({ outcome: result.value, blocked, blockedAction: blocked ? endpoint : undefined, reconciled: false, confirmation: undefined })
    })
  }
  async confirm(): Promise<void> {
    const confirmation = this.state.confirmation, expected = this.expected()
    if (confirmation === undefined || expected === undefined || confirmation.identity !== this.confirmationIdentity() || this.state.blocked) { this.patch({ confirmation: undefined, error: 'stale-confirmation' }); return }
    await this.run(async epoch => {
      const result = await this.mutation(confirmation.action === 'close' ? 'remote-close-pr' : 'remote-merge-pr', { ...expected, objectKind: 'pull', number: confirmation.number, expectedHeadSha: confirmation.sha, ...(confirmation.method === undefined ? {} : { method: confirmation.method }) }, epoch, this.state.generation, confirmation.action === 'merge' ? 'merge-pr' : 'close-pr', confirmation.number)
      this.patch({ outcome: result.value, blocked: true, blockedAction: confirmation.action === 'merge' ? 'merge-pr' : 'close-pr', reconciled: false, confirmation: undefined })
    })
  }
  async create(values: { source: ScopedGitLabRepository; headRef: string; baseRef: string; title: string; body: string; draft: boolean }): Promise<void> {
    const expected = this.expected(), target = this.state.target, facts = this.state.facts
    if (expected === undefined || target === undefined || facts === undefined || this.state.blocked || !facts.operationSupport['create-pr'].supported || !acceptedAction(facts.actions.canCreatePr) || values.source.scope.instance !== target.scope.instance || !this.state.targets.some(item => item.identity.scope.instance === values.source.scope.instance && item.identity.path === values.source.path)) return
    await this.run(async epoch => {
      const sourceFacts = await this.feature.scoped.call<ScopedRemoteRepositoryFacts>('remote-repository', values.source.scope, { repository: this.state.repository, sessionId: this.sessionId, path: values.source.path, ...(values.source.projectId === undefined ? {} : { projectId: values.source.projectId }) }, this.active.signal, this.sessionId)
      if (epoch !== this.epoch || !same(sourceFacts.generation, this.state.generation) || sourceFacts.value.actionScope.path !== values.source.path || typeof sourceFacts.value.actionScope.projectId !== 'string' || !/^[1-9][0-9]{0,39}$/u.test(sourceFacts.value.actionScope.projectId) || sourceFacts.value.viewer?.host !== facts.viewer?.host || sourceFacts.value.viewer?.userId !== facts.viewer?.userId) throw new ScopedProtocolError('stale-generation')
      const result = await this.mutation('remote-create-pr', { ...expected, head: { provider: 'gitlab', instance: values.source.scope.instance, path: values.source.path, projectId: sourceFacts.value.actionScope.projectId }, headRef: values.headRef, baseRef: values.baseRef, title: values.title, body: values.body, draft: values.draft }, epoch, this.state.generation, 'create-pr')
      this.patch({ outcome: result.value, blocked: result.value.outcome !== 'succeeded', blockedAction: result.value.outcome !== 'succeeded' ? 'create-pr' : undefined, reconciled: false })
    })
  }
  async refresh(): Promise<void> {
    const detail = this.state.detail
    if (detail !== undefined) await this.open(detail.number, this.state.kind, true)
    else {
      this.cancel()
      const creation = this.state.blockedAction === 'create-pr' || this.state.blockedAction === 'remote-create-pr'
      await this.run(epoch => this.loadList(epoch, creation ? 'pulls' : this.state.kind, creation ? 'all' : this.state.filter, true), true)
    }
  }
  acknowledgeReconciliation(): void { if (this.state.blocked && this.state.reconciled) this.patch({ blocked: false, reconciled: false, blockedAction: undefined, error: undefined, errorDetails: undefined, outcome: undefined }) }
  async authAction(endpoint: 'remote-retry-auth' | 'remote-sign-out' | 'remote-clear-grant'): Promise<void> {
    if (this.state.blocked && endpoint === 'remote-retry-auth') return
    if (endpoint !== 'remote-retry-auth' && this.state.target !== undefined) this.notifications.clearInstance(this.state.target.scope.instance)
    this.cancel(); this.patch({ confirmation: undefined, detail: undefined, facts: undefined, items: [], notices: [], blocked: false, reconciled: false, blockedAction: undefined, outcome: undefined })
    await this.run(async epoch => {
      await this.call(endpoint, {}, epoch)
      const cap = await this.call<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
      this.patch({ capability: cap.value, generation: cap.generation })
      if (endpoint !== 'remote-sign-out') await this.loadList(epoch, this.state.kind, this.state.filter)
    }, true)
  }
  private publishNotice(notice: ScopedRemoteNotice): void {
    if (!this.notifications.add(notice)) return
    this.patch({ notices: [...this.notifications.items] })
    this.feature.notifyGitLab({ id: notice.id, kind: notice.kind, title: notice.title, ...(notice.url === undefined ? {} : { url: notice.url }) })
  }
  receivePush(target: ScopedGitLabRepository, projectId: string, viewer: GitRemoteViewer, generation: GitRemoteGeneration, head: string): void {
    if (this.disposed || this.state.repository === undefined) return
    const current = this.state.target, facts = this.state.facts, oldGeneration = this.state.generation
    let previous = current?.projectId !== undefined && facts?.viewer !== undefined && oldGeneration !== undefined ? { instance: current.scope.instance, projectId: current.projectId, viewer: facts.viewer, generation: oldGeneration } : undefined
    if (previous !== undefined && previous.instance === target.scope.instance && (previous.viewer.host !== viewer.host || previous.viewer.userId !== viewer.userId || !same(previous.generation, generation))) {
      this.notifications.clearInstance(target.scope.instance); this.cancel(); this.patch({ facts: undefined, detail: undefined, generation: undefined, items: [], notices: [], confirmation: undefined, error: 'identity-changed' }); return
    }
    this.notifications.activate({ instance: target.scope.instance, projectId, viewer, generation })
    const notice: ScopedRemoteNotice = { id: `push:${head}`, projectId, objectId: head, number: 0, kind: 'create-pr', title: head, state: 'pushed' }
    if (this.notifications.add(notice)) this.feature.notifyGitLab({ id: notice.id, kind: notice.kind, title: notice.title })
    if (previous !== undefined) { this.notifications.activate(previous); this.patch({ notices: [...this.notifications.items] }) }
    else this.notifications.deactivate()
  }
  private observePull(pull: ScopedRemotePull): void {
    const notice = this.notifications.observe(pull)
    if (notice !== undefined) this.publishNotice(notice)
  }
  private async pollNotifications(epoch: number, generation: GitRemoteGeneration): Promise<void> {
    const target = this.state.target, viewer = this.state.facts?.viewer
    if (target?.projectId === undefined || viewer === undefined || this.state.blocked) return
    try {
      const result = await this.call<RemotePage<ScopedRemoteNotice>>('remote-notifications', { automatic: true, pages: 1, ...(this.notifications.cursor === undefined ? {} : { cursor: this.notifications.cursor }) }, epoch, generation)
      const list = page<ScopedRemoteNotice>(result.value)
      for (const notice of list.items) {
        if (notice.kind === 'review-requested' && notice.projectId === target.projectId && notice.state === 'pending' && /^[1-9][0-9]{0,39}$/u.test(notice.id) && /^[1-9][0-9]{0,39}$/u.test(notice.objectId) && Number.isSafeInteger(notice.number) && notice.number > 0 && typeof notice.title === 'string' && notice.title.length <= 65536) this.publishNotice(notice)
      }
      this.notifications.cursor = list.next
    } catch (error) {
      if (error instanceof ScopedProtocolError && (error.reason === 'stale-response' || error.reason === 'stale-generation' || invalidProtocol(error) || error.code === 'git/remote-identity-mismatch' || error.code === 'git/unauthenticated' || error.code === 'git/signed-out' || removedInstance(error))) throw error
      if (error instanceof ScopedProtocolError && error.details?.['reason'] === 'invalid-cursor') this.notifications.cursor = undefined
    }
    const tracked = this.notifications.nextPull()
    if (tracked === undefined) return
    try {
      const result = await this.call<ScopedRemotePull>('remote-pr', { number: tracked.number, automatic: true }, epoch, generation)
      if (result.value.id === tracked.id && result.value.number === tracked.number) this.observePull(result.value)
    } catch (error) {
      if (error instanceof ScopedProtocolError && (error.reason === 'stale-response' || error.reason === 'stale-generation' || invalidProtocol(error) || error.code === 'git/remote-identity-mismatch' || error.code === 'git/unauthenticated' || error.code === 'git/signed-out' || removedInstance(error))) throw error
    }
  }
  async pollNotices(): Promise<void> {
    await this.run(async epoch => {
      const cap = await this.call<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
      if (this.state.generation !== undefined && !same(this.state.generation, cap.generation)) { if (this.state.target !== undefined) this.notifications.clearInstance(this.state.target.scope.instance); this.cancel(); this.patch({ capability: cap.value, generation: cap.generation, facts: undefined, detail: undefined, items: [], notices: [], confirmation: undefined, blocked: false, reconciled: false, blockedAction: undefined, error: 'identity-changed' }); return }
      this.patch({ capability: cap.value })
      if (cap.value.auth.state === 'authenticated') await this.pollNotifications(epoch, cap.generation)
    }, true)
  }
  async login(): Promise<void> {
    if (this.state.capability?.loginAvailable !== true || this.state.login !== undefined) return
    await this.run(async epoch => {
      const scope = this.state.target!.scope, signal = this.active.signal
      const started = await this.call<GitLabLogin>('remote-login', {}, epoch)
      if (!validVerification(scope.instance, started.value.userCode, started.value.verificationUri) || typeof started.value.attemptId !== 'string' || started.value.attemptId.length > 200) throw new ScopedProtocolError('invalid-login')
      this.patch({ login: started.value, confirmation: undefined, generation: started.generation })
      if (epoch !== this.epoch || this.disposed) return
      void this.feature.scoped.call('remote-poll-login', scope, { attemptId: started.value.attemptId }, signal, this.sessionId).then(async result => {
        if (epoch !== this.epoch || this.disposed) return
        this.patch({ login: undefined, generation: result.generation })
        await this.authAction('remote-retry-auth')
      }).catch(() => { if (epoch === this.epoch) this.patch({ login: undefined, error: 'login-failed' }) })
    })
  }
  async cancelLogin(): Promise<void> {
    if (this.state.login === undefined) return
    const cleanup = this.cancel(); this.patch({})
    await cleanup
  }
  dispose(): void { this.cancel(); this.disposed = true; clearInterval(this.timer); this.notifications.clear(); this.unsubscribe(); this.listeners.clear() }
}
