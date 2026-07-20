# @moolam/telemetry

Cognitive friction sensing. The collector folds raw interaction events (prompt rendered, input, deletions, assistance requests, submission) into one `FrictionSample` per task: hesitation latency, input velocity, revision churn, assistance count, outcome. Friction is the platform's leading evidence signal (correctness is lagging); these samples drive mastery posteriors and task routing.

Shared by design: the edge host records friction on-device, and cloud components consume the same sample shape. Raw keystroke content never leaves the device; samples carry behavioral metadata only.

**Field pilot:** device matrix, offline bundle, **consent record shape**, write-ahead / `markSynced`, and sovereignty checklist — [`docs/pilot/FIELD-PILOT-KIT.md`](../../docs/pilot/FIELD-PILOT-KIT.md) (§5).

**Turn trajectories:** captured fields, forbidden content, consent and
subject-isolation procedure, and worked valid/rejected JSON —
[`docs/TRAJECTORY-METADATA-POLICY.md`](./docs/TRAJECTORY-METADATA-POLICY.md).

**Training export:** explicit consent-gated CLI, schema validation, failure
playbook, locality controls, and external LoRA handoff —
[`docs/sdk/training-export-runbook.md`](../../docs/sdk/training-export-runbook.md).

## Architecture

- `src/collector.ts`: `CognitiveTelemetryCollector` with a write-ahead SQLite insert before acknowledgment (a killed app never loses an acknowledged sample; a half-observed task is discarded by design, since partial evidence poisons the posterior).
- Persistence goes through the `StorageDriver` contract, so any SQLite binding (expo-sqlite, better-sqlite3, wa-sqlite) or in-memory driver works.
- Sync seam: `unsynced()` lists rows with `synced = 0`; after a successful cloud compaction, `markSynced(capturedAt[])` flips those rows — idempotent on replay.
- Spec: PRD CAST-01 and CAST-02.

## Consent gate (field pilot)

Operators must hold a per-`subjectId`×`deviceId` consent record (`field-pilot.consent.v1`) before persist/sync. Forbidden scopes for this pilot: `rawKeystrokeExport`, `utteranceExport`, `trajectoryExport`. See the kit §5 worked JSON example.

| Leaves device (only if `frictionSampleSync`) | Stays sovereign |
|-----------------------------------------------|-----------------|
| `FrictionSample` metadata columns | Keystrokes, utterance text, consent vault, half-open exercises |

## Public API

`CognitiveTelemetryCollector`, `InteractionEvent`, `FrictionSample` and supporting types, exported from `src/index.ts`.

Notable methods: `initialize`, `observe` / `submitted` (write-ahead), `unsynced`, `markSynced`, `durableSampleCount`, `castIntegrityProbe` (bounded aggregates — no unbounded `SELECT *`).

## Quick start

```ts
import { CognitiveTelemetryCollector } from "@moolam/telemetry";

const telemetry = new CognitiveTelemetryCollector(storageDriver, hlcClock);
await telemetry.initialize();

telemetry.observe({ type: "prompt-rendered", conceptId: "math.fractions", atMs: Date.now() });
telemetry.observe({ type: "input", atMs: Date.now(), charsDelta: 12 });
telemetry.observe({ type: "submitted", atMs: Date.now(), outcome: "correct" });
// `submitted` finalizes the FrictionSample and persists it write-ahead

const pending = await telemetry.unsynced();
await telemetry.markSynced(pending.map((s) => s.capturedAt));
```

## Contributing notes

- Sample semantics are protocol surface: changing what a field means requires the same change in the cloud's interpretation and a PRD update.
- Privacy invariant: no raw content in samples, ever. New fields must be behavioral metadata.
- Concurrent collectors for the same `subjectId` must not share mutable accumulators across devices.

## Examples

`examples/offline-edge/` shows friction capture inside a full offline turn.

## Tests

```bash
pnpm --filter @moolam/telemetry test
```
