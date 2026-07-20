# P7 freeze RFC draft — field-pilot evidence appendix (B8)

| Meta | Value |
|------|-------|
| **Status** | Draft evidence input (not an accepted RFC under `rfcs/`) |
| **Audience** | Track A P7 contract-freeze / `FREERFC-001` authors |
| **Date** | 2026-07-16 |
| **Pilot summary** | [`PILOT-SUMMARY.md`](./PILOT-SUMMARY.md) |
| **Exit review** | [`PILOT-EXIT-REVIEW.md`](./PILOT-EXIT-REVIEW.md) |
| **Findings** | [`findings/`](./findings/) |

> **Purpose:** Satisfy B8 pilot-execution packaging so the 1.0 freeze RFC can cite concrete field-pilot evidence. This file is **not** `rfcs/0001-protocol-1.0-freeze.md`; that RFC is authored in Track A. When FREERFC-001 lands, copy or link this appendix and keep [`PILOT-SUMMARY.md`](./PILOT-SUMMARY.md) as the live index.

## Field-pilot evidence (required citation)

The freeze RFC evidence appendix **must** link:

- **Summary:** [`docs/pilot/PILOT-SUMMARY.md`](./PILOT-SUMMARY.md)
- **Exit review sign-off:** [`docs/pilot/PILOT-EXIT-REVIEW.md`](./PILOT-EXIT-REVIEW.md)
- **Dated findings:** [`docs/pilot/findings/`](./findings/) (`YYYY-MM-DD-*.md`, one observation each)

### Disposition for freeze acceptance

| Finding | Severity | Spec | Freeze disposition |
|---------|----------|------|--------------------|
| `FP-001` sync gap | P2 | `CAST-01` | Closed — documents write-ahead offline survival |
| `FP-002` STT noise | P1 | `CK-05` | **Closed** — `hi-classroom-noise` fixture + confidence regression test |
| `FP-003` routing parity | P3 | `ATR-01` | Closed — guidance-eval parity evidence |
| `FP-004` exit sign-off | P3 | `CAST-01` / `ATR-01` | Closed — privacy + `markSynced` + routing signed off |

Open issues are either closed, waived with expiry, or block acceptance — no silent deferrals. `FP-002` is **Closed** with fixture evidence (2026-07-17).

## Invariants carried into the freeze

- Friction samples are behavioral metadata only (`CAST-01` / `CAST-02`); never raw keystrokes.
- `trajectoryExport` stays `false` until B9 consent gates.
- Every pilot turn and finding is scoped by `subjectId` + `deviceId`.
- Exit review confirmed no raw keystroke export and completed `markSynced` audit.

## Observability

Pilot execution emits structured `field_pilot.execution` / `field_pilot.exit_review` events with `subjectId`, `deviceId`, and outcome — never plaintext learner content.

## Prove command

```bash
pnpm field-pilot:execute
pnpm field-pilot:findings:check
pnpm field-pilot:exit-review
```
