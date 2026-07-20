# Certified Binding — checklist and badge criteria

Public governance for third-party and in-repo `SlmRuntime` adapters. One command answers “is this adapter safe to ship?”:

```bash
pnpm --filter sutra-bindings-slm exec node ./bin/bindings-slm.mjs certify --profile <profile> --adapter <adapter>
```

Every badge criterion below maps to an **automated** harness check. There are no manual-only requirements.

| Artifact | Path |
|----------|------|
| Profile registry | [`packages/bindings-slm/certification/registry.json`](../../packages/bindings-slm/certification/registry.json) |
| Report schema | [`packages/bindings-slm/certification/schemas/certification.report.schema.json`](../../packages/bindings-slm/certification/schemas/certification.report.schema.json) (`bindings-slm.certification.report.v1`) |
| Package quickstart (&lt; 15 min) | [`packages/bindings-slm/README.md`](../../packages/bindings-slm/README.md) |
| B6 phase PRD | [`docs/bindings/b6-native-bindings-PRD.md`](./b6-native-bindings-PRD.md) |
| B0 model obligation catalog | [`packages/contract-conformance/src/obligations/model.ts`](../../packages/contract-conformance/src/obligations/model.ts) (`CK-03.1`–`CK-03.3`) |
| Conformance implementor path | [`docs/sdk/conformance-stub-guide.md`](../sdk/conformance-stub-guide.md) · [`binding-certification-guide.md`](../sdk/binding-certification-guide.md) |
| One-command proof | [`packages/bindings-slm/certification/proofs/one-command.proof.json`](../../packages/bindings-slm/certification/proofs/one-command.proof.json) |

---

## 1. Profiles (authoritative registry)

CLI `--profile` values come from `registry.json`:

| Profile id | Adapter | Hardware class | Committed report |
|------------|---------|----------------|------------------|
| `desktop` | `llamacpp` | cpu | `certification/reports/certification.report.json` |
| `android-mid` (alias `android`) | `onnx` | mid-range-android | `android/certification/reports/android.cert.json` |
| `apple-silicon` | `mlx` | apple-silicon | `macos/certification/reports/apple-silicon.cert.json` |

New engines land by adding a registry row + profile JSON + a green committed report — not by informal checklist checkmarks.

---

## 2. Human checklist (per profile)

Run in order. Fail-fast on the first red DIFF.

### 2.1 Prerequisites

- [ ] Adapter implements `SlmRuntime` / harness factory used by the certify CLI (no HTTP sidecar required for on-device locality).
- [ ] Profile JSON declares `subjectId`, `deviceId`, pinned `modelArtifact.artifactSha256`, B0 obligation ids, B1 zero-egress ops, and P4 bench subset.
- [ ] Fixture weights exist at the profile’s `fixtureRelpath` (missing artifact → typed fail before the obligation loop).

**Automated:** artifact phase in `runUnifiedCertifyOrchestration` / adapter certify paths; `CERT FAIL` on stderr for missing or mismatched hashes.

### 2.2 Conformance (B0 / CK-03)

- [ ] Selected obligations match the profile (`CK-03.1`, `CK-03.2`, `CK-03.3` for shipped profiles).
- [ ] Every `obligationVerdicts[].outcome` is `pass`.

**Automated:** B0 phase via `@moolam/contract-conformance` with `CERTIFICATION_CHECK_DEADLINE_MS` (5s) per check.

### 2.3 Locality (B1)

- [ ] `egressRecord.ok === true`
- [ ] `egressRecord.attemptCount === 0` for `zeroEgressOps` (`generate`, `embed`)
- [ ] Report and telemetry carry `subjectId` / `deviceId`; never utterance or prompt bodies

**Automated:** B1 egress-recorder harness; schema rejects content-body fields on the unified report.

### 2.4 Perf (P4)

- [ ] `p95Benches.first_token.ok === true` within profile `budgetP95Ms` (NFR-01 mid-range ceiling is ≤1500ms p95; desktop CI uses the profile floor/budget)
- [ ] When the profile includes `core_loop`, `p95Benches.core_loop.ok === true` (NFR-06 absolute-ceiling-plus-relative-baseline)

