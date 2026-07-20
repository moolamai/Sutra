# Training mix policy — Track C corpus governance

**Status:** ratified (stakeholder sign-off bound) for every pack SFT / adapter corpus under Sutra  
**Owners:** Track C corpus factory · `@moolam/training-corpus` maintainers  
**Machine mirror:** `training/corpus/mix_policy.ts`  
**Sign-off:** [`MIX_POLICY_SIGNOFF.json`](./MIX_POLICY_SIGNOFF.json)  
**Executable peers:** mix-policy linter + ratification prove · pack SFT curriculum metadata · constitution L6 ([CONSTITUTION.md](./CONSTITUTION.md))

This document is **governance law** for how training mixes are composed — not a wish list. Manifests that violate it must fail lint. Circumventing these rules to “fit more data” is a defect. Promotion requires a matching `mixPolicyVersion` against the ratified sign-off.

---

## 1. Cardinal rules

| # | Rule | One-line |
|---|------|----------|
| M1 | **RET has zero weight** | Retrieve-only knowledge stays in B7 packs / RAG. `weightTrainingPolicy.excludeKnowledgeModes` must include `RET`. |
| M2 | **MEM is thin** | Subject/session memory may enter weights only under consent, and at most the MEM thin cap of the mix. |
| M3 | **UND carries conceptual depth** | Protocol skill, distilled traces, and domain understanding are the primary weight mass. |
| M4 | **Repair-heavy finales ~50%** | Failure / repair / decision-graph stages target half the sampling mix (tolerance band below). |
| M5 | **Curriculum before depth** | Train order is `protocol → tool_use → domain_depth → repair` (see pack SFT curriculum metadata). |
| M6 | **One lane per pack** | Each domain pack corpus is a separate manifest lane with its own decontam proof and size report. |
| M7 | **Hundreds, not thousands** | First training jobs stay SLM-scale (≤ 999 sources / lane; first-job floor ≥ 100). |

Knowledge modes (aligned with constitution L6):

| Mode | Role in the mix | May enter weights? |
|------|-----------------|--------------------|
| `MEM` | Consented subject/session memory | Yes, **thin** (≤ MEM max weight) + consent class |
| `UND` | Understood / distilled protocol + domain skill | Yes (primary mass) |
| `RET` | Retrieve-only facts (syllabi, formularies, statutes) | **Never** — B7 RAG only |

---

## 2. Numeric policy (machine-mirrored)

Constants live in `training/corpus/mix_policy.ts` and must match this table.

| Constant | Value | Meaning |
|----------|------:|---------|
| `MIX_REPAIR_TARGET_WEIGHT` | `0.50` | Target share for `repair` curriculum stage (failures + decision-graphs) |
| `MIX_REPAIR_TOLERANCE` | `0.05` | Allowed absolute deviation from target before lint fails |
| `MIX_MEM_MAX_WEIGHT` | `0.15` | Hard ceiling for MEM in the weight mix (“thin”) |
| `MIX_RET_WEIGHT` | `0` | RET never contributes to sampling weights |
| `MIX_CURRICULUM_STAGE_ORDER` | `protocol`, `tool_use`, `domain_depth`, `repair` | Fixed stage order |

**Effective weight check (conceptual):**

```text
sum(stageWeights) == 1
stageWeights.repair ∈ [0.50 − 0.05, 0.50 + 0.05]   when repair sources are present
modeWeight(MEM) ≤ 0.15
modeWeight(RET) == 0
```

When a lane has **no** repair-tagged sources yet (scaffold / smoke), proportional stage weights apply and the repair band is not enforced until repair content exists — the pack SFT assembler documents this in `curriculum.repairHeavyTargetWeight`.

---

## 3. Lane weights and curriculum interaction

Pack SFT assembly writes `curriculum` on the corpus manifest:

- `stageOrder` — must equal `MIX_CURRICULUM_STAGE_ORDER`
- `stageWeights` — sampling guidance; repair targets `MIX_REPAIR_TARGET_WEIGHT` when repair sources exist
- `orderedSourceIds` — train sequence (stage order, then `sourceId`); independent of canonical source-array sort

**Interaction rule:** curriculum ordering decides *when* examples appear; mix weights decide *how often* stages are sampled. Changing one without the other is a governance defect.

Default remaining mass (when repair = 0.50 and three earlier stages are non-empty) splits equally:

| Stage | Default share (repair present) |
|-------|-------------------------------:|
| `protocol` | ≈ 0.1667 |
| `tool_use` | ≈ 0.1667 |
| `domain_depth` | ≈ 0.1667 |
| `repair` | **0.50** |

---

## 4. Sovereignty and subject isolation

- Consented trajectories and public/synthetic pack sources **never** share a manifest (`consentClass` is first-class).
- Every durable corpus write / lint event is scoped by `subjectId` + `deviceId` when subject-bound.
- No raw learner utterance or keystroke bodies appear in mix reports, telemetry, or this policy’s worked examples.
- Locality stays `on-device` / `self-hosted` / `bundled-offline` as declared on the source pack — mix policy does not move content across sovereignty boundaries.

**Concurrency / idempotency (governance expectations for factories that apply this policy):**

- Concurrent turns for the same `subjectId` must not lost-update consent or corpus inclusion state.
- Partial failure after the first durable side effect → typed `failureClass`, never silent continue.
- Replayed lint / assemble for the same manifest bytes is idempotent (byte-identical outputs).

---

## 5. Observability

Emit structured events (never raw content):

| Event / op | Outcome signals |
|------------|-----------------|
| `training.mix_policy` / `validate` | `ok` \| `error` with `failureClass` |
| Distinct failure classes | `ret_in_weights`, `mem_over_thin`, `repair_out_of_band`, `curriculum_mismatch`, `config` |

