import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitRemoteGit, parseRemoteUrl, type RemoteGitRun } from '../src/remote/git.ts'
import type { RemotePull } from '../src/remote/provider.ts'
const exec = promisify(execFile)
const roots: string[] = []
const SIG = new AbortController().signal
const target = { provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' } as const
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-git-')); roots.push(root)
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(root, 'file'), 'base'); git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-b', 'topic'); writeFileSync(join(root, 'file'), 'head'); git(root, 'commit', '-am', 'head')
  const head = git(root, 'rev-parse', 'HEAD'); git(root, 'update-ref', 'refs/pull/1/head', head); git(root, 'checkout', 'main'); git(root, 'branch', '-D', 'topic')
  git(root, 'remote', 'add', 'origin', root)
  const run: RemoteGitRun = async (cwd, args, signal) => {
    if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/owner/repo.git\n'
    return (await exec('git', [...args], { cwd, signal, maxBuffer: 1024 * 1024 })).stdout
  }
  const pr: RemotePull = { number: 1, title: 'PR', body: '', state: 'open', rawState: 'open', author: null, head: { repository: target, ref: 'topic', sha: head }, base: { repository: target, ref: 'main', sha: base }, draft: false }
  return { root, run, pr, head, base, remote: new GitRemoteGit(run) }
}
describe('remote Git integration', { timeout: 20000 }, () => {
  it('parses exact SSH/HTTPS GitHub identities only', () => {
    for (const url of ['git@github.com:owner/repo.git', 'https://github.com/owner/repo.git', 'ssh://git@github.com/owner/repo']) expect(parseRemoteUrl(url)).toEqual(target)
    for (const url of ['https://token@github.com/o/r', 'https://github.com.evil/o/r', 'https://github.com/o/r?token=x', '/tmp/repo', 'git@evil.example:o/r']) expect(parseRemoteUrl(url)).toBeUndefined()
  })
  it('fetches a verified SHA, adds single-branch mapping and configures tracking; repeats safely', async () => {
    const f = fixture()
    git(f.root, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main')
    const receipt = await f.remote.checkout(f.root, target, f.pr, undefined, SIG)
    expect(receipt).toMatchObject({ switched: true, head: f.head, privateRefWritten: true, trackingRefPrepared: true, fetchMappingAdded: true, upstreamNotConfigured: false })
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.head)
    expect(git(f.root, 'rev-parse', '--symbolic-full-name', '@{upstream}')).toBe('refs/remotes/origin/topic')
    expect((await f.remote.checkout(f.root, target, f.pr, undefined, SIG)).error).toBeUndefined()
  })
  it('rejects dirt and SHA races without switching or creating branches', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'untracked'), 'dirty')
    expect((await f.remote.checkout(f.root, target, f.pr, undefined, SIG)).error).toBe('dirty')
    rmSync(join(f.root, 'untracked'))
    const result = await f.remote.checkout(f.root, target, { ...f.pr, head: { ...f.pr.head, sha: f.base } }, undefined, SIG)
    expect(result).toMatchObject({ switched: false, privateRefWritten: true, error: 'head-moved' })
    expect(git(f.root, 'branch', '--show-current')).toBe('main')
  })
  it('refuses to overwrite conflicting user branches and advanced tracking refs', async () => {
    const f = fixture(); git(f.root, 'branch', 'topic', f.base)
    expect((await f.remote.checkout(f.root, target, f.pr, undefined, SIG)).error).toBe('branch-conflict')
    git(f.root, 'branch', '-D', 'topic')
    git(f.root, 'update-ref', 'refs/remotes/origin/topic', f.head)
    const old = { ...f.pr, head: { ...f.pr.head, sha: f.base } }; git(f.root, 'update-ref', 'refs/pull/1/head', f.base)
    expect((await f.remote.checkout(f.root, target, old, undefined, SIG)).error).toBe('head-moved')
    expect(git(f.root, 'rev-parse', 'refs/remotes/origin/topic')).toBe(f.head)
  })
  it('uses fork branch without upstream and reports config failures after switching', async () => {
    const fork = fixture()
    const forkPr = { ...fork.pr, head: { ...fork.pr.head, repository: { ...target, owner: 'fork' } } }
    expect(await fork.remote.checkout(fork.root, target, forkPr, undefined, SIG)).toMatchObject({ switched: true, branch: 'pr-1', upstreamNotConfigured: false })
    expect(git(fork.root, 'for-each-ref', '--format=%(upstream)', 'refs/heads/pr-1')).toBe('')
    const f = fixture()
    const failing = new GitRemoteGit(async (cwd, args, signal) => { if (args[0] === 'branch' && args[1]?.startsWith('--set-upstream')) throw new Error('config refused'); return f.run(cwd, args, signal) })
    expect(await failing.checkout(f.root, target, f.pr, undefined, SIG)).toMatchObject({ switched: true, head: f.head, upstreamNotConfigured: true, error: 'git-transport-or-local-failure' })
  })
  it('uses expected-old CAS and preserves a concurrent tracking ref creation', async () => {
    const f = fixture(); let raced = false
    const racing = new GitRemoteGit(async (cwd, args, signal) => {
      if (args[0] === 'update-ref' && args[1] === 'refs/remotes/origin/topic' && !raced) { raced = true; git(f.root, 'update-ref', 'refs/remotes/origin/topic', f.head) }
      return f.run(cwd, args, signal)
    })
    expect((await racing.checkout(f.root, target, f.pr, undefined, SIG)).switched).toBe(true)
    expect(raced).toBe(true)
  })
  it('rejects unknown repository before fetch', async () => {
    const f = fixture()
    await expect(f.remote.checkout(f.root, { ...target, owner: 'other' }, f.pr, undefined, SIG)).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
  })
})

