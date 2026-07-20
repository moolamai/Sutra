# Runtime

An agent is code that needs somewhere to run. The runtime layer defines what any host must provide (contracts in `@moolam/contracts`) and ships reference implementations (`@moolam/runtime` for in-process TypeScript, the FastAPI engine for cloud Python).

## The runtime contracts

| Contract | Provides | Reference implementation |
|---|---|---|
| `LifecycleAware` + `LifecycleState` | created -> initializing -> ready -> running -> suspended -> stopped/failed | `RuntimeHost` |
| `SchedulerInterface` | Deferred and periodic task execution (memory compaction, sync retries, plan reviews) | `InProcessScheduler` |
| `EventBusInterface` | Decoupled pub/sub between components (turn completed, sync adopted, friction spike) | `InProcessEventBus` |
| `StorageDriver` | Key-value persistence seam for hosts without a filesystem | SQLite/in-memory drivers |

## Hosts

| Host | Environment | Notes |
|---|---|---|
| `EdgeAgent` (`packages/edge-agent`) | Phones, browsers, embedded devices | Wraps the loop with a local SLM, local vector store, telemetry, and a sync client; fully offline-capable |
| Cloud engine (`packages/cloud-orchestrator`) | Server processes | `agent_runtime.py` composes the task router and master state store behind `POST /v1/agent/turn`; pluggable AuthN/AuthZ at the FastAPI boundary — see [pluggable auth deployment guide](../../packages/cloud-orchestrator/docs/pluggable-auth-deployment.md) |
| Runtime harness (`packages/runtime-harness`) | Streaming turn host + token parser | A P6 golden-turn import, replay, and chunk-boundary fuzz — operator workflow: [golden-replay-operator.md](../../packages/runtime-harness/docs/golden-replay-operator.md) |
| Test harness | Node test runner | The same loop with mock bindings; see `examples/_shared/mocks.mjs` |

The point of the contracts is that these three are the same agent. Nothing in `cognitive-core` knows which host it is inside.

## Lifecycle discipline

Transitions are one-way except suspend/resume. A component that fails during `initializing` moves to `failed` and the host reports it; there is no partial-startup state. Suspension exists for mobile hosts (app backgrounded, device sleeping) and must be cheap: suspended components keep memory but stop scheduling.

## Writing a new host

Implement the four contracts for your environment (a Cloudflare Worker, a desktop app, a robot controller), bind them into `CognitiveBindings`, and the loop runs unchanged. The runtime package's tests double as the conformance suite. Implementation philosophy lives in [`design/runtime.md`](../../design/runtime.md); decision history in [ADR 0005](../adr/0005-runtime.md).
