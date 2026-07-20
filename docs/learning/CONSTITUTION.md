# Learning constitution — Track C governance law

**Status:** binding for every learning / promotion / federation path under Sutra  
**Owners:** Track C learning substrate · `@moolam/learning` maintainers  
**Machine mirror:** `packages/learning/src/governance.ts`  
**Executable peers:** baseline promote gate · eval-slice gates · one-surgery lint (`pnpm --filter @moolam/learning surgery:check`) · kill-switch runbook ([KILL_SWITCH_RUNBOOK.md](./KILL_SWITCH_RUNBOOK.md)) · anti-cheat charter ([training/gym/charter.md](../../training/gym/charter.md)) · consent-law gates (`proveConsentGateIntegration` / `@moolam/learning` consent fixtures)

This constitution is **law**, not aspiration. A promotion, corpus inclusion, or learned flag that violates it is void — not “degraded.” Every named law must eventually have a CI or unit gate; shelfware is a defect.

---

## 1. Cardinal laws

| # | Law | One-line |
|---|-----|----------|
| L1 | **One surgery per stage** | A candidate may change exactly one component class (`adapter` XOR `critic` XOR `mix` XOR `policy`). Two or more → `attribution_void`. |
| L2 | **Baseline permanence** | Deterministic baselines are never deleted. Learned components live behind flags; flag-off equals baseline byte-for-byte. |
| L3 | **Full-gate promotion** | Challenger must beat champion on the **full** required eval gate (all required baseline setIds + safety). Subset green is not enough. **Ties do not promote.** |
| L4 | **Kill-switch law** | One audited operation reverts **every** learned component to its deterministic baseline and restores golden-turn behavior. |
| L5 | **Cross-subject default-deny** | Cross-subject learning requires anonymization **and** consent class. Raw subject content never trains or federates without that pipeline. |
| L6 | **Retrieval is not weights** | `RET` knowledge (statutes, curricula, formularies) stays in packs / RAG — it never enters model weights. |

Knowledge modes that gate weight eligibility:

| Mode | Meaning | May enter weights? |
|------|---------|-------------------|
| `MEM` | Subject/session memory under consent | Only with explicit training consent class |
| `UND` | Understood / distilled protocol skill | Yes, when consent + decontam green |
| `RET` | Retrieve-only factual corpora | **Never** |

---

## 2. Surgery component classes

Canonical classes (see `SURGERY_COMPONENT_CLASSES` in `@moolam/learning`):

1. `adapter` — LoRA / adapter deltas / weight hot-swap candidates  
2. `critic` — reward critic versions / rubric weights  
3. `mix` — corpus mix policy / saturation lane weights  
4. `policy` — routing, healing, compaction, or other control-surface policies  

**Worked example — surgery violation (reject):**

Stage `C4-micro-2026-07-15` proposes:

- touch `adapter` (new LoRA delta `sha256:…`)  
- **and** touch `critic` (rubric v3)

Verdict: **reject** with `failureClass=attribution_void`. GRPO advantages cannot be attributed; the stage is void even if every slice score improves.

Seeded CI fixtures (must stay red/green forever):

- green: `training/eval/fixtures/promotion-candidates/ok-adapter-only.json`
- red: `training/eval/fixtures/promotion-candidates/violation-multi-surgery.json` → `attribution_void`

**Worked example — legal single surgery (continue to full gate):**

Stage proposes only `adapter`. Critic, mix, and policy hashes match the champion ship. Stage may proceed to L3 scoring.

---

## 3. Baseline permanence

- Frozen eval artifacts live in `training/eval/` and the hashed registry `training/eval/baseline_registry.json`.  
- Hash changes require a **new version row** (append-only) — never silent overwrite.  
- Learned compaction / routing / healing must ship beside an immutable deterministic baseline; disabling the learned flag restores that baseline.

**Worked example:** Compaction vLearned ships with feature flag `learned_compaction=on`. Flag-off asserts byte-identical behavior with the deterministic compaction baseline (B5). Deleting the baseline artifact is a constitution breach.

---

## 4. Full-gate promotion (ties do not promote)

Promotion uses the **full** required set (see `REQUIRED_PROMOTE_BASELINE_SET_IDS` in `@moolam/learning`), not a developer-chosen subset. For every required `setId`:

```text
challengerScore[setId]  >  championScore[setId]
```

Equal scores → **reject** (`slice_regression` / tie). Humans may review evidence; they may not hand-wave a tie into production.

Also required before promote:

- Anti-cheat gym replay green (`pnpm --filter @moolam/training-gym parity:check`)  
- No train-on-eval / decontam breach against the baseline registry  
- One surgery class only (L1)  
- Signed lineage / stage record suitable for audit (no raw utterance bodies in telemetry)

### Worked example — real promotion scenario walkthrough

**Setting.** Domain pack `teacher`, locality `on-device`. Champion is the current fleet adapter. Challenger is a single-surgery LoRA trained under gym parity.

| Step | Action | Evidence |
|------|--------|----------|
| 1 | Stage declares `surgeryClasses: ["adapter"]` only | Manifest / stage record |
| 2 | Load baseline registry; required setIds present | `loadBaselineRegistry` / `assertPromotionBaselinesPresent` |
| 3 | Score champion and challenger on **every** required setId | Slice runners with pinned seeds |
| 4 | Compare with strict beat | `evaluateChampionChallengerGate` + `challengerStrictlyBeatsChampion` |
| 5 | Decontam check | Challenger corpus hashes must not intersect registry eval hashes |
| 6 | Anti-cheat | `parity:check` frame-identical on golden corpus |
| 7 | Verdict | `promote` **only** if 1–6 green; else reject with named `setId` / `failingSlice` |

