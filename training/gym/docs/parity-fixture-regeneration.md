# Parity fixture regeneration runbook

**Audience:** Track C gym maintainers · runtime-harness owners landing intentional frame-contract bumps  
**Charter:** [`../charter.md`](../charter.md)  
**Upstream operator guide (A P6 → B4 sync):** [`packages/runtime-harness/docs/golden-replay-operator.md`](../../../packages/runtime-harness/docs/golden-replay-operator.md)  
**CI gate:** `gym-replay-parity` (path-filtered) · `pnpm --filter @moolam/training-gym ci:parity`

> Governance for **intentional harness bumps** that change harness-frame shape.  
> Fixture updates require **human review**. CI **never** auto-accepts drift.

---

## 0. Cardinal rules (do not break)

1. **Parity is frame-sequence identity** — `sequenceIndex` + frame `type` + payload hash (canonical JSON). Not final-answer equality.
2. **Never auto-accept** — CI (`ci:parity` / `gym-replay-parity`) fails with unified diff + `firstDivergentFrameIndex`. No job rewrites fixtures.
3. **Never hand-edit imported A P6 `expectedFrames`** under `packages/runtime-harness/fixtures/golden-turns/*.json`. Change upstream in `packages/sync-protocol/fixtures/golden-turns`, then sync.
4. **Gym compiles; it does not invent frames** — `training/gym/scenarios/golden/` is derived from harness goldens via `golden:write` / `golden:check`. Prefer fixing parser/assembly or upstream goldens over patching gym task JSON by hand.
5. **Human review before commit** — every regeneration lands as a normal PR with a reviewed `git diff`. Scripts never run `git commit`.
6. **Sovereignty** — telemetry and tickets use `subjectId` / `deviceId` / `failureClass` / turn id + frame diff. Never paste raw learner utterances into logs or issues.

---

## 1. When regeneration is allowed

| Situation | Allowed? | Path |
|-----------|----------|------|
| Intentional A P6 / harness **frame contract** change (reviewed) | Yes | §2 Workflow A |
| Accidental CI red / flaky clock | **No** — fix seed / code; do not regenerate | §3 |
| Gym reimplemented parser / mock frames | **No** — training void; revert | charter §1–2 |
| New domain trajectory added upstream | Yes — after A P6→B4 sync | §2 then gym compile |
| “Make CI green” without understanding the diff | **Forbidden** | — |

If `gym-replay-parity` is red and nobody intended a frame-contract change, **do not** regenerate. Prefer fixing the gym/harness code path so replay matches committed goldens.

---

## 2. Workflow A — Intentional harness frame-contract bump

**When:** maintainers deliberately change production harness frames (new frame fields, ordering, terminal semantics) and land matching A P6 goldens.

### 2.1 Upstream A P6 + B4 import (source of truth)

Follow the B4 operator guide first:

```bash
# From repo root
pnpm --filter @moolam/runtime-harness golden:sync
git diff -- packages/runtime-harness/fixtures/golden-turns/
pnpm --filter @moolam/runtime-harness golden:check
pnpm --filter @moolam/runtime-harness golden:replay
```

- Review the diff yourself. Confirm only intended turns changed.
- Do **not** hand-edit imported `expectedFrames` in B4.
- Confirm terminal frames remain production-only: `TURN_COMPLETE` / `HARNESS_ERROR`.

### 2.2 Recompile gym golden episode fixtures (derived)

```bash
pnpm --filter @moolam/training-gym golden:write
git diff -- training/gym/scenarios/golden/
pnpm --filter @moolam/training-gym golden:check
```

`golden:write` materializes `training/gym/scenarios/golden/` from harness goldens. It **never auto-commits**. If the diff is unexpected, abort and investigate before writing again.

Refresh the catalog when scenario ids / slice tags change:

```bash
pnpm --filter @moolam/training-gym catalog:write
pnpm --filter @moolam/training-gym catalog:check
```

### 2.3 Prove gym replay parity (canonical + GymEnv path)

```bash
pnpm --filter @moolam/training-gym ci:parity
pnpm --filter @moolam/training-gym test
```

Expect structured events:

```json
{
  "event": "training.gym.replay_parity",
  "outcome": "ok",
  "phase": "ci",
  "subjectId": "subj-gym-replay-parity-ci",
  "deviceId": "dev-gym-replay-parity-ci",
  "turnCount": 5,
  "domainCount": 5
}
```

On failure, CI prints `firstDivergentFrameIndex` + `frameType` + unified diff. That locator is the review unit — not a license to silence the gate.

