# Older hosts refuse session logs written by newer harnesses (`job/registered`)

## Symptom

- On DSH `0.2.0-rc.2` (or any host older than `0.2.1-alpha.3`), opening an existing session shows "history load failed" with `failed to observe session "...": session "..." contains event type "job/registered" (seq N) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`, tagged `(gateway/internal)`.
- Sessions created on the same host, and older logs without `job/*` events, are unaffected; plugin features (Changes / Graph / Worktrees / commit message generation) are unaffected.

## Root cause

Starting with `0.2.1-alpha.3`, the upstream session event vocabulary gained `job/registered` and `job/settled` (written by `dsh-commands`, `dsh-subagent`, `dsh-client-file-upload`, etc. when registering background jobs; an agent bash tool call produces a `kind:"bash"` job event). They are written as **required** events: the envelope carries no `ignorable: true`, because job state participates in session reconstruction and silently dropping it would rebuild a wrong session.

On the read path, `dsh-session-persistence`'s `validateStoredEvents` checks every event against `KNOWN_SESSION_EVENT_TYPES`; an unknown type without `ignorable` throws `SessionFormatUnsupportedError`. `dsh-session-query.observeSession` wraps it as `SESSION_QUERY_PERSISTENCE_FAILED` and returns it to the client history stream through the gateway. Neither `0.2.0-rc.2` nor `0.2.1-alpha.1` / `alpha.2` knows `job/*`, so the whole log is refused.

The log format version is not the blocker: both sides use `SESSION_FORMAT_VERSION` 4; the version check passes and the failure happens during event validation.

Unrelated to this plugin: the plugin never calls `observeSession` / `sessionQuery` and never parses session logs; its `ctx.subprocess` git calls emit no `job/*` events; the `working-directory/change` event it can trigger is a known type on both version lines. The error fires inside the client's history stream when a session is opened — host behavior independent of whether this plugin is installed. The plugin's declared `0.2.0-rc.2` support remains valid.

## Fix (verified)

- Open those sessions on a host ≥ `0.2.1-alpha.3` (the version that wrote them); staying on `0.2.0-rc.2` leaves logs containing `job/*` events permanently unreadable — an intentional upstream forward-compatibility guard, not a plugin defect.
- Do not patch logs or intercept this error in the plugin: the read path lives in the host persistence layer, unreachable from the plugin, and treating a required event as `ignorable` would corrupt job-state reconstruction.
- If an upstream fix is wanted, the options are backporting the `job/*` event types onto the `0.2.0` line or having the writer mark them `ignorable` (a semantic-safety call for upstream); both are out of this repository's scope.

## Related

- Evidence: `validateStoredEvents` in `dsh-session-persistence@0.2.0-rc.2`; `KNOWN_SESSION_EVENT_TYPES` diffs across `dsh-session` versions showing `job/*` entering at `0.2.1-alpha.3`; a real `session.v4.jsonl.zstd` whose seq 24 is a `job/registered` (`kind:"bash"`) without `ignorable`.
- Compatibility contract: [`../reference/dsh-compatibility.md`](../reference/dsh-compatibility.md).
