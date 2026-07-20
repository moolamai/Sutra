# EventBus catalog — implementor reference

Domain events on `EventBusInterface` answer **what happened** (turn stages, sync
outcomes, tools, SYNC-06 advisories). OpenTelemetry spans answer **how long /
where**. This catalog is the contract Track B metering and trajectory capture
subscribe to — hosts must not invent parallel event streams.

| | |
|---|---|
| **Catalog version** | `1.3.0` (`EVENT_CATALOG_VERSION`) |
| **Zod source** | [`../src/event_catalog.ts`](../src/event_catalog.ts) |
| **JSON Schema** | [`../../sync-protocol/schemas/Event*.json`](../../sync-protocol/schemas/) via `pnpm --filter @moolam/sync-protocol schemas:export` |
| **Publish API** | `createValidatingEventBus()` (throw in tests; drop+counter in production) |

**Privacy rule (hard):** every payload is a metadata allow-list — ids, codes,
durations, hashes, folded friction summaries. Never utterance, reply, advisory
`detail` text, tool arguments, friction keystroke streams, or mastery blobs.

**Timestamps:** `at` is ISO-8601 (`…Z` / offset) **or** HLC
(`NNNNNNNNNNNNNNN:CCCCCC:deviceId`). Totally ordered per emitter.

**Synthetic ids in examples** (`anika-k`, `sess-1`, `edge-aaaa`) are fixtures —
never production learner content.

---

## Publishing (hosts)

Bare `InProcessEventBus` remains untyped (tests / legacy). Production and
catalog-aware hosts should wrap:

```ts
import { createValidatingEventBus } from "@moolam/observability";

const bus = createValidatingEventBus(); // mode from NODE_ENV / MOOLAM_EVENT_BUS_VALIDATE
bus.publish({
  type: "sync.outcome",
  at: new Date().toISOString(),
  payload: {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    syncAttemptId: "11111111-1111-4111-8111-111111111111",
    outcome: "converged",
    attempts: 1,
  },
});
```

- **Unknown types** → rejected (`catalog.unknown-type`).
- **Learner keys** (`utterance`, `detail`, `arguments`, …) → rejected.
- **Subscriber throws** → isolated; bus emits `runtime.subscriber-error` (never
  loses the original accepted event for other subscribers).

---

## Catalogue

### `turn.stage.start`

| | |
|---|---|
| **Trigger** | A cognitive turn stage begins (`perceive`…`reflect`) under turn instrumentation. |
| **Payload** | `subjectId`, `sessionId`, `stage`, `opCode`; optional `deviceId`. |
| **Privacy** | Stage name + ids only — no utterance / prompt. |
| **JSON Schema** | `EventTurnStageStart.json` |

```json
{
  "type": "turn.stage.start",
  "at": "2026-07-15T10:00:00.000Z",
  "payload": {
    "subjectId": "anika-k",
    "sessionId": "sess-1",
    "deviceId": "edge-aaaa",
    "stage": "reason",
    "opCode": "stage.reason"
  }
}
```

### `turn.stage.end`

| | |
|---|---|
| **Trigger** | A turn stage completes (`outcome: ok`) or fails (`outcome: error`). |
| **Payload** | Same as start + `outcome` (`ok` \| `error`); optional `durationMs`. |
| **Privacy** | Status / duration only — error messages must not embed learner text. |
| **JSON Schema** | `EventTurnStageEnd.json` |

```json
{
  "type": "turn.stage.end",
  "at": "2026-07-15T10:00:00.042Z",
  "payload": {
    "subjectId": "anika-k",
    "sessionId": "sess-1",
    "deviceId": "edge-aaaa",
    "stage": "reason",
    "opCode": "stage.reason",
    "outcome": "ok",
    "durationMs": 12.5
  }
}
```

### `turn.friction.summary`

| | |
|---|---|
| **Trigger** | Host publishes a **folded** FrictionSample summary for metering (never per-keystroke). |
| **Payload** | `subjectId`, `sessionId`, `conceptId`, `sampleCount`; optional `hesitationMsP95`, `assistanceRequestedCount`, `deviceId`. |
| **Privacy** | Raw friction input events and utterances **never** cross the bus — only this compact summary. |
| **JSON Schema** | `EventTurnFrictionSummary.json` |

