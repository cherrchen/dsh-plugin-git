/** Portable Git repository operations over `ctx.subprocess`. */

import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOG_FORMAT, parseGitLog } from './log.ts'
import { canonicalPath } from './path-identity.ts'
import { parseBranches, parsePorcelainV2 } from './status.ts'
import type { GitCheckout, GitCommitSummary, GitCreatedWorktree, GitDiff, GitFileChange, GitLogScope, GitRepositorySnapshot, GitWorktree } from './types.ts'
import { parseWorktreeList } from './worktrees.ts'
import { DEFAULT_WORKTREE_DIRECTORY, isPoolDirectory } from './worktree-settings.ts'

/** Extra `git log` arguments implementing one history scope. */
function logScopeArgs(scope: GitLogScope): readonly string[] {
  if (scope === 'all') return ['--all']
  if (scope === 'first-parent') return ['--first-parent']
  return []
}

/** Resolved Git process policy. */
export interface GitServiceOptions {
  readonly executable: string
  readonly maxOutputBytes: number
  readonly graceMs: number
}

/** Filesystem slice used to mark a freshly created checkout pool. */
export interface WorktreePoolFs {
  /** Metadata for one path, or `undefined` when it is absent. */
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<unknown>
  /** Resolve a path into the backend's opaque write target. */
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal | undefined }): Promise<unknown>
  /** Atomically create or replace one text file. */
  writeText(target: unknown, content: string, expected?: { kind: string }, signal?: AbortSignal): Promise<unknown>
}

/** Request accepted by {@link GitService.createWorktree}. */
export interface GitCreateWorktreeRequest {
  /** New branch name, also used as the checkout directory; omission generates one. */
  readonly name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  readonly from?: string
  /** Checkout pool: relative to the repository root, or absolute. */
  readonly directory?: string
}

/** Failure from a settled Git invocation. */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

