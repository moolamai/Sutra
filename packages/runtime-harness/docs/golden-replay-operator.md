# Golden replay — operator workflow

**Audience:** maintainers landing A P6 golden-turn updates into B4 (`@moolam/runtime-harness`)  
**Package:** `packages/runtime-harness`  
**Spec:** CK-07 (token parser / golden replay)

A P6 owns harness-frame golden turns (`input` + `expectedFrames`). B4 **imports** those bytes, replays them through `ToolCallParser` → frame assembly, and gates CI on byte-identical canonical JSON. Scripts print diffs; they never auto-commit.

## Invariants (do not break)

1. **No hand-edited A P6 expectedFrames** under `fixtures/golden-turns/*.json`. Change upstream in `packages/sync-protocol/fixtures/golden-turns`, then sync.
2. **Canonical compare:** sorted keys, 2-space indent, trailing newline (`canonicalizeFramesJson` / `canonicalizeEventsJson`).
3. **Human review** of every sync/overwrite before `git commit`. Sync prints a report; it does not run `git commit`.
4. **Chunk purity:** multi-chunk and joined feeds must produce the same events/frames. Chunk-boundary fuzz enforces this in CI.
5. **Subject scope:** fixtures carry `subjectId`; telemetries must include `subjectId` / `deviceId` / outcome — never paste learner/user utterance content into tickets or structured logs.

## Corpus layout

| Path | Role |
|------|------|
| `packages/sync-protocol/fixtures/golden-turns/` | **Source of truth** (A P6) |
| `packages/runtime-harness/fixtures/golden-turns/*.json` | Imported A P6 bytes (+ `manifest.json`, `A-P6-ORIGIN.txt`) |
| `packages/runtime-harness/fixtures/golden-turns/malformed-fence/` | B4-only CK-07 regression goldens (unclosed / nested / undeclared). **Not** synced from A P6 |
| `packages/runtime-harness/fixtures/golden-turns/README.md` | Short pointer to this doc |

Top-level `golden:check` only compares **top-level** `*.json` with A P6. Do not drop extra A P6-shaped JSON at the top level of the import dir (reported as `EXTRA_LOCAL`).

## Commands (worked)

From the repo root (pnpm 10.30.3, Node ≥ 22):

```bash
# 1) Import / refresh A P6 bytes into runtime-harness
pnpm --filter @moolam/runtime-harness golden:sync

# 2) Parity gate (CI): fail if local import drifts from A P6
pnpm --filter @moolam/runtime-harness golden:check

# 3) Replay: ToolCallParser → HarnessFrame[]; unified diff on drift
pnpm --filter @moolam/runtime-harness golden:replay

# 4) Chunk-boundary fuzz (exhaustive + seeded random splits)
pnpm --filter @moolam/runtime-harness golden:fuzz
# Repo-root aliases also exist:
pnpm golden:fuzz
pnpm golden:fuzz:prove

# 5) Malformed-fence regression goldens (separate corpus)
pnpm --filter @moolam/runtime-harness golden:malformed
```

CI jobs (see `.github/workflows/ci.yml`):

- `golden-turns` — A P6 stub ↔ fixtures (upstream package)
- `parser-chunk-fuzz` — B4 chunk-boundary fuzz + prove red→green
- Package `test` — includes replay + malformed-fence suites

## Workflow A — Upstream A P6 fixture changed

**When:** someone lands a new/edited golden in `packages/sync-protocol/fixtures/golden-turns/`.

1. **Confirm upstream green** (optional but recommended):

   ```bash
   pnpm golden:turns
   ```

2. **Sync import into B4** (copies bytes; never commits):

   ```bash
   pnpm --filter @moolam/runtime-harness golden:sync
   ```

   Example report lines:

   ```text
   OK thought-answer-basic.json
   MISSING_LOCAL new-turn.json
     → copied
   DRIFT tool-call-fence.json (local differs from A P6)
     → overwritten from A P6 (review before commit)
   sync: drift=2 copied_or_ok=N (never auto-commits)
   ```

3. **Review the diff yourself** (worked example):

   ```bash
   git diff -- packages/runtime-harness/fixtures/golden-turns/
   ```

   Check:

   - Only intended turns changed.
   - `expectedFrames` came from A P6 — you did not hand-edit them in B4.
   - `subjectId` / `correlationId` / `deviceId` still look coherent.
   - No learner PII was added to fixture text you will paste into chat/issues.

