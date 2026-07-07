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

## Validation

Every envelope validates at the boundary: Zod schemas in TypeScript, Pydantic models in Python. The two sides are kept field-for-field identical; the cross-language smoke tests merge the same fixture documents in both implementations and require identical results.

## Versioning

`docVersion` gates merges. A replica with an older document version receives a migration advisory rather than a silent merge. Protocol changes follow the RFC process; the envelope schemas are part of the public surface.

Deeper material: merge semantics in [`../sync/README.md`](../sync/README.md), decision history in [ADR 0003](../adr/0003-sync-protocol.md), implementation philosophy in [`design/sync.md`](../../design/sync.md).
