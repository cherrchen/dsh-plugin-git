/** Portable Git integration; every command is an argv array. No platform credential enters Git. */
import { createHash } from 'node:crypto'
import { GitRemoteError } from './errors.ts'
import type { RemotePull, RemoteRepository } from './provider.ts'
import { objectNumber, repositoryPath } from './github-model.ts'

export type RemoteGitRun = (root: string, args: readonly string[], signal: AbortSignal) => Promise<string>
export interface BoundRemote { readonly name: 'origin' | 'upstream'; readonly identity: RemoteRepository }
export interface RemoteRepositorySet { readonly state: 'supported' | 'no-remotes' | 'unsupported'; readonly remotes: readonly BoundRemote[] }
export interface RemoteCheckoutReceipt {
  readonly switched: boolean
  readonly privateRefWritten: boolean
  readonly trackingRefPrepared: boolean
  readonly fetchMappingAdded: boolean
  readonly upstreamNotConfigured: boolean
  readonly head?: string
  readonly branch: string
  /** The branch was observed in another worktree; no switch was attempted. */
  readonly worktreeConflict?: boolean
  readonly error?: 'dirty' | 'head-moved' | 'branch-conflict' | 'tracking-conflict' | 'git-transport-or-local-failure'
}
/** A provider resolves its own identity and ref; the shared Git executor handles local safety. */
export interface RemoteCheckoutPlan {
  readonly remoteName: 'origin' | 'upstream'
  readonly remoteHeadRef: string
  readonly privateRef: string
  readonly sourceRef: string
  readonly expectedSha: string
  readonly sameRepository: boolean
  readonly branch: string
  /** A default fork branch must not silently reuse an existing local branch. */
  readonly rejectExistingBranch?: boolean
}
export function sameRepository(a: RemoteRepository, b: RemoteRepository): boolean { return a.provider === b.provider && a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() }
export function parseRemoteUrl(value: string): RemoteRepository | undefined {
  let path: string
  if (/^git@github\.com:/.test(value)) path = value.slice('git@github.com:'.length)
  else {
    let url: URL
    try { url = new URL(value) } catch { return undefined }
    if (url.hostname !== 'github.com' || url.port !== '' || url.search !== '' || url.hash !== '') return undefined
    if (url.protocol === 'https:' && url.username === '' && url.password === '') path = url.pathname.slice(1)
    else if (url.protocol === 'ssh:' && url.username === 'git' && url.password === '') path = url.pathname.slice(1)
    else return undefined
  }
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(path)
  if (match?.[1] === undefined || match[2] === undefined || match[2] === '.' || match[2] === '..') return undefined
  return { provider: 'github', host: 'github.com', owner: match[1], repo: match[2] }
}

