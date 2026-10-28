/** Injectable, origin-pinned HTTP transport for OAuth now and GitHub REST later (ADR-0004 clause 8). */

import { GitRemoteError } from './errors.ts'
import { canonicalGitLabInstance } from './instances.ts'
import { gitLabBranchLookupPath, gitLabProjectLookupPath } from './gitlab-read-boundaries.ts'

export const GIT_REMOTE_API_ORIGIN = 'https://api.github.com'
export const GIT_REMOTE_WEB_ORIGIN = 'https://github.com'
const OAUTH_PATHS = new Set(['/login/device/code', '/login/oauth/access_token'])

export type GitRemoteHttpKind = 'cancelled' | 'timeout' | 'invalid-response' | 'http' | 'unknown' | 'not-sent'

export class GitRemoteHttpError extends GitRemoteError {
  constructor(
    readonly kind: GitRemoteHttpKind,
    message: string,
    readonly status?: number,
  ) {
    super('git/remote-unavailable', message, { kind, ...(status === undefined ? {} : { status }) })
    this.name = 'GitRemoteHttpError'
  }
}

export class GitRemoteTransportNotSent extends Error {
  readonly confirmedNotSent = true
}

export interface GitRemoteHttpResponse {
  readonly status: number
  readonly body: unknown
  readonly headers: { get(name: string): string | null }
}

