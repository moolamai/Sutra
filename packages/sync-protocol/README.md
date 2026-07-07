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

## Contributing notes

- Any change to `contract.ts` requires an accepted RFC and must be additive on the wire (PRD SYNC-01).
- Any merge-semantics change lands in TypeScript and Python in the same PR, with both smoke tests updated to prove identical joins.
- Never compare wall-clock times in the merge path; HLC order only.

## Examples

`examples/cloud-sync/` demonstrates two replicas diverging offline and converging; `benchmarks/crdt_merge.bench.mjs` and `benchmarks/sync_roundtrip.bench.mjs` measure the engine.

## Tests

```bash
pnpm --filter @moolam/sync-protocol test
```
