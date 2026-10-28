[中文](ADR-0005-remote-provider-instances.md) | English

# ADR-0005: Remote instances, versioned protocol and orphan-grant retirement

- **Status**: Accepted (GL0 design frozen; GL1 separately authorized)
- **Date**: 2026-10-27

## Context

[ADR-0004](ADR-0004-remote-platform-integration.md) delivered the initial GitHub scope with published RPC/types. Adding GitLab.com and Self-Managed requires instance isolation, replaceable providers, old/new Host/Client compatibility and authorization cleanup after instance removal. The user has passed the [B1 G1–G5 revisions](../plans/active/remote-platform-integration.en.md), validating retirement, uniform generation, rawState, per-instance refs and capability ownership.

This ADR owns lasting choices and rationale; the [instance design](../architecture/remote-platform-instances.en.md) owns detailed fields, algorithms, protocol examples and cases, while the plan owns status/evidence. B2–B4 provide bounded real-store, exact-version documentary and isolated-server admission evidence. The [final plan record](../plans/active/remote-platform-integration.en.md#b2b4-evidence-and-final-freeze-review-2026-10-27) owns results, anomalies and unverified scope, without implying GL5 acceptance.

## Decision

Accept these choices as the GL0 design baseline under the user’s final-freeze instruction. At that time design acceptance alone neither enabled GitLab nor authorized GL1; subsequent authorization and progress are recorded in the plan:

1. **Interface + composition + instance registry.** Orchestration depends on ScopedRemoteProvider; GitHub/GitLab adapters receive auth/HTTP policy through instance descriptors. GitLab.com and self-hosted installations share a platform adapter, with canonical URLs isolating contexts, credentials, caches, requests and lifecycle rather than a subclass per origin. Retain ADR-0004’s seam gate and portable-main/optional-Desktop fiber boundaries.
2. **Explicit v2 negotiation, preserved v1 meanings.** Retain exported types, unscoped GitHub RPC and grant v1. Use v2 only after Host advertisement, verifying remoteProtocol/scope/envelope generation on every successful scoped response. Retained capability generations must match; void=value:null, retirement generation:null, discovery and control-error exceptions follow D3. Never downgrade an unacknowledged v2 request into an unscoped write.
3. **Canonical instance identity and separate grant v2.** Adopt D2 validation-before-URL normalization and reversible base32 host-ids, including built-in exceptions and length limits. D4 provider/instance/App/grant binding preserves legacy meanings. B2 establishes actual 838-key support for two explicit provider/runtime combinations, without inferring other-store compatibility from encoding arithmetic.
4. **Storage-only retirement preserving sign-out suppression.** Add v2 remote-retire-grant for removed instances: normalize input fully before deriving the key rather than requiring an already canonical literal. Uppercase hosts, default ports and trailing slashes may normalize equivalently; unsafe input still rejects. Process only provably bound plugin GitLab-v2 records through modifyRecord, replacing secrets with a retired signed-out marker and invalidating stale refresh intent without unconditional deletion or network contexts. Preserve ordinary clear-grant deletion/discovery restoration. No listRecords dependency or expansion of the seam probe is introduced.
5. **Instance-bound credentials, object-scoped action facts.** Host configuration addresses resolve(ref). Distinguish initial absence, storage failure, invalid/lost adopted sources and network verification failures, without identity fallback. Capability contains known auth-method facts with no network; operation support/method/review sets accompany actions in repository/object facts and are recomputed before writes. Unknown permission never substitutes for implemented support.
6. **Project GitLab locked to scoped-v2 open with rawState.** rawState=locked blocks remote mutations/closed notifications without a phase enum; unknown values remain read-only. This prevents a neutral closed projection from implying terminal state while preserving provider facts. Once Accepted, this ADR replaces only the historical GitLab locked→closed mapping as the scoped-v2 implementation target. Other ADR-0004 decisions, GitHub state rules and its Proposed status remain unchanged; historical review text is preserved.
7. **Separate evidence from admission.** B1 and bounded B2–B4 evidence establish GL0 design freezing, not GL5 real acceptance. Retain D8’s official-default/latest-stable-major target, secondary custom-instance scenarios and explicit operation deferrals. Implementation exits still require C1–C7 and all applicable prerequisites. Do not start GL1 until every P1 closes and the user explicitly authorizes implementation.

## Alternatives Considered

- **Business-layer platform branches or a workflow-heavy base class:** initially straightforward, but pushes platform conditions, instance lifecycles and auth differences into orchestration/inheritance; composition is easier to replace/test per instance.
- **Subclass per origin:** configuration changes are not protocol changes, and duplication expands maintenance; specialize only for genuine protocol differences.
- **Widen existing v1 types/action enums:** risks published consumers and old Clients that allow any non-false string; choose scoped types and explicit negotiation.
- **Remove instances without an old-key cleanup path:** leaves unreachable secrets; allow storage-only retirement for validated old URLs without network context recreation.
- **Read then unconditional deleteRecord, or assume undefined means CAS deletion:** deleteRecord is unconditional and modifyRecord undefined means no change. An atomic signed-out replacement preserves suppression and refresh-CAS protection.
- **Require enumeration for cleanup:** upstream may provide listRecords, but the pinned seam probe does not require it. Known old URLs suffice this round; future enumeration needs a separate seam-extension decision.
- **Keep neutral closed for locked:** risks terminal-state UI/notice inference; choose scoped-v2 open/rawState/mutation guards with an explicit, limited historical replacement relationship.

## Consequences

Benefits: traceable legacy GitHub/Host/Client boundaries, shared adapters with isolated identity, and reachable cleanup without enumeration/network access. Costs: v1 adapters/v2 envelopes, persistent retired markers and distinct authentication versus object-action UI facts; actual store/server acceptance remains necessary.

GL0 design is frozen; the user subsequently authorized GL1 separately. The [RPC reference](../reference/remote-platform-rpc.en.md) records implemented behavior and the plan owns stage evidence. Accepted ADR/Target status does not mean GL2–GL5 or real acceptance is complete. ADR-0004 is not wholly Superseded.

## Related Documents

- [B1 re-review, GL0 status and external evidence](../plans/active/remote-platform-integration.en.md)
- [Detailed instance/protocol design D1–D9](../architecture/remote-platform-instances.en.md)
- [ADR-0004 initial decisions and historical mappings](ADR-0004-remote-platform-integration.md)
- [Current remote RPC contracts](../reference/remote-platform-rpc.en.md)
- [DSH compatibility contract](../reference/dsh-compatibility.md)
