# ADR 0003: CRDT state documents with HLC ordering

Status: Accepted

Date: 2026-07

## Context

Peer runtimes (ADR 0002) mean the same subject accumulates evidence on multiple replicas concurrently, with device clocks that cannot be trusted. The sync layer must guarantee that no evidence is lost and that all replicas reach the same state, without a human or a heuristic resolving conflicts.

## Decision

The unit of sync is a small JSON state document per subject, composed of CRDTs: G-Counters for mastery evidence, a G-Set for the memory log, and last-writer-wins registers ordered by Hybrid Logical Clocks for session registers and profile fields. Cloud wins exact HLC ties. Merge is commutative, associative, and idempotent, and both the TypeScript and Python implementations are tested against the same fixtures.

## Options considered

- **Operational transform / op log**: precise but demands ordered delivery and log compaction machinery; overkill for a document of counters and ids. Rejected.
- **Server-authoritative with client conflict prompts**: pushes distributed-systems problems onto users. Rejected.
- **Full CRDT library (e.g. general JSON CRDTs)**: powerful but imports large dependencies and semantics we do not need. Rejected in favor of hand-rolled structures matched to the document shape.
- **Purpose-built CRDT document (chosen)**: three well-understood structures, auditable in a few hundred lines per language.

## Consequences

- Sync is a full-document exchange; this stays cheap only while the document holds counters and ids, not content, which is now an invariant of the protocol
- Evidence counters never decrement; decay and re-weighting happen at read time, not in the CRDT
- HLC stamps make replica behavior debuggable (the Playground's protocol inspector renders them directly)
- Deleting data (subject forget requests) is out-of-band by design: a deletion epoch, not a CRDT operation
