# Guidance eval scenarios

Versioned fixtures for **routing-quality** gates (TaskRouter / playground), not
training-gym language guidance packs.

| Path | Role |
|------|------|
| [`schemas/scenario-v1.json`](../schemas/scenario-v1.json) | Scenario JSON Schema |
| [`schemas/rubric-v1.json`](../schemas/rubric-v1.json) | Rubric JSON Schema |
| [`../rubric.json`](../rubric.json) | Committed partial-score weights + `failBelow` |
| [`teacher/`](./teacher/) | Teacher CBSE-slice goldens (≥8) + `manifest.json` |
| `format-example-*.json` | Format proofs (hysteresis hold, multi-weak remediate) |
| `invalid/` | Negative fixtures for schema rejection |

Scorer + CI threshold wiring follow in EVALSCEN-003 / EVALCIGATE.

**Invariant:** friction rows are protocol `FrictionSample` shapes — no raw
keystrokes or utterance fields (`additionalProperties: false`).