export interface GitRemoteHttpResponseLike {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body?: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export type GitRemoteFetchImpl = (url: string, init: {
  method: string
  headers: Record<string, string> | undefined
  body: string | undefined
  redirect: 'manual'
  signal: AbortSignal
}) => Promise<GitRemoteHttpResponseLike>

export interface GitRemoteHttpDeps {
  fetch?: GitRemoteFetchImpl
  requestTimeoutMs?: number
  maxResponseBytes?: number
  now?: () => number
  /** Explicitly configured GitLab instance; omitted for the GitHub v1 policy. */
  gitlabInstance?: string
}

const defaultFetch: GitRemoteFetchImpl = async (url, init) => {
  const response = await fetch(url, { ...init, body: init.body ?? null, headers: init.headers ?? {} })
  return response as GitRemoteHttpResponseLike
}


/** Conservative v2 boundary. GL2 must add project/query-scoped cursor validation before paging. */
function safeGitLabPath(raw: string, prefix: string): boolean {
  if (/[\\%#\x00-\x20\x7f]/u.test(raw)) return false
  const path = raw.startsWith('https://') ? raw.slice(raw.indexOf('/', 'https://'.length)) : raw
  const pathname = path.split('?')[0] ?? ''
  if (!pathname.startsWith(`${prefix}/api/v4/`) || pathname.includes('//')) return false
  return !pathname.split('/').some(segment => segment === '.' || segment === '..')
}

/** Observed GitLab route echoes and defaults, limited to the endpoint that owns them. */
function gitLabPaginationAdditions(path: string): Readonly<Record<string, string>> {
  const match = /^\/api\/v4\/projects\/([1-9][0-9]*)\/(merge_requests|issues)(?:\/([1-9][0-9]*)\/(notes|discussions|commits|diffs))?$/u.exec(path)
  if (match === null) return {}
  const [, project, kind, number, collection] = match
  if ((collection === 'commits' || collection === 'diffs') && kind !== 'merge_requests') return {}
  const additions: Record<string, string> = { id: project! }
  if (collection === undefined) {
    Object.assign(additions, { order_by: 'created_at', sort: 'desc', with_labels_details: 'false' })
    if (kind === 'merge_requests') additions['with_merge_status_recheck'] = 'false'
  } else if (collection === 'notes' || collection === 'discussions') {
    additions['noteable_id'] = number!
    if (collection === 'notes') Object.assign(additions, { activity_filter: 'all_notes', order_by: 'created_at', sort: 'desc' })
  } else {
    additions['merge_request_iid'] = number!
    if (collection === 'diffs') additions['unidiff'] = 'false'
  }
  return additions
}

/** Validate server metadata, then construct the continuation from the original Host query. */
export function gitLabContinuation(instance: string, currentPath: string, next: string, direction: 'next' | 'any' = 'next'): string {
  const base = new URL(canonicalGitLabInstance(instance))
  const prefix = base.pathname === '/' ? '' : base.pathname
  if (!safeGitLabPath(currentPath, prefix) || !safeGitLabPath(next, prefix)) throw new GitRemoteHttpError('invalid-response', 'git-remote: continuation is outside the api scope')
  let current: URL, target: URL
  try { current = new URL(currentPath, base.origin); target = new URL(next, base.origin) } catch { throw new GitRemoteHttpError('invalid-response', 'git-remote: invalid continuation') }
  if (current.origin !== base.origin || target.origin !== base.origin || target.username || target.password || target.hash || target.pathname !== current.pathname) throw new GitRemoteHttpError('invalid-response', 'git-remote: continuation changed scope')
  const normalized = new URLSearchParams(target.search)
  for (const [key, expected] of Object.entries(gitLabPaginationAdditions(current.pathname.slice(prefix.length)))) {
    // An explicit request value remains authoritative, including a nondefault value.
    if (current.searchParams.has(key) || !normalized.has(key)) continue
    const values = normalized.getAll(key)
    if (values.length !== 1 || values[0] !== expected) throw new GitRemoteHttpError('invalid-response', 'git-remote: continuation changed query')
    normalized.delete(key)
  }
  const compare = (params: URLSearchParams) => [...params.entries()].filter(([key]) => key !== 'page').sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
  const pages = target.searchParams.getAll('page')
  const currentPages = current.searchParams.getAll('page')
  const nextPage = Number(pages[0]), currentPage = currentPages.length === 0 ? 1 : Number(currentPages[0])
  if (pages.length !== 1 || !/^[1-9][0-9]*$/.test(pages[0] ?? '') || !Number.isSafeInteger(nextPage) || currentPages.length > 1 || (currentPages.length === 1 && !/^[1-9][0-9]*$/.test(currentPages[0] ?? '')) || !Number.isSafeInteger(currentPage) || (direction === 'next' && nextPage !== currentPage + 1) || JSON.stringify(compare(normalized)) !== JSON.stringify(compare(current.searchParams))) throw new GitRemoteHttpError('invalid-response', 'git-remote: continuation changed query')
  current.searchParams.set('page', pages[0]!)
  return current.pathname + current.search
}

export class GitRemoteHttp {
  private readonly impl: GitRemoteFetchImpl
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly gitlab?: { origin: string; prefix: string }

  constructor(deps: GitRemoteHttpDeps = {}) {
    this.impl = deps.fetch ?? defaultFetch
    this.timeoutMs = deps.requestTimeoutMs ?? 15_000
    this.maxBytes = deps.maxResponseBytes ?? 4 * 1024 * 1024
    if (deps.gitlabInstance !== undefined) {
      const parsed = new URL(canonicalGitLabInstance(deps.gitlabInstance))
      this.gitlab = { origin: parsed.origin, prefix: parsed.pathname === '/' ? '' : parsed.pathname }
    }
  }

  async request(options: {
    role: 'api' | 'oauth'
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    timeoutMs?: number
    onSend?: () => void
  }, boundLookup?: { readonly kind: 'project'; readonly path: string } | { readonly kind: 'branch'; readonly projectId: string; readonly branch: string }): Promise<GitRemoteHttpResponse> {
    const policy = this.gitlab
    const origin = policy?.origin ?? (options.role === 'api' ? GIT_REMOTE_API_ORIGIN : GIT_REMOTE_WEB_ORIGIN)
    if (!options.path.startsWith('/') || options.path.startsWith('//')) {
      throw new GitRemoteHttpError('invalid-response', 'git-remote: request path must be an origin-relative path')
    }
    if (options.role === 'oauth') {
      const allowed = policy === undefined ? OAUTH_PATHS : new Set([`${policy.prefix}/oauth/authorize_device`, `${policy.prefix}/oauth/token`])
      if (!allowed.has(options.path) || (policy !== undefined && Object.keys(options.headers ?? {}).some(key => key.toLowerCase() === 'authorization'))) {
        throw new GitRemoteHttpError('invalid-response', 'git-remote: oauth request is not allowlisted')
      }
    }
    let exactLookup: string | undefined
    if (boundLookup !== undefined && policy !== undefined && options.role === 'api' && options.method === 'GET') {
      try { exactLookup = boundLookup.kind === 'project' ? gitLabProjectLookupPath(policy.prefix, boundLookup.path) : gitLabBranchLookupPath(policy.prefix, boundLookup.projectId, boundLookup.branch) } catch { /* rejected below */ }
      if (exactLookup !== options.path) exactLookup = undefined
    }
    if (policy !== undefined && options.role === 'api' && !safeGitLabPath(options.path, policy.prefix) && (exactLookup === undefined || options.path !== exactLookup)) {
      throw new GitRemoteHttpError('invalid-response', 'git-remote: api path is outside the instance boundary')
    }
    let url = origin + options.path
    const initial = new URL(url)
    const controller = new AbortController()
    const caller = options.signal
    if (caller?.aborted) throw new GitRemoteHttpError('cancelled', 'git-remote: request cancelled')
    const onCallerAbort = () => controller.abort()
    caller?.addEventListener('abort', onCallerAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? this.timeoutMs)
    const signal = controller.signal
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new GitRemoteHttpError(timedOut ? 'timeout' : 'cancelled', 'git-remote: request interrupted'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      for (let hops = 0; hops <= 3; hops += 1) {
        if (signal.aborted) throw new GitRemoteHttpError('cancelled', 'git-remote: request cancelled before send')
        options.onSend?.()
        const response = await Promise.race([
          this.impl(url, { method: options.method, headers: options.headers, body: options.body, redirect: 'manual', signal }),
          aborted,
        ])
        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
          void response.body?.cancel().catch(() => {})
          if (options.role === 'oauth' || options.method !== 'GET') throw new GitRemoteHttpError('http', 'git-remote: endpoint must not redirect', response.status)
          const location = response.headers.get('location')
          let target: URL
          try { target = new URL(location ?? '', url) } catch { throw new GitRemoteHttpError('http', 'git-remote: invalid redirect', response.status) }
          const allowedOrigin = policy?.origin ?? GIT_REMOTE_API_ORIGIN
          const exactLookupRedirect = exactLookup !== undefined && (location === exactLookup || location === policy?.origin + exactLookup) && target.pathname === exactLookup && target.search === ''
          if (location === null || target.origin !== allowedOrigin || target.username !== '' || target.password !== '' || target.hash !== '' ||
              (policy !== undefined && !exactLookupRedirect && (!safeGitLabPath(location, policy.prefix) || !safeGitLabPath(target.pathname + target.search, policy.prefix) || target.pathname !== initial.pathname || target.search !== initial.search))) {
            throw new GitRemoteHttpError('http', 'git-remote: redirect outside the api scope rejected', response.status)
          }
          url = target.href
          continue
        }
        const lengthHeader = response.headers.get('content-length')
        if (lengthHeader !== null && Number(lengthHeader) > this.maxBytes) {
          void response.body?.cancel().catch(() => {})
          throw new GitRemoteHttpError('invalid-response', 'git-remote: response exceeds the byte cap', response.status)
        }
        let buffer: ArrayBuffer
        if (response.body != null) {
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let size = 0
          try {
            for (;;) {
              const next = await Promise.race([reader.read(), aborted])
              if (next.done) break
              size += next.value.byteLength
              if (size > this.maxBytes) throw new GitRemoteHttpError('invalid-response', 'git-remote: response exceeds the byte cap', response.status)
              chunks.push(next.value)
            }
          } finally {
            void reader.cancel().catch(() => {})
            reader.releaseLock()
          }
          const joined = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
          buffer = joined.buffer
        } else {
          buffer = await Promise.race([response.arrayBuffer(), aborted])
        }
        if (buffer.byteLength > this.maxBytes) throw new GitRemoteHttpError('invalid-response', 'git-remote: response exceeds the byte cap', response.status)
        const text = new TextDecoder().decode(buffer)
        let body: unknown = text
        if (text !== '' && (response.headers.get('content-type') ?? '').includes('application/json')) {
          try { body = JSON.parse(text) } catch { throw new GitRemoteHttpError('invalid-response', 'git-remote: response body is not valid json', response.status) }
        }
        return { status: response.status, body, headers: response.headers }
      }
      throw new GitRemoteHttpError('http', 'git-remote: redirect budget exhausted')
    } catch (error) {
      if (error instanceof GitRemoteHttpError) throw error
      if (error instanceof GitRemoteTransportNotSent) throw new GitRemoteHttpError('not-sent', 'git-remote: transport confirmed the request was not sent')
      if (signal.aborted) throw new GitRemoteHttpError(timedOut ? 'timeout' : 'cancelled', 'git-remote: request interrupted')
      throw new GitRemoteHttpError('unknown', 'git-remote: transport failure; send status unknown')
    } finally {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  async oauthForm(path: string, fields: Record<string, string>, signal?: AbortSignal): Promise<GitRemoteHttpResponse> {
    return this.request({
      role: 'oauth',
      method: 'POST',
      path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /** Encode exactly one already-authorized project path, without relaxing the API policy. */
  async gitLabProjectLookup(path: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<GitRemoteHttpResponse> {
    if (this.gitlab === undefined) throw new GitRemoteHttpError('invalid-response', 'git-remote: GitLab instance required')
    let requestPath: string
    try { requestPath = gitLabProjectLookupPath(this.gitlab.prefix, path) } catch { throw new GitRemoteHttpError('invalid-response', 'git-remote: invalid project path') }
    return this.request({ role: 'api', method: 'GET', path: requestPath, ...(headers === undefined ? {} : { headers }), ...(signal === undefined ? {} : { signal }) }, { kind: 'project', path })
  }

  /** The project id must first be resolved against an allowed local remote. */
  async gitLabBranchLookup(projectId: string, branch: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<GitRemoteHttpResponse> {
    if (this.gitlab === undefined) throw new GitRemoteHttpError('invalid-response', 'git-remote: GitLab instance required')
    let requestPath: string
    try { requestPath = gitLabBranchLookupPath(this.gitlab.prefix, projectId, branch) } catch { throw new GitRemoteHttpError('invalid-response', 'git-remote: invalid branch path') }
    return this.request({ role: 'api', method: 'GET', path: requestPath, ...(headers === undefined ? {} : { headers }), ...(signal === undefined ? {} : { signal }) }, { kind: 'branch', projectId, branch })
  }
}
