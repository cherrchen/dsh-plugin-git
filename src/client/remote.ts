/** Portable remote capability lifecycle and session/workspace-scoped controller. */
import type { GitRpcClient } from './controller.ts'
import { ScopedProtocolError, ScopedRemoteClient, type RemoteAccountDescriptor } from './remote-protocol.ts'
import { GitLabNotices } from './gitlab-notices.ts'
import { GITHUB_SCOPE, projectGitLabDiscussion, projectGitLabNote, remoteTargetScope, sameRemoteTarget, strictPage, type RemoteBoundRemote, type RemoteCommentView, type RemoteCommitView, type RemoteConfirmation, type RemoteItem, type RemoteLoginAttempt, type RemoteTarget, type RemoteUnresolvedRemote, type RemoteWriteOutcome } from './remote/remote-view.ts'
import type { GitRemoteCapability, GitRemoteGeneration, GitRemoteViewer, GitRemoteWriteContext, ScopedRemoteCapabilityOn, ScopedRemoteScope } from '../remote/types.ts'
import type { RemoteRepositorySet, RemoteCheckoutReceipt } from '../remote/git.ts'
import type { RemoteComment, RemoteCommit, RemoteIssue, RemotePage, RemotePull, RemoteRepository, RemoteRepositoryFacts, RemoteResult, RemoteNotice, RemoteReview, ScopedRemoteApprovalFacts, ScopedRemoteCommit, ScopedRemoteDiscussion, ScopedRemoteIssue, ScopedRemoteNote, ScopedRemoteNotice, ScopedRemotePull, ScopedRemoteRepositoryFacts } from '../remote/provider.ts'
import { readLoginAttempt, loginFailure } from './remote/login.ts'
import type { RemoteLoginStatus } from './remote/remote-view.ts'

const OFF: GitRemoteCapability = { state: 'off', reason: 'implementation-pending', auth: { state: 'off' } }
const equal = (a: GitRemoteGeneration | undefined, b: GitRemoteGeneration | undefined) => a !== undefined && b !== undefined && a.instanceId === b.instanceId && a.revision === b.revision
/** Upstream pages fetched by the first request of a progressive list; continuations take one page each. */
const FIRST_PAGES = 1
/** Re-entering a view within this window needs no network validation. */
const CACHE_TTL_MS = 60_000
/** Longest reset wait for one automatic stream resume after `git/rate-limited`. */
const STREAM_RESUME_MAX_MS = 600_000
export class RemoteRpcError extends Error {
  constructor(readonly code: string, message: string, readonly details: unknown) { super(message) }
}
type ClientNotice = RemoteNotice & { readonly provider?: 'gitlab' }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const acceptedAction = (value: unknown) => value === true || value === 'unknown'
const removedInstance = (error: ScopedProtocolError | undefined) => error?.details?.['reason'] === 'instance-removed' || error?.details?.['reason'] === 'provider-unavailable'
const invalidProtocol = (error: ScopedProtocolError | undefined) => error !== undefined && ['scope-mismatch', 'generation-missing', 'generation-mismatch', 'invalid-response', 'invalid-facts', 'host-not-negotiated', 'seam-off', 'write-response-lost'].includes(error.reason)
export interface RemoteAuthDesktop {
  openExternal?: (url: string) => Promise<void>
  copyText?: (text: string) => Promise<void>
}

export class GitRemoteFeature {
  private authDesktop: RemoteAuthDesktop | undefined
  setAuthDesktop(desktop: RemoteAuthDesktop | undefined): void {
    this.authDesktop = desktop
    for (const controller of this.controllers.values()) controller.authDesktopChanged()
  }
  get nativeAuthBrowser(): boolean { return this.authDesktop?.openExternal !== undefined }
  async openAuthorization(url: string): Promise<boolean> {
    if (this.owner.signal.aborted || this.authDesktop?.openExternal === undefined) return false
    await this.authDesktop.openExternal(url)
    return true
  }
  async copyUserCode(code: string): Promise<void> {
    if (this.owner.signal.aborted) throw new Error('disposed')
    if (this.authDesktop?.copyText !== undefined) { await this.authDesktop.copyText(code); return }
    if (typeof navigator === 'undefined' || navigator.clipboard?.writeText === undefined) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(code)
  }
  private readonly controllers = new Map<string, GitRemoteController>()
  /** Controllers belong to the feature, so tab unmounts retain data and in-flight pages. */
  controllerFor(sessionId: string, view = 'list'): GitRemoteController {
    const key = JSON.stringify([sessionId, view])
    const existing = this.controllers.get(key)
    if (existing !== undefined) { this.controllers.delete(key); this.controllers.set(key, existing); return existing }
    // Bound retained idle views without evicting mounted or working controllers.
    for (const [oldKey, controller] of this.controllers) {
      if (this.controllers.size < 64) break
      if (controller.idle) { controller.dispose(); this.controllers.delete(oldKey) }
    }
    const controller = new GitRemoteController(this, sessionId, view)
    this.controllers.set(key, controller)
    return controller
  }
  /** Account settings manage sign-in through the same lifecycle without a repository or session. */
  accountControllerFor(scope: ScopedRemoteScope): GitRemoteController {
    const key = JSON.stringify(['account', scope.provider, scope.instance])
    let controller = this.controllers.get(key)
    if (controller === undefined) {
      controller = new GitRemoteController(this, '', `account:${scope.instance}`, scope)
      this.controllers.set(key, controller)
    }
    return controller
  }
  /** One scope's authentication changed; every other controller on it reloads, GitHub also refreshes its global capability. */
  authenticationChanged(scope: ScopedRemoteScope, source: GitRemoteController): void {
    for (const controller of this.controllers.values()) if (controller !== source) controller.accountChanged(scope)
    if (scope.provider === 'github') this.refresh()
  }
  private accountsList: readonly RemoteAccountDescriptor[] | undefined
  private accountsKey = ''
  readonly getAccounts = () => this.accountsList
  loadAccounts(): void {
    if (this.owner.signal.aborted) return
    if (!this.scoped.available) {
      if (this.accountsList === undefined) return
      this.accountsList = undefined
      for (const listener of this.listeners) listener()
      return
    }
    void this.scoped.accounts(this.owner.signal).then(list => {
      if (this.owner.signal.aborted) return
      this.accountsList = list
      for (const listener of this.listeners) listener()
    }, () => {})
  }
  retireGrant(instance: string, signal?: AbortSignal): Promise<{ disposition: 'retired' | 'already-retired' | 'absent' }> { return this.scoped.retire(instance, signal ?? this.owner.signal) }
  invalidate(repository: string | undefined): void {
    for (const controller of this.controllers.values()) {
      if (controller.getSnapshot().repository === repository) controller.invalidate()
    }
  }
  private state = OFF
  private notices: readonly ClientNotice[] = []
  private readonly seen = new Set<string>()
  private notify: ((notice: ClientNotice) => void | Promise<void>) | undefined
  readonly getNotices = () => this.notices
  setNotify(notify: ((notice: ClientNotice) => void | Promise<void>) | undefined): void { this.notify = notify }
  ingest(notices: readonly ClientNotice[]): void {
    if (this.owner.signal.aborted || this.state.state !== 'on') return
    for (const notice of notices) {
      if (this.seen.has(notice.id)) continue
      if (this.seen.size >= 1024) return
      this.seen.add(notice.id); this.notices = [...this.notices.slice(-99), notice]
      try { void Promise.resolve(this.notify?.(notice)).catch(() => {}) } catch { /* Native enhancement never interrupts the portable badge. */ }
    }
    for (const listener of this.listeners) listener()
  }
  private readonly listeners = new Set<() => void>()
  private readonly owner = new AbortController()
  private pending: Promise<void> | undefined
  private refreshAgain = false
  private timer: ReturnType<typeof setInterval> | undefined
  readonly scoped: ScopedRemoteClient
  private readonly pushScoped: ScopedRemoteClient
  constructor(readonly rpc: GitRpcClient) { this.scoped = new ScopedRemoteClient(rpc); this.pushScoped = new ScopedRemoteClient(rpc) }
  readonly getSnapshot = () => this.state
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  start(): void { this.refresh(); this.timer ??= setInterval(() => this.refresh(), 5000) }
  refresh(): void {
    if (this.owner.signal.aborted) return
    if (this.pending !== undefined) { this.refreshAgain = true; return }
    this.pending = (async () => {
      try {
        const reply = await this.rpc.call('/git', 'remote-capability', {}, this.owner.signal)
        if (this.owner.signal.aborted) return
        const cap = reply.ok ? reply.value as GitRemoteCapability : OFF
        this.scoped.observeCapability(cap)
        this.pushScoped.observeCapability(cap)
        if (cap?.state !== 'on' || (this.state.state === 'on' && !equal(cap.generation, this.state.generation))) { this.notices = []; this.seen.clear() }
        this.state = cap?.state === 'on' || cap?.state === 'off' ? cap : OFF
        const accountsKey = this.state.state === 'on' ? `${this.state.generation.instanceId}#${this.state.generation.revision}` : 'off'
        if (accountsKey !== this.accountsKey) { this.accountsKey = accountsKey; this.loadAccounts() }
      } catch { this.scoped.observeCapability(OFF); this.pushScoped.observeCapability(OFF); this.state = OFF; this.loadAccounts() }
      if (!this.owner.signal.aborted) for (const listener of this.listeners) listener()
    })().finally(() => {
      this.pending = undefined
      if (this.refreshAgain) { this.refreshAgain = false; this.refresh() }
    })
  }
  async pushed(repository: string, head: string, sessionId: string, legacyTitle: string, remoteName: 'origin' | 'upstream' | undefined, isCurrent: () => boolean = () => true): Promise<void> {
    if (this.owner.signal.aborted || !isCurrent()) return
    if (!this.pushScoped.available) { this.ingest([{ id: `push/${repository}/${head}`, kind: 'create-pr', title: legacyTitle }]); return }
    if (remoteName === undefined) return
    try {
      const discovered = await this.pushScoped.discover(repository, sessionId, this.owner.signal)
      if (this.owner.signal.aborted || !isCurrent()) return
      const origin = discovered.remotes.find(item => item.name === remoteName)?.identity
      if (origin?.provider === 'github') { this.ingest([{ id: `push/${repository}/${head}`, kind: 'create-pr', title: legacyTitle }]); return }
      if (origin?.provider !== 'gitlab' || !/^[A-Za-z0-9._/-]{1,255}$/u.test(head)) return
      const facts = await this.pushScoped.call<ScopedRemoteRepositoryFacts>('remote-repository', origin.scope, { repository, sessionId, path: origin.path }, this.owner.signal, sessionId)
      if (this.owner.signal.aborted || !isCurrent()) return
      if (facts.value.actionScope.path !== origin.path || facts.value.actionScope.object !== undefined || !/^[1-9][0-9]{0,39}$/u.test(facts.value.actionScope.projectId ?? '') || facts.value.viewer === undefined) return
      const controller = this.controllerFor(sessionId)
      if (controller.getSnapshot().repository !== repository) controller.setRepository(repository)
      controller.receivePush(origin, facts.value.actionScope.projectId!, facts.value.viewer, facts.generation, head)
    } catch { /* A suggestion is optional and never expands an unverified remote. */ }
  }
  dispose(): void {
    this.authDesktop = undefined; this.owner.abort(); clearInterval(this.timer)
    // Dispatch owned attempt cleanup before withdrawing the scoped transport capability.
    for (const controller of this.controllers.values()) controller.dispose()
    this.controllers.clear(); this.scoped.observeCapability(OFF); this.pushScoped.observeCapability(OFF); this.listeners.clear()
  }
}

