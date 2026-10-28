import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRemoteGit, type RemoteCheckoutPlan, type RemoteGitRun } from '../src/remote/git.ts'
import { gitLabPrivateRef } from '../src/remote/gitlab-git.ts'
import { GitRemoteRuntime } from '../src/remote/runtime.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { GitService } from '../src/service.ts'

const exec = promisify(execFile), signal = new AbortController().signal, roots: string[] = []
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gitlab-checkout-')); roots.push(root)
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(root, 'file'), 'base'); git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  git(root, 'switch', '-c', 'topic'); writeFileSync(join(root, 'file'), 'head'); git(root, 'commit', '-am', 'head')
  const head = git(root, 'rev-parse', 'HEAD'); git(root, 'update-ref', 'refs/merge-requests/7/head', head); git(root, 'switch', 'main'); git(root, 'branch', '-D', 'topic')
  git(root, 'remote', 'add', 'origin', root); git(root, 'remote', 'add', 'upstream', root)
  const argsSeen: readonly string[][] = []
  const run: RemoteGitRun = async (cwd, args, inner) => { (argsSeen as string[][]).push([...args]); return (await exec('git', [...args], { cwd, signal: inner, maxBuffer: 1024 * 1024 })).stdout }
  const plan: RemoteCheckoutPlan = { remoteName: 'origin', remoteHeadRef: 'refs/merge-requests/7/head', privateRef: gitLabPrivateRef('https://git.example.com/gitlab', '42', 7), sourceRef: 'topic', expectedSha: head, sameRepository: true, branch: 'topic' }
  return { root, run, plan, base, head, argsSeen, engine: new GitRemoteGit(run) }
}
describe('GitLab checkout shared mechanics', { timeout: 20000 }, () => {
  it('verifies the MR head, appends a single-branch fetch mapping and tracks the source branch', async () => {
    const f = fixture(); git(f.root, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main')
    const receipt = await f.engine.checkoutBound(f.root, f.plan, signal)
    expect(receipt).toMatchObject({ switched: true, privateRefWritten: true, trackingRefPrepared: true, fetchMappingAdded: true, upstreamNotConfigured: false, head: f.head })
    expect(git(f.root, 'rev-parse', '--symbolic-full-name', '@{upstream}')).toBe('refs/remotes/origin/topic')
    expect(f.argsSeen.find(args => args[0] === 'fetch')).toEqual(['fetch', '--no-tags', '--no-write-fetch-head', '--', 'origin', `+refs/merge-requests/7/head:${f.plan.privateRef}`])
  })
  it('requires a different fork name when the default already exists', async () => {
    const f = fixture(); git(f.root, 'branch', 'mr-7', f.head)
    const fork = { ...f.plan, sameRepository: false, branch: 'mr-7', rejectExistingBranch: true }
    expect(await f.engine.checkoutBound(f.root, fork, signal)).toMatchObject({ switched: false, privateRefWritten: true, error: 'branch-conflict' })
    expect(await f.engine.checkoutBound(f.root, { ...fork, branch: 'my-mr', rejectExistingBranch: false }, signal)).toMatchObject({ switched: true, branch: 'my-mr', head: f.head })
  })
  it('isolates same-iid private refs for different instances and target projects', async () => {
    const f = fixture()
    const other = gitLabPrivateRef('https://other.example', '42', 7), otherProject = gitLabPrivateRef('https://git.example.com/gitlab', '43', 7)
    expect(new Set([f.plan.privateRef, other, otherProject]).size).toBe(3)
    await f.engine.checkoutBound(f.root, { ...f.plan, sameRepository: false, branch: 'first' }, signal)
    git(f.root, 'switch', 'main')
    await f.engine.checkoutBound(f.root, { ...f.plan, sameRepository: false, branch: 'second', remoteName: 'upstream', privateRef: other }, signal)
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/dsh-git-remote/mr').split('\n')).toHaveLength(2)
  })
  it('refuses dirty workspaces and reports a fetched SHA race without switching', async () => {
    const f = fixture(); writeFileSync(join(f.root, 'untracked'), 'dirty')
    expect(await f.engine.checkoutBound(f.root, f.plan, signal)).toMatchObject({ switched: false, error: 'dirty' })
    rmSync(join(f.root, 'untracked'))
    expect(await f.engine.checkoutBound(f.root, { ...f.plan, expectedSha: f.base }, signal)).toMatchObject({ switched: false, privateRefWritten: true, error: 'head-moved' })
  })
  it('reports completed private-ref preparation when a later authorization guard fails', async () => {
    const f = fixture(); let checks = 0
    const receipt = await f.engine.checkoutBound(f.root, f.plan, signal, { beforeSideEffect: async () => { if (++checks === 3) throw Error('changed identity') } })
    expect(receipt).toMatchObject({ switched: false, privateRefWritten: true, trackingRefPrepared: false, error: 'git-transport-or-local-failure' })
    expect(git(f.root, 'branch', '--show-current')).toBe('main')
  })
  it('retries tracking CAS without overwriting a concurrently created tracking ref', async () => {
    const f = fixture(); let raced = false
    const runner: RemoteGitRun = async (root, args, inner) => {
      if (args[0] === 'update-ref' && args[1] === 'refs/remotes/origin/topic' && !raced) { raced = true; git(root, 'update-ref', 'refs/remotes/origin/topic', f.head) }
      return f.run(root, args, inner)
    }
    const result = await new GitRemoteGit(runner).checkoutBound(f.root, f.plan, signal)
    expect(raced).toBe(true); expect(result).toMatchObject({ switched: true, trackingRefPrepared: true, head: f.head })
  })
  it('preserves an advanced or divergent tracking ref', async () => {
    for (const mode of ['ahead', 'diverged'] as const) {
      const f = fixture()
      git(f.root, 'switch', '-c', 'extra', mode === 'ahead' ? f.head : f.base)
      writeFileSync(join(f.root, 'file'), mode); git(f.root, 'commit', '-am', mode)
      const tracking = git(f.root, 'rev-parse', 'HEAD'); git(f.root, 'switch', 'main'); git(f.root, 'branch', '-D', 'extra')
      git(f.root, 'update-ref', 'refs/remotes/origin/topic', tracking)
      const result = await f.engine.checkoutBound(f.root, f.plan, signal)
      expect(result).toMatchObject({ switched: false, privateRefWritten: true, error: mode === 'ahead' ? 'head-moved' : 'tracking-conflict' })
      expect(git(f.root, 'rev-parse', 'refs/remotes/origin/topic')).toBe(tracking)
    }
  })
  it('detects a background fetch advancing tracking after CAS and before switch', async () => {
    const f = fixture(); git(f.root, 'switch', '-c', 'ahead', f.head)
    writeFileSync(join(f.root, 'file'), 'ahead'); git(f.root, 'commit', '-am', 'ahead')
    const advanced = git(f.root, 'rev-parse', 'HEAD'); git(f.root, 'switch', 'main'); git(f.root, 'branch', '-D', 'ahead')
    const result = await f.engine.checkoutBound(f.root, f.plan, signal, { beforeEnter: async () => { git(f.root, 'update-ref', 'refs/remotes/origin/topic', advanced) } })
    expect(result).toMatchObject({ switched: false, trackingRefPrepared: true, error: 'head-moved' })
    expect(git(f.root, 'rev-parse', 'refs/remotes/origin/topic')).toBe(advanced)
    expect(git(f.root, 'branch', '--show-current')).toBe('main')
  })
  it('preserves a concurrently created local branch when switch -c loses the race', async () => {
    const f = fixture(); let raced = false
    const runner: RemoteGitRun = async (root, args, inner) => {
      if (args[0] === 'switch' && args[1] === '-c' && !raced) { raced = true; git(root, 'branch', 'topic', f.base) }
      return f.run(root, args, inner)
    }
    const result = await new GitRemoteGit(runner).checkoutBound(f.root, f.plan, signal)
    expect(result).toMatchObject({ switched: false, privateRefWritten: true, error: 'git-transport-or-local-failure' })
    expect(git(f.root, 'rev-parse', 'refs/heads/topic')).toBe(f.base)
  })
  it('reports mapping or upstream config failures without deleting prepared state', async () => {
    const mapping = fixture(); git(mapping.root, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main')
    const failMapping = new GitRemoteGit(async (root, args, inner) => { if (args[0] === 'config' && args[1] === '--add') throw Error('fixture config failure'); return mapping.run(root, args, inner) })
    expect(await failMapping.checkoutBound(mapping.root, mapping.plan, signal)).toMatchObject({ privateRefWritten: true, trackingRefPrepared: true, switched: false, fetchMappingAdded: false, error: 'git-transport-or-local-failure' })
    const upstream = fixture()
    const failUpstream = new GitRemoteGit(async (root, args, inner) => { if (args[0] === 'branch' && args[1]?.startsWith('--set-upstream')) throw Error('fixture config failure'); return upstream.run(root, args, inner) })
    expect(await failUpstream.checkoutBound(upstream.root, upstream.plan, signal)).toMatchObject({ privateRefWritten: true, trackingRefPrepared: true, switched: true, upstreamNotConfigured: true, head: upstream.head, error: 'git-transport-or-local-failure' })
  })
  it('preserves another worktree that has checked out the branch', async () => {
    const f = fixture(); await f.engine.checkoutBound(f.root, f.plan, signal); git(f.root, 'switch', 'main')
    const other = mkdtempSync(join(tmpdir(), 'dsh-gitlab-worktree-')); roots.push(other); rmSync(other, { recursive: true })
    git(f.root, 'worktree', 'add', other, 'topic')
    expect(await f.engine.checkoutBound(f.root, f.plan, signal)).toMatchObject({ switched: false, head: f.base, worktreeConflict: true, error: 'git-transport-or-local-failure' })
    expect(git(other, 'rev-parse', 'HEAD')).toBe(f.head)
  })
})

describe('scoped GitLab checkout admission', { timeout: 20000 }, () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  function runtimeFixture() {
    const f = fixture(), records = new Map<string, CredentialRecord>()
    const credentials: GitRemoteCredentialService = { readRecord: async key => records.get(key), modifyRecord: async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); return records.get(key) }, deleteRecord: async key => { records.delete(key) }, resolve: async ref => ref === 'OFFICE' ? { value: 'test-secret', source: 'fixture' } : undefined, describe: async () => ({ configured: false, writable: true }), describeRecord: async key => ({ configured: records.has(key), writable: true }) }
    const subprocess = { spawn: vi.fn(() => { throw Error('unexpected probe') }), resolveExecutable: vi.fn(async () => { throw Error('unexpected probe') }) }
    const calls: string[][] = []; let failSwitch = false, moveAfterFetch = false, changeRemoteAfterFetch = false, selectedRemote: 'origin' | 'upstream' = 'origin'
    const run: RemoteGitRun = async (cwd, args, inner) => {
      calls.push([...args])
      if (args[0] === 'remote' && args[1] === 'get-url') return args[3] === selectedRemote ? 'https://git.example.com/gitlab/group/repo.git\n' : 'https://git.example.com/gitlab/other/repo.git\n'
      if (failSwitch && args[0] === 'switch') throw Error('fixture switch failure')
      const result = await exec('git', [...args], { cwd, signal: inner, maxBuffer: 1024 * 1024, env: { PATH: process.env['PATH'], HOME: f.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
      if (moveAfterFetch && args[0] === 'fetch') apiHead = f.base
      if (changeRemoteAfterFetch && args[0] === 'fetch') selectedRemote = 'upstream'
      return result.stdout
    }
    const runtime = new GitRemoteRuntime(credentials, subprocess, { remoteCommand: run } as unknown as GitService, { instances: [{ url: 'https://git.example.com/gitlab', credentialRef: 'OFFICE' }] })
    let sourceId = 42, apiHead = f.head
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/user')) return json({ id: 9, username: 'viewer' })
      if (path.includes('/projects/group%2F')) return json({ id: 42, path_with_namespace: 'group/repo' })
      if (path.endsWith('/merge_requests/7')) return json({ id: 123, iid: 7, title: 'MR', description: '', state: 'opened', author: null, source_project_id: sourceId, target_project_id: 42, source_branch: 'topic', target_branch: 'main', sha: apiHead })
      if (path.endsWith('/issues/7')) return json({ id: 345, iid: 7, project_id: 42, title: 'Repair the widget', description: '', state: 'opened', author: null })
      throw Error('unexpected network')
    })
    const request = { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com/gitlab', repository: f.root, sessionId: 'session-1', path: 'group/repo' }
    return { ...f, runtime, request, calls, setSource: (value: number) => { sourceId = value }, setApiHead: (value: string) => { apiHead = value }, setFailSwitch: (value: boolean) => { failSwitch = value }, setMoveAfterFetch: (value: boolean) => { moveAfterFetch = value }, setChangeRemoteAfterFetch: (value: boolean) => { changeRemoteAfterFetch = value }, setRemote: (value: 'origin' | 'upstream') => { selectedRemote = value } }
  }
  async function confirmed(f: ReturnType<typeof runtimeFixture>) {
    const facts = await f.runtime.handle('remote-repository', f.request, signal, async () => {}) as any
    return { ...f.request, projectId: '42', number: 7, expectedInstance: f.request.instance, expectedGeneration: facts.generation, expectedViewer: { host: 'git.example.com', userId: '9' }, expectedHeadSha: f.head, requestId: 'checkout-0001' }
  }
  it('fetches only the allowed target MR ref and deduplicates identical submissions', async () => {
    const f = runtimeFixture()
    try {
      const request = await confirmed(f)
      const first = await f.runtime.handle('remote-checkout-pr', request, signal, async () => {}) as any
      const again = await f.runtime.handle('remote-checkout-pr', request, signal, async () => {}) as any
      expect(first.value).toMatchObject({ outcome: 'succeeded', receipt: { switched: true, branch: 'topic', head: f.head } })
      expect(again.value).toEqual(first.value)
      expect(f.calls.filter(args => args[0] === 'fetch')).toHaveLength(1)
      expect(JSON.stringify([first, again, f.calls])).not.toContain('test-secret')
      await expect(f.runtime.handle('remote-checkout-pr', { ...request, branch: 'other' }, signal, async () => {})).rejects.toMatchObject({ details: { reason: 'submission-conflict' } })
    } finally { await f.runtime.dispose() }
  })
  it('fetches and tracks through upstream when that is the allowed target remote', async () => {
    const f = runtimeFixture(); f.setRemote('upstream')
    try {
      const request = await confirmed(f)
      const result = await f.runtime.handle('remote-checkout-pr', request, signal, async () => {}) as any
      expect(result.value).toMatchObject({ outcome: 'succeeded', receipt: { switched: true, head: f.head } })
      expect(f.calls.find(args => args[0] === 'fetch')?.[4]).toBe('upstream')
      expect(git(f.root, 'rev-parse', '--symbolic-full-name', '@{upstream}')).toBe('refs/remotes/upstream/topic')
    } finally { await f.runtime.dispose() }
  })
  it('refuses forged project, stale viewer and stale head before fetch', async () => {
    const f = runtimeFixture()
    try {
      const request = await confirmed(f)
      await expect(f.runtime.handle('remote-checkout-pr', { ...request, projectId: '43' }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
      await expect(f.runtime.handle('remote-checkout-pr', { ...request, expectedViewer: { host: 'git.example.com', userId: '10' } }, signal, async () => {})).rejects.toMatchObject({ code: 'git/remote-identity-mismatch' })
      f.setApiHead(f.base)
      await expect(f.runtime.handle('remote-checkout-pr', request, signal, async () => {})).rejects.toMatchObject({ code: 'git/head-moved' })
      expect(f.calls.some(args => args[0] === 'fetch')).toBe(false)
    } finally { await f.runtime.dispose() }
  })
  it('reports a fetched SHA race and keeps the current branch', async () => {
    const f = runtimeFixture()
    try {
      const request = await confirmed(f); git(f.root, 'update-ref', 'refs/merge-requests/7/head', f.base)
      const result = await f.runtime.handle('remote-checkout-pr', request, signal, async () => {}) as any
      expect(result.value).toMatchObject({ outcome: 'partial', receipt: { switched: false, privateRefWritten: true, error: 'head-moved' } })
      expect(git(f.root, 'branch', '--show-current')).toBe('main')
    } finally { await f.runtime.dispose() }
  })
  it('detects the API head moving after fetch but before switch', async () => {
    const f = runtimeFixture(); f.setMoveAfterFetch(true)
    try {
      const request = await confirmed(f)
      const result = await f.runtime.handle('remote-checkout-pr', request, signal, async () => {}) as any
      expect(result.value).toMatchObject({ outcome: 'partial', receipt: { switched: false, privateRefWritten: true, error: 'head-moved' } })
      expect(git(f.root, 'branch', '--show-current')).toBe('main')
    } finally { await f.runtime.dispose() }
  })
  it('does not switch after the selected local remote changes during fetch', async () => {
    const f = runtimeFixture(); f.setChangeRemoteAfterFetch(true)
    try {
      const request = await confirmed(f)
      const result = await f.runtime.handle('remote-checkout-pr', request, signal, async () => {}) as any
      expect(result.value).toMatchObject({ outcome: 'partial', receipt: { switched: false, privateRefWritten: true, trackingRefPrepared: false } })
      expect(git(f.root, 'branch', '--show-current')).toBe('main')
      expect(f.calls.filter(args => args[0] === 'fetch')).toHaveLength(1)
    } finally { await f.runtime.dispose() }
  })
  it('uses mr-N for a fork and refuses a pre-existing default branch', async () => {
    const f = runtimeFixture(); f.setSource(99); git(f.root, 'branch', 'mr-7', f.head)
    try {
      const request = await confirmed(f)
      const result = await f.runtime.handle('remote-checkout-pr', request, signal, async () => {}) as any
      expect(result.value).toMatchObject({ outcome: 'partial', receipt: { switched: false, branch: 'mr-7', error: 'branch-conflict' } })
      const named = await f.runtime.handle('remote-checkout-pr', { ...request, requestId: 'checkout-0002', branch: 'manual' }, signal, async () => {}) as any
      expect(named.value).toMatchObject({ outcome: 'succeeded', receipt: { switched: true, branch: 'manual' } })
    } finally { await f.runtime.dispose() }
  })
  it('creates and switches an Issue branch from the checked local HEAD without Git transport', async () => {
    const f = runtimeFixture()
    try {
      const request = { ...await confirmed(f), requestId: 'issue-branch-0001' }
      const result = await f.runtime.handle('remote-issue-branch', request, signal, async () => {}) as any
      expect(result.value).toMatchObject({ outcome: 'succeeded', receipt: { branch: 'issue-7-repair-the-widget', created: true, switched: true, head: f.base } })
      expect(git(f.root, 'branch', '--show-current')).toBe('issue-7-repair-the-widget')
      expect(f.calls.some(args => args[0] === 'fetch' || args[0] === 'push')).toBe(false)
    } finally { await f.runtime.dispose() }
  })
  it('reports Issue branch creation when switching fails and does not retry it', async () => {
    const f = runtimeFixture(); f.setFailSwitch(true)
    try {
      const request = { ...await confirmed(f), requestId: 'issue-branch-0002' }
      const result = await f.runtime.handle('remote-issue-branch', request, signal, async () => {}) as any
      expect(result.value).toMatchObject({ outcome: 'partial', steps: [{ kind: 'create-branch', state: 'succeeded' }, { kind: 'switch-branch', state: 'unknown' }], receipt: { branch: 'issue-7-repair-the-widget', created: true, switched: false } })
      expect(git(f.root, 'rev-parse', 'refs/heads/issue-7-repair-the-widget')).toBe(f.base)
      const repeated = await f.runtime.handle('remote-issue-branch', request, signal, async () => {}) as any
      expect(repeated.value).toEqual(result.value)
      expect(f.calls.filter(args => args[0] === 'branch' && args[1] === '--')).toHaveLength(1)
    } finally { await f.runtime.dispose() }
  })
  it('rejects a dirty checkout and an existing Issue branch without deleting either', async () => {
    const f = runtimeFixture()
    try {
      const request = { ...await confirmed(f), requestId: 'issue-branch-0003' }
      writeFileSync(join(f.root, 'untracked'), 'dirty')
      expect((await f.runtime.handle('remote-issue-branch', request, signal, async () => {}) as any).value).toMatchObject({ receipt: { created: false, switched: false, error: 'dirty' } })
      rmSync(join(f.root, 'untracked')); git(f.root, 'branch', 'issue-7-repair-the-widget', f.base)
      const result = await f.runtime.handle('remote-issue-branch', { ...request, requestId: 'issue-branch-0004' }, signal, async () => {}) as any
      expect(result.value).toMatchObject({ receipt: { created: false, switched: false, error: 'branch-conflict' } })
      expect(git(f.root, 'rev-parse', 'refs/heads/issue-7-repair-the-widget')).toBe(f.base)
    } finally { await f.runtime.dispose() }
  })
})
