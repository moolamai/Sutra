# Federated aggregation policy — Track C continuous cadence

**Status:** ratified for every cross-subject / cross-tenant learning path under Sutra  
**Owners:** Track C self-evolution governance · `@moolam/learning` maintainers  
**Machine mirror:** `packages/learning/src/federated_policy.ts`  
**Parent law:** [CONSTITUTION.md](../../docs/learning/CONSTITUTION.md) **L5 — Cross-subject default-deny**  
**Executable peers:** consent-law gate · **federated upload gate** (`runFederatedUploadGate` — extends B9 locality harness) · **default-deny negative suite** (`training/federated/fixtures/default-deny-negative-suite.json` · `proveFederatedDefaultDenyNegativeSuite`) · candidate red-team locality proofs

This document is **governance law**, not aspiration. Cross-subject gradient or trajectory aggregation without an explicit federation consent tier is **blocked**. Anonymization and differential-privacy (DP) requirements are **executable** in `@moolam/learning` — shelfware prose is a defect.

---

## 1. Cardinal rules

| # | Rule | One-line |
|---|------|----------|
| F1 | **Default deny** | No federation consent tier → reject. Missing anonymization proof → reject. Undeclared DP tier → reject. |
| F2 | **Consent tiers are explicit** | Only `research_anon` and `product_improve_anon` may federate. `personal` never federates. Raw / undeclared tier never federates. |
| F3 | **Anonymization is mandatory** | Upload bundles carry hashed / aggregated features only — never raw utterances, prompts, or subject-identifying plaintext. |
| F4 | **DP parameters are declared per tier** | Every eligible tier pins `(ε, δ, clipNorm)`. Undeclared or mismatched parameters reject the upload. |
| F5 | **Revocation is forward-looking** | Mid-round consent revocation excludes the subject from the **current** aggregation round. Completed prior rounds are not retroactively poisoned without a separate remediation policy. |
| F6 | **Locality preserved** | Declared locality (`on-device` / `self-hosted`) is never widened by federation. On-device raw content does not leave the device boundary. |
| F7 | **Subject isolation** | Every evaluation is scoped by `subjectId`. Cross-subject reads without the anonymized federation path are defects. |

---

## 2. Consent tiers

Aligned with B9 trajectory consent classes, with a federation overlay:

| Federation tier | B9 consent class | `optedIn` | Anonymized | May federate? |
|-----------------|------------------|-----------|------------|---------------|
| _(none / deny)_ | any / missing | — | — | **No** (default) |
| `research_anon` | `research` | `true` | `true` | Yes, with DP pin |
| `product_improve_anon` | `product-improve` | `true` | `true` | Yes, with DP pin |
| _(forbidden)_ | `personal` | any | any | **Never** |

Machine constants: `FEDERATION_CONSENT_TIERS`, `FEDERATION_ELIGIBLE_TIERS` in `federated_policy.ts`.

---

## 3. Anonymization requirements

An upload is anonymization-complete only when **all** hold:

1. `anonymized === true` on the federation request.  
2. Bundle fields are metadata / aggregates / content-addressed hashes — no keys matching utterance / prompt / reply / learner raw content.  
3. Contributing `subjectId` values are replaced by per-round **participant tokens** (opaque ids) before leave-locality.  
4. Locality on the wire matches the subject's declared boundary; `on-device` never emits raw learner text off-device.

Executable check: `assertFederatedAnonymizationProof` / `evaluateFederatedAggregationEligibility` / `runFederatedUploadGate`.

---

## 3b. Federated upload gate (B9 locality)

The upload gate is the executable leave-locality control for federation. It extends the B9 locality harness fail-closed posture:

1. **Locality proof required** — missing `FederatedLocalityProof` → `federated.locality_proof_missing` (default deny).  
2. **Consent class check** — runs the federation eligibility path (tier + B9 class + DP pin).  
3. **No raw subject content** — bundle anonymization proof must pass before admit.  
4. **Destination class** — federated uploads may target `self-hosted` allowlisted aggregators only; `third-party` is forbidden.  
5. **Payload class** — only `metadata` (or `none`) after anonymization; `regulated` / `model-prompt` / `cognitive-state` reject.  
6. **Subject binding** — proof `subjectId`/`deviceId` must match the upload request.

Machine entrypoints: `assertFederatedUploadLocalityProof`, `runFederatedUploadGate`, `proveFederatedUploadGate`, `proveFederatedDefaultDenyNegativeSuite`.

### Default-deny negative suite

Committed fixtures under `training/federated/fixtures/default-deny-negative-suite.json`:

| Fixture | Expected |
|---------|----------|
| `missing-consent` | reject `federated.default_deny` |
| `raw-content-leak` | reject `federated.sovereignty` |
| `wrong-anonymization-tier` | reject `federated.anonymization_missing` |
| `consent-tier-mismatch` | reject `federated.consent_mismatch` |
| `missing-locality-proof` | reject `federated.locality_proof_missing` |
| `proven-accept` | **accept** (only fully proven bundle) |

