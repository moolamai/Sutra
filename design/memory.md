# Design: memory

## The stance

Memory is evidence, not truth. A memory records that something was observed at a time, with a reason it seemed worth keeping (the kind). Retrieval re-weighs that evidence for the present question. The store never editorializes: ranking policy lives in the retrieval path where it can be inspected, not in write-time filtering where it cannot.

## Why kinds, concretely

The kind is the only write-time policy decision we allow, because it is the only one the writer actually knows. The writer knows "this was a diagnosed error" (`correction`) or "this was a raw exchange" (`episodic`). The writer does not know whether the memory will matter in a year, so we refuse APIs that ask for TTLs or importance scores at write time. Importance is a retrieval-time judgment; time-to-live is a kind-table lookup.

## Decay implementation

Decay is computed at query time from `created_at`, never by mutating rows. This keeps writes append-only (cheap, audit-friendly, sync-friendly) and makes decay parameters tunable without migration. Compaction is the only destructive operation: episodics past the compaction horizon are summarized into a single semantic memory and deleted, under a scheduled runtime task, never inline with a turn.

## The two reference stores

`LocalVectorDb` (edge) and `MemoryGraph` (cloud) are deliberately parallel: same schema shape, same kind check constraint, same decay function, different substrates (embedded SQLite-style vs Postgres + pgvector + HNSW). Parity is a feature; a subject syncing between edge and cloud must not feel a personality change. When you improve one, port the improvement or document why it is substrate-specific.

## What stays out

- Mastery posteriors: CRDT counters in the state document, not memories
- Raw content in sync: memory ids travel in the G-Set log; text syncs through the memory replication channel a deployment configures, respecting locality policy
- Cross-subject retrieval: recall is keyed by `subjectId` at the contract level; there is no "search everyone" API, deliberately
