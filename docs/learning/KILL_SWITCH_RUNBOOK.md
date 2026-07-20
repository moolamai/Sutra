# Kill-switch operator runbook — revert all learned components

**Audience:** on-call / fleet operators / Track C release managers  
**Law:** Constitution L4 ([CONSTITUTION.md](./CONSTITUTION.md) §5)  
**Machine mirror:** `packages/learning/src/kill_switch.ts` (`runKillSwitchOrchestrator` — typed operator API) · `packages/learning/src/governance.ts` (`applyKillSwitch`, runbook coherence)  
**Verify once:** golden-turn / gym replay parity (commands below)

> One audited operation reverts **every** learned artifact to its deterministic baseline. Partial reverts are drill **failures**, not “best effort.”

**Sovereignty:** emit metadata-only telemetry (`subjectId`, `deviceId`, `outcome`, `failureClass`). Never log raw learner utterances, adapter weight tensors, or corpus shard bodies.

---

## 0. When to fire

| Trigger | Action |
|---------|--------|
| Safety incident / suspected reward hack | Fire kill-switch **immediately**, then triage |
| Scheduled safety-alignment drill (see §5) | Fire kill-switch end-to-end; record drill outcome |
| Promote gate / parity unexplained red after learn | Prefer kill-switch before debugging under learned flags |
| Suspected multi-surgery ship | Kill-switch, then open constitution L1 incident |

Fleet scope: `subjectId=null` in telemetry. Subject-bound hot-swap: pass the affected `subjectId` (never invent cross-subject mass revert without audit).

---

## 1. Copy-paste procedure (fleet)

Run from repository root. Prefer the checklist in order — do not skip verification.

### 1.1 Declare drill / incident id

```bash
# Synthetic scope only — never put learner PII in the id
export KS_DEVICE_ID="ops-kill-switch-$(date -u +%Y%m%dT%H%M%SZ)"
export KS_SCOPE="fleet"   # or subjectId when subject-bound
```

```powershell
$env:KS_DEVICE_ID = "ops-kill-switch-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$env:KS_SCOPE = "fleet"
```

### 1.2 One-shot revert (learned → baseline)

<!-- RUNBOOK_KILL_SWITCH_FLAGS -->
Flip **all** learned feature flags off (names are normative for operators and tests):

| Component | Flag / pin | Baseline state |
|-----------|------------|----------------|
| `adapter` | `learned_adapter` / hot-swap pin | **unpinned** · flag `off` · active adapter = **champion/base** |
| `critic` | `learned_critic` | deterministic critic version |
| `mix` | `learned_mix_policy` | committed mix policy baseline |
| `policy` | `learned_routing` · `learned_compaction` · `learned_healing` | deterministic policy pointers |

Copy-paste checklist (record each line in the incident ticket):

```text
[ ] learned_adapter=off  AND adapter pin cleared AND challenger unloaded → champion/base
[ ] learned_critic=off
[ ] learned_mix_policy=off
[ ] learned_routing=off
[ ] learned_compaction=off
[ ] learned_healing=off
```
<!-- /RUNBOOK_KILL_SWITCH_FLAGS -->

**Typed operator API (preferred):** call `runKillSwitchOrchestrator` from
`packages/learning/src/kill_switch.ts` with a stable `operationId`, scoped
`subjectId` (or fleet `null`), and the registered operator surface. The
orchestrator:

1. Serializes concurrent applies for the same `subjectId`
2. Completes in-flight turns under their **pinned checkpoint** (no mid-turn unload)
3. Unloads the challenger adapter to `championAdapterId`
4. Disables every learned flag (including compaction, routing, healing)
5. Writes a metadata-only **audit record** (`kill-switch.audit.v1`)

A second invoke against an already-baseline surface is an **idempotent advisory
no-op** (outcome `advisory_idempotent`) — never double-apply digests.

Operator surface fallback: governance + flag/config (C5/C6 own the hot-swap CLIs). Until those ship, treat the checklist as the single atomic “operation” — either complete the whole checklist in one change window or abort and mark `kill_switch_partial`.

### 1.3 Emit audit telemetry

Emit structured event (metadata only):

```json
{
  "event": "learning.governance.kill_switch",
  "outcome": "ok",
  "subjectId": null,
  "deviceId": "<KS_DEVICE_ID>",
  "action": "kill_switch",
  "componentsReverted": ["adapter", "critic", "mix", "policy"]
}
```

Orchestrator telemetry (also metadata-only):

```json
{
  "event": "learning.kill_switch.orchestrator",
  "outcome": "ok",
  "subjectId": null,
  "deviceId": "<KS_DEVICE_ID>",
  "action": "audit",
  "adapterRevertedTo": "adapter.champion.baseline",
  "componentsReverted": ["adapter", "critic", "mix", "policy"]
}
```

Partial failure **must** set `"outcome": "rejected"` and `"failureClass": "kill_switch_partial"` (governance) or `"kill_switch.partial"` (orchestrator) with the remaining-on components named — never silent continue.

### 1.4 Verify against golden turns **once**

