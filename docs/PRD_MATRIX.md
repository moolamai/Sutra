# Sutra - Master PRD Matrix

**Hybrid Cognitive Sync Protocol · Indian Sovereign AI Initiative · Moolam AI**

Protocol version: `1.0.0` · Status: `DRAFT-FOR-IMPLEMENTATION` · Canonical contract: [`packages/sync-protocol/src/contract.ts`](../packages/sync-protocol/src/contract.ts)

This document is the engineering source of truth for the five subsystems of the platform: the four protocol subsystems (CAST, ATR, MCE, SYNC) and the domain-agnostic Cognitive Contracts (CK) that generalize them to every industry. Every Spec ID is referenceable from commits, issues, and conformance tests (`CAST-01`, `CK-03`, etc.). "Edge" refers to `@moolam/edge-agent`; "Cloud" refers to the reference engine `sutra_orchestrator`; "Contracts" refers to `@moolam/contracts` with the composition loop in `@moolam/cognitive-core` - but any contract-compliant implementation MUST satisfy the same rows.

---

## 1. Cognitive Assessment & State Tracking (CAST)

**Thesis.** Correctness is a lagging indicator; *friction* is a leading one. CAST treats hesitation latency, input velocity, revision churn, and assistance requests as first-class evidence, folded into a per-concept Bayesian mastery posterior that both hosts can compute identically.

**Mastery model.** Each concept holds Beta-distribution pseudo-counts `(α, β)` sharded per device as CRDT G-Counters. Posterior mean = `(Σα+1)/(Σα+Σβ+2)`. Fluency-weighted increments: an assisted, high-churn correct outcome contributes 0.5α, a fluent one 1.0α.

| Spec ID | Feature | Technical Implementation | Edge Case & Remediation |
|---|---|---|---|
| CAST-01 | Friction sampling | `CognitiveTelemetryCollector` (`@moolam/telemetry`) folds raw events (`prompt-rendered`, `input`, `deletion`, `assistance-requested`, `submitted`) into one `FrictionSample` per task; write-ahead insert into SQLite `friction_samples` before acknowledgment. | App killed mid-task → open accumulator is discarded by design (partial evidence poisons the posterior); durable samples survive via WAL. Stray events with no open window are dropped, not queued. |
| CAST-02 | Hesitation & velocity metrics | `hesitationMs` = prompt render → first input; `inputVelocity` = chars/sec over the active typing window; `revisionCount` = deletion events. All computed on-device; raw keystroke content never leaves the device. | Subject walks away mid-prompt → hesitation would be spuriously huge; the cloud router clamps at `HESITATION_SPIKE_MS` and treats it as a binary spike flag, not a magnitude. |
| CAST-03 | Bayesian mastery posterior | `ConceptMastery{alpha, beta}` per-device G-Counter shards (`Record<deviceId, number>`); posterior mean computed identically in TS (`edge_agent.ts#foldFriction`) and Python (`ConceptMastery.mastery_mean`). | Same evidence replayed via sync retry → shards merge by `max()`, never `sum()` of deltas, so double-counting is structurally impossible (SYNC-03). |
| CAST-04 | Fluency-weighted evidence | Correct outcome with `hesitationMs < 3000 ∧ revisionCount ≤ 1` → +1.0α; otherwise +0.5α; incorrect → +1.0β; partial → +0.5α +0.5β. | Guessing (fast + correct + later contradicted): the correction memory class (MCE-03) resurfaces the concept for reinforcement, and subsequent β evidence pulls the posterior back down. |
| CAST-05 | Diagnostic cold start | New subject enters in `diagnostic` mode; the router schedules calibration probes across task-graph entry nodes until every root concept has ≥3 samples. | Subject transferred mid-track with external history → profile `track` LWW register is updated and unprobed concepts default to posterior mean 0.5 (maximally uncertain), never 0. |
| CAST-06 | Age-band signal calibration | `profile.ageBand ∈ {child, adolescent, adult}` selects the friction normalization table (children type slower; velocity thresholds scale). | Shared family device → `deviceId` identifies the install, `subjectId` the subject; per-subject rows in every store prevent posterior cross-contamination. |

---

## 2. Adaptive Task Router (ATR)