export type RemotePending = 'repositories' | 'repository' | 'items' | 'detail' | 'auth' | 'authorization' | 'write'
export interface RemoteClientState {
  readonly capability: GitRemoteCapability
  readonly repository?: string | undefined
  readonly remotes: readonly RemoteBoundRemote[]
  readonly unresolved: readonly RemoteUnresolvedRemote[]
  /** Discovery verdict for the workspace remotes; absent until the scoped probe ran. */
  readonly discovery?: 'supported' | 'no-remotes' | 'unsupported' | undefined
  readonly target?: RemoteTarget | undefined
  /** Per-scope capability for scoped targets (GitLab instance auth; GitHub scope mirrors the global one). */
  readonly scopedCapability?: ScopedRemoteCapabilityOn | undefined
  readonly facts?: RemoteRepositoryFacts | ScopedRemoteRepositoryFacts | undefined
  readonly generation?: GitRemoteGeneration | undefined
  readonly items: readonly RemoteItem[]
  readonly listKind?: 'pulls' | 'issues' | undefined
  readonly listState?: 'open' | 'closed' | 'all' | undefined
  /** Opaque list continuation cursor; absent once the list is fully loaded. */
  readonly itemsNext?: string | undefined
  readonly detail?: RemoteItem | undefined
  readonly comments: readonly RemoteCommentView[]
  readonly commentsNext?: string | undefined
  readonly inline: readonly RemoteCommentView[]
  readonly inlineNext?: string | undefined
  readonly commits: readonly RemoteCommitView[]
  readonly commitsNext?: string | undefined
  readonly reviews: readonly RemoteReview[]
  readonly reviewsNext?: string | undefined
  readonly approvals?: ScopedRemoteApprovalFacts | undefined
  /** Scoped read sections that failed non-fatally during the last detail load. */
  readonly unavailable: readonly string[]
  readonly checkout?: RemoteCheckoutReceipt | undefined
  readonly outcome?: RemoteWriteOutcome | undefined
  /** Mutation action that produced `outcome`; drives the transient success notice copy. */
  readonly outcomeAction?: string | undefined
  /** Monotonic sequence bumped per reported outcome; remounts the notice so it replays. */
  readonly outcomeSeq: number
  readonly busy: boolean
  readonly pending?: RemotePending | undefined
  /** True while a background page pull appends to an already-rendered list. */
  readonly streaming: boolean
  /** Set when the background stream stopped on an error or an overlong rate-limit reset. */
  readonly streamError?: string | undefined
  readonly error?: string | undefined
  readonly errorDetails?: Readonly<Record<string, string | number | boolean>> | undefined
  /** v1 write-result-unknown flag; scoped writes gate through `blocked` instead. */
  readonly unknown: boolean
  /** Scoped write reconciliation gate: writes stay locked until the refreshed result is acknowledged. */
  readonly blocked: boolean
  readonly reconciled: boolean
  readonly blockedAction?: string | undefined
  readonly confirmation?: RemoteConfirmation | undefined
  readonly login?: RemoteLoginAttempt | undefined
  readonly loginStatus?: RemoteLoginStatus | undefined
  readonly loginBrowser?: 'opening' | 'opened' | 'manual' | 'failed' | undefined
  readonly loginCopy?: 'copied' | 'failed' | undefined
}

