# Trajectory schema changelog

All notable changes to the committed `TurnTrajectoryRecord` JSON Schema
(`schemas/trajectory/v1.json`) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Schema evolution is **additive only** (MINOR bumps). Dense on-device SLMs may
omit `routerReplayMap`; parsers must accept absence.

Metadata-only: never raw learner content, utterances, or keystroke streams.

## [Unreleased]

## [trajectory.v1] — 2026-07-15 (W3 freeze)

### Added

- Committed JSON Schema export for `TurnTrajectoryRecord` at
  `schemas/trajectory/v1.json`, generated deterministically from
  `@moolam/learning` `turnTrajectoryRecordSchema` via `schemas:export`.
- C0 training fields (optional, additive over B9 metadata records):
  - `policyCheckpointHash` — exact adapter/base checkpoint (never floating
    `latest`)
  - `precisionFormat` — quantization tag (`fp32` | `fp16` | `bf16` | `int8` |
    `int4` | `nf4`)
  - `executionState` — `{ commandExecuted, statusCode }` (stream abort must
    record last attempted command, not omit)
  - `routerReplayMap` — forward-compat; dense SLMs may omit
    (`x-forward-compat.routerReplayMap.denseSlmMayOmit: true`)
- Consent object required on every record; export gate requires
  `consent.optedIn === true` (sovereign boundary).
- CI drift gate: regenerated export must match the committed file byte-for-byte
  (`pnpm --filter @moolam/learning schemas:check`).
