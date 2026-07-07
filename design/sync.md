# Design: sync

## The stance

Sync is correct first, clever never. The entire layer rests on three algebraic properties (commutativity, associativity, idempotence) that are cheap to test and catastrophic to lose. Any proposed change to the merge path must come with property tests demonstrating all three survive.

## Why the document stays small

Full-document exchange is only viable because the document holds counters, registers, and ids, never content. This is the invariant that makes the whole design simple: no delta encoding, no op logs, no partial sync, no compaction protocol. The moment someone proposes putting memory text or transcripts into the state document, the correct answer is no, followed by pointing at this paragraph.

## Hand-rolled CRDTs, on purpose

Three structures (G-Counter, G-Set, LWW register) cover the document. A general CRDT library would handle arbitrary JSON but imports semantics we would then have to police. A few hundred auditable lines per language, tested against shared fixtures, beats a dependency we understand at 80%.

## Cross-language parity

The TypeScript resolver and the Python `crdt_merge.py` are twins by construction: same fixtures, same expected outputs, byte-comparable results. Any merge change lands in both languages in the same PR or it does not land. The smoke tests exist to make violating this rule embarrassing quickly.

## Time

HLCs give a total order without trusting device clocks. Two subtleties worth preserving: the logical counter absorbs clock skew rather than rejecting writes, and cloud wins exact ties by explicit policy (someone must, and the cloud's decision is the one a fleet operator can inspect). Never compare raw wall-clock times anywhere in the merge path.

## Deletion

CRDTs as used here cannot unsee data: counters only grow, sets only union. Forget requests are handled out-of-band as a deletion epoch (state document reset plus memory purge), coordinated by the deployment. Do not attempt tombstones in the G-Set; that path leads to the compaction machinery this design exists to avoid.
