import { describe, expect, it } from 'vitest'
import { canonicalGitLabInstance, gitLabGrantKey, gitLabHostId, resolveGitLabInstances } from '../src/remote/instances.ts'

describe('GitLab instance identities', () => {
  it('canonicalizes before deriving the frozen base32 fixtures', () => {
    expect(canonicalGitLabInstance('https://GIT.EXAMPLE.COM:443/')).toBe('https://git.example.com')
    expect(gitLabHostId('https://GIT.EXAMPLE.COM:443/')).toBe('gl-nb2hi4dthixs6z3joqxgk6dbnvygyzjomnxw2')
    expect(gitLabHostId('https://git.example.com:8443/gitlab/')).toBe('gl-nb2hi4dthixs6z3joqxgk6dbnvygyzjomnxw2orygq2dgl3hnf2gyylc')
    expect(gitLabHostId('https://GITLAB.COM/')).toBe('gitlab-com')
    expect(canonicalGitLabInstance('https://例子.测试/Prefix/')).toBe('https://xn--fsqu00a.xn--0zwm56d/Prefix')
    expect(canonicalGitLabInstance('https://[2001:db8::1]:443/')).toBe('https://[2001:db8::1]')
    expect(gitLabHostId('https://git.example.com:8443/GitLab')).not.toBe(gitLabHostId('https://git.example.com:8443/gitlab'))
  })
  it.each(['http://host', 'https://u:p@host', 'https://host/a/../b', 'https://host/a/%2e%2e/b', 'https://host/%2f', 'https://host/%252f', 'https://host/a//b', 'https://host/a\\b', 'https://host/a?x', 'https://host/a#x', 'https://host/ a', 'https://host/a/%41', 'https://host:/', 'https://host:0/'])('rejects dangerous raw URL %s', value => {
    expect(() => canonicalGitLabInstance(value)).toThrow()
  })
  it('rejects overlong identities without truncation and keeps the maximum key', () => {
    const base = 'https://example.com/'
    const max = base + 'a'.repeat(512 - base.length)
    expect(Buffer.byteLength(canonicalGitLabInstance(max))).toBe(512)
    expect(gitLabGrantKey(max)).toHaveLength(838)
    expect(() => canonicalGitLabInstance(`${max}a`)).toThrow()
  })
  it('validates the complete list, rejects duplicates and reserved or reused refs, and adds the built-in instance', () => {
    expect(resolveGitLabInstances([{ url: 'https://git.example.com', credentialRef: 'OFFICE' }]).map(item => item.instance)).toEqual(['https://git.example.com', 'https://gitlab.com'])
    expect(() => resolveGitLabInstances([{ url: 'https://GITLAB.COM/' }, { url: 'https://gitlab.com:443' }])).toThrow('duplicate-url')
    expect(() => resolveGitLabInstances([{ url: 'https://a.example', credentialRef: 'OFFICE' }, { url: 'https://b.example', credentialRef: 'OFFICE' }])).toThrow('duplicate-ref')
    for (const credentialRef of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN']) expect(() => resolveGitLabInstances([{ url: 'https://a.example', credentialRef }])).toThrow('reserved-ref')
    expect(() => resolveGitLabInstances([{ url: 'https://a.example', sshHost: 'ssh.example:443' }])).toThrow('ssh-host')
    expect(() => resolveGitLabInstances(Array.from({ length: 17 }, (_, i) => ({ url: `https://a${i}.example` })))).toThrow('instances')
  })
})


it('round-trips the complete base32 payload without lossy truncation', () => {
  const input = `https://git.example.com:8443/${'A'.repeat(80)}`
  const encoded = gitLabHostId(input).slice(3), alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0, buffer = 0
  const bytes: number[] = []
  for (const char of encoded) {
    buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); buffer &= (1 << bits) - 1 }
  }
  expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe(input)
})
