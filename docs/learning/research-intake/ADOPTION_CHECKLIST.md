# RFC adoption → manifest regeneration checklist

**Status:** binding for every approved breakthrough RFC before status may become `adopted`  
**Template:** [RFC_TEMPLATE.md](./RFC_TEMPLATE.md)  
**Workflow:** [REVIEW_WORKFLOW.md](./REVIEW_WORKFLOW.md)  
**Generator hook:** [`docs/stages/tracks/_generator/track-c/research-intake-rfc.md`](../../stages/tracks/_generator/track-c/research-intake-rfc.md)  
**Worked example:** [rfcs/RFC-2026-004-grpo-g8-to-g6.md](./rfcs/RFC-2026-004-grpo-g8-to-g6.md)  
**Machine mirror:** `packages/learning/src/research_intake_adoption.ts`  
**CI:** `pnpm --filter @moolam/learning research-rfc-adoption:check`

**Invariant:** Adopted RFCs update Track C generator manifests and regenerate — never ad-hoc trainers. One-off trainer forks that bypass this checklist are void. No learning-algorithm change ships without an approved RFC and champion comparison experiment.

---

## 1. Ordered checklist (approved → adopted)

Execute **in order**. Do not mark `adopted` until every step is green. Partial failure after the first durable side effect → stop, restore last good manifests, never leave a half-regenerated tree.

| # | Step | Done when |
|---|------|-----------|
| 1 | **Approved RFC** | Status `approved`; role quorum + champion experiment receipts on file (ties do not promote) |
| 2 | **Update track-c manifest** | Edit every path in the RFC §5 manifest change list under `docs/stages/tracks/_generator/track-c/` (and declared `training/` pins) |
| 3 | **Regenerate** | `node docs/stages/tracks/_generator/generate-tracks.mjs` succeeds; no hand-edits to generated Track C trees |
| 4 | **Micro-run green** | RFC’s declared CI micro-run commands pass (learning package tests / gym micro-run as named) |
| 5 | **PROGRESS update** | Track `PROGRESS.md` + implementations queue reflect the adoption; if checkboxes reset, `node docs/stages/tracks/_generator/compare-progress-order.mjs --fix` |
| 6 | **Mark adopted** | RFC status → `adopted` with PR/commit citing `RFC-YYYY-NNN` |

Replaying the same `operationId` for a completed step is **idempotent** — do not double-apply manifest edits.

### Copy-paste command block

```text
# After RFC status = approved
# 1) Edit manifests listed in RFC §5 (e.g. c4.mjs)
node docs/stages/tracks/_generator/generate-tracks.mjs
node docs/stages/tracks/_generator/compare-progress-order.mjs --fix
# 2) Run the RFC’s micro-run (example for GRPO worked example):
pnpm --filter @moolam/learning build
node --test packages/learning/tests/grpo_group.test.mjs packages/learning/tests/grpo_advantage.test.mjs
pnpm --filter @moolam/learning research-rfc-adoption:check
# 3) Land PR citing RFC-YYYY-NNN; mark RFC adopted
```

---

## 2. CI lint — orphan trainer flags

Trainer feature flags that change learning-algorithm behavior **must** cite an `rfcRef` (`RFC-YYYY-NNN`). An **orphan** flag is any enabled trainer flag (or `orphanTrainerFork: true` marker) without a valid RFC reference.

| Case | Verdict |
|------|---------|
| Enabled flag + `rfcRef: "RFC-2026-004"` | allow |
| Enabled flag + missing / empty `rfcRef` | reject — `research_rfc.orphan_trainer_flag` |
| `orphanTrainerFork: true` without `rfcRef` | reject — same failure class |
| Disabled flag without `rfcRef` | allow (dormant; enabling requires RFC) |
| Emergency bypass with constitution amendment only | allow temporary ship; follow-up RFC still required — never silent |

Fixtures (process proof):

- Green: [`fixtures/trainer-flags-ok.json`](./fixtures/trainer-flags-ok.json)
- Red (orphan): [`fixtures/trainer-flags-orphan.json`](./fixtures/trainer-flags-orphan.json)

Executable: `lintResearchIntakeTrainerFlags` / `proveResearchIntakeAdoptionChecklist`.

---

## 3. Edge cases

| Edge | Handling |
|------|----------|
| Emergency safety patch | May skip full RFC **only** with explicit constitution amendment record — never silent; must not silently edit generator manifests |
| Rejected RFCs | Archive experiment results under `archive/RFC-YYYY-NNN/`; do not adopt |
| Concurrent subject turns | Cognitive-state races are out of band; adoption receipts key by `rfcId` + `operationId` |
| Partial failure mid-checklist | Stop; restore last good manifests; resume from last completed idempotent step |
| Replay / duplicate request | Same `operationId` returns prior receipt — never double-apply |

Sovereignty: checklist receipts and lint telemetry are metadata-only (`subjectId`, `deviceId`, `rfcId`, outcomes). No raw learner content.

---

## 4. Observability

Emit `learning.research_intake.rfc` with `action` in `assert_adoption_checklist` \| `evaluate_adoption` \| `lint_trainer_flags` \| `ci_prove`, plus distinct `failureClass` values. Never attach utterances.
