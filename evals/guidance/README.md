# Guidance routing-quality evals

Fixtures and schemas for CI gating of TaskRouter / playground route decisions
(ATR), distinct from `training/eval/fixtures/b8-guidance/` (gym episode tone).

```
evals/guidance/
  schemas/scenario-v1.json   # scenario format
  schemas/rubric-v1.json     # rubric format
  rubric.json                # committed weights + failBelow (0.85)
  threshold.json             # CI minAggregateScore + pinned tooling/pack
  run.mjs                    # CI gate runner (DIFF on fail)
  scenarios/teacher/         # ≥8 teacher CBSE-slice goldens + manifest
  src/validate.mjs           # AJV validate
  src/score.mjs              # seeded suite scorer (keyword tolerance)
  src/router_actual.mjs      # route_core actuals for scoring
```

```bash
pnpm --filter @moolam/guidance-evals test
pnpm --filter @moolam/guidance-evals gate
```
