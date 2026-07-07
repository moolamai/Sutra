# SDK

`@moolam/sdk` is the single public entry point. Applications import from it; internal packages remain importable for advanced integrations, but their layout may shift between minor versions while the SDK surface stays stable.

## Quick start

```ts
import { CognitiveCore, type CognitiveBindings, type AgentProfile } from "@moolam/sdk";

const profile: AgentProfile = {
  domainId: "my-domain",
  charter: "You are a careful research companion. Cite sources.",
  refusals: ["Never present an unsourced conclusion as fact."],
  languages: ["en"],
};

const core = new CognitiveCore(profile, bindings);
const reply = await core.turn({
  subjectId: "subject-1",
  sessionId: crypto.randomUUID(),
  utterance: "Walk me through the trade-offs here.",
});
```

`bindings` is a `CognitiveBindings` object: one implementation per contract (memory, model, reasoning, knowledge, planning, tools, optionally speech and vision). The `examples/_shared/mocks.mjs` file shows minimal bindings; the domain specifications under `domains/` show production binding recommendations.

## What the SDK re-exports

| From | Surface |
|---|---|
| `@moolam/contracts` | All contract interfaces and their supporting types |
| `@moolam/cognitive-core` | `CognitiveCore`, `CognitiveBindings`, `AgentProfile`, turn types |
| `@moolam/runtime` | `RuntimeHost`, `InProcessScheduler`, `InProcessEventBus` |
| `@moolam/telemetry` | `CognitiveTelemetryCollector`, interaction event types |
| `@moolam/sync-protocol` | `CognitiveState`, CRDT resolver, HLC clock, sync engine, schemas |
| `@moolam/edge-agent` | `EdgeAgent`, `LocalVectorDb`, SLM runtime adapters |

## Replaceability

Every contract is a seam. Swap the vector store, the model provider, the reasoning engine, or the whole runtime host without touching the loop:

- Different model: implement `ModelInterface` (an OpenAI-compatible adapter is a few dozen lines)
- Different memory: implement `MemoryInterface` over your store; keep the kind/decay semantics (see [`../memory/README.md`](../memory/README.md))
- Different runtime: implement the runtime contracts (`SchedulerInterface`, `EventBusInterface`, `StorageDriver`) for your host environment

## Stability policy

The SDK surface follows semver. Contract changes require an RFC (see [`../../rfcs/README.md`](../../rfcs/README.md)); additive changes are minor versions, breaking contract changes are major versions and are expected to be rare.
