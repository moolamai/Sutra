# Sutra - Project Overview

**Indian Sovereign AI Initiative · Moolam AI**

## What is Sutra?

Sutra is open cognitive infrastructure: the reusable foundation for building **autonomous cognitive companions** - systems that adapt to one subject (a learner, a matter, a case, a project, a portfolio) over months and years, and that keep working with no internet connection. Every component is self-hostable; no third-party service ever sits on the path of a user's data.

Sutra is not an app you download, and it is not itself a teacher, a lawyer, or a chatbot. It is the **engine underneath**, the way a payment gateway powers thousands of shops. Developers and companies build the user-facing product; Sutra supplies the cognition: memory, planning, reasoning, reflection, communication, and tool use.

**Education is the first reference domain, not the boundary.** The same primitives that power an autonomous cognitive teacher also power a legal companion, clinical decision support, an engineering design companion, or an analyst companion. Five domain specifications live in [`domains/`](../domains/README.md); the full cross-industry catalogue lives in [`domains/USE_CASES.md`](domains/USE_CASES.md).

## The platform in one sentence

A companion is not a model; it is a **configuration of cognitive primitives** bound to a domain: what it remembers, what corpus it cites, what tools it may touch, what it must refuse, and what task graph it walks.

Sutra ships those primitives as **interfaces rather than implementations** (`@moolam/contracts`): bind any memory store (vector DB or graph), any model (OpenAI-compatible, local SLM, custom), any reasoning engine, any speech or vision stack, any tool registry, any planner, any knowledge connector, any runtime host. Integrators author declarative domain configuration; the cognitive machinery, offline sync, audit surfaces, and multimodal plumbing are inherited. That is where the ~90% development acceleration comes from.

## The core idea: friction, not just correctness

Most software only records outcomes: the answer was right or wrong, the task was done or not. Sutra's protocol treats **interaction friction** (how long the user hesitated, how fast they worked, how many times they revised, whether they asked for help) as first-class evidence. A slow, assisted correct outcome and an instant fluent one are very different signals, and the engine weighs them differently when estimating consolidation of each concept.

When evidence shows a foundation is weak, the planner does something linear workflows cannot: it **loops backwards** through the prerequisite graph and repairs the foundation before moving on. Teaching a track, preparing a case, and working up a differential all backtrack this way. That cyclical behaviour is the heart of the system.

## How the pieces fit

| Component | Where it lives | What it does |
|---|---|---|
| Contracts | `packages/contracts` (TypeScript) | The pure interfaces: Memory, Model, Reasoning, Speech, Vision, Tool, Planning, Knowledge, Runtime. Zero dependencies, zero implementations; the dependency root of everything |
| Cognitive Core | `packages/cognitive-core` | `CognitiveCore`: the composition loop (perceive → recall → retrieve → reason → respond → reflect) assembled from one binding per contract |
| Runtime | `packages/runtime` | Reference lifecycle host, scheduler, and event bus; the hosting seam edge and cloud share |
| The Contract | `packages/sync-protocol` | The strict, framework-agnostic wire contract both sides speak, plus the CRDT merge mathematics that lets offline devices and the cloud reconcile state without ever producing a conflict |
| Telemetry | `packages/telemetry` | The friction collector, shared by edge and cloud |
| Edge host | `packages/edge-agent` | Runs a small language model (Phi-3, Gemma…) directly on the user's device. Works offline with zero latency, records friction into local SQLite, keeps a local memory of corrections and milestones |
| Cloud host | `packages/cloud-orchestrator` (Python) | The reference backend: FastAPI + LangGraph "cognitive state machine" (`agent_runtime`, `task_router`, `planner`, `memory_graph`, `sync_service`) plus pgvector long-term memory. Replaceable by any backend that honours the contract |
| SDK | `packages/sdk` | The one public entry point: `import { CognitiveCore } from "sutra-sdk"` |
| Domains | `domains/` | Domain specifications (teacher, lawyer, doctor, engineering, finance): profiles, task graphs, tool packs, memory semantics. Configuration, never platform code |
| Playground | `playground/` | The developer instrument. Exercises the real protocol code interactively so you can understand and verify system behaviour before writing integration code |
| Examples | `examples/` | Eight small runnable scripts against the SDK, from the education loop to CRDT sync to tool risk classes |
| Benchmarks | `benchmarks/` | Microbenchmarks for merge throughput, memory retrieval, sync round-trips, and core loop overhead |
| Infra | `infra/` | One docker-compose file that stands up Postgres+pgvector, Redis, and the orchestrator: the full self-hosted stack |

