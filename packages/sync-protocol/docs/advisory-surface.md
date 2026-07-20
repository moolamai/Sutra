# SyncAdvisory surface — implementor conformance

Reference for harness implementors (TypeScript `CrdtHarnessResolver`, Python
`merge_states`). Semantic anomalies **never abort** a same-subject merge
(SYNC-06); they append typed `SyncAdvisory` rows. Structural impossibilities
(`SUBJECT_MISMATCH`, schema/version violations) still throw — those are not
advisories.

Wire shape (`code` + `detail` string):

```json
{ "code": "<ENUM>", "detail": "<human-readable, machine-greppable>" }
```

Canonical enum: [`../schemas/SyncAdvisory.json`](../schemas/SyncAdvisory.json).
Both languages must emit the same codes and compatible `detail` content for
identical inputs.

Observability: fixtures emit structured `{"event":"crdt.advisory",...}` lines
with `subjectId`, `deviceId` (when applicable), and `outcome` — never raw
learner content.

---

## Catalogue (all five codes)

### `CLOCK_SKEW_CLAMPED` — SYNC-02

| | |
|---|---|
| **Trigger** | A remote HLC physical component is strictly greater than `now + MAX_CLOCK_SKEW_MS`. |
| **Bound** | Named constant `MAX_CLOCK_SKEW_MS = 86_400_000` (24h). Same value in TS (`crdt_harness_resolver.ts`), Python (`crdt_merge.py`), and [`../fixtures/advisories/skew-clamp.json`](../fixtures/advisories/skew-clamp.json). Not a magic number per language. |
| **Clamped fields** | Remote `profile.updatedAt` and every `stateVector` entry. Mastery / friction HLCs are not rewritten by the clamp path. |
| **Merge continues** | Yes — clamped values participate in LWW / pointwise-max joins. |
| **Payload (`detail`)** | Count of clamped timestamps, the ms bound, and semicolon-separated `original→clamped` pairs. |

Worked example (from the skew-clamp fixture, `nowMs = 1000000000000`):

```json
{
  "code": "CLOCK_SKEW_CLAMPED",
  "detail": "4 HLC timestamp(s) exceeded the 86400000ms skew horizon and were clamped; original→clamped: 009000000000000:000010:edge-bbbb→001000086400000:000010:edge-bbbb; 009000000000000:000011:edge-bbbb→001000086400000:000011:edge-bbbb; 009000000000000:000010:edge-bbbb→001000086400000:000010:edge-bbbb; 009000000000000:000012:edge-bbbb→001000086400000:000012:edge-bbbb"
}
```

Regression suite: `tests/hlc_advisories.test.mjs` · cloud `tests/test_hlc_advisories.py`
(in-bound / at-bound → no advisory; beyond-bound → advisory with both originals and clamped values).

### `DUPLICATE_SAMPLE_DROPPED` — SYNC-03 / SYNC-06

| | |
|---|---|
| **Trigger** | Friction G-Set union sees two samples with the same `capturedAt` HLC key (replay or divergent payloads). |
| **Merge continues** | Yes — one sample retained via deterministic payload preference; count of collisions reported. |
| **Payload (`detail`)** | `"<n> duplicate friction sample(s) dropped during union"`. |

```json
{
  "code": "DUPLICATE_SAMPLE_DROPPED",
  "detail": "1 duplicate friction sample(s) dropped during union"
}
```

Related fixture direction: [`../fixtures/golden-joins/07-friction-collision-prefer.json`](../fixtures/golden-joins/07-friction-collision-prefer.json)
(and the merge-laws friction collision corpus).

### `UNKNOWN_CONCEPT_QUARANTINED` — SYNC-06

| | |
|---|---|
| **Trigger** | Merge is given a known-concept set and a mastery key is absent from that set. |
| **Merge continues** | Yes — shard bytes stay in the merged document for later adoption. |
| **Payload (`detail`)** | Count + sorted concept ids: `"… quarantined (evidence preserved): <ids>"`. |

Worked example ([`../fixtures/advisories/unknown-concept-quarantined.json`](../fixtures/advisories/unknown-concept-quarantined.json)):

```json
{
  "code": "UNKNOWN_CONCEPT_QUARANTINED",
  "detail": "2 unknown conceptId(s) quarantined (evidence preserved): also.unknown.z, rogue.unknown.concept"
}
```