**Thesis.** Guidance is a *cyclical* state machine, not a playlist. Failure routes backwards through the prerequisite DAG; consolidation routes forward. Implemented as a LangGraph `StateGraph` (`task_router.py`) whose loop edge `remediate_prereq → assess_friction` is the core mechanic.

**Topology.** `assess_friction → {advance_concept | remediate_prereq | generate_guidance}`; `remediate_prereq → {assess_friction (cycle) | generate_guidance}`; `advance_concept → generate_guidance → END`. Hysteretic thresholds: advance at posterior ≥ 0.85, remediate below 0.40 - the gap prevents oscillation on noisy estimates.

| Spec ID | Feature | Technical Implementation | Edge Case & Remediation |
|---|---|---|---|
| ATR-01 | Cyclical remediation routing | LangGraph conditional edge from `assess_friction`: friction spike + weakest prerequisite posterior < τ_r=0.40 → `remediate_prereq`, which rewrites `active_concept_id` and re-enters `assess_friction` to recurse into the prerequisite's own prerequisites. | Pathological/cyclic task DAG or deeply weak chains → `MAX_REMEDIATION_DEPTH = 4` circuit breaker exits the loop and pins the session to `guided` mode with a logged warning. |
| ATR-02 | Hysteretic advancement | `_route_after_assessment` advances only when posterior ≥ τ_a=0.85 *and* no friction spike this turn; τ_r < τ_a creates a dead band where the router holds position. | Posterior hovering at the threshold with alternating outcomes → dead band absorbs the noise; no mode thrash, no remediation ping-pong. |
| ATR-03 | Guidance mode selection | `GuidanceMode` LWW register set by router nodes: `exploratory` on advance, `guided` under the depth breaker, `reinforcement` for decayed concepts, `prerequisite-remediation` inside the cycle, `diagnostic` at cold start. | A subject stuck in `guided` after a breaker trip → next nominal-friction turn re-runs assessment and restores `exploratory`; mode never latches permanently. |
| ATR-04 | Explainable routing | Every node appends to `routing_rationale`; the terminal state returns it verbatim in `AgentTurnResponse.routingRationale`, rendered raw in the Playground router trace panel. | "Why is the session on fractions again?" support escalation → the rationale string is the audit answer; it is never truncated or post-processed. |
| ATR-05 | Model-agnostic guidance directives | `generate_guidance` emits a structured directive (`GUIDE concept=… mode=… remediation_depth=…`), not prose; the prompt assembler downstream targets cloud LLM or edge SLM interchangeably. | Backend LLM unavailable/timeout → the directive itself is a valid degraded reply; the edge SLM executes the identical directive offline (edge fallback is the *same* contract, not a special path). |
| ATR-06 | Edge policy parity | Edge runs a greedy simplification (lowest-mastery prerequisite first, `edge_agent.ts`); on reconnect the cloud's LWW session registers win, upgrading routing quality without state conflict. | Divergent edge vs cloud routing decisions during a long offline stretch → both are recorded; HLC total order picks the winner deterministically, and mastery evidence (G-Counters) from both merge losslessly regardless. |

---

## 3. Memory & Context Engine (MCE)

**Thesis.** A cognitive companion is defined by what it refuses to forget. The MCE is a per-subject memory graph over four durable classes - `correction`, `milestone`, `preference`, `episodic` - embedded at 768-dim, stored in pgvector (cloud, `memory_graph.py`) and mirrored in SQLite (edge, `local_vector_db.ts`).

**Retrieval semantics (identical on both hosts).** Score = cosine similarity × recency decay; episodic memories decay with a 30-day half-life; **corrections never decay** - a dormant error pattern resurfacing months later is precisely what long-term adaptation must catch.

