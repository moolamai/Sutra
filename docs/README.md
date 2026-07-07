# Sutra documentation

Layered documentation for the Moolam open cognitive infrastructure. Start with [`OVERVIEW.md`](OVERVIEW.md) if you are new; everything else is reference material organized by layer.

## Orientation

| Document | Purpose |
|---|---|
| [`OVERVIEW.md`](OVERVIEW.md) | What this project is, who it is for, how the pieces fit |
| [`ROADMAP.md`](ROADMAP.md) | Staged delivery plan |
| [`PRD_MATRIX.md`](PRD_MATRIX.md) | Requirements traceability matrix |

## By layer

| Section | Covers | Code |
|---|---|---|
| [`architecture/`](architecture/README.md) | System shape, dependency rules, edge/cloud split; [TikZ diagrams](architecture/diagrams/README.md) | whole repo |
| [`sdk/`](sdk/README.md) | The public API surface and how to build on it | `packages/sdk` |
| [`protocol/`](protocol/README.md) | The wire contract: state documents, sync envelopes, versioning | `packages/sync-protocol` |
| [`memory/`](memory/README.md) | Memory kinds, decay, retrieval, the two reference stores | `packages/contracts`, `packages/edge-agent`, cloud `memory_graph` |
| [`reasoning/`](reasoning/README.md) | Traces, verification, constraints | `packages/contracts` |
| [`planning/`](planning/README.md) | Goal graphs, task routing, evidence-driven revision | `packages/contracts`, cloud `task_router`/`planner` |
| [`sync/`](sync/README.md) | CRDT reconciliation, HLC time, offline-first behavior | `packages/sync-protocol`, cloud `sync_service` |
| [`runtime/`](runtime/README.md) | Lifecycle, scheduling, events, hosting an agent | `packages/runtime`, `packages/cloud-orchestrator` |
| [`domains/`](domains/README.md) | How domain modules work (the modules live in top-level `domains/`) | `domains/` |
| [`examples/`](examples/README.md) | Guide to the runnable examples | `examples/` |

## Decisions and process

| Section | Purpose |
|---|---|
| [`adr/`](adr/README.md) | Architecture Decision Records: why the system is shaped this way |
| [`../design/`](../design/) | Implementation philosophy per subsystem (maintainer-facing) |
| [`../rfcs/`](../rfcs/README.md) | Accepted design proposals; how the contracts evolve |