The education stack (`edge-agent` + `cloud-orchestrator` + `domains/teacher`) is the **first reference configuration** of the contracts, living proof that the interfaces compose into a shipping domain. The full contract-by-contract mapping is documented in [`sdk/INTERFACES.md`](sdk/INTERFACES.md).

## Who is this for?

**App developers & founders (any industry).** You build the user-facing product; Sutra supplies the cognition. Pick your domain from the use-case catalogue, author an `AgentProfile` (charter, refusals, languages), bind implementations to the contracts, register your knowledge connectors and tools, and self-host the backend with `pnpm infra:up`. Your product inherits offline operation, long-term memory, auditable reasoning, and sync without you writing any of that machinery. Start in the Playground console to see the protocol behave, then run the `examples/`.

**Domain professionals & researchers (law, medicine, finance, engineering, education, science).** The platform makes machine assistance inspectable in ways regulated professions require: every reasoning conclusion carries an auditable step trace, every knowledge passage carries a resolvable citation with an as-of date, every risky tool action is write-ahead audited, and refusal boundaries are configuration rather than prompt-engineering hope. The PRD matrix in [`PRD_MATRIX.md`](PRD_MATRIX.md) is the formal spec; the domain specifications under [`domains/`](../domains/README.md) show your profession's configuration.

**Educators & learning researchers.** The education configuration makes guidance inspectable. Every routing decision ships with a human-readable rationale; every mastery estimate is a transparent Beta posterior you can audit. Use the Playground console to falsify the model: construct interaction sequences and check the router does what the spec claims.

**Students & curious learners.** You will normally meet Sutra through apps built on top of it, not this repo. But if you want to understand how an AI companion "thinks", the Playground console is a glass-box demonstration: submit answers as an imaginary learner and watch your mastery estimate move, and see why the system decides to revisit fractions before percentages.

**Open-source contributors.** Two centres of gravity: the wire contract (`packages/sync-protocol`) and the cognitive contracts (`packages/contracts`). Good first areas: contract conformance suites, SLM runtime adapters for new inference engines, speech bindings for Indic languages, knowledge connectors for open corpora, task graph tooling, and new domain specifications. See `CONTRIBUTING.md` at the repository root.

## Development stages

See [`ROADMAP.md`](ROADMAP.md) for full acceptance criteria.

- **Stage 0 - Protocol & contracts scaffold (current).** The wire contract, CRDT merge engine, HLC clocks, reference cloud runtime, edge host, the cognitive contracts and core loop, the runtime package, infra, examples, benchmarks, and the Playground all exist and are verified by smoke tests. APIs may still change.
- **Stage 1 - Hardening & conformance (next).** Property-based tests fuzzing the CRDT merge across both languages, contract drift checks in CI, per-contract conformance suites (an implementation that type-checks but violates an obligation must fail CI), persistence and checkpointing. Outcome: contracts third parties can implement against with confidence.
- **Stage 2 - Reference bindings & pilots.** Native SLM adapters (llama.cpp, ONNX Runtime Mobile, Android AICore, MLX), speech and vision reference bindings, production task graph packs, education pilot deployments, plus at least one complete non-education domain built from its specification. Outcome: real autonomous cognitive companions in users' hands.
- **Stage 3 - Ecosystem.** Stable 1.0 contracts, a registry of community domain configurations (task graphs, knowledge connectors, tool packs), deployment blueprints for institutions, and multilingual evaluation. Outcome: Sutra as shared national infrastructure any industry can build on.

## Using the Playground console

1. **Play a subject.** Pick a concept, choose an outcome, set how long the subject hesitated and how much they revised, then submit. The mastery table updates using the production evidence-weighting rules.
2. **Trigger the loop-back.** Give several fast wrong answers on a basic concept (e.g. fractions), then fail its dependent concept (ratios). The event log will show the router looping back to the weak prerequisite, the defining behaviour of the engine.
3. **Break the network.** Take Device B offline, accumulate interactions on both devices so their states diverge, then restore connectivity and sync each one. The CRDT join reconciles everything: same result regardless of sync order, no conflicts, no lost evidence.

Everything the console does runs through the same published packages your application would use. It is a demonstration of the product, not a mock of it.
