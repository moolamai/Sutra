# sutra-sdk

The one public entry point. Applications import from here; internal package layout may shift between minor versions while this surface stays stable and semver-governed.

```ts
import { CognitiveCore } from "sutra-sdk";
```

## Architecture

A re-export barrel with no logic of its own. Layering (each layer depends only on layers above it):

| Layer | Package | Re-exported surface |
|---|---|---|
| Contracts | `@moolam/contracts` | All cognitive and runtime interfaces |
| Protocol | `@moolam/sync-protocol` | `CognitiveState`, CRDT resolver, HLC clock, sync engine, schemas |
| Core | `@moolam/cognitive-core` | `CognitiveCore`, `CognitiveBindings`, `AgentProfile` |
| Runtime | `@moolam/runtime` | `RuntimeHost`, `InProcessScheduler`, `InProcessEventBus` |
| Telemetry | `@moolam/telemetry` | `CognitiveTelemetryCollector`, event and sample types |
| Edge | `@moolam/edge-agent` | `EdgeAgent`, `LocalVectorDb`, SLM runtime adapters |

## Public API

Everything exported from `src/index.ts`. If a symbol is not exported here, treat it as internal even if its package exposes it.

## Quick start

Scaffold a companion outside the monorepo (`create-sutra`), then:

```ts
import { CognitiveCore } from "sutra-sdk";
```

Full walkthrough: [`docs/sdk/implementor-quickstart.md`](../../docs/sdk/implementor-quickstart.md).  
Conformance stub + binding certification: [`docs/sdk/conformance-stub-guide.md`](../../docs/sdk/conformance-stub-guide.md), [`docs/sdk/binding-certification-guide.md`](../../docs/sdk/binding-certification-guide.md). Binding recommendations per profession: `domains/*/interfaces.md`.

## Contributing notes

- Additions here are additions to the public contract; removals are breaking changes. Prefer exporting from the owning package first and promoting to the SDK once stable.
- Keep this package logic-free. Helpers belong in the owning layer.

## Examples

Every script in `examples/` imports exclusively from `sutra-sdk`; they are the living documentation of this surface.
