# @moolam/contracts

Pure cognitive contracts: the interfaces every other package is built from. Zero runtime dependencies, zero implementations. This package is the dependency root of the platform; it imports nothing and everything imports it.

## Architecture

One file per contract, one export barrel. Contracts carry MUST-level obligations in their JSDoc, not just type shapes: an implementation that type-checks but violates an obligation (drops a constraint, skips a trace, lies about locality) is non-conformant.

| File | Contract | Governs |
|---|---|---|
| `src/memory.ts` | `MemoryInterface` | Kind-tagged long-term memory with kind-driven decay |
| `src/model.ts` | `ModelInterface` | Provider-agnostic inference with locality declaration |
| `src/reasoning.ts` | `ReasoningInterface` | Auditable deliberation: traces, constraints, confidence |
| `src/speech.ts` | `SpeechInterface` | Streaming STT/TTS with declared language support |
| `src/vision.ts` | `VisionInterface` | Visual analysis behind a single `analyze` seam |
| `src/tool.ts` | `ToolInterface` | Risk-classed, audited action on the world |
| `src/planning.ts` | `PlanningInterface` | Goal graphs with evidence-driven, cyclic-capable revision |
| `src/knowledge.ts` | `KnowledgeConnectorInterface` | Citation-bearing access to authoritative corpora |
| `src/runtime.ts` | Lifecycle, scheduler, event bus, storage driver | What any host must provide |

## Public API

Everything exported from `src/index.ts` is public and semver-governed. There are no internal modules.

## Quick start

```ts
import type { MemoryInterface, MemoryItem } from "@moolam/contracts";

class MyStore implements MemoryInterface {
  // your vector DB, graph store, or SQLite behind the same seam
}
```

Minimal reference implementations of every contract live in `examples/_shared/mocks.mjs`.

## Contributing notes

- Any change to a contract file requires an accepted RFC (`rfcs/`). Documentation-only changes do not.
- This package must never gain a runtime dependency. CI treats one as a build failure.
- Full specification with obligations tables: `docs/sdk/INTERFACES.md`.

## Examples

Every script under `examples/` implements one or more of these contracts with mocks; `examples/tool-use/` and `examples/voice/` are the most contract-focused.

## Tests

```bash
pnpm --filter @moolam/contracts test
```
