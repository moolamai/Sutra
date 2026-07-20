# Breakthrough RFC template — Track C research intake

**Status:** binding template for every learning-algorithm / training-technique change under Sutra  
**Owners:** Track C research intake · `@moolam/learning` maintainers  
**Workflow:** [REVIEW_WORKFLOW.md](./REVIEW_WORKFLOW.md)  
**Generator hook:** [`docs/stages/tracks/_generator/track-c/research-intake-rfc.md`](../../stages/tracks/_generator/track-c/research-intake-rfc.md)  
**Machine mirror:** `packages/learning/src/research_intake_rfc.ts`  
**Parent law:** [CONSTITUTION.md](../CONSTITUTION.md)

Copy this file to `docs/learning/research-intake/rfcs/RFC-YYYY-NNN-short-slug.md` (or archive/` for rejected). Fill every section. Empty sections are a defect — the review gate rejects incomplete RFCs.

**Worked example:** [rfcs/RFC-2026-004-grpo-g8-to-g6.md](./rfcs/RFC-2026-004-grpo-g8-to-g6.md) (GRPO G=8→G=6).

**Invariant:** No learning-algorithm change ships without an **approved** RFC and a champion comparison experiment. Adopted RFCs update Track C generator manifests and regenerate — never one-off trainer forks.

---

## 0. Header

| Field | Value |
|-------|-------|
| **RFC id** | `RFC-YYYY-NNN` |
| **Title** | |
| **Author** | |
| **Opened** | `YYYY-MM-DD` |
| **Status** | `draft` \| `in_review` \| `experiment_running` \| `approved` \| `rejected` \| `adopted` \| `emergency_bypass` |
| **Locality impact** | `none` \| `on-device` \| `self-hosted` \| `both` |
| **Surgery class touched** | `adapter` \| `critic` \| `mix` \| `policy` \| `none` (exactly one if weights/control surface change) |
| **Subject scope** | Fleet / pack / named `subjectId` policy (never raw learner text in this RFC) |

---

## 1. Hypothesis

State the change as a falsifiable claim against the **current champion**.

```text
If we <change>, then challenger will strictly beat champion on <required setIds>
with no slice regression past tolerance, safety suites green, and one surgery class only.
```

Non-examples (reject at intake):

- “Make GRPO better somehow”
- “Port paper X into main without an eval plan”

---

## 2. Related work

Cite papers / prior RFCs / internal experiments with enough precision to re-find them (title, venue/year or RFC id, opaque artifact hashes — **not** raw prompts or learner utterances).

| Reference | Relevance | Artifact / RFC id |
|-----------|-----------|-------------------|
| | | |

---

## 3. Eval plan vs champion

Champion is the currently promoted baseline for the named surgery class / hyperparameter pin.

| Step | Requirement |
|------|-------------|
| Champion pin | Checkpoint / config hash + lineage ref |
| Challenger build | How the experiment is produced (manifest lane, not a forked trainer) |
| Required setIds | Full C0/C5 required promote set — **ties do not promote** |
| Safety | Candidate red-team + locality proofs before eval gates |
| Micro-run | CI-budget command(s) that reproduce the comparison |
| Success rule | Challenger strictly beats champion on **every** required setId; no undeclared surgery |
| Failure rule | Archive results under `docs/learning/research-intake/archive/` and mark `rejected` |

Sovereignty: eval artifacts and telemetry are metadata-only (`subjectId`, `deviceId`, scores, hashes). Raw learner content never appears in the RFC or experiment receipts.

---

## 4. Rollback plan

| Trigger | Action |
|---------|--------|
| Slice regression / safety fail | Do not adopt; keep champion; archive scores |
| Adopted then field regression | Kill-switch / staged rollback to pre-RFC champion pin |
| Partial manifest apply | Treat as failed adoption — regenerate from last good manifest; never leave half-applied generator state |

Rollback must be **idempotent**: replaying the rollback receipt does not double-apply.

---

## 5. Manifest change list

List every Track C generator / training manifest path that would change on adoption. Ad-hoc code outside this list is forbidden.

| Path under `docs/stages/tracks/_generator/track-c/` or `training/` | Change summary |
|-------------------------------------------------------------------|----------------|
| | |

After approval: edit manifests → run `node docs/stages/tracks/_generator/generate-tracks.mjs` (and any package-specific regen) → land regenerated docs with the RFC id in the commit message. See [research-intake-rfc.md](../../stages/tracks/_generator/track-c/research-intake-rfc.md) and [ADOPTION_CHECKLIST.md](./ADOPTION_CHECKLIST.md).

---

## 6. Review checklist (author self-check)

- [ ] Hypothesis is falsifiable against a named champion  
- [ ] Related work table filled  
- [ ] Eval plan names required setIds and micro-run commands  
- [ ] Rollback plan covers failed experiment and failed adoption  
- [ ] Manifest change list is complete (or explicitly `none` with justification)  
- [ ] No raw learner / utterance bodies in this document  
- [ ] One surgery class only (or `none`)  

---

## 7. Decision record (reviewers fill)

| Role | Name | Verdict | Date |
|------|------|---------|------|
| Track C maintainer | | approve / request changes / reject | |
| Safety reviewer | | approve / request changes / reject | |
| Constitution steward (if L1–L6 impact) | | approve / n/a / reject | |

Final status: _______________  
Archive path (if rejected): _______________  
Adoption commit / PR (if adopted): _______________