export class GitRemoteGit {
  constructor(private readonly run: RemoteGitRun) {}
  async repositories(root: string, signal: AbortSignal): Promise<RemoteRepositorySet> {
    const names = (await this.run(root, ['remote'], signal)).trim().split('\n').filter(name => name === 'origin' || name === 'upstream') as ('origin' | 'upstream')[]
    const remotes: BoundRemote[] = []
    for (const name of names) {
      const urls = (await this.run(root, ['remote', 'get-url', '--all', name], signal)).trim().split('\n')
      if (urls.length !== 1) continue
      const identity = parseRemoteUrl(urls[0] ?? '')
      if (identity !== undefined) remotes.push({ name, identity })
    }
    return { state: remotes.length > 0 ? 'supported' : names.length > 0 ? 'unsupported' : 'no-remotes', remotes }
  }
  async assertRepository(root: string, target: RemoteRepository, signal: AbortSignal): Promise<BoundRemote> {
    repositoryPath(target)
    const match = (await this.repositories(root, signal)).remotes.find(remote => sameRepository(remote.identity, target))
    if (match === undefined) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: target is not a configured origin or upstream')
    return match
  }
  private async optionalRef(root: string, ref: string, signal: AbortSignal): Promise<string | undefined> {
    // for-each-ref succeeds with empty output for a missing ref; failures remain failures.
    const value = await this.run(root, ['for-each-ref', '--format=%(refname)%00%(objectname)', ref], signal)
    for (const row of value.split('\n')) {
      const [name, object] = row.split('\0')
      if (name === ref && object !== undefined && /^[a-f0-9]{40,64}$/u.test(object)) return object
    }
    return undefined
  }
  async checkout(root: string, target: RemoteRepository, pr: RemotePull, requestedName: string | undefined, signal: AbortSignal, beforeEnter?: () => Promise<void>): Promise<RemoteCheckoutReceipt> {
    const remote = await this.assertRepository(root, target, signal)
    if (pr.base.repository === null || !sameRepository(pr.base.repository, target)) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: pull base does not match the selected repository')
    const sameRepo = pr.head.repository !== null && sameRepository(pr.head.repository, target)
    const branch = requestedName ?? (sameRepo ? pr.head.ref : `pr-${objectNumber(pr.number)}`)
    const repoKey = createHash('sha256').update(`${target.host}/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`).digest('hex').slice(0, 24)
    return this.checkoutBound(root, { remoteName: remote.name, remoteHeadRef: `refs/pull/${objectNumber(pr.number)}/head`, privateRef: `refs/dsh-git-remote/pr/${repoKey}/${objectNumber(pr.number)}`, sourceRef: pr.head.ref, expectedSha: pr.head.sha, sameRepository: sameRepo, branch }, signal, { ...(beforeEnter === undefined ? {} : { beforeEnter }) })
  }
  async checkoutBound(root: string, plan: RemoteCheckoutPlan, signal: AbortSignal, guards: { beforeSideEffect?: () => Promise<void>; beforeEnter?: () => Promise<void> } = {}): Promise<RemoteCheckoutReceipt> {
    const { branch, sameRepository: sameRepo, remoteName, sourceRef, expectedSha, privateRef, remoteHeadRef } = plan
    if ((remoteName !== 'origin' && remoteName !== 'upstream') || !privateRef.startsWith('refs/dsh-git-remote/')) throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: invalid checkout target')
    if (branch === '' || branch.startsWith('-')) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid checkout branch')
    await this.run(root, ['check-ref-format', '--branch', branch], signal)
    await this.run(root, ['check-ref-format', `refs/heads/${sourceRef}`], signal)
    await this.run(root, ['check-ref-format', privateRef], signal)
    await this.run(root, ['check-ref-format', remoteHeadRef], signal)
    if (!/^[a-f0-9]{40,64}$/.test(expectedSha)) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid pull commit')
    await guards.beforeSideEffect?.()
    const receipt: RemoteCheckoutReceipt = { switched: false, privateRefWritten: false, trackingRefPrepared: false, fetchMappingAdded: false, upstreamNotConfigured: sameRepo, branch }
    let result = receipt
    let switchAttempted = false
    try {
      if ((await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], signal)) !== '') return { ...result, error: 'dirty' }
      await guards.beforeSideEffect?.()
      await this.run(root, ['fetch', '--no-tags', '--no-write-fetch-head', '--', remoteName, `+${remoteHeadRef}:${privateRef}`], signal)
      result = { ...result, privateRefWritten: true }
      const verified = (await this.run(root, ['rev-parse', '--verify', '--end-of-options', `${privateRef}^{commit}`], signal)).trim()
      if (verified !== expectedSha) return { ...result, error: 'head-moved' }
      const tracking = `refs/remotes/${remoteName}/${sourceRef}`
      const trackingChanged = async (): Promise<'head-moved' | 'tracking-conflict' | undefined> => {
        const current = await this.optionalRef(root, tracking, signal)
        if (current === verified) return undefined
        if (current === undefined) return 'tracking-conflict'
        try { const base = (await this.run(root, ['merge-base', current, verified], signal)).trim(); return base === verified ? 'head-moved' : 'tracking-conflict' } catch { signal.throwIfAborted(); return 'tracking-conflict' }
      }
      const local = await this.optionalRef(root, `refs/heads/${branch}`, signal)
      if (local !== undefined && plan.rejectExistingBranch === true) return { ...result, error: 'branch-conflict' }
      if (local !== undefined && local !== verified) return { ...result, error: 'branch-conflict' }
      if (sameRepo) {
        let prepared = false
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const old = await this.optionalRef(root, tracking, signal)
          if (old === verified) { prepared = true; break }
          if (old !== undefined) {
            // A tracking ref ahead of or divergent from the verified snapshot must never move backwards.
            let base: string
            try { base = (await this.run(root, ['merge-base', old, verified], signal)).trim() } catch { signal.throwIfAborted(); return { ...result, error: 'tracking-conflict' } }
            if (base !== old) return { ...result, error: base === verified ? 'head-moved' : 'tracking-conflict' }
          }
          await guards.beforeSideEffect?.()
          try { await this.run(root, ['update-ref', tracking, verified, old ?? '0'.repeat(verified.length)], signal); prepared = true; break } catch { signal.throwIfAborted() }
        }
        if (!prepared) return { ...result, error: 'tracking-conflict' }
        result = { ...result, trackingRefPrepared: true }
        const mapping = `+refs/heads/${sourceRef}:${tracking}`
        // Read config as NUL-separated key/value records, preserving all pre-existing mappings.
        const config = await this.run(root, ['config', '--null', '--list'], signal)
        const mappings = config.split('\0').flatMap(entry => entry.startsWith(`remote.${remoteName}.fetch\n`) ? [entry.slice(`remote.${remoteName}.fetch\n`.length)] : [])
        if (!mappings.includes(mapping) && !mappings.includes(`+refs/heads/*:refs/remotes/${remoteName}/*`)) {
          await guards.beforeSideEffect?.()
          await this.run(root, ['config', '--add', `remote.${remoteName}.fetch`, mapping], signal)
          result = { ...result, fetchMappingAdded: true }
        }
        if (local !== undefined) {
          const upstream = (await this.run(root, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`], signal)).trim()
          if (upstream !== tracking) return { ...result, error: 'branch-conflict' }
        }
      } else if (local !== undefined) {
        const upstream = (await this.run(root, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`], signal)).trim()
        if (upstream !== '') return { ...result, error: 'branch-conflict' }
      }
      // Recheck immediately before entering; Git also refuses conflicting worktrees and local changes.
      if ((await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], signal)) !== '') return { ...result, error: 'dirty' }
      await guards.beforeSideEffect?.()
      await guards.beforeEnter?.()
      if ((await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], signal)) !== '') return { ...result, error: 'dirty' }
      if (sameRepo) { const changed = await trackingChanged(); if (changed !== undefined) return { ...result, error: changed } }
      const currentBranch = (await this.run(root, ['branch', '--show-current'], signal)).trim()
      if (currentBranch !== branch) {
        const worktrees = (await this.run(root, ['worktree', 'list', '--porcelain', '-z'], signal)).split('\0')
        if (worktrees.includes(`branch refs/heads/${branch}`)) {
          const head = (await this.run(root, ['rev-parse', '--verify', 'HEAD'], signal)).trim()
          return { ...result, head, worktreeConflict: true, error: 'git-transport-or-local-failure' }
        }
      }
      switchAttempted = true
      await this.run(root, local === undefined ? ['switch', '-c', branch, verified] : ['switch', branch], signal)
      result = { ...result, switched: true }
      if (sameRepo) {
        await guards.beforeSideEffect?.()
        const changed = await trackingChanged()
        if (changed !== undefined) {
          const head = (await this.run(root, ['rev-parse', '--verify', 'HEAD'], signal)).trim()
          return { ...result, head, error: changed }
        }
        await this.run(root, ['branch', `--set-upstream-to=${remoteName}/${sourceRef}`, branch], signal)
        result = { ...result, upstreamNotConfigured: false }
      }
      const head = (await this.run(root, ['rev-parse', '--verify', 'HEAD'], signal)).trim()
      return { ...result, head, ...(head === verified ? {} : { error: 'head-moved' as const }) }
    } catch (error) {
      // Read actual state even if the caller cancelled; this is a local, bounded reconciliation.
      let head: string | undefined
      if (switchAttempted) {
        try { head = (await this.run(root, ['rev-parse', '--verify', 'HEAD'], AbortSignal.timeout(3000))).trim() } catch { /* Receipt retains completed stages. */ }
      }
      return { ...result, ...(head === undefined ? {} : { head }), error: error instanceof GitRemoteError && error.code === 'git/head-moved' ? 'head-moved' : 'git-transport-or-local-failure' }
    }
  }
}
