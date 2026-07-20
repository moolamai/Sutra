# Sutra documentation

Layered documentation for the Moolam open cognitive infrastructure. Start with [`OVERVIEW.md`](OVERVIEW.md) if you are new; everything else is reference material organized by layer.

Public browsable site: [`docs-site/`](../docs-site/README.md) (VitePress). Canonical markdown still lives under `docs/` — see [`docs-site/OWNERSHIP.md`](../docs-site/OWNERSHIP.md). Generated TypeDoc API reference is served at `/api/` on that site (`pnpm docs-site:api`).

## Orientation

| Document | Purpose |
|---|---|
| [`OVERVIEW.md`](OVERVIEW.md) | What this project is, who it is for, how the pieces fit |
| [`ROADMAP.md`](ROADMAP.md) | Staged delivery plan |
| [`PRD_MATRIX.md`](PRD_MATRIX.md) | Requirements traceability matrix (public spec) |

## By layer

| Section | Covers | Code |
|---|---|---|
| [`architecture/`](architecture/README.md) | System shape, dependency rules, edge/cloud split; [TikZ diagrams](architecture/diagrams/README.md) | whole repo |
| [`sdk/`](sdk/README.md) | The public API surface and how to build on it; [implementor](sdk/implementor-quickstart.md), [conformance stub](sdk/conformance-stub-guide.md), [binding certification](sdk/binding-certification-guide.md) quickstarts | `packages/sdk`, `packages/contract-conformance` |
| [`protocol/`](protocol/README.md) | The wire contract: state documents, sync envelopes, versioning | `packages/sync-protocol` |
| [`memory/`](memory/README.md) | Memory kinds, decay, retrieval, the two reference stores | `packages/contracts`, `packages/edge-agent`, cloud `memory_graph` |
| [`reasoning/`](reasoning/README.md) | Traces, verification, constraints | `packages/contracts` |
| [`planning/`](planning/README.md) | Goal graphs, task routing, evidence-driven revision | `packages/contracts`, cloud `task_router`/`planner` |
| [`sync/`](sync/README.md) | CRDT reconciliation, HLC time, offline-first behavior | `packages/sync-protocol`, cloud `sync_service` |
| [`runtime/`](runtime/README.md) | Lifecycle, scheduling, events, hosting an agent | `packages/runtime`, `packages/cloud-orchestrator` |
| [`domains/`](domains/README.md) | How domain modules work (the modules live in top-level `domains/`) | `domains/` |
| [`learning/`](learning/CONSTITUTION.md) | Learning constitution, [mix policy](learning/MIX_POLICY.md), [LLM-judge policy](learning/LLM_JUDGE_POLICY.md), kill-switch runbook | `packages/learning`, `training/corpus` |
| [`pilot/FIELD-PILOT-KIT.md`](pilot/FIELD-PILOT-KIT.md) | Field pilot device matrix + offline bundle recipe (B8) | `examples/offline-edge`, bindings certify |
| [`pilot/findings/`](pilot/findings/) | Dated field-pilot anomaly findings (B8 execution) | `pnpm field-pilot:execute` |
| [`pilot/PILOT-SUMMARY.md`](pilot/PILOT-SUMMARY.md) | Pilot finding index for P7 freeze RFC evidence | `pnpm field-pilot:findings:check` |
| [`pilot/PILOT-EXIT-REVIEW.md`](pilot/PILOT-EXIT-REVIEW.md) | Privacy + markSynced + routing exit sign-off | `pnpm field-pilot:exit-review` |
| [`pilot/P7-FREEZE-RFC-DRAFT.md`](pilot/P7-FREEZE-RFC-DRAFT.md) | B8 field-pilot appendix draft for Track A freeze RFC | links `PILOT-SUMMARY.md` |
| [`examples/`](examples/README.md) | Guide to the runnable examples | `examples/` |

## Decisions and process

| Section | Purpose |
|---|---|
| [`adr/`](adr/README.md) | Architecture Decision Records: why the system is shaped this way |
| [`../design/`](../design/) | Implementation philosophy per subsystem (maintainer-facing) |
| [`../rfcs/`](../rfcs/README.md) | Accepted design proposals; how the contracts evolve |
