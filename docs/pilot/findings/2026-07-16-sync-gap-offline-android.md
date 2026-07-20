# Sync gap — offline Android mid-range window

| Field | Value |
|-------|-------|
| **Finding ID** | `FP-001` |
| **Date** | 2026-07-16 |
| **Severity** | `P2` |
| **Disposition** | Closed — expected sovereign offline behavior; noted for freeze RFC evidence |
| **Affected spec** | `CAST-01` (Friction sampling / write-ahead) · related `CAST-02` |
| **subjectId** | `subj.pilot.learner.a1` |
| **deviceId** | `dev-android-mid-01` |
| **profile** | `android-mid` |
| **anomalyClass** | `sync_gap` |
| **scopes.trajectoryExport** | `false` |

## Observation

Primary Android mid-range device stayed offline for the full two-week pilot window (network denied / classroom without egress). Friction samples were write-ahead persisted on-device (`synced=0`). When sync was later allowed, `unsynced()` → SyncResponse compaction → `markSynced(capturedAt[])` drained the gap. Replaying the same timestamps stayed idempotent (no double-count).

## Repro

1. Assemble offline bundle per [`FIELD-PILOT-KIT.md`](../FIELD-PILOT-KIT.md) on `android-mid`.
2. Hold consent with `frictionSamplePersist: true`, `frictionSampleSync: true`, `trajectoryExport: false`.
3. Deny network for 14 calendar days; run ≥1 turn/day (`pnpm field-pilot:execute` simulates this window).
4. Confirm `castIntegrityProbe().unsyncedCount === durableCount` each day.
5. Re-enable network; drain via `unsynced()` → sync → `markSynced`; replay same `capturedAt[]` (idempotent).

## Daily friction review

Bounded probes only (`castIntegrityProbe`, `unsynced`, `durableSampleCount`) — never unbounded `SELECT *` of the friction log. Sync-gap advisory emitted as `field_pilot.sync_gap` with `subjectId` / `deviceId` / outcome (no utterance text).

## Sovereignty

Behavioral metadata only. Never raw keystroke content, never utterance bodies, never trajectory export.
