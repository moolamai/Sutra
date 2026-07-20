# Gym scenario fixtures — A P6 golden turns

Compiled from `packages/runtime-harness/fixtures/golden-turns/` (A P6 import;
alias `fixtures/golden-turns/`). Origin: `packages/sync-protocol/fixtures/golden-turns`.

## Regenerate

```bash
pnpm --filter @moolam/training-gym golden:write   # materialize working tree
# human review of git diff — never auto-commit
pnpm --filter @moolam/training-gym golden:check   # byte-identical CI gate
```

## Invariants

- Language-neutral JSON only.
- Each task declares `expectedTerminalFrame` (`TURN_COMPLETE` | `HARNESS_ERROR`) and `oracleCheckId`.
- `scenarioId` equals the golden turn `id` so `GymEnv.reset(scenarioId)` maps 1:1.
- Scenario tasks carry oracle metadata only — not raw frame / utterance bodies.
