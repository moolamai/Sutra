# Degradation registry — named dependency-failure behaviors

Normative rules for B4/B5 adapters when a dependency is down. Behavior is
**looked up**, never improvised per surface. The registry document ships with
the SDK and is **read-only at runtime** (not mutated per tenant or subject).

**Wire schema:** [`packages/sync-protocol/schemas/DegradationRegistry.json`](../../packages/sync-protocol/schemas/DegradationRegistry.json)
· Freshness marker: [`FreshnessMarker.json`](../../packages/sync-protocol/schemas/FreshnessMarker.json)
· Zod/TS: `degradationRegistrySchema` / `createDegradationRegistry` /
`lookup(surface, operation)` in `packages/sync-protocol/src/degradation_registry.ts`
· Contract: `DegradationRegistry` / `DEGRADATION_MODES` in
`packages/contracts/src/degradation.ts`
· Fixtures: [`packages/sync-protocol/fixtures/degradation-registry/`](../../packages/sync-protocol/fixtures/degradation-registry/)

---

## 1. Modes (closed enum)

| Mode | Read policy | Write policy | MUST |
|---|---|---|---|
| `STALE_READ` | `stale-with-marker` | hard-stop | Return last-known-good **with** `freshnessMarker`. **Never fabricate** data. |
| `HARD_STOP_WRITE` | unavailable | `hard-stop-rollback` | Refuse the write, roll back buffers, emit signal. **Silent write retry is forbidden.** |
| `QUEUE_AND_WARN` | unavailable | `queue-and-warn` | Bound the queue by `subjectId`, emit warning signal. Never catch-and-continue without a signal. |

Schema fields `allowsFabrication` and `allowsSilentWriteRetry` are **always
`false`** — any registry document that sets them true fails validation.

---

## 2. Read API

```ts
import {
  createDegradationRegistry,
  assertStaleReadPayload,
} from "@moolam/sync-protocol";

const registry = createDegradationRegistry(); // SDK default document
const result = registry.lookup("storage", "read", {
  subjectId: "anika-k",
  deviceId: "edge-aaaa",
});
// → { outcome: "accepted", behavior: { mode: "STALE_READ", signalCode: "DEGRADE_STALE_READ", ... } }
```

Lookup is subject-scoped for **telemetry** (`subjectId` required). Binding
tables themselves are SDK-global — not per-tenant.

Surfaces: `sync` · `storage` · `model`  
Operations: `read` · `write`

### Default bindings (fixture)

| Surface | Operation | Mode |
|---|---|---|
| storage | read | `STALE_READ` |
| storage | write | `HARD_STOP_WRITE` |
| sync | read | `STALE_READ` |
| sync | write | `HARD_STOP_WRITE` |
| model | read | `QUEUE_AND_WARN` |
| model | write | `HARD_STOP_WRITE` |

---

## 3. MUST behaviors per mode (B4 adapters)

### `STALE_READ`

1. Serve last-known-good **only** — never invent fields or synthesize mastery.
2. Attach a `freshnessMarker` (`capturedAt` + `source`: `last-known-good` |
   `local-cache`).
3. Emit `DEGRADE_STALE_READ` with `subjectId` / `deviceId` (metadata only).

```json
{
  "value": { "conceptId": "math.ratios" },
  "freshnessMarker": {
    "capturedAt": "000001700000000:000001:edge-aaaa",
    "source": "last-known-good"
  }
}
```

`assertStaleReadPayload` rejects `fabricated: true` and missing markers.

### `HARD_STOP_WRITE`

1. Refuse the write **before** durable side effects for that `subjectId`.
2. Rollback any in-flight local buffer for the operation.
3. Emit `DEGRADE_HARD_STOP_WRITE` — never silently retry the write.

### `QUEUE_AND_WARN`

1. Enqueue bounded work keyed by `subjectId` (no unbounded scans).
2. Emit `DEGRADE_QUEUE_AND_WARN` — never silent catch-and-continue.
3. Never fabricate a response body while queued.

---

## 4. Sovereignty, concurrency, idempotency

1. **Subject isolation** — signals and queues are keyed by `subjectId`;
   cross-subject mixing is a defect. Empty `subjectId` → lookup rejected.
2. **No learner content** on registry documents, markers, or signal payloads
   (`utterance` / `prompt` / `arguments` forbidden).
3. **Concurrent turns** — hosts serialize per-`subjectId` when applying
   hard-stop rollback or queue drains.
4. **Idempotent replay** — replaying the same degraded operation for the same
   subject must not double-apply rollback or double-enqueue (host idempotency keys).
5. **Observability** — distinct `signalCode` per mode; outcome classes
   (`accepted` / `rejected` + `failureClass`) are distinct signals.

---

## 5. Stubbed-down dependency test vectors (B4)

B4 integration suites force a dependency down and assert the registry outcome.
Canonical catalog:

[`packages/sync-protocol/fixtures/degradation-registry/stub-vectors.json`](../../packages/sync-protocol/fixtures/degradation-registry/stub-vectors.json)

Wire schema: [`DegradationStubVectorCatalog.json`](../../packages/sync-protocol/schemas/DegradationStubVectorCatalog.json)

Each vector names:

| Field | Role |
|---|---|
| `surface` / `operation` | `sync` \| `storage` \| `model` × `read` \| `write` |
| `forcedFailure.kind` | `dependency_unavailable` \| `timeout` \| `corrupt_response` \| `partial_failure` |
| `expectedMode` / `expectedSignalCode` | Registry lookup expectation (`DEGRADE_*`) |
| `idempotencyKey` | Replay must not double-apply rollback/queue |

```ts
import {
  createDegradationRegistry,
  degradationStubVectorCatalogSchema,
  evaluateDegradationStubVector,
  claimStubVectorIdempotencyKey,
} from "@moolam/sync-protocol";

const catalog = degradationStubVectorCatalogSchema.parse(stubVectorsJson);
const registry = createDegradationRegistry();
const seen = new Set<string>();

for (const vector of catalog.vectors) {
  const result = evaluateDegradationStubVector(vector, registry);
  // result.ok === true → mode + signalCode match registry
  const claim = claimStubVectorIdempotencyKey(seen, vector.idempotencyKey);
  // claim.first === true on first apply; false on replay
}
```

Coverage in the fixture: every default binding (storage/sync/model × read/write)
plus a `partial_failure` write vector. Violation cases cover empty `subjectId`,
fabricated stale payloads, and `allowsSilentWriteRetry: true` (schema reject).

---

## 6. Related

- Stream frames: [`HARNESS-STREAM-SEMANTICS.md`](./HARNESS-STREAM-SEMANTICS.md)
- Metering: [`METERING.md`](./METERING.md)
- Contracts overview: [`docs/sdk/INTERFACES.md`](../sdk/INTERFACES.md)
- Drill cross-reference (failure → registry → proving drill):
  [`DEGRADATION-DRILL-CROSSREF.md`](./DEGRADATION-DRILL-CROSSREF.md)
