/** Client-side Git state and RPC orchestration. */

import type { GitCommitSummary, GitCommitMessageCapability, GitCreatedWorktree, GitDiff, GitFileChange, GitGenerationUnavailableReason, GitLogScope, GitRepositorySnapshot, GitWorktreeMode } from '../types.ts'
import { layoutGitGraph } from './graph/layout.ts'
import type { GraphContinuationState, GraphLayoutRow } from './graph/types.ts'
import type { GitWorktreeFeature } from './worktree-feature.ts'

export type GitRpcResult = { ok: true; value: unknown } | { ok: false; error: { message: string } }

/** Structural subset of the Connection RPC caller consumed by the Git client. */
export interface GitRpcClient {
  /**
   * Call one Git endpoint through the logical Connection channel.
   * @param channel - Absolute logical channel.
   * @param endpoint - Channel-relative Git endpoint.
   * @param payload - Endpoint request payload.
   * @returns Host success or error result.
   */
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<GitRpcResult>
}

/** Exact Desktop methods consumed by this plugin's optional enhancement. */
export interface GitDesktopCapability {
  shell: {
    showItemInFolder(path: string): Promise<void>
    openPath(path: string): Promise<string>
  }
  notification: {
    show(options: { title: string; body?: string }): Promise<{ shown: boolean }>
  }
}

/** Number of commits loaded per graph page. */
export const GIT_GRAPH_PAGE_SIZE = 25

/** Hard cap on simultaneously active graph lanes. */
export const GIT_GRAPH_MAX_LANES = 3

export interface GitClientState {
  readonly workspacePath: string | undefined
  readonly repository: GitRepositorySnapshot | null | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly desktopAvailable: boolean
  /** Commit history page, newest first. */
  readonly graph: readonly GitCommitSummary[]
  /** Whether a graph page request is in flight. */
  readonly graphLoading: boolean
  /** Whether another graph page may exist past the loaded ones. */
  readonly graphHasMore: boolean
  readonly graphError: string | undefined
  /** History scope used for the loaded graph. */
  readonly graphScope: GitLogScope
  /** Whether the current binding's first graph page already settled (loaded, empty, or failed). */
  readonly graphLoaded: boolean
  /** Renderer-ready graph rows laid out across all loaded pages. */
  readonly graphRows: readonly GraphLayoutRow[]
  /** Maximum visible lane count across the loaded rows. */
  readonly graphLaneCount: number
  /** Editable commit message proposal/input shared by the commit region. */
  readonly commitMessage: string
  /** Whether a commit message generation request is in flight. */
  readonly generating: boolean
  /** Whether the Host reports a configured generation backend. */
  readonly generationAvailable: boolean
  /** Why generation is unavailable; absent when available or unknown. */
  readonly generationReason: GitGenerationUnavailableReason | undefined
  readonly generationError: string | undefined
  /** Whether this host can change the bound session's directory. */
  readonly directorySwitchAvailable: boolean
  /** Whether a session directory change is queued or in flight. */
  readonly enteringWorktree: boolean
  /** Host-reported Worktrees feature mode; `undefined` until the first answer lands. */
  readonly worktreeMode: GitWorktreeMode | undefined
  /** Pool directory reported for local-mode creation hints. */
  readonly worktreeDirectory: string | undefined
  /** Whether a worktree creation is queued or in flight. */
  readonly creatingWorktree: boolean
}

/** Follow-up remote action after a successful local commit. */
export type GitCommitFollowUp = 'push' | 'sync'

/** Options for {@link GitClientController.commit}. */
export interface GitCommitOptions {
  /** Rewrite HEAD instead of creating a new commit. */
  readonly amend?: boolean
  /** Push or rebase-then-push after the commit lands. */
  readonly followUp?: GitCommitFollowUp
}

