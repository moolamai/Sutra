# @moolam/telemetry

Cognitive friction sensing. The collector folds raw interaction events (prompt rendered, input, deletions, assistance requests, submission) into one `FrictionSample` per task: hesitation latency, input velocity, revision churn, assistance count, outcome. Friction is the platform's leading evidence signal (correctness is lagging); these samples drive mastery posteriors and task routing.

Shared by design: the edge host records friction on-device, and cloud components consume the same sample shape. Raw keystroke content never leaves the device; samples carry behavioral metadata only.

## Architecture

- `src/collector.ts`: `CognitiveTelemetryCollector` with a write-ahead SQLite insert before acknowledgment (a killed app never loses an acknowledged sample; a half-observed task is discarded by design, since partial evidence poisons the posterior).
- Persistence goes through the `StorageDriver` contract, so any SQLite binding (expo-sqlite, better-sqlite3, wa-sqlite) or in-memory driver works.
- Spec: PRD CAST-01 and CAST-02.

## Public API

`CognitiveTelemetryCollector`, `InteractionEvent`, `FrictionSample` and supporting types, exported from `src/index.ts`.

## Quick start

```ts
import { CognitiveTelemetryCollector } from "@moolam/telemetry";

const telemetry = new CognitiveTelemetryCollector(storageDriver, hlcClock);
await telemetry.initialize();

telemetry.observe({ type: "prompt-rendered", conceptId: "math.fractions", atMs: Date.now() });
telemetry.observe({ type: "input", atMs: Date.now(), charsDelta: 12 });
telemetry.observe({ type: "submitted", atMs: Date.now(), outcome: "correct" });
// `submitted` finalizes the FrictionSample and persists it write-ahead
```

## Contributing notes

- Sample semantics are protocol surface: changing what a field means requires the same change in the cloud's interpretation and a PRD update.
- Privacy invariant: no raw content in samples, ever. New fields must be behavioral metadata.

## Examples

`examples/offline-edge/` shows friction capture inside a full offline turn.

## Tests

```bash
pnpm --filter @moolam/telemetry test
```
