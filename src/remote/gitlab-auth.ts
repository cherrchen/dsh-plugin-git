/** GitLab-only per-instance authentication. Secrets never leave this owner. */
import { createHash, randomUUID } from 'node:crypto'
import type { CredentialRef, CredentialRecord } from './credentials-types.ts'
import { gitRemoteCredentialRef, type GitRemoteCredentialService } from './credentials.ts'
import { AuthSelectionStore, authMethod, hasOAuthRecord } from './auth-selection.ts'
import { GitRemoteError, remoteAuthError } from './errors.ts'
import { GitRemoteHttp, GitRemoteHttpError } from './http.ts'
import { gitLabGrantRecord, parseGitLabGrant, type GitLabGrant } from './gitlab-grant.ts'
import { gitLabWebUrl } from './gitlab-model.ts'
import { GITLAB_COM, gitLabGrantKey, type GitLabInstance } from './instances.ts'
import type { ResolvedRemoteSettings } from './settings.ts'
import type { GitRemoteGeneration, GitRemoteViewer, ScopedRemoteCapabilityOn, ScopedRemoteResult } from './types.ts'

interface PendingLogin { deviceCode: string; userCode: string; expiresAt: number; intervalMs: number; controller: AbortController }
type Source = 'grant' | 'ref' | 'glab'
interface Context { state: 'unauthenticated' | 'anonymous' | 'signed-out' | 'authenticated' | 'invalid'; source?: Source; ref?: CredentialRef; refSource?: string; token?: string; fingerprint?: string; viewer?: GitRemoteViewer; refreshable?: boolean }
/** Host-only immutable credential snapshot; never return this object over RPC. */
export interface GitLabAuthSnapshot {
  readonly generation: GitRemoteGeneration
  readonly state: Context['state']
  readonly token?: string
  readonly viewer?: GitRemoteViewer
  readonly signal: AbortSignal
}
const tokenValid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/u.test(value)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
function expiry(now: number, seconds: unknown): number {
  if (!positive(seconds)) throw remoteAuthError('invalid-expiry')
  const value = now + seconds * 1000
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER || value <= now) throw remoteAuthError('invalid-expiry')
  return value
}
const getObject = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(remoteAuthError('cancelled')) }
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
})