**Numeric illustration** (illustrative scores in `[0,1]`):

| setId (abbrev.) | Champion | Challenger | Result |
|-----------------|----------|------------|--------|
| golden_turns lane | 0.90 | 0.92 | beat |
| guidance lane | 0.90 | 0.90 | **tie → reject whole stage** |
| smoke / nfr | 0.90 | 0.93 | beat |

Even with two beats, the guidance **tie voids promotion**. Operator action: do not ship; either improve the challenger past 0.90 on guidance or abandon the stage.

**Happy promote (continuation):** Challenger scores `0.92 / 0.91 / 0.93` against champion `0.90 / 0.90 / 0.90`, surgery=`adapter`, decontam+parity green → `verdict=promote`.

---

## 5. Kill-switch law

One operator operation (API / CLI / runbook — see [KILL_SWITCH_RUNBOOK.md](./KILL_SWITCH_RUNBOOK.md)) must:

1. Flip **every** learned feature flag to baseline.  
2. Unload / unpin every adapter delta currently hot-swapped.  
3. Restore critic / mix / policy pointers to deterministic versions.  
4. Emit an audited telemetry event (`learning.governance.kill_switch`) with `subjectId` scope when subject-bound, else fleet-scoped `subjectId=null`, plus `deviceId` and `outcome`.  
5. Assert golden-turn / promote-baseline behavior matches flag-off expectations.

**Worked example — kill-switch drill:**

- Fleet runs learned routing + LoRA adapter.  
- Operator fires kill-switch.  
- Post-condition: `learned_routing=off`, adapter pin cleared, golden-turn replay matches pre-learn baseline within charter parity.  
- Partial failure (adapter cleared but routing flag still on) → drill **fails**; do not mark the drill green.

Kill-switch must be **idempotent**: replaying the same audited request does not double-apply side effects or leave an inconsistent half-state.

---

## 6. Cross-subject anonymization + consent

- Default: learning paths are **subject-scoped**. Cross-subject aggregation is deny-by-default.  
- Allowed only when: (a) anonymization pipeline strips raw identifiers / utterances to the declared privacy tier, **and** (b) every contributing shard carries a training-eligible `consentClass` with `optedIn=true` (see B9 / `CONSENT_CLASSES` / consent-law module).  
- Telemetry for governance events is metadata-only — never attach raw learner utterance bodies.  
- Locality `on-device` / `self-hosted` must be preserved; exporting raw content “for debugging a promotion” is a breach.  
- **Federated aggregation policy (ratified):** consent tiers, anonymization proofs, and per-tier DP pins — [training/federated/aggregation_policy.md](../../training/federated/aggregation_policy.md) · machine mirror `packages/learning/src/federated_policy.ts`.

**Worked example — cross-subject reject:**

Federated upload mixes trajectories from `subjectId=anika-k` and `subjectId=ravi-m` without anonymization markers → reject (`cross_subject` / consent failure). No weight update.

**Worked example — allowed path:**

Shards carry `consentClass=research`, `optedIn=true`, anonymized feature aggregates only, locality `self-hosted` → may enter distillation / GRPO queues subject to decontam.

---

## 7. Sovereignty, concurrency, and observability

- Every durable learning write is scoped by `subjectId` when subject-bound; fleet ops use explicit fleet scope in telemetry (`subjectId=null` only when not subject-bound).  
- Concurrent turns for the same `subjectId` must not lost-update cognitive / consent state (serialize or optimistic concurrency with typed conflict errors).  
- Partial failure after the first durable side effect → typed failure class; never silent catch-and-continue that leaves a half-promoted candidate.  
- Structured events: `learning.governance.*` with `outcome`, `subjectId`, `deviceId`, and distinct `failureClass` values (`attribution_void`, `slice_regression`, `tie_reject`, `kill_switch_partial`, `cross_subject`, …).

---

## 8. Acknowledgement

Shipping or promoting a learned component under this repository constitutes acknowledgement of this constitution. Circumventing L1–L6 is an intentional breach.

Related:

- Kill-switch runbook: [KILL_SWITCH_RUNBOOK.md](./KILL_SWITCH_RUNBOOK.md)  
- Training mix policy: [MIX_POLICY.md](./MIX_POLICY.md) · [sign-off](./MIX_POLICY_SIGNOFF.json)  
- Federated aggregation policy: [training/federated/aggregation_policy.md](../../training/federated/aggregation_policy.md)  
- Research intake (breakthrough RFC): [research-intake/RFC_TEMPLATE.md](./research-intake/RFC_TEMPLATE.md) · [REVIEW_WORKFLOW.md](./research-intake/REVIEW_WORKFLOW.md) · [ADOPTION_CHECKLIST.md](./research-intake/ADOPTION_CHECKLIST.md) · worked example [RFC-2026-004](./research-intake/rfcs/RFC-2026-004-grpo-g8-to-g6.md)  
- Anti-cheat: [training/gym/charter.md](../../training/gym/charter.md)  
- Package: [`packages/learning`](../../packages/learning/README.md)  
- Machine constants: `packages/learning/src/governance.ts`
