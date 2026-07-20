# Changelog

## 1.1.0

### Patch Changes

- @moolam/contracts@1.1.0
- @moolam/observability@1.1.0

## 1.0.0

### Major Changes

- Protocol 1.0.0 freeze: independent certification (DIST-01) green, FP-002 closed, freeze RFC Accepted.

### Patch Changes

- Updated dependencies
  - @moolam/contracts@1.0.0
  - @moolam/observability@1.0.0

All notable changes to the Hybrid Cognitive Sync Protocol wire surface
(`@moolam/sync-protocol`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for the published package. Envelope JSON carries a separate `protocolVersion`
string (currently `"1.0.0"`); package versions here track the artifact consumers
install, while additive wire edits also bump that field per the RFC process.

Unreleased wire edits accumulate under **[Unreleased]** until a release cuts
them into a dated version section. Contributors must update `[Unreleased]` in
the same PR that changes Zod/Pydantic schemas or committed JSON Schema files
(see root `CONTRIBUTING.md` §9).

## [Unreleased]

### Added

- **`DEPRECATED_FIELD_PRESENT` SyncAdvisory** — emitted when a registered
  deprecated wire path is present on parse; `detail` carries `field=` and
  `sunset=` (never field values). Seeded test-only path
  `profile.__deprTestLegacyLocale` (sunset `2027-01-13`) proves emission via
  `parseCognitiveStateWithDeprecationAdvisories`.
- **`SyncRequest.headers`** (optional) — W3C Trace Context carrier
  (`traceparent`, `tracestate`) for edge→cloud sync span continuity.
  Metadata only; never learner content.
- **Event catalog JSON Schemas** — committed
  `EventTurnStageStart`, `EventTurnStageEnd`, `EventTurnFrictionSummary`,
  `EventTurnCompleted`, `EventSyncOutcome`, `EventSyncAdvisory`,
  `EventToolInvoked`, `EventToolResult`, `EventRuntimeSubscriberError`
  under `schemas/` via `schemas:export` (shared TS/Python audit wire shape;
  metadata allow-lists only, never utterance/detail bodies).
- **`HarnessFrame`** — streaming turn frame discriminated union
  (`SESSION_START`, `THOUGHT_DELTA`, `ANSWER_DELTA`, `TOOL_STATUS`,
  `ADVISORY_ATTACH`, `METER_TICK`, `TURN_COMPLETE`, `HARNESS_ERROR`).
  Every variant carries monotonic `sequenceIndex`, `correlationId`, and
  `subjectId`. Committed as `schemas/HarnessFrame.json` (Zod + Pydantic
  twin via `schemas:export`). Frames move typed cognition — never raw
  provider tokens; validation outcomes are metadata-only (no deltas in
  telemetry).
- **`ToolCallEnvelope` / `ToolEnvelopeError`** — fenced-JSON tool-call
  grammar (single object or bounded array) and closed repair-loop error
  payload. Committed as `schemas/ToolCallEnvelope.json` +
  `schemas/ToolEnvelopeError.json` with wire fixtures under
  `fixtures/tool-envelope/` (valid + one violation per error code).
  Unknown keys are stripped; correction-loop messages never include stack
  traces or argument bodies.
- **`MeterEvent`** (`metering.ts`) — per-turn metering snapshot
  (`inputTokens`, `outputTokens`, `cachedInputTokens`, `latencyMs`,
  `modelId`, `locality`, `aborted`). Bound as `METER_TICK.tick` payload;
  cached vs fresh input stay separate fields; metadata only (no prompt/
  completion text). Committed as `schemas/MeterEvent.json` (Zod +
  Pydantic twin) with dedicated fixtures under
  `fixtures/wire-parity/meter-events.json`.
- **`EventHarnessMeter` / `harness.meter`** — EventBus catalog envelope
  for subject-scoped MeterEvent metadata (`EVENT_CATALOG_VERSION` `1.3.0`).
  Committed as `schemas/EventHarnessMeter.json`.
- **`BudgetHook`** — host throttling seam (`onMeterTick` →
  `allow` \| `throttle` \| `hardStop`) in `@moolam/contracts`, with
  `toBudgetMeterTick` / `invokeBudgetHook` helpers and normative docs in
  [`docs/protocol/METERING.md`](../../docs/protocol/METERING.md).
- **`DegradationRegistry`** — closed modes `STALE_READ` /
  `HARD_STOP_WRITE` / `QUEUE_AND_WARN` with per-mode behavior specs and
  read-only `lookup(surface, operation)` (`degradation_registry.ts`).
  Fabrication and silent write retry are schema-forbidden. Committed as
  `schemas/DegradationRegistry.json` + `schemas/FreshnessMarker.json`
  with fixtures under `fixtures/degradation-registry/` and normative
  docs in [`docs/protocol/DEGRADATION-REGISTRY.md`](../../docs/protocol/DEGRADATION-REGISTRY.md).
  Stubbed-down dependency vectors (`DegradationStubVectorCatalog`) cover
  every `sync`/`storage`/`model` × `read`/`write` binding for B4 suites.
- **`FrictionAggregationRollup`** — subject-scoped friction aggregates
  (counts, rates, consent-bound) for learning-path locality; metadata only,
  never raw samples. Committed as `schemas/FrictionAggregationRollup.json`.
- **`TurnTrajectoryV1`** — bounded turn trajectory envelope for eval and
  replay parity (`schemas/TurnTrajectoryV1.json`); metadata allow-lists only.

### Changed

- **Protocol 1.0.0 freeze** — envelope `protocolVersion` and committed JSON
  Schema twins now stamp `x-protocol-version: "1.0.0"` on
  **`AgentTurnRequest`**, **`AgentTurnResponse`**, **`CognitiveState`**,
  **`ConceptMastery`**, **`FrictionSample`**, **`SyncAdvisory`**,
  **`SyncRequest`**, and **`SyncResponse`** (wire shapes unchanged; version
  metadata aligned with the frozen RFC baseline).
- **PROTOCOL_VERSION bump CI gate** — `pnpm protocol:version-bump` fails on
  wire-visible `schemas/` hash drift without a `PROTOCOL_VERSION` bump and
  `[Unreleased]` coverage; baseline lockfile is
  `schemas/wire-shape-baseline.json`. Prove path:
  `pnpm protocol:version-bump:prove`.

### Deprecated

### Removed

### Fixed

### Security

## [0.1.0] - 2026-07-15

Initial public baseline of the Hybrid Cognitive Sync Protocol. This release
documents the full initial wire surface as shipped with `@moolam/sync-protocol@0.1.0`
and the matching Python twin in `sutra_orchestrator.contract_models`.

Envelope `protocolVersion` on the wire is `"1.0.0"`.

### Added

#### State document

- **`CognitiveState`** — unit of sync per subject: identity (`subjectId`,
  `docVersion`, replica device + HLC), G-Counter mastery map, LWW session
  registers (active concept, guidance mode, directive), G-Set memory log,
  and LWW profile (track, language, preferences).

#### Sync envelopes

- **`SyncRequest`** — device → cloud: current replica document plus
  `syncAttemptId` for idempotent apply.
- **`SyncResponse`** — cloud → device: converged master document plus
  advisory list.
- **`SyncAdvisory`** — structured codes and payloads for what changed,
  what was refused, and migration hints (see `docs/advisory-surface.md`).

#### Cognitive telemetry samples

- **`FrictionSample`** — friction / struggle signal carried on turns and
  collected by the shared telemetry package.
- **`ConceptMastery`** — per-concept evidence counters (successes, failures,
  assists) merged as G-Counters.

#### Agent-turn envelopes

- **`AgentTurnRequest`** / **`AgentTurnResponse`** — cloud-hosted turn:
  friction sample and context in; guidance directive and related fields out.

#### Wire invariants (baseline contract)

- Hybrid Logical Clock timestamps on all mutable ordering fields (never raw
  wall clocks).
- Additive-only wire evolution: fields are not removed or repurposed.
- Committed JSON Schema artifacts under `schemas/` for the eight primary
  types above, kept in lockstep with Zod and Pydantic twins.
- Cross-language CRDT merge parity (TypeScript `crdt.ts` / Python
  `crdt_merge.py`) for the same fixture documents.

HTTP bindings that carry these envelopes (auth-gated in the reference cloud):
`POST /v1/sync`, `POST /v1/agent/turn`, `GET /v1/subjects/{id}/state`.

[Unreleased]: https://github.com/moolamai/Sutra/compare/sync-protocol-v0.1.0...HEAD
[0.1.0]: https://github.com/moolamai/Sutra/releases/tag/sync-protocol-v0.1.0
