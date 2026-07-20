# Guidance episode tasks (B8 → gym)

Language-neutral episode tasks compiled from
`training/eval/fixtures/b8-guidance/`.

- Each task declares `expectedTerminalFrame` (`TURN_COMPLETE` | `HARNESS_ERROR`)
  and `oracleCheckId`.
- Teacher pack attaches verifiable **mastery** outcomes; lawyer pack attaches
  verifiable **citation** / scope outcomes.
- Regeneration: `pnpm --filter @moolam/training-gym guidance:write` then human
  review before commit. CI / local gate: `guidance:check` (never auto-commits).