4. **Replay + fuzz + malformed** (B4 must stay green):

   ```bash
   pnpm --filter @moolam/runtime-harness golden:check
   pnpm --filter @moolam/runtime-harness golden:replay
   pnpm --filter @moolam/runtime-harness golden:fuzz
   pnpm --filter @moolam/runtime-harness golden:malformed
   ```

5. **If replay prints `GOLDEN_TURN_DRIFT`:** unify the gap carefully.

   - Drift header looks like:

     ```text
     --- golden/<turnId>.expected.json
     +++ golden/<turnId>.actual.json
     @@ ...
     ```

   - Prefer fixing **parser / frame assembly** when B4 is wrong.
   - Prefer fixing **A P6 expectedFrames upstream** when the golden contract intentionally changed — then re-sync; do not patch `expectedFrames` only in B4.
   - Multi-chunk vs joined mismatch → parser purity bug; do not “fix” by weakening the test.

6. **Land with a normal PR.** Commit message should say why the A P6 contract changed. Never rely on sync to commit for you.

## Workflow B — New A P6 golden (B4 not yet updated)

**Symptom:** `golden:check` fails with `MISSING_LOCAL <file>.json`, or CI turns red after an A P6 PR merged without a B4 follow-up.

**Remedy:** run Workflow A (sync → review → replay/fuzz). Until sync lands, B4 is intentionally red — that is the gate working.

## Workflow C — Malformed-fence regression (B4-only)

These are **not** A P6 harness-frame turns. They live under `fixtures/golden-turns/malformed-fence/` and lock violation routing (`unclosed_fence`, `nested_fence`, `undeclared_markup`) — never answer with fence prose.

1. Edit/add a case JSON + `manifest.json` entry.
2. Capture `expectedEvents` via `summarizeParseEvents(parseChunks(...))` and `canonicalizeEventsJson` (sorted keys).
3. Run:

   ```bash
   pnpm --filter @moolam/runtime-harness golden:malformed
   ```

4. On `MALFORMED_FENCE_DRIFT`, the suite prints a unified diff under `malformed/<id>.*.json`. Fix parser or expected events after review — still no auto-commit.

## Failure classes operators will see

| Signal | Meaning | Next step |
|--------|---------|-----------|
| `DRIFT` / `MISSING_LOCAL` from `golden:check` | Import ≠ A P6 | `golden:sync`, review `git diff` |
| `EXTRA_LOCAL` | Top-level JSON not in A P6 | Move B4-only fixtures into `malformed-fence/` (or remove) |
| `GOLDEN_TURN_DRIFT:<turnId>` | Replay canonical ≠ `expectedFrames` | Read unified diff; fix parser or upstream golden |
| `CHUNK_BOUNDARY_FUZZ_DRIFT:<turnId>` | Split stream ≠ single-chunk events | Parser purity bug — do not skip the gate |
| `MALFORMED_FENCE_DRIFT:<id>` | Violation golden drifted | Diff under `malformed/`; keep “never answer” substrings |
| Prove gates (`golden:fuzz:prove`, `golden:turns:prove`) | Intentional seed → red with diff → restore green | Must stay wired in CI |

Structured events use names such as `runtime.harness.golden_replay`, `runtime.harness.chunk_boundary_fuzz`, `runtime.harness.malformed_fence_golden` with `subjectId`, `deviceId`, `outcome` — not raw transcript text.

## Sovereignty reminders

- Goldens use synthetic subject ids (e.g. `anika-k`). Prefer the same in new cases.
- Do not attach full learner transcripts to GitHub issues when a turn id + failure class + unified **frame/event** diff is enough.
- Cross-subject access in loaders/parsers is a defect; empty `subjectId` must reject.

## Quick checklist before merge

- [ ] A P6 source changed first (if `expectedFrames` moved)
- [ ] `golden:sync` then human `git diff` review
- [ ] `golden:check` / `golden:replay` / `golden:fuzz` green
- [ ] Malformed-fence suite green if those fixtures changed
- [ ] No script auto-commit; no hand-edit of imported A P6 JSON
