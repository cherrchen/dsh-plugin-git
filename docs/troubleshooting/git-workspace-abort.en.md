[中文](git-workspace-abort.md) | English

# Blank Git surfaces and persistent AbortError

## Symptoms

- Composer branch and change controls disappear, Changes retains only its current-branch heading, and Graph has no history.
- Worktrees reports `This operation was aborted`, including after another refresh.
- Cancelling the first load in one session can prevent other sessions from loading Git data.
- A checkout is created and the session enters it, but the creation dialog still reports AbortError.

Distinguish this failure from [RPC channel 405](git-rpc-channel-405.md) and the [Windows focus storm](windows-desktop-console-flood.md) by inspecting the error. Temporary repositories, real subprocesses and client mounting tests verify this chain; the user's running Desktop process has not been retested.

## Causes

1. Composer and sidebar surfaces share a session controller. Changes / Worktrees call `refresh()` before their workspace-binding effect. Refresh advances result ownership without changing the directory, but the previous `setWorkspace()` guard required both path and generation equality. Mounting another surface therefore cancelled the existing binding and cleared its repository and commit draft. This cancellation risk already existed on main; Worktrees reused the same mount order.
2. The Host cached the Promise returned by its first `resolveExecutable(..., signal)` call. Cancellation left a rejected Promise cached for the service's lifetime. Later discover/status/log calls, including other sessions, inherited the same AbortError.
3. When refresh superseded initial discovery, the binding's generation check skipped its capability probes. Refresh previously updated only repository data, so directory-switch and generation capabilities could remain at their initial values.
4. Changes displayed errors only inside the commit region after a repository existed; Graph displayed only log errors. Neither showed repository discovery/status failures. Worktrees already rendered `state.error`, exposing the AbortError that the other tabs hid.
5. Worktree creation can publish its directory projection before its RPC reply. If a dispatched creation shares the workspace binding's cancellation signal, the projection's `setWorkspace()` cancels its own successful reply.

## Fix

- Keep same-directory bindings idempotent independently of refresh result generations. Actual directory changes still cancel and reset the old binding; refresh coalescing and the single trailing read remain bounded.
- Cache only successfully resolved executable paths. Initial callers own separate cancellable lookups instead of sharing a request-scoped Promise. Failed lookups can be retried and cannot transfer cancellation to other sessions.
- Re-probe capabilities after successful refreshes, covering both superseded startup and sessions becoming live.
- Display repository failures in Changes before a snapshot exists and in Graph alongside history failures.
- Give a dispatched worktree creation its own cancellation signal and settle the dialog from its reply. Rebinding still cancels old reads and undispatched writes; the creation reply does not refresh the superseded directory. Disposing the controller still cancels in-flight creation.

An old service holding a rejected Promise needs to be recreated after loading the fix, by reloading the plugin or restarting the Host. Refreshing the old UI alone cannot clear its Host cache.

## Verification

- `tests/service.spec.ts`: real subprocess recovery after cancelled initial discovery, followed by discover/status/log; two sessions and overlapping tab mounts load branches, changes, checkouts and history.
- `tests/controller.client.spec.ts`: overlapping initial binding, refresh and same-directory remount preserve request signals, drafts and capability results.
- `tests/git-branch-control.client.spec.tsx`: one real controller drives composer, Changes, Worktrees and Graph together, with all four receiving data. RPC answers are fixtures; the service tests cover real Git execution.
- `tests/details-surface.client.spec.tsx`: failures remain visible without a repository snapshot; upstream creation requires a live session even for Enter submission inside an open dialog; local creation remains independent and alone displays its pool hint.
- `tests/worktree-endpoints.spec.ts`: local and upstream-delegated creation in real temporary repositories accepts a successful reply even when the directory projection arrives first, and displays the new checkout. `tests/worktree-feature.client.spec.ts` covers disposal cancelling creation.

See the [architecture overview](../architecture/overview.md).