### 2.4 Land with a human-reviewed PR

Checklist before merge:

- [ ] A P6 source changed first (if `expectedFrames` moved)
- [ ] B4 `golden:sync` + human `git diff` of harness fixtures
- [ ] Gym `golden:write` + human `git diff` of `training/gym/scenarios/golden/`
- [ ] `ci:parity` green locally
- [ ] Path-filtered CI job `Gym replay parity (path-filtered)` green on the PR
- [ ] No script auto-commit; no CI auto-accept; no hand-edit of imported A P6 JSON
- [ ] Commit / PR body states **why** the frame contract changed (not “fix CI”)

---

## 3. Workflow B — Accidental drift (do **not** regenerate)

**Symptom:** `canonical_drift` / `firstDivergentFrameIndex=N` after an unrelated gym or harness change.

**Remedy:**

1. Read the unified diff at the failing frame index.
2. Prefer fixing **gym bridge / harness code** so replay matches the committed golden.
3. Prefer fixing **non-determinism** (seeded clock / RNG / retrieval) when entropy polluted the sequence.
4. Only if the frame contract itself changed intentionally → escalate to Workflow A.

Never:

- Patch only gym scenario JSON to match a buggy replay
- Disable `gym-replay-parity` or `--no-verify` the gate
- Paste learner utterance bodies into the failure ticket

---

## 4. Workflow C — New production trajectory domain

**When:** a new A P6 golden turn is added and must join the multi-domain parity corpus.

1. Land the turn upstream (A P6) → B4 sync (Workflow A §2.1).
2. Map the turn id → domain in `training/gym/src/frame_parity.mjs` (`PARITY_TRAJECTORY_DOMAIN_BY_ID` / `PARITY_CORPUS_DOMAINS`) if it is a new capability domain.
3. Recompile gym goldens + catalog (§2.2).
4. Prove `ci:parity` reports the new `domainCount` / turn.
5. Human review — domain map changes are part of the PR, not silent.

---

## 5. Failure classes operators will see

| Signal | Meaning | Next step |
|--------|---------|-----------|
| `canonical_drift` + `firstDivergentFrameIndex` | Replay ≠ committed frames | Diff at index; Workflow B unless intentional bump |
| `missing_corpus` / missing domain | Parity corpus incomplete | Add domain mapping + golden (§4) |
| `missing_subject` | Fixture / bind missing `subjectId` | Reject; fix fixture — never invent cross-subject |
| `GOLDEN_TURN_DRIFT` (B4) | Harness replay ≠ A P6 expected | Upstream operator guide |
| `golden:check` drift (gym) | On-disk gym scenarios ≠ recompile | `golden:write` only after human intent |
| Path-filter skip | PR did not touch gym/harness | Expected; push to main still runs parity |

Structured events: `training.gym.replay_parity` with `subjectId`, `deviceId`, `outcome`, `failureClass`, optional `frameIndex` / `frameType` — never raw transcript text.

---

## 6. Sovereignty & subject isolation

- Synthetic subject ids in goldens (e.g. `anika-k`) stay synthetic.
- Cross-subject access in loaders/replay is a defect.
- Debug diffs are **frame/event** diffs — not utterance dumps.
- Locality (`on-device` / `self-hosted`) of recorded trajectories must not be violated by exporting raw content for “debug”.

---

## 7. Scalability

- Corpus and frame compare limits (`GYM_REPLAY_CORPUS_LIMIT`, `GYM_FRAME_COMPARE_LIMIT`) stay bounded.
- Do not expand regeneration into unbounded scans of memory / friction logs.
- Prefer one intentional PR per frame-contract bump (attribution).

---

## 8. Related commands (quick)

```bash
# Path-filtered CI entrypoint (also used locally)
pnpm --filter @moolam/training-gym ci:parity

# Derived gym scenarios
pnpm --filter @moolam/training-gym golden:check
pnpm --filter @moolam/training-gym golden:write   # human review before commit

# Catalog after scenario set changes
pnpm --filter @moolam/training-gym catalog:check
pnpm --filter @moolam/training-gym catalog:write

# Upstream B4 import
pnpm --filter @moolam/runtime-harness golden:sync
pnpm --filter @moolam/runtime-harness golden:check
pnpm --filter @moolam/runtime-harness golden:replay
```

---

## 9. Acknowledgement

Running `golden:write` / landing fixture regeneration constitutes acknowledgement of this runbook and the anti-cheat charter. Circumventing human review or CI auto-accept of drift is treated as an intentional breach of the parity invariant.
