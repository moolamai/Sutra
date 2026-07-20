# LLM-judge policy — Track C narrow lane

**Status:** binding for every LLM-as-judge path under Sutra reward engineering  
**Owners:** Track C critics · `@moolam/learning` / `@moolam/training-critics` maintainers  
**Machine mirror:** `packages/learning/src/critics/llm_judge_policy.ts` · lane plugin `packages/learning/src/critics/llm_judge_lane.ts` · published path `training/critics/llm_judge_lane.ts`  
**Executable peers:** hack suite CI (`pnpm --filter @moolam/learning hack:check`) · core / process / pack-oracle critics · human-label calibration gate  
**Parent law:** Learning constitution ([CONSTITUTION.md](./CONSTITUTION.md)) — rule critics own verifiable outcomes; LLM judges never replace them

This document is **governance law** for the narrow LLM-judge lane — not aspiration. A training run, critic plugin, or eval harness that uses an LLM judge outside this policy is void. Shelfware without a CI coherence gate is a defect.

---

## 1. Cardinal rules

| # | Rule | One-line |
|---|------|----------|
| J1 | **Tone + clarity only** | Allowed aspects are exactly `tone` and `clarity`. No other aspect may enter an LLM-judge reward. |
| J2 | **Verifiable domains forbidden** | LLM judges must not score mastery math, citations, schema validity, or contract obligations. |
| J3 | **One aspect per call** | Each judge invocation scores exactly one allowed aspect. Bundled multi-aspect prompts are void. |
| J4 | **Never replaces rule critics** | Core rubric, process rewards, and pack oracles remain the sole scorers for verifiable structure and outcomes. |
| J5 | **Pinned judge identity** | Every judge output must pin `judgeModelId` + `judgePromptVersion` (opaque ids — never prompt bodies in telemetry). |
| J6 | **Own eval gate** | Judge quality must pass an independent agreement gate on held-out tone/clarity fixtures before use in training. |
| J7 | **Hack suite first** | New critic / judge versions clear the hack suite (`hack:check`) before calibration or training config entry. |

---

## 2. Allowed aspects (closed set)

| Aspect id | What it may judge | What it must not judge |
|-----------|-------------------|------------------------|
| `tone` | Register, politeness, pedagogical warmth vs harshness | Correctness of math, citations, schema, obligations |
| `clarity` | Readability / structure of non-verifiable prose | Whether an answer is factually right |

**Machine constants** (must match `LLM_JUDGE_ALLOWED_ASPECTS` in the mirror):

```text
LLM_JUDGE_ALLOWED_ASPECTS = ["clarity", "tone"]   # sorted canonical order
```

Any aspect id outside this set → `llm_judge.forbidden_aspect`.

---

## 3. Forbidden verifiable domains (hard denylist)

LLM judges **must refuse** (typed failure — never silent zero) when asked to score:

| Denylist id | Examples owned by rule critics / pack oracles |
|-------------|-----------------------------------------------|
| `mastery_math` | Mastery math oracles (`oracle.teacher.mastery-math`) |
| `citations` | Citation resolution oracles (`oracle.teacher.citation`) |
| `schema_validity` | Trajectory / wire schema validation (`schema_failure` core component) |
| `contract_obligations` | Invariant / obligation breaches (`invariant_violation` core component) |

**Machine constants:** `LLM_JUDGE_FORBIDDEN_DOMAINS` in the mirror.

**Worked example — reject (forbidden domain):**

A training config registers `judge.aspect=mastery_math` with a pinned LLM. Verdict: **void** — mastery is a pack-oracle / rule-critic concern. Use `training/critics/fixtures/pack-oracles/teacher-mastery.manifest.json`, not an LLM judge.

**Worked example — reject (bundled aspects):**

A single prompt asks “score tone and clarity together.” Verdict: **void** (`llm_judge.multi_aspect_call`). Issue two separate calls: one `tone`, one `clarity`.

---

## 4. Separate call per aspect

```text
call_1: aspect=tone    → { aspect: "tone", score, judgeModelId, judgePromptVersion }
call_2: aspect=clarity → { aspect: "clarity", score, judgeModelId, judgePromptVersion }
```