/** Observable controller shared by the composer control and details surface. */
export class GitClientController {
  private state: GitClientState = {
    workspacePath: undefined,
    repository: undefined,
    loading: false,
    error: undefined,
    desktopAvailable: false,
    graph: [],
    graphLoading: false,
    graphHasMore: true,
    graphError: undefined,
    graphScope: 'auto',
    graphLoaded: false,
    graphRows: [],
    graphLaneCount: 0,
    commitMessage: '',
    generating: false,
    generationAvailable: false,
    generationReason: undefined,
    generationError: undefined,
    directorySwitchAvailable: false,
    enteringWorktree: false,
    worktreeMode: undefined,
    worktreeDirectory: undefined,
    creatingWorktree: false,
  }
  private readonly listeners = new Set<() => void>()
  /** Cancels Git RPC started for the current workspace when that workspace changes. */
  private operations = new AbortController()
  private desktop: GitDesktopCapability | undefined
  private operationGeneration = 0
  /**
   * In-flight repository refresh; concurrent refreshes for the same workspace
   * reuse it instead of starting another Host round trip.
   */
  private refreshing: {
    path: string | undefined
    generation: number
    promise: Promise<void>
    /** Whether the round has issued its repository read; later requests need a trailing one. */
    burst: { read: boolean; repeat: boolean }
  } | undefined
  /** Serializes repository mutations and worktree directory changes so overlapping RPCs apply in call order. */
  private mutationTail: Promise<void> = Promise.resolve()
  /** Directory changes queued on `mutationTail`, including the one currently in flight. */
  private directoryEntries = 0
  /** Workspace binding identity; refreshing the same path does not replace it. */
  private boundWorkspace: { path: string | undefined } | undefined
  private diffNavigator: ((path: string, staged: boolean) => void) | undefined
  /** Monotonic request identity for graph pages; stale responses are discarded. */
  private graphRequestGeneration = 0
  /** Monotonic request identities for independently replaceable async results. */
  private generationRequestGeneration = 0
  private capabilityRequestGeneration = 0
  private readonly unsubscribeWorktreeFeature: (() => void) | undefined
  /** Lane continuation state between loaded graph pages. */
  private graphContinuation: GraphContinuationState | undefined

  /**
   * @param rpc - Connection caller for the `/git` channel.
   * @param sessionId - Session this controller belongs to. Included on RPC payloads
   * so the host can bind writes to that session's directory. Omitted by direct tests.
   * @param worktreeFeature - Shared creation capability; standalone controllers
   * probe it during workspace binding when no store is provided.
   */
  constructor(
    private readonly rpc: GitRpcClient,
    private readonly sessionId?: string,
    private readonly worktreeFeature?: GitWorktreeFeature,
  ) {
    if (worktreeFeature !== undefined) {
      const sync = (): void => {
        const capability = worktreeFeature.getSnapshot()
        this.patch({ worktreeMode: capability.mode, worktreeDirectory: capability.directory })
      }
      this.unsubscribeWorktreeFeature = worktreeFeature.subscribe(sync)
      sync()
    }
  }

  /**
   * Read the current immutable view consumed by React external-store hooks.
   * @returns Current controller state.
   */
  readonly getSnapshot = (): GitClientState => this.state
  /**
   * Subscribe to state changes.
   * @param listener - Callback invoked after a state replacement.
   * @returns Disposer that removes the callback.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Install or remove the optional native capability.
   * @param desktop - Minimal Desktop service, or `undefined` after provider unload.
   */
  setDesktop(desktop: GitDesktopCapability | undefined): void {
    this.desktop = desktop
    this.patch({ desktopAvailable: desktop !== undefined })
  }

  /**
   * Install the right-sidebar diff navigation (set at plugin mount).
   * @param navigator - Opens one Diff surface tab for the path and side.
   */
  setDiffNavigator(navigator: ((path: string, staged: boolean) => void) | undefined): void {
    this.diffNavigator = navigator
  }

  /**
   * Open one changed path as its own Diff surface tab (create-or-reuse via
   * the stable diff tab key). No-op when the right sidebar is unavailable;
   * each Diff surface fetches its own content once the tab mounts.
   * @param path - Repository-relative changed path.
   * @param staged - Whether to open the staged comparison.
   */
  openDiff(path: string, staged: boolean): void {
    this.diffNavigator?.(path, staged)
  }