**Automated:** P4 phase in the unified harness; thresholds/baseline under `benchmarks/gates/`.

### 2.5 Aggregate

- [ ] CLI exit code `0`
- [ ] Report `outcome === "pass"` and `failures` is `[]`
- [ ] Committed report path matches the registry `committedReportRelpath` for that profile

**Automated:** certify CLI exit code; schema validation (`validateCertificationReport`); CI jobs `binding-certify-harness`, `llama-cpp-desktop-cert`, `onnx-mobile-android-cert`, `mlx-apple-silicon-cert`.

---

## 3. Badge criteria (tied to report fields)

The **Certified Binding** mark may be displayed for a `(adapter, profile)` pair only when a committed report satisfies **all** rows. Each row names the harness field — no discretionary exceptions.

| # | Badge criterion | Report / harness field | Automated check |
|---|-----------------|------------------------|-----------------|
| B1 | Aggregate pass | `outcome === "pass"` and `failures.length === 0` | CLI exit 0; schema |
| B2 | Schema pin | `schemaVersion === "bindings-slm.certification.report.v1"` (or adapter-specific `bindings-slm.cert-report.v1` for mobile legacy reports that still carry the same verdict fields) | `validateCertificationReport` / CI copy of schema |
| B3 | Identity | `adapter`, `profileId` match registry entry | registry lookup + CLI `--adapter` match |
| B4 | Artifact pin | `measuredArtifactSha256 === modelArtifactSha256` (64-hex) | artifact phase |
| B5 | B0 green | every `obligationVerdicts[].outcome === "pass"` for profile `b0Model` | B0 runner |
| B6 | B1 zero egress | `egressRecord.ok === true` and `attemptCount === 0` | B1 recorder |
| B7 | P4 first token | `p95Benches.first_token.ok === true` | P4 probe |
| B8 | Subject isolation | non-empty `subjectId` and `deviceId`; concurrent certifies must not cross-contaminate ids | report required fields + isolation tests |
| B9 | Deadline budget | harness uses `deadlineMs` ≤ `CERTIFICATION_CHECK_DEADLINE_MS` (5000) per check | runner constant |

### Badge SVG / mark rules

- **Text:** `Certified Binding`
- **Subtitle (required):** `{adapter} · {profileId}` taken from the report (never from marketing copy alone)
- **Color:** solid mark only when B1–B9 hold; no “provisional” or grey badge
- **Link target (recommended):** the committed report path from the registry for that profile
- **Forbidden:** displaying the mark from a red report, a report missing `subjectId`/`deviceId`, or a report that embeds utterance/prompt bodies

Minimal SVG skeleton (fill only after B1–B9 pass):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="48" role="img" aria-label="Certified Binding">
  <rect width="220" height="48" rx="4" fill="#1a1a1a"/>
  <text x="12" y="20" fill="#f5f5f5" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" font-weight="600">Certified Binding</text>
  <text x="12" y="38" fill="#b0b0b0" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">llamacpp · desktop</text>
