# STT failure spike — classroom noise

| Field | Value |
|-------|-------|
| **Finding ID** | `FP-002` |
| **Date** | 2026-07-16 |
| **Closed** | 2026-07-17 |
| **Severity** | `P1` |
| **Disposition** | **Closed** — noisy Indic STT fixture committed; confidence regression locked |
| **Affected spec** | `CK-05` (Voice as a first-class modality / `SpeechInterface`) |
| **subjectId** | `subj.pilot.learner.b2` |
| **deviceId** | `dev-android-mid-01` |
| **profile** | `android-mid` |
| **anomalyClass** | `stt_noise_spike` |
| **scopes.trajectoryExport** | `false` |
| **Fixture** | `hi-classroom-noise` in `packages/bindings-speech/fixtures/indic/` |
| **Re-test** | `packages/bindings-speech/tests/fp002_classroom_noise.test.mjs` |

## Observation

Indic STT error rate spiked under classroom ambient noise on the Android mid-range host (`pnpm offline-edge:speech` path). Turns still completed offline via typed input fallback; friction samples recorded hesitation / assistance metadata only — no raw audio transcript left the device.

## Repro

1. On `android-mid` with `sutra-bindings-speech`, run `pnpm offline-edge:speech` in a noisy room (or inject ambient noise into the mic path).
2. Speak an Indic / code-switched prompt; observe elevated STT error / low confidence partials.
3. Complete the turn via typed fallback; confirm friction row has metadata only (no transcript in sample or logs).
4. CI fixture: load `hi-classroom-noise` and assert final confidence ≤ 0.35 without enabling `trajectoryExport`.

## Closure evidence (2026-07-17)

1. Committed PCM fixture `hi-classroom-noise` (Indic + code-switch probe with `NOISE:classroom` ambient marker).
2. In-process whisper.cpp-class backend depresses `confidence` ≤ 0.35 under the marker (quiet fixtures remain high).
3. Unit tests assert partial→final streaming, depressed confidence, and metadata-only telemetry (`subjectId` scoped; no utterance body in events).
4. Speech cert profile requires `hi-classroom-noise` in `indicFixtures.requiredUtteranceIds`.

## Sovereignty

No raw learner utterance body in this record or in telemetry export. `trajectoryExport` remains `false` until B9 consent gates.