  /**
   * Bind repository discovery to the current workspace path. Idempotent: the
   * right sidebar remounts surfaces on tab switches, and rebinding the same
   * workspace must not reset retained state (commit drafts, loaded graph).
   * @param workspacePath - Current workspace path, if one is selected.
   * @returns Completion after the first discover and status calls settle.
   */
  async setWorkspace(workspacePath: string | undefined): Promise<void> {
    // A refresh changes result ownership, not workspace identity. Another
    // surface mounting during that refresh must not abort the shared binding.
    const binding = this.boundWorkspace
    if (binding !== undefined
      && this.state.workspacePath === workspacePath
      && binding.path === workspacePath) return
    // Stop reads and writes that still name the previous checkout.
    this.operations.abort()
    this.operations = new AbortController()
    const signal = this.operations.signal
    const generation = ++this.operationGeneration
    this.boundWorkspace = { path: workspacePath }
    this.patch({
      workspacePath,
      repository: undefined,
      error: undefined,
      graph: [],
      graphRows: [],
      graphLaneCount: 0,
      graphHasMore: true,
      graphError: undefined,
      graphLoading: false,
      graphLoaded: false,
      commitMessage: '',
      generating: false,
      generationError: undefined,
      directorySwitchAvailable: false,
      enteringWorktree: false,
      worktreeMode: this.worktreeFeature?.getSnapshot().mode,
      worktreeDirectory: this.worktreeFeature?.getSnapshot().directory,
      creatingWorktree: false,
    })
    this.graphContinuation = undefined
    if (workspacePath === undefined) {
      this.patch({ loading: false })
      return
    }
    await this.loadRepository(generation, workspacePath, signal)
    if (generation !== this.operationGeneration || signal.aborted) return
    void this.loadGraph(true)
    this.loadCapabilities(generation, signal)
  }

  /**
   * Drop in-flight Git RPC. Called when the owning session controller is released.
   */
  dispose(): void {
    this.unsubscribeWorktreeFeature?.()
    this.operations.abort()
    this.listeners.clear()
  }

  /**
   * Discover and reload repository state for a workspace. A successful reload
   * invalidates the loaded graph so the Graph surface reloads history that may
   * have changed outside this session (external commits, branch switches).
   * Overlapping calls for the same workspace share the in-flight round trip
   * instead of superseding one another, so focus churn cannot stack Host
   * discovery/status calls or discard the round whose result would land. A
   * request that arrives after the shared round captured its snapshot is not
   * assumed covered by it: the burst runs one trailing read, and callers
   * merging into it await that read.
   * @param workspacePath - Workspace path, defaulting to the current controller state.
   * @returns Completion after the burst's last Host discovery and status calls settle.
   */
  async refresh(workspacePath = this.state.workspacePath): Promise<void> {
    const signal = this.operations.signal
    if (workspacePath === undefined) {
      this.patch({ workspacePath, repository: undefined, loading: false, error: undefined })
      return
    }
    const inFlight = this.refreshing
    if (inFlight !== undefined && inFlight.path === workspacePath && inFlight.generation === this.operationGeneration) {
      // Reusing the round trip is only sound while that round has yet to read
      // the repository: its read still follows this request. Once it has read,
      // this request carries newer intent and needs a read of its own.
      if (inFlight.burst.read) inFlight.burst.repeat = true
      return inFlight.promise
    }
    const generation = ++this.operationGeneration
    const burst = { read: false, repeat: false }
    const run = (async (): Promise<void> => {
      await this.reloadRepository(generation, workspacePath, signal, () => { burst.read = true })
      // A requested trailing read runs even when this round failed: the request
      // that set it asked for a read of its own, and a transient discovery or
      // status failure must not absorb it. Bounded to exactly one extra read —
      // deeper chaining would let this controller's own Host traffic (the focus
      // events the Windows console windows raise) re-arm the burst forever.
      if (!burst.repeat || !burst.read || generation !== this.operationGeneration || signal.aborted) return
      await this.reloadRepository(generation, workspacePath, signal)
    })()
    this.refreshing = { path: workspacePath, generation, promise: run, burst }
    try {
      await run
    } finally {
      if (this.refreshing?.promise === run) this.refreshing = undefined
    }
  }

