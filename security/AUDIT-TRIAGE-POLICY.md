# Dependency audit triage policy

| Meta | Value |
|------|-------|
| **Spec** | SEC-02 |
| **Phase** | P7 — Production hardening and 1.0 |
| **Status** | Active — initial suppression inventory recorded 2026-07-16 |
| **Suppressions** | [`AUDIT-SUPPRESSIONS.json`](./AUDIT-SUPPRESSIONS.json) |
| **CI gate** | `pnpm audit:gate` — `scripts/run-audit-gate.mjs` |

Adopters inherit every dependency Sutra ships. CI runs `pnpm audit` on the JavaScript lockfile and `pip-audit` on `packages/cloud-orchestrator` on every pull request. This policy defines what blocks merge and how known acceptable risks are documented — **not blind ignore**. Every critical/high advisory is either fixed, suppressed with expiry and owner, or it fails the gate.

## Severity thresholds

| Severity | Gate effect | Operator action |
|----------|-------------|-----------------|
| **critical** | Blocks merge until fixed or explicitly suppressed | Fix in the same PR when a patched version exists; otherwise open a suppression with a dated remediation path |
| **high** | Blocks merge until fixed or explicitly suppressed | Same as critical |
| moderate | Logged; does not block merge | Track in the inventory below; promote to a fix PR when cost is low |
| low | Logged; does not block merge | No mandatory action |

Severity is taken from the advisory feed (`pnpm audit` severity field; pip findings without a severity are treated as **high** by the gate — see `scripts/run-audit-gate.mjs`).

## Suppression rules

A critical or high advisory may be suppressed only when every field in [`AUDIT-SUPPRESSIONS.json`](./AUDIT-SUPPRESSIONS.json) is present and valid:

| Field | Requirement |
|-------|-------------|
| `advisoryIds` | At least one of: npm advisory id, GHSA id, or CVE id — the gate matches any id |
| `ecosystem` | `npm` or `pip` |
| `package` | Affected package name (exact match to the audit report) |
| `severity` | Filed severity (`critical` or `high`) |
| `owner` | Named owner responsible for re-review |
| `expiresOn` | ISO date (`YYYY-MM-DD`); **expired suppressions fail CI** |
| `rationale` | Why the risk is acceptable for this release window (≥ 20 characters); must name a remediation path or deployment constraint |

Suppressions are triage decisions, not permanent waivers. The gate treats an expired suppression as absent — the advisory blocks merge again until fixed or re-approved with a new expiry.

### Worked example — suppress (real)

Advisory `1123525` / `GHSA-fx2h-pf6j-xcff` / `CVE-2026-53571` (vite, **high**, `server.fs.deny` bypass on Windows alternate paths) is suppressed through 2026-10-01:

```json
{
  "advisoryIds": ["1123525", "GHSA-fx2h-pf6j-xcff", "CVE-2026-53571"],
  "ecosystem": "npm",
  "package": "vite",
  "severity": "high",
  "owner": "Track A lead",
  "expiresOn": "2026-10-01",
  "rationale": "Vite is a dev/build dependency for docs-site and playground only; production edge and cloud artifacts do not bundle vite. Patched major upgrade tracked for the next release window."
}
```

Removing this row (or letting `expiresOn` pass) turns the `dependency-audit` CI job red and prints `advisoryIds=1123525,GHSA-fx2h-pf6j-xcff,CVE-2026-53571` on stderr.

### Worked example — do not suppress (fix instead)

If a **critical** advisory appears in a runtime dependency of `@moolam/sync-protocol` or `sutra-sdk` (PyPI) with a patched version on the same major, the correct action is a lockfile / dependency bump PR — **not** a suppression. Suppressions are for deployment-bounded or remediable-later risks; a reachable remote RCE in a shipped package is never an acceptable residual.

## Quarterly review cadence

| Cadence field | Role |
|---------------|------|
| `lastReviewed` | Date of the last human review of the suppression file |
| `nextReviewDue` | Target for the next review (quarterly — typically ≈ 90 days) |
| per-row `expiresOn` | Hard fail date for that suppression, enforced by CI |

Review checklist (run every quarter, or sooner when a new critical lands):

1. Run `pnpm audit:gate` locally; confirm green.
2. Diff `pnpm audit --json` and `pip-audit packages/cloud-orchestrator -f json` against this inventory.
3. For every open critical/high: open a fix PR **or** add a suppression with owner + expiry + rationale.
4. Drop or renew each suppression past or near `expiresOn`.
5. Update `lastReviewed` / `nextReviewDue` and the inventory table below in the same PR.

## Initial advisory inventory (2026-07-16)

Snapshot of advisories present when this policy was authored. Moderate findings do not block merge; they are listed so the inventory is complete and reviewable. Python (`pip-audit` on `packages/cloud-orchestrator`) reported **zero** known vulnerabilities at inventory time.

### npm — blocking (critical / high)

| Advisory | Severity | Package | Disposition | Evidence |
|----------|----------|---------|-------------|----------|
| `1123525` / `GHSA-fx2h-pf6j-xcff` / `CVE-2026-53571` | high | `vite` | **suppressed** — expires 2026-10-01; owner Track A lead | [`AUDIT-SUPPRESSIONS.json`](./AUDIT-SUPPRESSIONS.json) |

### npm — non-blocking (moderate / low)

| Advisory | Severity | Package | Disposition |
|----------|----------|---------|-------------|
| `1102341` / `GHSA-67mh-4wv8-2f99` | moderate | `esbuild` | track — dev server only; upgrade with toolchain bump |
| `1116229` / `GHSA-4w7w-66w2-5vf9` / `CVE-2026-39365` | moderate | `vite` | track — same vite upgrade window as the high |
| `1117015` / `GHSA-qx2v-qp2m-jg93` / `CVE-2026-41305` | moderate | `postcss` | track — docs-site / playground build path |
| `1120784` / `GHSA-v6wh-96g9-6wx3` / `CVE-2026-53632` | moderate | `vite` | track — same vite upgrade window as the high |
| `1120821` / `GHSA-8988-4f7v-96qf` / `CVE-2026-54285` | moderate | `@opentelemetry/core` | track — upgrade when observability pin allows |

### pip — `packages/cloud-orchestrator`

| Advisory | Severity | Package | Disposition |
|----------|----------|---------|-------------|
| _(none)_ | — | — | clean at inventory date — no suppressions required |

## Sovereignty and observability

Audit triage is metadata about dependencies — never raw learner content. Gate events emit `subjectId` (CI subject, e.g. `ci-audit-gate`), `deviceId` (`ci`), and typed `outcome` / failure class. Failure classes are distinct (`expired_suppression`, `unsuppressed_finding`, `invalid_suppressions`); silent catch-and-continue is forbidden. Cross-subject concerns do not apply to lockfile audits, but the same structured-event contract is used so operators get one observability shape across security gates.

## Links for implementors

- Gate: `pnpm audit:gate` / `pnpm audit:gate:prove`
- Policy gate: `pnpm audit:policy:check` — `scripts/check-audit-triage-policy.mjs`
- Vulnerability reporting: [`SECURITY.md`](../SECURITY.md)
- Adopter security summary: [`docs/security/SECURITY-REVIEW-SUMMARY.md`](../docs/security/SECURITY-REVIEW-SUMMARY.md)
