/**
 * Process-reward correction-loop golden fixtures.
 * Seeded invalid→valid, farming ≤0, MAX_CORRECTION_TURNS cap breach.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CORRECTION_TURNS,
  PROCESS_MIN_SCORE,
  PROCESS_OUTCOME_OBLIGATION_PENALTY,
  PROCESS_REWARD_ABS_CAP,
  PROCESS_REWARD_GOLDEN_BRANCHES,
  PROCESS_REWARD_GOLDEN_FIXTURES_RELPATH,
  PROCESS_RUBRIC_ID,
  PROCESS_RUBRIC_VERSION,
  assertProcessDominatedByObligation,
  createProcessRewardCritic,
  scoreProcessReward,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, PROCESS_REWARD_GOLDEN_FIXTURES_RELPATH);
const MANIFEST = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
);

function loadJson(rel) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, rel), "utf8"));
}

function assertExactBreakdown(actual, expected, id) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  assert.deepEqual(
    actualKeys,
    expectedKeys,
    `${id}: breakdown keys must match exactly`,
  );
  for (const key of expectedKeys) {
    assert.equal(actual[key], expected[key], `${id}: breakdown[${key}]`);
  }
}

test("manifest covers every process-reward golden branch", () => {
  assert.equal(MANIFEST.rubricId, PROCESS_RUBRIC_ID);
  assert.equal(MANIFEST.rubricVersion, PROCESS_RUBRIC_VERSION);
  assert.equal(MANIFEST.maxCorrectionTurns, MAX_CORRECTION_TURNS);
  assert.equal(MANIFEST.processAbsCap, PROCESS_REWARD_ABS_CAP);
  const covered = new Set(MANIFEST.branches.map((b) => b.branch));
  for (const branch of PROCESS_REWARD_GOLDEN_BRANCHES) {
    assert.ok(covered.has(branch), `manifest missing branch ${branch}`);
  }
});

test("happy path: fixtures assert exact scores; first-pass meets label threshold", () => {
  const events = [];
  const critic = createProcessRewardCritic({
    onTelemetry: (e) => events.push(e),
  });

  let firstPassAgree = 0;
  let firstPassTotal = 0;

  for (const entry of MANIFEST.branches) {
    const trajectory = loadJson(entry.file);
    const blob = JSON.stringify(trajectory);
    assert.equal(
      /utterance|keystroke|rawContent|promptText/i.test(blob),
      false,
      entry.id,
    );
    assert.ok(trajectory.subjectId, entry.id);

    const shaped = scoreProcessReward(trajectory, {
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(shaped.total, entry.expectedTotal, entry.id);
    assertExactBreakdown(shaped.breakdown, entry.expectedBreakdown, entry.id);
    assert.ok(
      Math.abs(shaped.total) <= PROCESS_REWARD_ABS_CAP + 1e-12,
      entry.id,
    );
    assertProcessDominatedByObligation(shaped.total);

    if (entry.expectedMaxTotal !== undefined) {
      assert.ok(
        shaped.total <= entry.expectedMaxTotal,
        `${entry.id}: farming must score ≤ ${entry.expectedMaxTotal}`,
      );
    }

    if (entry.assertCappedAtMax) {
      assert.equal(shaped.features.cappedAtMax, true, entry.id);
      assert.equal(shaped.minScoreApplied, true, entry.id);
      assert.equal(shaped.total, PROCESS_MIN_SCORE, entry.id);
    }

    if (entry.assertNoFirstPass) {
      assert.equal(shaped.features.firstPassBonusEligible, false, entry.id);
      assert.equal(shaped.features.firstPassValidToolCall, false, entry.id);
    }

    if (entry.assertNetNegativeWithObligation) {
      const obligation =
        entry.obligationPenalty ?? PROCESS_OUTCOME_OBLIGATION_PENALTY;
      assert.ok(
        shaped.total + obligation < 0,
        `${entry.id}: process+obligation must stay net negative`,
      );
    }

    if (entry.netWithObligationMax !== undefined) {
      assert.ok(
        shaped.total + PROCESS_OUTCOME_OBLIGATION_PENALTY <=
          entry.netWithObligationMax + 1e-12,
        entry.id,
      );
    }

    const score = critic.score(trajectory);
    assert.equal(score.total, entry.expectedTotal, `${entry.id} critic`);

    if (entry.label === "FIRST_PASS") {
      firstPassTotal += 1;
      if (shaped.total >= 0.25) firstPassAgree += 1;
    }
  }

  assert.ok(firstPassTotal >= 1);
  assert.ok(
    firstPassAgree / firstPassTotal >= MANIFEST.agreementThreshold,
    "held-out first-pass labels must meet agreement threshold",
  );
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
  assert.equal(
    /utterance|keystrokeText|rawContent/i.test(JSON.stringify(events)),
    false,
  );
});

test("edge: invalid-then-valid is negative; farming ≤ 0; cap floor sticky", () => {
  const repaired = scoreProcessReward(loadJson("invalid-then-valid.json"));
  assert.ok(repaired.total < 0);
  assert.equal(repaired.features.effectiveDepth, 1);
  assert.equal(repaired.features.firstPassBonusEligible, false);

  const farming = scoreProcessReward(loadJson("retry-loop-farming.json"));
  assert.ok(farming.total <= 0);
  assert.equal(farming.total, -PROCESS_REWARD_ABS_CAP);

  const cap = scoreProcessReward(loadJson("cap-breach.json"));
  assert.equal(cap.total, PROCESS_MIN_SCORE);
  assert.equal(cap.features.effectiveDepth, MAX_CORRECTION_TURNS);

  const synth = scoreProcessReward(loadJson("synthetic-retry.json"));
  assert.equal(synth.total, PROCESS_MIN_SCORE);
  assert.equal(synth.features.syntheticRetryAfterExhaustion, true);
});

test("sovereignty: empty subjectId fails; fixtures stay subject-scoped", () => {
  const critic = createProcessRewardCritic();
  assert.throws(() =>
    critic.score({
      ...loadJson("first-pass-valid.json"),
      subjectId: "",
    }),
  );
  const subjects = new Set(
    MANIFEST.branches.map((b) => loadJson(b.file).subjectId),
  );
  assert.equal(subjects.size, MANIFEST.branches.length);
});
