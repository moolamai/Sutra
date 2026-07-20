# Sutra STRIDE threat model

| Meta | Value |
|------|-------|
| **Spec** | SEC-01 |
| **Phase** | P7 — Production hardening and 1.0 |
| **Status** | Trust boundary inventory + STRIDE enumeration complete |
| **Diagrams** | [`security/diagrams/`](./diagrams/README.md) |

Sovereign cognitive infrastructure spans four distinct trust surfaces: the on-device edge turn loop, the self-hosted cloud agent and sync host, the sync wire between them, and the tool sandbox seam inside the act stage. This document inventories every named boundary crossing, classifies data as **metadata** or **content**, assigns at least one primary **STRIDE** category per crossing, and enumerates threats with mitigations linked to regression tests (see [STRIDE enumeration](#stride-enumeration)).

## Data classification

| Class | Definition | Sovereignty rule |
|-------|------------|------------------|
| **metadata** | Identifiers (`subjectId`, `deviceId`, `correlationId`), protocol version, HLC timestamps, friction telemetry (hesitation, velocity, outcome codes), routing mode, audit hashes, meter ticks, structured event outcomes | May cross sync and telemetry paths when the deployment declares the locality boundary |
| **content** | Learner utterances, model prompts/replies, charter text, tool arguments and results, memory recall bodies | Stays within the declared locality (`on-device` or `self-hosted`); never echoed into cross-boundary telemetry in plaintext |

Model output and wire payloads are **untrusted input** — every crossing into platform code validates at the boundary (parse, never cast).

## Observability contract

Structured events at boundaries carry `subjectId`, `deviceId` (when applicable), and a typed `outcome` / `failureClass`. Raw learner content is never logged in plaintext.

| Event family | Example `event` | Fields (metadata only) |
|--------------|-----------------|------------------------|
| Edge turn | `cognitive_core.tool_stage`, catalog `turn.completed` | `subjectId`, `deviceId`, `outcome`, `failureClass` |
| Cloud sync | `sync ok` (log), OpenTelemetry sync spans | `subject_id`, `device_id`, `samples`, `advisories`, `outcome` |
| Tool policy | `cognitive_core.tool_policy` | `subjectId`, `sessionId`, `toolName`, `route`, `outcome` |
| Streaming | `StreamingTurnEmitRejected` | `failure_class`, `subject_id`, `issue_path` |

## Data-flow diagrams

| Surface | Diagram | Code anchors |
|---------|---------|--------------|
| Edge turn loop | [`diagrams/edge-turn-loop.mmd`](./diagrams/edge-turn-loop.mmd) | `packages/edge-agent/src/edge_agent.ts`, `packages/cognitive-core/src/harness.ts` |
| Cloud agent / sync host | [`diagrams/cloud-agent-sync-path.mmd`](./diagrams/cloud-agent-sync-path.mmd) | `packages/cloud-orchestrator/src/sutra_orchestrator/agent_runtime.py`, `sync_service.py`, `auth.py` |
| Sync wire | [`diagrams/sync-wire.mmd`](./diagrams/sync-wire.mmd) | `packages/sync-protocol/src/contract.ts`, `sync_engine.ts`, `harness_frames.ts` |
| Tool sandbox seam | [`diagrams/tool-sandbox-seam.mmd`](./diagrams/tool-sandbox-seam.mmd) | `packages/cognitive-core/src/tool_stage.ts`, `tool_policy.ts`, `tool_audit.ts`, `packages/sync-protocol/src/tool_envelope.ts` |

Architecture overview figures (package layers, cognitive pipeline) remain in [`docs/architecture/`](../docs/architecture/README.md).

---

## Trust boundary inventory

Each row is a named crossing (`TB-*`). **STRIDE** letters: **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of service, **E**levation of privilege.

### Surface 1 — Edge turn loop (`edge-turn`)

| Crossing ID | From → To | Classification | STRIDE | Notes |
|-------------|-----------|----------------|--------|-------|
| `TB-EDGE-01` | host app → `EdgeAgent.agentTurn` | content (local) | S, I | Utterance enters on-device locality only |
| `TB-EDGE-02` | `EdgeAgent` → `CognitiveCore.turn` | content + metadata (`subjectId`, `sessionId`) | S, T | `subjectId` required — cross-subject is a defect |
| `TB-EDGE-03` | `CognitiveCore` → `MemoryInterface` recall/remember | content (local store) | I, T | Subject-scoped memory lock on edge |
| `TB-EDGE-04` | `CognitiveCore` → `ModelInterface.generate` | content (prompt/messages) | I, T | Charter + utterance stay on-device |
| `TB-EDGE-05` | model output → `runActStage` envelope parse | content (untrusted) | T, E | Fenced JSON validated before invoke |
| `TB-EDGE-06` | act stage → tool policy seam | content + metadata | E, T | All invokes through `invokeThroughToolPolicy` |
| `TB-EDGE-07` | `CognitiveCore` / `EdgeAgent` → `EventBus` | metadata | I | Never publish reply text on the bus |
| `TB-EDGE-08` | `EdgeAgent` → `foldFriction` (durable) | metadata | T, R | Friction samples only; no utterance bodies |
| `TB-EDGE-09` | `turnChain` serializer (per-instance) | metadata | T, D | Serializes concurrent `agentTurn` RMW per subject |
| `TB-EDGE-10` | local state → pre-sync `CognitiveState` | metadata + structured state | I, T | No raw keystroke/utterance on wire (see sync surface) |

### Surface 2 — Cloud agent / sync host (`cloud-agent`)

| Crossing ID | From → To | Classification | STRIDE | Notes |
|-------------|-----------|----------------|--------|-------|
| `TB-CLOUD-01` | HTTP client → auth middleware | metadata (credentials) | S, I | Credentials never reach handlers — `CallerContext` only |
| `TB-CLOUD-02` | auth → `AgentRuntime` / handlers | metadata (`subjectId` scope) | S, E | Bounded scope tables; operator `*` is explicit |
| `TB-CLOUD-03` | `AgentRuntime` → `MasterStateStore.get_state` | metadata + cognitive state | I, T | Load scoped by `subjectId` |
| `TB-CLOUD-04` | `AgentRuntime` → `TaskRouter` / `GraphPlanner` | metadata | T | Routing fields persisted under subject guard |
| `TB-CLOUD-05` | `AgentRuntime` → `ModelProvider.generate` | content (self-hosted) | I, T | Prompt assembly in cloud locality |
| `TB-CLOUD-06` | `StreamingTurnHost` → SSE client | metadata + bounded content deltas | I, D | Harness frames typed; `METER_TICK` metadata-only |
| `TB-CLOUD-07` | `AgentRuntime` → `MasterStateStore.put_state` | metadata + cognitive state | T, R | Durable write after routing/plan attachment |
| `TB-CLOUD-08` | stream emitter subject guard | metadata | S, E | `cross_subject` rejection on forged `subjectId` |

### Surface 3 — Sync wire (`sync-wire`)

| Crossing ID | From → To | Classification | STRIDE | Notes |
|-------------|-----------|----------------|--------|-------|
| `TB-SYNC-01` | edge `SyncEngine` → `POST /v1/sync` | metadata envelope + `CognitiveState` | I, T | `SyncRequest` validated at boundary |
| `TB-SYNC-02` | TLS / HTTP transport | metadata (headers, traceparent) | I, T | Deployment TLS terminates here |
| `TB-SYNC-03` | wire bytes → parse `SyncRequest` | metadata + validated state | T, E | Zod (TS) / Pydantic (Python) — parse, never cast |
| `TB-SYNC-04` | `SyncService` → `subject_guard` | metadata | S, T | Per-subject serialization |
| `TB-SYNC-05` | CRDT `merge_states` (edge + master) | metadata + friction/mastery | T, D | Join idempotent; bounded friction log |
| `TB-SYNC-06` | merged state → repository `put_state` | metadata + cognitive state | T, R | Transactional with sync audit |
| `TB-SYNC-07` | `SyncResponse` → edge apply | metadata + merged state | T | Edge applies converged document locally |
| `TB-SYNC-08` | `sync_audit` append | metadata | R, I | Advisories verbatim; no utterance content |

### Surface 4 — Tool sandbox seam (`tool-sandbox`)

| Crossing ID | From → To | Classification | STRIDE | Notes |
|-------------|-----------|----------------|--------|-------|
| `TB-TOOL-01` | model text → `parseToolCallEnvelope` | content (untrusted) | T, E | Closed error enum; strips unknown keys |
| `TB-TOOL-02` | envelope → `authorizeToolInvocation` | content + metadata | E, S | `riskClass` routing table |
| `TB-TOOL-03` | write/critical → host approval hooks | metadata | E, R | Default deny without hook |
| `TB-TOOL-04` | write-ahead → `AuditSink` | metadata (hashed args) | R, I | `hashToolArguments` — no raw arg bodies in audit |
| `TB-TOOL-05` | policy → `ToolInterface.invoke` | content (sandboxed) | E, I | Host implements sandbox; deadline bounded |
| `TB-TOOL-06` | tool result → model message list | metadata + bounded content | I, T | Structured tool role messages |
| `TB-TOOL-07` | missing `riskClass` → fail-safe write | metadata | E | `TOOL.POLICY_RISK_ASSUMED_WRITE` |
| `TB-TOOL-08` | tool context `subjectId` guard | metadata | S, E | Mismatched subject rejected at policy layer |

---

## STRIDE enumeration

Per-surface threat tables: **Threat** description, **Mitigation** in platform code, **Test link** (existing regression file), **Status**. Prose-only mitigations are rejected — every `mitigated` row must resolve to a test file that exists in the repo.

### Surface 1 — Edge turn loop (`edge-turn`)

| Threat ID | Crossing | STRIDE | Threat | Mitigation | Test link | Status |
|-----------|----------|--------|--------|------------|-----------|--------|
| `TH-EDGE-001` | `TB-EDGE-02` | S | Forged or empty `subjectId` routes a turn to the wrong learner | Require non-empty trimmed `subjectId` at plan stage and `EdgeAgent` config | `packages/cognitive-core/tests/plan_stage_integration.test.mjs` | mitigated |
| `TH-EDGE-002` | `TB-EDGE-03` | I | Cross-subject memory recall leaks another learner's stored items | Per-subject memory lock; recall results filtered by `subjectId` | `packages/edge-agent/tests/local_vector_memory.test.mjs` | mitigated |
| `TH-EDGE-003` | `TB-EDGE-05` | T, E | Adversarial model output injects arbitrary tool calls | Parse fenced JSON envelope; reject invalid with typed `ToolStageError` | `packages/cognitive-core/tests/act_stage_integration.test.mjs` | mitigated |
| `TH-EDGE-004` | `TB-EDGE-07` | I | Assistant reply text published on `EventBus` | Catalog `turn.completed` emits metadata only; privacy golden turn suite | `packages/cognitive-core/tests/privacy_golden_turn.test.mjs` | mitigated |
| `TH-EDGE-005` | `TB-EDGE-09` | T, D | Concurrent `agentTurn` races mastery/friction RMW | `turnChain` serializes turns per instance; `SessionPlanGate` on plan stage | `packages/edge-agent/tests/edge_agent_turn_completed.test.mjs` | mitigated |
| `TH-EDGE-006` | `TB-EDGE-08` | T, R | Partial turn failure still folds friction or emits completion | Fold friction and emit `turn.completed` only after successful `core.turn` | `packages/edge-agent/tests/edge_agent_turn_completed.test.mjs` | mitigated |

### Surface 2 — Cloud agent / sync host (`cloud-agent`)

| Threat ID | Crossing | STRIDE | Threat | Mitigation | Test link | Status |
|-----------|----------|--------|--------|------------|-----------|--------|
| `TH-CLOUD-001` | `TB-CLOUD-01` | S, I | Stolen or missing credentials access cloud API | Pluggable `AuthVerifier`; credentials never reach handlers | `packages/cloud-orchestrator/tests/test_reference_verifiers.py` | mitigated |
| `TH-CLOUD-002` | `TB-CLOUD-02` | S, E | Caller requests another subject's turn or state | `subjectId` scope enforcement on every handler | `packages/cloud-orchestrator/tests/test_subject_scope_enforcement.py` | mitigated |
| `TH-CLOUD-003` | `TB-CLOUD-03` | T, I | Cross-subject state write via mismatched `subjectId` | `MasterStateStore` `expected_subject_id` guard | `packages/cloud-orchestrator/tests/test_postgres_master_state_repository.py` | mitigated |
| `TH-CLOUD-004` | `TB-CLOUD-06` | I, D | Unbounded SSE stream exhausts client or proxy | `STREAMING_TURN_MAX_FRAMES` budget; typed `stream_budget_exceeded` | `packages/runtime-harness/tests/streaming_turn_host_emitter.test.mjs` | mitigated |
| `TH-CLOUD-005` | `TB-CLOUD-08` | S, E | Forged `subjectId` on harness frame crosses streams | `StreamingTurnHost` `cross_subject` rejection | `packages/cloud-orchestrator/tests/test_agent_turn_stream.py` | mitigated |
| `TH-CLOUD-006` | `TB-CLOUD-05` | D | Model provider hang blocks worker indefinitely | `generate` deadline → `ModelProviderTimeoutError` | `packages/cloud-orchestrator/tests/test_model_provider.py` | mitigated |

### Surface 3 — Sync wire (`sync-wire`)

| Threat ID | Crossing | STRIDE | Threat | Mitigation | Test link | Status |
|-----------|----------|--------|--------|------------|-----------|--------|
| `TH-SYNC-001` | `TB-SYNC-03` | T, E | Malformed `SyncRequest` crashes merge or casts unsafely | Zod / Pydantic parse at wire boundary | `packages/sync-protocol/tests/golden_joins.test.mjs` | mitigated |
| `TH-SYNC-002` | `TB-SYNC-04` | S, T | Concurrent sync for same subject interleaves RMW | `subject_guard` serializes reconcile | `packages/cloud-orchestrator/tests/test_master_state_repository.py` | mitigated |
| `TH-SYNC-003` | `TB-SYNC-05` | T | Replay of identical `SyncRequest` double-applies friction | CRDT join idempotence | `packages/cloud-orchestrator/tests/test_restart_durability.py` | mitigated |
| `TH-SYNC-004` | `TB-SYNC-01` | I | Raw utterance bodies exfiltrate via sync wire | `CognitiveState` schema carries friction metadata only | `packages/sync-protocol/tests/deprecation_policy.test.mjs` | mitigated |
| `TH-SYNC-005` | `TB-SYNC-08` | R | Sync reconciliation repudiated after dispute | `sync_audit` append in same transaction as state write | `packages/cloud-orchestrator/tests/test_sync_audit_writer.py` | mitigated |
| `TH-SYNC-006` | `TB-SYNC-05` | D | Unbounded `frictionLog` exhausts merge hot path | Bounded arrays; metering budget counters | `packages/sync-protocol/tests/metering_budget.test.mjs` | mitigated |

### Surface 4 — Tool sandbox seam (`tool-sandbox`)

| Threat ID | Crossing | STRIDE | Threat | Mitigation | Test link | Status |
|-----------|----------|--------|--------|------------|-----------|--------|
| `TH-TOOL-001` | `TB-TOOL-01` | T, E | Invalid tool envelope silently skipped | Closed error enum; `ToolStageError` on invalid envelope | `packages/sync-protocol/tests/tool_envelope_errors.test.mjs` | mitigated |
| `TH-TOOL-002` | `TB-TOOL-02` | E | Auto-execute write-class tool without approval | `riskClass` routing; default deny without hook | `packages/cognitive-core/tests/tool_policy_risk_class.test.mjs` | mitigated |
| `TH-TOOL-003` | `TB-TOOL-03` | E, R | Write/critical effect before audit acknowledgment | Write-ahead audit `recordThenInvoke` | `packages/cognitive-core/tests/write_ahead_conformance.test.mjs` | mitigated |
| `TH-TOOL-004` | `TB-TOOL-04` | I | Raw tool arguments written to audit sink | `hashToolArguments` — metadata only in audit | `packages/cognitive-core/tests/tool_audit.test.mjs` | mitigated |
| `TH-TOOL-005` | `TB-TOOL-05` | E, D | Hung or oversize tool hangs act stage | Invoke deadline; sandbox seam payload limits | `packages/runtime-harness/tests/sandbox_seam.test.mjs` | mitigated |
| `TH-TOOL-006` | `TB-TOOL-07` | E | Missing `riskClass` treated as read (auto-execute) | Fail-safe assume write + `ToolPolicyError` | `packages/cognitive-core/tests/tool_policy.test.mjs` | mitigated |

---

## Edge-case coverage (inventory scope)

| Edge case | Relevant crossings | Regression anchor |
|-----------|-------------------|-------------------|
| Concurrent turns race on cognitive state RMW | `TB-EDGE-09`, `TB-CLOUD-04` | `packages/cognitive-core/tests/plan_stage_integration.test.mjs` (SessionPlanGate), `packages/edge-agent/tests/edge_agent_turn_completed.test.mjs` |
| Partial failure after durable side effect | `TB-EDGE-08`, `TB-CLOUD-07` | `packages/edge-agent/tests/edge_agent_turn_completed.test.mjs` (mid-turn throw emits no `turn.completed`) |
| Replayed sync payload must be idempotent | `TB-SYNC-05`, `TB-SYNC-06` | `packages/cloud-orchestrator/tests/test_master_state_repository.py`, `test_restart_durability.py` |
| Cross-subject access rejected | `TB-EDGE-02`, `TB-CLOUD-08`, `TB-TOOL-08` | `packages/runtime-harness/tests/streaming_turn_host_emitter.test.mjs`, `packages/cognitive-core/tests/plan_stage_integration.test.mjs` |

---

## Sovereignty and subject isolation

- Every read and write is scoped by `subjectId`; cross-subject access is a defect, not a feature gap.
- **Locality:** learner utterances and model prompts/replies remain in the declared boundary (`on-device` for edge turns, `self-hosted` for cloud turns). Sync carries structured cognitive state and friction **metadata**, not raw keystroke or utterance bodies.
- Wire and model outputs are validated at the boundary before use in platform code.

---

## Residual risk register

Explicitly accepted risks that are not fully mitigated in platform code. Each row names an owner and review date — never silently ignored.

| Risk ID | Related crossing | Status | Owner | Review date | Acceptance rationale |
|---------|------------------|--------|-------|-------------|----------------------|
| `RR-TLS-001` | `TB-SYNC-02` | accepted | Deployment operator | 2026-10-01 | TLS termination, cert rotation, and cipher policy are deployment-owned; platform documents HTTPS as production requirement; confirmed by external review finding `F-EXT-009` |
| `RR-HOST-TOOL-001` | `TB-TOOL-05` | accepted | Domain integrator | 2026-10-01 | Tool sandbox isolation depends on host `ToolInterface` implementation; B4 seam enforces deadlines and payload bounds only; confirmed by external review finding `F-EXT-008` |
| `RR-DEVICE-001` | `TB-EDGE-01` | accepted | Deployment operator | 2026-10-01 | Compromised on-device OS can read local learner content; out of platform threat boundary |

---

## Correlation

| Artifact | Role |
|----------|------|
| [`docs/architecture/README.md`](../docs/architecture/README.md) | Layered architecture and canonical TikZ figures |
| [`security/EXTERNAL-REVIEW.md`](./EXTERNAL-REVIEW.md) | External-equivalent review scope, independence rules, and findings register |
| CI `security-supply-chain` job (`.github/workflows/ci.yml`) | Mitigation-to-test link verification on every push/PR |

**Inventory gate:** `pnpm threat-model:inventory:check` — `scripts/check-threat-model-inventory.mjs`

**STRIDE gate:** `pnpm threat-model:stride:check` — `scripts/check-threat-model-stride.mjs`

**Red→green prove:** `node scripts/prove-threat-model-gate.mjs` — seeds a broken test link and a prose-only mitigation, asserts the gate goes red naming the offending threat ID and path, then restores the model byte-identical.
