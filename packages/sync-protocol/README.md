# @moolam/sync-protocol

The wire contract and the CRDT reconciliation engine: the centre of gravity of the platform. Every byte crossing the edge/cloud boundary is defined here, validated here, and merged here. A semantically identical Python twin lives in the cloud engine (`contract_models.py`, `crdt_merge.py`); the two are kept in lockstep by shared-fixture smoke tests.

## Architecture

| File | Responsibility |
|---|---|
| `src/contract.ts` | The canonical wire contract: `CognitiveState`, sync envelopes, agent turn envelopes, all Zod-validated. Changes are RFC-gated and additive-only |
| `src/crdt_harness_resolver.ts` | The merge engine: G-Counter mastery shards (pointwise max), G-Set friction log (union by HLC key), LWW session registers (HLC total order, cloud wins ties), skew clamping with typed advisories |
| `src/hlc.ts` | Hybrid Logical Clocks: total event order without trusting device clocks |
| `src/sync_engine.ts` | The autonomous client: exponential backoff with jitter, idempotency keys, poison-payload quarantine, response re-validation before adoption |

Merge is commutative, associative, and idempotent; `smoke_test.mjs` asserts the algebra directly. Design philosophy: `design/sync.md`. Decision record: ADR 0003.

## Public API

The contract types and schemas, `CrdtHarnessResolver`, `HlcClock`, `SyncEngine`, and the advisory/error types, exported from `src/index.ts`.

## Quick start

```ts
import { CrdtHarnessResolver, cognitiveStateSchema } from "@moolam/sync-protocol";

const resolver = new CrdtHarnessResolver();
const merged = resolver.merge(deviceReplica, cloudMaster);
// same result in any order, any number of times

cognitiveStateSchema.parse(merged.state); // validate before adopting, always
```

## Versioning

Additive-only until Stage 3 (Track A P7 freeze). Envelope `protocolVersion`
(`PROTOCOL_VERSION` in `src/contract.ts`, currently `"0.1.0"`) bumps **MINOR**
on every additive schema change. Breaking removals are prohibited before the
freeze; deprecate fields in place per the policy below.

**Protocol 1.0 freeze RFC:** [`rfcs/0001-protocol-1.0-freeze.md`](../../rfcs/0001-protocol-1.0-freeze.md)
— draft evidence appendix, explicit acceptance blockers, and the additive-only
policy that applies after maintainer acceptance. Conformance obligation
coverage: [`rfcs/appendix/conformance-coverage.md`](../../rfcs/appendix/conformance-coverage.md)
(`pnpm conformance:coverage`).

**Changelog:** [`CHANGELOG.md`](./CHANGELOG.md) follows Keep a Changelog.
Package baseline **0.1.0** documents the full initial wire surface. Put every
schema-visible edit under `## [Unreleased]` in the same PR; cut a dated
section only at release.

**Deprecation policy:** [`docs/DEPRECATION-POLICY.md`](./docs/DEPRECATION-POLICY.md)
— additive-only pre–Stage 3, `PROTOCOL_VERSION` bump table, 180-day / two-minor
deprecation window, and worked examples (additive field, deprecated field,
breaking rename deferred).

**Cross-language release lockstep:** [`docs/protocol/VERSION-LOCKSTEP.md`](../../docs/protocol/VERSION-LOCKSTEP.md)
— `PROTOCOL_VERSION`, this package's npm `version`, and `sutra-sdk` PyPI
version must match at every `v*` tag.

## Contributing notes

- Any change to `contract.ts` requires an accepted RFC and must be additive on the wire (PRD SYNC-01).
- Any merge-semantics change lands in TypeScript and Python in the same PR, with both smoke tests updated to prove identical joins.
- Never compare wall-clock times in the merge path; HLC order only.
- Wire or schema PRs update `## [Unreleased]` in [`CHANGELOG.md`](./CHANGELOG.md) (also noted in root `CONTRIBUTING.md` §9).

## Examples

`examples/cloud-sync/` demonstrates two replicas diverging offline and converging; `benchmarks/crdt_merge.bench.mjs` and `benchmarks/sync_roundtrip.bench.mjs` measure the engine.

## Tests

```bash
pnpm --filter @moolam/sync-protocol test
```

## Advisory surface (SYNC-02 / SYNC-06)

Implementors testing harness merge behavior should treat
[`docs/advisory-surface.md`](./docs/advisory-surface.md) as the reference:
each `SyncAdvisory` code, its trigger, `detail` payload shape, and the named
regression fixtures that pin it. Advisories never abort a same-subject merge;
cross-subject merges remain hard errors.

## Harness stream semantics

Streaming turn frames (`HarnessFrame`) — `sequenceIndex` monotonicity, gap
detection, last-seen reconnect/replay, and `HARNESS_ERROR` terminal rules —
are documented in
[`../../docs/protocol/HARNESS-STREAM-SEMANTICS.md`](../../docs/protocol/HARNESS-STREAM-SEMANTICS.md).
Wire schema: [`schemas/HarnessFrame.json`](./schemas/HarnessFrame.json).

## Metering and BudgetHook

Per-turn `MeterEvent` (`METER_TICK.tick` / EventBus `harness.meter`) and the
host `BudgetHook` surface (`allow` \| `throttle` \| `hardStop`) are documented
in [`../../docs/protocol/METERING.md`](../../docs/protocol/METERING.md).
Wire schema: [`schemas/MeterEvent.json`](./schemas/MeterEvent.json).

## Degradation registry

Named dependency-failure modes (`STALE_READ`, `HARD_STOP_WRITE`,
`QUEUE_AND_WARN`) and read-only `lookup(surface, operation)` are documented in
[`../../docs/protocol/DEGRADATION-REGISTRY.md`](../../docs/protocol/DEGRADATION-REGISTRY.md).
Wire schema: [`schemas/DegradationRegistry.json`](./schemas/DegradationRegistry.json).

## Canonical JSON Schemas

Committed wire JSON Schema lives in [`schemas/`](./schemas/). Regenerate after any
Zod contract change with:

```bash
pnpm --filter @moolam/sync-protocol schemas:export
```

See [`schemas/README.md`](./schemas/README.md) for the regeneration command,
normalization rules, and a reviewer checklist. Do not hand-edit the `.json`
files — CI will treat exporter output as law.