Fields: `subjectId`, `deviceId`, `manifestId`, `packId` / `laneCode` when applicable, `detail` (counts and thresholds only).

---

## 6. Worked examples (real packs)

### 6.1 Teacher — `pack.teacher.cbse-slice`

**Sources (real tree):**

- Domain spec: `domains/teacher/README.md` → curriculum stage `protocol` (UND)
- Domain data: `domains/teacher/data/cbse-syllabus-slice.md` → `domain_depth` (UND)
- Knowledge-pack manifest: `knowledge-packs/teacher-cbse-slice/manifest.json` → `domain_depth` (UND; pack content shards remain RET/RAG at runtime via B7)
- B8-derived guidance stubs (not eval fixture bytes) → `protocol` (UND)
- Distilled traces (critic ≥ 0.6) → typically `tool_use` (UND)
- Consented trajectories → separate **consented** manifest only; stage often `repair`

**Compliant synthetic mix (illustrative stageWeights when repair present):**

| Stage | Weight |
|-------|-------:|
| protocol | 0.167 |
| tool_use | 0.167 |
| domain_depth | 0.166 |
| repair | **0.500** |

**Must hold:**

- Manifest `weightTrainingPolicy.excludeKnowledgeModes` includes `RET`.
- CBSE factual passages used at inference via `knowledge-packs/teacher-cbse-slice` retrieval — **not** copied into weight shards as RET.
- Lane size within SLM hundreds gate; decontam proof path unique to this pack lane.

**Reject example:** A teacher lane that sets `stageWeights.repair = 0.20` while repair sources exist → `repair_out_of_band` (outside 0.45–0.55).

### 6.2 Doctor — `pack.doctor.formulary-sketch`

**Sources (real tree):**

- Domain spec: `domains/doctor/README.md` → `protocol` (UND)
- Domain data: `domains/doctor/data/formulary-sketch.md` → `domain_depth` (UND)
- Knowledge-pack manifest: `knowledge-packs/doctor-formulary-sketch/manifest.json` → `domain_depth` (UND)
- Formulary **content shards** stay retrieve-only at runtime (B7); regulatory disclaimers in pack provenance apply.

**Compliant mix:** same stage-weight pattern as teacher when repair sources are present. MEM stays ≤ 0.15 and only under consented class.

**Reject example:** Weight-training a RET-tagged formulary shard (or omitting `exclude_ret_from_weights` while RET sources are listed) → `ret_in_weights` / constitution L6 breach.

---

## 7. Ratification, version hash, and promotion

**Status:** ratified via stakeholder sign-off  
**Sign-off artifact:** [`MIX_POLICY_SIGNOFF.json`](./MIX_POLICY_SIGNOFF.json)  
**Machine hook:** `assertMixPolicyPromotion` / `proveMixPolicyRatification` in `mix_policy.ts`

### 7.1 Policy version hash

Every ratified policy revision has a content-addressed id:

```text
mixPolicyVersion = sha256( canonical identity JSON )
```

Identity payload (stable key order):

| Field | Source |
|-------|--------|
| `schemaVersion` | `training.mix-policy.v1` |
| numeric constants | repair target/tolerance, MEM max, RET=0, stage order |
| `docRelpath` | `docs/learning/MIX_POLICY.md` |
| `docSha256` | SHA-256 of the governance document bytes |

Corpus manifests that are **promotion-ready** must record `mixPolicyVersion` equal to the current ratified hash. Floating labels (`latest`, empty) are rejected.

### 7.2 Stakeholder sign-off hook

`MIX_POLICY_SIGNOFF.json` binds:

- `status: "ratified"`
- `mixPolicyVersion` matching the live computed hash
- ≥ 2 stakeholder attestations (`role` + `attestorId` + `signedAt`) — Track C corpus owner and learning governance
- `changelog[]` entries for each ratified policy update

Replaying the same sign-off check is idempotent (pure read + compare). Partial / mismatched sign-off blocks promotion with a typed failure class — never silent continue.

### 7.3 Promotion gate

Promotion (or any “ship this pack SFT corpus” gate) requires:

1. Mix policy lint green (RET=0, MEM thin, repair band when repair sources exist)
2. Sign-off present and `status=ratified`
3. `manifest.mixPolicyVersion ===` live `mixPolicyVersion ===` sign-off hash

Mismatch → `version_mismatch` / `promotion_blocked`. Lint-only smoke manifests may omit `mixPolicyVersion`; they cannot promote.

### 7.4 Changelog

| Date | Summary |
|------|---------|
| 2026-07-16 | Initial ratification: RET=0, MEM≤0.15, repair 0.50±0.05, curriculum `protocol→tool_use→domain_depth→repair`, manifest linter, stakeholder sign-off + promotion version bind. |

Machine changelog mirrors the same entries inside `MIX_POLICY_SIGNOFF.json`.

**Executable prove (CI):**

```bash
pnpm --filter @moolam/training-corpus prove:mix-policy
```

Golden green: `training/corpus/fixtures/valid/minimal.json` (lint), `training/corpus/fixtures/mix_policy/ok-repair-curriculum.json` (lint + promotion version).  
Seeded red: `violation-ret-in-weights.json`, `violation-repair-out-of-band.json`, `violation-version-mismatch.json`.

Related:

- Learning constitution: [CONSTITUTION.md](./CONSTITUTION.md) (L6 Retrieval is not weights)
- Kill-switch: [KILL_SWITCH_RUNBOOK.md](./KILL_SWITCH_RUNBOOK.md)
- Corpus factory: [`training/corpus/README.md`](../../training/corpus/README.md)
- Pack SFT assembler: `training/corpus/domain_packs/`
- Knowledge packs: [`knowledge-packs/README.md`](../../knowledge-packs/README.md)