/** Cohesive local-repository service consumed by RPC and same-process plugins. */
export class GitService {
  /** Cache successful lookups only; request cancellation must not poison the service. */
  private executable: string | undefined

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly options: GitServiceOptions,
  ) {}

  /**
   * Locate the repository containing a path.
   * @param path - Existing path used as the Git working directory.
   * @param signal - Optional command cancellation signal.
   * @returns Repository root, or `null` when the path is outside a repository.
   */
  async discover(path: string, signal?: AbortSignal): Promise<string | null> {
    try {
      return (await this.run(path, ['rev-parse', '--show-toplevel'], signal)).trim()
    } catch (error) {
      if (error instanceof GitCommandError && /not a git repository/iu.test(error.stderr)) return null
      throw error
    }
  }

  /**
   * Read a complete repository snapshot.
   * @param repository - Repository working directory.
   * @param signal - Optional command cancellation signal.
   * @returns Normalized identity, status, and local branches.
   */
  async status(repository: string, signal?: AbortSignal): Promise<GitRepositorySnapshot> {
    const root = (await this.run(repository, ['rev-parse', '--show-toplevel'], signal)).trim()
    const [versionText, statusText, branchText, checkout, worktrees] = await Promise.all([
      this.run(root, ['--version'], signal),
      this.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], signal),
      this.run(root, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(HEAD)', 'refs/heads'], signal),
      this.readCheckout(root, signal),
      this.readWorktrees(root, signal),
    ])
    const parsed = parsePorcelainV2(statusText)
    return {
      root,
      version: versionText.trim().replace(/^git version\s+/u, ''),
      ...parsed,
      branches: parseBranches(branchText),
      checkout,
      worktrees,
    }
  }

  /**
   * List checkouts registered for the repository that contains a path.
   * A failure to list worktrees yields an empty list so status and diff still work.
   * @param repository - Existing path inside the repository.
   * @param signal - Optional command cancellation signal.
   * @returns Checkout records, with `current` set on the checkout that contains `repository`.
   */
  async listWorktrees(repository: string, signal?: AbortSignal): Promise<readonly GitWorktree[]> {
    const root = (await this.run(repository, ['rev-parse', '--show-toplevel'], signal)).trim()
    return this.readWorktrees(root, signal)
  }

  /**
   * Create a fresh branch and checkout, mirroring the upstream experimental
   * worktree service's contract for hosts that do not mount it. The new branch
   * starts at a pinned local commit and the checkout lands in the configured
   * pool directory — `<root>/.agents/worktrees/<name>` by default, matching the
   * upstream convention. Existing branches and occupied paths fail; a partially
   * created checkout is retained, as upstream documents.
   * @param repository - Existing path inside the repository.
   * @param request - Optional new name, local revision, and pool directory.
   * @param fs - Optional filesystem slice used to write the pool's self-ignoring
   *   `.gitignore` and to reject an occupied destination before Git runs.
   * @param signal - Optional command cancellation signal.
   * @returns The created checkout path, branch, and pinned commit.
   */
  async createWorktree(
    repository: string,
    request: GitCreateWorktreeRequest = {},
    fs?: WorktreePoolFs,
    signal?: AbortSignal,
  ): Promise<GitCreatedWorktree> {
    const root = (await this.run(repository, ['rev-parse', '--show-toplevel'], signal)).trim()
    const branch = request.name ?? `worktree-${randomUUID()}`
    // The branch name doubles as the checkout directory, so reject path
    // separators and dot segments on top of Git's ref grammar.
    if (branch.startsWith('-') || branch.includes('\\') || branch.includes(':')
      || branch.split('/').some(part => part.length === 0 || part === '.' || part === '..')) {
      throw new Error('git: worktree branch name must be a relative Git branch name')
    }
    await this.run(root, ['check-ref-format', `refs/heads/${branch}`], signal)
    const existing = await this.runOutcome(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], signal, [0, 1])
    if (existing.exitCode === 0) throw new Error(`git: worktree branch already exists: ${branch}`)
    const revision = request.from ?? 'HEAD'
    if (revision.length === 0) throw new Error('git: worktree base must name a local commit, branch, or tag')
    const baseCommit = (await this.run(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], signal)).trim()
    const directory = (request.directory ?? DEFAULT_WORKTREE_DIRECTORY).trim()
    if (directory.length === 0) throw new Error('git: worktree directory must not be empty')
    const absolute = posix.isAbsolute(directory) || win32.isAbsolute(directory)
    const pool = absolute ? directory : `${root}/${directory}`
    const path = `${pool}/${branch}`
    let poolExisted = true
    if (fs !== undefined) {
      if (await fs.lstat(path, undefined, signal) !== undefined) {
        throw new Error(`git: worktree path already exists: ${path}`)
      }
      poolExisted = await fs.lstat(pool, undefined, signal) !== undefined
    }
    await this.run(root, ['worktree', 'add', '-b', branch, '--', path, baseCommit], signal, {
      // LFS smudge needs network or credentials; a fresh checkout skips it.
      GIT_LFS_SKIP_SMUDGE: '1',
    })
    if (fs !== undefined && !poolExisted && isPoolDirectory(directory)) {
      try {
        const marker = await fs.resolve(`${pool}/.gitignore`, { signal })
        await fs.writeText(marker, '*\n', { kind: 'createIfAbsent' }, signal)
      } catch {
        // The checkout exists; a missing pool marker only leaves status noise.
      }
    }
    return { path, branch, baseCommit }
  }

  /**
   * Read a working-tree or staged diff.
   * @param repository - Repository working directory.
   * @param staged - Whether to compare the index instead of the working tree.
   * @param path - Optional repository-relative path filter.
   * @param signal - Optional command cancellation signal.
   * @returns Plain, colorless diff text and its repository identity.
   */
  async diff(repository: string, staged: boolean, path?: string, signal?: AbortSignal): Promise<GitDiff> {
    const args = ['diff', '--no-ext-diff', '--no-color', ...staged ? ['--cached'] : []]
    if (path !== undefined) args.push('--', path)
    return { repository, staged, ...path === undefined ? {} : { path }, text: await this.run(repository, args, signal) }
  }

  /**
   * Stage one path, or all paths when omitted.
   * @param repository - Repository working directory.
   * @param change - Optional complete change record. Its target path is staged.
   * @param signal - Optional command cancellation signal.
   * @returns Repository snapshot after the index update.
   */
  async stage(repository: string, change?: GitFileChange, signal?: AbortSignal): Promise<GitRepositorySnapshot> {
    await this.run(repository, change === undefined ? ['add', '--all'] : ['add', '--', change.path], signal)
    return this.status(repository, signal)
  }

  /**
   * Remove one path, or every path, from the index without changing the working tree.
   * @param repository - Repository working directory.
   * @param change - Optional complete change record. Renames reset both paths.
   * @param signal - Optional command cancellation signal.
   * @returns Repository snapshot after the index update.
   */
  async unstage(repository: string, change?: GitFileChange, signal?: AbortSignal): Promise<GitRepositorySnapshot> {
    await this.run(repository, change === undefined ? ['reset', '--mixed'] : ['reset', '--mixed', '--', ...changePaths(change)], signal)
    return this.status(repository, signal)
  }

  /**
   * Commit the staged index with a non-empty message.
   * @param repository - Repository working directory.
   * @param message - Commit message passed as one argv value.
   * @param signal - Optional command cancellation signal.
   * @param amend - When true, rewrite HEAD instead of creating a new commit.
   * @returns Repository snapshot after the commit.
   */
  async commit(repository: string, message: string, signal?: AbortSignal, amend: boolean = false): Promise<GitRepositorySnapshot> {
    const normalized = message.trim()
    if (normalized.length === 0) throw new Error('commit message must not be empty')
    await this.run(
      repository,
      amend ? ['commit', '--amend', '-m', normalized] : ['commit', '-m', normalized],
      signal,
    )
    return this.status(repository, signal)
  }

  /**
   * Push the current branch to `origin`, creating upstream tracking on first push.
   * @param repository - Repository working directory.
   * @param signal - Optional command cancellation signal.
   * @returns Repository snapshot after the push.
   */
  async push(repository: string, signal?: AbortSignal): Promise<GitRepositorySnapshot> {
    await this.run(repository, ['push', '--set-upstream', 'origin', 'HEAD'], signal)
    return this.status(repository, signal)
  }

  /**
   * Rebase the current branch onto its upstream, then push.
   * @param repository - Repository working directory.
   * @param signal - Optional command cancellation signal.
   * @returns Repository snapshot after the sync.
   */
  async sync(repository: string, signal?: AbortSignal): Promise<GitRepositorySnapshot> {
    await this.run(repository, ['pull', '--rebase', '--autostash'], signal)
    const before = await this.pushDestination(repository, signal)
    await this.run(repository, ['push'], signal)
    const snapshot = await this.status(repository, signal)
    const after = await this.pushDestination(repository, signal)
    return before !== undefined && after !== undefined && before.ref === after.ref && before.remote === after.remote ? { ...snapshot, pushedRemote: before.remote } : snapshot
  }

  /** A hint for notices only; ambiguous or changed push configuration is not guessed. */
  private async pushDestination(repository: string, signal?: AbortSignal): Promise<{ ref: string; remote: 'origin' | 'upstream' } | undefined> {
    try {
      const ref = (await this.run(repository, ['symbolic-ref', '--quiet', 'HEAD'], signal)).trim()
      if (!ref.startsWith('refs/heads/')) return undefined
      const parts = (await this.run(repository, ['for-each-ref', '--format=%(refname)%00%(push:remotename)%00', ref], signal)).split('\0')
      if (parts.length !== 3 || parts[0] !== ref || (parts[1] !== 'origin' && parts[1] !== 'upstream') || parts[2]?.trim() !== '') return undefined
      return { ref, remote: parts[1] }
    } catch { signal?.throwIfAborted(); return undefined }
  }

  /**
   * Discard working-tree, HEAD, or untracked content. Destructive: callers
   * confirm before invoking.
   * @param repository - Repository working directory.
   * @param change - Optional complete change record. Required for `head` and `untracked`.
   * @param signal - Optional command cancellation signal.
   * @param mode - `worktree` restores the index, `head` restores both index and working tree from HEAD, `untracked` deletes the path.
   * @returns Repository snapshot after the discard.
   */
  async discard(
    repository: string,
    change?: GitFileChange,
    signal?: AbortSignal,
    mode: 'worktree' | 'head' | 'untracked' = 'worktree',
  ): Promise<GitRepositorySnapshot> {
    if (mode === 'untracked') {
      if (change === undefined) throw new Error('untracked discard requires a change record')
      await this.run(repository, ['clean', '-f', '--', change.path], signal)
      return this.status(repository, signal)
    }
    if (mode === 'head') {
      if (change === undefined) throw new Error('HEAD discard requires a change record')
      await this.discardHead(repository, change, signal)
      return this.status(repository, signal)
    }
    if (change === undefined) await this.run(repository, ['checkout', '--', '.'], signal)
    else await this.discardWorktree(repository, change, signal)
    return this.status(repository, signal)
  }

  /** Restore one staged change to HEAD, including paths absent from HEAD with later working-tree edits. */
  private async discardHead(repository: string, change: GitFileChange, signal?: AbortSignal): Promise<void> {
    const indexStatus = change.status[0]
    if (indexStatus === 'A' || indexStatus === 'C') {
      await this.run(repository, ['rm', '-f', '--cached', '--', change.path], signal)
      await this.run(repository, ['clean', '-f', '--', change.path], signal)
      return
    }
    if (indexStatus === 'R' && change.originalPath !== undefined) {
      await this.run(repository, ['rm', '-f', '--cached', '--', change.path], signal)
      await this.run(repository, ['clean', '-f', '--', change.path], signal)
      await this.run(repository, ['checkout', 'HEAD', '--', change.originalPath], signal)
      return
    }
    await this.run(repository, ['checkout', 'HEAD', '--', change.path], signal)
  }

  /** Restore one working-tree change while retaining the index. */
  private async discardWorktree(repository: string, change: GitFileChange, signal?: AbortSignal): Promise<void> {
    const worktreeStatus = change.status[1]
    if (worktreeStatus === 'A' || worktreeStatus === 'C') {
      await this.run(repository, ['clean', '-f', '--', change.path], signal)
      return
    }
    if (worktreeStatus === 'R' && change.originalPath !== undefined) {
      await this.run(repository, ['clean', '-f', '--', change.path], signal)
      await this.run(repository, ['checkout', '--', change.originalPath], signal)
      return
    }
    await this.run(repository, ['checkout', '--', change.path], signal)
  }

  /**
   * Read one bounded page of commit history, newest first.
   * @param repository - Repository working directory.
   * @param limit - Page size; callers page forward with `skip`.
   * @param skip - Number of commits to offset before the first returned row.
   * @param scope - History scope: HEAD ancestry (`auto`), all refs (`all`),
   *   or the HEAD first-parent chain (`first-parent`).
   * @param signal - Optional command cancellation signal.
   * @returns Commit rows in output order (newest first).
   */
  async log(
    repository: string,
    limit: number,
    skip: number,
    scope: GitLogScope = 'auto',
    signal?: AbortSignal,
  ): Promise<readonly GitCommitSummary[]> {
    const cappedLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
    const cappedSkip = Math.max(0, Math.floor(skip))
    const text = await this.run(repository, [
      'log', `--max-count=${cappedLimit}`, `--skip=${cappedSkip}`,
      `--format=${GIT_LOG_FORMAT}`, '--date-order', ...logScopeArgs(scope),
    ], signal)
    return parseGitLog(text)
  }

  /**
   * Create a local branch without switching to it.
   * @param repository - Repository working directory.
   * @param branch - Non-empty local branch name passed as one argv value.
   * @param signal - Optional command cancellation signal.
   * @returns Repository snapshot containing the new branch.
   */
  async createBranch(repository: string, branch: string, signal?: AbortSignal): Promise<GitRepositorySnapshot> {
    await this.run(repository, ['branch', requireBranch(branch)], signal)
    return this.status(repository, signal)
  }

  /**
   * Switch to an existing local branch.
   * @param repository - Repository working directory.
   * @param branch - Existing local branch name passed as one argv value.
   * @param signal - Optional command cancellation signal.
   * @returns Repository snapshot after switching branches.
   */
  async switchBranch(repository: string, branch: string, signal?: AbortSignal): Promise<GitRepositorySnapshot> {
    await this.run(repository, ['switch', requireBranch(branch)], signal)
    return this.status(repository, signal)
  }

  /** Classify this checkout without failing the snapshot when Git cannot answer. */
  private async readCheckout(root: string, signal?: AbortSignal): Promise<GitCheckout> {
    try {
      const lines = (await this.run(root, [
        'rev-parse', '--git-dir', '--git-common-dir', '--is-bare-repository',
      ], signal)).trim().split(/\r?\n/u)
      const gitDirText = lines[0] ?? ''
      const commonDirText = lines[1] ?? ''
      const bareText = lines[2] ?? ''
      const gitDir = canonicalPath(gitDirText, root)
      const commonDir = canonicalPath(commonDirText, root)
      const bare = bareText.trim() === 'true'
      return {
        kind: bare ? 'bare' : gitDir === commonDir ? 'main' : 'linked',
        gitDir,
        commonDir,
      }
    } catch {
      return { kind: 'unknown' }
    }
  }

  /** Read worktree porcelain; an unsupported or failing Git still leaves the snapshot usable. */
  private async readWorktrees(root: string, signal?: AbortSignal): Promise<readonly GitWorktree[]> {
    let text = ''
    try {
      text = await this.run(root, ['worktree', 'list', '--porcelain', '-z'], signal)
    } catch {
      try {
        text = await this.run(root, ['worktree', 'list', '--porcelain'], signal)
      } catch {
        return []
      }
    }
    return parseWorktreeList(text).map(entry => ({
      ...entry,
      current: canonicalPath(entry.path, root) === canonicalPath(root, root),
    }))
  }

  /** Execute an internal remote integration command through the same bounded portable subprocess policy. Never exposed as an arbitrary RPC. */
  async remoteCommand(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    return this.run(cwd, args, signal, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' })
  }

  private async run(cwd: string, args: readonly string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
    return (await this.runOutcome(cwd, args, signal, [0], env)).stdout
  }

  private async runOutcome(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    allowedExitCodes: readonly number[],
    env?: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; exitCode: number }> {
    signal?.throwIfAborted()
    // Each initial caller owns its lookup signal. Sharing an in-flight promise
    // would let one cancelled workspace break unrelated sessions as well.
    const executable = this.executable ?? await this.subprocess.resolveExecutable(this.options.executable, undefined, signal)
    signal?.throwIfAborted()
    this.executable = executable
    const handle = this.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.options.maxOutputBytes },
        stderr: { maxBytes: this.options.maxOutputBytes },
      },
      graceMs: this.options.graceMs,
      signal,
      env: {
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        NO_COLOR: '1',
        TERM: 'dumb',
        // Filenames are literal pathspecs; magic prefixes such as `:(glob)` stay one path.
        GIT_LITERAL_PATHSPECS: '1',
        ...env,
      },
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout?.lossy === true || stderr?.lossy === true) {
      throw new GitCommandError(`git ${args[0] ?? 'command'} output exceeded ${this.options.maxOutputBytes} bytes`, outcome.exitCode, stderr?.text ?? '')
    }
    if (outcome.exitCode === null || !allowedExitCodes.includes(outcome.exitCode)) {
      throw new GitCommandError(stderr?.text.trim() || `git ${args[0] ?? 'command'} failed`, outcome.exitCode, stderr?.text ?? '')
    }
    return { stdout: stdout?.text ?? '', exitCode: outcome.exitCode }
  }
}

/** Cordis declaration for the portable service. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    git: GitService
  }
}

/**
 * Read the Git service from a typed Host context.
 * @param ctx - Context whose active composition provides `git`.
 * @returns Installed Git service.
 */
export function gitService(ctx: Context): GitService {
  return ctx.git
}

function requireBranch(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error('branch name must not be empty')
  return normalized
}

/** Paths that represent one rename as a single index operation. */
function changePaths(change: GitFileChange): readonly string[] {
  return change.originalPath === undefined ? [change.path] : [change.path, change.originalPath]
}