```json
{
  "type": "turn.friction.summary",
  "at": "000001700000000:000001:edge-aaaa",
  "payload": {
    "subjectId": "anika-k",
    "sessionId": "sess-1",
    "conceptId": "math.ratios",
    "sampleCount": 3,
    "hesitationMsP95": 820,
    "assistanceRequestedCount": 0
  }
}
```

### `turn.completed`

| | |
|---|---|
| **Trigger** | EdgeAgent (or host) finishes a durable on-device turn — friction folded, reply ready. |
| **Payload** | `subjectId`, `conceptId`, `latencyMs`, `servedLocally`, `turnIdHash`; optional `sessionId`, `deviceId`. |
| **Privacy** | Never utterance or reply text. Publishers hash an opaque `turnId` before emitting. |
| **JSON Schema** | `EventTurnCompleted.json` |

```json
{
  "type": "turn.completed",
  "at": "2026-07-15T10:00:01.200Z",
  "payload": {
    "subjectId": "anika-k",
    "sessionId": "sess-1",
    "deviceId": "edge-aaaa",
    "conceptId": "math.ratios",
    "latencyMs": 42,
    "servedLocally": true,
    "turnIdHash": "f1e2d3c4b5a69788"
  }
}
```

### `sync.outcome`

| | |
|---|---|
| **Trigger** | A `SyncEngine.synchronize()` series reaches a terminal state. |
| **Payload** | `subjectId`, `deviceId`, `syncAttemptId`, `outcome` (`converged` \| `quarantined` \| `exhausted` \| `skipped-offline`), `attempts`; optional `durationMs`, reason codes, `httpStatus`, `advisoryCodes` (SYNC-06 codes only). |
| **Privacy** | Outcome codes only — never CRDT shards or rejected bodies. Advisory **detail** text is forbidden; codes only. |
| **JSON Schema** | `EventSyncOutcome.json` |

```json
{
  "type": "sync.outcome",
  "at": "2026-07-15T10:01:00.000Z",
  "payload": {
    "subjectId": "anika-k",
    "deviceId": "edge-aaaa",
    "syncAttemptId": "11111111-1111-4111-8111-111111111111",
    "outcome": "converged",
    "attempts": 1,
    "durationMs": 18,
    "advisoryCodes": ["CLOCK_SKEW_CLAMPED"]
  }
}
```

### `sync.advisory`

| | |
|---|---|
| **Trigger** | SYNC-06 advisory emitted during merge / sync (known codes only). |
| **Payload** | `subjectId`, `deviceId`, `syncAttemptId`, `advisoryCode`; optional `advisoryIndex`, `hlcTimestamp` (lifted HLC, never detail text). |
| **Privacy** | Wire advisory `detail` strings are **forbidden** on the bus — codes + ids only. |
| **JSON Schema** | `EventSyncAdvisory.json` |

Codes: `CLOCK_SKEW_CLAMPED`, `DUPLICATE_SAMPLE_DROPPED`,
`UNKNOWN_CONCEPT_QUARANTINED`, `STATE_VECTOR_REGRESSION`, `DEPRECATED_FIELD_PRESENT`.

```json
{
  "type": "sync.advisory",
  "at": "2026-07-15T10:01:00.010Z",
  "payload": {
    "subjectId": "anika-k",
    "deviceId": "edge-aaaa",
    "syncAttemptId": "11111111-1111-4111-8111-111111111111",
    "advisoryCode": "CLOCK_SKEW_CLAMPED",
    "advisoryIndex": 0,
    "hlcTimestamp": "000001700000000:000002:edge-aaaa"
  }
}
```

### `tool.invoked`

| | |
|---|---|
| **Trigger** | Host / act-stage begins a tool call. |
| **Payload** | `subjectId`, `sessionId`, `toolIdHash`, `opCode`; optional `deviceId`. |
| **Privacy** | Tool **names are hashed** — argument bodies never accepted. |
| **JSON Schema** | `EventToolInvoked.json` |

