# Cognitive Contracts - Interface Specification

**Package: `@moolam/contracts` · Status: Stage 0 draft**

The platform exposes **interfaces, never implementations**. An agent is assembled by binding one implementation per contract into the `CognitiveCore` (`@moolam/cognitive-core`). This document specifies each contract's purpose, obligations, and reference bindings. Source of truth: `packages/contracts/src/`.

## Design rules (apply to every contract)

1. **Interface over implementation.** The contracts package never imports a vendor SDK, a database driver, or a model runtime. Adapters do.
2. **Contracts carry obligations, not just shapes.** Each interface documents MUST-level requirements (durability, streaming, audit, citation). An implementation that type-checks but violates an obligation is non-conformant.
3. **Locality is first-class.** Anything that moves data declares where it runs (`on-device` / `self-hosted` / `external-api`) so sovereign deployments can gate by data class.
4. **Auditability over convenience.** Reasoning traces, tool audit, plan rationales, and knowledge citations are mandatory surfaces, because the platform must be deployable in regulated domains.

---

## 1. `MemoryInterface` - what the agent learns about its subject

**File:** `src/memory.ts`

Long-term adaptation: corrections (never decay), milestones, preferences, episodic traces (decay-eligible), semantic facts. Pluggable across vector DBs, SQLite (edge), and graph stores - `associate()` gives graph backends an edge surface that vector backends may no-op.

| Obligation | Rationale |
|---|---|
| `remember` durable before resolve | A battery pull must never lose an acknowledged memory |
| Kind-aware decay; `correction` never decays | A dormant error pattern resurfacing is exactly what companions must catch |
| Multi-tenant safety by `subjectId` | One deployment serves many subjects |

**Reference bindings:** pgvector (cloud, `memory_graph.py`), SQLite Float32 BLOB (edge, `local_vector_db.ts`). **Community targets:** Qdrant, Milvus, Neo4j.

## 2. `ModelInterface` - provider-agnostic inference

**File:** `src/model.ts`

Chat generation (buffered + streaming), embeddings, structured output via JSON Schema. The descriptor declares context window, modalities, and **locality** - the hook for data-residency policy.

| Obligation | Rationale |
|---|---|
| Stable embedding dimension per instance | Memory stores lock dimension at first write |
| Streaming yields deltas | Voice synthesis pipelines consume token deltas |
| Truthful `locality` | Sovereign gating is only as good as the declaration |

**Reference bindings:** OpenAI-compatible localhost (Ollama/llamafile via `@moolam/edge-agent`), any OpenAI-compatible cloud endpoint. **Community targets:** Anthropic, vLLM, ONNX Runtime Mobile, Android AICore, MLX.

## 3. `ReasoningInterface` - auditable deliberation

**File:** `src/reasoning.ts`

Separates *deriving a conclusion* from *generating text*. Takes a proposition plus evidence (from Memory and Knowledge), returns a conclusion with a mandatory step trace and explicitly unresolved constraints.

| Obligation | Rationale |
|---|---|
| Empty `steps` is a contract violation | Regulated domains require reconstructable conclusions |
| Unverifiable constraints surface in `unresolvedConstraints` | The engine never pretends to have checked what it has not |

**Reference bindings:** single-model chain-of-thought with self-verification pass. **Community targets:** multi-agent debate, symbolic rule engines (legal/clinical) hybridized with LLM steps.

## 4. `SpeechInterface` - voice in, voice out

**File:** `src/speech.ts`

Streaming STT with partial segments and word-level confidence (the voice analogue of friction telemetry), streaming TTS with rate control. Indic languages are first-class: implementations declare `supportedLanguages` and the core routes fallbacks.

| Obligation | Rationale |
|---|---|
| Partial (`isFinal: false`) segments during transcription | The agent begins reasoning before the utterance ends - perceived latency |
| Declared language support, routed fallback | Voice-only users cannot read an error message |

**Reference bindings:** Whisper.cpp (on-device), any cloud STT/TTS. **Community targets:** AI4Bharat Indic models, Coqui/Piper TTS.

## 5. `VisionInterface` - visual understanding

**File:** `src/vision.ts`

Single `analyze` seam over images/PDFs with instruction + optional JSON Schema output, returning answers and located regions. Specialist backends (OCR, DICOM, CAD parsers) bind behind the same contract as general VLMs.

