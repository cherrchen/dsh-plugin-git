/** Host-side credential/auth engine for the remote surface (ADR-0004 clauses 2–7). Not wired to RPC until S3. */

import { createHash, randomUUID } from 'node:crypto'
import type { CredentialKey, CredentialRef } from './credentials-types.ts'
import { AuthSelectionStore, authMethod, hasOAuthRecord } from './auth-selection.ts'
import { GitRemoteError, remoteAuthError } from './errors.ts'
import { GitRemoteHttp, GitRemoteHttpError } from './http.ts'
import { gitRemoteCredentialKey, gitRemoteCredentialRef, type GitRemoteCredentialService } from './credentials.ts'
import {
  GIT_REMOTE_HOST,
  grantRecord,
  parseGrantRecord,
  type GitRemoteGrant,
  type GitRemoteRefreshingGrant,
} from './grant.ts'
import type { ResolvedRemoteSettings } from './settings.ts'
import type { GitRemoteCapabilityOn, GitRemoteGeneration } from './types.ts'

export const GIT_REMOTE_GRANT_RECORD_KEY: CredentialKey = gitRemoteCredentialKey('dsh-plugin-git', 'github-com')
const REFS: readonly CredentialRef[] = [gitRemoteCredentialRef('GH_TOKEN'), gitRemoteCredentialRef('GITHUB_TOKEN')]

export interface GitRemoteSnapshot {
  readonly generation: GitRemoteGeneration
  readonly state: 'anonymous' | 'unauthenticated' | 'signed-out' | 'authenticated' | 'invalid'
  readonly source?: 'grant' | 'ref' | 'gh' | 'git-credential'
  readonly token?: string
  readonly refSource?: string
}