| Spec ID | Feature | Technical Implementation | Edge Case & Remediation |
|---|---|---|---|
| MCE-01 | Cloud vector store | Postgres 17 + pgvector, `vector(768)`, HNSW index with `vector_cosine_ops` (no training step → correct from row #1, unlike IVFFlat); psycopg3 pool, handlers off the event loop via threadpool. | HNSW recall degradation at high per-subject cardinality → nightly `compact_episodic` (≥180-day fully-decayed episodics) bounds the working set; corrections/milestones/preferences retained indefinitely. |
| MCE-02 | Edge vector mirror | `LocalVectorDb` over a `StorageDriver` seam (expo-sqlite / better-sqlite3 / wa-sqlite); Float32 BLOB vectors; brute-force exact cosine bounded by `maxResidentVectors = 50k` - exact recall, zero native ANN deps on mobile. | Store exceeding the resident cap → `pruneEpisodicOlderThan` evicts cloud-acknowledged episodics first; correction rows are never eviction candidates. |
| MCE-03 | Memory classes & decay | Class drives decay policy: episodic `exp(−ln2 · age/30d)`; correction/milestone/preference decay factor fixed at 1.0. Same formula in Python (`recall`) and TS (`search`). | Correction actually resolved (posterior recovered + N fluent retrievals) → superseded by a linked `milestone` memory and demoted to episodic, entering normal decay rather than being deleted (audit trail preserved). |
| MCE-04 | Embedding dimension lock | Store-wide 768-dim asserted at write time on both sides (`ValueError` / `Error` on mismatch) - fail at the boundary, not a round-trip later in the DB. | Embedding model swap (e.g. nomic → gte) → dimensions match but spaces don't; deployments MUST bump the store epoch and re-embed; mixed-epoch writes are rejected by an epoch tag in the model card. |
| MCE-05 | Cross-boundary continuity | Edge retrieves from its mirror while offline; cloud recalls from pgvector online; identical scoring ⇒ the agent "remembers the same things" on either side of the connectivity boundary. | Memory written on-device while offline → shipped in the next sync envelope, embedded cloud-side into pgvector; the HLC id makes replay idempotent (duplicate insert is a no-op). |
| MCE-06 | Privacy containment | Memories store distilled text ("confuses derivative with chord slope"), never raw transcripts; CAST behavioral metadata and MCE text are the only subject data classes that cross the boundary. | Data-residency mandate (sovereign deployment) → the entire cloud host is self-hostable via `infra/docker-compose.yml`; no third-party service is on the data path by design. |

---

## 4. Protocol-First Sync Logic (SYNC)

**Thesis.** The API boundary is the product. The edge host speaks a strict JSON contract (`/v1/sync`, `/v1/agent/turn`, `/v1/subjects/{id}/state`) and is byte-for-byte indifferent to what implements it. State reconciliation is a state-based CRDT (CvRDT) join - convergence is a property of the data types, not of policy code. There is no conflict-resolution UI anywhere in Sutra.

**Merge algebra** (`crdt_harness_resolver.ts` ⇄ `crdt_merge.py`, join-semilattice: commutative, associative, idempotent): mastery α/β → per-device G-Counter shards, pointwise `max`; `frictionLog` → G-Set keyed by HLC `capturedAt`; session registers (`activeConceptId`, `mode`, `profile`) → LWW under HLC total order; `stateVector` → pointwise HLC `max`.

| Spec ID | Feature | Technical Implementation | Edge Case & Remediation |
|---|---|---|---|
| SYNC-01 | Framework-agnostic contract | Single canonical source (`contract.ts`, Zod) mirrored by Pydantic (`contract_models.py`); runtime validation at both boundaries; `PROTOCOL_VERSION` literal pinned in every envelope; wire format changes are additive-only. | TS/Python model drift → CI conformance job diffs generated JSON Schemas from both sides and fails the build on any mismatch. Version mismatch on the wire → 4xx with `VERSION_MISMATCH`, edge quarantines (never retries) per SYNC-05. |
| SYNC-02 | Hybrid Logical Clocks | `HlcClock` (Kulkarni et al. 2014): `"<physical:15d>:<logical:6d>:<deviceId>"`; lexicographic order = total order; `observe()` advances past every received remote timestamp. | Device wall clock grossly wrong ("time-traveler attack" - permanently winning every LWW register) → resolver clamps HLCs beyond a 24h skew horizon and emits `CLOCK_SKEW_CLAMPED` advisory; merge always completes. |
| SYNC-03 | Convergent CRDT merge | State-based join: full-replica exchange, `merge(a,b)` commutative/associative/idempotent; G-Counter shards merge by `max` (retransmission-safe), G-Set union keyed by globally-unique HLC, LWW ties broken deterministically by the deviceId embedded in the HLC. | Three-way concurrent edits (two devices + cloud) in any delivery order → semilattice algebra guarantees identical convergence on all replicas; property-based tests fuzz merge orderings for the commutativity/associativity/idempotence invariants. |
| SYNC-04 | Autonomous retry engine | `SyncEngine.synchronize()` never throws - terminal outcomes are values (`converged` / `quarantined` / `exhausted`); transient failures (network, 5xx) → exponential backoff with full jitter, 6 attempts, idempotency key (`syncAttemptId`) reused across retries. | Connectivity dies mid-retry-series → `exhausted` outcome parks the replica locally; the next connectivity-restoration event starts a fresh series; join idempotence makes partial double-delivery harmless. |
| SYNC-05 | Poison-payload quarantine | HTTP 4xx (server declares the payload malformed) → payload quarantined locally with a structured report; retrying a payload the server rejected is forbidden by the engine. | Corrupted local SQLite producing a schema-invalid replica → `IrreconcilableStateError{SCHEMA_VIOLATION}`; quarantine preserves the evidence for a repair tool instead of hot-looping the endpoint. |
| SYNC-06 | Self-healing advisories | Semantic anomalies never abort a merge; they degrade to typed `SyncAdvisory` rows (`CLOCK_SKEW_CLAMPED`, `DUPLICATE_SAMPLE_DROPPED`, `UNKNOWN_CONCEPT_QUARANTINED`, `STATE_VECTOR_REGRESSION`) persisted to `sync_audit` and streamed to the Playground. | Advisory storm from one device (e.g. flapping clock) → audit table is `UNIQUE(sync_attempt_id)` and append-only; fleet panel surfaces the offending device rather than throttling the subject's sync. |
| SYNC-07 | Server response validation | Edge re-validates `SyncResponse.mergedState` against the Zod schema before adopting it; a garbage response leaves the local replica authoritative (`exhausted` outcome, flagged for next window). | Compromised or buggy backend returning malformed state → the edge never adopts unvalidated state; sovereignty includes not trusting the cloud. |
| SYNC-08 | Compaction handshake | `SyncResponse.compactedSampleTimestamps` acknowledges friction samples folded into mastery; edge marks them `synced=1` and prunes; unacknowledged samples ride again in the next envelope. | Ack lost after a successful merge → samples are re-sent; the G-Set union dedupes them (`DUPLICATE_SAMPLE_DROPPED` advisory) with zero double-counting, per SYNC-03. |

---

## 5. Cognitive Contracts (CK)

**Thesis.** The domain changes; the cognitive primitives stay the same. `@moolam/contracts` exposes the primitives as **interfaces rather than implementations** so the same architecture serves education, law, medicine, finance, engineering, and beyond, as text, voice-only, or voice+visual products. The reference stack (CAST/ATR/MCE/SYNC above) is the first configuration of these contracts. Full interface documentation: [`sdk/INTERFACES.md`](sdk/INTERFACES.md); domain specifications: [`../domains/`](../domains/README.md).

| Spec ID | Feature | Technical Implementation | Edge Case & Remediation |
|---|---|---|---|
| CK-01 | Interface-over-implementation contracts | Nine typed contracts in `contracts/src`: `MemoryInterface`, `ModelInterface`, `ReasoningInterface`, `SpeechInterface`, `VisionInterface`, `ToolInterface`, `PlanningInterface`, `KnowledgeConnectorInterface`, plus the runtime contracts. The package imports no vendor SDK, DB driver, or model runtime; adapters do. | Vendor lock-in pressure ("just import the SDK, it's easier") → CI forbids runtime dependencies in `@moolam/contracts` entirely; adapters live in separate packages. |
| CK-02 | Pluggable memory (vector or graph) | `MemoryInterface` with kind-aware decay (`correction` never decays), durable `remember`, multi-tenant `subjectId` scoping, and an `associate()` edge surface that graph stores implement and vector stores may no-op. | Store migration (vector → graph) mid-deployment → the contract carries `relatedIds` on items, so a replaying export/import preserves associations; dimension/epoch locks reject mixed-embedding corpora. |
| CK-03 | Provider-agnostic models with locality | `ModelInterface` declares `locality: on-device / self-hosted / external-api` in its descriptor; deployments gate which localities may see which data classes. Streaming yields deltas; embedding dimension is stable per instance. | Provider silently proxies "self-hosted" traffic to an external API → conformance suite includes network-isolation tests; a descriptor caught lying fails certification (Stage 1 criterion). |
| CK-04 | Auditable reasoning | `ReasoningInterface.deliberate()` returns conclusion + mandatory `steps` trace + `unresolvedConstraints`. Empty traces are contract violations. Uncited evidence is inadmissible by contract policy. | Latency pressure tempts implementations to skip tracing → `effort: "fast"` permits shallower traces, never empty ones; the trace is the product in regulated domains, not overhead. |
| CK-05 | Voice as a first-class modality | `SpeechInterface` streams partial transcripts (`isFinal: false`) with word-level confidence (the voice analogue of friction), declares `supportedLanguages`, and synthesizes with rate control. Indic languages are first-class targets. | Utterance in an undeclared language → the core routes to a fallback provider rather than failing; voice-only users cannot read an error message. |
| CK-06 | Visual understanding seam | `VisionInterface.analyze()` takes bytes + instruction + optional JSON Schema; returns answer, located regions, confidence. General VLMs and specialist backends (OCR, DICOM, CAD) bind identically. | Oversized/corrupt input → typed rejection above `maxInputBytes`, never silent downscaling; a downscaled schematic or scan is corrupted evidence. |
| CK-07 | Risk-classed, audited tools | `ToolDescriptor.riskClass` drives execution policy: `read`/`compute` auto-execute, `write` requires policy approval, `critical` requires human approval. Write-ahead audit for mutating classes; argument validation returns typed errors; deadlines are mandatory. | Model emits a malformed or dangerous tool call → schema validation returns `status: "error"` (never throws); a denied `critical` call is still audit-logged as an attempt. |
| CK-08 | Cyclic planning | `PlanningInterface` composes goal graphs (prerequisites + success criteria) and `revise()` may route BACK to earlier goals when evidence invalidates a foundation - the loop-back generalized to case prep, differentials, and design review. Every revision updates `rationale`. | Oscillating plans under noisy evidence → implementations inherit the hysteresis pattern from ATR-02 (separate advance/retreat thresholds); silent plan mutation is a contract violation. |
| CK-09 | Citation-bearing knowledge | `KnowledgeConnectorInterface` returns passages with resolvable `citation` and truthful `asOf` dates; `bundled-offline` sources MUST answer when disconnected; staleness is a reasoning input. | Connector cannot resolve a citation for a passage → the passage is dropped, not emitted uncited; degraded-but-cited beats complete-but-unattributable. |
| CK-10 | Composition & refusal boundaries | `CognitiveCore` (`@moolam/cognitive-core`) wires the loop (perceive → recall → retrieve → reason → respond → reflect) from an `AgentProfile` (charter, refusals, languages) plus one binding per contract; speech/vision optional. Refusals are configuration checked by the reasoning layer, not prompt hope. | Domain scope creep (a legal-aid agent asked for medical advice) → refusals enter `deliberate()` as constraints; violations surface in `unresolvedConstraints` and the core declines rather than answers. |

---

## Cross-cutting non-functional requirements

| Spec ID | Requirement | Target |
|---|---|---|
| NFR-01 | Edge first-token latency (on-device SLM, mid-range Android) | ≤ 1.5s p95 |
| NFR-02 | Offline operation horizon with zero degradation of CAST capture | unbounded (storage-limited) |
| NFR-03 | Sync convergence after reconnect (1k pending samples) | ≤ 10s p95 end-to-end |
| NFR-04 | Cloud `/v1/agent/turn` routing overhead (excluding LLM generation) | ≤ 50ms p95 |
| NFR-05 | Deployment sovereignty | fully self-hostable from `infra/`; zero third-party services on the user-data path |
| NFR-06 | Core composition overhead (loop excluding bound-implementation time) | ≤ 10ms p95 per turn |
| NFR-07 | Voice round-trip on-device (final transcript → first synthesized audio, mid-range Android) | ≤ 2.5s p95 |
| NFR-08 | Domain configuration surface (new agent from existing bindings) | profile + connectors + tools + task graphs only; zero platform code changes |
