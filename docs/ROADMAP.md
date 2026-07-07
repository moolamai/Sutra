# Sutra Roadmap

**Indian Sovereign AI Initiative · Moolam AI**

Sutra ships in deliberate stages. Each stage has explicit acceptance criteria; a stage is not "done" because code exists, but because the criteria hold.

Scope note: Sutra is **cognitive infrastructure**, not an application. Education is the first reference domain; the cognitive contracts (`packages/contracts`) and the core loop (`packages/cognitive-core`) carry the same primitives into law, medicine, finance, engineering, and beyond. Each stage below tracks both tracks: the protocol/reference-domain track and the contracts/platform track.

---

## Stage 0 - Protocol & Contracts Scaffold `← WE ARE HERE`

The foundation: a complete, buildable, verifiable skeleton of the Hybrid Cognitive Sync Protocol and the domain-agnostic cognitive contracts.

**Delivered (protocol & reference-domain track):**

- Canonical wire contract (`packages/sync-protocol/src/contract.ts`) with Zod runtime validation and a Pydantic mirror.
- CRDT merge engine in both TypeScript and Python (G-Counter mastery shards, G-Set friction log, LWW session registers, HLC clocks), smoke-tested for commutativity, idempotence, and duplicate elimination in both languages.
- Reference cloud engine: FastAPI ingress + LangGraph cyclical task router + graph planner + pgvector memory graph + sync service, composed by `agent_runtime.py`.
- Edge host: pluggable SLM runtime interface, SQLite-backed local vector store, autonomous sync engine with backoff/quarantine semantics.
- Shared telemetry package (`packages/telemetry`) used by the edge host and available to the cloud.
- Self-host stack (`infra/docker-compose.yml`) and the Playground protocol console.
- Master PRD matrix (`docs/PRD_MATRIX.md`) with per-spec edge cases.

**Delivered (contracts & platform track):**

- The cognitive contracts in `packages/contracts`: Memory, Model, Reasoning, Speech, Vision, Tool, Planning, Knowledge Connector, and the runtime contracts (lifecycle, scheduler, events, storage), each with documented MUST-level obligations (durability, traces, citations, risk classes, locality).
- The `CognitiveCore` reference composition (`packages/cognitive-core`): perceive → recall → retrieve → reason → respond → reflect.
- The reference runtime (`packages/runtime`): lifecycle host, in-process scheduler, in-process event bus.
- The SDK (`packages/sdk`): one public entry point re-exporting the stable surface.
- Five domain specifications (`domains/`): teacher, lawyer, doctor, engineering, finance.
- Eight runnable examples (`examples/`) and four microbenchmarks (`benchmarks/`).
- Layered documentation (`docs/`), five ADRs (`docs/adr/`), five design documents (`design/`), and the RFC process (`rfcs/`).

**Honest caveats at this stage:** APIs may change; master state is held in memory unless `SUTRA_PG_DSN` is set; no security/authn layer yet; task graphs are demonstration-sized; contracts have no conformance suites yet and only the education bindings exist.

---

## Stage 1 - Hardening & Conformance

Make the contracts something third parties can implement against with confidence, in both tracks.

**Acceptance criteria (protocol & reference-domain track):**

- [ ] Property-based test suite fuzzing merge orderings across TS and Python; identical joins byte-for-byte.
- [ ] CI contract-drift check: generated JSON Schemas from Zod and Pydantic diffed on every commit.
- [ ] Master cognitive state persisted to Postgres (JSONB) with the `sync_audit` trail wired.
- [ ] LangGraph checkpointing on Redis; router state survives process restart.
- [ ] AuthN/AuthZ at the API boundary (deployment-pluggable; no third-party identity requirement).
- [ ] Versioned protocol changelog and deprecation policy published.

**Acceptance criteria (contracts & platform track):**

- [ ] Per-contract conformance suites: an implementation that type-checks but violates an obligation (e.g. empty reasoning trace, uncited knowledge passage, missing write-ahead tool audit) fails CI.
- [ ] Locality enforcement tests: deployments can prove regulated data classes never cross `on-device` / `self-hosted` boundaries.
- [ ] Reference in-memory implementations of all contracts for testing and prototyping (the example mocks promoted to a supported package).
- [ ] `AgentProfile` refusal boundaries checked by the reasoning layer, with tests demonstrating scope-of-practice enforcement.
- [ ] Dependency-direction lint in CI: contracts import nothing; no package imports `domains/`.

---

## Stage 2 - Reference Bindings & Pilots

Put real autonomous cognitive companions in users' hands.

**Acceptance criteria (protocol & reference-domain track):**

- [ ] Native SLM adapters: llama.cpp (desktop), ONNX Runtime Mobile, Android AICore/MediaPipe, Apple MLX.
- [ ] Production task graph packs: CBSE middle-school mathematics; system-design interview track.
- [ ] Task graph authoring tooling (flat-row prerequisite DAGs, validated against the router).
- [ ] Sustained-offline field trial: two weeks disconnected, full reconciliation on reconnect, zero evidence loss.
- [ ] Pilot deployments with partner classrooms/institutes; friction-model calibration against real cohorts.
- [ ] NFR targets from the PRD matrix measured and met on mid-range Android hardware, tracked in `benchmarks/`.

**Acceptance criteria (contracts & platform track):**

- [ ] Speech reference bindings: on-device STT/TTS with first-class Indic language support (voice-only companions become buildable).
- [ ] Vision reference binding: local VLM behind the `VisionInterface` seam.
- [ ] Tool execution policy engine: risk-classed approval flows (`read`/`compute` auto, `write` policy-gated, `critical` human-gated) with write-ahead audit.
- [ ] Knowledge connector reference implementations: one bundled-offline pack format and one self-hosted RAG index.
- [ ] At least one complete **non-education domain** built end to end from its specification in `domains/` (candidates: lawyer or doctor), demonstrating the domain-changes-primitives-stay thesis.

---

## Stage 3 - Ecosystem

Sutra as shared infrastructure across industries.

**Acceptance criteria:**

- [ ] Wire contract and cognitive contracts frozen at 1.0 with additive-only evolution guarantees, governed through the RFC process.
- [ ] Community registry of domain configurations: task graphs, knowledge connectors, tool packs, and agent profiles, with a review process.
- [ ] Institution deployment blueprints (sizing, backup, data-residency guidance) for schools, courts/firms, clinics, and enterprises.
- [ ] Multilingual evaluation across major Indian languages, text and voice.
- [ ] At least one independent, non-reference backend implementation passing the conformance suites, proof the contracts, not the codebase, are the product.
- [ ] Regulated-domain deployment guides (law, medicine, finance) documenting trace, citation, audit, and locality guarantees against sector requirements.

---

## How to engage at each stage

| You are… | Stage 0 (now) | Stage 1-2 | Stage 3 |
|---|---|---|---|
| **Developer / founder (any industry)** | Explore the Playground; run the `examples/`; read the contracts; prototype against the reference engine locally | Build your domain configuration on the SDK; join pilots | Ship on frozen 1.0 contracts |
| **Domain professional / researcher** | Audit the PRD matrix, the mastery/routing models, and your profession's specification in `domains/` | Contribute calibration studies, task graphs, and knowledge connectors | Publish and deploy against stable, citable contracts |
| **Contributor** | Conformance tests, docs, adapter stubs | Runtime/speech/vision bindings, tool policy engine, connector implementations | Registry, evaluation harnesses |
| **End user** | Try the Playground's glass-box console | Join pilot programs | Use apps built on Sutra |
