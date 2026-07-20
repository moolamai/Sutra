# Metering contract — MeterEvent and BudgetHook

Normative rules for per-turn harness spend. Track B harness economics (B5)
and stranger hosts aggregate tokens from `MeterEvent` / `harness.meter` and
gate further generation through `BudgetHook` **before** overrun.

**Wire schema:** [`packages/sync-protocol/schemas/MeterEvent.json`](../../packages/sync-protocol/schemas/MeterEvent.json)
· EventBus: [`EventHarnessMeter.json`](../../packages/sync-protocol/schemas/EventHarnessMeter.json) (`harness.meter`)
· Zod/TS: `meterEventSchema` / `toBudgetMeterTick` / `invokeBudgetHook` in
`packages/sync-protocol/src/metering.ts`
· Contract: `BudgetHook` / `BUDGET_DECISIONS` in
`packages/contracts/src/budget.ts`
· Pydantic: `MeterEvent` / `parse_meter_event` in `sutra_orchestrator.contract_models`
· Golden meters: [`packages/sync-protocol/fixtures/wire-parity/meter-events.json`](../../packages/sync-protocol/fixtures/wire-parity/meter-events.json)

---

## 1. MeterEvent (metadata only)

Every accepted tick carries:

| Field | Rule |
|---|---|
| `inputTokens` | Fresh (non-cached) input tokens — never conflated with cache hits |
| `cachedInputTokens` | Cache-hit input tokens — separate channel for aggregation |
| `outputTokens` | Completion tokens emitted so far |
| `latencyMs` | Wall latency for the sampled window (non-negative int) |
| `modelId` | Opaque model identifier (metadata) |
| `locality` | `on-device` \| `self-hosted` \| `external-api` |
| `aborted` | `true` when the turn ended before a natural `TURN_COMPLETE` |

**Hard privacy rule:** never put prompt text, completion text, tool arguments,
or utterances on a meter tick. Unknown keys are rejected at the wire boundary
(`.strict()` / `extra=forbid`).

Ticks ride:

1. Stream frame `METER_TICK.tick` (see [`HARNESS-STREAM-SEMANTICS.md`](./HARNESS-STREAM-SEMANTICS.md))
2. EventBus `harness.meter` (subject-scoped catalog payload)

### Worked example — complete turn (golden fixture)

```json
{
  "inputTokens": 12,
  "outputTokens": 4,
  "cachedInputTokens": 2,
  "latencyMs": 35,
  "modelId": "slm-local",
  "locality": "on-device",
  "aborted": false
}
```

Field-wise totals keep channels distinct: billed input samples as
`inputTokens + cachedInputTokens` only when the host explicitly sums them;
aggregators must not collapse cache into `inputTokens`.

### Worked example — aborted partial turn

Partial turns after stream abort **still emit** a final MeterEvent with
`aborted: true` so spend is accounted:

```json
{
  "inputTokens": 8,
  "outputTokens": 1,
  "cachedInputTokens": 0,
  "latencyMs": 12,
  "modelId": "slm-local",
  "locality": "on-device",
  "aborted": true
}
```

---

## 2. BudgetHook — host throttling before overrun

```ts
import type { BudgetHook } from "@moolam/contracts";
// or: import type { BudgetHook } from "@moolam/sync-protocol";

const hook: BudgetHook = {
  onMeterTick(event) {
    // event.subjectId scopes all budget state
    if (overBudget(event.subjectId, event)) return "hardStop";
    if (nearLimit(event.subjectId, event)) return "throttle";
    return "allow";
  },
};
```

### Decision enum (closed)

| Decision | Host MUST |
|---|---|
| `allow` | Continue generation under current pacing |
| `throttle` | Continue but apply host-defined slowdown / load shed |
| `hardStop` | Stop further generation for this turn / budget window |

Hosts MUST NOT invent free-text decisions. Invalid returns are rejected by
`invokeBudgetHook` as `invalid_decision`.

### Binding MeterEvent → BudgetMeterTick

```ts
import {
  invokeBudgetHook,
  meterEventSchema,
  toBudgetMeterTick,
} from "@moolam/sync-protocol";

const meter = meterEventSchema.parse({
  inputTokens: 12,
  outputTokens: 4,
  cachedInputTokens: 2,
  latencyMs: 35,
  modelId: "slm-local",
  locality: "on-device",
  aborted: false,
});

const tick = toBudgetMeterTick(meter, {
  subjectId: "anika-k",
  deviceId: "edge-aaaa",
  sessionId: "sess-1",
});

const result = await invokeBudgetHook(hook, tick);
// → { outcome: "accepted", subjectId: "anika-k", decision: "allow" | "throttle" | "hardStop", aborted: false }
```

`toBudgetMeterTick` throws when `subjectId` is empty. `invokeBudgetHook`
returns `failureClass: "missing_subject"` for the same gap.

---

## 3. Sovereignty, concurrency, and idempotency

1. **Subject isolation** — budget counters, throttle state, and hard-stop
   flags are keyed by `subjectId` (and optionally `deviceId` / `sessionId`).
   Cross-subject sharing is a defect.
2. **Locality** — meter ticks declare locality; they never carry raw learner
   content across sovereignty boundaries.
3. **Concurrent turns** — hosts MUST serialize budget read-modify-write per
   `subjectId` (or use atomic increments). Two parallel turns for the same
   subject racing an in-memory counter without locking can overrun.
4. **Abort survival** — `aborted: true` ticks still invoke `onMeterTick`;
   spend is never silently dropped after a stream abort.
5. **Idempotent replay** — replaying the same accepted `METER_TICK` /
   `harness.meter` envelope must not double-apply budget. Prefer
   `(subjectId, correlationId, sequenceIndex)` or equivalent idempotency keys.
6. **Observability** — emit structured outcomes with `subjectId`, `deviceId`,
   and `decision` / `failureClass`. Never log prompt or completion bodies.

### Worked example — throttle near limit

```ts
const nearLimitHook: BudgetHook = {
  onMeterTick(event) {
    const fresh = event.inputTokens;
    const cached = event.cachedInputTokens;
    // Keep channels distinguishable when comparing to host budgets.
    if (fresh + cached >= 10_000) return "hardStop";
    if (fresh + cached >= 8_000) return "throttle";
    return "allow";
  },
};

await invokeBudgetHook(nearLimitHook, {
  subjectId: "anika-k",
  deviceId: "edge-aaaa",
  inputTokens: 100,
  outputTokens: 40,
  cachedInputTokens: 20,
  latencyMs: 420,
  modelId: "cloud-model",
  locality: "external-api",
  aborted: false,
});
// → decision: "allow" (120 ≪ 8000)
```

### Worked example — hardStop after abort still accounts spend

```ts
const accountingHook: BudgetHook = {
  onMeterTick(event) {
    recordSpend(event.subjectId, event); // always, including aborted
    if (event.aborted) return "hardStop";
    return "allow";
  },
};
```

---

## 4. Related

- Stream sequencing: [`HARNESS-STREAM-SEMANTICS.md`](./HARNESS-STREAM-SEMANTICS.md)
- Event catalog: [`packages/observability/docs/event-catalog.md`](../../packages/observability/docs/event-catalog.md) (`harness.meter`)
- Contracts overview: [`docs/sdk/INTERFACES.md`](../sdk/INTERFACES.md)
