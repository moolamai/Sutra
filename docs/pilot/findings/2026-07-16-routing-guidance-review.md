# Routing vs guidance eval — daily friction review

| Field | Value |
|-------|-------|
| **Finding ID** | `FP-003` |
| **Date** | 2026-07-16 |
| **Severity** | `P3` |
| **Disposition** | Closed — parity held; evidence for freeze RFC (no RFC-blocking drift) |
| **Affected spec** | `ATR-01` (Cyclical remediation routing) · related guidance-eval threshold |
| **subjectId** | `subj.pilot.learner.a1` |
| **deviceId** | `dev-apple-silicon-01` |
| **profile** | `apple-silicon` |
| **anomalyClass** | `routing_guidance_review` |
| **scopes.trajectoryExport** | `false` |
| **Pack** | `teacher-cbse-slice@1.0.0` |

## Observation

Across the 14-day pilot window, operators reviewed friction samples daily (bounded) and compared observed `routeAction` / `targetConceptId` against guidance-eval scenario expectations (`evals/guidance/scenarios/teacher/*`, threshold `minAggregateScore: 0.85`). Parity held for the committed teacher corpus; no RFC-blocking routing drift in this window.

Concurrent turns used distinct `subjectId`×`deviceId` pairs. Same-subject dual-device access was rejected. Mid-turn restart before `submitted` discarded partial evidence; post-write-ahead restart retained `synced=0` samples.

## Repro

1. Run `pnpm field-pilot:execute` (14-day matrix + `castIntegrityProbe` reviews) or equivalent on-device daily review.
2. Compare observed routes to `evals/guidance/scenarios/teacher/*` via `routerActualFromScenario` (same path as `pnpm guidance:eval`).
3. Confirm each golden `expected.routeAction` matches observed; emit `field_pilot.execution` `routing_compare` events with `subjectId` / `deviceId` (never utterance text).
4. Restart mid-turn before `submitted` → no durable sample; after write-ahead → `synced=0` survives.

## Sovereignty

Findings and review events carry `subjectId` / `deviceId` / outcome only — never raw keystroke or utterance content.
