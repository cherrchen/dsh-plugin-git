import { describe, expect, it, vi } from 'vitest'
import { GitRemoteHttp } from '../src/remote/http.ts'
import { gitLabProjectLookupPath, GitLabCursorStore } from '../src/remote/gitlab-read-boundaries.ts'

describe('GitLab project lookup boundary', () => {
  it('encodes the entire namespace only for the validated project lookup', async () => {
    const fetch = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }))
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch })
    const path = gitLabProjectLookupPath('/gitlab', 'group/sub-group/项目')
    expect(path).toBe('/gitlab/api/v4/projects/group%2Fsub-group%2F%E9%A1%B9%E7%9B%AE')
    await http.gitLabProjectLookup('group/sub-group/项目', { accept: 'application/json' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toBe('https://git.example.com' + path)
    await expect(http.request({ role: 'api', method: 'GET', path })).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it.each(['', '/group/repo', 'group/', 'group//repo', 'group/../repo', 'group/%2Frepo', 'group/a%252fb', 'group/a\\b', 'group/a?x=1', 'group/a#x', 'group/a\n', 'single'])('rejects an unsafe project path %j before sending', async path => {
    const fetch = vi.fn(async () => new Response('{}'))
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch })
    await expect(http.gitLabProjectLookup(path)).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    '/gitlab/api/v4/projects/other%2Frepo',
    '/gitlab/api/v4/projects/group%252Frepo',
    '/gitlab/api/v4/projects/group%2Frepo?other=1',
    'https://other.example/gitlab/api/v4/projects/group%2Frepo',
  ])('rejects a changed lookup redirect %s', async location => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch })
    await expect(http.gitLabProjectLookup('group/repo', { authorization: 'Bearer sentinel' })).rejects.toMatchObject({ kind: 'http' })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('permits an exact project lookup redirect while retaining the bearer on the same scoped URL', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://git.example.com/gitlab/api/v4/projects/group%2Frepo' } }))
      .mockResolvedValueOnce(new Response('{}'))
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch })
    await http.gitLabProjectLookup('group/repo', { authorization: 'Bearer sentinel' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toBe(fetch.mock.calls[0]?.[0])
  })
})

describe('GitLab branch lookup boundary', () => {
  it('binds a safely encoded branch to one validated numeric project and GET only', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch })
    await http.gitLabBranchLookup('42', 'feature/subgroup')
    expect(fetch.mock.calls[0]?.[0]).toBe('https://git.example.com/gitlab/api/v4/projects/42/repository/branches/feature%2Fsubgroup')
    await expect(http.request({ role: 'api', method: 'GET', path: '/gitlab/api/v4/projects/42/repository/branches/feature%2Fsubgroup' })).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it.each([
    ['43/other', 'main'], ['42', '../main'], ['42', 'feature/%2fsecret'], ['42', 'feature//bad'], ['42', 'a?b'], ['42', 'a\\b'], ['42', '-bad'], ['42', 'bad.lock'],
  ])('rejects invalid project %s or branch %s before sending', async (project, branch) => {
    const fetch = vi.fn(async () => new Response('{}'))
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch })
    await expect(http.gitLabBranchLookup(project, branch)).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects a redirect that changes the bound project or branch', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/gitlab/api/v4/projects/43/repository/branches/feature%2Fsubgroup' } }))
    const http = new GitRemoteHttp({ gitlabInstance: 'https://git.example.com/gitlab', fetch })
    await expect(http.gitLabBranchLookup('42', 'feature/subgroup', { authorization: 'Bearer sentinel' })).rejects.toMatchObject({ kind: 'http' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('GitLab opaque cursor binding', () => {
  const binding = {
    instance: 'https://git.example.com/gitlab', projectId: '42', path: 'group/repo',
    viewer: '9', generation: { instanceId: 'generation-a', revision: 2 },
    query: '/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50',
    snapshot: 'base:head', root: '/repo', session: 'session-a',
  }
  it('returns only a host-issued handle and rejects every binding change', () => {
    const cursors = new GitLabCursorStore()
    const handle = cursors.issue(binding, '/gitlab/api/v4/projects/42/merge_requests?state=opened&per_page=50&page=2')
    expect(handle).not.toContain('/gitlab/')
    expect(cursors.resolve(handle, binding)).toContain('page=2')
    for (const changed of [
      { ...binding, instance: 'https://other.example' }, { ...binding, projectId: '43' },
      { ...binding, path: 'other/repo' }, { ...binding, viewer: '10' },
      { ...binding, generation: { ...binding.generation, revision: 3 } },
      { ...binding, query: binding.query.replace('opened', 'closed') },
      { ...binding, snapshot: 'base:other' }, { ...binding, root: '/other' },
      { ...binding, session: 'session-b' },
    ]) expect(() => cursors.resolve(handle, changed)).toThrow()
    expect(() => cursors.resolve('unissued', binding)).toThrow()
    cursors.clear()
    expect(() => cursors.resolve(handle, binding)).toThrow()
  })
  it('expires handles and refuses exhaustion rather than reporting a truncated list as complete', () => {
    let now = 1
    const cursors = new GitLabCursorStore({ now: () => now, maxEntries: 1, ttlMs: 10 })
    const handle = cursors.issue(binding, '/next')
    expect(() => cursors.issue(binding, '/next')).toThrow()
    now = 11
    expect(() => cursors.resolve(handle, binding)).toThrow()
    expect(cursors.issue(binding, '/next')).toBeTruthy()
  })
})