  /**
   * Discover and reload one workspace, retaining no result from a superseded binding.
   * @param generation - Operation generation owning this reload.
   * @param workspacePath - Workspace path to discover and read.
   * @param onRepositoryRead - Called once this round has issued its status read.
   */
  private async reloadRepository(
    generation: number,
    workspacePath: string,
    signal: AbortSignal,
    onRepositoryRead?: () => void,
  ): Promise<void> {
    await this.loadRepository(generation, workspacePath, signal, onRepositoryRead)
    if (signal.aborted || generation !== this.operationGeneration || this.state.error !== undefined) return
    // Keep the binding bookkeeping current so surface remounts after a
    // refresh stay idempotent.
    this.boundWorkspace = { path: workspacePath }
    // The binding generation invalidates an in-flight page. Clear its visible
    // loading state as well, so the Graph surface can schedule its replacement.
    this.patch({ graphLoading: false, graphLoaded: false, generating: false, generationError: undefined })
    // A refresh can supersede initial discovery before its capability probes,
    // and a previously cold session may now have a live agent.
    this.loadCapabilities(generation, signal)
  }

  /**
   * Read the diff for one changed path without retaining it: each Diff surface
   * owns its result, so multiple tabs never overwrite one another.
   * @param path - Repository-relative changed path.
   * @param staged - Whether to read the staged diff.
   * @returns The decoded diff.
   */
  async fetchDiff(path: string, staged: boolean): Promise<GitDiff> {
    const signal = this.operations.signal
    const repository = this.requireRepository()
    return decodeDiff(await this.call('diff', { repository: repository.root, path, staged }, signal))
  }

