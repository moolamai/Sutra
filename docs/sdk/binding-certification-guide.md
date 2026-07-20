# Binding certification guide — model adapter pass / fail

Certify a **model** adapter (then speech / vision with the same report shape) through the **conformance (B0 / CK-03)** and **locality (B1)** suites. Interpret green vs red from the unified certification report — never display a Certified Binding mark from a red report.

**Verified:** 2026-07-16 · Node.js 22 · pnpm 10.30.3 · `sutra-bindings-slm` certify CLI (desktop / `llamacpp` profile).

> Obligation stub path first: [conformance-stub-guide.md](./conformance-stub-guide.md).  
> Authoritative badge table: [CERTIFIED-BINDING.md](../bindings/CERTIFIED-BINDING.md).

## Pipeline (what runs)

| Phase | Suite | Pass when |
|-------|-------|-----------|
| B0 | Model obligations `CK-03.1`, `CK-03.2`, `CK-03.3` | Every `obligationVerdicts[].outcome === "pass"` |
| B1 | Locality / zero-egress | `egressRecord.ok === true` and `attemptCount === 0` for `generate` / `embed` |
| P4 | Perf budgets (NFR-01 / NFR-06) | `p95Benches.*.ok === true` within profile budgets |
| Aggregate | Report + CLI | `outcome === "pass"`, `failures` empty, process exit **0** |

Reports always carry `subjectId` and `deviceId`. They must **never** embed utterance or prompt bodies.

## 1. Prerequisites

```bash
node -v   # v22.x
pnpm -v   # 10.30.3
```

```bash
pnpm add -D sutra-bindings-slm @moolam/contract-conformance
# or from a Sutra checkout:
#   pnpm install --frozen-lockfile
#   pnpm --filter sutra-bindings-slm build
```

Profile ids (authoritative registry in the bindings package): `desktop` (llamacpp), `android-mid` (onnx), `apple-silicon` (mlx).

## 2. One-command certify (model / desktop)

```bash
pnpm --filter sutra-bindings-slm run certify
```

Equivalent explicit form (same gate):

```bash
pnpm --filter sutra-bindings-slm exec bindings-slm certify --profile desktop --adapter llamacpp
```

> When the package is published: `pnpm exec bindings-slm certify --profile desktop --adapter llamacpp` (binary name from `sutra-bindings-slm`).

### Pass (green)

- Process exit **0**
- Stdout JSON includes `"outcome":"pass"`
- No `CERT FAIL` on stderr
- `obligationVerdicts` all `pass` for `CK-03.1` / `CK-03.2` / `CK-03.3`
- `egressRecord.ok === true` and `attemptCount === 0`
- Non-empty `subjectId` / `deviceId`

Worked excerpt (field names only — no content bodies):

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
  "failures": []
}
```

### Fail (red) — how to read it

| Symptom | Likely phase | What to fix |
|---------|--------------|-------------|
| Exit ≠ 0 + `CERT FAIL` on stderr | Aggregate | Read the DIFF line — named field / obligation |
| `obligationVerdicts[].outcome` is `fail` / `timeout` | B0 conformance | Fix that `obligationId` (e.g. `CK-03.3` locality truth) |
| `egressRecord.ok === false` or `attemptCount > 0` | B1 locality | Remove network egress from `generate` / `embed` |
| Artifact hash mismatch | Artifact pin | Fixture / weights must match profile `modelArtifact.artifactSha256` |
| Missing `subjectId` / `deviceId` | Isolation | Profile JSON must declare both — concurrent certifies must not cross-contaminate |
| `p95Benches.first_token.ok === false` | P4 | Meet profile `budgetP95Ms` (NFR-01 mid-range ceiling ≤ 1500 ms p95) |

Replayed certify runs are **idempotent** — do not double-apply side effects when re-running after a red. Partial failure after the first durable cert write still means **red** until a full green report exists.

Downstream timeout → typed `timeout` / `CERT FAIL`, never an unhandled rejection or silent continue.

## 3. Locality & sovereignty

- On-device adapters must not ship subject content off-box during `zeroEgressOps`.
- Model output is untrusted input — validate at the binding boundary before use.
- Concurrent certification jobs for different `subjectId`s must not share mutable adapter state.
- Never log raw learner content in certify events or reports.

## 4. Speech / vision

Same certify entry point and report schema. Swap `--adapter` / `--profile` per the registry (see [CERTIFIED-BINDING.md](../bindings/CERTIFIED-BINDING.md) §1). Badge criteria B1–B9 still apply — there is no manual-only path.

Optional prove (seeded red → green) inside Sutra:

```bash
pnpm --filter sutra-bindings-slm run prove:one-command
```

## 5. When may you show the mark?

Only when **all** badge rows in [CERTIFIED-BINDING.md](../bindings/CERTIFIED-BINDING.md) §3 hold for that `(adapter, profile)` pair. Forbidden: displaying the mark from a red report, a report missing identity fields, or a report that embeds utterance/prompt bodies.

## Checklist

- [ ] Stub / B0 obligations green for your factory ([conformance-stub-guide.md](./conformance-stub-guide.md))
- [ ] `certify --profile … --adapter …` exits 0 with `outcome: "pass"`
- [ ] B0 + B1 fields interpreted as above
- [ ] Report has `subjectId` / `deviceId`; no content bodies
- [ ] Badge criteria reviewed in [CERTIFIED-BINDING.md](../bindings/CERTIFIED-BINDING.md)
