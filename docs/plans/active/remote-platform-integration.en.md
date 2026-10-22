[中文](remote-platform-integration.md) | English

# Plan: Remote platform integration (ADR-0004)

- **Status**: In progress
- **Started**: 2026-10-22
- **Completed**:

## Background

**Current**: The remote-platform implementation is present; full external/platform acceptance is pending. Existing local Git behavior and old-host support remain the baseline. The [final Decision in ADR-0004](../../decisions/ADR-0004-remote-platform-integration.md#decision) is the sole design authority; clause numbers below refer to that section, not historical review rounds. Technical review items are closed, but the ADR remains **Proposed (pending freezing)**. Authorization to start implementation does not automatically promote it to Accepted.

**Planned / In progress**: Implement the complete ADR in dependency order, S0→S7. S0 analysis/documentation and the S1 safe contracts/Host boundary have landed; S1 delivers only the fail-closed boundary (structured `off` answers and `git/remote-unavailable` rejections) and does not make the remote feature available. S2–S6 authentication, REST, Git integration, guarded writes and Client are wired; S7 notifications are implemented. Complete seams enable Remote and old hosts remain fail-closed. Automated tests, full-release-matrix evidence and real-platform acceptance are recorded separately; this plan remains active until all acceptance is complete.

## Goals

### Requirement analysis

| Requirement | Observable acceptance | Stages |
| --- | --- | --- |
| Portable remote entry | Main-fiber right-sidebar `git.remote`; GitHub first, with a provider-neutral model rather than GitHub-bound UI; old hosts still load and run local Git | S1, S3, S6, S7 |
| PR workflows | List, detail, file comparison, PR comments, inline comments and approve/comment/request-changes reviews, checkout, create, close, merge | S3–S6 |
| Limited Issue scope | Read-only list, detail, comments; create `issue-{n}-{slug}` through existing branch operations | S3, S4, S6 |
| Identity and permission safety | All-or-nothing credentials seam; writable storage is neither authentication nor repository/action permission; every write binds a repository, stable viewer, and one credential snapshot | S1–S3, S5 |
| Honest failures and concurrency | Persist refresh send intent and never replay possibly consumed refresh credentials; verify checkout SHA, protect concurrent tracking updates, report partial effects; do not misreport unknown remote writes | S2, S4, S5 |
| Lifecycle and budgets | Stop admission, cancel/await owned work on unload; isolate account caches, back off rate limits, deduplicate notifications; Desktop is removable enhancement only | S2, S3, S6, S7 |

Acceptance must extend beyond happy paths: prove no token reaches RPC, logs, or argv; enforce separate API/browser allowlists; prevent workspace/account/generation changes from causing cross-account writes or stale UI.

## Non-goals

- No Review Mode, editor embedding, GitLab, GHES, or self-hosted implementation; retain structure for later providers only.
- No Issue mutations, custom queries, hover cards, completion, TODO→issue, or local application of suggestions.
- Create PR accepts already-pushed remote branches, including forks. It does not push or create forks; direct users to the existing push RPC.
- Do not take over Git transport authentication or bridge OAuth tokens into `git fetch/push`; no automatic branch deletion or promise of atomic rollback across refs/config.
- Implementation never touches real credentials, real OAuth, remote writes, or destructive actions; dependency installation/network access needs prior approval, and no commits, pushes, or publication happen without instruction.

## Design

### Boundaries and implementation locations (Planned)

Extend the [current architecture](../../architecture/overview.md): Host owns capability gating, credential runtime, REST providers, Git integration, and `/git` RPC. Client receives only wire-safe state/results; its main fiber owns all portable UI. Git continues through `ctx.subprocess` with separate argv values, without shell, Electron, or Desktop runtime dependencies. Optional Desktop notifications belong in a child `ctx.inject(['desktop'], ...)` fiber declaring only consumed structural methods.

Implement alongside existing Host entry/service, shared types, `src/compat/`, Client controller/sidebar, and their tests. Keep remote state machines and provider modules separate from local Git paths. Establish `docs/reference/remote-platform-rpc.md` as the canonical stable RPC reference when contracts land; architecture links to it rather than duplicating schemas.

### Stages and acceptance gates

| Stage | Dependencies | ADR clauses | Exit criteria |
| --- | --- | --- | --- |
| S0 Analysis and plan | None | 1–15 | Bilingual plan/indexes and documentation checks complete; ADR status unchanged |
| S1 Safe contracts and Host boundary | S0 | 1, 4, 7, 9, 15 | Incomplete seam is off; complete seam is also off while implementation is pending; no local Git regression |
| S2 Credential/auth runtime | S1; dependency lanes and store guarantees | 2–7 | Deterministic discovery, sign-in/out, refresh, and unload-failure tests |
| S3 Neutral provider and REST reads | S2 | 7, 8, 10, 13, 15 | Bounded, cancellable, account-isolated PR/Issue reads and permission facts |
| S4 Repository identity and Git integration | S3 identity/snapshots | 9–11, 15 | Checkout SHA/CAS/partial receipts and Issue branch temporary-repository tests pass |
| S5 Guarded writes | S2–S4 | 9, 12, 15 | Single-snapshot identity checks, SHA preconditions, unknown-outcome reconciliation; every mutator gated |
| S6 Portable Client | S1–S5 | 1, 5, 7, 9, 12, 15 | Complete PR/Issue/auth UI, two-step confirmations, safe inline anchors; unload preserves local UI |
| S7 Notifications and integration acceptance | S1–S6 | 1, 13–15 | Removable notification enhancement, full compatibility matrix and final acceptance evidence; only then complete the plan |

Passing a stage completes only that gate. Missing later capabilities remain Planned, without a placeholder Remote UI. In particular, S1 must not equate “seam detected” with “remote feature enabled.”

## Checklist

### S0 — Analysis and bilingual plan

- [x] Complete requirements, security boundaries, staged acceptance, bilingual plans, and both index levels; `pnpm docs:check` and `git diff --check` passed, with evidence in the log below. Preserve the user's ADR/decision indexes verbatim without status promotion.

### S1 — Safe contracts and Host boundary

- [x] Define secret-free capability, opaque generation, viewer, permission, action, structured error/receipt contracts. Keep local credential key/ref grammar equivalent to upstream, with branded constructors and no runtime credentials import. Landed in `src/remote/types.ts` (published via `src/types.ts`/`./types`) and `src/remote/credentials.ts`; the key/ref grammar matches upstream `KEY_SEGMENT_PATTERN`/`REF_PATTERN` byte for byte, and `gitRemoteCredentialKey('dsh-plugin-git','github-com')` yields `dsh-plugin-git/github-com`.
- [x] Structurally probe `readRecord`, `modifyRecord`, `deleteRecord`, `resolve`, `describe`, `describeRecord`, and the actual `record-updated` emission surface (`notifyRecordUpdated`, prototype-inherited members accepted, inspected but never invoked). A generic event API is not evidence that the event exists. Any missing member disables the whole feature, without per-method degradation or version-string gating. Landed in `probeCredentialsService`.
- [x] `/git` `remote-capability` always returns structured off/reason; other unavailable `remote-*` operations return `git/remote-unavailable`. Even a complete seam reports implementation-pending/off until auth/provider runtime exists; do not register placeholder Remote UI. Landed in `src/remote/feature.ts` plus the `src/index.ts` boundary dispatch (remote endpoints are handled before `record()`/repository assertions).
- [x] Capability probes use no network or subprocesses and infer no authenticated identity from `describe*`; preserve old-host loading and Changes/Diff/Graph/Worktrees. Counter assertions show zero spawns/fetches.
- [x] Focused tests cover each missing method/event, secret leakage, zero-network/subprocess probing, dynamic seam loss, and local Git regression; document the landed RPC/architecture boundary. See `tests/remote-feature.spec.ts`, `tests/remote-endpoints.spec.ts`, and [remote-platform RPC](../../reference/remote-platform-rpc.md).

### S2 — Credential/auth runtime

- [x] Before consuming upstream types, add `@deepseek-ai/dsh-credentials` as an optional peer/type-only development dependency with lane-aware install/compatibility handling. Declare ranges only for lanes where the package was published; do not force nonexistent packages into old lanes. Local branded constructors retain no runtime import; use registry semver, never `workspace:`. The peer OR covers only `CREDENTIALS_SEAM_DSH_RELEASES` (from `0.2.0-rc.2`) and is marked `optional`; dev pin `0.2.0-rc.2`; the compat gate checks that subset and older lanes may install without the package.
- [x] Validate GrantRecord v1, record key/ref, and host/client/app binding. Perform every state transition through `modifyRecord` mutate/CAS with a fresh, non-reusable persisted revision; no extra files/settings/keychain. Distinguish persisted revision from Host opaque `{ instanceId, revision }`; token fingerprint is an irreversible process-local digest, never wire/log data. Landed in `src/remote/grant.ts` (`parseGrantRecord` and the state union, `dsh-plugin-git/github-com`) and `auth.ts` (`authBase` mints a `uuid` revision per commit, sha256 in-process digest).
- [x] Resolve per operation; discover authenticated grant→`GH_TOKEN`/`GITHUB_TOKEN` refs→`gh auth token`→anonymous, reporting the actual source. Run `gh` serially only for identity-establishment events: seam mount, credential events, explicit retry, and rebuilding identity after 401; at most one round per event. A 401 becomes invalid with repair guidance, not silent account fallback; anonymous applies only when no credentials ever existed. `establish()`/`resolveContext()` check grant→refs→cached `ghToken`→anonymous in order; `markInvalid` records the fingerprint to block the same token; malformed/unsupported records report `invalid` without falling back to discovery.
- [x] Allow `git credential fill` only as an explicit user action. Credential probes set `GIT_ASKPASS=''`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`, and `-c credential.interactive=never`, with ≤5s hard timeout, bounded output, redacted errors, no stdout/stderr forwarding, and no token in argv. Landed in `src/remote/probe.ts`: `git credential fill` runs only via the explicit `useGitCredential()`; protocol/host travel over stdin; timeout/cancellation compose through an internal AbortController that terminates the child and awaits its exit on abort; output is capped at 4096 bytes and failures become redacted `GitRemoteError`s.
- [x] Device Flow uses public client_id from `Config.remote.clientId` and `repo` scope. Persist authorizing/attemptId by CAS first, then commit only the matching attempt. Handle interval, slow_down, expiry, denial, cancellation, and repeated-login exclusion. Hide login without client_id but retain discovery; expiring credentials without refresh tokens become reauth-required. Landed in `startLogin`/`pollLogin`/`cancelLogin`; without `clientId`, `startLogin` rejects and `capability().loginAvailable === false`.
- [x] Sign-out persists signed-out and suppresses discovery across restart. “Clear local authorization” separately calls `deleteRecord` to resume discovery and explicitly does not revoke the token server-side. Landed in `signOut()` (CAS write of signed-out) and `clearLocalGrant()` (`deleteRecord`).
- [x] Refresh prepare must **commit** refreshing/refreshId/basedOnRevision before the owner sends outside the lock. Complete writes new tokens only on matching refreshId+basedOnRevision CAS. Onlookers wait a bounded interval, then require reauthentication; they never resend. Landed in `refresh()`: a lost marker CAS moves to a bounded `waitRefresh` (`refreshPollMs`/`refreshTtlMs`/`refreshExpiresAt`) and adopts the settled result; a failed prepare commit throws before any send.
- [x] Never replay after sent-request timeout, response loss, any 5xx including 502/504, deterministic rejection, complete-commit failure, crash, or restart. A crash after marker commit but before send also burns the attempt. Only transport-confirmed **not sent** permits safe retry; failed prepare commit sends nothing. Failed completion discards new tokens and reports remote-updated/local-uncommitted. Only `GitRemoteTransportNotSent`/`kind: 'not-sent'` takes the restore path permitting a later safe retry; other failures CAS to `reauth-required`; a complete-commit exception/CAS miss throws `{ stage: 'complete', remoteUpdated: true, localCommitted: false }` and keeps the marker.
- [x] Enable automatic rotation only with a **positive backing-store cross-process mutex guarantee**, not an inferred local lock or an invented upstream method. Otherwise explicitly expose/document automatic rotation as unavailable. `refreshStoreExclusive` defaults to `false`; without the attestation refresh moves to `reauth-required` without sending, and `automaticRefreshAvailable` honestly reports `false`.
- [x] Seam unload stops admission, cancels and awaits all owned work including login/refresh/probes, and clears account viewer/permission/ETag caches. Fake store/clock/transport/subprocess tests cover concurrency, CAS, crash recovery, confirmed-not-sent exception, redaction, and unload drain; no real OAuth calls. `dispose()` stops admission, aborts every controller, and `allSettled`s in-flight work; queued work re-checks disposed/aborted before starting. See `tests/remote-auth.spec.ts` (25 tests), `tests/remote-http.spec.ts` (12 tests), and `tests/remote-probe.spec.ts` (5 tests). The engine is now wired through S3–S6; old hosts retain the S1 gate.

### S3 — Neutral provider and REST reads

- [x] Define neutral PR/Issue/viewer/permission/error models: open/closed/merged PR state plus raw-state, explicit fork head/base identity; read PR lists/details/file comparisons/comments/threads and Issue lists/details/comments.
- [x] GitHub REST uses a version header, AbortSignal, and a per-request page cap with origin-checked cursor continuation (no total-item ceiling; the Client streams pages progressively). Separate API/web origins: authenticated requests, redirects, and pagination `Link` stay inside the API allowlist; browser `html_url`, openExternal, and device verification URLs use the HTTPS web allowlist without tokens. `gh` is not the REST transport.
- [x] At most one `GET /user` per generation establishes stable user.id. Expose storage, auth, viewer, and repository permissions separately. Action checks are true/false/unknown (unknown permits an attempt subject to server judgment); `canMerge` follows push, `canClose` follows authorship or push, never storage writability.
- [x] Authenticated ETag caches key by host+viewer+repo+full query string and invalidate on account changes. Anonymous refresh is manual-only; authenticated polling is ≥60s or stricter response-header limits. Honor X-Poll-Interval/Retry-After/reset, primary/secondary limits, exponential backoff, and actionable SSO/scope/auth failures.
- [x] Mock-transport tests cover hostile redirects/Link/URLs, pagination truncation, cancellation, rate limits, SSO, unknown permissions, cross-account caches, and generation invalidation; no real GitHub access.

### S4 — Repository identity and Git integration

- [x] Parse SSH/HTTPS remotes using machine-readable Git output; aggregate origin/upstream provider/host/owner/repo. Classify missing/unsupported remotes and establish the local allowed identity set for all target-write assertions.
- [x] Before checkout, verify payload remote/head against that set and refuse dirty workspaces. Fetch into a private PR ref containing the **base repository key**, then verify fetched SHA equals API head SHA; report head races and refresh on mismatch.
- [x] Same-repository tracking uses expected-old `update-ref` CAS, with all-zero expectation for missing refs. Bound equal/ahead-retry/divergent-refusal handling to prevent backward movement from background fetch or overwriting concurrent creation. Append missing fetch mappings, preserving single-branch clone mappings; tracking proves a verified snapshot, not remote freshness.
- [x] Switch/create from the explicit verified SHA, then configure upstream. Before reusing a same-name/same-SHA branch, prepare tracking and verify existing upstream matches. Refuse same-name/different-SHA with manual naming guidance; forks use `pr-N` without upstream. Preserve multi-worktree errors; success requires actual HEAD == verified SHA.
- [x] Receipts distinguish no checkout change with partial privateRef/trackingRef/fetchMapping preparation from a switched actual HEAD with unfinished upstream. No fake rollback, automatic branch deletion, or blind cleanup. Keep OAuth out of Git transport and distinguish platform-authenticated from Git-fetch-unauthenticated.
- [x] Reuse `createBranch`/`switchBranch` for Issue branches. Temporary-repository tests cover same-number origin/upstream PRs, dirty state, API SHA races, background-fetch progress, concurrent missing-ref creation, equal/ahead/divergence, single-branch mappings, branch reuse, multi-worktree, config errors, and all checkout failure/partial-receipt phases.

### S5 — Guarded remote writes

- [x] Enumerate every remote mutator in `isRepositoryWrite`: PR comments, inline comments, reviews, create/close/merge, PR checkout, Issue branches, and any other ref/config/branch writes. Do not classify reads/capability as writes.
- [x] Apply both `assertSessionRepository` and the local allowed remote host/owner/repo assertion. Payloads carry object identity, `expectedGeneration`, and `expectedViewer(host + stable user.id)`. Use **one immutable per-operation resolved credential snapshot** for identity checks and sending, never a replacement token after checking. Reject changed contexts with refresh/reconfirmation; cancel unsent writes on workspace changes.
- [x] Map merge `expectedHeadSha` to GitHub `sha`; send the viewed snapshot's SHA as review `commit_id`. Create PR models fork head/base explicitly and accepts only already-pushed branches. Preserve permission prechecks and protection/scope denials; wire close/merge two-step confirmation in S6.
- [x] Do not automatically retry non-idempotent comments, reviews, create/close/merge. Sent timeout/cancellation returns `write-result-unknown` with directed refresh/reconciliation for the affected object, not “not sent” or automatic resubmission.
- [x] Mock tests cover account changes including same login/different id, generation/repository changes, credential changes after checks, unsent cancellation versus sent unknown outcome, head-moved, and duplicate-submission prevention. Assert the actual request uses the exact checked snapshot's token.

### S6 — Portable Client

- [x] Main fiber polls capability and dynamically registers/removes `git.remote` type plus portable body/title. Discard/cancel replies mismatching workspace/account/generation. Remote-provider unload preserves local Changes/Diff/Graph/Worktrees without Desktop dependency.
- [x] Deliver PR/Issue browsing, file comparison, comments/reviews, checkout, create PR from pushed branches, Issue branches, and auth repair. Hide login without client_id; distinguish sign-out from clearing local authorization and platform auth from Git transport auth. Supply Chinese/English product copy through existing locale mechanisms.
- [x] Comparison snapshots retain path, base/head SHA, original old/new line numbers, and side anchors. Submit `line/side`, multiline `start_line/start_side`, and same-snapshot `commit_id`; never use deprecated position or infer original coordinates from rendered numbers.
- [x] For deletions, renames, multiple hunks, multiline ranges, outdated threads, truncation, or ambiguity without reliable anchors, keep read browsing available but visibly disable unsafe inline submission with an explanation. Do not introduce Review Mode.
- [x] Enforce two-step close/merge confirmation using the discard pattern; show tri-state permissions, renewed confirmation after head changes, and directed reconciliation for unknown outcomes instead of blind retries.
- [x] Client controller/component/lifecycle tests cover complete read/write flows, anchors, out-of-order replies, account/directory changes, dynamic seam loss, timer/subscription/request teardown, and retained local UI.

### S7 — Notifications, compatibility, and integration acceptance

- [x] Deduplicate review requests, own PR merged/closed/changes-requested events, and post-push create-PR suggestions by event id. Web uses an in-tab badge. Desktop enhancement calls structural `notification.show` only in its child fiber; removing it preserves core UI and badges.
- [x] Drive **every supported exact release lane** from the [compatibility contract](../../reference/dsh-compatibility.md) and its linked canonical version list, not just minimum/latest. Retain lane-aware optional credentials installation. Prove old-host install, bundle load, and local Git with a genuinely package-absent installation tree, not merely a mocked missing seam.
- [x] Record seam mount/unmount and abort/drain on both minimum seam host `0.2.0-rc.2` and current supported upper release `0.2.1-rc.2`; do not confuse development pin with latest support. Obtain user permission before any matrix installation needing network access.
- [x] Update requirements, architecture, RPC reference, compatibility contract, and relevant bilingual navigation as each stage lands. Synchronize root `README.md`/`README.zh.md` and refresh both hashes in `README.i18n.yaml`; adjust development constraints where needed so Planned/Current reflects reality. Do not defer all documentation to S7.
- [ ] Run final gates and collect manual acceptance evidence. Only after all implementation and acceptance completes, mark Completed, move **both** plans to `completed/`, and repair indexes/links. Do not archive after S0/S1 or automatically accept the ADR.

## Validation

### Layered evidence

| Scope | Method and recording requirements |
| --- | --- |
| This S0 documentation task | Run **only** `pnpm docs:check` and `git diff --check`; save logs at an absolute temporary path outside the repository and report it in handoff. No build/unit/artifact checks or network installation |
| S1–S6 | Focused Host/Client tests, mock transport/store/clock, and temporary repositories per stage; record exact commands, exit codes, gates covered, and gaps |
| S7 final checkpoint | Run `pnpm compat:check`, `pnpm test`, `pnpm docs:check`, `pnpm build`, `pnpm test:artifact` once in full; preserve equivalent per-lane evidence across the full release matrix, not just a default-lane result |
| Manual/external | Real Device Flow/SSO/remote reads and writes, Windows/Linux/Web/Desktop acceptance require environment and user approval. Mark unexecuted checks **Not verified**, never substitute mocks or a successful build |

Use redacted logs and simulated credentials throughout automated tests; never operate user credentials, real remote writes, or destructive actions. Real OAuth/remote-write acceptance needs separate authorization, isolation, and records, not an automatic consequence of checking a plan item.

### Risks and external prerequisites

| Item | Handling/blocking scope |
| --- | --- |
| Public OAuth client_id and App Device Flow setting | Deployment supplies/enables them; absent configuration hides login, never implies authentication is available |
| Positive backing-store cross-process mutex guarantee | Verify actual provider contract/implementation; without it automatic rotation is unavailable and documented, not enabled through an invented API |
| GitHub primary/secondary limits, organization SSO and permission policies | Mock normalized errors/budgets first; real behavior needs an approved environment. Writable storage never substitutes for auth or permission |
| Git fetch authentication and local concurrency | Use existing user Git transport; SHA/CAS and partial receipts protect concurrent changes, with actionable recovery guidance |
| Optional dependencies and old-lane installation | Update dependency handling before consumption; network installation requires approval, and old-host package-absent evidence is mandatory |
| GHES/self-hosted host-id encoding | Explicitly deferred, not a GitHub.com freezing blocker or an excuse to implement self-hosted support |

Keep implementation on current `feat/git-remote`. If later authorized to commit, use the user's normal Git identity with absolutely no Generator or Co-author attribution; no push/publication unless requested.

### Progress and verification log

| Date | Stage | Record |
| --- | --- | --- |
| 2026-10-22 | S0 | Read repository rules, documentation skill/template, branch/mirror note, final 15 ADR clauses, and plan indexes. Organized the settled requirements/design and wrote bilingual plans/indexes. `pnpm docs:check` passed (55 Markdown files, 569 links, 188 filenames, exit 0); `git diff --check` passed (no output, exit 0). Log saved outside the repository, with its absolute temporary path supplied in handoff |
| 2026-10-22 | S1 | Landed `src/remote/{types,credentials,feature}.ts`, the `src/types.ts` re-export, and the `src/index.ts` remote boundary dispatch plus error adapter; added `tests/remote-feature.spec.ts` and `tests/remote-endpoints.spec.ts`. `pnpm exec vitest run tests/remote-feature.spec.ts tests/remote-endpoints.spec.ts tests/rpc-channel.spec.ts tests/host-entry.spec.ts`: 4 files, 63 tests passed; `pnpm build:types:standalone` exit 0; `pnpm docs:check` and `git diff --check` passed. Logs kept in a temporary directory outside the repository (path in handoff report) |
| 2026-10-22 | S2 | Landed `src/remote/{settings,errors,grant,http,probe,auth}.ts`, the `Config.remote` schema, and the `@deepseek-ai/dsh-credentials` optional peer (the `CREDENTIALS_SEAM_DSH_RELEASES` subset); added `tests/remote-{auth,http,probe}.spec.ts`. `pnpm exec vitest run tests/remote-auth.spec.ts tests/remote-http.spec.ts tests/remote-probe.spec.ts tests/remote-feature.spec.ts tests/remote-endpoints.spec.ts tests/rpc-channel.spec.ts tests/host-entry.spec.ts`: 7 files, 98 tests passed; `pnpm build:types:standalone`, `pnpm compat:check`, `pnpm docs:check`, and `git diff --check` all exit 0. At that stage checkpoint the engine was internal and capability remained off; subsequent work is recorded below. No real OAuth. Logs kept outside the repository at `/tmp/dsh-git-s2/` |
| 2026-10-22 | S2–S7 continuation | Fixed authentication cancellation/slow_down/URL/body deadlines; added provider/github-model/github/git/runtime/diff, RPC wiring, Client remote surface/controller and notifications. Focused tests and types passed; the main lane passed 442 tests in 43 files, compat/docs/build and four artifact tests; all 17 exact release lanes passed final gates, recorded below. Real OAuth, remote writes and cross-platform manual acceptance remain **Not verified** |
| 2026-10-22 | S3/S6 continuation | Remote list/comment/file reads moved from "fetch everything within one request budget and flag `truncated`" to cursor-driven progressive streaming: `RemotePage` exposes an opaque `next`; `remote-list-*`/`remote-comments`/`remote-files` accept `cursor`/`pages`; the provider re-checks cursor origins and keeps a per-request page bound. The Client controller now appends items with a serial background stream, deduplicates by number/id/path, and retries once at `resetAt` after a rate limit; `remote-files` continuations pin the comparison snapshot via expected SHAs. The truncated banner is gone and inline comments stay disabled until files are fully loaded; bounded collection for notification expansion and write-path coordinate checks is unchanged. `pnpm test` passed 448 tests in 43 files; `pnpm build` and `pnpm docs:check` exit 0. Real remote acceptance remains **Not verified** |
| 2026-10-22 | S3/S6 continuation | PR detail no longer renders file diffs proactively: added `remote-commits`/`remote-reviews` read endpoints (`RemoteCommit`/`RemoteReview` models, five normalized `state` values); file changes are reached through a GitHub Files link (`pr.url + '/files'`). Commit and review history reuse cursor streaming; inline comments are read-only and nested under their review via `reviewId`; the composer drops the inline submission entry (no anchor picker). `remote-files`/`remote-inline-comment` remain guarded capabilities but the Client no longer calls them. Also fixed an infinite load/open retry loop on detail-page failures by recording attempted keys. `pnpm test` passed 451 tests in 43 files; `pnpm build` and `pnpm docs:check` exit 0. Real remote acceptance remains **Not verified** |

## 2026-10-22 automated acceptance snapshot

All gates exited 0: `pnpm compat:check`, `pnpm test --maxWorkers=4`, `pnpm docs:check`, `pnpm build`, `pnpm test:artifact`. Worker limits isolate resource contention across concurrent lanes without reducing coverage. Earlier unbounded concurrent runs hit existing UI specifications' five-second timeouts; all final lanes were rechecked successfully.

The user authorized network installation in isolated temporary copies. The original development pin remains 0.2.0-rc.2; the working directory's original locked versions were restored solely to refresh installation metadata. For old lanes, .pnpmfile.cjs omits the root optional credentials peer development edge while preserving the published manifest, and upgrade-dsh.mjs removes its dev pin. Registry inspection found credentials packages published for some older versions; package absence is an explicit test condition, not an inference about publication dates.

remote-endpoints exercises seam mount/unmount and preservation of local Git using each real Cordis version. Mock store/HTTP auth/provider tests exercise abort/drain, immutable snapshots and unknown writes. Temporary repositories cover checkout/CAS/partial receipts; Client/controller/component specifications cover cancellation, stale replies, two-step confirmation and optional notification unload. Minimum seam and supported upper release execute the same specifications. This does not prove real credential backing-store exclusion, OAuth/SSO or remote writes.

| Exact release snapshot | Business/contract tests | Credentials installation | All gates |
| --- | --- | --- | --- |
| `0.1.5-rc.2` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.1.5-rc.3` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.1.6-alpha.1` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.1.6-alpha.2` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.1.7-alpha.1` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.1.7-alpha.2` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.1.7-rc.1` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.1.7-rc.2` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.2.0-rc.1` | 441 passed, 1 absent-package differential skipped | Absent, asserted | Passed |
| `0.2.0-rc.2` | 442 passed | Matching exact release | Passed |
| `0.2.1-alpha.1` | 442 passed | Matching exact release | Passed |
| `0.2.1-alpha.2` | 442 passed | Matching exact release | Passed |
| `0.2.1-alpha.3` | 442 passed | Matching exact release | Passed |
| `0.2.1-alpha.4` | 442 passed | Matching exact release | Passed |
| `0.2.1-alpha.5` | 442 passed | Matching exact release | Passed |
| `0.2.1-rc.1` | 442 passed | Matching exact release | Passed |
| `0.2.1-rc.2` | 442 passed | Matching exact release | Passed |

Old lanes skip only the constructor differential requiring the absent optional package; all business tests execute. Each lane passes four artifact tests. No-secret-on-RPC/argv and no credentials runtime import invariants remain enforced. Public neutral models are exported through ./types, with per-lane type/artifact rechecks.

**Not verified**: real Device Flow/SSO, real remote reads/writes, and Windows/Linux/Web/Desktop manual scenarios. Missing public client_id hides login; absent cross-process store exclusion disables rotation. The plan remains In progress, is not archived, and does not automatically accept the ADR. Changes are saved in one complete commit; no push or publication. External temporary log run identifiers are dsh-git-remote-final and dsh-git-remote-matrix-20261022.

## Related Documents

- [ADR-0004: final Decision (sole design authority)](../../decisions/ADR-0004-remote-platform-integration.md#decision)
- [Scope and requirements (Current baseline)](../../requirements/scope-and-requirements.md)
- [Current architecture](../../architecture/overview.md)
- [DSH compatibility contract](../../reference/dsh-compatibility.md)
- [Root README (existing features and installation)](../../../README.md)
- [Documentation maintenance rules](../../../.agent/skills/documentation/SKILL.md)
- [Branch and mirror layout](../../../.agent/note/branch-and-mirror-layout.en.md)
- [Plan index](../README.en.md) / [Active index](README.en.md)
