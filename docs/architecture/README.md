# Architecture

Sutra is layered infrastructure. Each layer depends only on the layers above it, and the arrows never reverse.

![Package dependency graph](diagrams/svg/package-dependencies.svg)

Full diagram set (repository map, edge/cloud, cognitive pipeline, sync, memory, domains, SDK layering): [`diagrams/README.md`](diagrams/README.md).

STRIDE threat model (trust boundaries, data-flow diagrams, boundary inventory): [`security/THREAT-MODEL.md`](../../security/THREAT-MODEL.md).

## The layers

| Layer | Package | Responsibility |
|---|---|---|
| Contracts | `packages/contracts` | Every interface the platform is built from: memory, model, reasoning, planning, knowledge, tool, vision, speech, runtime. No implementations, no dependencies |
| Core | `packages/cognitive-core` | `CognitiveCore`: the composition loop that turns bound contracts into an agent turn (recall, ground, reason, act, remember) |
| Runtime | `packages/runtime` | Reference in-process implementations of the runtime contracts: `RuntimeHost` lifecycle, `InProcessScheduler`, `InProcessEventBus` |
| Protocol | `packages/sync-protocol` | The wire contract (`CognitiveState`, sync envelopes) and the CRDT reconciliation engine, with a byte-equivalent Python twin in the cloud engine |
| Telemetry | `packages/telemetry` | Friction sensing shared by edge and cloud |
| Edge host | `packages/edge-agent` | Offline-first on-device host: local SLM runtime, local vector store, sync client |
| Cloud host | `packages/cloud-orchestrator` | FastAPI runtime: `agent_runtime`, `task_router`, `planner`, `memory_graph`, `sync_service` |
| SDK | `packages/sdk` | Re-exports the stable public surface; the one import applications need |
| Domains | `domains/` | Profiles, task graphs, corpora, tool packs. Data and documentation, never platform code |

## Cognitive turn

![Cognitive execution pipeline](diagrams/svg/cognitive-pipeline.svg)

## Edge and cloud

![Edge and cloud peers](diagrams/svg/edge-cloud.svg)

## Dependency rules

Allowed direction: SDK -> Contracts -> Core -> Runtime -> Edge/Cloud -> Domains.

Forbidden, and treated as review-blocking:

- Contracts importing any implementation
- Core importing runtime, hosts, or domains
- Any package importing from `domains/`
- Domains importing each other
- Profession-specific vocabulary (teacher, student, pedagogy, curriculum, lesson) inside `packages/`

## Why these decisions

The reasoning behind the shape of the system is recorded as Architecture Decision Records in [`../adr/`](../adr/README.md). The implementation philosophy per subsystem lives in top-level [`design/`](../../design/). Diagram sources are version-controlled TikZ in [`diagrams/source/`](diagrams/source/).
