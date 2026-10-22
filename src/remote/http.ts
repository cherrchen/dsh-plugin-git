/** Injectable, origin-pinned HTTP transport for OAuth now and GitHub REST later (ADR-0004 clause 8). */

import { GitRemoteError } from './errors.ts'

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
}

const defaultFetch: GitRemoteFetchImpl = async (url, init) => {
  const response = await fetch(url, { ...init, body: init.body ?? null, headers: init.headers ?? {} })
  return response as GitRemoteHttpResponseLike
}

export class GitRemoteHttp {
  private readonly impl: GitRemoteFetchImpl
  private readonly timeoutMs: number
  private readonly maxBytes: number

  constructor(deps: GitRemoteHttpDeps = {}) {
    this.impl = deps.fetch ?? defaultFetch
    this.timeoutMs = deps.requestTimeoutMs ?? 15_000
    this.maxBytes = deps.maxResponseBytes ?? 4 * 1024 * 1024
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
  }): Promise<GitRemoteHttpResponse> {
    const origin = options.role === 'api' ? GIT_REMOTE_API_ORIGIN : GIT_REMOTE_WEB_ORIGIN
    if (options.role === 'oauth' && !OAUTH_PATHS.has(options.path)) {
      throw new GitRemoteHttpError('invalid-response', `git-remote: oauth path is not allowlisted (${options.path})`)
    }
    if (!options.path.startsWith('/') || options.path.startsWith('//')) {
      throw new GitRemoteHttpError('invalid-response', 'git-remote: request path must be an origin-relative path')
    }
    let url = origin + options.path
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
          if (location === null || target.origin !== GIT_REMOTE_API_ORIGIN || target.username !== '' || target.password !== '') {
            throw new GitRemoteHttpError('http', 'git-remote: redirect outside the api origin rejected', response.status)
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
}