Omit the known-concept option → check skipped (backward compatible); no advisory.

### `STATE_VECTOR_REGRESSION` — SYNC-06

| | |
|---|---|
| **Trigger** | Submitted `stateVector` is **strictly dominated** by stored: ≤ on every key, < on at least one (missing keys treat as genesis). |
| **Merge continues** | Yes — pointwise HLC max still joins; advisory names the regressed keys. |
| **Payload (`detail`)** | `"submitted stateVector strictly dominated by stored; regressed entries: <sorted keys>"`. |

Worked example ([`../fixtures/advisories/state-vector-regression.json`](../fixtures/advisories/state-vector-regression.json)):

```json
{
  "code": "STATE_VECTOR_REGRESSION",
  "detail": "submitted stateVector strictly dominated by stored; regressed entries: device:edge-bbbb, profile, session"
}
```

Equal vectors or any submitted-ahead key → **not** strict domination → no advisory.

### `DEPRECATED_FIELD_PRESENT` — deprecation window

| | |
|---|---|
| **Trigger** | Inbound wire document still carries a registered deprecated field path. |
| **Merge / parse continues** | Yes — field is accepted until sunset eligibility + Stage 3 major; never silently dropped without advisory. |
| **Payload (`detail`)** | Machine-greppable: `field=<path>;sunset=YYYY-MM-DD;testOnly=true\|false[;replacement=<path>]`. **Never** includes the field value. |

Seeded test-only proof path: `profile.__deprTestLegacyLocale` (sunset `2027-01-13`) via
`parseCognitiveStateWithDeprecationAdvisories` /
`tests/deprecation_advisory.test.mjs`. Production deprecations register the same way
after additive schema announcement (see [`DEPRECATION-POLICY.md`](./DEPRECATION-POLICY.md)).

```json
{
  "code": "DEPRECATED_FIELD_PRESENT",
  "detail": "field=profile.__deprTestLegacyLocale;sunset=2027-01-13;testOnly=true;replacement=profile.language"
}
```

---

## Not advisories (abort paths)

| Condition | Surface | Notes |
|---|---|---|
| Different `subjectId` | Throw `SUBJECT_MISMATCH` / `IrreconcilableStateError` | Sovereignty / subject isolation — never merge across subjects |
| Schema / protocol version violations | Typed irreconcilable errors | Caller must not retry the same poison payload |

---

## Edge contracts implementors must respect

1. **Idempotent replay** — Merging the same remote again after adopt must converge to the same document; advisories may re-fire for the second join's inputs (skew clamp re-evaluates remote HLCs each call).
2. **Concurrency** — Per-`subjectId` serialization belongs to the store/sync service; the merge function itself is a pure join over two snapshots.
3. **Bounded work** — Advisories are O(changed fields / colliding samples); no unbounded scans of unrelated subjects.
4. **Observability** — Distinct codes are distinct signals. Never swallow a semantic anomaly without a `SyncAdvisory` row.

## How to prove conformance

| Advisory | Fixture | Dual-language tests |
|---|---|---|
| `CLOCK_SKEW_CLAMPED` | `fixtures/advisories/skew-clamp.json` | `tests/hlc_advisories.test.mjs`, `cloud-orchestrator/tests/test_hlc_advisories.py` |
| `UNKNOWN_CONCEPT_QUARANTINED` | `fixtures/advisories/unknown-concept-quarantined.json` | `tests/advisories_unknown_concept.test.mjs`, `test_advisories_unknown_concept.py` |
| `STATE_VECTOR_REGRESSION` | `fixtures/advisories/state-vector-regression.json` | `tests/advisories_state_vector_regression.test.mjs`, `test_advisories_state_vector_regression.py` |
| `DUPLICATE_SAMPLE_DROPPED` | golden-joins / merge-laws friction collision | merge algebra suites |
| `DEPRECATED_FIELD_PRESENT` | seeded `profile.__deprTestLegacyLocale` | `tests/deprecation_advisory.test.mjs` |

Run:

```bash
pnpm --filter @moolam/sync-protocol test:advisories
# from packages/cloud-orchestrator:
pytest tests/test_hlc_advisories.py tests/test_advisories_unknown_concept.py tests/test_advisories_state_vector_regression.py
```
