[中文](remote-platform-rpc.md) | English

# Remote-platform RPC contract (remote-*)

- **Status**: Current implementation, covered by mocks and temporary repositories; real OAuth, remote writes and platform manual acceptance remain Not verified.
- **Authority**: [ADR-0004 Decision](../decisions/ADR-0004-remote-platform-integration.md#decision) (Proposed) and the [implementation plan](../plans/active/remote-platform-integration.en.md).

## Gate and lifecycle

The `/git` channel disables the entire feature without a complete credentials seam. Structural checks require readRecord, modifyRecord, deleteRecord, resolve, describe, describeRecord and notifyRecordUpdated, including inherited methods; event emitters are never called by the probe. Missing names come from an allowlist; provider/getter/process/network diagnostics and secrets never propagate.

A credentials child fiber owns authentication, REST, caches and subprocess work. Unload stops admission, cancels and drains work, preserving the local Git service and Changes/Diff/Graph/Worktrees. The Client main fiber polls capability every five seconds and registers/removes `git.remote` type/body/title. Session/workspace changes cancel old requests; account/generation changes discard stale data. Desktop notification enhancement lives in an optional child fiber.

The seam uses local structural types without production or published-declaration imports of the optional package; older hosts can build and load without it. Release lanes are governed by the [compatibility contract](dsh-compatibility.md).

## remote-capability

Payload is ignored, including null. Missing seam returns `{state:'off',reason:'credentials-missing',auth:{state:'off'}}`; incomplete seams return credentials-incomplete and missing names. implementation-pending remains a fail-closed fallback when the runtime has not assembled.

With a complete seam the result is `{state:'on',generation,credential,auth,actions,loginAvailable,automaticRefreshAvailable}`. Capability launches no subprocess or network activity; it reads storage descriptions and known in-memory authentication state. Storage configured/writable does not prove authentication or remote permissions. Initial auth is unauthenticated and actions are unknown. Repository viewer, permissions and actions are returned separately by remote-repository.

`generation={instanceId,revision}` is opaque to clients; runtime replacement never reuses instanceId. Viewer identity is stable host/userId; login is presentation only. GET /user runs at most once per generation. Explicit retry creates a fresh generation; rejected tokens do not silently fall back to another account.

## Configuration and authentication

Configuration parsing/validation lives in src/remote/settings.ts and its schema in src/index.ts. All fields are optional volatile values:

| Field | Default | Meaning |
| --- | --- | --- |
| clientId | absent | Public Device Flow client id; hide login when absent, retaining discovery |
| requestTimeoutMs | 15000 | Total HTTP deadline, including redirects and body reading |
| probeTimeoutMs | 5000 | Non-interactive probe deadline, 1–5000 ms |
| refreshTtlMs | 30000 | Persistent refresh intent and observer wait TTL |
| refreshPollMs | 250 | Positive observer interval, no greater than TTL |
| refreshStoreExclusive | false | Deployment attestation of cross-process modifyRecord exclusion; otherwise no automatic rotation |
| maxResponseBytes | 4194304 | Per-response byte cap; cancel oversized streams immediately |

GrantRecord v1 uses key dsh-plugin-git/github-com. Transitions use modifyRecord CAS and a fresh revision. Discovery is authenticated grant → GH_TOKEN/GITHUB_TOKEN refs → gh auth token → anonymous. Ref source is provider-defined and resolved per operation; gh runs only for identity establishment/events/explicit retry, never per REST page. A rejected token becomes invalid without switching identity; loss of a previously present credential never silently becomes anonymous. Git credential fill is explicit, non-interactive and receives fixed host/protocol over stdin. Probe output never enters RPC, logs or argv; probes have bounded collection, ≤5s deadlines and exit drain.

| Authentication endpoint | Payload / result |
| --- | --- |
| remote-login | {} → attemptId,userCode,verificationUri,expiresAt,intervalMs; no device_code/token on wire |
| remote-poll-login | attemptId → authenticated; shares one poll per attempt, accumulates slow_down, rejects denied/expired/cancelled authorization |
| remote-cancel-login | attemptId; cancel polling and CAS-finish that attempt |
| remote-sign-out | {}; persist signed-out to suppress discovery |
| remote-clear-grant | {}; delete only the local grant, resume discovery, no GitHub server revocation |
| remote-retry-auth | {}; explicitly rebuild identity, return capability |
| remote-use-git-credential | {}; explicit non-interactive helper probe, return capability |

Device Flow verification is restricted to https://github.com/login/device. Refresh first CAS-commits an intent marker, exchanges outside the lock, then commits new tokens only for matching refreshId/basedOnRevision. Failed prepare sends nothing. Only confirmed-not-sent permits restoring the old snapshot. Timeout, cancellation, 5xx, response loss or crash never replay the exchange and converge to reauth-required. Failed completion discards new tokens and reports complete/remoteUpdated/localCommitted facts.

## Repository reads

remote-repositories accepts repository/sessionId? and returns `{state:'supported'|'no-remotes'|'unsupported',remotes:[{name,identity}]}`. Only supported GitHub HTTPS/SSH origin/upstream identities enter the allowlist; URL credentials and other hosts are rejected.

Other repository endpoints carry repository/sessionId?/host:'github.com'/owner/repo. The Host verifies local remote membership. Reads return `{generation,value}`; lists use `{items,truncated,next?}`: `truncated` reports that upstream still has more beyond the fetched pages, and `next` is an opaque continuation cursor (the upstream `Link rel="next"`, origin-checked against the API allowlist and free of credentials). List endpoints additionally accept `{cursor?,pages?}`: `cursor` resumes from a previous `next` (the provider re-validates its origin and rejects foreign origins), `pages` bounds how many upstream pages one request may read (default 1, clamped to the per-request page cap). Each page holds at most 100 items (notifications 50) and a single request reads at most the page cap, but there is no total-item ceiling — the Client streams pages with the cursor until exhaustion; cache size is capped at 128 entries.

| Endpoint | Additional fields / value |
| --- | --- |
| remote-repository | Viewer, known original permission bits, five tri-state actions; storage writability proves no remote permission |
| remote-list-prs / remote-list-issues | state?:open/closed/all, cursor?, pages?; Issue lists exclude PR entries |
| remote-pr / remote-issue | number; explicit PR head/base repository/ref/SHA, open/closed/merged plus rawState; `createdAt` keeps upstream `created_at` |
| remote-comments | number,inline?, cursor?, pages?; replyTo, commitSha, original line/side, outdated state and `reviewId` (owning review id for nested display); `createdAt` keeps upstream `created_at` |
| remote-commits | number, cursor?, pages?; `{items,truncated,next?}` of `{sha,subject,author,date?,committedAt?,url?}`, `committedAt` from `commit.committer.date` |
| remote-reviews | number, cursor?, pages?; `{items,truncated,next?}` of `{id,author,state,rawState,body,url?,submittedAt?,commitSha?}` with `state` normalized to `approved/changes-requested/commented/dismissed/pending` |
| remote-files | number, cursor?, pages?, expectedBaseSha?, expectedHeadSha?; files:{items,truncated,next?},baseSha,headSha; verify PR snapshot before/after the first page, then pin head/base on each continuation. PR detail no longer calls it proactively: file changes open the GitHub Files page via `pr.url + '/files'`; the capability remains for guarded write paths that need local coordinates |
| remote-notifications | automatic?; review requests and own PR merged/closed/changes-requested events with stable ids; expand at most ten threads, explicitly mark truncation |

Tokens go only to https://api.github.com with X-GitHub-Api-Version:2022-11-28. Pagination Link and GET redirects obey the same allowlist; browser links independently require https://github.com, and avatar URLs (the viewer and every `author.avatarUrl`) further require credential-free `https://avatars.githubusercontent.com` or are omitted. Explicit projections prevent raw response leakage. Authenticated ETag/body caches are isolated by origin/viewer/generation/full path and query, and cleared when identity changes. Anonymous reads are manual only. Authenticated polling waits at least 60s and honors stricter X-Poll-Interval. Rate limits honor Retry-After/reset and bounded exponential backoff. Writes never retry automatically.

### Client loading feedback (Current)

The Remote list, detail view and authentication dialog show a status banner distinguishing remote discovery, GitHub connection, list/discussion reads, authentication connection, waiting for user authorization and action submission. Network waits longer than eight seconds show a slow-response hint; waiting for Device Flow user authorization is not treated as a slow network. The initial list uses skeleton rows without prematurely reporting missing remotes or an empty filter result. Lists and detail collections request only one page initially, then fill the rest through the existing cursor stream with background-loading feedback. Refreshing or changing filters preserves existing rows and their original PR/Issue kind so their details remain accessible; writes retain busy/unknown guards. Failed requests clear loading feedback, show the error and restore the explicit refresh control. All copy is bilingual and animations respect reduced-motion preferences.

The authentication dialog opens with a status card keyed by `auth.state`: connected (with the viewer avatar and `@login`), not connected, disconnected, and credential-invalid headlines; non-connected states carry their hints. When authenticated with a `ref`, `git-credential`, or unrecognized source, a small localized source subline appears (enum `gh` → GitHub CLI (gh), `grant` → GitHub OAuth (device login), `ref` → Credential reference (GH_TOKEN / GITHUB_TOKEN), `git-credential` → Git credential helper; missing/unrecognized sources show “Source not reported” and raw strings are never rendered). A ghost “Disconnect” on the card's right shows only while authenticated or invalid and sends `remote-sign-out` (persisted signed-out suppresses all discovery without revoking server-side tokens). Below it, “Ways to connect” is a radio group offering GitHub CLI (`remote-retry-auth`, with `remote.ghLoginHint` while unauthenticated) and GitHub OAuth (only when `loginAvailable`, starts device login); the checked option derives from capability only, so a failed switch reverts. When a grant or marker record would override the choice (signed-out, invalid, or source `grant`), the client sends `remote-clear-grant` first inside the same busy run — `authAction` executes the endpoint sequence in order and stops at the first failure. All copy is bilingual and never displays tokens, fingerprints or device codes. Authentication actions immediately refresh capability; if an older capability read is in flight, one trailing read prevents the source from remaining stale until the next timer tick. Isolation boundaries and browser regression commands are documented in [Browser E2E](../development/browser-e2e.en.md).

### Client caching and incremental validation (Current)

`GitRemoteFeature` owns controllers per session and view, separating the list from individual PR/Issue details. Unmounting a tab retains its state and in-flight pagination; unloading the feature cancels all work. Caches live only in the current Client memory, never on disk, and are cold after restart. New views evict idle controllers in least-recently-used order once 64 slots are occupied. Mounted controllers, active pagination/retries and unknown write outcomes are protected, so protected entries can temporarily exceed 64. Each controller also retains up to 12 list snapshots keyed by remote identity, pulls/issues and open/closed/all filters. Returning within the same workspace restores the selected filter, loaded pages and details.

Returning to a view or filter reuses data younger than 60 seconds; stale data stays visible during validation. Explicit refresh and detail `navigation.revision` changes bypass the relevant freshness gate. Five-second capability polling alone does not revalidate lists or introduce anonymous automatic network polling. Failures retain content and errors without render-driven retry loops; explicit refresh remains available.

Refresh validates pages from the beginning using the Host's existing ETag / `If-None-Match` support: unchanged pages reuse their bodies on 304, and only changed pages transfer new bodies. This is conditional updating per page, rather than item-level delta synchronization through an upstream change cursor. The Client merges by stable id and retains unchanged row references. Old tail pages remain visible while validation continues; the final page removes records absent from the new result, covering closures, deletions and changes in ordering or page boundaries.

Workspace rebinding, capability off and identity/generation changes clear view/filter caches and cancel old requests. Remote writes, including failures and unknown outcomes, invalidate sibling caches for the same local repository. Tab switches, cache hits and automatic validation never clear an unknown-write gate: explicit targeted refresh is still required, and writes are never replayed automatically.

## Guarded writes

Every repository mutator is enumerated in isRepositoryWrite. In addition to repository identity, payloads require expectedGeneration, expectedViewer:{host,userId}, and requestId. Submission ids contain 8–200 alphanumeric/hyphen characters. A repeated process-local submission returns its original result, including unknown outcomes; retain at most 512 submissions and refuse further admission rather than evicting and replaying effects. Host checks local session directory, remote identity, stable viewer and the same token snapshot at admission and before sending; final resolution compares identity without replacing the checked sending token.

| Endpoint | Additional fields |
| --- | --- |
| remote-comment | number,body; PR-level comment |
| remote-inline-comment | number,body,expectedHeadSha,path,line,side,startLine?,startSide? |
| remote-review | number,body,expectedHeadSha,event:APPROVE/COMMENT/REQUEST_CHANGES |
| remote-create-pr | title,body,head:{host,owner,repo},headRef,baseRef,draft?; verify already pushed branches, no push/fork |
| remote-close-pr | number,expectedHeadSha; two-step Client confirmation |
| remote-merge-pr | number,expectedHeadSha,method?:merge/squash/rebase; two-step confirmation and GitHub sha precondition |
| remote-checkout-pr | number,expectedHeadSha,branch?; optional nonconflicting branch name |
| remote-issue-branch | number; existing create/switch operations create issue-N-slug |

src/remote/diff.ts derives anchors from original hunk headers and validates them on the Host: file/commit/side/hunk plus ordered multiline ranges. Payloads use line/side, start_line/start_side and commit_id, never deprecated position. The current portable UI renders no local diff and has no anchor picker, so `remote-inline-comment` stays unexposed; inline review comments are read-only and nested under their review via `reviewId`.

Checkout fetches a private ref keyed by base repository hash and verifies API head SHA. Tracking updates use expected-old CAS, zero SHA for absence, head-moved for an advanced ref and refusal for divergence. Missing fetch mappings are appended. Branches start at the verified SHA; existing SHA/upstream must match. User branches and other worktrees are never forced. Receipts report switched/privateRefWritten/trackingRefPrepared/fetchMappingAdded/upstreamNotConfigured/branch, actual head when readable, and error. False means completion was not confirmed, not a promise of cross-ref/config rollback. Prepared state is not automatically deleted. Git transport uses existing Git credentials, without OAuth bridging.

Sent-request response loss/timeout/cancellation/5xx yield git/write-result-unknown. Client retains the warning and disables further writes until explicit targeted refresh and inspection. No automatic resend occurs. Successful responses project only id/number/url/merged. Permission/scope/SSO errors and moved heads require repair or renewed confirmation.

## Errors and evidence

Codes: git/remote-unavailable, git/unauthenticated, git/signed-out, git/insufficient-scope, git/head-moved, git/rate-limited with resetAt, git/write-result-unknown, git/remote-identity-mismatch. Without the seam all other known/unknown remote endpoints fail closed before payload parsing.

Automated evidence lives in tests/remote-*.spec.ts and tests/remote-surface.client.spec.tsx. The [plan log](../plans/active/remote-platform-integration.en.md#progress-and-validation-log) records real OAuth/SSO, remote-write, platform-manual and full-release-matrix status. Mocks and the development pin cannot substitute for those checks.
