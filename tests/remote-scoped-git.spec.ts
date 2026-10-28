import { describe, expect, it } from 'vitest'
import { resolveGitLabInstances } from '../src/remote/instances.ts'
import { parseScopedRemote, scopedRepositories } from '../src/remote/scoped-git.ts'
const instances = resolveGitLabInstances([{ url: 'https://git.example.com:8443/gitlab', sshHost: 'ssh.example.com', sshPort: 2222 }])
describe('scoped discovery', () => {
  it('uses explicit HTTPS prefix and SSH mapping without consuming a prefix as SSH path', () => {
    expect(parseScopedRemote('https://git.example.com:8443/gitlab/group/sub/repo.git', instances).identity).toMatchObject({ provider: 'gitlab', path: 'group/sub/repo', scope: { instance: 'https://git.example.com:8443/gitlab' } })
    expect(parseScopedRemote('ssh://git@ssh.example.com:2222/group/sub/repo.git', instances).identity).toMatchObject({ provider: 'gitlab', path: 'group/sub/repo' })
    expect(parseScopedRemote('git@ssh.example.com:group/repo.git', instances).identity).toBeUndefined()
    expect(parseScopedRemote('git@github.com:owner/repo.git', instances).identity).toMatchObject({ scope: { provider: 'github', instance: 'https://github.com' } })
  })
  it('rejects ambiguous SSH mapping and unsafe or unregistered URLs without exposing them', async () => {
    const ambiguous = resolveGitLabInstances([{ url: 'https://one.example', sshHost: 'shared.example' }, { url: 'https://two.example', sshHost: 'shared.example' }])
    expect(parseScopedRemote('git@shared.example:group/repo.git', ambiguous).reason).toBe('ambiguous')
    for (const url of ['https://user:secret@git.example.com:8443/gitlab/g/r', 'https://git.example.com:8443/gitlab/g/../r', 'https://git.example.com:8443/gitlab/g/%2fr', 'https://stranger.example/g/r']) expect(parseScopedRemote(url, instances).identity).toBeUndefined()
    const set = await scopedRepositories(async (_root, args) => args[1] === 'get-url' ? 'https://user:secret@stranger.example/g/r\n' : 'origin\n', '/repo', instances, new AbortController().signal)
    expect(set).toEqual({ state: 'unsupported', remotes: [], unresolved: [{ name: 'origin', reason: 'unregistered' }] })
    expect(JSON.stringify(set)).not.toContain('secret')
  })
})