| Obligation | Rationale |
|---|---|
| Typed rejection above `maxInputBytes` | Silent downscaling corrupts clinical/engineering inputs |
| Schema-conformant answers when requested | Downstream reasoning consumes structured extractions |

**Reference bindings:** local VLM via OpenAI-compatible endpoint. **Community targets:** PaddleOCR, MONAI (medical), CAD toolchains.

## 6. `ToolInterface` - acting on the world

**File:** `src/tool.ts`

Schema'd tool registry and invocation with **risk classes** (`read` / `compute` / `write` / `critical`) that drive the execution policy: reads auto-execute, writes need policy approval, critical actions need a human. Write-ahead audit for mutating classes.

| Obligation | Rationale |
|---|---|
| Argument validation returns `error`, never throws | A malformed model-emitted call must not crash the loop |
| Write-ahead audit for `write`/`critical` | Regulated deployments need the attempt recorded, not just the success |
| Deadline enforcement | A hung tool cannot hang the agent |

## 7. `PlanningInterface` - goal graphs under evidence

**File:** `src/planning.ts`

Goals with prerequisites and success criteria, plans with dependent steps, and **revision that may route backwards** when evidence invalidates a foundation (the loop-back, domain-neutral).

| Obligation | Rationale |
|---|---|
| Cyclic-capable revision | Case prep, differentials, and design reviews all backtrack |
| Every revision updates `rationale` | Silent plan mutation destroys operator trust |

**Reference bindings:** LangGraph state machines (the cloud task router, `task_router.py`; graph planner, `planner.py`). **Community targets:** HTN planners, domain-specific protocol engines.

## 8. `KnowledgeConnectorInterface` - authoritative corpora

**File:** `src/knowledge.ts`

Memory is what the agent learned about its subject; knowledge is what the world already knows. Connectors bind statutes, guidelines, filings, standards, skill tracks - every passage carries a resolvable **citation** and an **as-of date**.

| Obligation | Rationale |
|---|---|
| Citation on every passage | Uncited knowledge is inadmissible to reasoning, by contract policy |
| `bundled-offline` sources answer offline | Village deployments cannot depend on connectivity |
| Truthful `asOf` | Staleness is a reasoning input, not a footnote |

## 9. Runtime contracts - the hosting seam

**File:** `src/runtime.ts`

What any host (phone app, server process, test harness) must provide: `LifecycleAware` state transitions, `SchedulerInterface` deferred/periodic tasks, `EventBusInterface` pub/sub, and `StorageDriver` key-value persistence. Reference in-process implementations live in `@moolam/runtime`.

| Obligation | Rationale |
|---|---|
| One-way lifecycle transitions (except suspend/resume) | Half-initialized components produce plausible-looking wrong turns |
| Events are observations, never control flow | Removing all subscribers must not break correctness |

---

## Composition: `CognitiveCore`

**Package:** `@moolam/cognitive-core` (`src/harness.ts`)

```
perceive (Speech/Vision) → recall (Memory) → retrieve (Knowledge)
→ reason (Reasoning) → plan/act (Planning + Tools) → respond (Model/Speech)
→ reflect (Memory)
```

The core takes an `AgentProfile` (charter, refusals, languages) and one binding per contract (speech/vision optional). Integrators author the profile, the bindings, the connectors, the tool registry, and the task graphs - declarative domain knowledge. The loop, the audit surfaces, the offline sync (via `@moolam/sync-protocol`), and the multimodal plumbing are inherited.

## Relationship to the reference stack

The shipped edge and cloud packages are the **first configuration** of these contracts:

| Contract | Reference binding |
|---|---|
| Memory | `LocalVectorDb` (edge) / `memory_graph.py` (cloud) |
| Model | `SlmRuntime` adapters (`@moolam/edge-agent`) |
| Planning | `task_router.py` + `planner.py` (LangGraph ATR) |
| Reasoning | Guidance-directive deliberation |
| Knowledge | Bundled corpus packs |
| Runtime | `@moolam/runtime` (in-process) / FastAPI engine (cloud) |
| Speech/Vision/Tools | Stage 2 bindings (roadmap) |

Domain-specific binding recommendations live in each domain's `interfaces.md` under [`domains/`](../../domains/README.md).
