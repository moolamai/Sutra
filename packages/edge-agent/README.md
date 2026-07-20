# @moolam/edge-agent

The offline-first on-device host. `EdgeAgent` runs the full cognitive loop against a local SLM and a local vector store, with zero connectivity, indefinitely. It is not a degraded cache of the cloud: it is a peer replica that acts independently and converges through CRDT sync when connectivity returns (ADR 0002).

## Architecture

| File | Responsibility |
|---|---|
| `src/edge_agent.ts` | The host facade: `agentTurn()` composes local routing, prompt assembly, SLM inference, friction folding, and memory writes |
| `src/slm_runtime.ts` | The pluggable SLM seam: OpenAI-compatible localhost adapter shipped; llama.cpp, ONNX Runtime Mobile, AICore, and MLX adapters are roadmap Stage 2 |
| `src/local_vector_db.ts` | `LocalVectorDb`: SQLite-backed vector memory (Float32 BLOBs, exact cosine, kind-aware decay, corrections never evicted) behind the `StorageDriver` contract |

Friction telemetry comes from `@moolam/telemetry`; sync comes from `@moolam/sync-protocol`. Routing on-device is a greedy simplification of the cloud task router; on reconnect the cloud's LWW registers win without conflict (PRD ATR-06).

## Public API

`EdgeAgent`, `AgentReply`, `LocalVectorDb`, the SLM runtime interface and adapters, exported from `src/index.ts`.

## Quick start

```ts
import { EdgeAgent } from "@moolam/edge-agent";

const agent = new EdgeAgent({
  subjectId: "subject-1",
  deviceId: "device-a",
  runtime: slmRuntime,        // any SlmRuntime adapter
  storage: storageDriver,     // any StorageDriver (SQLite binding)
  profile,                    // track, language, age band
  // transport omitted = permanently-offline sovereign mode
});
await agent.initialize();

const reply = await agent.agentTurn("Explain this step to me.", frictionSample);
// works with the network cable cut; reply.servedLocally === true
```

## Contributing notes

- Every feature must answer "what does this do offline" at design time.
- Missing or corrupt on-disk weights must throw typed `SlmRuntimeInitError`
  (`missing_weights` / `corrupt_weights`) — never crash-loop or fabricate.
  See [`LocalWeightSlmRuntime`](./src/slm_runtime.ts) and the drill map in
  [`docs/protocol/DEGRADATION-DRILL-CROSSREF.md`](../../docs/protocol/DEGRADATION-DRILL-CROSSREF.md).
- Memory store changes must preserve parity with the cloud `memory_graph.py` semantics (same decay, same kinds), or document why the divergence is substrate-specific.
- Performance budgets: first token ≤ 1.5s p95 on mid-range Android (NFR-01).

## Examples

`examples/offline-edge/` runs a full turn with no network; `examples/memory/` exercises `LocalVectorDb` directly.

## Tests

Currently covered through the examples and the protocol smoke tests; per-package unit tests are a welcome contribution (see `CONTRIBUTING.md`).