</svg>
```

Replace the subtitle with the report’s `adapter` and `profileId`.

---

## 4. Worked examples (real in-repo artifacts)

### 4.1 Desktop / llama.cpp (unified report)

Source: [`packages/bindings-slm/certification/reports/certification.report.json`](../../packages/bindings-slm/certification/reports/certification.report.json)

Excerpt (fields that gate the badge):

```json
{
  "schemaVersion": "bindings-slm.certification.report.v1",
  "outcome": "pass",
  "profileId": "desktop",
  "adapter": "llamacpp",
  "subjectId": "cert.desktop.llamacpp",
  "deviceId": "ci-desktop-cpu",
  "modelArtifactSha256": "f1ae43bcd01bb341ebe4159b0dd0f5ca6742d7a3680b65d3469a5b9af04d02b9",
  "measuredArtifactSha256": "f1ae43bcd01bb341ebe4159b0dd0f5ca6742d7a3680b65d3469a5b9af04d02b9",
  "obligationVerdicts": [
    { "obligationId": "CK-03.1", "outcome": "pass" },
    { "obligationId": "CK-03.2", "outcome": "pass" },
    { "obligationId": "CK-03.3", "outcome": "pass" }
  ],
  "egressRecord": {
    "ok": true,
    "attemptCount": 0,
    "zeroEgressOps": ["generate", "embed"],
    "obligationId": "CK-03.3"
  },
  "p95Benches": {
    "first_token": { "nfrId": "NFR-01", "budgetP95Ms": 1500, "ok": true },
    "core_loop": { "nfrId": "NFR-06", "configured": true, "ok": true }
  },
  "failures": []
}
```

### 4.2 Mobile / ONNX (`android-mid`)

Source: [`packages/bindings-slm/android/certification/reports/android.cert.json`](../../packages/bindings-slm/android/certification/reports/android.cert.json)

```json
{
  "outcome": "pass",
  "profileId": "android",
  "adapter": "onnx",
  "subjectId": "cert.android.onnx",
  "deviceId": "ci-android-mid-range",
  "egressRecord": { "ok": true, "attemptCount": 0 },
  "obligationVerdicts": [
    { "obligationId": "CK-03.1", "outcome": "pass" },
    { "obligationId": "CK-03.2", "outcome": "pass" },
    { "obligationId": "CK-03.3", "outcome": "pass" }
  ],
  "failures": []
}
```

### 4.3 One-command proof (llama.cpp + one mobile)

Source: [`packages/bindings-slm/certification/proofs/one-command.proof.json`](../../packages/bindings-slm/certification/proofs/one-command.proof.json) — `exitCode: 0`, seeded hash violation `seededRed.ok: true` with `exitCode: 1`, green targets `desktop`/`llamacpp` and `android-mid`/`onnx`.

### 4.4 Red path (must not badge)

Seeded hash mismatch fails the single certify command (`CERT FAIL` + non-zero exit). Reports with `outcome: "fail"` or non-empty `failures` **must not** display the Certified Binding mark.

---

## 5. Third-party submission process

1. **Implement** an adapter factory consumable by the certify harness (same contracts as in-repo adapters).
2. **Add** a profile under `packages/bindings-slm/certification/` and a registry entry (`id`, `adapter`, `profileRelpath`, `committedReportRelpath`).
3. **Run** one command locally and in CI:

   ```bash
   pnpm --filter sutra-bindings-slm exec node ./bin/bindings-slm.mjs certify --profile <id> --adapter <adapter> --report-out <path>
   ```

4. **Commit** the green report at the registry path; open a PR that includes profile + report + CI job wiring (mirror existing certify jobs).
5. **Badge** only after CI is green and B1–B9 hold on the committed report.
6. **Replay / concurrency:** re-running certify must stay idempotent (same exit / pass); concurrent subjects must keep distinct `subjectId` values in reports (isolation defect = reject).

Merge policy: no new engine merges without a green committed report referenced by the registry. Partial failure after the first durable report write is still a red aggregate until `outcome` is `pass`.

---

## 6. Sovereignty, isolation, observability

- Scope every certify run by `subjectId` / `deviceId` (report required fields).
- Locality boundary is `on-device` / `self-hosted` as declared; B1 proves zero egress on `generate`/`embed`.
- Structured events use event `bindings_slm.certify` (and prove event `bindings_slm.one_command_prove`) with outcome classes — never raw learner content.
- Distinct failure classes surface as `CERT FAIL` DIFF lines (hash mismatch, missing artifact, obligation fail, schema DIFF).

---

## 7. Spec references

- CK-03 — provider-agnostic models with locality ([`docs/PRD_MATRIX.md`](../PRD_MATRIX.md))
- B0 model obligations — [`MODEL_OBLIGATION_IDS`](../../packages/contract-conformance/src/obligations/model.ts) / [`DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS`](../../packages/contract-conformance/src/obligations/model.ts) (`CK-03.1` embed dimension, `CK-03.2` stream deltas, `CK-03.3` locality truthful)
- NFR-01 — first-token p95 · NFR-06 — core loop gates
- Phase B6 PRD — [`b6-native-bindings-PRD.md`](./b6-native-bindings-PRD.md)
- Package certify quickstart — [`packages/bindings-slm/README.md`](../../packages/bindings-slm/README.md)