export class GitRemoteController {
  private state: RemoteClientState
  private readonly listeners = new Set<() => void>()
  private readonly notifications = new GitLabNotices()
  private epoch = 0
  private active = new AbortController()
  private disposed = false
  private streamEpoch: number | undefined
  private streamResume: ReturnType<typeof setTimeout> | undefined
  private loginTimeout: ReturnType<typeof setTimeout> | undefined
  private listKind: 'pulls' | 'issues' = 'pulls'
  private listState: 'open' | 'closed' | 'all' = 'open'
  private listAttempt: { key: string; at: number } | undefined
  private authDetail: { number: number; kind: 'pulls' | 'issues' } | undefined
  private detailAttempt: { key: string; at: number } | undefined
  private listValidatedAt = 0
  private readonly lists = new Map<string, { state: RemoteClientState; at: number; collected: readonly unknown[] | undefined }>()
  private readonly collections = new Map<string, readonly unknown[]>()
  private readonly unsubscribe: () => void
  private readonly lane: string
  constructor(private readonly feature: GitRemoteFeature, private readonly sessionId: string, view = 'list', private readonly authScope?: ScopedRemoteScope) {
    this.lane = `${sessionId}:${view}`
    this.state = { capability: feature.getSnapshot(), remotes: [], unresolved: [], items: [], comments: [], inline: [], commits: [], reviews: [], unavailable: [], outcomeSeq: 0, busy: false, streaming: false, unknown: false, blocked: false, reconciled: false }
    this.unsubscribe = feature.subscribe(() => {
      const capability = feature.getSnapshot()
      const gitlab = this.authenticationScope?.provider === 'gitlab'
      if (capability.state === 'off' || (gitlab && !feature.scoped.available) || (!gitlab && this.state.generation !== undefined && capability.state === 'on' && !equal(this.state.generation, capability.generation))) {
        const feedback = this.state.login === undefined ? this.state.loginStatus : undefined
        this.clear(this.state.repository)
        if (capability.state === 'on' && feedback !== undefined && !['requesting', 'waiting', 'verifying'].includes(feedback) && (feedback !== 'connected' || capability.auth.state === 'authenticated')) this.state = { ...this.state, loginStatus: feedback }
      }
      this.patch({ capability })
    })
  }
  private get authenticationScope(): ScopedRemoteScope | undefined { return this.authScope ?? (this.state.target === undefined ? undefined : remoteTargetScope(this.state.target)) }
  readonly getSnapshot = () => this.state
  get idle(): boolean { return this.listeners.size === 0 && !this.state.busy && !this.state.streaming && !this.state.unknown && !this.state.blocked && this.state.login === undefined && this.streamResume === undefined }
  invalidate(): void { this.listAttempt = undefined; this.detailAttempt = undefined; this.lists.clear() }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(value: Partial<RemoteClientState>): void { if (this.disposed) return; this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener() }
  /** Abort in-flight work on this view's lane, stop any pending device login, and drop its server attempt. */
  private cancel(): Promise<void> {
    const target = this.state.target, login = this.state.login
    const scope = this.feature.scoped.available ? this.authenticationScope : undefined
    clearTimeout(this.loginTimeout); this.loginTimeout = undefined
    this.epoch++; this.active.abort(); this.active = new AbortController()
    if (this.streamResume !== undefined) { clearTimeout(this.streamResume); this.streamResume = undefined }
    this.collections.clear()
    this.state = { ...this.state, busy: false, pending: undefined, streaming: false, login: undefined }
    if (scope !== undefined) this.feature.scoped.invalidate(scope, this.lane)
    if (login === undefined) return Promise.resolve()
    if (scope === undefined || scope.provider !== 'gitlab') return this.feature.rpc.call('/git', 'remote-cancel-login', { attemptId: login.attemptId, sessionId: this.sessionId }).then(() => {}, () => {})
    // Cleanup belongs to the original instance and must survive the old UI signal.
    // Its own lane cannot invalidate new reads/login when switching within an instance.
    return this.feature.scoped.call('remote-cancel-login', scope, { attemptId: login.attemptId }, undefined, `${this.lane}:cancel-login`).then(() => {}, () => {})
  }
  private clear(repository?: string): void {
    void this.cancel()
    this.invalidate(); this.notifications.clear()
    this.listValidatedAt = 0
    this.authDetail = undefined
    this.state = { capability: this.feature.getSnapshot(), ...(repository === undefined ? {} : { repository }), remotes: [], unresolved: [], items: [], comments: [], inline: [], commits: [], reviews: [], unavailable: [], outcomeSeq: 0, busy: false, streaming: false, unknown: false, blocked: false, reconciled: false, discovery: undefined }
  }
  setRepository(repository: string | undefined, autoload = true): void { if (repository === this.state.repository) return; this.clear(repository); this.patch({}); if (repository !== undefined && autoload) void this.load() }
  /** Restore a filter immediately, validating stale data while it remains visible. */
  async ensureList(kind = this.listKind, selected = this.state.target, state = this.listState): Promise<void> {
    if (this.state.busy || this.state.login !== undefined || this.state.unknown || this.state.blocked || this.state.repository === undefined || this.state.capability.state !== 'on') return
    const key = this.listKey(kind, selected, state)
    if (this.listAttempt?.key === key && (this.state.streaming || Date.now() - this.listAttempt.at < CACHE_TTL_MS)) return
    const cached = this.lists.get(key)
    if (cached !== undefined) {
      this.stopStream()
      this.listKind = kind; this.listState = state
      this.listValidatedAt = cached.at
      if (cached.state.itemsNext !== undefined) this.collections.set('items', cached.collected ?? cached.state.items)
      this.patch({ ...cached.state, capability: this.feature.getSnapshot(), busy: false, pending: undefined, streaming: false })
      this.listAttempt = { key, at: cached.at }
      if (Date.now() - cached.at < CACHE_TTL_MS) { this.stream(this.epoch); return }
    }
    await this.load(kind, selected, state)
  }
  async ensureOpen(n: number, kind: 'pulls' | 'issues', revision: number): Promise<void> {
    if (this.state.unknown || this.state.blocked) return
    const key = `${kind}/${n}:${revision}`
    if (this.detailAttempt?.key === key && Date.now() - this.detailAttempt.at < CACHE_TTL_MS) return
    if (this.state.busy || this.state.login !== undefined) return
    this.detailAttempt = { key, at: Date.now() }
    await this.open(n, kind)
  }
  private listKey(kind: string, target: RemoteTarget | undefined, state: string): string {
    if (target?.provider === 'gitlab') return JSON.stringify(['gitlab', target.instance, target.path, kind, state])
    return JSON.stringify([target?.provider, target !== undefined && target.provider === 'github' ? target.host : undefined, target !== undefined && target.provider === 'github' ? target.owner.toLowerCase() : undefined, target !== undefined && target.provider === 'github' ? target.repo.toLowerCase() : undefined, kind, state])
  }
  private rememberList(): void {
    if (this.state.listKind === undefined || this.state.detail !== undefined || this.listAttempt === undefined) return
    const key = this.listKey(this.listKind, this.state.target, this.listState)
    if (this.lists.size >= 12) this.lists.delete(this.lists.keys().next().value ?? '')
    this.lists.set(key, { state: this.state, at: this.listValidatedAt, collected: this.collections.get('items') })
  }
  private stopStream(): void {
    this.epoch += 1; this.active.abort(); this.active = new AbortController()
    if (this.streamResume !== undefined) { clearTimeout(this.streamResume); this.streamResume = undefined }
    this.collections.clear()
    this.patch({ streaming: false })
  }
  /** Keep old rows during validation; remove missing rows only after the final page. */
  private page<T>(name: string, current: readonly T[], page: RemotePage<T>, key: (item: T) => string | number, first = false): readonly T[] {
    const accumulated = appendUnique(first ? [] : (this.collections.get(name) ?? []) as readonly T[], page.items, key)
    if (page.next === undefined) this.collections.delete(name)
    else this.collections.set(name, accumulated)
    const ids = new Set(accumulated.map(key))
    return reconcile(current, page.next === undefined ? accumulated : [...accumulated, ...current.filter(item => !ids.has(key(item)))], key)
  }
  private async call<T>(endpoint: string, payload: Record<string, unknown> = {}, signal = this.active.signal): Promise<T> {
    const reply = await this.feature.rpc.call('/git', endpoint, { ...payload, ...(this.state.repository === undefined ? {} : { repository: this.state.repository }), ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }) }, signal)
    if (!reply.ok) { const error = reply.error as { code?: string; message?: string; details?: unknown }; throw new RemoteRpcError(error.code ?? 'git/remote-unavailable', error.message ?? 'Git remote request failed', error.details) }
    return reply.value as T
  }
  /** Scoped business call bound to the current target, repository and view lane. */
  private async scopedCall<T>(endpoint: string, payload: Record<string, unknown>, epoch: number, expected?: GitRemoteGeneration): Promise<{ generation: GitRemoteGeneration; value: T }> {
    const target = this.state.target, repository = this.state.repository
    if (this.authScope !== undefined) {
      // A pinned account controller owns no repository; it may only reach authentication endpoints.
      if (!['remote-account', 'remote-capability', 'remote-select-auth', 'remote-oauth-logout', 'remote-retry-auth', 'remote-login', 'remote-poll-login', 'remote-cancel-login', 'remote-sign-out', 'remote-clear-grant'].includes(endpoint)) throw new ScopedProtocolError('invalid-target')
      const response = await this.feature.scoped.call<T>(endpoint, this.authScope, payload, this.active.signal, this.lane)
      if (epoch !== this.epoch || this.disposed) throw new ScopedProtocolError('stale-response')
      return response
    }
    if (target === undefined || repository === undefined) throw new ScopedProtocolError('invalid-target')
    const identity: Record<string, unknown> = target.provider === 'gitlab'
      ? { path: target.path, ...(target.projectId === undefined ? {} : { projectId: target.projectId }) }
      : { owner: target.owner, repo: target.repo }
    const response = await this.feature.scoped.call<T>(endpoint, remoteTargetScope(target), { ...payload, repository, sessionId: this.sessionId, ...identity }, this.active.signal, this.lane)
    if (epoch !== this.epoch || this.disposed) throw new ScopedProtocolError('stale-response')
    if (expected !== undefined && !equal(expected, response.generation)) { this.patch({ confirmation: undefined, facts: undefined }); throw new ScopedProtocolError('stale-generation') }
    return response
  }
  private async run(work: (epoch: number) => Promise<void>, pending?: RemotePending, allowBlocked = false): Promise<void> {
    if (this.disposed || this.state.busy || (!allowBlocked && this.state.blocked)) return
    const epoch = this.epoch; this.patch({ busy: true, ...(pending === undefined ? {} : { pending }), ...(this.state.blocked ? {} : { error: undefined, errorDetails: undefined }) })
    try { await work(epoch) } catch (error) {
      if (epoch === this.epoch && !this.disposed) {
        if (error instanceof ScopedProtocolError) {
          const scoped = error
          const changedIdentity = scoped.code === 'git/remote-identity-mismatch' || scoped.code === 'git/unauthenticated' || scoped.code === 'git/signed-out' || scoped.reason === 'stale-generation' || removedInstance(scoped)
          const invalidScope = invalidProtocol(scoped)
          if ((changedIdentity || invalidScope) && this.state.target?.provider === 'gitlab') this.notifications.clearInstance(this.state.target.scope.instance)
          const details = this.state.blocked && !changedIdentity ? { ...this.state.errorDetails, ...scoped.details } : scoped.details
          const blocked = changedIdentity ? false : this.state.blocked || scoped.code === 'git/write-result-unknown'
          const keepReconciliationTarget = invalidScope && blocked && !changedIdentity
          const recoverAuth = this.state.target?.provider === 'gitlab' && (scoped.code === 'git/signed-out' || scoped.code === 'git/unauthenticated')
          if (changedIdentity || invalidScope) void this.cancel()
          this.patch({ error: scoped.code ?? scoped.reason ?? 'git/remote-unavailable', errorDetails: details, blocked, blockedAction: changedIdentity ? undefined : scoped.code === 'git/write-result-unknown' ? String(scoped.details?.['action'] ?? 'unknown') : this.state.blockedAction, reconciled: false, confirmation: undefined, ...((changedIdentity || invalidScope) ? { facts: undefined, scopedCapability: undefined, detail: keepReconciliationTarget ? this.state.detail : undefined, generation: undefined, items: [], itemsNext: undefined, comments: [], commentsNext: undefined, inline: [], inlineNext: undefined, commits: [], commitsNext: undefined, reviews: [], reviewsNext: undefined, approvals: undefined, unavailable: [] } : {}) })
          if (recoverAuth) {
            // Authentication metadata remains readable after protected repository reads fail.
            // Use the new lane after cancellation, never the failed request's generation.
            const recoveryEpoch = this.epoch
            this.patch({ busy: true, pending: 'auth' })
            try {
              const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, recoveryEpoch)
              if (cap.value.state === 'on' && cap.value.auth !== undefined) this.patch({ scopedCapability: cap.value, generation: cap.generation,
                ...(scoped.code === 'git/signed-out' && cap.value.auth.state === 'signed-out' ? { error: undefined, errorDetails: undefined } : {}) })
            } catch { /* Keep the original error; explicit authentication can retry metadata discovery. */ }
            finally { if (recoveryEpoch === this.epoch) { this.patch({ busy: false, pending: undefined }); this.feature.refresh() } }
          }
        } else {
          this.patch({ error: error instanceof Error ? error.message : String(error), errorDetails: undefined, unknown: error instanceof RemoteRpcError && error.code === 'git/write-result-unknown' || this.state.unknown })
        }
      }
    } finally { if (epoch === this.epoch) { this.patch({ busy: false, pending: undefined }); this.feature.refresh() } }
  }
  async load(kind: 'pulls' | 'issues' = 'pulls', selected?: RemoteTarget, state: 'open' | 'closed' | 'all' = 'open'): Promise<void> {
    if (this.disposed || this.state.busy || this.state.blocked) return
    this.rememberList()
    if (this.feature.scoped.available) void this.cancel()
    else this.stopStream()
    this.listAttempt = { key: this.listKey(kind, selected ?? this.state.target, state), at: Date.now() }
    await this.run(async epoch => {
      if (this.feature.scoped.available) await this.loadScoped(epoch, kind, selected, state)
      else await this.loadV1(epoch, kind, selected as RemoteRepository | undefined, state)
    }, 'repositories', true)
  }
  private async loadV1(epoch: number, kind: 'pulls' | 'issues', selected: RemoteRepository | undefined, state: 'open' | 'closed' | 'all'): Promise<void> {
    const repositories = await this.call<RemoteRepositorySet>('remote-repositories')
    const target = selected ?? this.state.target as RemoteRepository | undefined ?? repositories.remotes[0]?.identity
    if (epoch !== this.epoch) return
    this.patch({ remotes: repositories.remotes, unresolved: [], discovery: undefined, pending: 'repository' })
    if (target === undefined) return
    const facts = await this.call<RemoteResult<RemoteRepositoryFacts>>('remote-repository', target as unknown as Record<string, unknown>)
    if (epoch !== this.epoch) return
    this.patch({ pending: 'items' })
    const list = await this.call<RemoteResult<RemotePage<RemotePull | RemoteIssue>>>(kind === 'pulls' ? 'remote-list-prs' : 'remote-list-issues', { ...target, state, pages: FIRST_PAGES })
    if (epoch !== this.epoch || !equal(facts.generation, list.generation)) return
    this.listKind = kind; this.listState = state
    this.listAttempt = { key: this.listKey(kind, target, state), at: Date.now() }
    this.listValidatedAt = Date.now()
    const sameList = this.state.listKind === kind && this.state.listState === state && this.listKey(kind, this.state.target, state) === this.listKey(kind, target, state)
    this.patch({ target, generation: facts.generation, facts: facts.value, scopedCapability: undefined, listKind: kind, listState: state, items: this.page('items', sameList ? this.state.items : [], list.value, item => item.number, true), itemsNext: list.value.next, detail: undefined, comments: [], commentsNext: undefined, inline: [], inlineNext: undefined, commits: [], commitsNext: undefined, reviews: [], reviewsNext: undefined, approvals: undefined, unavailable: [], outcome: undefined, confirmation: undefined, streamError: undefined, unknown: false })
    this.rememberList()
    this.stream(epoch)
  }
  private async loadScoped(epoch: number, kind: 'pulls' | 'issues', selected: RemoteTarget | undefined, state: 'open' | 'closed' | 'all'): Promise<void> {
    const discovered = await this.feature.scoped.discover(this.state.repository!, this.sessionId, this.active.signal, this.lane)
    if (epoch !== this.epoch) return
    const remotes: readonly RemoteBoundRemote[] = discovered.remotes
    const unresolved: readonly RemoteUnresolvedRemote[] = discovered.unresolved ?? []
    const wanted = selected ?? this.state.target
    let target = wanted === undefined ? undefined : remotes.find(remote => sameRemoteTarget(remote.identity, wanted))?.identity
    if (wanted !== undefined && target === undefined) {
      if (selected !== undefined) throw new ScopedProtocolError('remote-not-bound')
      target = remotes[0]?.identity
    }
    target ??= remotes[0]?.identity
    // Rows and cursors belong to the previous target, even before the new list resolves.
    if (!sameRemoteTarget(this.state.target, target) || this.state.target === undefined) this.patch({ remotes, unresolved, discovery: discovered.state, target, generation: undefined, listKind: undefined, listState: undefined, items: [], itemsNext: undefined, detail: undefined, comments: [], commentsNext: undefined, inline: [], inlineNext: undefined, commits: [], commitsNext: undefined, reviews: [], reviewsNext: undefined, approvals: undefined, unavailable: [], facts: undefined, scopedCapability: undefined, outcome: undefined, confirmation: undefined, streamError: undefined, pending: 'repository' })
    else this.patch({ remotes, unresolved, discovery: discovered.state, pending: 'repository' })
    if (target === undefined) return
    await this.loadListScoped(epoch, kind, state)
  }
  private async loadListScoped(epoch: number, kind: 'pulls' | 'issues', filter: 'open' | 'closed' | 'all', reconcile = false): Promise<void> {
    const initialCapability = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
    this.patch({ scopedCapability: initialCapability.value, generation: initialCapability.generation })
    if (initialCapability.value.auth.state === 'signed-out') {
      this.patch({ facts: undefined, detail: undefined, items: [], itemsNext: undefined, comments: [], commentsNext: undefined, inline: [], inlineNext: undefined,
        commits: [], commitsNext: undefined, reviews: [], reviewsNext: undefined, approvals: undefined, unavailable: [], confirmation: undefined, error: undefined, errorDetails: undefined })
      return
    }
    const facts = await this.scopedCall<ScopedRemoteRepositoryFacts>('remote-repository', {}, epoch)
    this.validateFacts(facts.value)
    const rawTarget = this.state.target!
    const resolvedProjectId = facts.value.actionScope.projectId
    const target: RemoteTarget = rawTarget.provider === 'gitlab' && resolvedProjectId !== undefined && rawTarget.projectId !== resolvedProjectId ? { ...rawTarget, projectId: resolvedProjectId } : rawTarget
    this.patch({ target, generation: facts.generation, facts: facts.value, pending: 'items' })
    if (target.provider === 'gitlab') {
      const projectId = facts.value.actionScope.projectId, viewer = facts.value.viewer
      if (projectId === undefined || viewer === undefined) this.notifications.deactivate()
      else this.notifications.activate({ instance: target.scope.instance, projectId, viewer, generation: facts.generation })
    }
    const result = await this.scopedCall<RemotePage<RemoteItem>>(kind === 'pulls' ? 'remote-list-prs' : 'remote-list-issues', { state: filter, pages: FIRST_PAGES }, epoch, facts.generation)
    const capability = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch, facts.generation)
    const list = strictPage<RemoteItem>(result.value)
    if (target.provider === 'gitlab') for (const item of list.items) if ('head' in item) this.observePull(item as ScopedRemotePull)
    this.listKind = kind; this.listState = filter
    this.listAttempt = { key: this.listKey(kind, target, filter), at: Date.now() }
    this.listValidatedAt = Date.now()
    const sameList = this.state.listKind === kind && this.state.listState === filter && this.listKey(kind, this.state.target, filter) === this.listKey(kind, target, filter)
    this.patch({ generation: facts.generation, scopedCapability: capability.value, listKind: kind, listState: filter, items: this.page('items', sameList ? this.state.items : [], list, item => item.number, true), itemsNext: list.next, detail: undefined, comments: [], commentsNext: undefined, inline: [], inlineNext: undefined, commits: [], commitsNext: undefined, reviews: [], reviewsNext: undefined, approvals: undefined, unavailable: [], outcome: undefined, confirmation: undefined, streamError: undefined, unknown: false, ...(reconcile && this.state.blocked ? { reconciled: list.next === undefined } : { blocked: false, reconciled: false, blockedAction: undefined, error: undefined, errorDetails: undefined }) })
    this.rememberList()
    this.stream(epoch)
  }
  async open(n: number, kind: 'pulls' | 'issues', reconcile = false): Promise<void> {
    if (this.disposed || this.state.busy || !Number.isSafeInteger(n) || n < 1) return
    if (this.feature.scoped.available) { void this.cancel(); this.patch({ confirmation: undefined }) }
    else this.stopStream()
    await this.run(async epoch => {
      if (this.feature.scoped.available) await this.openScoped(epoch, n, kind, reconcile)
      else await this.openV1(epoch, n, kind)
    }, 'detail', reconcile)
  }
  private async openV1(epoch: number, n: number, kind: 'pulls' | 'issues'): Promise<void> {
    const target = this.state.target as RemoteRepository | undefined; if (target === undefined) return
    const detail = await this.call<RemoteResult<RemotePull | RemoteIssue>>(kind === 'pulls' ? 'remote-pr' : 'remote-issue', { ...target, number: n })
    const comments = await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number: n, pages: FIRST_PAGES })
    const inline = kind === 'pulls' ? await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number: n, inline: true, pages: FIRST_PAGES }) : undefined
    const commits = kind === 'pulls' ? await this.call<RemoteResult<RemotePage<RemoteCommit>>>('remote-commits', { ...target, number: n, pages: FIRST_PAGES }) : undefined
    const reviews = kind === 'pulls' ? await this.call<RemoteResult<RemotePage<RemoteReview>>>('remote-reviews', { ...target, number: n, pages: FIRST_PAGES }) : undefined
    if (epoch !== this.epoch || !equal(detail.generation, comments.generation) || (inline !== undefined && !equal(detail.generation, inline.generation)) || (commits !== undefined && !equal(detail.generation, commits.generation)) || (reviews !== undefined && !equal(detail.generation, reviews.generation))) return
    const sameDetail = this.state.detail?.number === n && ('head' in this.state.detail) === (kind === 'pulls')
    const v1Facts = this.state.facts as RemoteRepositoryFacts | undefined
    this.patch({ facts: v1Facts === undefined ? undefined : { ...v1Facts, actions: { ...v1Facts.actions, canClose: detail.value.author?.userId === v1Facts.viewer?.userId || v1Facts.permissions.push === true ? true : v1Facts.permissions.push === false ? false : 'unknown' } }, itemsNext: undefined, detail: detail.value, generation: detail.generation, comments: this.page('comments', sameDetail ? this.state.comments : [], comments.value, entry => entry.id, true), commentsNext: comments.value.next, inline: inline === undefined ? [] : this.page('inline', sameDetail ? this.state.inline : [], inline.value, entry => entry.id, true), inlineNext: inline?.value.next, commits: commits === undefined ? [] : this.page('commits', sameDetail ? this.state.commits : [], commits.value, entry => entry.sha, true), commitsNext: commits?.value.next, reviews: reviews === undefined ? [] : this.page('reviews', sameDetail ? this.state.reviews : [], reviews.value, entry => entry.id, true), reviewsNext: reviews?.value.next, unavailable: [], outcome: undefined, streamError: undefined, unknown: false })
    this.stream(epoch)
  }
  private async openScoped(epoch: number, n: number, kind: 'pulls' | 'issues', reconcile: boolean): Promise<void> {
    const previous = this.state.generation
    const detail = await this.scopedCall<RemoteItem>(kind === 'pulls' ? 'remote-pr' : 'remote-issue', { number: n }, epoch, previous)
    if (detail.value.number !== n) throw new ScopedProtocolError('invalid-response')
    const target = this.state.target!
    const gitlab = target.provider === 'gitlab'
    if (gitlab && 'head' in detail.value) this.observePull(detail.value as ScopedRemotePull)
    const object = { kind: kind === 'pulls' ? 'pull' as const : 'issue' as const, number: n }
    const facts = await this.scopedCall<ScopedRemoteRepositoryFacts>('remote-repository', { object }, epoch, detail.generation)
    this.validateFacts(facts.value, object)
    const sameDetail = this.state.detail?.number === n && ('head' in this.state.detail) === (kind === 'pulls')
    if (!gitlab) {
      const comments = await this.scopedCall<RemotePage<RemoteComment>>('remote-comments', { number: n, pages: FIRST_PAGES }, epoch, detail.generation)
      const inline = kind === 'pulls' ? await this.scopedCall<RemotePage<RemoteComment>>('remote-comments', { number: n, inline: true, pages: FIRST_PAGES }, epoch, detail.generation) : undefined
      const commits = kind === 'pulls' ? await this.scopedCall<RemotePage<RemoteCommit>>('remote-commits', { number: n, pages: FIRST_PAGES }, epoch, detail.generation) : undefined
      const reviews = kind === 'pulls' ? await this.scopedCall<RemotePage<RemoteReview>>('remote-reviews', { number: n, pages: FIRST_PAGES }, epoch, detail.generation) : undefined
      const needsReconcile = this.state.blocked && reconcile
      this.patch({ facts: facts.value, itemsNext: undefined, detail: detail.value, generation: detail.generation, comments: this.page('comments', sameDetail ? this.state.comments : [], strictPage(comments.value), entry => entry.id, true), commentsNext: strictPage(comments.value).next, inline: inline === undefined ? [] : this.page('inline', sameDetail ? this.state.inline : [], strictPage(inline.value), entry => entry.id, true), inlineNext: inline === undefined ? undefined : strictPage(inline.value).next, commits: commits === undefined ? [] : this.page('commits', sameDetail ? this.state.commits : [], strictPage(commits.value), entry => entry.sha, true), commitsNext: commits === undefined ? undefined : strictPage(commits.value).next, reviews: reviews === undefined ? [] : this.page('reviews', sameDetail ? this.state.reviews : [], strictPage(reviews.value), entry => entry.id, true), reviewsNext: reviews === undefined ? undefined : strictPage(reviews.value).next, approvals: undefined, unavailable: [], outcome: undefined, confirmation: undefined, streamError: undefined, unknown: false, ...(needsReconcile ? { reconciled: true } : {}) })
      this.stream(epoch)
      return
    }
    const unavailable: string[] = []
    const optional = async <T,>(name: string, endpoint: string, payload: Record<string, unknown>): Promise<T | undefined> => {
      try { return (await this.scopedCall<T>(endpoint, payload, epoch, detail.generation)).value } catch (error) {
        if (error instanceof ScopedProtocolError && (error.reason === 'stale-response' || error.reason === 'stale-generation' || invalidProtocol(error) || error.code === 'git/remote-identity-mismatch' || error.code === 'git/unauthenticated' || error.code === 'git/signed-out' || removedInstance(error))) throw error
        unavailable.push(name); return undefined
      }
    }
    const commentsRaw = await optional<RemotePage<ScopedRemoteNote>>('comments', 'remote-comments', { number: n, objectKind: object.kind, pages: FIRST_PAGES })
    const discussionsRaw = await optional<RemotePage<ScopedRemoteDiscussion>>('discussions', 'remote-discussions', { number: n, objectKind: object.kind, pages: FIRST_PAGES })
    const commitsRaw = kind === 'pulls' ? await optional<RemotePage<ScopedRemoteCommit>>('commits', 'remote-commits', { number: n, pages: FIRST_PAGES }) : undefined
    const approvals = kind === 'pulls' ? await optional<ScopedRemoteApprovalFacts>('approvals', 'remote-approvals', { number: n }) : undefined
    const comments = commentsRaw === undefined ? undefined : strictPage<ScopedRemoteNote>(commentsRaw)
    const discussions = discussionsRaw === undefined ? undefined : strictPage<ScopedRemoteDiscussion>(discussionsRaw)
    const commits = commitsRaw === undefined ? undefined : strictPage<ScopedRemoteCommit>(commitsRaw)
    const needsComments = this.state.blockedAction === 'comment' || this.state.blockedAction === 'remote-comment' || this.state.blockedAction === 'review' || this.state.blockedAction === 'remote-review'
    const needsApprovals = this.state.blockedAction === 'review' || this.state.blockedAction === 'approve' || this.state.blockedAction === 'remote-review'
    const reconciled = (!needsComments || comments !== undefined && comments.next === undefined) && (!needsApprovals || approvals !== undefined)
    const commentViews = comments === undefined ? undefined : { items: comments.items.map(projectGitLabNote), truncated: comments.truncated, ...(comments.next === undefined ? {} : { next: comments.next }) }
    const inlineViews = discussions === undefined ? undefined : { items: discussions.items.flatMap(projectGitLabDiscussion), truncated: discussions.truncated, ...(discussions.next === undefined ? {} : { next: discussions.next }) }
    this.patch({ listKind: kind, detail: detail.value, facts: facts.value, generation: detail.generation, itemsNext: undefined, comments: commentViews === undefined ? [] : this.page('comments', sameDetail ? this.state.comments : [], commentViews, entry => entry.id, true), commentsNext: commentViews?.next, inline: inlineViews === undefined ? [] : this.page('inline', sameDetail ? this.state.inline : [], inlineViews, entry => entry.id, true), inlineNext: inlineViews?.next, commits: commits === undefined ? [] : this.page('commits', sameDetail ? this.state.commits : [], commits, entry => entry.sha, true), commitsNext: commits?.next, reviews: [], reviewsNext: undefined, approvals, unavailable, confirmation: undefined, streamError: undefined, unknown: false, ...(reconcile && this.state.blocked ? { reconciled } : {}) })
    this.stream(epoch)
  }
  /** Fetch one continuation page on whichever wire the current target uses. */
  private async fetchPage<T>(endpoint: string, payload: Record<string, unknown>, epoch: number, generation: GitRemoteGeneration): Promise<RemotePage<T> | undefined> {
    const target = this.state.target
    if (target !== undefined && this.feature.scoped.available) return strictPage<T>((await this.scopedCall<RemotePage<T>>(endpoint, payload, epoch, generation)).value)
    if (target === undefined) return undefined
    const result = await this.call<RemoteResult<RemotePage<T>>>(endpoint, { ...(target as unknown as Record<string, unknown>), ...payload })
    return equal(generation, result.generation) ? result.value : undefined
  }
  /** Continue any pending page cursor in the background, one upstream page per call. */
  private stream(epoch: number): void {
    if (this.disposed || this.streamEpoch === epoch || this.active.signal.aborted) return
    this.streamEpoch = epoch
    void this.streamLoop(epoch).then(drained => {
      if (this.streamEpoch !== epoch) return
      this.streamEpoch = undefined
      // A kick landing between the loop's last cursor check and this teardown is honored now.
      if (drained && epoch === this.epoch && this.hasPendingCursor()) this.stream(epoch)
    })
  }
  private hasPendingCursor(): boolean {
    const s = this.state
    return s.itemsNext !== undefined || s.commentsNext !== undefined || s.inlineNext !== undefined || s.commitsNext !== undefined || s.reviewsNext !== undefined
  }
  /** @returns `true` only when the loop drained every cursor; errors and superseded state return `false`. */
  private async streamLoop(epoch: number): Promise<boolean> {
    this.patch({ streaming: true, streamError: undefined })
    try {
      for (;;) {
        if (this.disposed || epoch !== this.epoch || this.active.signal.aborted) return false
        const s = this.state
        const target = s.target
        const generation = s.generation
        if (target === undefined || generation === undefined) return false
        const gitlab = target.provider === 'gitlab'
        if (s.itemsNext !== undefined) {
          const cursor = s.itemsNext
          const page = await this.fetchPage<RemoteItem>(this.listKind === 'issues' ? 'remote-list-issues' : 'remote-list-prs', { state: this.listState, cursor }, epoch, generation)
          if (page === undefined || epoch !== this.epoch) return false
          if (this.state.itemsNext !== cursor) continue
          if (gitlab) for (const item of page.items) if ('head' in item) this.observePull(item as ScopedRemotePull)
          this.patch({ items: this.page('items', this.state.items, page, item => item.number), itemsNext: page.next, ...(this.state.blocked && this.state.blockedAction === 'create-pr' && page.next === undefined ? { reconciled: true } : {}) }); this.rememberList()
          continue
        }
        const number = s.detail?.number
        const objectKind = s.detail !== undefined && 'head' in s.detail ? 'pull' : 'issue'
        if (s.commentsNext !== undefined && number !== undefined) {
          const cursor = s.commentsNext
          const page = gitlab
            ? await this.fetchPage<ScopedRemoteNote>('remote-comments', { number, objectKind, cursor }, epoch, generation)
            : await this.fetchPage<RemoteComment>('remote-comments', { number, cursor }, epoch, generation)
          if (page === undefined || epoch !== this.epoch) return false
          if (this.state.commentsNext !== cursor) continue
          const items = gitlab ? (page.items as readonly ScopedRemoteNote[]).map(projectGitLabNote) : page.items as readonly RemoteCommentView[]
          const reviewBlocked = this.state.blockedAction === 'review' || this.state.blockedAction === 'remote-review'
          const commentBlocked = reviewBlocked || this.state.blockedAction === 'comment' || this.state.blockedAction === 'remote-comment'
          this.patch({ comments: this.page('comments', this.state.comments, { ...page, items }, item => item.id), commentsNext: page.next, ...(this.state.blocked && commentBlocked && page.next === undefined && (!reviewBlocked || this.state.approvals !== undefined) ? { reconciled: true } : {}) })
          continue
        }
        if (s.inlineNext !== undefined && number !== undefined) {
          const cursor = s.inlineNext
          if (gitlab) {
            const page = await this.fetchPage<ScopedRemoteDiscussion>('remote-discussions', { number, objectKind, cursor }, epoch, generation)
            if (page === undefined || epoch !== this.epoch) return false
            if (this.state.inlineNext !== cursor) continue
            const items = page.items.flatMap(projectGitLabDiscussion)
            this.patch({ inline: this.page('inline', this.state.inline, { ...page, items }, item => item.id), inlineNext: page.next })
          } else {
            const page = await this.fetchPage<RemoteComment>('remote-comments', { number, inline: true, cursor }, epoch, generation)
            if (page === undefined || epoch !== this.epoch) return false
            if (this.state.inlineNext !== cursor) continue
            this.patch({ inline: this.page('inline', this.state.inline, page, item => item.id), inlineNext: page.next })
          }
          continue
        }
        if (s.commitsNext !== undefined && number !== undefined) {
          const cursor = s.commitsNext
          const page = await this.fetchPage<RemoteCommit | ScopedRemoteCommit>('remote-commits', { number, cursor }, epoch, generation)
          if (page === undefined || epoch !== this.epoch) return false
          if (this.state.commitsNext !== cursor) continue
          this.patch({ commits: this.page('commits', this.state.commits, page, item => item.sha), commitsNext: page.next })
          continue
        }
        if (s.reviewsNext !== undefined && number !== undefined) {
          const cursor = s.reviewsNext
          const page = await this.fetchPage<RemoteReview>('remote-reviews', { number, cursor }, epoch, generation)
          if (page === undefined || epoch !== this.epoch) return false
          if (this.state.reviewsNext !== cursor) continue
          this.patch({ reviews: this.page('reviews', this.state.reviews, page, item => item.id), reviewsNext: page.next })
          continue
        }
        return true
      }
    } catch (error) {
      if (this.disposed || epoch !== this.epoch || this.active.signal.aborted) return false
      this.patch({ streamError: error instanceof Error ? error.message : String(error) })
      if (error instanceof RemoteRpcError && error.code === 'git/rate-limited' || error instanceof ScopedProtocolError && error.code === 'git/rate-limited') {
        const resetAt = (error instanceof RemoteRpcError ? error.details as { resetAt?: unknown } | undefined : error.details)?.resetAt
        const delay = typeof resetAt === 'number' ? resetAt - Date.now() : Number.NaN
        if (Number.isFinite(delay) && delay > 0 && delay <= STREAM_RESUME_MAX_MS) {
          this.streamResume = setTimeout(() => { this.streamResume = undefined; this.stream(epoch) }, delay)
        }
      }
      return false
    } finally {
      if (!this.disposed && epoch === this.epoch) this.patch({ streaming: false })
    }
  }
  async pollNotices(): Promise<void> {
    const { target, generation, capability } = this.state
    // Continuation pages share this view's scoped lane; polling would invalidate their replies.
    if (this.disposed || this.state.busy || this.state.streaming || this.state.login !== undefined || target === undefined || generation === undefined || capability.state !== 'on') return
    if (target.provider === 'gitlab') {
      if (this.state.blocked) return
      await this.run(async epoch => {
        const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
        if (this.state.generation !== undefined && !equal(this.state.generation, cap.generation)) {
          this.notifications.clearInstance(target.scope.instance)
          void this.cancel()
          this.patch({ scopedCapability: cap.value, generation: cap.generation, facts: undefined, detail: undefined, items: [], itemsNext: undefined, comments: [], commentsNext: undefined, inline: [], inlineNext: undefined, commits: [], commitsNext: undefined, approvals: undefined, confirmation: undefined, blocked: false, reconciled: false, blockedAction: undefined, error: 'identity-changed' })
          return
        }
        this.patch({ scopedCapability: cap.value })
        if (cap.value.auth.state === 'authenticated') await this.pollGitLabNotifications(epoch, cap.generation)
      }, undefined, true)
      return
    }
    if (capability.auth.state !== 'authenticated') return
    const epoch = this.epoch
    try {
      const result = await this.fetchPage<RemoteNotice>('remote-notifications', { automatic: true }, epoch, generation)
      if (epoch === this.epoch && result !== undefined) this.feature.ingest(result.items)
    } catch { /* Shared Host budgets decide when polling can resume. */ }
  }
  private publishNotice(notice: ScopedRemoteNotice): void {
    if (!this.notifications.add(notice)) return
    this.feature.ingest([{ id: `gitlab/${this.state.target === undefined ? '' : remoteTargetScope(this.state.target).instance}/${notice.projectId}/${notice.id}:${notice.state}:${notice.updatedAt ?? ''}`, kind: notice.kind, title: notice.title, provider: 'gitlab', ...(notice.url === undefined ? {} : { url: notice.url }) }])
  }
  receivePush(target: RemoteTarget & { provider: 'gitlab' }, projectId: string, viewer: GitRemoteViewer, generation: GitRemoteGeneration, head: string): void {
    if (this.disposed || this.state.repository === undefined) return
    const current = this.state.target, facts = this.state.facts, oldGeneration = this.state.generation
    let previous = current?.provider === 'gitlab' && current.projectId !== undefined && facts?.viewer !== undefined && oldGeneration !== undefined ? { instance: current.scope.instance, projectId: current.projectId, viewer: facts.viewer, generation: oldGeneration } : undefined
    if (previous !== undefined && previous.instance === target.scope.instance && (previous.viewer.host !== viewer.host || previous.viewer.userId !== viewer.userId || !equal(previous.generation, generation))) {
      this.notifications.clearInstance(target.scope.instance); void this.cancel(); this.patch({ facts: undefined, detail: undefined, generation: undefined, items: [], confirmation: undefined, error: 'identity-changed' }); return
    }
    this.notifications.activate({ instance: target.scope.instance, projectId, viewer, generation })
    const notice: ScopedRemoteNotice = { id: `push:${head}`, projectId, objectId: head, number: 0, kind: 'create-pr', title: head, state: 'pushed' }
    if (this.notifications.add(notice)) this.feature.ingest([{ id: `gitlab/${target.scope.instance}/${projectId}/${notice.id}:${notice.state}`, kind: notice.kind, title: notice.title, provider: 'gitlab' }])
    if (previous !== undefined) this.notifications.activate(previous)
    else this.notifications.deactivate()
  }
  private observePull(pull: ScopedRemotePull): void {
    const notice = this.notifications.observe(pull)
    if (notice !== undefined) this.publishNotice(notice)
  }
  private async pollGitLabNotifications(epoch: number, generation: GitRemoteGeneration): Promise<void> {
    const target = this.state.target, viewer = this.state.facts?.viewer
    if (target?.provider !== 'gitlab' || target.projectId === undefined || viewer === undefined || this.state.blocked) return
    try {
      const result = await this.scopedCall<RemotePage<ScopedRemoteNotice>>('remote-notifications', { automatic: true, pages: 1, ...(this.notifications.cursor === undefined ? {} : { cursor: this.notifications.cursor }) }, epoch, generation)
      const list = strictPage<ScopedRemoteNotice>(result.value)
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
      const result = await this.scopedCall<ScopedRemotePull>('remote-pr', { number: tracked.number, automatic: true }, epoch, generation)
      if (result.value.id === tracked.id && result.value.number === tracked.number) this.observePull(result.value)
    } catch (error) {
      if (error instanceof ScopedProtocolError && (error.reason === 'stale-response' || error.reason === 'stale-generation' || invalidProtocol(error) || error.code === 'git/remote-identity-mismatch' || error.code === 'git/unauthenticated' || error.code === 'git/signed-out' || removedInstance(error))) throw error
    }
  }
  get scopedAvailable(): boolean { return this.feature.scoped.available }
  /** Non-interactive account read for a pinned settings row; establishes identity like a first read. */
  async refreshAccount(): Promise<void> {
    if (this.authScope === undefined || !this.feature.scoped.available || this.state.login !== undefined) return
    await this.run(async epoch => {
      const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-account', {}, epoch)
      this.patch({ scopedCapability: cap.value, generation: cap.generation })
    }, 'auth', true)
  }
  /** Withdraw this scope's cached data after another view changed its authentication. */
  accountChanged(scope: ScopedRemoteScope): void {
    const mine = this.authenticationScope
    if (mine?.provider !== scope.provider || mine.instance !== scope.instance) return
    if (this.authScope !== undefined) { void this.refreshAccount(); return }
    // GitHub Remote views already reset through the global generation change; a scoped capability would change what they render.
    if (mine.provider !== 'gitlab') return
    this.rememberAuthDetail()
    void this.cancel(); this.invalidate(); this.notifications.clear()
    this.patch({ facts: undefined, scopedCapability: undefined, generation: undefined, detail: undefined, items: [], itemsNext: undefined,
      comments: [], commentsNext: undefined, inline: [], inlineNext: undefined, commits: [], commitsNext: undefined, reviews: [], reviewsNext: undefined, approvals: undefined,
      confirmation: undefined, blocked: false, reconciled: false, unknown: false, outcome: undefined, error: undefined, errorDetails: undefined })
    if (this.listeners.size === 0 || !this.feature.scoped.available) return
    void this.run(async epoch => {
      const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
      this.patch({ scopedCapability: cap.value, generation: cap.generation })
      if (cap.value.auth.state === 'authenticated' && this.state.repository !== undefined) await this.reloadAfterAuth(epoch)
    }, 'auth', true)
  }
  async ensureAuthCapability(): Promise<boolean> {
    if (this.authenticationScope?.provider !== 'gitlab' || this.state.scopedCapability !== undefined) return true
    let restored = false
    await this.run(async epoch => {
      const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
      if (cap.value.state !== 'on' || cap.value.auth === undefined) throw new Error('invalid-auth-capability')
      this.patch({ scopedCapability: cap.value, generation: cap.generation })
      restored = true
    }, 'auth', true)
    return restored
  }
  private rememberAuthDetail(): void {
    const detail = this.state.detail
    if (detail !== undefined) this.authDetail = { number: detail.number, kind: 'head' in detail ? 'pulls' : 'issues' }
  }
  private async reloadAfterAuth(epoch: number): Promise<void> {
    const detail = this.authDetail
    if (detail === undefined) await this.loadListScoped(epoch, this.listKind, this.listState)
    else await this.openScoped(epoch, detail.number, detail.kind, false)
    if (epoch === this.epoch) this.authDetail = undefined
  }
  async authAction(...endpoints: string[]): Promise<void> {
    this.patch({ loginStatus: undefined, loginBrowser: undefined, loginCopy: undefined })
    const scope = this.authenticationScope, gitlab = scope?.provider === 'gitlab' && this.feature.scoped.available
    // The scoped branch cancels work below while retaining the sign-out target.
    if (!gitlab && endpoints[0] === 'remote-sign-out' && this.state.busy) { this.clear(this.state.repository); this.patch({}) }
    if (gitlab) {
      if (this.state.blocked && endpoints[0] === 'remote-retry-auth') return
      if (endpoints[0] !== 'remote-retry-auth' && this.state.target?.provider === 'gitlab') this.notifications.clearInstance(this.state.target.scope.instance)
      this.rememberAuthDetail()
      void this.cancel(); this.patch({ confirmation: undefined, detail: undefined, facts: undefined, items: [], blocked: false, reconciled: false, blockedAction: undefined, outcome: undefined })
      let completed = false
      await this.run(async epoch => {
        for (const endpoint of endpoints) await this.scopedCall(endpoint, {}, epoch)
        const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
        this.patch({ scopedCapability: cap.value, generation: cap.generation })
        if (endpoints[0] !== 'remote-sign-out' && this.state.repository !== undefined) await this.reloadAfterAuth(epoch)
        completed = true
      }, 'auth', true)
      if (completed && scope !== undefined) this.feature.authenticationChanged(scope, this)
      return
    }
    let completed = false
    await this.run(async epoch => {
      for (const endpoint of endpoints) await this.call(endpoint)
      if (epoch === this.epoch) { this.clear(this.state.repository); this.patch({}); this.feature.refresh(); completed = true }
    }, 'auth')
    if (completed) {
      this.feature.authenticationChanged(this.authenticationScope ?? GITHUB_SCOPE, this)
      if (this.authScope !== undefined) await this.refreshAccount()
    }
  }
  async selectAuthMethod(method: 'cli' | 'oauth'): Promise<void> {
    if (!await this.ensureAuthCapability()) return
    if (this.state.busy || this.state.login !== undefined || this.disposed) return
    const gitlab = this.authenticationScope?.provider === 'gitlab' && this.feature.scoped.available
    const capability = gitlab ? this.state.scopedCapability : this.state.capability.state === 'on' ? this.state.capability : undefined
    if (capability?.authSelection === undefined) {
      if (method === 'oauth') await this.login()
      else await this.authAction(...(capability?.auth.source === 'grant' || capability?.auth.state === 'signed-out' || capability?.auth.state === 'invalid' ? ['remote-clear-grant'] : []), 'remote-retry-auth')
      return
    }
    if (method === 'cli' && !capability.authSelection.cliAvailable) return
    await this.changeAuthMethod('remote-select-auth', method)
  }
  async logoutOAuth(): Promise<void> {
    if (!await this.ensureAuthCapability()) return
    const capability = this.authenticationScope?.provider === 'gitlab' ? this.state.scopedCapability : this.state.capability.state === 'on' ? this.state.capability : undefined
    if (capability?.authSelection === undefined) { await this.authAction('remote-sign-out'); return }
    await this.changeAuthMethod('remote-oauth-logout')
  }
  private async changeAuthMethod(endpoint: 'remote-select-auth' | 'remote-oauth-logout', method?: 'cli' | 'oauth'): Promise<void> {
    const gitlab = this.authenticationScope?.provider === 'gitlab' && this.feature.scoped.available
    this.rememberAuthDetail()
    void this.cancel(); this.invalidate(); this.notifications.clear()
    const epoch = this.epoch
    this.patch({ error: undefined, errorDetails: undefined, loginStatus: undefined, loginBrowser: undefined, loginCopy: undefined,
      facts: undefined, detail: undefined, items: [], itemsNext: undefined, confirmation: undefined, blocked: false, reconciled: false, blockedAction: undefined, outcome: undefined })
    let needsLogin = false, completed = false
    await this.run(async current => {
      const payload = method === undefined ? {} : { method }
      const selected = gitlab
        ? (await this.scopedCall<ScopedRemoteCapabilityOn>(endpoint, payload, current)).value
        : await this.call<Extract<GitRemoteCapability, { state: 'on' }>>(endpoint, payload)
      if (current !== this.epoch || this.disposed) return
      if (selected?.state !== 'on' || selected.auth === undefined) throw new Error('invalid-auth-capability')
      this.patch({ generation: selected.generation, ...(gitlab || this.authScope !== undefined ? { scopedCapability: selected as ScopedRemoteCapabilityOn } : { capability: selected as Extract<GitRemoteCapability, { state: 'on' }> }) })
      if (method === 'oauth' && (selected.auth.state !== 'authenticated' || selected.auth.source !== 'grant')) { needsLogin = true; return }
      if (selected.auth.state === 'signed-out') { completed = true; return }
      if (this.state.repository !== undefined) {
        if (this.feature.scoped.available && this.state.target !== undefined) await this.reloadAfterAuth(current)
        else await this.loadV1(current, this.listKind, this.state.target as RemoteRepository | undefined, this.listState)
      }
      completed = true
    }, 'auth', true)
    if (completed && this.authenticationScope !== undefined) this.feature.authenticationChanged(this.authenticationScope, this)
    if (this.authScope !== undefined && !needsLogin) await this.refreshAccount()
    if (needsLogin && epoch === this.epoch && this.state.error === undefined) await this.login()
  }
  get nativeLoginBrowser(): boolean { return this.feature.nativeAuthBrowser }
  authDesktopChanged(): void {
    this.patch(this.state.login !== undefined && !this.nativeLoginBrowser ? { loginBrowser: 'manual' } : {})
  }
  private liveLogin(login: RemoteLoginAttempt, epoch: number): boolean {
    return !this.disposed && epoch === this.epoch && this.state.login === login && (login.expiresAt === undefined || login.expiresAt > Date.now())
  }
  async openLoginBrowser(): Promise<void> {
    const login = this.state.login, epoch = this.epoch
    if (login === undefined || !this.liveLogin(login, epoch)) return
    this.patch({ loginBrowser: 'opening' })
    try {
      const opened = await this.feature.openAuthorization(login.verificationUriComplete ?? login.verificationUri)
      if (this.liveLogin(login, epoch)) this.patch({ loginBrowser: opened && this.nativeLoginBrowser ? 'opened' : 'manual' })
    } catch { if (this.liveLogin(login, epoch)) this.patch({ loginBrowser: 'failed' }) }
  }
  async copyLoginCode(): Promise<void> {
    const login = this.state.login, epoch = this.epoch
    if (login === undefined || !this.liveLogin(login, epoch)) return
    this.patch({ loginCopy: undefined })
    try {
      await this.feature.copyUserCode(login.userCode)
      if (this.liveLogin(login, epoch)) this.patch({ loginCopy: 'copied' })
    } catch { if (this.liveLogin(login, epoch)) this.patch({ loginCopy: 'failed' }) }
  }
  async login(): Promise<void> {
    if (this.state.login !== undefined || this.state.busy || this.disposed) return
    if (!await this.ensureAuthCapability()) return
    const target = this.state.target, authScope = this.authenticationScope, gitlab = authScope?.provider === 'gitlab' && this.feature.scoped.available
    const capability = gitlab ? this.state.scopedCapability : this.state.capability.state === 'on' ? this.state.capability : undefined
    if (capability?.loginAvailable !== true) return
    if (gitlab) this.rememberAuthDetail()
    const scope = gitlab ? authScope : GITHUB_SCOPE
    let attempt: RemoteLoginAttempt | undefined
    let epoch = this.epoch
    await this.run(async current => {
      epoch = current
      this.patch({ loginStatus: 'requesting', loginBrowser: undefined, loginCopy: undefined })
      try {
        const raw = gitlab ? await this.scopedCall<unknown>('remote-login', {}, epoch) : { value: await this.call<unknown>('remote-login'), generation: undefined }
        if (epoch !== this.epoch || this.disposed) return
        try { attempt = readLoginAttempt(raw.value, scope.instance, gitlab) }
        catch (error) {
          const attemptId = isRecord(raw.value) ? raw.value['attemptId'] : undefined
          if (typeof attemptId === 'string' && /^[^\s\x00-\x1f\x7f]{1,200}$/u.test(attemptId)) {
            if (gitlab) await this.feature.scoped.call('remote-cancel-login', scope, { attemptId }, undefined, `${this.lane}:cancel-login`).catch(() => {})
            else await this.feature.rpc.call('/git', 'remote-cancel-login', { attemptId, sessionId: this.sessionId }).catch(() => {})
          }
          throw error
        }
        this.patch({ login: attempt, loginStatus: 'waiting', confirmation: undefined, ...(raw.generation === undefined ? {} : { generation: raw.generation }) })
      } catch (error) {
        if (epoch === this.epoch && !this.disposed) {
          this.patch({ loginStatus: loginFailure(error), login: undefined })
          if (gitlab) {
            try { const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch); this.patch({ scopedCapability: cap.value, generation: cap.generation }) } catch { /* Preserve the original login error. */ }
          }
        }
      }
    }, 'auth')
    if (attempt === undefined || !this.liveLogin(attempt, epoch)) {
      if (attempt !== undefined && epoch === this.epoch) await this.cancelLogin('expired')
      return
    }
    const login = attempt, signal = this.active.signal
    if (login.expiresAt !== undefined) this.loginTimeout = setTimeout(() => { void this.cancelLogin('expired') }, Math.min(login.expiresAt - Date.now(), 2_147_483_647))
    // Controller ownership, rather than a component effect, guarantees one automatic open per attempt.
    void this.openLoginBrowser()
    void (async () => {
      try {
        const result = gitlab
          ? await this.feature.scoped.call('remote-poll-login', scope, { attemptId: login.attemptId }, signal, this.lane)
          : { value: await this.call('remote-poll-login', { attemptId: login.attemptId }, signal), generation: undefined }
        if (!this.liveLogin(login, epoch)) return
        if (!isRecord(result.value) || result.value['state'] !== 'authenticated') throw new Error('invalid-login-result')
        clearTimeout(this.loginTimeout); this.loginTimeout = undefined
        this.patch({ login: undefined, loginStatus: 'verifying', ...(result.generation === undefined ? {} : { generation: result.generation }) })
        await this.run(async current => {
          if (current !== epoch) return
          if (gitlab) {
            await this.scopedCall('remote-retry-auth', {}, epoch)
            const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
            if (cap.value.auth.state !== 'authenticated') throw new Error('login-not-authenticated')
            this.patch({ scopedCapability: cap.value, generation: cap.generation })
            if (this.state.repository !== undefined) await this.reloadAfterAuth(epoch)
            this.feature.authenticationChanged(scope, this)
          } else {
            const cap = await this.call<{ auth?: { state?: string } }>('remote-retry-auth')
            if (current !== this.epoch || this.disposed) return
            if (cap?.auth?.state !== 'authenticated') throw new Error('login-not-authenticated')
            // Invalidate the old viewer/data immediately; the normal surface effect reloads this repository.
            this.clear(this.state.repository); this.patch({})
            this.feature.authenticationChanged(scope, this)
            if (this.authScope !== undefined) await this.refreshAccount()
          }
          if (!this.disposed && (gitlab ? current === this.epoch : this.state.target === undefined)) this.patch({ loginStatus: 'connected' })
        }, 'auth')
        if (epoch === this.epoch && this.state.loginStatus === 'verifying' && this.state.error !== undefined) this.patch({ loginStatus: 'failed' })
      } catch (error) {
        if (epoch !== this.epoch || this.disposed || this.state.login !== login) return
        clearTimeout(this.loginTimeout); this.loginTimeout = undefined
        const status = loginFailure(error)
        await this.cancelLogin(status)
      }
    })()
  }
  async cancelLogin(status: RemoteLoginStatus = 'cancelled'): Promise<void> {
    if (this.state.login === undefined) return
    const gitlab = this.authenticationScope?.provider === 'gitlab'
    const cleanup = this.cancel()
    const epoch = this.epoch
    this.patch({ loginStatus: status, loginBrowser: undefined, loginCopy: undefined })
    await cleanup
    if (gitlab && epoch === this.epoch && this.state.login === undefined && this.state.loginStatus === status) {
      try {
        const cap = await this.scopedCall<ScopedRemoteCapabilityOn>('remote-capability', {}, epoch)
        if (this.state.login === undefined && this.state.loginStatus === status) this.patch({ scopedCapability: cap.value, generation: cap.generation })
      } catch { /* Cancellation feedback remains available if capability refresh fails. */ }
    }
    this.feature.refresh()
  }
  private async writeV1(endpoint: string, values: Record<string, unknown>): Promise<void> {
    await this.run(async epoch => {
      const { target, generation, facts, repository } = this.state
      if (target === undefined || generation === undefined || facts?.viewer === undefined) return
      const context: GitRemoteWriteContext = { ...(target as unknown as { host: string; owner: string; repo: string }), expectedGeneration: generation, expectedViewer: facts.viewer }
      let result: unknown
      try { result = await this.call(endpoint, { ...context, ...values, requestId: crypto.randomUUID() }) }
      finally { this.invalidate(); this.feature.invalidate(repository) }
      if (epoch !== this.epoch) return
      if (endpoint === 'remote-checkout-pr' && typeof result === 'object' && result !== null) this.patch({ checkout: result as RemoteCheckoutReceipt, ...('error' in result ? { error: 'Git checkout needs attention' } : {}) })
    }, 'write')
  }
  private expected(): Record<string, unknown> | undefined {
    const target = this.state.target, generation = this.state.generation, facts = this.state.facts, viewer = facts?.viewer
    if (target === undefined || generation === undefined || viewer === undefined || facts === undefined || !('actionScope' in facts)) return undefined
    const expectedPath = target.provider === 'gitlab' ? target.path : `${target.owner}/${target.repo}`
    if (facts.actionScope.path !== expectedPath) return undefined
    if (target.provider === 'gitlab' && (target.projectId === undefined || facts.actionScope.projectId !== target.projectId)) return undefined
    return { expectedInstance: remoteTargetScope(target).instance, expectedGeneration: generation, expectedViewer: { host: viewer.host, userId: viewer.userId }, requestId: globalThis.crypto.randomUUID() }
  }
  private validateFacts(value: ScopedRemoteRepositoryFacts, object?: { kind: 'pull' | 'issue'; number: number }): void {
    const scope = value?.actionScope, target = this.state.target
    if (target === undefined || scope === undefined) throw new ScopedProtocolError('invalid-facts')
    const expectedPath = target.provider === 'gitlab' ? target.path : `${target.owner}/${target.repo}`
    const pathMatches = target.provider === 'gitlab' ? scope.path === expectedPath : scope.path.toLowerCase() === expectedPath.toLowerCase()
    const projectOk = target.provider !== 'gitlab' || (typeof scope.projectId === 'string' && /^[1-9][0-9]{0,39}$/u.test(scope.projectId) && (target.projectId === undefined || target.projectId === scope.projectId))
    const objectOk = object === undefined ? scope.object === undefined : scope.object?.kind === object.kind && scope.object.number === object.number
    if (!pathMatches || !projectOk || !objectOk) throw new ScopedProtocolError('invalid-facts')
  }
  private normalizeOutcome(endpoint: string, value: unknown): RemoteWriteOutcome {
    if (isRecord(value) && ['succeeded', 'partial', 'unknown'].includes(String(value['outcome'])) && Array.isArray(value['steps'])) return value as unknown as RemoteWriteOutcome
    // GitHub scope returns bare v1 receipts for local operations instead of an outcome envelope.
    if (endpoint === 'remote-checkout-pr' || endpoint === 'remote-issue-branch') {
      const receipt = isRecord(value) ? value : {}
      return { outcome: typeof receipt['error'] === 'string' ? 'partial' : 'succeeded', steps: [], receipt: value }
    }
    throw new ScopedProtocolError('invalid-response')
  }
  private async mutation(endpoint: string, payload: Record<string, unknown>, epoch: number, generation: GitRemoteGeneration | undefined, action: string, number?: number): Promise<{ generation: GitRemoteGeneration; value: RemoteWriteOutcome }> {
    const repository = this.state.repository
    try {
      const result = await this.scopedCall<unknown>(endpoint, payload, epoch, generation)
      const value = this.normalizeOutcome(endpoint, result.value)
      return { generation: result.generation, value }
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) throw error
      if (error instanceof ScopedProtocolError) {
        if (error.reason === 'host-not-negotiated' || error.code === 'git/write-result-unknown' || error.code === 'git/head-moved' || error.code === 'git/insufficient-scope' || error.code === 'git/rate-limited' || error.code === 'git/unauthenticated' || error.code === 'git/signed-out') throw error
        const known = ['not-sent', 'provider-rejected', 'approval-rejected-or-reauth-required', 'action-not-supported', 'invalid-request', 'invalid-comparison', 'object-read-only', 'unsupported-review-event', 'unsupported-merge-method', 'not-supported']
        if (error.code === 'git/remote-unavailable' && known.includes(String(error.details?.['reason'] ?? ''))) throw error
      }
      const reason = error instanceof ScopedProtocolError && invalidProtocol(error) ? error.reason : 'write-response-lost'
      throw new ScopedProtocolError(reason, 'git/write-result-unknown', { action, ...(number === undefined ? {} : { number }) })
    } finally {
      this.feature.invalidate(repository)
    }
  }
  private confirmationIdentity(): string | undefined {
    const target = this.state.target, facts = this.state.facts, detail = this.state.detail, generation = this.state.generation, viewer = facts?.viewer
    if (target === undefined || facts === undefined || detail === undefined || !('head' in detail) || detail.head.sha === null || generation === undefined || viewer === undefined) return undefined
    if ('actionScope' in facts) {
      const expectedPath = target.provider === 'gitlab' ? target.path : `${target.owner}/${target.repo}`
      if (facts.actionScope.object?.kind !== 'pull' || facts.actionScope.object.number !== detail.number || facts.actionScope.path !== expectedPath) return undefined
      if (target.provider === 'gitlab' && facts.actionScope.projectId !== target.projectId) return undefined
      return JSON.stringify(['scoped', remoteTargetScope(target), expectedPath, facts.actionScope.projectId ?? '', detail.number, detail.head.sha, detail.state, detail.rawState, generation, viewer.host, viewer.userId])
    }
    const github = target as RemoteRepository
    return JSON.stringify(['v1', github.host, github.owner.toLowerCase(), github.repo.toLowerCase(), detail.number, detail.head.sha, detail.state, detail.rawState, generation, viewer.host, viewer.userId])
  }
  prepare(action: 'close' | 'merge', method?: 'merge' | 'squash'): void {
    const identity = this.confirmationIdentity(), detail = this.state.detail, facts = this.state.facts
    if (identity === undefined || detail === undefined || !('head' in detail) || detail.head.sha === null || facts === undefined || this.state.busy || this.state.blocked || this.state.unknown) return
    const scoped = 'actionScope' in facts ? facts : undefined
    if (action === 'close' && ((scoped !== undefined && !scoped.operationSupport['close-pr'].supported) || !acceptedAction(facts.actions.canClose))) return
    if (action === 'merge' && ((scoped !== undefined && (!scoped.operationSupport['merge-pr'].supported || method === undefined || !scoped.supportedMergeMethods.includes(method))) || !acceptedAction(facts.actions.canMerge))) return
    this.patch({ confirmation: { action, ...(method === undefined ? {} : { method }), identity, number: detail.number, sha: detail.head.sha } })
  }
  cancelConfirmation(): void { this.patch({ confirmation: undefined }) }
  async confirm(): Promise<void> {
    const confirmation = this.state.confirmation
    if (confirmation === undefined) return
    if (confirmation.identity !== this.confirmationIdentity() || this.state.blocked || this.state.unknown) { this.patch({ confirmation: undefined, error: 'stale-confirmation' }); return }
    if (this.feature.scoped.available && this.state.facts !== undefined && 'actionScope' in this.state.facts) {
      const expected = this.expected()
      if (expected === undefined) { this.patch({ confirmation: undefined, error: 'stale-confirmation' }); return }
      await this.run(async epoch => {
        const result = await this.mutation(confirmation.action === 'close' ? 'remote-close-pr' : 'remote-merge-pr', { ...expected, ...(this.state.target!.provider === 'gitlab' ? { objectKind: 'pull' } : { object: { kind: 'pull', number: confirmation.number } }), number: confirmation.number, expectedHeadSha: confirmation.sha, ...(confirmation.method === undefined ? {} : { method: confirmation.method }) }, epoch, this.state.generation, confirmation.action === 'merge' ? 'merge-pr' : 'close-pr', confirmation.number)
        this.patch({ outcome: result.value, outcomeAction: confirmation.action === 'merge' ? 'merge-pr' : 'close-pr', outcomeSeq: this.state.outcomeSeq + 1, blocked: true, blockedAction: confirmation.action === 'merge' ? 'merge-pr' : 'close-pr', reconciled: false, confirmation: undefined })
      })
      return
    }
    const endpoint = confirmation.action === 'close' ? 'remote-close-pr' : 'remote-merge-pr'
    await this.writeV1(endpoint, { number: confirmation.number, expectedHeadSha: confirmation.sha, ...(confirmation.method === undefined ? {} : { method: confirmation.method }) })
    this.patch({ confirmation: undefined })
  }
  async write(endpoint: string, values: Record<string, unknown> = {}): Promise<void> {
    if (this.state.unknown) return
    if (this.feature.scoped.available && this.state.target !== undefined && this.state.facts !== undefined && 'actionScope' in this.state.facts) return this.writeScoped(endpoint, values)
    return this.writeV1(endpoint, values)
  }
  private async writeScoped(endpoint: string, values: Record<string, unknown> = {}): Promise<void> {
    const target = this.state.target, detail = this.state.detail, facts = this.state.facts as ScopedRemoteRepositoryFacts | undefined, expected = this.expected()
    if (target === undefined || detail === undefined || facts === undefined || expected === undefined || this.state.blocked) return
    const pull = 'head' in detail
    if (facts.actionScope.object?.kind !== (pull ? 'pull' : 'issue') || facts.actionScope.object.number !== detail.number) return
    if (pull && (detail.rawState === 'locked' || detail.state === 'unknown')) return
    if (!pull && detail.state === 'unknown') return
    if (endpoint === 'remote-comment' && (!pull || !facts.operationSupport.comment.supported || !acceptedAction(facts.actions.canComment))) return
    if (endpoint === 'remote-review') {
      const event = values['event']
      if (!pull || (event !== 'COMMENT' && event !== 'APPROVE' && event !== 'REQUEST_CHANGES') || !facts.operationSupport.review.supported || !(facts.supportedReviewEvents as readonly string[]).includes(String(event)) || !acceptedAction(facts.actions.canReview) || (target.provider === 'gitlab' && event === 'APPROVE' && facts.reviewPermissions?.APPROVE !== true && facts.reviewPermissions?.APPROVE !== 'unknown')) return
    }
    if (endpoint === 'remote-checkout-pr' && (!pull || detail.head.sha === null)) return
    if (endpoint === 'remote-issue-branch' && pull) return
    await this.run(async epoch => {
      const objectKind = pull ? 'pull' : 'issue'
      const result = await this.mutation(endpoint, { ...values, ...expected, number: detail.number, ...(target.provider === 'gitlab' ? { objectKind } : { object: { kind: objectKind, number: detail.number } }), ...(pull && (endpoint === 'remote-checkout-pr' || endpoint === 'remote-review' && (target.provider === 'github' || values['event'] === 'APPROVE')) && detail.head.sha !== null ? { expectedHeadSha: detail.head.sha } : {}) }, epoch, this.state.generation, endpoint, detail.number)
      const outcome = result.value
      const blocked = outcome.outcome === 'partial' || outcome.outcome === 'unknown' || endpoint === 'remote-review' && values['event'] === 'APPROVE'
      const receipt = isRecord(outcome.receipt) ? outcome.receipt : undefined
      this.patch({ outcome, outcomeAction: endpoint, outcomeSeq: this.state.outcomeSeq + 1, blocked, blockedAction: blocked ? endpoint : undefined, reconciled: false, confirmation: undefined, ...(endpoint === 'remote-checkout-pr' && receipt !== undefined ? { checkout: receipt as unknown as RemoteCheckoutReceipt, ...('error' in receipt ? { error: 'Git checkout needs attention' } : {}) } : {}) })
    })
  }
  async createPr(values: { title: string; body: string; headRef: string; baseRef: string; headOwner?: string; headRepo?: string; source?: RemoteTarget & { provider: 'gitlab' }; draft?: boolean }): Promise<void> {
    const target = this.state.target, facts = this.state.facts
    if (target === undefined || facts === undefined) return
    if ('actionScope' in facts) {
      const scopedFacts = facts, expected = this.expected()
      if (expected === undefined || this.state.blocked || !scopedFacts.operationSupport['create-pr'].supported || !acceptedAction(scopedFacts.actions.canCreatePr)) return
      if (target.provider === 'gitlab') {
        const source = values.source
        if (source === undefined || source.scope.instance !== target.scope.instance || !this.state.remotes.some(item => item.identity.provider === 'gitlab' && item.identity.scope.instance === source.scope.instance && item.identity.path === source.path)) return
        await this.run(async epoch => {
          const sourceFacts = await this.feature.scoped.call<ScopedRemoteRepositoryFacts>('remote-repository', source.scope, { repository: this.state.repository, sessionId: this.sessionId, path: source.path, ...(source.projectId === undefined ? {} : { projectId: source.projectId }) }, this.active.signal, this.lane)
          if (epoch !== this.epoch || !equal(sourceFacts.generation, this.state.generation) || sourceFacts.value.actionScope.path !== source.path || !/^[1-9][0-9]{0,39}$/u.test(sourceFacts.value.actionScope.projectId ?? '') || sourceFacts.value.viewer?.host !== scopedFacts.viewer?.host || sourceFacts.value.viewer?.userId !== scopedFacts.viewer?.userId) throw new ScopedProtocolError('stale-generation')
          const result = await this.mutation('remote-create-pr', { ...expected, head: { provider: 'gitlab', instance: source.scope.instance, path: source.path, projectId: sourceFacts.value.actionScope.projectId }, headRef: values.headRef, baseRef: values.baseRef, title: values.title, body: values.body, draft: values.draft === true }, epoch, this.state.generation, 'create-pr')
          this.patch({ outcome: result.value, outcomeAction: 'create-pr', outcomeSeq: this.state.outcomeSeq + 1, blocked: result.value.outcome !== 'succeeded', blockedAction: result.value.outcome !== 'succeeded' ? 'create-pr' : undefined, reconciled: false })
        })
        return
      }
      const github = target as RemoteRepository
      await this.run(async epoch => {
        const head = { provider: 'github', host: 'github.com', owner: values.headOwner === undefined || values.headOwner === '' ? github.owner : values.headOwner, repo: values.headRepo === undefined || values.headRepo === '' ? github.repo : values.headRepo, scope: GITHUB_SCOPE }
        const result = await this.mutation('remote-create-pr', { ...expected, head, headRef: values.headRef, baseRef: values.baseRef, title: values.title, body: values.body, draft: values.draft === true }, epoch, this.state.generation, 'create-pr')
        this.patch({ outcome: result.value, outcomeAction: 'create-pr', outcomeSeq: this.state.outcomeSeq + 1, blocked: result.value.outcome !== 'succeeded', blockedAction: result.value.outcome !== 'succeeded' ? 'create-pr' : undefined, reconciled: false })
      })
      return
    }
    const github = target as RemoteRepository
    await this.writeV1('remote-create-pr', { title: values.title, body: values.body, head: { ...github, owner: values.headOwner === undefined || values.headOwner === '' ? github.owner : values.headOwner, repo: values.headRepo === undefined || values.headRepo === '' ? github.repo : values.headRepo }, headRef: values.headRef, baseRef: values.baseRef, draft: false })
  }
  async refresh(): Promise<void> {
    const detail = this.state.detail
    if (detail !== undefined) { await this.open(detail.number, 'head' in detail ? 'pulls' : 'issues', true); return }
    if (this.feature.scoped.available && this.state.blocked) {
      void this.cancel()
      const creation = this.state.blockedAction === 'create-pr' || this.state.blockedAction === 'remote-create-pr'
      await this.run(epoch => this.loadListScoped(epoch, creation ? 'pulls' : this.listKind, creation ? 'all' : this.listState, true), 'repositories', true)
      return
    }
    await this.load(this.listKind, undefined, this.listState)
  }
  acknowledgeReconciliation(): void { if (this.state.blocked && this.state.reconciled) this.patch({ blocked: false, reconciled: false, blockedAction: undefined, error: undefined, errorDetails: undefined, outcome: undefined }) }
  /** Dismiss the transient success notice once the toast finishes. */
  dismissOutcome(): void { this.patch({ outcome: undefined, outcomeAction: undefined }) }
  dispose(): void { void this.cancel(); this.disposed = true; if (this.streamResume !== undefined) clearTimeout(this.streamResume); this.notifications.clear(); this.unsubscribe(); this.listeners.clear() }
}