---

## 4. Differential privacy parameters (per tier)

| Tier | `epsilon` (ε) | `delta` (δ) | `clipNorm` |
|------|--------------:|------------:|-----------:|
| `research_anon` | `1.0` | `0.00001` (`1e-5`) | `1.0` |
| `product_improve_anon` | `0.5` | `0.000001` (`1e-6`) | `1.0` |

- Uploads must declare the **exact** pin for their tier.  
- Stricter noise (lower ε) than the pin is allowed; looser (higher ε or higher δ) is **reject**.  
- Missing DP declaration on an eligible tier → `federated.dp_undeclared`.

Machine constants: `FEDERATION_DP_PARAMS`.

---

## 5. Worked examples — default deny

### 5.1 Missing consent tier (reject)

Two tenants propose gradient aggregation with no `federationTier` field.

**Verdict:** `reject` · `failureClass=federated.default_deny`  
No weight update. No upload leaves locality.

### 5.2 Personal consent never federates (reject)

`subjectId=tenant-a.learner-01` carries `consentClass=personal`, `optedIn=true`, `anonymized=true`, DP pin present.

**Verdict:** `reject` · `failureClass=federated.personal_forbidden`  
Personal remains sovereign-local forever.

### 5.3 Undeclared DP parameters (reject)

`federationTier=research_anon`, anonymized, but `dp` omitted.

**Verdict:** `reject` · `failureClass=federated.dp_undeclared`

### 5.4 Revoked mid-aggregation (exclude current round)

Round `fed.round.2026-07-17` started with `subjectId=tenant-b.learner-02` eligible. Before upload commit, the subject revokes.

**Verdict for that subject:** `reject` · `failureClass=federated.consent_revoked`  
Subject is excluded from **this** round. Prior completed rounds remain as-is (no silent retroactive poison without remediation policy).

### 5.5 Raw content in bundle (reject)

Bundle includes field `utterance` (or `promptBody` / `replyBody`).

**Verdict:** `reject` · `failureClass=federated.sovereignty`  
Anonymization proof fails — not policy prose.

---

## 6. Real cross-tenant scenario walkthrough

**Setting.** Two self-hosted fleets — `tenant.aurora` and `tenant.borealis` — want a shared research adapter warm-start. Neither may see the other's raw trajectories.

| Step | Action | Evidence |
|------|--------|----------|
| 1 | Each subject opts in with `consentClass=research`, `optedIn=true` | B9 consent record |
| 2 | Local anonymizer strips utterances → feature aggregates + participant tokens | Anonymization proof |
| 3 | Request declares `federationTier=research_anon` and DP pin `(ε=1.0, δ=0.00001, clipNorm=1.0)` | Upload manifest |
| 4 | Locality remains `self-hosted`; attach B9 locality proof (metadata → self-hosted allowlist) | `FederatedLocalityProof` / upload gate |
| 5 | Gate evaluates eligibility per subject | `evaluateFederatedAggregationEligibility` |
| 6 | Upload gate admits only subjects that pass locality + consent + DP | `runFederatedUploadGate` |
| 7 | Aggregator accepts only admitted uploads; revoked / personal / undeclared DP / missing proof are dropped | Round receipt |
| 8 | Telemetry emits `learning.federated.policy` metadata-only events | Observability |

**Happy allow:** Both tenants pass steps 1–5 → round may aggregate anonymized updates under the research DP pin.

**Numeric illustration (eligibility):**

| Subject | Tier | Anon | DP pin | Revoked | Result |
|---------|------|------|--------|---------|--------|
| aurora.learner-01 | `research_anon` | yes | exact | no | **allow** |
| borealis.learner-07 | `research_anon` | yes | exact | no | **allow** |
| aurora.learner-99 | _(missing)_ | yes | — | no | **deny** |
| borealis.learner-03 | `research_anon` | no | exact | no | **deny** |

---

## 7. Sovereignty, concurrency, observability

- Every eligibility check is keyed by `subjectId` (+ `deviceId` when device-bound).  
- Concurrent federation requests for the same `subjectId` must not double-admit the same `operationId` (idempotent receipts).  
- Partial failure after the first durable round side effect → typed `federated.partial_failure`; never silent continue.  
- Structured events: `learning.federated.policy` with `outcome`, `subjectId`, `deviceId`, and distinct `failureClass` values — never raw learner content.

---

## 8. Acknowledgement

Shipping a federated upload or cross-tenant aggregate under this repository constitutes acknowledgement of this policy and constitution L5. Circumventing F1–F7 is an intentional breach.

Related:

- Constitution L5: [docs/learning/CONSTITUTION.md](../../docs/learning/CONSTITUTION.md)  
- Consent-law gate: `packages/learning/src/consent_gate.ts`  
- Machine mirror: `packages/learning/src/federated_policy.ts`
