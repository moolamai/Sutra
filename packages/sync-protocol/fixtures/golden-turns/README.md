# Golden turn fixtures

Executable A↔B stream contract: raw `input` chunks → `expectedFrames`
(`HarnessFrame[]`). B4's parser must replay these byte-identically.

## Format

```json
{
  "id": "thought-answer-basic",
  "subjectId": "anika-k",
  "deviceId": "edge-aaaa",
  "correlationId": "corr-gt-01",
  "coverage": ["thought_delta", "answer_delta", "tool_call_fence", "advisory_attach", "turn_complete"],
  "input": ["…raw stream chunk…"],
  "expectedFrames": [ { "type": "SESSION_START", "…" : "…" } ]
}
```

Zod source: `packages/sync-protocol/src/golden_turns.ts` (`goldenTurnFixtureSchema`).

Reference parser stub (until B4): `packages/sync-protocol/tests/golden_turn_parser_stub.mjs`
— consumes `input` chunks and emits canonical `HarnessFrame[]` for CI replay.

CI gate: job `golden-turns` (`pnpm golden:turns`). Drift prints a unified diff;
prove red→green with `pnpm golden:turns:prove` (never auto-commits).

## Rules

1. Language-neutral JSON with **canonical key ordering** (use
   `canonicalizeGoldenTurn` — never hand-reorder casually).
2. **Each** golden MUST include: a `tool_call` fence and/or `TOOL_STATUS`,
   one `ADVISORY_ATTACH`, and a terminal `TURN_COMPLETE` or `HARNESS_ERROR`.
3. Corpus (≥5 turns) MUST cover: thought/answer deltas, tool fence,
   correction loop, `METER_TICK`, and `HARNESS_ERROR`.
4. Updating a golden requires **human review** — do not auto-commit
   regenerated files from scripts.
5. Metadata only in telemetry; fixtures may contain synthetic deltas for
   parse coverage but must stay subject-scoped (`subjectId` on every frame).

## Manifest

See `manifest.json` for the committed turn list.
