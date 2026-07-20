# Protocol

The Hybrid Cognitive Sync Protocol is the wire contract of the platform: the shape of the cognitive state document, the sync envelopes that move it, and the rules that keep independent replicas convergent. It lives in `packages/sync-protocol` (TypeScript) with a semantically identical Python twin in the cloud engine (`contract_models.py`, `crdt_merge.py`).

## The state document

`CognitiveState` is the unit of sync: one JSON document per subject, replicated across every device and the cloud master.

| Field group | Contents | Merge discipline |
|---|---|---|
| Identity | `subjectId`, `docVersion`, `replica` (device id, HLC) | Version-gated; mismatched subjects refuse to merge |
| Mastery | Per-concept evidence counters (successes, failures, assists) | G-Counters: sum by replica, never decrement |
| Session registers | Active concept, guidance mode, directive | Last-writer-wins by HLC, cloud-preferred on ties |
| Memory log | Append-only ids of durable memories | G-Set union |
| Profile | `track`, language, preferences | Last-writer-wins by HLC |

## Envelopes

| Envelope | Direction | Purpose |
|---|---|---|
| `SyncRequest` | device -> cloud | Replica's current document plus `syncAttemptId` for idempotency |
| `SyncResponse` | cloud -> device | Converged master document plus advisories (what changed, what was refused) |
| `AgentTurnRequest` / `AgentTurnResponse` | device -> cloud | A cloud-hosted turn: friction sample in, guidance directive out |

HTTP bindings: `POST /v1/sync`, `POST /v1/agent/turn`, `GET /v1/subjects/{id}/state`.

Implementor path (scaffold → first turn → sync outside the monorepo): [`../sdk/implementor-quickstart.md`](../sdk/implementor-quickstart.md).  
Conformance stub + binding certification: [`../sdk/conformance-stub-guide.md`](../sdk/conformance-stub-guide.md), [`../sdk/binding-certification-guide.md`](../sdk/binding-certification-guide.md).  
Independence kit (fixtures tarball + obligation checklist, no monorepo): [`CERTIFICATION-CHECKLIST.md`](./CERTIFICATION-CHECKLIST.md).

## Turn trajectory privacy

`TurnTrajectoryV1` captures bounded stage, tool-call, outcome, model, hash, and
length metadata. It never accepts raw keystrokes, prompts, utterances, replies,
or tool argument/result bodies. Storage remains subject-scoped inside the
declared locality, and export requires an active, subject-matched opt-in consent
record. The field policy and worked valid/rejected JSON are in
[`packages/telemetry/docs/TRAJECTORY-METADATA-POLICY.md`](../../packages/telemetry/docs/TRAJECTORY-METADATA-POLICY.md).

## Validation

Every envelope validates at the boundary: Zod schemas in TypeScript, Pydantic models in Python. The two sides are kept field-for-field identical; the cross-language smoke tests merge the same fixture documents in both implementations and require identical results.

## Versioning

`docVersion` gates merges. A replica with an older document version receives a migration advisory rather than a silent merge. Protocol changes follow the RFC process; the envelope schemas are part of the public surface.

Evolution rules (additive-only until Stage 3, `PROTOCOL_VERSION` bumps,
deprecation window, worked examples):
[`DEPRECATION-POLICY.md`](./DEPRECATION-POLICY.md) /
[`packages/sync-protocol/docs/DEPRECATION-POLICY.md`](../../packages/sync-protocol/docs/DEPRECATION-POLICY.md).
History: [`packages/sync-protocol/CHANGELOG.md`](../../packages/sync-protocol/CHANGELOG.md).

**Release lockstep** (npm `@moolam/sync-protocol`, PyPI `sutra-sdk`, and
`PROTOCOL_VERSION` share one semver at every `v*` tag):
[`VERSION-LOCKSTEP.md`](./VERSION-LOCKSTEP.md)

Deeper material: merge semantics in [`../sync/README.md`](../sync/README.md), decision history in [ADR 0003](../adr/0003-sync-protocol.md), implementation philosophy in [`design/sync.md`](../../design/sync.md). Advisory codes and payload contracts for harness implementors: [`packages/sync-protocol/docs/advisory-surface.md`](../../packages/sync-protocol/docs/advisory-surface.md).

## Harness stream frames

Streaming turns use a typed `HarnessFrame` union (`SESSION_START` through
`HARNESS_ERROR`) with monotonic `sequenceIndex` and subject scoping — never
raw provider tokens. Reconnect, last-seen replay, gap detection, and
`HARNESS_ERROR` terminal rules:

[`HARNESS-STREAM-SEMANTICS.md`](./HARNESS-STREAM-SEMANTICS.md)

## Metering and BudgetHook

Per-turn `MeterEvent` (METER_TICK / `harness.meter`) and the host
`BudgetHook` decision surface (`allow` | `throttle` | `hardStop`):

[`METERING.md`](./METERING.md)

## Degradation registry

Named dependency-failure behaviors (`STALE_READ`, `HARD_STOP_WRITE`,
`QUEUE_AND_WARN`) and the read-only `lookup(surface, operation)` contract:

[`DEGRADATION-REGISTRY.md`](./DEGRADATION-REGISTRY.md)

Failure mode → behavior → proving drill (P4 chaos + harness), with verbatim
signal / freshness locks:

[`DEGRADATION-DRILL-CROSSREF.md`](./DEGRADATION-DRILL-CROSSREF.md)