- No shared hidden state across aspects that could smuggle verifiable grading.
- Aggregation (if any) happens **outside** the judge — and must not override a negative rule-critic total.
- Concurrent turns for the same `subjectId` must not interleave aspect writes without subject-scoped locking (lost-update → typed failure).

### 4.1 Isolated lane plugin (optional)

Factory: `createIsolatedLlmJudgeLane` in `packages/learning/src/critics/llm_judge_lane.ts` (re-exported from `training/critics/llm_judge_lane.ts`).

| Surface | Behavior |
|---------|----------|
| `scoreAspect({ aspect, subjectId, … })` | Exactly one aspect; pins `judgeModelId` + `judgePromptVersion` on every judgment |
| `scoreAllowedAspectsSeparately(…)` | Two **separate** calls (`clarity` then `tone` in canonical order) — never one bundled prompt |
| `createAspectCritic(aspect)` | Optional `TrajectoryCritic` bound to a **single** aspect at construct time |

**Worked example — accept (pinned output):**

```text
lane = createIsolatedLlmJudgeLane({
  judgeModelId: "judge.tone.local-v1",
  judgePromptVersion: "prompt.tone.1.0.0",
  scoreAspectFn: ({ aspect }) => (aspect === "tone" ? 0.4 : 0.2),
})
judgment = await lane.scoreAspect({
  subjectId: "subj.a", deviceId: "dev.1", turnId: "turn.1", aspect: "tone",
})
→ { aspect: "tone", score: 0.4, judgeModelId: "judge.tone.local-v1", judgePromptVersion: "prompt.tone.1.0.0", … }
```

**Worked example — reject (hard denylist):**

`scoreAspect({ aspect: "mastery_math", … })` → typed `llm_judge.forbidden_domain` (never silent zero).

**Worked example — reject (bundled aspects):**

`assertSingleLlmJudgeAspectCall(["tone", "clarity"])` → typed `llm_judge.multi_aspect_call`.

The scorer is **injected** — `@moolam/learning` does not open network sockets for judging. Lane scores enter GRPO / training config only after the independent agreement gate (§5) is green for the pinned judge identity.

---

## 5. Eval gate requirements (before training use)

| Requirement | Meaning |
|-------------|---------|
| Held-out fixtures | Tone/clarity labels independent of the main critic calibration set |
| Agreement threshold | Declared per `judgeModelId` + `judgePromptVersion` (default band documented with the gate) |
| Pin before train | Training config must record the passing gate content hash |
| Independence | Failing the judge gate does **not** waive hack-suite or human-label calibration |

Default agreement threshold (machine mirror): `LLM_JUDGE_DEFAULT_AGREEMENT_THRESHOLD = 0.85`.

### 5.1 Implemented gate

| Surface | Path |
|---------|------|
| Held-out set | `training/eval/llm_judge_sets/` (`excludeFromCriticCalibration: true`) |
| Machine gate | `packages/learning/src/critics/llm_judge_gate.ts` |
| Published path | `training/critics/llm_judge_lane.ts` |
| CI | `pnpm --filter @moolam/learning llm-judge-gate:check` |

Metric: Cohen's κ on binary `pass`/`fail` human labels vs judge scores (≥ 0 → pass). Per-aspect breakdown; both `tone` and `clarity` must clear the threshold. Known-good oracle must promote; known-bad always-pass must reject. Passing pin records `judgeModelId`, `judgePromptVersion`, and `setContentHash`.

**Worked example — accept:**

Oracle scorer mirrors held-out labels → κ = 1.0 ≥ 0.85 → `trainingConfigAllowed: true` with pinned `setContentHash`.

**Worked example — reject:**

Always-pass scorer on a balanced pass/fail set → κ ≈ 0 < 0.85 → typed `llm_judge.agreement_below_threshold` / gate reject. Main critic `calibration:check` is unaffected (independent).

Until this gate is green for a pinned judge identity, LLM-judge scores must not enter GRPO / training config.

---

## 6. Relationship to rule critics (never replace)

