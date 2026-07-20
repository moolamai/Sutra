# Sync

Offline-first is a merge problem. A subject works on a phone for a week with no connectivity while the cloud serves them through a shared terminal; when the phone reconnects, both histories are true and neither may be lost. Sutra resolves this with CRDTs over the cognitive state document, so convergence is a mathematical property rather than a conflict-resolution policy.

## The merge algebra

| State component | CRDT | Behavior under merge |
|---|---|---|
| Mastery evidence | G-Counter per (concept, replica) | Sum across replicas; evidence from both weeks counts |
| Memory log | G-Set | Union; a memory recorded anywhere exists everywhere |
| Session registers | LWW register | Latest HLC wins; cloud preferred on exact ties |
| Profile fields | LWW register | Same discipline |

Merge is commutative, associative, and idempotent: replicas can sync in any order, any number of times, through any intermediary, and reach the same document. The smoke tests assert these properties directly in both the TypeScript and Python implementations.

## Time without trusted clocks

Hybrid Logical Clocks order events across devices whose wall clocks disagree. Each replica stamps writes with (physical time, logical counter, replica id); comparisons are total, and causality is preserved even when a device's clock is hours wrong.

## The sync conversation

1. Device sends `SyncRequest` with its full document and a `syncAttemptId` (idempotency key; retries are safe).
2. Cloud merges against the master, persists, and returns `SyncResponse` with the converged document and advisories.
3. Device adopts the response after validating it; a validation failure keeps local state and surfaces the advisory.

There is no partial sync and no operational transform log: the document is small by design (counters and ids, not content), so full-document exchange stays cheap. The `cloud-sync` example demonstrates divergence and convergence end to end; `benchmarks/` measures merge throughput and round-trip latency. Decision history is in [ADR 0003](../adr/0003-sync-protocol.md); implementation philosophy in [`design/sync.md`](../../design/sync.md).

## Self-healing advisories

Semantic anomalies (clock skew, duplicate friction keys, unknown concepts, dominated state vectors) complete the merge and return typed `SyncAdvisory` rows. The implementor reference — codes, triggers, payload shapes, and regression fixtures — is [`packages/sync-protocol/docs/advisory-surface.md`](../../packages/sync-protocol/docs/advisory-surface.md).
