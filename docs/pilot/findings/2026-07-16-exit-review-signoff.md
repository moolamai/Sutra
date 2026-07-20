# Exit review sign-off — privacy, markSynced, routing

| Field | Value |
|-------|-------|
| **Finding ID** | `FP-004` |
| **Date** | 2026-07-16 |
| **Severity** | `P3` |
| **Disposition** | Closed — exit review signed; see [`PILOT-EXIT-REVIEW.md`](../PILOT-EXIT-REVIEW.md) |
| **Affected spec** | `CAST-01` · `CAST-02` · `ATR-01` (gap `FP-002` / `CK-05` remains RFC blocker) |
| **subjectId** | `subj.pilot.exit.review` |
| **deviceId** | `dev-pilot-exit-ci` |
| **anomalyClass** | `exit_review_signoff` |
| **scopes.trajectoryExport** | `false` |

## Observation

Pilot exit review confirmed: (1) no raw keystroke export from `@moolam/telemetry` collector schema or pilot findings; (2) `markSynced` audit passed (write-ahead, offline sync gap, idempotent replay, restart survival); (3) routing quality signed off against guidance-eval expectations. Guidance gap `FP-002` (classroom-noise STT fixture) is filed as a freeze RFC blocker — not waived.

## Repro

1. `pnpm field-pilot:execute` — 14-day matrix + routing compare.
2. `pnpm field-pilot:findings:check` — severity / summary / RFC draft packaging.
3. `pnpm field-pilot:exit-review` — privacy source audit + live `markSynced` audit + sign-off doc gate.
4. Confirm exit review and this finding keep `trajectoryExport: false` and never embed utterance bodies.

## Sovereignty

Behavioral metadata only. Never raw keystroke content, never utterance bodies, never trajectory export.
