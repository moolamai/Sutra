# RFC-2026-004 — GRPO group size G=8 → G=6 (worked example)

**Status:** worked example (process proof) — not adopted; adoption follows [REVIEW_WORKFLOW.md](../REVIEW_WORKFLOW.md) + [research-intake-rfc.md](../../../stages/tracks/_generator/track-c/research-intake-rfc.md)  
**Template:** [RFC_TEMPLATE.md](../RFC_TEMPLATE.md)  
**Machine mirror:** `packages/learning/src/research_intake_worked_example.ts`  
**Parent law:** [CONSTITUTION.md](../../CONSTITUTION.md)

This RFC is the **binding worked example** that proves research intake is real: a concrete GRPO hyperparameter experiment (champion G=8 → challenger G=6, clip ε unchanged at 0.2), with micro-run commands, champion comparison criteria, and a documented manifest update path. It does **not** change production pins until status becomes `approved` then `adopted`.

---

## 0. Header

| Field | Value |
|-------|-------|
| **RFC id** | `RFC-2026-004` |
| **Title** | Reduce GRPO group size from G=8 to G=6 |
| **Author** | Track C research-intake (worked example) |
| **Opened** | `2026-07-17` |
| **Status** | `in_review` |
| **Locality impact** | `none` (hyperparameter pin only; no locality boundary change) |
| **Surgery class touched** | `adapter` (LoRA-class GRPO updates only — one surgery) |
| **Subject scope** | Fleet pack policy for CI micro-runs; receipts use opaque `subjectId` only |

---

## 1. Hypothesis

```text
If we pin GRPO group size from champion G=8 to challenger G=6 (clip ε=0.2 unchanged),
then the challenger will strictly beat the champion on every required promote setId
with no slice regression past tolerance, safety suites green, and one surgery class only
(adapter). Ties do not promote.
```

Falsifiable against the current champion pin: `GRPO_GROUP_SIZE_MAX = 8`, `GRPO_CLIP_EPSILON = 0.2` in `@moolam/learning` (`staleness_control` / `grpo_advantage`).

---

## 2. Related work

| Reference | Relevance | Artifact / RFC id |
|-----------|-----------|-------------------|
| DeepSeekMath GRPO (group-relative advantages, G candidates per prompt) | Motivates G∈[4,8] band | paper: DeepSeekMath / GRPO |
| Track C C4 spine — GRPO core G=4–8, clipped surrogate ε=0.2 | Current plan text | generator `c4.mjs` |
| `@moolam/learning` bounds | Executable champion pin | `GRPO_GROUP_SIZE_MIN=4`, `GRPO_GROUP_SIZE_MAX=8`, `GRPO_CLIP_EPSILON=0.2` |
| Prior RFCs | None yet — this is the first worked example | `RFC-2026-004` |

Opaque artifact hashes only — no raw prompts or learner utterances.

---

## 3. Eval plan vs champion

Champion is the currently promoted GRPO hyperparameter pin for adapter surgery: **G=8**, **ε=0.2**.

| Step | Requirement |
|------|-------------|
| Champion pin | `groupSize=8`, `clipEps=0.2`; lineage via last promoted adapter checkpoint hash on the C4 micro-run lane |
| Challenger build | Same trainer path with `groupSize=6`, `clipEps=0.2` — manifest / training pin only, **not** a forked trainer |
| Required setIds | Full C0/C5 required promote set for the adapter surgery class — **ties do not promote** |
| Safety | Candidate red-team + locality proofs before eval gates; one surgery class (`adapter`) only |
| Micro-run | CI-budget commands below |
| Success rule | Challenger strictly beats champion on **every** required setId; no undeclared surgery; safety suites green |
| Failure rule | Archive results under `docs/learning/research-intake/archive/` and mark `rejected` |

### Micro-run (CI budget)

```bash
pnpm --filter @moolam/learning build
node --test packages/learning/tests/grpo_group.test.mjs packages/learning/tests/grpo_advantage.test.mjs
node --test packages/learning/tests/research_intake_worked_example.test.mjs
```

Optional training gym micro-run (when accelerators available): fleet telemetry G-band check under `training/gym/` with `groupSize=6` vs champion receipt `groupSize=8`. Compare slice scores only — metadata (`subjectId`, `deviceId`, scores, hashes), never raw learner content.

### Champion comparison criteria

| Criterion | Pass |
|-----------|------|
| Per required setId | `challengerScore > championScore` (strict) |
| Tie | Fail — ties do not promote |
| Safety suites | Green before any promote verdict |
| Surgery class | Exactly `adapter` |
| Clip ε | Unchanged at `0.2` (this RFC does not propose an ε change) |

Sovereignty: eval artifacts and telemetry are metadata-only.

---

## 4. Rollback plan

| Trigger | Action |
|---------|--------|
| Slice regression / safety fail | Do not adopt; keep champion G=8; archive scores under `docs/learning/research-intake/archive/RFC-2026-004/` |
| Adopted then field regression | Kill-switch / staged rollback to pre-RFC champion pin (`groupSize=8`, `clipEps=0.2`) |
| Partial manifest apply | Treat as failed adoption — regenerate from last good manifest; never leave half-applied generator state |

Rollback is **idempotent**: replaying the rollback receipt does not double-apply.

Concurrent subject turns race on cognitive state elsewhere; this RFC’s receipts key by `rfcId` + `operationId` so replays are safe.

---

## 5. Manifest change list

On **adoption only** (after `approved`), edit these paths — no ad-hoc trainer forks:

| Path | Change summary |
|------|----------------|
| `docs/stages/tracks/_generator/track-c/c4.mjs` | Update GRPO core plan text from “G=4–8” champion example to document adopted default **G=6** (band may remain [4,8]) |
| `training/` hyperparameter pin (declare concrete file in adoption PR) | Pin micro-run / trainer `groupSize: 6`, keep `clipEps: 0.2` |

After approval: edit manifests → run `node docs/stages/tracks/_generator/generate-tracks.mjs` → land regenerated docs with `RFC-2026-004` in the commit message. See [research-intake-rfc.md](../../../stages/tracks/_generator/track-c/research-intake-rfc.md).

**Not in scope of this RFC:** changing `GRPO_GROUP_SIZE_MAX` / `MIN` bounds, clip ε, or surgery law.

---

## 6. Review checklist (author self-check)

- [x] Hypothesis is falsifiable against a named champion (G=8, ε=0.2)
- [x] Related work table filled
- [x] Eval plan names required setIds and micro-run commands
- [x] Rollback plan covers failed experiment and failed adoption
- [x] Manifest change list is complete (`c4.mjs` + training pin)
- [x] No raw learner / utterance bodies in this document
- [x] One surgery class only (`adapter`)

---

## 7. Decision record (reviewers fill)

| Role | Name | Verdict | Date |
|------|------|---------|------|
| Track C maintainer | _pending_ | | |
| Safety reviewer | _pending_ (locality impact `none` — still confirm no serving surface change) | | |
| Constitution steward | n/a (no L1–L6 delta) | n/a | |

Final status: `in_review` (worked example; experiment not yet executed for adoption)  
Archive path (if rejected): `docs/learning/research-intake/archive/RFC-2026-004/`  
Adoption commit / PR (if adopted): _______________

---

## 8. Emergency bypass note (edge)

An emergency safety patch may **not** silently change G or ε. Bypass requires an explicit constitution amendment record and follow-up RFC — never silent. See [REVIEW_WORKFLOW.md](../REVIEW_WORKFLOW.md) §5.
