# Speech certification

CI gate for Indic speech bindings: B0 speech obligations (`CK-05.1` partial streaming, `CK-05.2` language fallback) against **both** STT and TTS factories, the committed Indic utterance fixture pack, and **NFR-07** voice round-trip (final transcript → first synthesized audio) on the mid-range Android device profile.

```bash
pnpm --filter sutra-bindings-speech run certify:speech
pnpm --filter sutra-bindings-speech run prove:speech-cert
```

| Artifact | Path |
|----------|------|
| Profile | [`profile.json`](./profile.json) |
| Device profile (NFR-07) | [`device-profiles/mid-range-android.json`](./device-profiles/mid-range-android.json) |
| Voice RTT baseline | [`voice-rtt.baseline.json`](./voice-rtt.baseline.json) |
| Report schema | [`schemas/speech.cert.report.schema.json`](./schemas/speech.cert.report.schema.json) |
| Committed report | [`reports/speech.cert.json`](./reports/speech.cert.json) |

NFR-07 gate: absolute ceiling **≤ 2500ms p95** (PRD_MATRIX) plus relative regression vs the recorded baseline (`performance.now` clocks — not mocked alone). Failures print `SPEECH CERT FAIL DIFF` with measured vs budget — never raw utterance or synthesis bodies.