| Surface | Owner | LLM judge? |
|---------|-------|------------|
| Format / protocol breach | Core rubric | No |
| Invariant / obligation | Core rubric | No |
| Schema failure | Core rubric | No |
| Human ACCEPTED / REJECTED | Core rubric + C0 signal | No |
| Correction-loop process | Process reward critic | No |
| Mastery / citation oracles | Pack oracles | No |
| Degenerate reward hacks | Hack suite ≤ 0 | No |
| Tone / clarity (non-verifiable) | LLM-judge lane (this policy) | Yes, gated |

**Worked example — legal path:**

Trajectory already scored by `critic.core-rubric@1.0.0` and process rewards. Optional lane adds `tone` then `clarity` judgments with pinned model ids. Composite training reward **must not** let positive tone/clarity flip a ≤ 0 hack-suite or negative obligation outcome into a promote.

---

## 7. Sovereignty and subject isolation

- Every judge request / score write is scoped by `subjectId` (+ `deviceId` on the install).
- Cross-subject judge batches are a defect (`llm_judge.subject_scope`).
- Locality stays `on-device` / `self-hosted` as declared on the trajectory — judge calls must not exfiltrate raw learner utterances, keystrokes, or frame bodies.
- Telemetry fields: `subjectId`, `deviceId`, `aspect`, `judgeModelId`, `judgePromptVersion`, `outcome`, `failureClass` — **never** prompt text or completion bodies.

**Concurrency / idempotency:**

- Concurrent aspect calls for the same `subjectId` must be conflict-safe (no silent last-write-wins on score pins).
- Partial failure after the first durable judge write → typed `failureClass`, never silent continue.
- Replayed judge request with the same pin ids is idempotent (same score record; no double-apply into training mix).

---

## 8. Observability

| Event | Outcomes |
|-------|----------|
| `learning.critic.llm_judge_policy` | `ok` \| `fail` \| `advisory` |
| `learning.critic.llm_judge_lane` | `ok` \| `fail` \| `advisory` (aspect judgments; may set `idempotentReplay`) |
| `learning.critic.llm_judge_gate` | `ok` \| `fail` \| `advisory` (agreement gate; may set `agreementValue`, `idempotentReplay`) |
| Distinct failure classes | `llm_judge.forbidden_aspect`, `llm_judge.forbidden_domain`, `llm_judge.multi_aspect_call`, `llm_judge.unpinned_identity`, `llm_judge.subject_scope`, `llm_judge.policy_incoherent`, `llm_judge.source_missing`, `llm_judge.agreement_below_threshold`, `llm_judge.gate_rejected`, `llm_judge.calibration_independence`, … |

---

## 9. Scalability

- Aspect set size is fixed (2). No unbounded aspect registries.
- Judge calls per turn: at most one per allowed aspect (≤ 2).
- Hot path stays on deterministic critics; LLM judge is optional and off the default GRPO path until gated.

---

## 10. Coherence checklist (CI)

The machine mirror must prove this document is present and encodes:

1. Both allowed aspects (`tone`, `clarity`)
2. All four forbidden domains
3. Separate-call / one-aspect rule
4. Pin requirements (`judgeModelId`, `judgePromptVersion`)
5. Explicit “never replaces rule critics”
6. `subjectId` sovereignty language
7. Hack-suite-before-training ordering cue (`hack:check`)

```bash
pnpm --filter @moolam/learning llm-judge-policy:check
pnpm --filter @moolam/learning llm-judge-gate:check
```

Held-out fixtures: `training/eval/llm_judge_sets/` (independent of `training/eval/calibration_sets/`).

---

## 11. References

- Hack fixtures: `training/critics/fixtures/hack/` · `pnpm --filter @moolam/learning hack:check`
- Core rubric goldens: `training/critics/fixtures/core-rubric/`
- Pack oracles: `training/critics/fixtures/pack-oracles/`
- Human calibration: `training/eval/calibration_sets/` · `calibration:check`
- LLM-judge agreement: `training/eval/llm_judge_sets/` · `llm-judge-gate:check`
- Constitution: [CONSTITUTION.md](./CONSTITUTION.md)
