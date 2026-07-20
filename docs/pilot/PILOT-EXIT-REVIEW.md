# Pilot exit review — telemetry privacy & routing quality sign-off

| Meta | Value |
|------|-------|
| **Date** | 2026-07-16 |
| **Window** | 2026-07-02 → 2026-07-16 |
| **Matrix** | `android-mid` + `apple-silicon` |
| **Reviewer role** | Field pilot exit (B8) |
| **Prove** | `pnpm field-pilot:exit-review` |
| **Summary** | [`PILOT-SUMMARY.md`](./PILOT-SUMMARY.md) |
| **Freeze draft** | [`P7-FREEZE-RFC-DRAFT.md`](./P7-FREEZE-RFC-DRAFT.md) |
| **Dated record** | [`findings/2026-07-16-exit-review-signoff.md`](./findings/2026-07-16-exit-review-signoff.md) |

## 1. Telemetry privacy sign-off

| Check | Result |
|-------|--------|
| Raw keystroke / utterance content in `FrictionSample` export | **Pass** — schema is metadata columns only (`captured_at`, `concept_id`, `hesitation_ms`, `input_velocity`, `revision_count`, `assistance_requested`, `outcome`, `synced`) |
| Host `input` events | **Pass** — `charsDelta` only; no string payload in `InteractionEvent` |
| `trajectoryExport` / `rawKeystrokeExport` / `utteranceExport` | **Pass** — all `false` for this pilot (B9 owns trajectory consent) |
| Findings / logs | **Pass** — no utterance bodies; scoped by `subjectId` × `deviceId` |

**Sign-off:** Privacy invariants for CAST-01 / CAST-02 hold for the pilot window. No raw keystroke export.

## 2. `markSynced` audit

| Step | Result |
|------|--------|
| Write-ahead persist before ack | Confirmed via `CognitiveTelemetryCollector.submitted` → `INSERT OR IGNORE` |
| Offline window (`FP-001`) | Samples remain `synced=0` until reconnect |
| Successful sync path | `unsynced()` → compaction → `markSynced(capturedAt[])` |
| Idempotent replay | Replaying the same timestamps does not double-apply |
| Restart after write-ahead | Durable rows survive; half-open exercises leave no sample |
| Bounded scans | `unsynced` / `durableSampleCount` / `castIntegrityProbe` only — no unbounded `SELECT *` |

**Sign-off:** `markSynced` audit complete. Sync-gap advisories recorded; no silent catch-and-continue.

## 3. Routing quality sign-off

| Check | Result |
|-------|--------|
| Guidance-eval parity (`FP-003`) | **Pass** — teacher corpus `routeAction` matched expectations (`pnpm field-pilot:execute` / `pnpm guidance:eval`) |
| Aggregate threshold | `minAggregateScore: 0.85` held for committed scenarios |
| Concurrent subject isolation | Distinct `subjectId`×`deviceId`; same-subject dual device rejected |

**Sign-off:** Routing quality acceptable for B8 exit. No RFC-blocking routing drift in this window.

## 4. Guidance eval gaps — follow-up or RFC blockers

| ID | Gap | Disposition |
|----|-----|-------------|
| `FP-002` | Indic STT classroom-noise fixture | **Closed** — `hi-classroom-noise` fixture + `packages/bindings-speech/tests/fp002_classroom_noise.test.mjs` |
| — | Trajectory export consent | Deferred to B9 (explicit consent gate) — out of pilot scope |

## 5. Exit decision

| Gate | Status |
|------|--------|
| Telemetry privacy | **Signed off** |
| `markSynced` audit | **Signed off** |
| Routing quality | **Signed off** |
| Open P1 gaps | `FP-002` **Closed** with classroom-noise fixture evidence |
| Pilot submodule | **Exit complete** — evidence feeds Track A P7 via PILOT-SUMMARY |

Observability: exit-review gate emits `field_pilot.exit_review` events with `subjectId`, `deviceId`, and named failure classes — never learner content.