  /**
   * Ask the host to point this session at another checkout of the current repository.
   * The host performs the change through its working-directory service. This
   * controller waits for the session projection to publish the new path.
   * Overlapping calls share the mutation queue, and `enteringWorktree` stays
   * set until each queued change has settled so the checkout buttons stay disabled.
   * @param path - Checkout directory from the current worktree list.
   * @returns Completion after the host accepts the change.
   */
  async enterWorktree(path: string): Promise<void> {
    const signal = this.operations.signal
    const generation = this.operationGeneration
    const repositoryRoot = this.requireRepository().root
    this.directoryEntries += 1
    this.patch({ enteringWorktree: true })
    const run = async (): Promise<void> => {
      try {
        if (signal.aborted || !this.isBindingCurrent(generation, repositoryRoot)) return
        this.patch({ error: undefined })
        await this.call('set-directory', { repository: repositoryRoot, path }, signal)
      } catch (error) {
        if (signal.aborted || !this.isBindingCurrent(generation, repositoryRoot)) return
        const message = error instanceof Error ? error.message : String(error)
        this.patch({ error: message })
        throw error instanceof Error ? error : new Error(message)
      } finally {
        this.directoryEntries -= 1
        if (this.directoryEntries === 0) this.patch({ enteringWorktree: false })
      }
    }
    const pending = this.mutationTail.then(run, run)
    this.mutationTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  /**
   * Create a fresh branch and checkout through the active worktree mode.
   * Shares the mutation queue with directory changes so creations and enters
   * apply in call order. When the host entered the new checkout, the session
   * projection flips the workspace and this binding ends; otherwise a refresh
   * pulls the new checkout into the worktree list.
   * @param name - New branch/checkout name; empty or omitted generates one.
   * @param from - Local revision to start from; empty or omitted uses HEAD.
   * @returns Completion after the host accepts the creation and the list reloads.
   */
  async createWorktree(name?: string, from?: string): Promise<GitCreatedWorktree> {
    const signal = this.operations.signal
    const generation = this.operationGeneration
    const repositoryRoot = this.requireRepository().root
    const run = async (): Promise<GitCreatedWorktree> => {
      if (signal.aborted || !this.isBindingCurrent(generation, repositoryRoot)) throw abortError()
      this.patch({ creatingWorktree: true })
      try {
        const created = decodeCreatedWorktree(await this.call('create-worktree', {
          repository: repositoryRoot,
          ...(name !== undefined && name !== '' ? { name } : {}),
          ...(from !== undefined && from !== '' ? { from } : {}),
        }, signal))
        if (signal.aborted) throw abortError()
        // Entered creations hand the repository to the rebound workspace; a
        // refresh on the old binding is meaningless and the new one reloads
        // through `setWorkspace` anyway.
        if (!this.isBindingCurrent(generation, repositoryRoot)) return created
        await this.refresh()
        return created
      } catch (error) {
        if (signal.aborted || !this.isBindingCurrent(generation, repositoryRoot)) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw error instanceof Error ? error : new Error(message)
      } finally {
        // A reload above re-binds the operation generation, so this clears
        // unconditionally: a superseded binding already reset the flag and a
        // queued mutation runs only after this one settles.
        this.patch({ creatingWorktree: false })
      }
    }
    const pending = this.mutationTail.then(run, run)
    this.mutationTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  /**
   * Discard working-tree, HEAD, or untracked content of one path, or every
   * unstaged tracked path when omitted. Destructive; callers confirm first.
   * @param change - Optional complete file change record.
   * @param mode - `worktree` (default), `head` (restore index+worktree), or `untracked`.
   * @returns Completion after state refresh.
   */
  async discard(change?: GitFileChange, mode: 'worktree' | 'head' | 'untracked' = 'worktree'): Promise<void> {
    await this.mutate('discard', { ...(change === undefined ? {} : { change }), ...(mode === 'worktree' ? {} : { mode }) })
  }

  /**
   * Load a graph page, replacing (reset) or appending to the loaded history.
   * Appended pages continue the previous page's active lanes through the
   * stored continuation state instead of restarting from empty lanes.
   * @param reset - Replace the loaded page instead of appending.
   * @returns Completion after the Host log call settles.
   */
  async loadGraph(reset = true): Promise<void> {
    const signal = this.operations.signal
    const repository = this.state.repository
    if (repository === undefined || repository === null) {
      this.graphContinuation = undefined
      this.patch({ graph: [], graphRows: [], graphLaneCount: 0, graphHasMore: false, graphLoaded: false })
      return
    }
    const requestGeneration = ++this.graphRequestGeneration
    const bindingGeneration = this.operationGeneration
    const repositoryRoot = repository.root
    const scope = this.state.graphScope
    const skip = reset ? 0 : this.state.graph.length
    this.patch({ graphLoading: true, graphError: undefined })
    try {
      const commits = decodeCommits(await this.call('log', {
        repository: repositoryRoot,
        limit: GIT_GRAPH_PAGE_SIZE,
        skip,
        scope,
      }, signal))
      if (signal.aborted || !this.isRequestCurrent(bindingGeneration, repositoryRoot, requestGeneration, () => this.graphRequestGeneration)) return
      const graph = reset ? commits : [...this.state.graph, ...commits]
      if (reset) this.graphContinuation = undefined
      const layout = layoutGitGraph(commits, {
        ...(this.graphContinuation !== undefined ? { continuation: this.graphContinuation } : {}),
        firstParentOnly: scope === 'first-parent',
        maxLanes: GIT_GRAPH_MAX_LANES,
      })
      this.graphContinuation = layout.continuation
      this.patch({
        graph,
        graphRows: reset ? layout.rows : [...this.state.graphRows, ...layout.rows],
        graphLaneCount: reset ? layout.laneCount : Math.max(this.state.graphLaneCount, layout.laneCount),
        graphLoading: false,
        graphHasMore: commits.length === GIT_GRAPH_PAGE_SIZE,
        graphLoaded: true,
      })
    } catch (error) {
      // A settled failure counts as loaded: the empty-history auto effect must
      // not turn a failing `git log` into an infinite retry loop. Recovery is
      // an explicit refresh. Cancellation belongs to the replacement binding.
      if (signal.aborted || !this.isRequestCurrent(bindingGeneration, repositoryRoot, requestGeneration, () => this.graphRequestGeneration)) return
      this.patch({
        graphLoading: false,
        graphError: error instanceof Error ? error.message : String(error),
        graphLoaded: true,
      })
    }
  }

  /**
   * Load the next graph page and append it.
   * @returns Completion after the Host log call settles.
   */
  loadMoreGraph(): Promise<void> { return this.loadGraph(false) }

  /**
   * Switch the graph history scope and reload the first page.
   * @param scope - New history scope (`auto`, `all`, or `first-parent`).
   * @returns Completion after the reloaded page settles.
   */
  async setGraphScope(scope: GitLogScope): Promise<void> {
    if (scope === this.state.graphScope) return
    this.patch({ graphScope: scope })
    await this.loadGraph(true)
  }

  /**
   * Editable commit message input (survives tab switches within a session).
   * @param message - Current message text.
   */
  setCommitMessage(message: string): void {
    this.patch({ commitMessage: message })
  }

  /**
   * Generate a commit message proposal from the staged diff. Generation only
   * produces text: it never stages, commits, or pushes.
   * @returns Completion after the proposal lands in `commitMessage`.
   */
  async generateCommitMessage(): Promise<void> {
    const signal = this.operations.signal
    const repository = this.requireRepository()
    if (repository.staged.length === 0) {
      this.patch({ generationError: 'stage-changes-first' })
      return
    }
    const generation = this.operationGeneration
    const repositoryRoot = repository.root
    const requestGeneration = ++this.generationRequestGeneration
    this.patch({ generating: true, generationError: undefined })
    try {
      const staged = decodeDiff(await this.call('diff', { repository: repositoryRoot, staged: true }, signal))
      if (signal.aborted || !this.isRequestCurrent(generation, repositoryRoot, requestGeneration, () => this.generationRequestGeneration)) return
      const proposal = await this.call('generate-commit-message', {
        repository: repositoryRoot,
        stagedDiff: staged.text,
      }, signal)
      if (signal.aborted || !this.isRequestCurrent(generation, repositoryRoot, requestGeneration, () => this.generationRequestGeneration)) return
      if (typeof proposal !== 'string' || proposal.trim().length === 0) {
        throw new Error('generation returned an empty message')
      }
      this.patch({ commitMessage: proposal, generating: false })
    } catch (error) {
      // Stale requests (workspace switched, repository reloaded) publish
      // neither their proposal nor their failure.
      if (signal.aborted || !this.isRequestCurrent(generation, repositoryRoot, requestGeneration, () => this.generationRequestGeneration)) return
      this.patch({ generating: false, generationError: error instanceof Error ? error.message : String(error) })
    }
  }

  private loadCapabilities(generation: number, signal: AbortSignal): void {
    void this.loadGenerationCapability()
    void this.loadDirectoryCapability(generation, signal)
    if (this.worktreeFeature === undefined) void this.loadWorktreeCapability(generation, signal)
  }

  private async loadGenerationCapability(): Promise<void> {
    const signal = this.operations.signal
    const repository = this.state.repository
    if (repository === undefined || repository === null) return
    const bindingGeneration = this.operationGeneration
    const requestGeneration = ++this.capabilityRequestGeneration
    try {
      const capability = await this.call('commit-message-capability', {}, signal) as Partial<GitCommitMessageCapability>
      if (signal.aborted || !this.isRequestCurrent(bindingGeneration, repository.root, requestGeneration, () => this.capabilityRequestGeneration)) return
      const reason = capability.reason
      this.patch({
        generationAvailable: capability.available === true,
        generationReason: reason === 'not-configured' || reason === 'llm-unavailable' || reason === 'default-model-missing'
          ? reason
          : undefined,
      })
    } catch {
      if (signal.aborted || !this.isRequestCurrent(bindingGeneration, repository.root, requestGeneration, () => this.capabilityRequestGeneration)) return
      this.patch({ generationAvailable: false, generationReason: undefined })
    }
  }

  private async loadDirectoryCapability(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const value = await this.call('directory-capability', {}, signal)
      if (signal.aborted || generation !== this.operationGeneration) return
      const available = isRecord(value) && value['available'] === true
      this.patch({ directorySwitchAvailable: available })
    } catch {
      if (signal.aborted || generation !== this.operationGeneration) return
      this.patch({ directorySwitchAvailable: false })
    }
  }

  private async loadWorktreeCapability(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const value = await this.call('worktree-capability', {}, signal)
      if (signal.aborted || generation !== this.operationGeneration) return
      const mode = isRecord(value) ? value['mode'] : undefined
      const directory = isRecord(value) ? value['directory'] : undefined
      this.patch({
        worktreeMode: mode === 'upstream' || mode === 'local' ? mode : 'off',
        worktreeDirectory: typeof directory === 'string' ? directory : undefined,
      })
    } catch {
      // Hosts predating the endpoint report `off`: the Worktrees tab stays hidden.
      if (signal.aborted || generation !== this.operationGeneration) return
      this.patch({ worktreeMode: 'off', worktreeDirectory: undefined })
    }
  }