export interface GitRemoteAuthDeps {
  credentials: GitRemoteCredentialService
  http: GitRemoteHttp
  settings: ResolvedRemoteSettings
  discoverGh?: (signal: AbortSignal) => Promise<string | undefined>
  discoverGitCredential?: (signal: AbortSignal) => Promise<string | undefined>
  now?: () => number
  uuid?: () => string
  digest?: (value: string) => string
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

interface PendingLogin {
  readonly attemptId: string
  readonly deviceCode: string
  readonly intervalMs: number
  readonly expiresAt: number
  readonly controller: AbortController
}

function defaultDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => { cleanup(); reject(new GitRemoteError('git/remote-unavailable', 'git-remote: operation cancelled', { reason: 'cancelled' })) }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class GitRemoteAuth {
  private readonly credentials: GitRemoteCredentialService
  private readonly http: GitRemoteHttp
  private readonly settings: ResolvedRemoteSettings
  private readonly discoverGh?: (signal: AbortSignal) => Promise<string | undefined>
  private readonly discoverGitCredential?: (signal: AbortSignal) => Promise<string | undefined>
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly digest: (value: string) => string
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly instanceId: string
  private readonly selection: AuthSelectionStore
  private oauthCached = false
  private selectionRevision: string | undefined
  private revision = 0
  private context: { authState: GitRemoteSnapshot['state']; token?: string; fingerprint?: string; source?: GitRemoteSnapshot['source']; refSource?: string } = { authState: 'unauthenticated' }
  private invalidFingerprint: string | undefined
  private ghToken: string | undefined
  private readonly pending = new Set<Promise<unknown>>()
  private readonly polls = new Map<string, Promise<{ state: 'authenticated' }>>()
  private readonly pollCaptures = new Map<string, Set<(generation: GitRemoteGeneration) => void>>()
  private readonly logins = new Map<string, PendingLogin>()
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(deps: GitRemoteAuthDeps) {
    this.credentials = deps.credentials
    this.selection = new AuthSelectionStore(deps.credentials, GIT_REMOTE_GRANT_RECORD_KEY, 'github', 'https://github.com')
    this.http = deps.http
    this.settings = deps.settings
    if (deps.discoverGh !== undefined) this.discoverGh = deps.discoverGh
    if (deps.discoverGitCredential !== undefined) this.discoverGitCredential = deps.discoverGitCredential
    this.now = deps.now ?? Date.now
    this.uuid = deps.uuid ?? randomUUID
    this.digest = deps.digest ?? defaultDigest
    this.sleep = deps.sleep ?? defaultSleep
    this.instanceId = this.uuid()
  }

  private generation(): GitRemoteGeneration {
    return { instanceId: this.instanceId, revision: this.revision }
  }

  private bump(): void {
    this.revision += 1
  }

  private readonly controllers = new Set<AbortController>()

  private track<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new GitRemoteError('git/remote-unavailable', 'git-remote: auth engine is disposed', { reason: 'disposed' }))
    const controller = new AbortController()
    this.controllers.add(controller)
    const inner = controller.signal
    const onAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const task = work(inner).finally(() => {
      this.pending.delete(task)
      this.controllers.delete(controller)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    })
    this.pending.add(task)
    return task
  }

  private serialize<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<T> {
    return this.track((inner) => {
      const run = this.chain.then(() => {
        if (this.disposed || inner.aborted) {
          throw new GitRemoteError('git/remote-unavailable', 'git-remote: auth engine is disposed', { reason: 'disposed' })
        }
        return work(inner).then(value => { capture?.(this.generation()); return value })
      })
      this.chain = run.catch(() => {})
      return run
    }, signal)
  }

  private async selectedMethod() {
    const selected = await this.selection.read()
    if (selected.revision !== this.selectionRevision) {
      this.selectionRevision = selected.revision
      this.context = { authState: 'unauthenticated' }; this.ghToken = undefined; this.bump()
    }
    if (selected.method === 'cli') this.oauthCached = hasOAuthRecord(await this.credentials.readRecord(GIT_REMOTE_GRANT_RECORD_KEY))
    return selected.method
  }
  selectMethod(method: unknown, signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<GitRemoteSnapshot> {
    const selected = authMethod(method)
    // A method switch must not queue behind an in-flight device poll for the whole expiry window.
    for (const login of this.logins.values()) login.controller.abort()
    return this.serialize(async inner => {
      if (selected === 'cli' && this.discoverGh === undefined) throw remoteAuthError('cli-unavailable')
      await this.selection.write(selected)
      const snapshot = await this.establishCurrent(inner)
      return snapshot.source === 'grant' ? this.refreshCurrent(inner) : snapshot
    }, signal, capture)
  }
  logoutOAuth(signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<void> {
    for (const login of this.logins.values()) login.controller.abort()
    return this.serialize(async inner => {
      const selected = await this.selectedMethod()
      await this.modify(async () => ({ ...this.authBase(this.settings.clientId ?? 'unconfigured'), state: 'signed-out' }))
      this.invalidFingerprint = undefined; this.context = { authState: 'signed-out' }; this.bump()
      if (selected === 'cli') { this.context = { authState: 'unauthenticated' }; await this.establishCurrent(inner) }
    }, signal, capture)
  }
  private async resolveContext(signal: AbortSignal): Promise<GitRemoteSnapshot> {
    const selected = await this.selectedMethod()
    if (selected === 'cli') {
      if (this.context.authState === 'unauthenticated') return this.establishCurrent(signal)
      return this.ghToken === undefined ? this.markState('anonymous') : this.acceptToken(this.ghToken, 'gh')
    }
    const { grant, malformed } = await this.readGrantOrMalformed()
    if (malformed) return this.markState('invalid')
    if (grant !== undefined) {
      if (grant.state === 'refreshing') {
        const settled = await this.waitRefresh(grant, signal)
        if (settled !== undefined) {
          const follow = await this.readGrant()
          if (follow !== undefined) return this.fromGrant(follow)
        }
        return { generation: this.generation(), state: 'invalid' }
      }
      return this.fromGrant(grant)
    }
    if (selected === 'oauth') return this.markState('unauthenticated')
    for (const ref of REFS) {
      const resolved = await this.credentials.resolve(ref)
      if (resolved !== undefined) {
        return this.acceptToken(resolved.value, 'ref', resolved.source)
      }
    }
    if (this.context.source === 'git-credential' && this.context.token !== undefined) return this.fromContext()
    if (this.ghToken !== undefined) return this.acceptToken(this.ghToken, 'gh')
    if (this.context.authState === 'signed-out') return this.fromContext()
    if (this.context.authState !== 'anonymous' && this.context.authState !== 'unauthenticated') return this.markState('invalid')
    return this.markState('anonymous')
  }

  private fromGrant(grant: GitRemoteGrant): GitRemoteSnapshot {
    switch (grant.state) {
      case 'authenticated':
        if (grant.clientId !== this.settings.clientId) return this.markState('invalid')
        return this.acceptToken(grant.accessToken, 'grant')
      case 'refreshing':
        return this.markState('invalid')
      case 'authorizing':
      case 'signed-out':
      case 'reauth-required':
        return this.markState(grant.state === 'signed-out' ? 'signed-out' : 'invalid')
    }
  }

  private markState(state: GitRemoteSnapshot['state']): GitRemoteSnapshot {
    if (this.context.authState !== state || this.context.token !== undefined) {
      this.context = { authState: state }
      this.bump()
    }
    return this.fromContext()
  }

  private acceptToken(token: string, source: GitRemoteSnapshot['source'], refSource?: string): GitRemoteSnapshot {
    const fingerprint = this.digest(token)
    if (this.invalidFingerprint === fingerprint) {
      this.context = { authState: 'invalid' }
      return this.fromContext()
    }
    if (this.context.token !== token || this.context.fingerprint !== fingerprint || this.context.source !== source || this.context.authState !== 'authenticated') {
      this.context = { authState: 'authenticated', token, fingerprint, source, ...(refSource === undefined ? {} : { refSource }) }
      this.bump()
    }
    return this.fromContext()
  }

  private fromContext(): GitRemoteSnapshot {
    return {
      generation: this.generation(),
      state: this.context.authState,
      ...(this.context.source === undefined ? {} : { source: this.context.source }),
      ...(this.context.token === undefined ? {} : { token: this.context.token }),
      ...(this.context.refSource === undefined ? {} : { refSource: this.context.refSource }),
    }
  }

  private async readGrant(): Promise<GitRemoteGrant | undefined> {
    const record = await this.credentials.readRecord(GIT_REMOTE_GRANT_RECORD_KEY)
    this.oauthCached = hasOAuthRecord(record)
    const parsed = parseGrantRecord(record)
    if (!parsed.ok) return undefined
    return parsed.grant
  }

  private async readGrantOrMalformed(): Promise<{ grant?: GitRemoteGrant; malformed: boolean }> {
    const record = await this.credentials.readRecord(GIT_REMOTE_GRANT_RECORD_KEY)
    this.oauthCached = hasOAuthRecord(record)
    if (record === undefined) return { malformed: false }
    const parsed = parseGrantRecord(record)
    if (!parsed.ok) return { malformed: true }
    return { grant: parsed.grant, malformed: false }
  }

  retry(signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<GitRemoteSnapshot> {
    return this.serialize(async inner => { this.markState('unauthenticated'); this.ghToken = undefined; this.invalidFingerprint = undefined; return this.establishCurrent(inner) }, signal, capture)
  }

  establish(signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<GitRemoteSnapshot> {
    return this.serialize(inner => this.establishCurrent(inner), signal, capture)
  }

  private async establishCurrent(inner: AbortSignal): Promise<GitRemoteSnapshot> {
  const selected = await this.selectedMethod()
  if (selected === 'cli') {
    const token = await this.discoverGh?.(inner)
    this.ghToken = token
    return token === undefined ? this.markState('anonymous') : this.acceptToken(token, 'gh')
  }
  const { grant, malformed } = await this.readGrantOrMalformed()
  if (malformed) return this.markState('invalid')
  if (grant !== undefined) {
    if (grant.state === 'refreshing') {
      const settled = await this.waitRefresh(grant, inner)
      const follow = settled === undefined ? undefined : await this.readGrant()
      if (follow === undefined) return this.markState('invalid')
      return this.fromGrant(follow)
    }
    return this.fromGrant(grant)
  }
  if (selected === 'oauth') return this.markState('unauthenticated')
  for (const ref of REFS) {
    const resolved = await this.credentials.resolve(ref)
    if (resolved !== undefined) return this.acceptToken(resolved.value, 'ref', resolved.source)
  }
  if (this.discoverGh !== undefined) {
    const token = await this.discoverGh(inner)
    if (token !== undefined) {
      this.ghToken = token
      return this.acceptToken(token, 'gh')
    }
  }
  return this.markState('anonymous')

  }

  snapshot(signal: AbortSignal): Promise<GitRemoteSnapshot> {
    return this.serialize(async (inner) => {
      const snapshot = await this.resolveContext(inner)
      return snapshot.source === 'grant' ? this.refreshCurrent(inner) : snapshot
    }, signal)
  }

  markInvalid(snapshot: GitRemoteSnapshot): void {
    if (snapshot.generation.instanceId !== this.instanceId || snapshot.generation.revision !== this.revision) return
    if (snapshot.token !== undefined) this.invalidFingerprint = this.digest(snapshot.token)
    this.context = { authState: 'invalid' }
    this.bump()
  }

  private async modify(mutate: (current: GitRemoteGrant | undefined) => Promise<GitRemoteGrant | undefined> | GitRemoteGrant | undefined): Promise<GitRemoteGrant | undefined> {
    const record = await this.credentials.modifyRecord(GIT_REMOTE_GRANT_RECORD_KEY, async (current) => {
      const parsed = parseGrantRecord(current)
      const next = await mutate(parsed.ok ? parsed.grant : undefined)
      return next === undefined ? undefined : grantRecord(next)
    })
    this.oauthCached = hasOAuthRecord(record)
    const parsed = parseGrantRecord(record)
    return parsed.ok ? parsed.grant : undefined
  }

  private authBase(clientId: string): { v: 1; revision: string; host: string; clientId: string } {
    return { v: 1, revision: this.uuid(), host: GIT_REMOTE_HOST, clientId }
  }

  startLogin(signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<{ attemptId: string; userCode: string; verificationUri: string; expiresAt: number; intervalMs: number }> {
    const clientId = this.settings.clientId
    if (clientId === undefined) return Promise.reject(remoteAuthError('client-id-missing'))
    return this.serialize(async (inner) => {
      await this.selection.write('oauth')
      const preferred = await this.selection.read()
      if (preferred.method !== 'oauth') throw remoteAuthError('source-changed')
      this.selectionRevision = preferred.revision
      const attemptId = this.uuid()
      const committed = await this.modify(async (current) => {
        if (current?.state === 'authorizing') {
          // An authorizing record whose attempt died (restart/cancel) is stale; only a live attempt blocks login.
          const live = this.logins.get(current.attemptId)
          if (live !== undefined && !live.controller.signal.aborted) return undefined
        }
        return { ...this.authBase(clientId), state: 'authorizing', attemptId }
      })
      if (committed?.state !== 'authorizing' || committed.attemptId !== attemptId) {
        throw remoteAuthError('login-already-running')
      }
      try {
      const response = await this.http.oauthForm('/login/device/code', {
        client_id: clientId,
        scope: 'repo',
      }, inner)
      if (response.status !== 200) throw remoteAuthError('device-flow-failed')
      const body = response.body
      if (typeof body !== 'object' || body === null) throw remoteAuthError('invalid-device-response')
      const data = body as Record<string, unknown>
      const deviceCode = data['device_code']
      const userCode = data['user_code']
      const verificationUri = data['verification_uri']
      if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
        throw remoteAuthError('invalid-device-response')
      }
      let verification: URL
      try { verification = new URL(verificationUri) } catch { throw remoteAuthError('invalid-device-response') }
      if (verification.origin !== 'https://github.com' || verification.pathname !== '/login/device' || verification.search !== '' || verification.hash !== '' || verification.username !== '' || verification.password !== '') throw remoteAuthError('invalid-device-response')
      const expiresIn = typeof data['expires_in'] === 'number' ? data['expires_in'] : 900
      const interval = typeof data['interval'] === 'number' && data['interval'] > 0 ? data['interval'] : 5
      this.logins.set(attemptId, {
        attemptId,
        deviceCode,
        intervalMs: interval * 1000,
        expiresAt: this.now() + expiresIn * 1000,
        controller: new AbortController(),
      })
      return { attemptId, userCode, verificationUri, expiresAt: this.now() + expiresIn * 1000, intervalMs: interval * 1000 }
      } catch (error) {
        await this.modify(current => current?.state === 'authorizing' && current.attemptId === attemptId ? { ...this.authBase(current.clientId), state: 'reauth-required' } : undefined)
        throw error
      }
    }, signal, capture)
  }

  pollLogin(attemptId: string, signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<{ state: 'authenticated' }> {
    if (capture !== undefined) { const captures = this.pollCaptures.get(attemptId) ?? new Set(); captures.add(capture); this.pollCaptures.set(attemptId, captures) }
    const polling = this.polls.get(attemptId)
    if (polling !== undefined) return polling
    const login = this.logins.get(attemptId)
    if (login === undefined) { this.pollCaptures.delete(attemptId); return Promise.reject(remoteAuthError('unknown-attempt')) }
    const task = this.serialize(async (owned) => {
      const inner = AbortSignal.any([owned, login.controller.signal])
      const clientId = this.settings.clientId ?? ''
      let waitMs = login.intervalMs
      try {
      for (;;) {
        if (this.now() >= login.expiresAt) throw remoteAuthError('device-code-expired')
        await this.sleep(waitMs, inner)
        const response = await this.http.oauthForm('/login/oauth/access_token', {
          client_id: clientId,
          device_code: login.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }, inner)
        if (response.status !== 200 || typeof response.body !== 'object' || response.body === null) throw remoteAuthError('invalid-oauth-response')
        const body = response.body as Record<string, unknown>
        if (typeof body['access_token'] === 'string' && body['access_token'] !== '') {
          const committed = await this.modify(async (current) => {
            if (current?.state !== 'authorizing' || current.attemptId !== attemptId) return undefined
            return {
              ...this.authBase(clientId),
              state: 'authenticated',
              accessToken: body['access_token'] as string,
              ...(typeof body['refresh_token'] === 'string' ? { refreshToken: body['refresh_token'] } : {}),
              ...(typeof body['token_type'] === 'string' ? { tokenType: body['token_type'] } : {}),
              ...(typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}),
              ...(typeof body['expires_in'] === 'number' ? { expiresAt: this.now() + (body['expires_in'] as number) * 1000 } : {}),
            }
          })
          if (committed?.state !== 'authenticated') throw remoteAuthError('login-superseded')
          this.logins.delete(attemptId)
          this.acceptToken(body['access_token'], 'grant')
          return { state: 'authenticated' as const }
        }
        const error = body['error']
        if (error === 'authorization_pending') continue
        if (error === 'slow_down') { waitMs += 5000; continue }
        if (error === 'expired_token') throw remoteAuthError('device-code-expired')
        if (error === 'access_denied') throw remoteAuthError('access-denied')
        throw remoteAuthError('device-flow-failed')
      }
      } finally {
        if (!login.controller.signal.aborted) {
          await this.modify(current => current?.state === 'authorizing' && current.attemptId === attemptId ? { ...this.authBase(current.clientId), state: 'reauth-required' } : undefined)
        }
      }
    }, signal, generation => { for (const capture of this.pollCaptures.get(attemptId) ?? []) capture(generation) }).finally(() => { this.logins.delete(attemptId); this.polls.delete(attemptId); this.pollCaptures.delete(attemptId) })
    this.polls.set(attemptId, task)
    return task
  }

  ownsLogin(attemptId: string): boolean { return this.logins.has(attemptId) }

  async cancelLogin(attemptId: string, capture?: (generation: GitRemoteGeneration) => void): Promise<void> {
    const login = this.logins.get(attemptId)
    login?.controller.abort()
    await this.serialize(() => this.modify(async (current) => {
      if (current?.state === 'authorizing' && current.attemptId === attemptId) {
        return { ...this.authBase(current.clientId), state: 'signed-out' }
      }
      return undefined
    }), undefined, capture)
    this.logins.delete(attemptId)
  }

  signOut(signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<void> {
    for (const login of this.logins.values()) login.controller.abort()
    return this.serialize(async () => {
      await this.selection.write('auto')
      const grant = await this.readGrant()
      const clientId = grant?.clientId ?? this.settings.clientId ?? 'unconfigured'
      await this.modify(async () => ({ ...this.authBase(clientId), state: 'signed-out' }))
      this.invalidFingerprint = undefined; this.context = { authState: 'signed-out' }
      this.bump()
    }, signal, capture)
  }

  async clearLocalGrant(signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<void> {
    await this.serialize(async () => {
      await this.selection.write('auto')
      await this.credentials.deleteRecord(GIT_REMOTE_GRANT_RECORD_KEY)
      this.oauthCached = false
      this.invalidFingerprint = undefined
      this.context = { authState: 'unauthenticated' }
      this.ghToken = undefined
      this.bump()
    }, signal, capture)
  }

  useGitCredential(signal: AbortSignal, capture?: (generation: GitRemoteGeneration) => void): Promise<GitRemoteSnapshot> {
    const discover = this.discoverGitCredential
    if (discover === undefined) return Promise.reject(remoteAuthError('git-credential-unavailable'))
    return this.serialize(async (inner) => {
      const token = await discover(inner)
      if (token === undefined) throw remoteAuthError('git-credential-missing')
      return this.acceptToken(token, 'git-credential')
    }, signal, capture)
  }

  async capability(): Promise<GitRemoteCapabilityOn> {
    const info = await this.credentials.describeRecord(GIT_REMOTE_GRANT_RECORD_KEY)
    return {
      state: 'on',
      authSelection: this.selection.capability(this.discoverGh !== undefined, info.configured && this.oauthCached),
      generation: this.generation(),
      credential: { configured: info.configured, writable: info.writable },
      auth: {
        state: this.context.authState === 'anonymous' ? 'anonymous' : this.context.authState,
        ...(this.context.source === undefined ? {} : { source: this.context.source }),
      },
      actions: { canComment: 'unknown', canReview: 'unknown', canMerge: 'unknown', canClose: 'unknown', canCreatePr: 'unknown' },
      loginAvailable: this.settings.clientId !== undefined,
      automaticRefreshAvailable: this.settings.refreshStoreExclusive,
    }
  }

  private async waitRefresh(marker: GitRemoteRefreshingGrant, signal: AbortSignal): Promise<GitRemoteGrant | undefined> {
    const deadline = Math.min(marker.refreshExpiresAt, this.now() + this.settings.refreshTtlMs)
    for (;;) {
      if (this.now() >= deadline) {
        const transitioned = await this.modify(async (current) => {
          if (current?.state === 'refreshing' && current.refreshId === marker.refreshId && current.basedOnRevision === marker.basedOnRevision) {
            return { ...this.authBase(current.clientId), state: 'reauth-required' }
          }
          return undefined
        })
        if (transitioned === undefined || transitioned.state !== 'reauth-required') {
          const current = await this.readGrant()
          return current === undefined || current.state === 'refreshing' ? undefined : current
        }
        return transitioned
      }
      await this.sleep(this.settings.refreshPollMs, signal)
      const current = await this.readGrant()
      if (current === undefined || current.state !== 'refreshing' || current.refreshId !== marker.refreshId) return current
    }
  }

  refresh(snapshot: GitRemoteSnapshot, signal: AbortSignal): Promise<GitRemoteSnapshot> {
    return this.serialize((inner) => this.refreshCurrent(inner), signal)
  }

  private async refreshCurrent(inner: AbortSignal): Promise<GitRemoteSnapshot> {
      const grant = await this.readGrant()
      if (grant?.state !== 'authenticated') {
        if (grant?.state === 'refreshing') {
          const settled = await this.waitRefresh(grant, inner)
          if (settled === undefined) return this.markState('invalid')
          return this.fromGrant(settled)
        }
        return grant === undefined ? this.markState('invalid') : this.fromGrant(grant)
      }
      if (grant.clientId !== this.settings.clientId) return this.markState('invalid')
      if (grant.expiresAt === undefined || grant.expiresAt > this.now()) return this.fromGrant(grant)
      if (grant.refreshToken === undefined || !this.settings.refreshStoreExclusive) {
        const committed = await this.modify(async (current) => {
          if (current?.state === 'authenticated' && current.revision === grant.revision) {
            return { ...this.authBase(current.clientId), state: 'reauth-required' }
          }
          return undefined
        })
        if (committed?.state === 'reauth-required') return this.markState('invalid')
        const current = await this.readGrant()
        return current === undefined ? this.markState('invalid') : this.fromGrant(current)
      }
      const refreshId = this.uuid()
      const marker = await this.modify(async (current) => {
        if (current?.state === 'authenticated' && current.revision === grant.revision) {
          return {
            ...this.authBase(current.clientId),
            state: 'refreshing',
            accessToken: current.accessToken,
            refreshToken: current.refreshToken ?? '',
            ...(current.tokenType === undefined ? {} : { tokenType: current.tokenType }),
            ...(current.scope === undefined ? {} : { scope: current.scope }),
            ...(current.expiresAt === undefined ? {} : { expiresAt: current.expiresAt }),
            ...(current.userId === undefined ? {} : { userId: current.userId }),
            ...(current.login === undefined ? {} : { login: current.login }),
            refreshId,
            basedOnRevision: grant.revision,
            refreshExpiresAt: this.now() + this.settings.refreshTtlMs,
          }
        }
        return undefined
      })
      if (marker?.state !== 'refreshing' || marker.refreshId !== refreshId) {
        const current = await this.readGrant()
        if (current === undefined) return this.markState('invalid')
        if (current.state === 'refreshing') {
          const settled = await this.waitRefresh(current, inner)
          return settled === undefined ? this.markState('invalid') : this.fromGrant(settled)
        }
        return this.fromGrant(current)
      }
      let pair: { accessToken: string; refreshToken?: string; expiresAt?: number; tokenType?: string; scope?: string } | undefined
      let notSent = false
      try {
        const response = await this.http.oauthForm('/login/oauth/access_token', {
          client_id: this.settings.clientId ?? '',
          grant_type: 'refresh_token',
          refresh_token: grant.refreshToken,
        }, inner)
        if (response.status !== 200 || typeof response.body !== 'object' || response.body === null) throw remoteAuthError('invalid-oauth-response')
        const body = response.body as Record<string, unknown>
        if (typeof body['access_token'] !== 'string' || body['access_token'] === '') {
          throw remoteAuthError('invalid-refresh-response')
        }
        pair = {
          accessToken: body['access_token'],
          ...(typeof body['refresh_token'] === 'string' ? { refreshToken: body['refresh_token'] } : {}),
          ...(typeof body['expires_in'] === 'number' ? { expiresAt: this.now() + (body['expires_in'] as number) * 1000 } : {}),
          ...(typeof body['token_type'] === 'string' ? { tokenType: body['token_type'] } : {}),
          ...(typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}),
        }
      } catch (error) {
        if (error instanceof GitRemoteHttpError && error.kind === 'not-sent') {
          notSent = true
        } else {
          await this.modify(async (current) => {
            if (current?.state === 'refreshing' && current.refreshId === refreshId) {
              return { ...this.authBase(current.clientId), state: 'reauth-required' }
            }
            return undefined
          })
          return this.markState('invalid')
        }
      }
      if (notSent || pair === undefined) {
        const restored = await this.modify(async (current) => {
          if (current?.state === 'refreshing' && current.refreshId === refreshId) {
            return {
              ...this.authBase(current.clientId),
              state: 'authenticated',
              accessToken: grant.accessToken,
              refreshToken: grant.refreshToken ?? '',
              ...(grant.tokenType === undefined ? {} : { tokenType: grant.tokenType }),
              ...(grant.scope === undefined ? {} : { scope: grant.scope }),
              ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
              ...(grant.userId === undefined ? {} : { userId: grant.userId }),
              ...(grant.login === undefined ? {} : { login: grant.login }),
            }
          }
          return undefined
        })
        if (restored?.state === 'authenticated') return this.acceptToken(grant.accessToken, 'grant')
        return this.markState('invalid')
      }
      const pairValue = pair
      let committed: GitRemoteGrant | undefined
      try {
        committed = await this.modify(async (current) => {
          if (current?.state === 'refreshing' && current.refreshId === refreshId && current.basedOnRevision === grant.revision) {
            return {
              ...this.authBase(current.clientId),
              state: 'authenticated',
              accessToken: pairValue.accessToken,
              ...(pairValue.refreshToken === undefined ? (grant.refreshToken === undefined ? {} : { refreshToken: grant.refreshToken }) : { refreshToken: pairValue.refreshToken }),
              ...(pairValue.tokenType === undefined ? {} : { tokenType: pairValue.tokenType }),
              ...(pairValue.scope === undefined ? {} : { scope: pairValue.scope }),
              ...(pairValue.expiresAt === undefined ? {} : { expiresAt: pairValue.expiresAt }),
              ...(grant.userId === undefined ? {} : { userId: grant.userId }),
              ...(grant.login === undefined ? {} : { login: grant.login }),
            }
          }
          return undefined
        })
      } catch {
        throw new GitRemoteError('git/remote-unavailable', 'git-remote: refresh committed remotely but not locally', { stage: 'complete', remoteUpdated: true, localCommitted: false })
      }
      if (committed?.state !== 'authenticated') {
        throw new GitRemoteError('git/remote-unavailable', 'git-remote: refresh committed remotely but not locally', { stage: 'complete', remoteUpdated: true, localCommitted: false })
      }
      return this.acceptToken(pairValue.accessToken, 'grant')
  }

  private disposal: Promise<void> | undefined
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    for (const login of this.logins.values()) login.controller.abort()
    for (const controller of this.controllers) controller.abort()
    this.disposal = (async () => {
    await Promise.allSettled([...this.pending])
    this.logins.clear()
    this.polls.clear()
    this.pollCaptures.clear()
    this.context = { authState: 'unauthenticated' }
    this.ghToken = undefined
    this.invalidFingerprint = undefined
    })()
    return this.disposal
  }
}
