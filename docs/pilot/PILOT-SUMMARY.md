# Field pilot summary — B8 evidence for Track A P7 freeze RFC

| Meta | Value |
|------|-------|
| **Window** | 2026-07-02 → 2026-07-16 (14 days) |
| **Matrix** | `android-mid` + `apple-silicon` (kit minimum) |
| **Pack** | `teacher-cbse-slice@1.0.0` |
| **Execution prove** | `pnpm field-pilot:execute` |
| **Findings packaging** | `pnpm field-pilot:findings:check` |
| **Exit review** | [`PILOT-EXIT-REVIEW.md`](./PILOT-EXIT-REVIEW.md) · `pnpm field-pilot:exit-review` |
| **Freeze RFC draft** | [`P7-FREEZE-RFC-DRAFT.md`](./P7-FREEZE-RFC-DRAFT.md) |
| **trajectoryExport** | `false` (B9 owns consent later) |

This summary indexes dated findings under [`findings/`](./findings/). One file per significant observation. Behavioral metadata only — never raw keystroke or utterance bodies.

## Finding index

| ID | Date file | Severity | Affected spec | Disposition |
|----|-----------|----------|---------------|-------------|
| `FP-001` | [`2026-07-16-sync-gap-offline-android.md`](./findings/2026-07-16-sync-gap-offline-android.md) | P2 | `CAST-01` | Closed — offline write-ahead expected |
| `FP-002` | [`2026-07-16-stt-classroom-noise.md`](./findings/2026-07-16-stt-classroom-noise.md) | P1 | `CK-05` | **Closed** — `hi-classroom-noise` fixture + `fp002_classroom_noise.test.mjs` |
| `FP-003` | [`2026-07-16-routing-guidance-review.md`](./findings/2026-07-16-routing-guidance-review.md) | P3 | `ATR-01` | Closed — guidance-eval parity held |
| `FP-004` | [`2026-07-16-exit-review-signoff.md`](./findings/2026-07-16-exit-review-signoff.md) | P3 | `CAST-01` / `ATR-01` | Closed — privacy + `markSynced` + routing exit sign-off |

## Edge cases exercised

| Case | Result |
|------|--------|
| Device offline entire window | Samples persist `synced=0`; sync gap advisories; idempotent `markSynced` on reconnect (`FP-001`) |
| STT spike in classroom noise | Finding + fixture request; typed fallback; no utterance export (`FP-002`) |
| Restart mid-operation | Pre-`submitted` discard; post-write-ahead survival |
| Concurrent two devices | Distinct `subjectId`×`deviceId`; same-subject dual device rejected |
| Replayed sync | `markSynced` idempotent |
| Exit privacy / routing sign-off | [`PILOT-EXIT-REVIEW.md`](./PILOT-EXIT-REVIEW.md) (`FP-004`) |

## Sovereignty

Every finding is scoped by `subjectId` and `deviceId`. No raw learner content leaves `on-device` / `self-hosted`. Observability events use the same scope fields and named failure classes — never silent catch-and-continue.

## How this feeds P7

Track A freeze RFC (`rfcs/0001-protocol-1.0-freeze.md`, authored under FREERFC-001) **must** cite this summary from its field-pilot evidence appendix. Until that RFC exists, [`P7-FREEZE-RFC-DRAFT.md`](./P7-FREEZE-RFC-DRAFT.md) is the authoritative draft link surface. Exit sign-off: [`PILOT-EXIT-REVIEW.md`](./PILOT-EXIT-REVIEW.md).