  /**
   * Stage one path or every path.
   * @param change - Optional complete file change record.
   * @returns Completion after state refresh.
   */
  async stage(change?: GitFileChange): Promise<void> { await this.mutate('stage', change === undefined ? {} : { change }) }
  /**
   * Unstage one path or the complete index.
   * @param change - Optional complete file change record.
   * @returns Completion after state refresh.
   */
  async unstage(change?: GitFileChange): Promise<void> { await this.mutate('unstage', change === undefined ? {} : { change }) }
  /**
   * Switch to an existing local branch.
   * @param branch - Local branch name.
   * @returns Completion after state refresh.
   */
  async switchBranch(branch: string): Promise<void> { await this.mutate('switch-branch', { branch }) }
  /**
   * Create a local branch without switching to it.
   * @param branch - New local branch name.
   * @returns Completion after state refresh.
   */
  async createBranch(branch: string): Promise<void> { await this.mutate('create-branch', { branch }) }

  /**
   * Commit the staged index (or amend HEAD), optionally push or sync, and
   * optionally show a native notification.
   * @param message - Non-empty commit message.
   * @param options - Amend and follow-up remote action.
   * @returns Completion after the mutation and optional notification settle.
   */
  async commit(message: string, options: GitCommitOptions = {}): Promise<void> {
    const applied = await this.mutate('commit', {
      message,
      ...(options.amend === true ? { amend: true } : {}),
    })
    if (!applied) return
    try {
      if (options.followUp === 'push') await this.mutate('push', {})
      if (options.followUp === 'sync') await this.mutate('sync', {})
      await this.desktop?.notification.show({ title: 'Git commit created', body: message.trim() })
    } finally {
      this.patch({ commitMessage: '' })
    }
  }

