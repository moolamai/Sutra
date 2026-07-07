# ADR 0004: Kind-tagged memories with kind-driven decay

Status: Accepted

Date: 2026-07

## Context

A long-term companion accumulates memories for years. Treating all memories equally fails in both directions: uniform retention drowns retrieval in stale episodic noise; uniform decay forgets the one thing that must never be forgotten (a diagnosed misconception, a recorded allergy, a fielded design failure).

## Decision

Every memory carries a kind (`correction`, `milestone`, `preference`, `episodic`, `semantic`), and decay policy is a function of kind alone: corrections, milestones, preferences, and semantic facts never decay; episodics decay with a half-life (default 30 days) and are compacted after 180. Retrieval applies the decay multiplier at ranking time. Domains assign professional meaning to the kinds but cannot change the decay algebra.

## Options considered

- **Uniform recency-weighted retrieval**: simple, but a two-year-old correction loses to last week's noise. Rejected.
- **Per-memory TTLs set by the writer**: flexible but pushes a policy decision into every write site and makes behavior unauditable. Rejected.
- **Learned retention (train a forgetting model)**: interesting, unexplainable, unshippable as a default. Rejected for the platform; a deployment can implement it behind the contract.
- **Kind-driven policy (chosen)**: five kinds cover every domain we specified; the policy is one table that fits in documentation.

## Consequences

- The kind vocabulary is part of the public contract; adding a kind is an RFC
- Both reference stores (edge SQLite, cloud pgvector) enforce the same check constraint, keeping semantics identical across sync
- Mastery posteriors stay out of the memory system entirely (they are CRDT counters in the state document), a separation this ADR makes explicit
- Compaction is a scheduled runtime task, which is part of why the scheduler contract exists (ADR 0005)