export interface GitLabAuthDeps {
  readonly credentials: GitRemoteCredentialService
  readonly http: GitRemoteHttp
  readonly instance: GitLabInstance
  readonly settings: ResolvedRemoteSettings
  readonly discoverGlab?: (signal: AbortSignal) => Promise<string | undefined>
  readonly isCurrent?: () => boolean
  readonly now?: () => number
  readonly uuid?: () => string
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export class GitLabAuth {
  private readonly instanceId: string
  private revision = 0
  private context: Context = { state: 'unauthenticated' }
  private adopted: { source: Source; ref?: CredentialRef } | undefined
  private glabProbe: { token?: string } | undefined
  private glabOwner = new AbortController()
  private invalidFingerprint: string | undefined
  private deviceFlow: boolean | 'unknown' = 'unknown'
  private serverVersion: string | undefined
  private readonly owner = new AbortController()
  private generationOwner = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly logins = new Map<string, PendingLogin>()
  private readonly polls = new Map<string, Promise<ScopedRemoteResult<{ state: 'authenticated' }>>>()
  private chain: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  constructor(private readonly deps: GitLabAuthDeps) {
    this.now = deps.now ?? Date.now; this.uuid = deps.uuid ?? randomUUID; this.wait = deps.sleep ?? sleep; this.instanceId = this.uuid()
  }
  private checkCurrent(): void { if (this.deps.isCurrent?.() === false) throw new GitRemoteError('git/remote-unavailable', 'git-remote: instance configuration changed', { reason: 'instance-removed' }) }
  private generation(): GitRemoteGeneration { return { instanceId: this.instanceId, revision: this.revision } }
  private result<T>(value: T): ScopedRemoteResult<T> { return { generation: this.generation(), value } }
  private track<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    this.pending.add(task); void task.finally(() => this.pending.delete(task)).catch(() => {})
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(remoteAuthError('cancelled'))
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  private run<T>(work: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    if (this.owner.signal.aborted) return Promise.reject(remoteAuthError('disposed'))
    const signal = caller === undefined ? this.owner.signal : AbortSignal.any([caller, this.owner.signal])
    const task = this.chain.then(() => { signal.throwIfAborted(); this.checkCurrent(); return work(signal) })
    this.chain = task.catch(() => {})
    return this.track(task, signal)
  }
  private setState(state: Context['state']): void {
    if (this.context.state !== state || this.context.token !== undefined) { this.context = { state }; this.serverVersion = undefined; this.bump() }
  }
  private bump(): void { this.generationOwner.abort(); this.generationOwner = new AbortController(); this.revision++ }
  private async read(): Promise<{ record?: CredentialRecord; grant?: GitLabGrant }> {
    let record: CredentialRecord | undefined
    try { record = await this.deps.credentials.readRecord(gitLabGrantKey(this.deps.instance.instance)) } catch { throw remoteAuthError('store-read-failed') }
    this.oauthCached = hasOAuthRecord(record)
    if (record === undefined) return {}
    const grant = parseGitLabGrant(record, this.deps.instance.instance)
    if (grant === undefined) { this.setState('invalid'); throw remoteAuthError('record-mismatch') }
    return { record, grant }
  }
  private async modify(mutate: (grant: GitLabGrant | undefined, record: CredentialRecord | undefined) => GitLabGrant | undefined, allowStaleCleanup = false): Promise<GitLabGrant | undefined> {
    let record: CredentialRecord | undefined
    try {
      if (!allowStaleCleanup) this.checkCurrent()
      record = await this.deps.credentials.modifyRecord(gitLabGrantKey(this.deps.instance.instance), async current => {
        if (!allowStaleCleanup) this.checkCurrent()
        const parsed = parseGitLabGrant(current, this.deps.instance.instance)
        if (current !== undefined && parsed === undefined) throw remoteAuthError('record-mismatch')
        const next = mutate(parsed, current)
        return next === undefined ? undefined : gitLabGrantRecord(next)
      })
    } catch (error) { if (error instanceof GitRemoteError) throw error; throw remoteAuthError('store-write-failed') }
    this.oauthCached = hasOAuthRecord(record)
    return parseGitLabGrant(record, this.deps.instance.instance)
  }
  private base(): { v: 2; provider: 'gitlab'; instance: string; revision: string } {
    return { v: 2, provider: 'gitlab', instance: this.deps.instance.instance, revision: this.uuid() }
  }
  private async accept(token: unknown, source: Source, signal: AbortSignal, ref?: CredentialRef, refSource?: string, refreshable = false, grantRevision?: string): Promise<void> {
    if (!tokenValid(token)) { this.setState('invalid'); throw remoteAuthError('invalid-token') }
    const fingerprint = hash(token)
    if (this.invalidFingerprint === fingerprint) { this.setState('invalid'); throw remoteAuthError('invalid-token') }
    if (this.context.state === 'authenticated' && this.context.fingerprint === fingerprint && this.context.source === source && this.context.ref === ref) {
      this.context = { ...this.context, refreshable }; return
    }
    this.setState('unauthenticated')
    this.checkCurrent()
    let response
    try { response = await this.deps.http.request({ role: 'api', method: 'GET', path: `${this.deps.instance.prefix}/api/v4/user`, headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal }) }
    catch (error) { if (error instanceof GitRemoteHttpError) throw remoteAuthError('verification-retryable'); throw error }
    if (response.status === 401) { this.invalidFingerprint = fingerprint; this.setState('invalid'); throw remoteAuthError('invalid-token') }
    if (response.status === 429 || response.status >= 500) throw remoteAuthError('verification-retryable')
    if (response.status !== 200) throw remoteAuthError('verification-failed')
    const body = getObject(response.body)
    const id = body?.['id']; const login = body?.['username']
    if ((typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id))) || String(id) === '' || typeof login !== 'string' || login === '') throw remoteAuthError('invalid-user-response')
    // An event or external edit can race GET /user. Verify the source again before adopting it.
    if (ref !== undefined) {
      const current = await this.resolved(ref)
      if (current?.value !== token || current.source !== refSource) { this.setState('invalid'); throw remoteAuthError('source-changed') }
    }
    if (grantRevision !== undefined) {
      const current = (await this.read()).grant
      if (current?.state !== 'authenticated' || current.revision !== grantRevision || current.accessToken !== token) { this.setState('invalid'); throw remoteAuthError('source-changed') }
    }
    if ((await this.selectionStore().read()).revision !== this.selectionRevision) { this.setState('unauthenticated'); throw remoteAuthError('source-changed') }
    signal.throwIfAborted()
    this.checkCurrent()
    const avatarUrl = gitLabWebUrl(this.deps.instance.instance, body?.['avatar_url'], true)
    const viewer: GitRemoteViewer = { host: this.deps.instance.hostname, userId: String(id), login, ...(avatarUrl === undefined ? {} : { avatarUrl }) }
    this.context = { state: 'authenticated', source, token, fingerprint, viewer, refreshable, ...(ref === undefined ? {} : { ref }), ...(refSource === undefined ? {} : { refSource }) }
    this.adopted = { source, ...(ref === undefined ? {} : { ref }) }; this.serverVersion = undefined; this.bump()
  }
  private async resolved(ref: CredentialRef): Promise<{ value: string; source: string } | undefined> {
    try { return await this.deps.credentials.resolve(ref) } catch { throw remoteAuthError('store-read-failed') }
  }
  private resetGlab(): void {
    this.glabOwner.abort(); this.glabOwner = new AbortController(); this.glabProbe = undefined
  }
  private async establishGlab(signal: AbortSignal): Promise<void> {
    const inner = AbortSignal.any([signal, this.glabOwner.signal])
    if (this.glabProbe === undefined) {
      let token: string | undefined
      try { token = await this.deps.discoverGlab?.(inner) } catch { inner.throwIfAborted() }
      // Invalidation/cancellation must fence even a probe that ignores its signal.
      inner.throwIfAborted(); this.checkCurrent()
      this.glabProbe = token === undefined ? {} : { token }
    }
    inner.throwIfAborted()
    const token = this.glabProbe.token
    if (token === undefined || token === '') {
      if (this.adopted?.source === 'glab') { this.setState('invalid'); throw remoteAuthError('source-lost') }
      this.setState('anonymous'); return
    }
    this.adopted = { source: 'glab' }
    await this.accept(token, 'glab', inner)
  }
  private oauthCached = false
  private selection: AuthSelectionStore | undefined
  private selectionRevision: string | undefined
  private selectionStore(): AuthSelectionStore { return this.selection ??= new AuthSelectionStore(this.deps.credentials, gitLabGrantKey(this.deps.instance.instance), 'gitlab', this.deps.instance.instance, () => this.checkCurrent()) }
  private async selectedMethod() {
    const selected = await this.selectionStore().read()
    if (selected.revision !== this.selectionRevision) {
      this.selectionRevision = selected.revision
      this.resetGlab(); this.adopted = undefined; this.setState('unauthenticated')
    }
    if (selected.method === 'cli') this.oauthCached = hasOAuthRecord(await this.deps.credentials.readRecord(gitLabGrantKey(this.deps.instance.instance)))
    return selected.method
  }
  selectMethod(method: unknown, signal: AbortSignal): Promise<ScopedRemoteResult<ScopedRemoteCapabilityOn>> {
    const selected = authMethod(method)
    // A method switch must not queue behind an in-flight device poll for the whole expiry window.
    for (const login of this.logins.values()) login.controller.abort()
    return this.run(async inner => {
      if (selected === 'cli' && this.deps.discoverGlab === undefined) throw remoteAuthError('cli-unavailable')
      await this.selectionStore().write(selected)
      try { await this.establishCurrent(inner) } catch (error) {
        if (!(error instanceof GitRemoteError) || error.details?.['reason'] !== 'invalid-token') throw error
      }
      return this.currentCapability()
    }, signal)
  }
  logoutOAuth(signal: AbortSignal): Promise<ScopedRemoteResult<ScopedRemoteCapabilityOn>> {
    for (const login of this.logins.values()) login.controller.abort()
    return this.run(async inner => {
      const selected = await this.selectedMethod()
      await this.modify(() => ({ ...this.base(), state: 'signed-out' }))
      if (selected !== 'cli') { this.adopted = undefined; this.setState('signed-out') }
      else await this.establishCurrent(inner)
      return this.currentCapability()
    }, signal)
  }
  private async establishCurrent(signal: AbortSignal): Promise<void> {
    const selected = await this.selectedMethod()
    if (selected === 'cli') { await this.establishGlab(signal); return }
    let { grant } = await this.read()
    if (grant !== undefined) {
      if (grant.state === 'signed-out') { this.setState('signed-out'); return }
      if (grant.state === 'reauth-required' || grant.state === 'authorizing') { this.setState('invalid'); return }
      this.adopted = { source: 'grant' }
      if (grant.clientId !== this.deps.instance.clientId) { this.setState('invalid'); throw remoteAuthError('record-mismatch') }
      if (grant.state === 'refreshing') grant = await this.waitForRefresh(grant, signal)
      if (grant?.state !== 'authenticated') { this.setState('invalid'); return }
      if (grant.expiresAt <= this.now()) grant = await this.refresh(grant, signal)
      if (grant?.state !== 'authenticated') { this.setState('invalid'); return }
      await this.accept(grant.accessToken, 'grant', signal, undefined, undefined, grant.refreshToken !== undefined && this.deps.settings.refreshStoreExclusive, grant.revision)
      return
    }
    if (selected === 'oauth') { this.setState('unauthenticated'); return }
    if (this.adopted?.source === 'grant') { this.setState('invalid'); throw remoteAuthError('source-lost') }
    const refs: CredentialRef[] = []
    if (this.deps.instance.credentialRef !== undefined) refs.push(this.deps.instance.credentialRef)
    if (this.deps.instance.instance === GITLAB_COM) for (const name of ['GITLAB_TOKEN', 'GL_TOKEN']) {
      const ref = gitRemoteCredentialRef(name); if (!refs.includes(ref)) refs.push(ref)
    }
    if (this.adopted?.source === 'ref') {
      const ref = this.adopted.ref
      const value = ref === undefined ? undefined : await this.resolved(ref)
      if (value === undefined || value.value === '') { this.setState('invalid'); throw remoteAuthError('source-lost') }
      await this.accept(value.value, 'ref', signal, ref, value.source); return
    }
    if (this.adopted?.source === 'glab') {
      await this.establishGlab(signal); return
    }
    for (const ref of refs) {
      const value = await this.resolved(ref)
      if (value === undefined || value.value === '') continue
      this.adopted = { source: 'ref', ref }
      await this.accept(value.value, 'ref', signal, ref, value.source); return
    }
    if (this.deps.instance.instance === GITLAB_COM && this.deps.discoverGlab !== undefined) {
      await this.establishGlab(signal); return
    }
    this.setState('anonymous')
  }
  /** An event is only an invalidation hint; the next explicit operation resolves and validates the source. */
  invalidate(kind: 'record' | 'reference' = 'record'): void { if (kind !== 'reference' || this.context.state !== 'signed-out') { this.resetGlab(); this.setState('unauthenticated') } }
  establish(signal: AbortSignal): Promise<ScopedRemoteResult<null>> { return this.run(async inner => { await this.establishCurrent(inner); return this.result(null) }, signal) }
  snapshot(signal: AbortSignal): Promise<GitLabAuthSnapshot> {
    return this.run(async inner => {
      await this.establishCurrent(inner)
      inner.throwIfAborted(); this.checkCurrent()
      return Object.freeze({ generation: Object.freeze(this.generation()), state: this.context.state, signal: this.generationOwner.signal,
        ...(this.context.token === undefined ? {} : { token: this.context.token }),
        ...(this.context.viewer === undefined ? {} : { viewer: Object.freeze({ ...this.context.viewer }) }) })
    }, signal)
  }
  markInvalid(snapshot: GitLabAuthSnapshot): void {
    if (snapshot.generation.instanceId !== this.instanceId || snapshot.generation.revision !== this.revision) return
    if (snapshot.token !== undefined) this.invalidFingerprint = hash(snapshot.token)
    this.setState('invalid')
  }
  assertGeneration(expected: GitRemoteGeneration): void {
    this.checkCurrent()
    if (this.owner.signal.aborted || expected.instanceId !== this.instanceId || expected.revision !== this.revision) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: credentials changed before the response')
  }
  private async currentCapability(): Promise<ScopedRemoteResult<ScopedRemoteCapabilityOn>> {
    let info
    try { info = await this.deps.credentials.describeRecord(gitLabGrantKey(this.deps.instance.instance)) } catch { throw remoteAuthError('store-read-failed') }
    const generation = this.generation()
    const value: ScopedRemoteCapabilityOn = {
      state: 'on', authSelection: this.selectionStore().capability(this.deps.discoverGlab !== undefined, info.configured && this.oauthCached), generation, credential: { configured: info.configured, writable: info.writable },
      auth: { state: this.context.state, ...(this.context.source === undefined ? {} : { source: this.context.source }) },
      ...(this.context.viewer === undefined ? {} : { viewer: this.context.viewer }),
      actions: { canComment: false, canReview: false, canMerge: false, canClose: false, canCreatePr: false },
      authMethods: { deviceFlow: { supported: this.deviceFlow, ...(this.deviceFlow === 'unknown' ? { reason: 'not-verified' } : this.deviceFlow === false ? { reason: 'not-supported' } : {}) } },
      ...(this.serverVersion === undefined ? {} : { serverVersion: { value: this.serverVersion, support: 'unknown' as const, reason: 'not-verified' as const } }),
      loginAvailable: this.deps.instance.clientId !== undefined && info.writable && this.deviceFlow !== false,
      automaticRefreshAvailable: this.context.refreshable === true,
    }
    return { generation, value }
  }
  capability(caller?: AbortSignal): Promise<ScopedRemoteResult<ScopedRemoteCapabilityOn>> {
    if (this.owner.signal.aborted) return Promise.reject(remoteAuthError('disposed'))
    const signal = caller === undefined ? this.owner.signal : AbortSignal.any([caller, this.owner.signal])
    const task = (async () => { signal.throwIfAborted(); this.checkCurrent(); const result = await this.currentCapability(); signal.throwIfAborted(); this.checkCurrent(); return result })()
    return this.track(task, signal)
  }
  retry(signal: AbortSignal): Promise<ScopedRemoteResult<ScopedRemoteCapabilityOn>> {
    return this.run(async inner => { this.resetGlab(); this.invalidFingerprint = undefined; await this.establishCurrent(inner); await this.initializeVersion(inner); return this.currentCapability() }, signal)
  }
  private async initializeVersion(signal: AbortSignal): Promise<void> {
    if (this.context.state !== 'authenticated' && this.context.state !== 'anonymous') return
    const revision = this.revision, token = this.context.token
    try {
      this.checkCurrent()
      const response = await this.deps.http.request({ role: 'api', method: 'GET', path: `${this.deps.instance.prefix}/api/v4/metadata`, headers: { accept: 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, signal })
      this.checkCurrent(); signal.throwIfAborted()
      if (response.status === 401 && token !== undefined) { this.invalidFingerprint = hash(token); this.setState('invalid'); throw remoteAuthError('invalid-token') }
      const version = getObject(response.body)?.['version']
      if (this.revision === revision && response.status === 200 && typeof version === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(version)) this.serverVersion = version
    } catch (error) {
      if (error instanceof GitRemoteError && error.details?.['reason'] === 'invalid-token') throw error
      signal.throwIfAborted(); this.checkCurrent() // Other metadata failures do not replace a verified identity.
    }
  }
  startLogin(signal: AbortSignal): Promise<ScopedRemoteResult<{ attemptId: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresAt: number; intervalMs: number }>> {
    return this.run(async inner => {
      const clientId = this.deps.instance.clientId
      if (clientId === undefined) throw remoteAuthError('client-id-missing')
      if (this.deviceFlow === false) throw remoteAuthError('device-flow-not-supported')
      const info = await this.deps.credentials.describeRecord(gitLabGrantKey(this.deps.instance.instance))
      if (!info.writable) throw remoteAuthError('store-read-only')
      await this.selectionStore().write('oauth')
      const preferred = await this.selectionStore().read()
      if (preferred.method !== 'oauth') throw remoteAuthError('source-changed')
      this.selectionRevision = preferred.revision
      const attemptId = this.uuid()
      const committed = await this.modify(current => {
        if (current !== undefined && (current.state === 'authorizing' || current.state === 'authenticated' || current.state === 'refreshing') && current.clientId !== clientId) throw remoteAuthError('record-mismatch')
        if (current?.state === 'authorizing') {
          // An authorizing record whose attempt died (restart/cancel) is stale; only a live attempt blocks login.
          const live = this.logins.get(current.attemptId)
          if (live !== undefined && !live.controller.signal.aborted) return undefined
        }
        return { ...this.base(), state: 'authorizing', clientId, attemptId }
      })
      if (committed?.state !== 'authorizing' || committed.attemptId !== attemptId) throw remoteAuthError('login-already-running')
      this.setState('unauthenticated')
      try {
        this.checkCurrent()
        const response = await this.deps.http.oauthForm(`${this.deps.instance.prefix}/oauth/authorize_device`, { client_id: clientId, scope: 'api' }, inner)
        this.checkCurrent()
        const data = getObject(response.body)
        if (response.status === 404 || response.status === 405) this.deviceFlow = false
        if (response.status !== 200 || !tokenValid(data?.['device_code']) || !tokenValid(data?.['user_code']) || !positive(data?.['expires_in'])) throw remoteAuthError('invalid-device-response')
        const userCode = data['user_code'], verificationUri = data['verification_uri']
        this.validateVerification(verificationUri, userCode, false)
        if (data['verification_uri_complete'] !== undefined) this.validateVerification(data['verification_uri_complete'], userCode, true)
        this.deviceFlow = true
        const expiresAt = expiry(this.now(), data['expires_in'])
        const intervalMs = positive(data['interval']) ? data['interval'] * 1000 : 5000
        if (!Number.isSafeInteger(intervalMs) || intervalMs > 2_147_483_647) throw remoteAuthError('invalid-device-response')
        this.logins.set(attemptId, { deviceCode: data['device_code'], userCode, expiresAt, intervalMs, controller: new AbortController() })
        return this.result({ attemptId, userCode, verificationUri: verificationUri as string, ...(typeof data['verification_uri_complete'] === 'string' ? { verificationUriComplete: data['verification_uri_complete'] } : {}), expiresAt, intervalMs })
      } catch (error) {
        await this.modify(current => current?.state === 'authorizing' && current.attemptId === attemptId ? { ...this.base(), state: 'reauth-required', clientId } : undefined, true)
        throw error
      }
    }, signal)
  }
  private validateVerification(raw: unknown, code: string, complete: boolean): void {
    if (typeof raw !== 'string' || /[\x00-\x20\x7f\\]/u.test(raw)) throw remoteAuthError('invalid-device-response')
    const rawPath = /^https:\/\/[^/]+(\/[^?#]*)(?:\?[^#]*)?$/i.exec(raw)?.[1]
    if (rawPath === undefined || rawPath.includes('%') || rawPath.includes('//') || rawPath.split('/').some(part => part === '.' || part === '..')) throw remoteAuthError('invalid-device-response')
    let url: URL
    try { url = new URL(raw) } catch { throw remoteAuthError('invalid-device-response') }
    const expected = new URL(this.deps.instance.instance)
    if (url.origin !== expected.origin || url.pathname !== `${this.deps.instance.prefix}/oauth/device` || url.hash || url.username || url.password) throw remoteAuthError('invalid-device-response')
    const entries = [...url.searchParams.entries()]
    if (complete ? entries.length !== 1 || entries[0]?.[0] !== 'user_code' || entries[0]?.[1] !== code : url.search !== '') throw remoteAuthError('invalid-device-response')
  }
  pollLogin(attemptId: string, signal: AbortSignal): Promise<ScopedRemoteResult<{ state: 'authenticated' }>> {
    const existing = this.polls.get(attemptId); if (existing !== undefined) return existing
    const login = this.logins.get(attemptId); if (login === undefined) return Promise.reject(remoteAuthError('unknown-attempt'))
    const task = this.run(async outer => {
      const inner = AbortSignal.any([outer, login.controller.signal]); const clientId = this.deps.instance.clientId ?? ''
      let interval = login.intervalMs
      try {
        for (;;) {
          if (this.now() >= login.expiresAt) throw remoteAuthError('device-code-expired')
          await this.wait(interval, inner); inner.throwIfAborted()
          this.checkCurrent()
          const response = await this.deps.http.oauthForm(`${this.deps.instance.prefix}/oauth/token`, { client_id: clientId, device_code: login.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, inner)
          this.checkCurrent()
          const body = getObject(response.body)
          if (body?.['error'] === 'authorization_pending') continue
          if (body?.['error'] === 'slow_down') { interval += 5000; continue }
          if (body?.['error'] === 'access_denied') throw remoteAuthError('access-denied')
          if (body?.['error'] === 'expired_token') throw remoteAuthError('device-code-expired')
          if (response.status !== 200 || !tokenValid(body?.['access_token']) || !positive(body?.['expires_in']) || (body?.['refresh_token'] !== undefined && !tokenValid(body['refresh_token']))) throw remoteAuthError('invalid-oauth-response')
          const accessToken = body['access_token']; const refreshToken = body['refresh_token']; const expiresAt = expiry(this.now(), body['expires_in'])
          // Validate identity before committing an OAuth token; no fallback on validation failure.
          await this.accept(accessToken, 'grant', inner, undefined, undefined, refreshToken !== undefined && this.deps.settings.refreshStoreExclusive)
          this.checkCurrent()
          const committed = await this.modify(current => current?.state === 'authorizing' && current.attemptId === attemptId && current.clientId === clientId ? { ...this.base(), state: 'authenticated', clientId, accessToken, expiresAt, ...(typeof refreshToken === 'string' ? { refreshToken } : {}) } : undefined)
          if (committed?.state !== 'authenticated' || committed.accessToken !== accessToken) { this.setState('invalid'); throw remoteAuthError('login-superseded') }
          // modifyRecord may emit record-updated synchronously, invalidating the
          // in-memory context. Re-adopt only after checking the committed binding.
          await this.accept(accessToken, 'grant', inner, undefined, undefined, refreshToken !== undefined && this.deps.settings.refreshStoreExclusive, committed.revision)
          return this.result({ state: 'authenticated' as const })
        }
      } catch (error) {
        this.setState('invalid')
        throw error
      } finally {
        if (!login.controller.signal.aborted || this.owner.signal.aborted) await this.modify(current => current?.state === 'authorizing' && current.attemptId === attemptId ? { ...this.base(), state: 'reauth-required', clientId } : undefined, true)
      }
    }, signal).finally(() => { this.logins.delete(attemptId); this.polls.delete(attemptId) })
    this.polls.set(attemptId, task); return task
  }
  cancelLogin(attemptId: string): Promise<ScopedRemoteResult<null>> {
    const login = this.logins.get(attemptId); if (login === undefined) return Promise.reject(remoteAuthError('unknown-attempt'))
    login.controller.abort()
    return this.run(async () => {
      await this.modify(current => current?.state === 'authorizing' && current.attemptId === attemptId ? { ...this.base(), state: 'signed-out' } : undefined)
      this.logins.delete(attemptId); this.setState('signed-out'); return this.result(null)
    })
  }
  signOut(signal: AbortSignal): Promise<ScopedRemoteResult<null>> {
    for (const login of this.logins.values()) login.controller.abort()
    return this.run(async () => { await this.selectionStore().write('auto'); await this.modify(() => ({ ...this.base(), state: 'signed-out' })); this.resetGlab(); this.adopted = undefined; this.invalidFingerprint = undefined; this.setState('signed-out'); return this.result(null) }, signal)
  }
  clearGrant(signal: AbortSignal): Promise<ScopedRemoteResult<null>> {
    for (const login of this.logins.values()) login.controller.abort()
    return this.run(async () => { this.checkCurrent(); await this.selectionStore().write('auto'); try { await this.deps.credentials.deleteRecord(gitLabGrantKey(this.deps.instance.instance)) } catch { throw remoteAuthError('store-write-failed') }; this.oauthCached = false; this.resetGlab(); this.adopted = undefined; this.invalidFingerprint = undefined; this.setState('unauthenticated'); return this.result(null) }, signal)
  }
  private async waitForRefresh(marker: Extract<GitLabGrant, { state: 'refreshing' }>, signal: AbortSignal): Promise<GitLabGrant | undefined> {
    const deadline = Math.min(marker.refreshExpiresAt, this.now() + this.deps.settings.refreshTtlMs)
    while (this.now() < deadline) {
      await this.wait(this.deps.settings.refreshPollMs, signal)
      const { grant } = await this.read()
      if (grant?.state !== 'refreshing' || grant.refreshId !== marker.refreshId) return grant
    }
    return this.modify(current => current?.state === 'refreshing' && current.refreshId === marker.refreshId && current.basedOnRevision === marker.basedOnRevision ? { ...this.base(), state: 'reauth-required', clientId: current.clientId } : undefined, true)
  }
  private async refresh(grant: Extract<GitLabGrant, { state: 'authenticated' }>, signal: AbortSignal): Promise<GitLabGrant | undefined> {
    if (grant.refreshToken === undefined || !this.deps.settings.refreshStoreExclusive) return this.modify(current => current?.state === 'authenticated' && current.revision === grant.revision ? { ...this.base(), state: 'reauth-required', clientId: current.clientId } : undefined)
    const refreshId = this.uuid(), refreshToken = grant.refreshToken
    const marker = await this.modify(current => current?.state === 'authenticated' && current.revision === grant.revision && current.refreshToken !== undefined ? { ...this.base(), state: 'refreshing', clientId: current.clientId, accessToken: current.accessToken, expiresAt: current.expiresAt, refreshToken: current.refreshToken, refreshId, basedOnRevision: grant.revision, refreshExpiresAt: Math.min(Number.MAX_SAFE_INTEGER, this.now() + this.deps.settings.refreshTtlMs) } : undefined)
    if (marker?.state !== 'refreshing' || marker.refreshId !== refreshId) return marker?.state === 'refreshing' ? this.waitForRefresh(marker, signal) : marker
    let next: { accessToken: string; expiresAt: number; refreshToken?: string }
    try {
      this.checkCurrent()
      const response = await this.deps.http.oauthForm(`${this.deps.instance.prefix}/oauth/token`, { client_id: grant.clientId, grant_type: 'refresh_token', refresh_token: refreshToken }, signal)
      this.checkCurrent()
      const body = getObject(response.body)
      if (response.status !== 200 || !tokenValid(body?.['access_token']) || !positive(body?.['expires_in']) || (body?.['refresh_token'] !== undefined && !tokenValid(body['refresh_token']))) throw remoteAuthError('invalid-refresh-response')
      next = { accessToken: body['access_token'], expiresAt: expiry(this.now(), body['expires_in']), ...(typeof body['refresh_token'] === 'string' ? { refreshToken: body['refresh_token'] } : {}) }
    } catch (error) {
      if (error instanceof GitRemoteHttpError && error.kind === 'not-sent') {
        await this.modify(current => current?.state === 'refreshing' && current.refreshId === refreshId && current.basedOnRevision === grant.revision ? { ...grant, revision: this.uuid() } : undefined, true)
        throw remoteAuthError('refresh-not-sent')
      }
      await this.modify(current => current?.state === 'refreshing' && current.refreshId === refreshId && current.basedOnRevision === grant.revision ? { ...this.base(), state: 'reauth-required', clientId: current.clientId } : undefined, true)
      return undefined
    }
    try {
      this.checkCurrent()
      const committed = await this.modify(current => current?.state === 'refreshing' && current.refreshId === refreshId && current.basedOnRevision === grant.revision ? { ...this.base(), state: 'authenticated', clientId: current.clientId, ...next } : undefined)
      if (committed?.state !== 'authenticated' || committed.accessToken !== next.accessToken) throw Error('superseded')
      return committed
    } catch { throw new GitRemoteError('git/remote-unavailable', 'git-remote: refresh committed remotely but not locally', { stage: 'complete', remoteUpdated: true, localCommitted: false }) }
  }
  async dispose(): Promise<void> {
    this.owner.abort(); this.glabOwner.abort(); this.glabProbe = undefined; this.generationOwner.abort(); for (const login of this.logins.values()) login.controller.abort()
    await Promise.allSettled([...this.pending]); this.logins.clear(); this.context = { state: 'unauthenticated' }; this.adopted = undefined
  }
}
