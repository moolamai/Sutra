# Anti-cheat charter — production path = training path

**Status:** binding for all training environments under `training/`  
**Owners:** Track C learning substrate · runtime harness maintainers  
**Executable checks:** `pnpm --filter @moolam/training-gym parity:check` (corpus CI gate) · `training/gym/tests/replay_parity.test.ts` · `pnpm deps:lint` / `pnpm deps:lint:prove` (anti-cheat import + reimpl gate)

This document is the governance contract for AICA’s anti-cheat invariant. Convenience mocks that “almost” match production poison GRPO advantages and invalidate every reward computed in that environment. When this charter and production diverge, **training is void** — not degraded.

---

## 1. Cardinal invariant

```text
production harness code path  ≡  training environment code path
```

The gym **imports** `@moolam/runtime-harness` (and the production tool registry when tools are exercised). It never re-implements:

- the token / tool-call parser
- the sandbox / tool-invoke seam
- the correction loop
- harness frame assembly or `sequenceIndex` allocation

Any divergence between gym code path and production harness code path **invalidates training**. Rewards, advantages, and adapters produced under a diverged path are not promotable.

---

## 2. Import rules

| Location | Allowed imports for harness primitives | Forbidden |
|----------|----------------------------------------|-----------|
| `training/gym/**` | `@moolam/runtime-harness`, production tool registry packages only | Local parser, sandbox, correction-loop, or frame-assembler re-implementations |
| `training/**` (other) | Must not invent alternate harness frame semantics | Duplicate `ToolCallParser` / sandbox / abort pipelines |

Concrete rules:

1. Gym modules that need turn frames import only through `@moolam/runtime-harness` (or a thin re-export bridge that itself only imports that package).
2. No `training/**` copy of fence parsing, tool envelope validation, or terminal-frame emission.
3. Seeded violation fixtures (lint / CI) must fail when forbidden re-implementation lands under `training/`.

---

## 3. Replay test contract

Replay parity is **frame-sequence identity**, not final-answer equality.

For each recorded production trajectory (or golden production-path fixture):

1. Load the frozen record (inputs + expected harness frames).
2. Replay through the gym’s harness wrapper (production code path).
3. Compare each frame on:
   - `sequenceIndex` (monotonic identity)
   - frame `type` (e.g. `THOUGHT_DELTA`, `TOOL_STATUS`, `HARNESS_ERROR`, `TURN_COMPLETE`)
   - **payload hash** — SHA-256 of the canonical JSON of the frame body used for compare (sorted keys; same canon as harness `canonicalizeFramesJson` frame elements)
4. Pass only if the full ordered sequence matches.

Fail loudly with a **frame-level diff** (index + type + hash). Never auto-update golden fixtures from CI.

**Intentional harness bump (human-reviewed regeneration only):**  
[`docs/parity-fixture-regeneration.md`](./docs/parity-fixture-regeneration.md)

### Non-determinism

Clocks, retrieval order, and sampling must be pinned or sealed in the recorded fixture (`pinnedAt`, fixed seeds, fixed corpus). Uncontrolled entropy makes rewards noise and voids the run. Seeded clock and per-rollout RNG injection follow the seed propagation contract in `training/gym/determinism.ts` (`SEED_PROPAGATION_CONTRACT`).

### Episode termination

Episodes end only on production terminal frames:

- `TURN_COMPLETE`
- `HARNESS_ERROR`

Custom gym `done` flags that are not these frames are forbidden.

---

## 4. Consequences of violation

| Violation | Consequence |
|-----------|-------------|
| Gym re-implements parser / sandbox / correction loop | Training void; PR blocked by lint / import gate |
| Replay frame sequence drifts from production record | CI fail with frame-level diff; rewards for that env invalidated |
| Harness version changes frame shape without new golden | Loud fail; humans land a reviewed fixture — no silent green |
| Gym mock replaces B4 typed tool / violation errors | Training void; tests must assert real harness error frames |
| Unseeded non-determinism in the replay path | Run rejected; treat as `runner_error` / environment invalid |

Invalidated training artifacts must not be promoted. Operators treat the failure class as a hard gate, not a warning.

---

## 5. Sovereignty & subject isolation

- Every replay and telemetry event is scoped by `subjectId` (and `deviceId` when present).
- Cross-subject leakage in replay buffers is a defect.
- Telemetry is metadata-only: never attach raw learner utterance bodies to charter / parity events.
- Model output and wire payloads remain untrusted input — validated at the harness boundary before use.
- Locality (`on-device` / `self-hosted`) of recorded trajectories must not be violated by exporting raw content for “debug diffs” in plaintext logs.

---

## 6. Observability

Emit structured events such as:

```json
{
  "event": "training.gym.replay_parity",
  "outcome": "ok | rejected",
  "subjectId": "<from fixture>",
  "deviceId": "<from fixture>",
  "failureClass": "canonical_drift | missing_subject | …",
  "frameIndex": 3,
  "frameType": "HARNESS_ERROR"
}
```

Distinct failure classes get distinct signals. Silent catch-and-continue is forbidden.

---

## 7. Edge cases (normative)

1. **Harness version bump** that changes frame shape → new golden replay fixture after human review; CI fails with unified diff until landed.
2. **Deliberate invalid tool / truncated stream** in replay → must yield the **real** typed terminal / status frames from the production harness (e.g. `HARNESS_ERROR` with harness codes), never a gym-only mock object.
3. **Partial failure** after the first durable side effect → same abort / rollback semantics as production; no gym-specific cleanup that hides divergence.
4. **Idempotent replay** of the same recorded input → identical frame sequence (no double-apply).

---

## 8. Scalability

- Bound frames buffered and compared per turn (same soft caps as the streaming host).
- No unbounded scans of memory or friction logs during parity checks.
- Hot-path NFR budgets from `docs/PRD_MATRIX.md` apply to harness code under the gym just as in production.

---

## 9. Related surfaces

- Production harness: `packages/runtime-harness/`
- Golden / production-path fixtures: harness `fixtures/golden-turns/` (A P6 origin)
- Learning substrate: `@moolam/learning` (trajectory / eval baselines consume rewards only from charter-valid envs)
- Sibling enforcement: import / reimpl lint (`pnpm deps:lint`) · trajectory replay CI (`pnpm --filter @moolam/training-gym parity:check`)
- Fixture regeneration runbook: [`docs/parity-fixture-regeneration.md`](./docs/parity-fixture-regeneration.md)

---

## 10. Acknowledgement

Shipping or running a training job under this tree constitutes acknowledgement of this charter. Circumventing the import or replay gates is treated as an intentional breach of the anti-cheat invariant.