function appendUnique<T>(items: readonly T[], page: readonly T[], key: (item: T) => string | number): readonly T[] {
  const merged = new Map(items.map(item => [key(item), item]))
  for (const item of page) merged.set(key(item), item)
  return [...merged.values()]
}

/** Preserve object/array identity for unchanged rows after conditional validation. */
function reconcile<T>(previous: readonly T[], next: readonly T[], key: (item: T) => string | number): readonly T[] {
  const old = new Map(previous.map(item => [key(item), item]))
  const rows = next.map(item => {
    const retained = old.get(key(item))
    return retained !== undefined && JSON.stringify(retained) === JSON.stringify(item) ? retained : item
  })
  return rows.length === previous.length && rows.every((item, index) => item === previous[index]) ? previous : rows
}

export const remoteNoticeKeys = { 'review-requested': 'remote.noticeReview', merged: 'remote.noticeMerged', closed: 'remote.noticeClosed', 'changes-requested': 'remote.noticeChanges', 'create-pr': 'remote.noticeCreate' } as const
export const gitLabNoticeKeys = { 'review-requested': 'gitlab.noticeReview', merged: 'gitlab.noticeMerged', closed: 'gitlab.noticeClosed', 'changes-requested': 'gitlab.noticeReview', 'create-pr': 'gitlab.noticeCreate' } as const