<!-- RUNBOOK_KILL_SWITCH_VERIFY -->
Preferred drill API: call `runKillSwitchGoldenRestorationDrill` with the same
subject-scoped store and the runtime harness's production-path
`replayGoldenTurn` executor. It loads the committed protocol corpus, fires the
one-operation orchestrator, then
requires every replay's canonical frame bytes to equal `expectedFrames`.
Telemetry contains only turn ids and SHA-256 expected/actual hashes; frame
content is never logged. `kill_switch.golden_mismatch` is a hard failure.

Then run the package-level parity commands:

```bash
# Gym anti-cheat (frame-identical production goldens)
pnpm --filter @moolam/training-gym parity:check

# Harness golden replay (A P6 path)
pnpm --filter @moolam/runtime-harness golden:replay
```

Expected: both commands exit `0`.  
If either fails: **do not** re-enable learned flags; open an incident — kill-switch revealed a baseline or harness regression.
<!-- /RUNBOOK_KILL_SWITCH_VERIFY -->

Run verification **once** per kill-switch firing (not in a retry loop that auto-rewrites fixtures).

---

## 2. Subject-bound kill-switch

When only one subject’s hot-swap pin must revert:

1. Set `subjectId=<that subject>` on the audit event (not `null`).  
2. Clear **only that subject’s** adapter pin / learned overlays.  
3. Do **not** load another subject’s state to “help debug.” Cross-subject access is a defect.  
4. Still flip fleet-global learned flags if the incident is fleet-wide; document scope in the ticket.

---

## 3. Failure modes (normative)

| Failure | `failureClass` | Operator action |
|---------|----------------|-----------------|
| Adapter unpinned but `learned_routing` still on | `kill_switch_partial` | Finish remaining flags; drill fails until green |
| Concurrent turns for same `subjectId` during pin clear | race / typed conflict | Serialize kill-switch; retry once; never double-apply digests |
| Replay of same kill-switch audit | idempotent no-op | Second apply must leave baseline state unchanged |
| Golden / parity red after kill-switch | baseline regression | Keep flags off; escalate — do not re-learn to “fix” |
| Downstream timeout mid-checklist | typed timeout | Abort with `kill_switch_partial`; resume checklist from top (idempotent) |

---

## 4. Idempotency

Replaying the kill-switch checklist against an already-baseline fleet must:

- leave all flags `off` and pins cleared  
- emit `outcome=ok` with `action=kill_switch` (idempotent apply)  
- **not** mutate baseline registry hashes or golden fixtures  

---

## 5. Safety-alignment drill schedule

<!-- RUNBOOK_KILL_SWITCH_DRILL -->
The **binding drill schedule** is:

| Cadence | Owner | What to run | Pass criteria |
|---------|-------|-------------|---------------|
| **Monthly — first day, 06:00 UTC** | Learning safety on-call | `.github/workflows/kill-switch-drill.yml` plus the recurring operator-calendar event | Telemetry `outcome=ok`; baseline-reversion tests and production-path `golden:replay` green |
| **After every promotion** that enables a learned flag | Promotion owner | Kill-switch dry-run in staging (or shadow) | Same as monthly; no production traffic required |
| **On P0 safety** | Incident commander | Immediate production kill-switch | Flags off within the change window; verify once |

### Operator calendar (binding)

Create a recurring calendar event with these exact fields:

- Title: `Monthly kill-switch baseline-reversion drill`
- Recurrence: monthly on day 1 at 06:00 UTC
- Owner: Learning safety on-call; invite the release manager as backup
- Duration: 30 minutes; do not cancel because the CI run was green
- Links: scheduled workflow, this runbook, and the open incident query
- Required secret: repository Actions secret `KILL_SWITCH_PAGER_WEBHOOK_URL`
- Optional assignment: repository variable `KILL_SWITCH_ON_CALL_GITHUB`

Copy-paste a manual drill or recovery run:

```bash
gh workflow run kill-switch-drill.yml --ref main
gh run list --workflow kill-switch-drill.yml --limit 1
gh run watch --exit-status
```

On failure, the workflow sends a bounded metadata-only P0 page and opens or
updates `[P0] Scheduled kill-switch drill failed`. A missing pager webhook is
itself a failed notification step. Keep learned flags off, acknowledge the page,
and follow §1; never paste learner content into the incident.

Record each drill in the ops ticket with: workflow run URL, `KS_DEVICE_ID`, UTC
time, scope (`synthetic-ci`, `fleet`, or `subjectId`), verify command exit
codes, and whether any `kill_switch_partial` occurred.

Cross-links:

- Constitution L4: [CONSTITUTION.md](./CONSTITUTION.md)  
- Anti-cheat / parity: [training/gym/charter.md](../../training/gym/charter.md)  
- Continuous-loop governance: self-evolution governance wave plan  
- Safety-alignment sibling: consent-law and candidate red-team cadence (do not wait on those to fire L4)
<!-- /RUNBOOK_KILL_SWITCH_DRILL -->

---

## 6. Related surfaces

- One-surgery lint: `pnpm --filter @moolam/learning surgery:check`  
- Baseline registry: `training/eval/baseline_registry.json`  
- Package: [`packages/learning`](../../packages/learning/README.md)
