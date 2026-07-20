# `@moolam/learning`

Learning substrate contracts: turn-trajectory schema, outcome signals, baseline
registry, and frozen eval slices for Track C.

## Anti-cheat charter

Training environments must use the **same** production harness code path as
live turns. The binding governance document is:

**[training/gym/charter.md](../../training/gym/charter.md)**

Executable replay-parity coverage: `pnpm --filter @moolam/training-gym parity:check` (and `test`).

Rewards computed under a diverged gym path are void and must not be promoted.

## Trajectory critics (C3)

Pack-pluggable `TrajectoryCritic` / `CriticScore` contracts live in this package
and are re-exported from [`training/critics/`](../../training/critics/).

- Pure `score(record)` — no network / LLM on the default path
- Versioned `rubricId` + `rubricVersion` on every score
- `CriticRegistry` stores critics by id@version; pack oracles load from JSON
  manifests under `training/critics/fixtures/pack-oracles/` (no `domains/` imports)

```bash
pnpm --filter @moolam/learning test
# critics_interface + critics_pack_oracles cover determinism, hack ≤0, two CI oracles
```

## Learning constitution

Binding governance law: [`docs/learning/CONSTITUTION.md`](../../docs/learning/CONSTITUTION.md).

One-surgery-per-stage promotion-candidate lint:
`pnpm --filter @moolam/learning surgery:check`
(green + seeded multi-surgery violation fixtures under
`training/eval/fixtures/promotion-candidates/`).

Kill-switch operator runbook (constitution L4):
[`docs/learning/KILL_SWITCH_RUNBOOK.md`](../../docs/learning/KILL_SWITCH_RUNBOOK.md)
— copy-paste revert checklist, monthly safety-alignment drill schedule,
verify once with `parity:check` + `golden:replay`.

## Research intake (C7 breakthrough RFC)

New learning techniques enter through an eval-gated RFC — never ad-hoc trainer
forks. Template + review workflow:

- [`docs/learning/research-intake/RFC_TEMPLATE.md`](../../docs/learning/research-intake/RFC_TEMPLATE.md)
- [`docs/learning/research-intake/REVIEW_WORKFLOW.md`](../../docs/learning/research-intake/REVIEW_WORKFLOW.md)
- [`docs/learning/research-intake/ADOPTION_CHECKLIST.md`](../../docs/learning/research-intake/ADOPTION_CHECKLIST.md) — approved → manifest → regenerate → micro-run → PROGRESS
- Worked example (GRPO G=8→G=6): [`docs/learning/research-intake/rfcs/RFC-2026-004-grpo-g8-to-g6.md`](../../docs/learning/research-intake/rfcs/RFC-2026-004-grpo-g8-to-g6.md)
- Generator hook: [`docs/stages/tracks/_generator/track-c/research-intake-rfc.md`](../../docs/stages/tracks/_generator/track-c/research-intake-rfc.md)

```bash
pnpm --filter @moolam/learning build
node --test packages/learning/tests/research_intake_rfc.test.mjs
node --test packages/learning/tests/research_intake_worked_example.test.mjs
node --test packages/learning/tests/research_intake_adoption.test.mjs
pnpm --filter @moolam/learning research-rfc-adoption:check
```

## LLM-judge policy (C3)

Narrow lane for non-verifiable aspects only (`tone`, `clarity`).
Binding governance: [`docs/learning/LLM_JUDGE_POLICY.md`](../../docs/learning/LLM_JUDGE_POLICY.md).

Published mirror: [`training/critics/llm_judge_lane.ts`](../../training/critics/llm_judge_lane.ts).

```bash
pnpm --filter @moolam/learning llm-judge-policy:check
pnpm --filter @moolam/learning llm-judge-gate:check
```

LLM judges must never score mastery math, citations, schema validity, or
contract obligations — those stay with rule critics / pack oracles.

Held-out tone/clarity agreement fixtures live under
[`training/eval/llm_judge_sets/`](../../training/eval/llm_judge_sets/)
and are independent of critic human-label calibration.

## Scripts

```bash
pnpm --filter @moolam/learning test
pnpm --filter @moolam/learning schemas:check
pnpm --filter @moolam/learning baselines:check
pnpm --filter @moolam/learning slices:check
pnpm --filter @moolam/learning surgery:check
pnpm --filter @moolam/learning hack:check
pnpm --filter @moolam/learning llm-judge-policy:check
pnpm --filter @moolam/learning llm-judge-gate:check
pnpm --filter @moolam/learning calibration:check
```
