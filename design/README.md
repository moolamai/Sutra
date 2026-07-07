# Design documents

Implementation philosophy per subsystem, written for maintainers and serious contributors. These are not user documentation (that lives in `docs/`) and not decision records (that is `docs/adr/`); they explain how the reference implementations think, so changes stay coherent with the original intent.

| Document | Subsystem |
|---|---|
| [`memory.md`](memory.md) | The two reference memory stores and the decay algebra |
| [`reasoning.md`](reasoning.md) | Traces, verification, and what an honest reasoning engine owes its callers |
| [`planner.md`](planner.md) | Graph walking, loop-back routing, and plan revision |
| [`runtime.md`](runtime.md) | Lifecycle strictness, scheduling minimalism, event discipline |
| [`sync.md`](sync.md) | The CRDT document, HLC time, and the invariants that keep sync cheap |

A change that contradicts one of these documents needs either a correction to the change or a PR updating the document with the reasoning for the shift.