describe('checkout partial state and worktrees', { timeout: 20000 }, () => {
  it('leaves a conflicting worktree intact and reports actual HEAD', async () => {
    const f = fixture()
    await f.remote.checkout(f.root, target, f.pr, undefined, SIG)
    git(f.root, 'checkout', 'main')
    const other = mkdtempSync(join(tmpdir(), 'dsh-remote-other-')); roots.push(other); rmSync(other, { recursive: true })
    git(f.root, 'worktree', 'add', other, 'topic')
    const result = await f.remote.checkout(f.root, target, f.pr, undefined, SIG)
    expect(result).toMatchObject({ switched: false, head: f.base, error: 'git-transport-or-local-failure' })
    expect(git(other, 'rev-parse', 'HEAD')).toBe(f.head)
  })
  it('reports preparation without switching when adding fetch mapping fails', async () => {
    const f = fixture(); git(f.root, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main')
    const remote = new GitRemoteGit(async (root, args, signal) => { if (args[0] === 'config' && args[1] === '--add') throw new Error('read-only config'); return f.run(root, args, signal) })
    expect(await remote.checkout(f.root, target, f.pr, undefined, SIG)).toMatchObject({ switched: false, privateRefWritten: true, trackingRefPrepared: true, fetchMappingAdded: false, error: 'git-transport-or-local-failure' })
    expect(git(f.root, 'branch', '--show-current')).toBe('main')
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/topic')).toBe('')
  })
  it('isolates private refs for same-number pulls from origin and upstream', async () => {
    const f = fixture(); git(f.root, 'remote', 'add', 'upstream', f.root)
    const run: RemoteGitRun = async (root, args, signal) => args[0] === 'remote' && args[1] === 'get-url' && args[3] === 'upstream' ? 'https://github.com/upstream/repo.git\n' : f.run(root, args, signal)
    const remote = new GitRemoteGit(run)
    await remote.checkout(f.root, target, f.pr, 'first', SIG)
    git(f.root, 'checkout', 'main')
    const upstream = { ...target, owner: 'upstream' }
    await remote.checkout(f.root, upstream, { ...f.pr, base: { ...f.pr.base, repository: upstream } }, 'second', SIG)
    const refs = git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/dsh-git-remote/pr').split('\n')
    expect(refs).toHaveLength(2)
  })
})
