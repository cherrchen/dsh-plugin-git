import { describe, expect, it } from 'vitest'
import { GitRemoteHttp, gitLabContinuation } from '../src/remote/http.ts'

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
describe('GitLab HTTP isolation', () => {
  it('sends device and token forms only to the configured prefix without bearer', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch: async (url, init) => { calls.push({ url, init }); return json({}) } })
    await http.oauthForm('/gitlab/oauth/authorize_device', { client_id: 'app', scope: 'api' })
    await http.oauthForm('/gitlab/oauth/token', { client_id: 'app', grant_type: 'refresh_token' })
    expect(calls.map(c => c.url)).toEqual(['https://git.example.com/gitlab/oauth/authorize_device', 'https://git.example.com/gitlab/oauth/token'])
    expect(calls.every(c => !Object.keys(c.init.headers ?? {}).some(k => k.toLowerCase() === 'authorization'))).toBe(true)
    await expect(http.oauthForm('/oauth/token', {})).rejects.toMatchObject({ kind: 'invalid-response' })
    await expect(http.request({ role: 'oauth', method: 'POST', path: '/gitlab/oauth/token', headers: { Authorization: 'secret' } })).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it.each(['https://other.example/gitlab/api/v4/user', '/api/v4/user', '/gitlab/api/v4/../user', '/gitlab/api/v4/%2e%2e/user', '/gitlab/api/v4/users', '/gitlab/api/v4/user?other=1'])('rejects redirect outside exact initialized scope: %s', async location => {
    let calls = 0
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location } }) } })
    await expect(http.request({ role: 'api', method: 'GET', path: '/gitlab/api/v4/user', headers: { authorization: 'Bearer sentinel' } })).rejects.toMatchObject({ kind: 'http' })
    expect(calls).toBe(1)
  })
  it('rejects encoded or wrong-prefix API requests before send', async () => {
    let calls = 0
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch: async () => { calls++; return json({}) } })
    for (const path of ['/api/v4/user', '/gitlab/api/v4/%2f', '/gitlab/api/v4/a/../user']) await expect(http.request({ role: 'api', method: 'GET', path })).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(calls).toBe(0)
  })
})


it('validates continuation origin, prefix, path and all non-page query values', () => {
  const instance = 'https://git.example.com/gitlab', current = '/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=1'
  expect(gitLabContinuation(instance, current, 'https://git.example.com/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=2')).toBe('/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=2')
  for (const next of [
    'https://evil.example/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=2',
    '/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=2',
    '/gitlab/api/v4/projects/43/merge_requests?state=opened&per_page=50&page=2',
    '/gitlab/api/v4/projects/42/merge_requests?state=closed&per_page=50&page=2',
    '/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=51&page=2',
    '/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=2&page=3',
    '/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=1',
    '/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=100',
    '/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=999999999999999999999',
    '/gitlab/api/v4/%2e%2e/projects/42/merge_requests?state=opened&per_page=50&page=2',
  ]) expect(() => gitLabContinuation(instance, current, next)).toThrow()
})
