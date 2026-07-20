# Research-intake review workflow — breakthrough RFC

**Status:** binding for every Track C research-intake RFC  
**Template:** [RFC_TEMPLATE.md](./RFC_TEMPLATE.md)  
**Generator hook:** [`docs/stages/tracks/_generator/track-c/research-intake-rfc.md`](../../stages/tracks/_generator/track-c/research-intake-rfc.md)  
**Machine mirror:** `packages/learning/src/research_intake_rfc.ts`  
**Parent law:** [CONSTITUTION.md](../CONSTITUTION.md)

New research — GRPO variants, QLoRA advances, Reflexion-style self-correction, safety techniques — enters **only** through this workflow. Ad-hoc trainer forks and silent main merges are constitution breaches.

---

## 1. Cardinal rules

| # | Rule | One-line |
|---|------|----------|
| R1 | **RFC before code** | No learning-algorithm change ships without an approved RFC and champion comparison experiment. |
| R2 | **Manifests, not forks** | Adopted RFCs update Track C generator manifests and regenerate — never one-off trainers. |
| R3 | **Fail closed** | Incomplete templates, missing roles, or missing experiment receipts → reject. |
| R4 | **Rejected ≠ deleted** | Rejected RFCs archive experiment results for reconsideration. |
| R5 | **Emergency is recorded** | Safety patches may bypass RFC **only** with an explicit constitution amendment record — never silent. |
| R6 | **Metadata-only** | RFCs, receipts, and telemetry never carry raw learner utterances. |

---

## 2. Review roles

| Role | Responsibility | Required for |
|------|----------------|--------------|
| **Author** | Drafts RFC from template; runs / owns micro-run experiment | Every RFC |
| **Track C maintainer** | Technical soundness, manifest path correctness, one-surgery | Every RFC |
| **Safety reviewer** | Red-team / locality / consent impact | Every RFC that touches serving, aggregation, or safety suites |
| **Constitution steward** | L1–L6 impact, emergency bypass amendments | RFCs that change surgery law, kill-switch, consent, or RET policy; all `emergency_bypass` |

Machine constants: `RESEARCH_RFC_REVIEW_ROLES`.

---

## 3. Status machine

```text
draft → in_review → experiment_running → approved → adopted
                 ↘ rejected (archive)
emergency_bypass  (only with constitution amendment record)
```

| Status | Meaning |
|--------|---------|
| `draft` | Author filling template |
| `in_review` | Roles assigned; template completeness gate |
| `experiment_running` | Champion comparison micro-run in progress |
| `approved` | Roles approved; experiment green; ready for manifest edit |
| `rejected` | Failed gate or experiment; results archived |
| `adopted` | Manifests updated + regenerated |
| `emergency_bypass` | Temporary ship with amendment record; must file follow-up RFC |

Transitions are **idempotent** for the same `rfcId` + `operationId`: replaying an approve receipt does not double-apply.

Concurrent edits to the same `rfcId` must serialize (optimistic revision or lock) — lost updates are a defect.

---

## 4. Approval gates

1. **Template completeness** — all sections in [RFC_TEMPLATE.md](./RFC_TEMPLATE.md) present (hypothesis, related work, eval plan vs champion, rollback, manifest change list).  
2. **Role quorum** — Track C maintainer + (safety reviewer when required) + (constitution steward when L1–L6 / emergency).  
3. **Champion experiment** — strict beat on every required setId; ties reject; safety suites green.  
4. **Manifest list non-empty or justified `none`** — adoption path documented.  
5. **Sovereignty scan** — no forbidden content keys (`utterance`, `promptBody`, …) in RFC body or receipts.

Executable: `evaluateResearchRfcApprovalGate` / `assertResearchIntakeRfcDocumentsCoherent`.

Adoption after approve: [ADOPTION_CHECKLIST.md](./ADOPTION_CHECKLIST.md) (manifest → regenerate → micro-run → PROGRESS) and CI orphan trainer-flag lint.

---

## 5. Emergency safety patch (bypass)

Allowed **only** when all hold:

1. Active production safety incident (locality breach class, refusal erosion, consent violation).  
2. Written **constitution amendment record** citing the law touched and the temporary delta.  
3. Status set to `emergency_bypass` with `amendmentRecordId`.  
4. Follow-up RFC opened within the stated deadline (default 14 days) to either adopt via normal gates or fully revert.

Silent bypass → `research_rfc.silent_bypass_forbidden`.

---

## 6. Rejected RFC archive

On `rejected`:

1. Copy experiment score receipts (metadata-only) to `docs/learning/research-intake/archive/RFC-YYYY-NNN/`.  
2. Keep the RFC document with status `rejected` and a pointer to the archive.  
3. Do **not** delete evidence — future reconsideration needs the champion comparison numbers.

---

## 7. Observability

Emit `learning.research_intake.rfc` events with `rfcId`, `outcome`, optional `deviceId`, and distinct `failureClass` values. Never attach raw learner content. Fleet-scoped governance may use `subjectId=null`.

---

## 8. Acknowledgement

Opening or approving a breakthrough RFC under this repository constitutes acknowledgement of this workflow and constitution L1–L6. Circumventing R1–R6 is an intentional breach.
