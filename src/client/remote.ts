/** Portable remote capability lifecycle and session/workspace-scoped controller. */
import type { GitRpcClient } from './controller.ts'
import type { GitRemoteCapability, GitRemoteGeneration, GitRemoteWriteContext } from '../remote/types.ts'
import type { BoundRemote, RemoteRepositorySet, RemoteCheckoutReceipt } from '../remote/git.ts'
import type { RemoteComment, RemoteFile, RemoteIssue, RemotePage, RemotePull, RemoteRepository, RemoteRepositoryFacts, RemoteResult, RemoteNotice } from '../remote/provider.ts'

const OFF: GitRemoteCapability = { state: 'off', reason: 'implementation-pending', auth: { state: 'off' } }
const equal = (a: GitRemoteGeneration | undefined, b: GitRemoteGeneration | undefined) => a !== undefined && b !== undefined && a.instanceId === b.instanceId && a.revision === b.revision
/** Upstream pages fetched by the first request of a progressive list; continuations take one page each. */
const FIRST_PAGES = 3
/** Longest reset wait for one automatic stream resume after `git/rate-limited`. */
const STREAM_RESUME_MAX_MS = 600_000
export class RemoteRpcError extends Error {
  constructor(readonly code: string, message: string, readonly details: unknown) { super(message) }
}
export class GitRemoteFeature {
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
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(readonly rpc: GitRpcClient) {}
  readonly getSnapshot = () => this.state
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  start(): void { this.refresh(); this.timer ??= setInterval(() => this.refresh(), 5000) }
  refresh(): void {
    if (this.owner.signal.aborted || this.pending !== undefined) return
    this.pending = (async () => {
      try {
        const reply = await this.rpc.call('/git', 'remote-capability', {}, this.owner.signal)
        if (this.owner.signal.aborted) return
        const cap = reply.ok ? reply.value as GitRemoteCapability : OFF
        if (cap?.state !== 'on' || (this.state.state === 'on' && !equal(cap.generation, this.state.generation))) { this.notices = []; this.seen.clear() }
        this.state = cap?.state === 'on' || cap?.state === 'off' ? cap : OFF
      } catch { this.state = OFF }
      if (!this.owner.signal.aborted) for (const listener of this.listeners) listener()
    })().finally(() => { this.pending = undefined })
  }
  dispose(): void { this.owner.abort(); clearInterval(this.timer); this.listeners.clear() }
}
export interface RemoteClientState {
  readonly capability: GitRemoteCapability
  readonly repository?: string | undefined
  readonly remotes: readonly BoundRemote[]
  readonly target?: RemoteRepository | undefined
  readonly facts?: RemoteRepositoryFacts | undefined
  readonly generation?: GitRemoteGeneration | undefined
  readonly items: readonly (RemotePull | RemoteIssue)[]
  /** Opaque list continuation cursor; absent once the list is fully loaded. */
  readonly itemsNext?: string | undefined
  readonly detail?: RemotePull | RemoteIssue | undefined
  readonly comments: readonly RemoteComment[]
  readonly commentsNext?: string | undefined
  readonly inline: readonly RemoteComment[]
  readonly inlineNext?: string | undefined
  readonly checkout?: RemoteCheckoutReceipt | undefined
  readonly comparison?: { readonly files: RemotePage<RemoteFile>; readonly baseSha: string; readonly headSha: string } | undefined
  readonly busy: boolean
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
  private streamRunning = false
  private streamResume: ReturnType<typeof setTimeout> | undefined
  private listKind: 'pulls' | 'issues' = 'pulls'
  private listState: 'open' | 'closed' | 'all' = 'open'
  private readonly unsubscribe: () => void
  constructor(private readonly feature: GitRemoteFeature, private readonly sessionId?: string) {
    this.state = { capability: feature.getSnapshot(), remotes: [], items: [], comments: [], inline: [], busy: false, streaming: false, unknown: false }
    this.unsubscribe = feature.subscribe(() => {
      const capability = feature.getSnapshot()
      if (capability.state === 'off' || (this.state.generation !== undefined && capability.state === 'on' && !equal(this.state.generation, capability.generation))) this.clear(this.state.repository)
      this.patch({ capability })
    })
  }
  readonly getSnapshot = () => this.state
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(value: Partial<RemoteClientState>): void { if (this.disposed) return; this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener() }
  private clear(repository?: string): void {
    this.epoch += 1; this.active.abort(); this.active = new AbortController()
    if (this.streamResume !== undefined) { clearTimeout(this.streamResume); this.streamResume = undefined }
    this.state = { capability: this.feature.getSnapshot(), ...(repository === undefined ? {} : { repository }), remotes: [], items: [], comments: [], inline: [], busy: false, streaming: false, unknown: false }
  }
  setRepository(repository: string | undefined): void { if (repository === this.state.repository) return; this.clear(repository); this.patch({}); if (repository !== undefined) void this.load() }
  private async call<T>(endpoint: string, payload: Record<string, unknown> = {}, signal = this.active.signal): Promise<T> {
    const reply = await this.feature.rpc.call('/git', endpoint, { ...payload, ...(this.state.repository === undefined ? {} : { repository: this.state.repository }), ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }) }, signal)
    if (!reply.ok) { const error = reply.error as { code?: string; message?: string; details?: unknown }; throw new RemoteRpcError(error.code ?? 'git/remote-unavailable', error.message ?? 'Git remote request failed', error.details) }
    return reply.value as T
  }
  private async run(work: (epoch: number) => Promise<void>): Promise<void> {
    if (this.disposed || this.state.busy) return
    const epoch = this.epoch; this.patch({ busy: true, error: undefined })
    try { await work(epoch) } catch (error) { if (epoch === this.epoch) this.patch({ error: error instanceof Error ? error.message : String(error), unknown: error instanceof RemoteRpcError && error.code === 'git/write-result-unknown' || this.state.unknown }) }
    finally { if (epoch === this.epoch) { this.patch({ busy: false }); this.feature.refresh() } }
  }
  async load(kind: 'pulls' | 'issues' = 'pulls', selected?: RemoteRepository, state: 'open' | 'closed' | 'all' = 'open'): Promise<void> {
    await this.run(async epoch => {
      const repositories = await this.call<RemoteRepositorySet>('remote-repositories')
      const target = selected ?? this.state.target ?? repositories.remotes[0]?.identity
      if (epoch !== this.epoch) return
      this.patch({ remotes: repositories.remotes })
      if (target === undefined) return
      const facts = await this.call<RemoteResult<RemoteRepositoryFacts>>('remote-repository', target as unknown as Record<string, unknown>)
      const list = await this.call<RemoteResult<RemotePage<RemotePull | RemoteIssue>>>(kind === 'pulls' ? 'remote-list-prs' : 'remote-list-issues', { ...target, state, pages: FIRST_PAGES })
      if (epoch !== this.epoch || !equal(facts.generation, list.generation)) return
      this.listKind = kind; this.listState = state
      this.patch({ target, generation: facts.generation, facts: facts.value, items: list.value.items, itemsNext: list.value.next, detail: undefined, comparison: undefined, comments: [], commentsNext: undefined, inline: [], inlineNext: undefined, streamError: undefined, unknown: false })
      this.stream(epoch)
    })
  }
  async open(n: number, kind: 'pulls' | 'issues'): Promise<void> {
    await this.run(async epoch => {
      const target = this.state.target; if (target === undefined) return
      const detail = await this.call<RemoteResult<RemotePull | RemoteIssue>>(kind === 'pulls' ? 'remote-pr' : 'remote-issue', { ...target, number: n })
      const comments = await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number: n, pages: FIRST_PAGES })
      const inline = kind === 'pulls' ? await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number: n, inline: true, pages: FIRST_PAGES }) : undefined
      const comparison = kind === 'pulls' ? await this.call<RemoteResult<NonNullable<RemoteClientState['comparison']>>>('remote-files', { ...target, number: n, pages: FIRST_PAGES }) : undefined
      if (epoch !== this.epoch || !equal(detail.generation, comments.generation) || (inline !== undefined && !equal(detail.generation, inline.generation)) || (comparison !== undefined && !equal(detail.generation, comparison.generation))) return
      this.patch({ facts: this.state.facts === undefined ? undefined : { ...this.state.facts, actions: { ...this.state.facts.actions, canClose: detail.value.author?.userId === this.state.facts.viewer?.userId || this.state.facts.permissions.push === true ? true : this.state.facts.permissions.push === false ? false : 'unknown' } }, itemsNext: undefined, detail: detail.value, generation: detail.generation, comments: comments.value.items, commentsNext: comments.value.next, inline: inline?.value.items ?? [], inlineNext: inline?.value.next, comparison: comparison?.value, streamError: undefined, unknown: false })
      this.stream(epoch)
    })
  }
  /** Continue any pending page cursor in the background, one upstream page per call. */
  private stream(epoch: number): void {
    if (this.disposed || this.streamRunning || this.active.signal.aborted) return
    this.streamRunning = true
    void this.streamLoop(epoch).then(drained => {
      this.streamRunning = false
      // A kick landing between the loop's last cursor check and this teardown is honored now.
      if (drained && epoch === this.epoch && this.hasPendingCursor()) this.stream(epoch)
    })
  }
  private hasPendingCursor(): boolean {
    const s = this.state
    return s.itemsNext !== undefined || s.commentsNext !== undefined || s.inlineNext !== undefined || s.comparison?.files.next !== undefined
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
          this.patch({ items: appendUnique(this.state.items, page.value.items, item => item.number), itemsNext: page.value.next })
          continue
        }
        const number = s.detail?.number
        if (s.commentsNext !== undefined && number !== undefined) {
          const cursor = s.commentsNext
          const page = await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number, cursor })
          if (epoch !== this.epoch || !equal(generation, page.generation)) return false
          if (this.state.commentsNext !== cursor) continue
          this.patch({ comments: appendUnique(this.state.comments, page.value.items, comment => comment.id), commentsNext: page.value.next })
          continue
        }
        if (s.inlineNext !== undefined && number !== undefined) {
          const cursor = s.inlineNext
          const page = await this.call<RemoteResult<RemotePage<RemoteComment>>>('remote-comments', { ...target, number, inline: true, cursor })
          if (epoch !== this.epoch || !equal(generation, page.generation)) return false
          if (this.state.inlineNext !== cursor) continue
          this.patch({ inline: appendUnique(this.state.inline, page.value.items, comment => comment.id), inlineNext: page.value.next })
          continue
        }
        const comparison = s.comparison
        if (comparison !== undefined && comparison.files.next !== undefined && number !== undefined) {
          const cursor = comparison.files.next
          const page = await this.call<RemoteResult<NonNullable<RemoteClientState['comparison']>>>('remote-files', { ...target, number, cursor, expectedBaseSha: comparison.baseSha, expectedHeadSha: comparison.headSha })
          if (epoch !== this.epoch || !equal(generation, page.generation)) return false
          if (this.state.comparison !== comparison) continue
          this.patch({ comparison: { ...comparison, files: { ...page.value.files, items: appendUnique(comparison.files.items, page.value.files.items, file => file.path) } } })
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
  async authAction(endpoint: string): Promise<void> {
    if (endpoint === 'remote-sign-out' && this.state.busy) { this.clear(this.state.repository); this.patch({}) }
    await this.run(async epoch => { await this.call(endpoint); if (epoch === this.epoch) { this.clear(this.state.repository); this.patch({}) } })
  }
  async login(show: (value: { userCode: string; verificationUri: string; attemptId: string }) => void): Promise<void> {
    await this.run(async epoch => {
      const login = await this.call<{ userCode: string; verificationUri: string; attemptId: string }>('remote-login')
      if (epoch !== this.epoch) return
      show(login)
      await this.call('remote-poll-login', { attemptId: login.attemptId })
    })
  }
  async cancelLogin(attemptId: string): Promise<void> { await this.call('remote-cancel-login', { attemptId }); this.feature.refresh() }
  async write(endpoint: string, values: Record<string, unknown>): Promise<void> {
    if (this.state.unknown) return
    await this.run(async epoch => {
      const { target, generation, facts } = this.state
      if (target === undefined || generation === undefined || facts?.viewer === undefined) return
      const context: GitRemoteWriteContext = { ...target, expectedGeneration: generation, expectedViewer: facts.viewer }
      const result = await this.call(endpoint, { ...context, ...values, requestId: crypto.randomUUID() })
      if (epoch !== this.epoch) return
      if (endpoint === 'remote-checkout-pr' && typeof result === 'object' && result !== null) this.patch({ checkout: result as RemoteCheckoutReceipt, ...('error' in result ? { error: 'Git checkout needs attention' } : {}) })
    })
  }
  dispose(): void { this.disposed = true; this.epoch += 1; this.active.abort(); if (this.streamResume !== undefined) clearTimeout(this.streamResume); this.unsubscribe(); this.listeners.clear() }
}

function appendUnique<T>(items: readonly T[], page: readonly T[], key: (item: T) => string | number): readonly T[] {
  if (page.length === 0) return items
  const seen = new Set(items.map(key))
  const fresh: T[] = []
  for (const item of page) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id); fresh.push(item)
  }
  return fresh.length === 0 ? items : [...items, ...fresh]
}

export const remoteNoticeKeys = { 'review-requested': 'remote.noticeReview', merged: 'remote.noticeMerged', closed: 'remote.noticeClosed', 'changes-requested': 'remote.noticeChanges', 'create-pr': 'remote.noticeCreate' } as const
