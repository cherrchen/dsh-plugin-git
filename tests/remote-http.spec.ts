import { describe, expect, it } from 'vitest'
import { GitRemoteHttp, GitRemoteHttpError, GitRemoteTransportNotSent, GIT_REMOTE_API_ORIGIN } from '../src/remote/http.ts'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return { impl, calls }
}

describe('remote http transport', () => {
  it('pins api role to the api origin and parses json', async () => {
    const { impl, calls } = fakeFetch(async () => jsonResponse(200, { ok: true }))
    const http = new GitRemoteHttp({ fetch: impl })
    const response = await http.request({ role: 'api', method: 'GET', path: '/user' })
    expect(calls[0]?.url).toBe(`${GIT_REMOTE_API_ORIGIN}/user`)
    expect(response.body).toEqual({ ok: true })
  })

  it.each(['/other/path', '//evil.example/x'])('rejects oauth role path %s', async (path) => {
    const { impl, calls } = fakeFetch(async () => jsonResponse(200, {}))
    const http = new GitRemoteHttp({ fetch: impl })
    await expect(http.request({ role: 'oauth', method: 'POST', path })).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(calls).toHaveLength(0)
  })

  it('rejects oauth redirects entirely', async () => {
    const { impl } = fakeFetch(async () => new Response(null, { status: 302, headers: { location: 'https://github.com/login' } }))
    const http = new GitRemoteHttp({ fetch: impl })
    await expect(http.oauthForm('/login/device/code', { client_id: 'x' })).rejects.toMatchObject({ kind: 'http', status: 302 })
  })

  it('follows api redirects inside the api origin and rejects foreign ones', async () => {
    const { impl, calls } = fakeFetch(async (url) =>
      url.endsWith('/start')
        ? new Response(null, { status: 302, headers: { location: `${GIT_REMOTE_API_ORIGIN}/next` } })
        : jsonResponse(200, { done: 1 }),
    )
    const http = new GitRemoteHttp({ fetch: impl })
    const response = await http.request({ role: 'api', method: 'GET', path: '/start' })
    expect(response.body).toEqual({ done: 1 })
    expect(calls.map((c) => c.url)).toEqual([`${GIT_REMOTE_API_ORIGIN}/start`, `${GIT_REMOTE_API_ORIGIN}/next`])
    const foreign = new GitRemoteHttp({
      fetch: fakeFetch(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })).impl,
    })
    await expect(foreign.request({ role: 'api', method: 'GET', path: '/start' })).rejects.toMatchObject({ kind: 'http', status: 302 })
  })

  it('exhausts the redirect budget after three hops', async () => {
    const { impl } = fakeFetch(async () => new Response(null, { status: 302, headers: { location: `${GIT_REMOTE_API_ORIGIN}/loop` } }))
    const http = new GitRemoteHttp({ fetch: impl })
    await expect(http.request({ role: 'api', method: 'GET', path: '/loop' })).rejects.toMatchObject({ kind: 'http' })
  })

  it('classifies caller abort, deadline timeout, generic transport failure, and confirmed-not-sent', async () => {
    const caller = new AbortController()
    caller.abort()
    const { impl, calls } = fakeFetch(async () => jsonResponse(200, {}))
    const http = new GitRemoteHttp({ fetch: impl })
    await expect(http.request({ role: 'api', method: 'GET', path: '/x', signal: caller.signal })).rejects.toMatchObject({ kind: 'cancelled' })
    expect(calls).toHaveLength(0)
    const hanging = new GitRemoteHttp({ fetch: (() => new Promise<Response>(() => {})) as typeof fetch, requestTimeoutMs: 20 })
    await expect(hanging.request({ role: 'api', method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'timeout' })
    const failing = new GitRemoteHttp({ fetch: (() => Promise.reject(new Error('socket died'))) as typeof fetch })
    await expect(failing.request({ role: 'api', method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'unknown' })
    const unsent = new GitRemoteHttp({ fetch: (() => Promise.reject(new GitRemoteTransportNotSent())) as typeof fetch })
    await expect(unsent.request({ role: 'api', method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'not-sent' })
  })

  it('enforces the response byte cap via content-length and body size', async () => {
    const tooLong = new GitRemoteHttp({
      fetch: fakeFetch(async () => new Response('x'.repeat(64), { status: 200, headers: { 'content-length': '9999' } })).impl,
      maxResponseBytes: 16,
    })
    await expect(tooLong.request({ role: 'api', method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'invalid-response' })
    const fat = new GitRemoteHttp({
      fetch: fakeFetch(async () => new Response('x'.repeat(64), { status: 200 })).impl,
      maxResponseBytes: 16,
    })
    await expect(fat.request({ role: 'api', method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('flags invalid json bodies as invalid-response', async () => {
    const http = new GitRemoteHttp({
      fetch: fakeFetch(async () => new Response('{nope', { status: 200, headers: { 'content-type': 'application/json' } })).impl,
    })
    await expect(http.request({ role: 'api', method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('sends oauth form posts only to the allowlisted endpoints', async () => {
    const { impl, calls } = fakeFetch(async () => jsonResponse(200, { access_token: 'x' }))
    const http = new GitRemoteHttp({ fetch: impl })
    await http.oauthForm('/login/oauth/access_token', { client_id: 'id', device_code: 'dc' })
    expect(calls[0]?.url).toBe('https://github.com/login/oauth/access_token')
    expect(String(calls[0]?.init.body)).toContain('device_code=dc')
    await expect(http.oauthForm('/repos/x', {})).rejects.toBeInstanceOf(GitRemoteHttpError)
  })
})


describe('response lifecycle', () => {
  it('times out a stalled response body after receiving headers', async () => {
    let cancelled = false
    const http = new GitRemoteHttp({ requestTimeoutMs: 15, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
    await expect(http.request({ role: 'api', method: 'GET', path: '/user' })).rejects.toMatchObject({ kind: 'timeout' })
    expect(cancelled).toBe(true)
  })
  it('accepts bodyless 304 and cancels oversized streams early', async () => {
    const cached = new GitRemoteHttp({ fetch: async () => new Response(null, { status: 304 }) })
    expect((await cached.request({ role: 'api', method: 'GET', path: '/user' })).status).toBe(304)
    let cancelled = false
    const http = new GitRemoteHttp({ maxResponseBytes: 2, fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)) }, cancel() { cancelled = true } })) })
    await expect(http.request({ role: 'api', method: 'GET', path: '/user' })).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(cancelled).toBe(true)
  })
})
