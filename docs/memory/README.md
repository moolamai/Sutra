# Memory

Long-term memory is what makes an agent a companion instead of a session. The platform defines memory as a contract (`MemoryInterface` in `@moolam/contracts`) with two reference implementations: `LocalVectorDb` on the edge (SQLite-compatible, embedded) and `MemoryGraph` in the cloud (Postgres + pgvector). Both share the same semantics, so a subject's memory feels continuous across devices and sync.

## Memory kinds

Kinds encode *why* something is remembered, which drives how long it survives.

| Kind | Meaning | Decay |
|---|---|---|
| `correction` | An error and its diagnosis; the agent must not let it recur | Never decays |
| `milestone` | A significant achievement or decision | Never decays |
| `preference` | How the subject likes to work | Never decays, refreshed by overwrite |
| `episodic` | Raw interaction traces | Half-life decay (default 30 days), compaction after 180 |
| `semantic` | Distilled stable facts about the subject | Never decays, low volume |

Domain meaning is authored per domain: a `correction` is a misconception for a learner, an overruled citation for a lawyer, a fielded failure for an engineer. See the `memory.md` file in each `domains/` module.

## Retrieval

Recall is similarity search scoped by `subjectId` and optionally by concept, with the decay multiplier applied only to episodics. The practical effect: corrections and milestones dominate ranking as episodic noise fades. Recall runs before every turn; its results ground the prompt.

## Memory vs state

Memories are unstructured evidence in a vector store. Mastery posteriors are structured CRDT counters in the state document. They answer different questions (what do we know vs how consolidated is a concept) and travel by different mechanisms (memory ids sync as a G-Set log; counters merge numerically).

## Replacing the store

Any store that can satisfy the contract works: a graph database can implement `associate`/`relatedIds` natively, a managed vector service can back `search`. The conformance obligations that matter are kind-aware decay, subject scoping, and forget-on-demand. See [`design/memory.md`](../../design/memory.md) for the implementation philosophy and [ADR 0004](../adr/0004-memory-model.md) for the decision history.
