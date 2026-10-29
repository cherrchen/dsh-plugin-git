[中文](remote-platform-instances.md) | English

# Design: GitLab instances and Remote protocol evolution

- **Status**: Target (GL0 design baseline frozen, not an implemented contract)
- **Date**: 2026-10-27
- **Scope**: GitLab.com + Self-Managed; GL1–GL4 have passed automated stage verification. The fields, limits, examples and tests remain the frozen complete target; the [RPC reference](../reference/remote-platform-rpc.en.md) records implemented behavior, and the plan records stage evidence and outstanding acceptance.

## Background

The [active plan](../plans/active/remote-platform-integration.en.md) owns GL-R0–R13 dispositions, freezing and stage progress; this document owns detailed structure, configuration, protocol examples and acceptance cases rather than duplicating status. Retain [ADR-0004](../decisions/ADR-0004-remote-platform-integration.md) gating, credential safety and portability. [ADR-0005](../decisions/ADR-0005-remote-provider-instances.en.md) records the lasting choices as Accepted following B1 re-review and bounded evidence. The plan records GL0 freezing; at that point ADR-0004 was not automatically accepted and implementation was not authorized. Subsequent GL1 authorization is recorded there.

## Historical starting point at GL0 freeze

- [Runtime](../../src/remote/runtime.ts) constructs GitHubProvider directly; repository types, grant keys, HTTP origins and remote parsing include GitHub constraints.
- The [published RPC reference](../reference/remote-platform-rpc.en.md) describes current contracts. [Host dispatch](../../src/index.ts) ignores remote-capability payloads; merely sending scope does not prove an old Host handled it.
- [Public exports](../../src/types.ts) include RemoteProvider/RemoteRepository. The [current Client](../../src/client/remote/RemotePullActions.tsx) disables actions only on false; [generation](../../src/remote/auth.ts) uses random runtime instanceId. Reinterpreting fields, widening exported unions or emitting new action strings requires compatibility review.

## Frozen target (Target)

### D1 Components and lifecycle (GL-R0, GL-R10)

Use interface + composition: orchestration depends on a new internal ScopedRemoteProvider; the assembly factory injects GitHub/GitLab adapters, AuthDescriptor, HttpPolicy and independent InstanceContext. Preserve exported RemoteProvider/RemoteRepository as GitHub-v1 views through projection adapters; add ScopedRemote* types instead of widening old types into unions that require existing callers to handle GitLab.

Each context owns auth, runtime generation, viewer/permission/ETag data, pending work, login attempts, notice and submission deduplication. The registry keys by canonical instance URL, with at most 16 explicit GitLab configurations; duplicate canonical URLs are rejected. Validate an entire configuration change first, then rebuild only changed/removed contexts: stop admission, cancel/drain, invalidate cursors and write confirmations, and mint a new random generation.instanceId. Account changes increment revision under the ADR; identical userIds across instances remain isolated.

Under the registry lock, publish configuration, remove old owners and synchronously initiate cancellation without joining their requests. Old business requests may reenter list/guard and finish within a bounded interval. A replacement for the same instance waits for the old owner to drain outside the lock, then reacquires the lock and rechecks configuration before creation. Disposal closes admission and joins all active and already removed owners outside the lock; its drain promise must never become part of the admission chain. When the Client changes target or invalidates identity, it immediately clears the login code/link and cancels against the original instance scope on a separate cleanup lane. Epoch checks discard old poll replies, and cleanup cannot invalidate fresh reads or login even when switching within one instance.

The credentials seam remains a whole-feature hard gate. An instance’s configuration/auth/network failure cannot disable other instances or local UI. Portable UI stays in the main fiber; removable Desktop children enhance notifications, authorization browser opening and user-code copying.

### D2 Configuration and instance identity (GL-R2, GL-R9, GL-R13)

Target configuration:

```json
{
  "remote": {
    "clientId": "existing-github-app",
    "instances": [
      {"url": "https://gitlab.com", "clientId": "gitlab-com-app"},
      {"url": "https://git.example.com", "clientId": "self-managed-default-app"},
      {"url": "https://git.example.com:8443/gitlab", "sshHost": "git.internal.example", "sshPort": 2222, "clientId": "self-managed-app", "credentialRef": "DSH_GITLAB_OFFICE"}
    ]
  }
}
```

