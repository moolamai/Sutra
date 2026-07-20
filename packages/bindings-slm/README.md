# `sutra-bindings-slm`

Native on-device SLM bindings (llama.cpp / ONNX Runtime Mobile / MLX) implementing `SlmRuntime` without an HTTP sidecar.

## Certification (start here)

| Doc | Role |
|-----|------|
| [`docs/sdk/binding-certification-guide.md`](../../docs/sdk/binding-certification-guide.md) | Stranger-facing certify + pass/fail interpretation |
| [`docs/bindings/CERTIFIED-BINDING.md`](../../docs/bindings/CERTIFIED-BINDING.md) | Public checklist, badge criteria B1–B9, third-party submission |
| [B6 phase PRD](../../docs/bindings/b6-native-bindings-PRD.md) | Phase intent, exit gates, Spec ID CK-03 |
| [B0 model obligations](../contract-conformance/src/obligations/model.ts) | `CK-03.1` / `CK-03.2` / `CK-03.3` catalog (`MODEL_OBLIGATION_IDS`) |
| [Conformance stub guide](../../docs/sdk/conformance-stub-guide.md) | Obligation CLI against a stub (&lt; 15 min) |
| [Conformance quickstart](../../docs/sdk/conformance-quickstart.md) | Broader B0 harness implementor path |

`bindings-slm certify` is the **only** certification entry point. Every badge criterion maps to an automated harness field — never display the Certified Binding mark from a red report.

---

## Quickstart: certify llama.cpp locally (&lt; 15 minutes)

Budget assumes Node 22, pnpm 10.30.3, and a warm install. Cold `pnpm install` is network-bound; the certify run itself is seconds.

### 1. Prerequisites

```bash
node -v   # v22.x
pnpm -v   # 10.30.3
```

### 2. Install + build (once)

From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter sutra-bindings-slm build
```

### 3. One-command certify (desktop / llama.cpp)

```bash
pnpm --filter sutra-bindings-slm exec node ./bin/bindings-slm.mjs certify --profile desktop --adapter llamacpp
```

Or: `pnpm --filter sutra-bindings-slm run certify`

**Green:** exit code `0`, stdout JSON includes `"outcome":"pass"`, no `CERT FAIL` on stderr.

**Red (expected on breach):** non-zero exit + `CERT FAIL` DIFF (e.g. artifact hash mismatch). Replayed runs are idempotent; do not double-apply side effects.

### 4. Read the committed llama.cpp report

After a green run, the unified harness writes:

[`certification/reports/certification.report.json`](./certification/reports/certification.report.json)

Worked example (real fields — no utterance bodies):

```json
{
  "schemaVersion": "bindings-slm.certification.report.v1",
  "outcome": "pass",
  "profileId": "desktop",
  "adapter": "llamacpp",
  "subjectId": "cert.desktop.llamacpp",
  "deviceId": "ci-desktop-cpu",
  "obligationVerdicts": [
    { "obligationId": "CK-03.1", "outcome": "pass" },
    { "obligationId": "CK-03.2", "outcome": "pass" },
    { "obligationId": "CK-03.3", "outcome": "pass" }
  ],
  "egressRecord": { "ok": true, "attemptCount": 0 },
  "p95Benches": {
    "first_token": { "nfrId": "NFR-01", "budgetP95Ms": 1500, "ok": true },
    "core_loop": { "nfrId": "NFR-06", "ok": true }
  },
  "failures": []
}
```

Interpret verdicts against the [B0 catalog](../contract-conformance/src/obligations/model.ts) and the [badge table](../../docs/bindings/CERTIFIED-BINDING.md#3-badge-criteria-tied-to-report-fields). Reports always carry `subjectId` / `deviceId`; concurrent subjects must not cross-contaminate.

### 5. Optional: mobile + one-command prove

```bash
pnpm --filter sutra-bindings-slm exec node ./bin/bindings-slm.mjs certify --profile android-mid --adapter onnx
pnpm --filter sutra-bindings-slm run prove:one-command
```

---

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm certify` | Desktop llama.cpp certify |
| `pnpm certify:android` | ONNX mid-range Android (`android-mid`) |
| `pnpm certify:apple-silicon` | MLX Apple silicon |
| `pnpm prove:one-command` | Seeded red + green prove for desktop + android-mid |

Profiles: [`certification/registry.json`](./certification/registry.json) · Schema: [`certification/schemas/certification.report.schema.json`](./certification/schemas/certification.report.schema.json)
