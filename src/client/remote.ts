/** Portable remote capability lifecycle and session/workspace-scoped controller. */
import type { GitRpcClient } from './controller.ts'
import type { GitRemoteCapability, GitRemoteGeneration, GitRemoteWriteContext } from '../remote/types.ts'
import type { BoundRemote, RemoteRepositorySet, RemoteCheckoutReceipt } from '../remote/git.ts'
import type { RemoteComment, RemoteCommit, RemoteIssue, RemotePage, RemotePull, RemoteRepository, RemoteRepositoryFacts, RemoteResult, RemoteNotice, RemoteReview } from '../remote/provider.ts'

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
export class GitRemoteFeature {
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
    const controller = new GitRemoteController(this, sessionId)
    this.controllers.set(key, controller)
    return controller
  }
  invalidate(repository: string | undefined): void {
    for (const controller of this.controllers.values()) {
      if (controller.getSnapshot().repository === repository) controller.invalidate()
    }
  }
  private state = OFF
  private notices: readonly RemoteNotice[] = []
  private readonly seen = new Set<string>()
  private notify: ((notice: RemoteNotice) => void | Promise<void>) | undefined
  readonly getNotices = () => this.notices
  setNotify(notify: ((notice: RemoteNotice) => void | Promise<void>) | undefined): void { this.notify = notify }
  ingest(notices: readonly RemoteNotice[]): void {
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
  constructor(readonly rpc: GitRpcClient) {}
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
        if (cap?.state !== 'on' || (this.state.state === 'on' && !equal(cap.generation, this.state.generation))) { this.notices = []; this.seen.clear() }
        this.state = cap?.state === 'on' || cap?.state === 'off' ? cap : OFF
      } catch { this.state = OFF }
      if (!this.owner.signal.aborted) for (const listener of this.listeners) listener()
    })().finally(() => {
      this.pending = undefined
      if (this.refreshAgain) { this.refreshAgain = false; this.refresh() }
    })
  }
  dispose(): void { this.owner.abort(); clearInterval(this.timer); for (const controller of this.controllers.values()) controller.dispose(); this.controllers.clear(); this.listeners.clear() }
}
export type RemotePending = 'repositories' | 'repository' | 'items' | 'detail' | 'auth' | 'authorization' | 'write'
export interface RemoteClientState {
  readonly capability: GitRemoteCapability
  readonly repository?: string | undefined
  readonly remotes: readonly BoundRemote[]
  readonly target?: RemoteRepository | undefined
  readonly facts?: RemoteRepositoryFacts | undefined
  readonly generation?: GitRemoteGeneration | undefined
  readonly items: readonly (RemotePull | RemoteIssue)[]
  readonly listKind?: 'pulls' | 'issues' | undefined
  readonly listState?: 'open' | 'closed' | 'all' | undefined
  /** Opaque list continuation cursor; absent once the list is fully loaded. */
  readonly itemsNext?: string | undefined
  readonly detail?: RemotePull | RemoteIssue | undefined
  readonly comments: readonly RemoteComment[]
  readonly commentsNext?: string | undefined
  readonly inline: readonly RemoteComment[]
  readonly inlineNext?: string | undefined
  readonly commits: readonly RemoteCommit[]
  readonly commitsNext?: string | undefined
  readonly reviews: readonly RemoteReview[]
  readonly reviewsNext?: string | undefined
  readonly checkout?: RemoteCheckoutReceipt | undefined
  readonly busy: boolean
  readonly pending?: RemotePending | undefined
  /** True while a background page pull appends to an already-rendered list. */
  readonly streaming: boolean
  /** Set when the background stream stopped on an error or an overlong rate-limit reset. */
  readonly streamError?: string | undefined
  readonly error?: string | undefined
  readonly unknown: boolean
}
export class GitRemoteController {
  private state: RemoteClientState
  private readonly listeners = new Set<() => void>()
  private epoch = 0
  private active = new AbortController()
  private disposed = false
  private streamEpoch: number | undefined
  private streamResume: ReturnType<typeof setTimeout> | undefined
  private listKind: 'pulls' | 'issues' = 'pulls'
  private listState: 'open' | 'closed' | 'all' = 'open'
  private listAttempt: { key: string; at: number } | undefined
  private detailAttempt: { key: string; at: number } | undefined
  private listValidatedAt = 0
  private readonly lists = new Map<string, { state: RemoteClientState; at: number; collected: readonly unknown[] | undefined }>()
  private readonly collections = new Map<string, readonly unknown[]>()
  private readonly unsubscribe: () => void
  constructor(private readonly feature: GitRemoteFeature, private readonly sessionId?: string) {
    this.state = { capability: feature.getSnapshot(), remotes: [], items: [], comments: [], inline: [], commits: [], reviews: [], busy: false, streaming: false, unknown: false }
    this.unsubscribe = feature.subscribe(() => {
      const capability = feature.getSnapshot()
      if (capability.state === 'off' || (this.state.generation !== undefined && capability.state === 'on' && !equal(this.state.generation, capability.generation))) this.clear(this.state.repository)
      this.patch({ capability })
    })
  }
  readonly getSnapshot = () => this.state
  get idle(): boolean { return this.listeners.size === 0 && !this.state.busy && !this.state.streaming && !this.state.unknown && this.streamResume === undefined }
  invalidate(): void { this.listAttempt = undefined; this.detailAttempt = undefined; this.lists.clear() }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(value: Partial<RemoteClientState>): void { if (this.disposed) return; this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener() }
  private clear(repository?: string): void {
    this.invalidate(); this.collections.clear()
    this.listValidatedAt = 0
    this.epoch += 1; this.active.abort(); this.active = new AbortController()
    if (this.streamResume !== undefined) { clearTimeout(this.streamResume); this.streamResume = undefined }
    this.state = { capability: this.feature.getSnapshot(), ...(repository === undefined ? {} : { repository }), remotes: [], items: [], comments: [], inline: [], commits: [], reviews: [], busy: false, streaming: false, unknown: false }
  }
  setRepository(repository: string | undefined, autoload = true): void { if (repository === this.state.repository) return; this.clear(repository); this.patch({}); if (repository !== undefined && autoload) void this.load() }
  /** Restore a filter immediately, validating stale data while it remains visible. */
  async ensureList(kind = this.listKind, selected = this.state.target, state = this.listState): Promise<void> {
    if (this.state.busy || this.state.unknown || this.state.repository === undefined || this.state.capability.state !== 'on') return
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
    if (this.state.unknown) return
    const key = `${kind}/${n}:${revision}`
    if (this.detailAttempt?.key === key && Date.now() - this.detailAttempt.at < CACHE_TTL_MS) return
    if (this.state.busy) return
    this.detailAttempt = { key, at: Date.now() }
    await this.open(n, kind)
  }
  private listKey(kind: string, target: RemoteRepository | undefined, state: string): string {
    return JSON.stringify([target?.host, target?.owner.toLowerCase(), target?.repo.toLowerCase(), kind, state])
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
  private async run(work: (epoch: number) => Promise<void>, pending: RemotePending = 'write'): Promise<void> {
    if (this.disposed || this.state.busy) return
    const epoch = this.epoch; this.patch({ busy: true, pending, error: undefined })
    try { await work(epoch) } catch (error) { if (epoch === this.epoch) this.patch({ error: error instanceof Error ? error.message : String(error), unknown: error instanceof RemoteRpcError && error.code === 'git/write-result-unknown' || this.state.unknown }) }
    finally { if (epoch === this.epoch) { this.patch({ busy: false, pending: undefined }); this.feature.refresh() } }
  }
  async load(kind: 'pulls' | 'issues' = 'pulls', selected?: RemoteRepository, state: 'open' | 'closed' | 'all' = 'open'): Promise<void> {
    if (this.disposed || this.state.busy) return
    this.rememberList()
    this.stopStream()
    this.listAttempt = { key: this.listKey(kind, selected ?? this.state.target, state), at: Date.now() }
    await this.run(async epoch => {
      const repositories = await this.call<RemoteRepositorySet>('remote-repositories')
      const target = selected ?? this.state.target ?? repositories.remotes[0]?.identity
      if (epoch !== this.epoch) return
      this.patch({ remotes: repositories.remotes, pending: 'repository' })
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
      this.patch({ target, generation: facts.generation, facts: facts.value, listKind: kind, listState: state, items: this.page('items', sameList ? this.state.items : [], list.value, item => item.number, true), itemsNext: list.value.next, detail: undefined, comments: [], commentsNext: undefined, inline: [], inlineNext: undefined, commits: [], commitsNext: undefined, reviews: [], reviewsNext: undefined, streamError: undefined, unknown: false })
      this.rememberList()
      this.stream(epoch)
    }, 'repositories')
  }
  async open(n: number, kind: 'pulls' | 'issues'): Promise<void> {
    if (this.disposed || this.state.busy) return
    this.stopStream()
    await this.run(async epoch => {
      const target = this.state.target; if (target === undefined) return
      const detail = await this.call<RemoteResult<RemotePull | RemoteIssue>>(kind === 'pulls' ? 'remote-pr' : 'remote-issue', { ...target, number: n })
      const comments = await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number: n, pages: FIRST_PAGES })
      const inline = kind === 'pulls' ? await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number: n, inline: true, pages: FIRST_PAGES }) : undefined
      const commits = kind === 'pulls' ? await this.call<RemoteResult<RemotePage<RemoteCommit>>>('remote-commits', { ...target, number: n, pages: FIRST_PAGES }) : undefined
      const reviews = kind === 'pulls' ? await this.call<RemoteResult<RemotePage<RemoteReview>>>('remote-reviews', { ...target, number: n, pages: FIRST_PAGES }) : undefined
      if (epoch !== this.epoch || !equal(detail.generation, comments.generation) || (inline !== undefined && !equal(detail.generation, inline.generation)) || (commits !== undefined && !equal(detail.generation, commits.generation)) || (reviews !== undefined && !equal(detail.generation, reviews.generation))) return
      const sameDetail = this.state.detail?.number === n && ('head' in this.state.detail) === (kind === 'pulls')
      this.patch({ facts: this.state.facts === undefined ? undefined : { ...this.state.facts, actions: { ...this.state.facts.actions, canClose: detail.value.author?.userId === this.state.facts.viewer?.userId || this.state.facts.permissions.push === true ? true : this.state.facts.permissions.push === false ? false : 'unknown' } }, itemsNext: undefined, detail: detail.value, generation: detail.generation, comments: this.page('comments', sameDetail ? this.state.comments : [], comments.value, entry => entry.id, true), commentsNext: comments.value.next, inline: inline === undefined ? [] : this.page('inline', sameDetail ? this.state.inline : [], inline.value, entry => entry.id, true), inlineNext: inline?.value.next, commits: commits === undefined ? [] : this.page('commits', sameDetail ? this.state.commits : [], commits.value, entry => entry.sha, true), commitsNext: commits?.value.next, reviews: reviews === undefined ? [] : this.page('reviews', sameDetail ? this.state.reviews : [], reviews.value, entry => entry.id, true), reviewsNext: reviews?.value.next, streamError: undefined, unknown: false })
      this.stream(epoch)
    }, 'detail')
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
        if (s.itemsNext !== undefined) {
          const cursor = s.itemsNext
          const page = await this.call<RemoteResult<RemotePage<RemotePull | RemoteIssue>>>(this.listKind === 'issues' ? 'remote-list-issues' : 'remote-list-prs', { ...target, state: this.listState, cursor })
          if (epoch !== this.epoch || !equal(generation, page.generation)) return false
          if (this.state.itemsNext !== cursor) continue
          this.patch({ items: this.page('items', this.state.items, page.value, item => item.number), itemsNext: page.value.next }); this.rememberList()
          continue
        }
        const number = s.detail?.number
        if (s.commentsNext !== undefined && number !== undefined) {
          const cursor = s.commentsNext
          const page = await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number, cursor })
          if (epoch !== this.epoch || !equal(generation, page.generation)) return false
          if (this.state.commentsNext !== cursor) continue
          this.patch({ comments: this.page('comments', this.state.comments, page.value, item => item.id), commentsNext: page.value.next })
          continue
        }
        if (s.inlineNext !== undefined && number !== undefined) {
          const cursor = s.inlineNext
          const page = await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number, inline: true, cursor })
          if (epoch !== this.epoch || !equal(generation, page.generation)) return false
          if (this.state.inlineNext !== cursor) continue
          this.patch({ inline: this.page('inline', this.state.inline, page.value, item => item.id), inlineNext: page.value.next })
          continue
        }
        if (s.commitsNext !== undefined && number !== undefined) {
          const cursor = s.commitsNext
          const page = await this.call<RemoteResult<RemotePage<RemoteCommit>>>('remote-commits', { ...target, number, cursor })
          if (epoch !== this.epoch || !equal(generation, page.generation)) return false
          if (this.state.commitsNext !== cursor) continue
          this.patch({ commits: this.page('commits', this.state.commits, page.value, item => item.sha), commitsNext: page.value.next })
          continue
        }
        if (s.reviewsNext !== undefined && number !== undefined) {
          const cursor = s.reviewsNext
          const page = await this.call<RemoteResult<RemotePage<RemoteReview>>>('remote-reviews', { ...target, number, cursor })
          if (epoch !== this.epoch || !equal(generation, page.generation)) return false
          if (this.state.reviewsNext !== cursor) continue
          this.patch({ reviews: this.page('reviews', this.state.reviews, page.value, item => item.id), reviewsNext: page.value.next })
          continue
        }
        return true
      }
    } catch (error) {
      if (this.disposed || epoch !== this.epoch || this.active.signal.aborted) return false
      this.patch({ streamError: error instanceof Error ? error.message : String(error) })
      if (error instanceof RemoteRpcError && error.code === 'git/rate-limited') {
        const resetAt = (error.details as { resetAt?: unknown } | undefined)?.resetAt
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
    if (this.disposed || this.state.busy || target === undefined || generation === undefined || capability.state !== 'on' || capability.auth.state !== 'authenticated') return
    const epoch = this.epoch
    try { const result = await this.call<RemoteResult<RemotePage<RemoteNotice>>>('remote-notifications', { ...target, automatic: true }); if (epoch === this.epoch && equal(generation, result.generation)) this.feature.ingest(result.value.items) } catch { /* Shared Host budgets decide when polling can resume. */ }
  }
  async authAction(...endpoints: string[]): Promise<void> {
    if (endpoints[0] === 'remote-sign-out' && this.state.busy) { this.clear(this.state.repository); this.patch({}) }
    await this.run(async epoch => {
      for (const endpoint of endpoints) await this.call(endpoint)
      if (epoch === this.epoch) { this.clear(this.state.repository); this.patch({}); this.feature.refresh() }
    }, 'auth')
  }
  async login(show: (value: { userCode: string; verificationUri: string; attemptId: string }) => void): Promise<void> {
    await this.run(async epoch => {
      const login = await this.call<{ userCode: string; verificationUri: string; attemptId: string }>('remote-login')
      if (epoch !== this.epoch) return
      show(login)
      this.patch({ pending: 'authorization' })
      await this.call('remote-poll-login', { attemptId: login.attemptId })
    }, 'auth')
  }
  async cancelLogin(attemptId: string): Promise<void> { await this.call('remote-cancel-login', { attemptId }); this.feature.refresh() }
  async write(endpoint: string, values: Record<string, unknown>): Promise<void> {
    if (this.state.unknown) return
    await this.run(async epoch => {
      const { target, generation, facts, repository } = this.state
      if (target === undefined || generation === undefined || facts?.viewer === undefined) return
      const context: GitRemoteWriteContext = { ...target, expectedGeneration: generation, expectedViewer: facts.viewer }
      let result: unknown
      try { result = await this.call(endpoint, { ...context, ...values, requestId: crypto.randomUUID() }) }
      finally { this.invalidate(); this.feature.invalidate(repository) }
      if (epoch !== this.epoch) return
      if (endpoint === 'remote-checkout-pr' && typeof result === 'object' && result !== null) this.patch({ checkout: result as RemoteCheckoutReceipt, ...('error' in result ? { error: 'Git checkout needs attention' } : {}) })
    })
  }
  dispose(): void { this.disposed = true; this.epoch += 1; this.active.abort(); if (this.streamResume !== undefined) clearTimeout(this.streamResume); this.unsubscribe(); this.listeners.clear() }
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
