# SDK

`sutra-sdk` is the single public entry point. Applications import from it; internal packages remain importable for advanced integrations, but their layout may shift between minor versions while the SDK surface stays stable.

Browsable TypeDoc API reference (generated from `dist/*.d.ts`): [`docs-site/`](../../docs-site/README.md) → `/api/` (`pnpm docs-site:api` / `pnpm docs-site:build`).

## Getting started (implementors)

→ **[`implementor-quickstart.md`](./implementor-quickstart.md)** — `create-sutra` → install → first turn → enable sync (commands verified outside the monorepo).

→ **[`conformance-stub-guide.md`](./conformance-stub-guide.md)** — obligation CLI against a stub factory; read named pass/fail verdicts.

→ **[`binding-certification-guide.md`](./binding-certification-guide.md)** — certify a model adapter (B0 + B1) with pass/fail interpretation; badge checklist in [`CERTIFIED-BINDING.md`](../bindings/CERTIFIED-BINDING.md).

→ **[`training-export-runbook.md`](./training-export-runbook.md)** — run the
explicit consent-gated trajectory export, validate metadata-only JSONL, and
hand it to an external LoRA tool without weakening locality or subject
isolation.

## Conformance (implementors)

Before shipping a custom binding, run it through the contract suite:

→ **[`conformance-quickstart.md`](./conformance-quickstart.md)** — install, factory wiring, reading verdicts, &lt; 15 minute budget, CI gate (`pnpm conformance`).

## Publish operations

→ **[`PUBLISH-CHECKLIST.md`](./PUBLISH-CHECKLIST.md)** — release-operator checklist for `@moolam/*` package dry-run verification (`publish:readiness` + `publish:pack`).

## Quick start

```ts
import { CognitiveCore, type CognitiveBindings, type AgentProfile } from "sutra-sdk";

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

Protocol implementors should use the
[`Post-1.0 protocol evolution guide`](../protocol/DEPRECATION-POLICY.md) to
check `PROTOCOL_VERSION`, handle deprecated fields and sunset advisories, and
sequence mixed-version migrations without weakening replay idempotency,
subject isolation, or locality.
