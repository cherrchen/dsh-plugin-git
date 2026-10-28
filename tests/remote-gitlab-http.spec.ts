import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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

const captured = JSON.parse(readFileSync(new URL('../docs/plans/active/evidence/remote-platform-gitlab-com-20261028.json', import.meta.url), 'utf8')) as { paginationObservations: { path: string; headers: { link: string } }[] }
describe('real GitLab.com pagination metadata (A3)', () => {
  it.each(captured.paginationObservations)('accepts captured first/last and advancing next links for $path', observation => {
    for (const part of observation.headers.link.split(',')) {
      const target = /^\s*<([^>]+)>/.exec(part)![1]!
      expect(gitLabContinuation('https://gitlab.com', observation.path, target, 'any')).toBe(observation.path)
      const next = new URL(target); next.searchParams.set('page', '2')
      const expected = new URL(observation.path, 'https://gitlab.com'); expected.searchParams.set('page', '2')
      expect(gitLabContinuation('https://gitlab.com', observation.path, next.href)).toBe(expected.pathname + expected.search)
    }
  })
  it.each([
    ['issues?state=all', 'id=43'],
    ['issues?state=all', 'id=42&id=42'],
    ['issues?state=all', 'sort=asc'],
    ['issues?state=all', 'order_by=updated_at'],
    ['issues?state=all', 'with_labels_details=true'],
    ['issues?state=all', 'with_labels_details=false&with_labels_details=false'],
    ['issues?state=all', 'with_merge_status_recheck=false'],
    ['issues?state=all', 'unknown=false'],
    ['merge_requests/7/notes?', 'noteable_id=8'],
    ['merge_requests/7/notes?', 'activity_filter=only_comments'],
    ['merge_requests/7/discussions?', 'merge_request_iid=7'],
    ['merge_requests/7/commits?', 'merge_request_iid=8'],
    ['merge_requests/7/diffs?', 'unidiff=true'],
    ['merge_requests/7/diffs?', 'noteable_id=7'],
  ])('rejects scope/default changes in %s: %s', (endpoint, extra) => {
    const current = `/gitlab/api/v4/projects/42/${endpoint}${endpoint.endsWith('?') ? '' : '&'}per_page=50&page=1`
    const next = `https://git.example.com${current.replace('page=1', 'page=2')}&${extra}`
    expect(() => gitLabContinuation('https://git.example.com/gitlab', current, next)).toThrow()
  })
  it('preserves explicitly requested nondefault values and rejects their replacement', () => {
    const current = '/api/v4/projects/42/issues?state=closed&sort=asc&per_page=50&page=1'
    expect(gitLabContinuation('https://gitlab.com', current, `${current.replace('page=1', 'page=2')}&id=42&order_by=created_at`)).toBe(current.replace('page=1', 'page=2'))
    expect(() => gitLabContinuation('https://gitlab.com', current, current.replace('sort=asc', 'sort=desc').replace('page=1', 'page=2'))).toThrow()
    expect(() => gitLabContinuation('https://gitlab.com', '/api/v4/unknown?per_page=50&page=1', '/api/v4/unknown?per_page=50&page=2&id=42')).toThrow()
  })
})
