# Research-intake RFC → Track C generator manifests

**Status:** binding hook for adopted breakthrough RFCs  
**RFC template:** [`docs/learning/research-intake/RFC_TEMPLATE.md`](./RFC_TEMPLATE.md)  
**Review workflow:** [`docs/learning/research-intake/REVIEW_WORKFLOW.md`](./REVIEW_WORKFLOW.md)  
**Generator entry:** `node docs/stages/tracks/_generator/generate-tracks.mjs` (internal operator path)

Adopted research **must** land as manifest edits under `docs/stages/tracks/_generator/track-c/` (and any declared `training/` paths in the RFC), then regenerate. One-off trainer forks that bypass this directory are void.

---

## 1. Why this file exists

Track C plan docs are generated from phase manifests in the generator folder (`c0.mjs` … `c7.mjs`). Research that changes the learning plan, phase spine, or task graph belongs in those manifests — not as hand-edited drift in generated trees.

---

## 2. Adoption sequence (after RFC status = `approved`)

Follow the binding checklist: [`docs/learning/research-intake/ADOPTION_CHECKLIST.md`](./ADOPTION_CHECKLIST.md).

1. Edit the RFC’s listed manifest paths (typically `c7.mjs` or the phase that owns the technique).  
2. Run the track generator (`generate-tracks.mjs`).  
3. Re-sync PROGRESS / queue checkboxes from track PROGRESS when needed.  
4. Confirm micro-run green (commands named in the RFC).  
5. Land regenerated docs + manifest edits in one PR citing `RFC-YYYY-NNN`.  
6. Mark the RFC `adopted` with the PR / commit reference.

Partial failure after the first durable manifest write → stop; restore last good manifests; never leave a half-regenerated tree.

---

## 3. Manifest change list (RFC §5)

Every adopted RFC must name concrete manifest files (or justify `none` for training-only hyperparameter pins that still record the pin path under `training/`). Examples of valid targets:

| Manifest / path | Typical RFC impact |
|-----------------|--------------------|
| `c4.mjs` | GRPO / queue / lineage plan text |
| `c5.mjs` | Adapter delta / promotion plan text |
| `c7.mjs` | Governance / research-intake outcomes |
| `training/**` pins declared in the RFC | Hyperparameters, critic versions |

Editing generated markdown under internal stage trees by hand to “absorb” research is a defect.

---

## 4. Emergency bypass

Emergency safety patches that temporarily skip a full RFC still **must not** silently edit generator manifests. Record the constitution amendment, ship the minimal fix, and file a follow-up RFC that either adopts via this sequence or reverts the temporary delta.

---

## 5. Worked example

Process proof (not yet adopted): [`docs/learning/research-intake/rfcs/RFC-2026-004-grpo-g8-to-g6.md`](./rfcs/RFC-2026-004-grpo-g8-to-g6.md) — champion G=8 → challenger G=6, clip ε=0.2 unchanged, `c4.mjs` + training pin on the manifest change list. Machine mirror: `packages/learning/src/research_intake_worked_example.ts`.

---

## 6. Machine check

`packages/learning/src/research_intake_rfc.ts` asserts this file exists and phrases the adoption invariant so the process cannot rot into shelfware. The worked-example module asserts the GRPO RFC stays concrete (hypothesis, micro-run, champion criteria, manifest path). Adoption checklist + orphan trainer-flag CI: `packages/learning/src/research_intake_adoption.ts` / `pnpm --filter @moolam/learning research-rfc-adoption:check`.
