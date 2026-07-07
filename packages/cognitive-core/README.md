# @moolam/cognitive-core

The cognitive composition loop. `CognitiveCore` takes an `AgentProfile` (charter, refusals, languages) and one binding per contract, and runs the turn:

```
perceive (Speech/Vision) → recall (Memory) → retrieve (Knowledge)
→ reason (Reasoning) → plan/act (Planning + Tools) → respond (Model/Speech)
→ reflect (Memory)
```

Nothing in this package knows which domain it serves or which host it runs in. A teacher, a legal companion, and a clinical assistant are the same loop with different bindings and profiles.

## Architecture

- `src/harness.ts`: `CognitiveCore`, `CognitiveBindings`, `AgentProfile`, `AgentTurnInput`, `AgentTurnOutput`.
- Depends only on `@moolam/contracts`. No environment assumptions (no filesystem, no timers, no network); hosts supply those through the runtime contracts.
- Refusals from the profile enter reasoning as constraints; violations surface in `unresolvedConstraints` and the core declines rather than answers.

## Public API

`CognitiveCore` (the class), the binding and profile types, and the turn input/output types. All exported from `src/index.ts`.

## Quick start

```ts
import { CognitiveCore } from "@moolam/cognitive-core";

const core = new CognitiveCore(profile, bindings);
const out = await core.turn({
  subjectId: "subject-1",
  sessionId: crypto.randomUUID(),
  utterance: "Where should we start?",
});
```

Applications should normally import through `@moolam/sdk` instead.

## Contributing notes

- Keep the loop domain-free: profession-specific vocabulary in this package is review-blocking.
- Composition overhead budget is ≤ 10ms p95 per turn excluding bound-implementation time (PRD NFR-06); `benchmarks/core_loop.bench.mjs` measures it.

## Examples

`examples/teacher-basic/` and `examples/lawyer-basic/` run this loop with different configurations; that pair is the package's thesis demonstrated.

## Tests

```bash
pnpm --filter @moolam/cognitive-core test
```