  /**
   * Reveal the repository, or one checkout inside it, through the optional
   * native file-manager action.
   * @param path - Checkout directory to reveal; the repository root when omitted.
   * @returns Completion after the native action settles, or immediately without Desktop.
   */
  async reveal(path?: string): Promise<void> {
    const repository = this.requireRepository()
    await this.desktop?.shell.showItemInFolder(path ?? repository.root)
  }

  private async loadRepository(
    generation: number,
    workspacePath: string,
    signal: AbortSignal,
    onRepositoryRead?: () => void,
  ): Promise<void> {
    this.patch({ workspacePath, loading: true, error: undefined })
    try {
      const root = decodeRoot(await this.call('discover', { path: workspacePath }, signal))
      if (signal.aborted || !this.isWorkspaceCurrent(generation)) return
      if (root === null) {
        this.patch({ repository: null, loading: false })
        return
      }
      // From here on this round reads the repository as it is now: a refresh
      // requested after this point must not be answered by this snapshot.
      onRepositoryRead?.()
      const snapshot = decodeSnapshot(await this.call('status', { repository: root }, signal))
      if (signal.aborted || !this.isWorkspaceCurrent(generation)) return
      this.patch({
        repository: snapshot,
        loading: false,
      })
    } catch (error) {
      if (signal.aborted || !this.isWorkspaceCurrent(generation)) return
      this.patch({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Apply one repository mutation and refresh the snapshot when the binding
   * that scheduled it is still current.
   * @param endpoint - Host mutation endpoint.
   * @param fields - Endpoint fields other than `repository`.
   * @returns `true` when this binding still owns the published snapshot.
   */
  private async mutate(endpoint: string, fields: Record<string, unknown>): Promise<boolean> {
    const signal = this.operations.signal
    const generation = this.operationGeneration
    const repositoryRoot = this.requireRepository().root
    const run = async (): Promise<boolean> => {
      if (signal.aborted || !this.isBindingCurrent(generation, repositoryRoot)) return false
      this.patch({ loading: true, error: undefined })
      try {
        const next = decodeSnapshot(await this.call(endpoint, { repository: repositoryRoot, ...fields }, signal))
        if (signal.aborted || !this.isBindingCurrent(generation, repositoryRoot)) return false
        // Commits, discards, and branch switches may change history: invalidate
        // the loaded graph so the Graph surface reloads instead of rendering the
        // pre-mutation log.
        this.patch({ repository: next, loading: false, graphLoaded: false })
        return true
      } catch (error) {
        if (signal.aborted || !this.isBindingCurrent(generation, repositoryRoot)) return false
        const message = error instanceof Error ? error.message : String(error)
        this.patch({ loading: false, error: message })
        throw error instanceof Error ? error : new Error(message)
      }
    }
    const pending = this.mutationTail.then(run, run)
    this.mutationTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  private requireRepository(): GitRepositorySnapshot {
    const repository = this.state.repository
    if (repository === undefined || repository === null) throw new Error('no Git repository is selected')
    return repository
  }

  /** Whether a repository discovery or status result still owns the workspace. */
  private isWorkspaceCurrent(generation: number): boolean {
    return generation === this.operationGeneration
  }

  /** Whether a result still belongs to the current workspace binding. */
  private isBindingCurrent(generation: number, repositoryRoot: string): boolean {
    return this.isWorkspaceCurrent(generation) && this.state.repository?.root === repositoryRoot
  }

  /** Whether an independently replaceable request still owns its result. */
  private isRequestCurrent(
    bindingGeneration: number,
    repositoryRoot: string,
    requestGeneration: number,
    latestRequestGeneration: () => number,
  ): boolean {
    return requestGeneration === latestRequestGeneration() && this.isBindingCurrent(bindingGeneration, repositoryRoot)
  }

  private async call(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw abortError()
    const fields = isRecord(payload) ? { ...payload } : {}
    if (this.sessionId !== undefined && this.sessionId.length > 0) fields['sessionId'] = this.sessionId
    const result = await this.rpc.call('/git', endpoint, fields, signal)
    if (signal.aborted) throw abortError()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  private patch(patch: Partial<GitClientState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeRoot(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value
  throw new Error('Git Host returned an invalid repository root')
}

function decodeCommits(value: unknown): readonly GitCommitSummary[] {
  if (!Array.isArray(value)) throw new Error('Git Host returned an invalid commit log')
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Git Host returned an invalid commit')
    const commit = entry as Partial<GitCommitSummary>
    if (typeof commit.hash !== 'string' || typeof commit.shortHash !== 'string'
      || typeof commit.subject !== 'string' || !Array.isArray(commit.parents)) {
      throw new Error('Git Host returned an invalid commit')
    }
    return {
      hash: commit.hash,
      shortHash: commit.shortHash,
      parents: commit.parents,
      subject: commit.subject,
      author: typeof commit.author === 'string' ? commit.author : '',
      date: typeof commit.date === 'string' ? commit.date : '',
      refs: Array.isArray(commit.refs) ? commit.refs.filter((ref): ref is string => typeof ref === 'string') : [],
    }
  })
}

function decodeDiff(value: unknown): GitDiff {
  if (typeof value !== 'object' || value === null) throw new Error('Git Host returned an invalid diff')
  const diff = value as Partial<GitDiff>
  if (typeof diff.repository !== 'string' || typeof diff.staged !== 'boolean' || typeof diff.text !== 'string'
    || (diff.path !== undefined && typeof diff.path !== 'string')) {
    throw new Error('Git Host returned an invalid diff')
  }
  return diff as GitDiff
}

function decodeCreatedWorktree(value: unknown): GitCreatedWorktree {
  if (!isRecord(value)) throw new Error('Git Host returned an invalid worktree result')
  const created = value as Partial<GitCreatedWorktree>
  if (typeof created.path !== 'string' || typeof created.branch !== 'string'
    || typeof created.baseCommit !== 'string') {
    throw new Error('Git Host returned an invalid worktree result')
  }
  return {
    path: created.path,
    branch: created.branch,
    baseCommit: created.baseCommit,
    ...(created.entered === true ? { entered: true } : {}),
  }
}

function decodeSnapshot(value: unknown): GitRepositorySnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('Git Host returned an invalid repository snapshot')
  const snapshot = value as Partial<GitRepositorySnapshot>
  if (typeof snapshot.root !== 'string' || typeof snapshot.version !== 'string'
    || !Array.isArray(snapshot.staged) || !Array.isArray(snapshot.unstaged)
    || !Array.isArray(snapshot.untracked) || !Array.isArray(snapshot.branches)) {
    throw new Error('Git Host returned an invalid repository snapshot')
  }
  return snapshot as GitRepositorySnapshot
}