```json
{
  "type": "tool.invoked",
  "at": "2026-07-15T10:02:00.000Z",
  "payload": {
    "subjectId": "anika-k",
    "sessionId": "sess-1",
    "toolIdHash": "a1b2c3d4e5f67890",
    "opCode": "tool.invoked"
  }
}
```

### `tool.result`

| | |
|---|---|
| **Trigger** | Tool call finishes. |
| **Payload** | Same as invoked + `status` (`ok` \| `error` \| `timeout` \| `denied`); optional `durationMs`. |
| **Privacy** | Status / duration only — never tool output text. |
| **JSON Schema** | `EventToolResult.json` |

```json
{
  "type": "tool.result",
  "at": "2026-07-15T10:02:00.030Z",
  "payload": {
    "subjectId": "anika-k",
    "sessionId": "sess-1",
    "toolIdHash": "a1b2c3d4e5f67890",
    "opCode": "tool.result",
    "status": "ok",
    "durationMs": 28
  }
}
```

### `harness.meter`

| | |
|---|---|
| **Trigger** | Per-turn metering snapshot (also carried as `METER_TICK.tick` on the stream). |
| **Payload** | `subjectId` + MeterEvent fields (`inputTokens`, `outputTokens`, `cachedInputTokens`, `latencyMs`, `modelId`, `locality`, `aborted`); optional `sessionId` / `deviceId`. |
| **Privacy** | Token / latency / locality metadata only — never prompt or completion text. Cached and fresh input tokens stay separate. |
| **JSON Schema** | `EventHarnessMeter.json` |

```json
{
  "type": "harness.meter",
  "at": "2026-07-15T10:02:00.040Z",
  "payload": {
    "subjectId": "anika-k",
    "sessionId": "sess-1",
    "deviceId": "edge-aaaa",
    "inputTokens": 12,
    "outputTokens": 4,
    "cachedInputTokens": 2,
    "latencyMs": 35,
    "modelId": "slm-local",
    "locality": "on-device",
    "aborted": false
  }
}
```

### `runtime.subscriber-error`

| | |
|---|---|
| **Trigger** | A subscriber threw while handling another event (`InProcessEventBus` isolation). |
| **Payload** | `sourceType` (the event type being handled), `error` (stringified cause, bounded). |
| **Privacy** | Must not copy learner payload fields into `error`. |
| **JSON Schema** | `EventRuntimeSubscriberError.json` |

```json
{
  "type": "runtime.subscriber-error",
  "at": "2026-07-15T10:03:00.000Z",
  "payload": {
    "sourceType": "turn.stage.end",
    "error": "Error: subscriber boom"
  }
}
```

---

## Edge cases implementors must handle

1. **Subscriber throws** — other subscribers still receive the original event;
   isolation surfaces as `runtime.subscriber-error`, not a lost publish.
2. **High-frequency friction** — publish `turn.friction.summary` only; raw
   `friction.*` sample streams are not catalog types and must not be invented.
3. **Replay / idempotency** — re-publishing the same valid catalog event is
   allowed (at-least-once); validators must not treat duplicates as schema failures.
4. **Subject isolation** — every payload that carries cognitive context includes
   `subjectId`; cross-subject subscription filtering is a host/metering concern,
   never silent content mixing.

---

## Forbidden payload keys

Do not publish (or accept) these on any catalog event:

`utterance`, `reply`, `detail`, `text`, `content`, `prompt`, `arguments`,
`frictionLog`, `mastery`.

---

## Related

- Validating bus: `@moolam/observability` `createValidatingEventBus`
- Registry keys: `@moolam/contracts` `CATALOG_EVENT_TYPES`
- Runtime bus: `@moolam/runtime` `InProcessEventBus` / `ValidatingEventBus`
- Wire SyncAdvisory codes (detail allowed on **wire**, never on EventBus):
  [`../../sync-protocol/docs/advisory-surface.md`](../../sync-protocol/docs/advisory-surface.md)