Release-default app IDs, explicit overrides and empty-value disabling follow the [RPC configuration reference](../reference/remote-platform-rpc.en.md#configuration-and-authentication); self-managed instances never inherit the GitLab.com app. remote.clientId still means GitHub only; instances[] registers GitLab without inheriting that clientId. GitLab.com remote recognition and an anonymous default descriptor are built in; a single matching configuration supplies overrides such as the App, rather than creating a second context. Unregistered self-hosted remotes never trigger network discovery. Drop editable id; optional label is display-only, while url defines security identity. clientId/credentialRef are optional; credentialRef is an existing-grammar ref name, never a token/secret in settings. sshHost defaults to URL hostname, sshPort to 22; explicit overrides affect SSH mapping, not API identity. Ambiguous SSH endpoint/repository ownership is rejected.

Normalization validates raw input before constructing URL so dot segments cannot be swallowed first. HTTPS only; reject userinfo, query, fragment, backslashes, repeated path separators, literal/encoded dot segments, encoded slashes and nested encodings. Lowercase domains through URL/IDNA; serialize IPs with standard URL rules including IPv6 brackets. Omit 443, retain other ports. Preserve prefix case with ASCII URL-unreserved segments; prefixes requiring percent encoding are deferred, independently of project-namespace encoding. Remove root/trailing slashes. Canonical URL UTF-8 length is at most 512 bytes; reject excess rather than truncate.

Credential host-id is `gl-` plus unpadded lowercase RFC 4648 base32 of canonical-URL UTF-8, except fixed gitlab-com for GitLab.com and unchanged github-com for GitHub. Maximum host-id is 823 characters and full dsh-plugin-git/ record key 838. Actual bounded backing-store evidence and limitations are maintained in [plan B2](../plans/active/remote-platform-integration.en.md#b2b4-evidence-and-final-freeze-review-2026-10-27); encoding arithmetic does not establish storage compatibility.

| Input / canonical instance | Expected design fixture |
| --- | --- |
| `https://GIT.EXAMPLE.COM:443/` | `https://git.example.com`; host-id `gl-nb2hi4dthixs6z3joqxgk6dbnvygyzjomnxw2` |
| `https://git.example.com:8443/gitlab/` | No trailing slash; host-id `gl-nb2hi4dthixs6z3joqxgk6dbnvygyzjomnxw2orygq2dgl3hnf2gyylc` |
| Same host with `:8443/GitLab` | Separate from lowercase gitlab, with no shared grants |
| `http://host`, `%2f`/`%252f`, userinfo or `a/../b` | Reject without network requests |


#### G1 Removed-instance grant retirement (B1 re-review passed, GL0 frozen)

Add v2-only `remote-retire-grant`, separate from normal remote-clear-grant deletion/discovery-restoration semantics. Payload is `{remoteProtocol:2,provider:'gitlab',instance}`. Validate raw input and then normalize it under D2 before deriving the key; an already canonical literal is not required. For example, https://GIT.EXAMPLE.COM/ addresses the same key as https://git.example.com, and the reply echoes canonical scope. The Client applies the same normalization when comparing scope instead of comparing the raw input literal. Unsafe inputs still reject. **This operation alone** may address an unregistered/removed instance. Derive the key inside the fixed plugin namespace; never accept arbitrary keys/refs/clientIds or establish network trust from the URL. Other auth/clear/repository operations for unregistered scopes still reject under D3.

With the full seam available, process that key only through modifyRecord: absent records remain unwritten and return absent. A valid GitLab-v2 grant whose provider/instance matches the derived key becomes `{v:2,state:'signed-out',provider:'gitlab',instance,revision,retired:true}` with a fresh revision, removing all access/refresh tokens, login/refresh intents and old App fields. An existing valid retired marker returns already-retired. Reject unknown/malformed/GitHub-v1/mismatched records without overwriting, using redacted record-mismatch. Decide against the current locked record so old refresh-completion CAS cannot match the replaced revision. In the pinned seam, returning undefined from modifyRecord means no change, **not deletion**; assume neither conditional deleteRecord nor a new persistent tombstone index.

Do not create a context/generation, run event probes/subprocesses/HTTP, mutate instance configuration, touch other instances/external refs or revoke server tokens. Return `{remoteProtocol:2,scope,generation:null,value:{disposition:'retired'|'already-retired'|'absent'}}` under D3. A confirmed cleanup UI for the old URL explains “clear old instance authorization, retaining a signed-out marker,” showing scope and redacted results without re-registration/network access. The same URL works after restart, without credential enumeration or persistent external URL history. Retain the marker to prevent silent discovery after re-registration; normal clear/login after registering restores use, and signed-out parsing recognizes the App-free marker.

If the URL has been registered again, return instance-registered and use normal active-instance auth operations. Serialize registry changes and this membership-check/storage operation within the Host. Explicit new authorization in another Host still follows existing CAS/state-machine rules; cleanup cannot prevent future explicit sign-in. Storage failures are repairable errors, never proof of cleanup. Null-generation receipts belong only to cleanup UI and cannot confirm repository writes; process them by scope/request sequence without clearing another active instance.

Enumeration is not required: listRecords is outside the pinned seam probe. Future orphan-record listing would require a separate capability/compatibility decision.

### D3 Negotiation and compatibility (GL-R0, GL-R3, GL-R10, GL-R12)

Use an explicitly scoped remoteProtocol=2 channel with existing endpoint names. The new Client first sends legacy remote-capability {}. A new Host adds remoteProtocol:2 to its original GitHub reply without changing existing fields. Only after that advertisement may the Client issue scoped requests, and every scoped response must acknowledge protocol and matching scope. Missing/mismatched acknowledgements or unsupported Hosts fail closed for GitLab, never falling back to unscoped GitHub writes.

```json
{"endpoint":"remote-capability","payload":{}}
{"state":"on","generation":{"instanceId":"opaque-runtime-id","revision":0},"credential":{"configured":false,"writable":true},"auth":{"state":"unauthenticated"},"actions":{"canComment":"unknown","canReview":"unknown","canMerge":"unknown","canClose":"unknown","canCreatePr":"unknown"},"loginAvailable":true,"automaticRefreshAvailable":false,"remoteProtocol":2}
```

Scoped payload and two reply forms follow; value contains endpoint-specific data, and the Host validates and returns scope:

```json
{"remoteProtocol":2,"provider":"gitlab","instance":"https://git.example.com:8443/gitlab"}
{"remoteProtocol":2,"scope":{"provider":"gitlab","instance":"https://git.example.com:8443/gitlab"},"generation":{"instanceId":"other-runtime-id","revision":0},"value":{"state":"on","generation":{"instanceId":"other-runtime-id","revision":0},"credential":{"configured":false,"writable":true},"auth":{"state":"unauthenticated"},"authMethods":{"deviceFlow":{"supported":"unknown","reason":"not-verified"}},"actions":{"canComment":false,"canReview":false,"canMerge":false,"canClose":false,"canCreatePr":false},"loginAvailable":true,"automaticRefreshAvailable":false}}
{"remoteProtocol":2,"scope":{"provider":"gitlab","instance":"https://git.example.com:8443/gitlab"},"generation":{"instanceId":"other-runtime-id","revision":1},"value":{"items":[],"truncated":false}}
```

Capability calls without the marker retain today’s ignored-payload behavior; new Clients infer no instance support from them. Except the narrowly defined D2 G1 retirement operation, invalid/mismatched providers, unknown/removed instances or missing fields under remoteProtocol=2 return existing git/remote-unavailable with a redacted reason, not seam off. Missing seams retain the legacy off shape and create no contexts; Clients handle that global off first. A present remoteProtocol other than 2 is rejected rather than treated as v1. All v2 auth endpoints, including poll/cancel, capability, reads and writes carry scope; attemptIds belong to their scope. All successful scoped replies—capability, auth including void operations, reads and writes—use `{remoteProtocol,scope,generation,value}`. Live-context generation is captured for the operation’s snapshot (auth mutations return the resulting generation), never replaced with a newer unrelated snapshot at response time. Client staleness checks always read the envelope generation; retained capability value.generation must equal it, otherwise reject. Void operations return value:null. D2 G1 retirement alone uses generation:null without creating a context, and cannot provide write confirmation. Discovery remains the explicitly unscoped response below. Seam off and existing RPC error shapes are control failures rather than scoped data: process them under the originating request scope/sequence and never adopt a generation from error details.

| Combination | Expected behavior |
| --- | --- |
| Old Client / new Host | Unscoped GitHub repositories/replies/errors/three-state actions only, with no GitLab data |
| New Client / old Host | Legacy GitHub channel; absent v2 advertisement explains unavailable GitLab and prevents GitLab auth/mutators |
| New Client / new Host | Discover/select instances after negotiation; verify scope+generation and discard cross-instance stale replies |
| Missing seam / any Client | Legacy off; all remote providers disabled, local Git remains available |

v2 remote-repositories also carries remoteProtocol:2 and existing repository/sessionId; its discovery response is `{remoteProtocol:2,value:{state,remotes,unresolved?}}`, spanning instances without pretending to have a single scope. Keep supported/no-remotes/unsupported; each remotes.identity has explicit scope. unresolved includes only origin/upstream names and registration-recovery reasons, never credential-bearing URLs or guessed host branding. Mixed-provider remotes may be selected independently, without aggregation or cross-provider creation/checkout objects.

### D4 Repository, viewer and credential models (GL-R2, GL-R3, GL-R11)

v2 GitLab targets are `{provider:'gitlab',instance,path,projectId?}`, preserving complete namespace paths. Build the allowed set from local origin/upstream and registered mappings before resolving projectId through the API. Use instance+numeric id afterward, but every write revalidates that current local remote/path resolves to that id; arbitrary Client projectId is not authority. Renames/transfers require revalidated configured remote and API identity rather than automatically broadening access through a stable id.

Do not reinterpret GitHub-v1 host/owner/repo, viewer.host, expectedViewer.host or grant v1. v2 adds expectedInstance equal to canonical URL, with expectedViewer still `{host:URL.hostname,userId}`; scope/expectedInstance distinguish ports/prefixes. generation.instanceId remains a random opaque runtime id. Missing or mismatched expectedInstance rejects writes.

```json
{"remoteProtocol":2,"provider":"gitlab","instance":"https://git.example.com:8443/gitlab","repository":"<session-repository>","path":"group/sub/project","projectId":"42","number":7,"body":"Review feedback","expectedInstance":"https://git.example.com:8443/gitlab","expectedViewer":{"host":"git.example.com","userId":"9"},"expectedGeneration":{"instanceId":"opaque-runtime-id","revision":3},"requestId":"example-request-0001"}
```

One account per instance this round. GitLab introduces grant-v2 payloads with ADR states/revisions/attempt/refresh markers, bound to provider/instance/clientId; never move or overwrite GitHub-v1 records. Authorizing/authenticated OAuth states require the matching clientId; signed-out suppression may omit clientId when no App is configured, remaining bound to provider/instance. Tokens discovered from refs stay external rather than being written as fabricated OAuth grants. Unknown/malformed/mismatched instance/App records become invalid without discovery fallback. URL edits remove the old context and create another; old grants stay at their keys without token migration; the D2 G1 retirement operation makes their secrets reachable for explicit cleanup even after scope removal.

Persisted method selection is separate from OAuth grants; explicit CLI/OAuth switching preserves authorization. The [RPC reference](../reference/remote-platform-rpc.en.md#configuration-and-authentication) owns the new endpoints, OAuth-only logout, older-Host compatibility and secret boundaries.

Candidate discovery: authenticated grant → configured per-instance credentialRef → GitLab.com-only GITLAB_TOKEN/GL_TOKEN refs → GitLab.com noninteractive glab probe → anonymous. Self-hosted instances consume neither generic refs nor CLI; self-hosted git credential fill is disabled this round to prevent helpers sharing tokens across deployment prefixes. CLI runs only once per identity-establishment event, ≤5s; bounded single-line whitespace/control-free output still needs GET /user validation, without assuming token prefixes. Missing commands/help output never establishes identity; 401 after identity acceptance cannot switch accounts. Source alone establishes neither token type nor expiry.

The CLI probe uses `glab config get token --host gitlab.com`, letting glab resolve per-host configuration and the OS keyring. It does not invoke the nonexistent `glab auth token` command or parse human-readable status output containing secrets. Candidates stay in Host memory for API verification and never pass through RPC, logs, or errors.

Cache glab probe results, including absent credentials and non-cancellation probe failures, only within their instance owner. Sequential/concurrent business snapshots in one identity-establishment cycle reuse the candidate and verified identity without launching the CLI again. Credential record/reference invalidation or explicit retry starts a new probe cycle; sign-out, grant clearing and instance disposal clear the cache. Late probe/identity verification results after cancellation or invalidation cannot be committed. A 401 retains the selected source and invalid-token fingerprint; ordinary snapshots cannot reprobe and switch CLI accounts, requiring explicit repair before rediscovery. This cache preserves per-operation grant reads/expiry refresh, ref resolution, signed-out suppression and generation guards.

**credentialRef resolution (G4)**: The Host calls existing ctx.credentials.resolve(ref) using the selected instance descriptor, never an RPC-supplied arbitrary ref. During first identity establishment before any credential has been adopted, no configured ref or a no-value/empty result means source absence: continue to the next source for this instance without a login error. Storage exceptions, malformed resolved tokens, GET /user 401s or disappearance of a previously adopted ref must not masquerade as absence and switch identities. Storage faults return repairable read errors. Malformed tokens, GET /user 401s or loss of an adopted source become invalid requiring explicit repair; transport/rate-limit/5xx failures remain retryable verification errors without source fallback or a claim that the token itself is invalid. Validate every new nonanonymous token, including explicit refs, with GET /user at its bound instance before establishing viewer; this is identity initialization, never capability probing.

Each explicit credentialRef belongs to one canonical instance in configuration; reject cross-instance reuse. Reserve GH_TOKEN/GITHUB_TOKEN for GitHub and automatic GITLAB_TOKEN/GL_TOKEN for GitLab.com; reject explicit use by any other instance. Deduplicate explicit and automatic use of the same ref within its own context. resolve returns value/source, not token type or host binding; explicit configuration supplies instance ownership, and the Host never sends that value to another instance. Equal values from different refs do not merge contexts or validation results. Retain per-operation resolution, signed-out suppression and credential-event invalidation.

Device Flow uses per-instance clientId and api scope; actual expires_in controls expiry. A refresh token plus positive store exclusion enables two-phase refresh. Without one, automaticRefreshAvailable=false and expiry requires reauthentication. Reject missing expires_in in exchange/refresh replies before persisting tokens rather than assuming immortality or two hours. If refresh succeeds without a replacement refresh token, never reuse the potentially consumed old refresh token; disable subsequent automatic refresh and reauthenticate at known new expiry. Actual issuance remains untested; both branches require implementation tests.

### D5 HTTP, URLs and budgets (GL-R4, GL-R9)

| Purpose | Admission and authentication |
| --- | --- |
| REST | Exact instance origin and `<prefix>/api/v4/` segment boundary; Bearer only there, revalidate every GET redirect/Link; never automatically follow write redirects or retry writes |
| Device initiation | POST `<prefix>/oauth/authorize_device`, App/scope only without API bearer |
| Token exchange/refresh | POST `<prefix>/oauth/token`, protocol body only, never forwarded to other pages/redirects |
| Verification web page | Exact HTTPS `<prefix>/oauth/device`; plain URI has no query, complete URI permits one user_code matching the attempt; no bearer |
| Browser/avatar | Web paths belong to the selected instance, excluding another registered prefix on the same origin; avatars use safe instance paths or secure.gravatar.com, without bearer, with no-referrer and initial-letter fallback |

Links/cursors cannot replace instance, project, query or comparison snapshot. Client treats them as opaque handles; Host binds context/generation/query and validates rather than trusting external_url. Retain bounded upstream pages per call with no total list ceiling. Authenticated caches include scope/viewer/generation/project id/path/full query. Send conditional requests only with ETags, never budgeting around free 304s. Anonymous refresh stays manual; authenticated polling is ≥60s with longer Retry-After/reset honored, and explicit rate limits/429 cause backoff.

HTTPS uses Host trust only, without changing global dispatchers/trust, disabling TLS or adding network dependencies. Record proxy behavior by Host Node version/startup configuration; no plugin proxy settings this round. Explicit private-network targets may match, without scanning other services.

### D6 Action support, semantics and receipts (GL-R3–R8, GL-R12)

v1 true/false/unknown actions stay unchanged. v2 repository/object facts add operationSupport with `{supported:boolean,reason?}` per action, plus supportedMergeMethods/supportedReviewEvents. Unsupported v2 actions are also false, with Host rejection. New Clients never infer support from unknown permission or storage writable.

The **authoritative location for operationSupport, supportedMergeMethods and supportedReviewEvents is v2 remote-repository facts (inside value, alongside actions)**, not instance capability as a claim about all projects. operationSupport has fixed keys comment/inline-comment/review/close-pr/merge-pr/create-pr, each `{supported:boolean,reason?}`. Merge methods are a subset of merge/squash; review events a subset of COMMENT/APPROVE/REQUEST_CHANGES. Unsupported actions are false; unconfirmed support is provisionally supported:false with capability-pending. Even supported:true requires an independent permission decision. Project tiers/policies narrow platform support rather than inheriting every instance feature.

v2 remote-repository may accept `object:{kind:'pull'|'issue',number}`; facts add `actionScope:{path,projectId,object?}`, used by the Client only for a matching object. Without object, return repository facts and keep authorship/target-branch/MR-dependent permissions unknown; these facts cannot confirm an object-specific write. Obtain matching object facts before confirmation; if support is established but permission remains unknown, retain the ADR’s optimistic attempt/server-judgment behavior. Write endpoints recompute facts for the actual command object and guard independently of cached Client support/method/event sets. Additional approval reauthentication may narrow review events without disabling a usable ordinary comment.

The v2 instance-capability value requires authMethods.deviceFlow.supported as true/false/unknown plus an optional redacted reason, from provider descriptors and existing initialization results. v2 loginAvailable means a valid clientId, credential.writable and deviceFlow.supported not false. Unknown permits an explicit user attempt/verification without guaranteeing server success; UI labels it unconfirmed. Known unsupported, missing-App or read-only-store OAuth methods stay visible but disabled with reasons; CLI authentication does not hide the OAuth option. Computing this never sends network traffic; explicit login failures update known facts. Retained capability actions are legacy-shape defaults only (false for known global lack of support, otherwise unknown), without repository authorization, merge methods or review-event sets; Clients wait for matching facts before enabling repository writes.

```json
{"remoteProtocol":2,"scope":{"provider":"gitlab","instance":"https://git.example.com"},"generation":{"instanceId":"runtime-a","revision":2},"value":{"actionScope":{"path":"group/project","projectId":"42","object":{"kind":"pull","number":7}},"viewer":{"host":"git.example.com","userId":"9","login":"reviewer"},"permissions":{},"actions":{"canComment":"unknown","canReview":"unknown","canMerge":"unknown","canClose":"unknown","canCreatePr":"unknown"},"operationSupport":{"comment":{"supported":true},"inline-comment":{"supported":false,"reason":"not-implemented"},"review":{"supported":true},"close-pr":{"supported":true},"merge-pr":{"supported":true},"create-pr":{"supported":true}},"supportedMergeMethods":["merge"],"supportedReviewEvents":["COMMENT","APPROVE"]}}
```

| Action/data | Target behavior this round |
| --- | --- |
| MR/Issue reads, commits, discussions | Neutral fields + rawState, Issue comments read-only; facts derive only from successful actual responses |
| Approve/comment | COMMENT is a note; APPROVE carries head SHA. Approval with body performs comment→approve and reports each step; no approval_password collection, with extra-reauth approval explicitly restricted |
| Request-changes writes/unapprove | Deferred with explicit unsupported UI; verified requested_changes reads remain available |
| Merge | Direct merge only, methods confirmed against project policy (merge means the server-configured project strategy, not a promise to create a merge commit; squash only when permitted). Always send sha; draft/locked/known blockers disable it. Rebase/auto-merge/merge-train orchestration is deferred |
| Close/create/comment | No atomic SHA precondition; single-snapshot prechecks are best-effort, non-idempotent writes are not retried. Create from a pushed branch in an allowed source project toward an allowed target, without fork creation/push |
| GitLab locked/unknown state | v2 locked→open + rawState:locked, with no remote writes/closed notices. Remove phase entirely; rawState belongs to ScopedRemotePull and is the authoritative raw-state carrier, while state is its neutral projection. Treat rawState=locked as an explicit UI/action guard, not a second enum. Accepted ADR-0005 establishes this limited replacement as the implementation target, preserving the historical record. Unknown states use v2 unknown/rawState and read-only behavior |
| Permission | Keep roles/authorship/branch policy/mergeability/scopes distinct. Missing reliable viewer facts mean unknown, known denial false; the server remains authoritative |

v2 write-response value is `{outcome:'succeeded'|'partial'|'unknown',steps:[{kind,state,id?,reason?}],receipt?}`; step states are succeeded/failed/unknown/not-sent. Sent-unknown still uses existing git/write-result-unknown plus redacted flat details and targeted reconciliation. Known partial success returns outcome=partial rather than success. Failed approval never resends an already successful comment; reconfirm only known failed/unsent actions. Receipts contain no raw HTTP bodies.

The Client retains pending GitLab reconciliation per session across sidebar unmount/remount. One unified controller keeps state per session+view (the list and each detail tab use separate RPC lanes); returning to a blocked detail keeps repeat writes locked until the affected object is refreshed and the user acknowledges the inspected result. Successful approve, close and merge actions follow the same flow. The Client has no manual provider switch: the provider is derived from the remote URL identity discovered by remote-repositories v2, and GitHub/GitLab share the same list/detail/tab UI. Remotes that match nothing are reported per-remote as unregistered/ambiguous, and a repository matching no supported provider is reported unsupported instead of defaulting to GitHub. GitLab detail addresses use the five-segment `dsh-resource://git-remote/gitlab/<instance>/<path>/<kind>/<number>` grammar while GitHub keeps the original four-segment form, so tab identities never collide.

Deduplication keys include session/root, scope, project, generation, viewer and requestId. Retain an in-process payload fingerprint without logging; reject same-id/different-content submissions. No cross-restart/server idempotency is promised; restart leaves uncertain outcomes requiring reconciliation.

### D7 Discussions, Markdown, notifications and Git (GL-R5, GL-R7, GL-R8)

- v2 adds discussionId/threadId, resolved/resolvable and raw diff positions. Legacy reviewId retains review ownership. Preserve old/new lines/paths, base/start/head and line_range; never derive side merely from old_line presence. Unproved anchors show text/external links only. Approval snapshots are separate current facts, not fabricated history; system notes may display raw text but unstructured natural language cannot create synthetic approval events.
- Select a verified shared safe Markdown subset with provider-specific input projection and a common renderer. Preserve unfamiliar GitLab markup readably without applying GitHub-specific HTML transforms. No arbitrary HTML execution; validate links/images/folds. HTML/entities/hostile-URL and GitLab-markup fixtures are GL4 evidence.
- Include verified review_requested todos and post-push create-MR suggestions. Own-MR state changes are snapshot differences only for the current viewer’s already loaded/explicitly tracked set, not complete account-wide events; disable unsupported changes-requested observations with explanation. Deduplicate by scope/project/id/state/time; do not mark todos done or invoke other mutation endpoints.
- Parse HTTPS and SSH independently. scp syntax matches only registered port 22; non-default ports require an explicit ssh:// URL. Aliases use explicit sshHost mappings without reading or reverse-resolving ssh_config. HTTPS relative prefixes and SSH repository paths are separate. Fork branches use mr-N with manual naming on conflict; same-project branches track source branches. Fetch only local origin/upstream through target MR ref→private ref→SHA verification→tracking CAS→switch/upstream, retaining partial receipts. Source-project fallback after missing head refs is deferred; ordinary failures never prove cleanup.

### D8 Server and operation matrix (preparation, not a support promise)

**User clarification (2026-10-27)**: Start from standard official deployment defaults and the latest stable major; users configure instance details. The checked [official release policy](https://docs.gitlab.com/policy/maintenance/) and [19.5 release](https://docs.gitlab.com/releases/19/gitlab-19-5-released/) identify major **19** at this checkpoint. Use [19.5.1](https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-5-1-released/) as the concrete preparation snapshot, rechecking the current patch before actual acceptance and recording an exact version/image digest rather than a moving latest tag. This is a validation target, not a claim of completed support for all 19.x.

The primary scenario is a standard single-node CE or unlicensed EE instance with no deployment prefix, default SSH port 22 and an administrator-configured valid HTTPS external_url. The plugin does not configure or install the server; official HTTP examples do not expand the plugin’s HTTPS boundary. Users can override URLs, SSH endpoints, ports, prefixes, Apps and credential refs under D2; those remain included secondary scenarios. Premium-only policies are restriction cases, not default expectations.

17.x/18.x backward compatibility is deferred this round, without hard-coding arbitrary version assertions into every provider operation. The historical [Device Flow GA baseline](https://docs.gitlab.com/api/oauth2/#device-authorization-grant-flow) is evidence only, not a minimum-version promise. Mark unvalidated major versions as unverified in explicit initialization and disable writes until their endpoint/capability evidence is established. Metadata absence does not disable known safe public reads or the global UI. Missing App/flow/fields and permission negatives remain necessary fixtures even on major 19. GitLab.com is separately verified against its actual schema and policies.

| Capability | GitHub v1 | GitLab.com/self-hosted target | Negative/restricted behavior |
| --- | --- | --- | --- |
| Device Flow | Preserve current behavior | Registered App + supported flow | Keep disabled with a reason without an App; absent flow never silently starts PKCE |
| API reads/pages | Existing contracts | MR/Issue/commits/discussions/current approvals | Classify denied/missing fields/unsafe continuations, never invent empty data |
| Comment/approve/create/close | Existing contracts | Per-action support and permission guards | Explain scope/policy denial or additional approval authentication |
| Merge/checkout | Existing SHA/CAS | Direct merge and target MR refs | No blind retry for locked/draft/head moves/missing refs |
| Reviews/notices | Existing model | Structured facts + bounded D7 coverage | Never fabricate missing history/events |
| Inline/Issue writes/resolve | Existing UI boundary | Unsupported this round | inline-comment=false with an operationSupport reason; Issue writes/resolve have no endpoint/UI entry this round and the Host rejects them |

### D9 Acceptance specifications and freeze gaps

These are future GL1–GL5 implementation acceptance specifications. GL0 isolated real-store/server evidence and the freeze decision live in [plan B2–B4](../plans/active/remote-platform-integration.en.md#b2b4-evidence-and-final-freeze-review-2026-10-27), without claiming completed C1–C7 or verified user instances.

| Group | Required assertions/evidence |
| --- | --- |
| C1 Protocol/legacy types | Old/new Host/Client combinations and missing seams; null/legacy payloads, absent v2 advertisement/acknowledgement, mismatched envelope/capability generations, null-generation retirement never confirming writes, scope mismatch preventing writes; unchanged legacy ./types consumers and artifact loading |
| C2 Instances/records | URL rules, 512-byte limit/base32 round-trip/maximum keys; different ports/prefixes/case; grant-v1/v2 isolation, URL edits/unload drain, duplicate configuration/SSH ambiguity and cross-instance ref-name reuse; removed-scope cleanup across restart without context/network, mismatch protection, retirement vs refresh/configuration races, absent/retired idempotency and storage failures |
| C3 Auth | Present/absent refresh tokens, missing expiry, no store exclusion, CAS/crash/response loss, successful-exit help text, initial absent refs vs storage faults/lost adopted refs/invalid resolved tokens, per-instance GET /user validation, reserved/cross-host refs, identical userIds, cross-scope poll/cancel; no tokens on RPC/log/argv |
| C4 HTTP/pagination | Hostile redirects/Links/encoded paths, prefixes, replaced project/query/snapshot cursors, rate limits, manual anonymous refresh, absent ETags, certificate/proxy failures |
| C5 Writes/permissions | Wrong viewer/instance/projectId, workspace changes/stale confirmation, insufficient role evidence, repository/object-scoped support and method sets, instance flow support vs loginAvailable, locked/unknown raw-state guards without phase, Host rejection of unsupported operations, duplicate requestId with different body, successful comment plus failed/unknown approval, merge SHA races |
| C6 Git/Client | Temporary repos: dirty/CAS/worktree/single-branch/same-iid isolation/partial receipts; HTTPS/SSH/prefix fixtures, stale responses, unload retaining local UI, Markdown/images/timeline/notice deduplication |
| C7 Servers/platforms | GitLab.com, dedicated/private hosts, non-default ports, prefixes, same-id dual instances; standard-deployment 19.5.1 preparation snapshot (recheck before running), CE/EE and secondary custom configurations, missing-flow/permission negatives; Windows/Linux/Web/Desktop, recording version/App/tier/TLS/commands/results |

| Freeze evidence | Required output | Current status |
| --- | --- | --- |
| B1 Contract review | Explicit review of D1–D7 requests/replies, v1 compatibility, locked mapping and included/deferred scope; subsequent ADR | G1–G5 passed; ADR-0005 Accepted and GL0 design frozen |
| B2 Key/runtime bounds | Actual backing-store limits/evidence for 838-character keys and Node/TLS/proxy prerequisites | Evidence obtained for two published real providers; exact runtime scope/limits are in the plan |
| B3 Server evidence | Endpoint/field/permission/tier table for the latest stable major, exact patch/digest at execution, custom scenarios and relative-URL SSH paths | Pinned 19.5.1 documents/hashes and endpoint table obtained; actual deployment results/final scope are in the plan |
| B4 Real environment | User-provided/separately authorized isolated instance, reachable network, trusted TLS, App/refs/version/permission scenarios | Isolated EE19.5.1 baseline/prefix/SSH evidence obtained; scope/anomalies in the plan, not GL5 completion |

## Impact

GL1 now affects Host assembly, auth/HTTP descriptors, ScopedRemote* types and Git remotes, with an ongoing v1-adapter maintenance cost; GL2–GL4 remain target work. Keep registry semver dependencies without workspace/Electron/runtime credentials imports. The [canonical DSH contract](../reference/dsh-compatibility.md) still defines lanes. See the [RPC reference](../reference/remote-platform-rpc.en.md) for current behavior; mocks and isolated fixtures are not user-account or real-project acceptance.

## Related documents

- [GL0 review, freeze checklist and stage progress](../plans/active/remote-platform-integration.en.md)
- [ADR-0004, unchanged existing design authority](../decisions/ADR-0004-remote-platform-integration.md)
- [Current RPC contracts](../reference/remote-platform-rpc.en.md)
- [Current architecture](overview.en.md)
- Official endpoint sources: [REST](https://docs.gitlab.com/api/rest/), [MR](https://docs.gitlab.com/api/merge_requests/), [Approvals](https://docs.gitlab.com/api/merge_request_approvals/), [Discussions](https://docs.gitlab.com/api/discussions/), [Todos](https://docs.gitlab.com/api/todos/), [Metadata](https://docs.gitlab.com/api/metadata/), [relative-URL deployment](https://docs.gitlab.com/omnibus/settings/configuration/#configure-a-relative-url-for-gitlab). These do not establish real-environment or historical exact-version acceptance.

Verified GitLab viewers and authors both project validated `avatar_url` values. HTTPS images are limited to the same instance and secure.gravatar.com. Avatar queries allow only unique s sizes, built-in d fallback styles, and r ratings; external fallback URLs and arbitrary query parameters are rejected. Failed Client images fall back to initials, and a new avatar URL can load again.
