/**
 * Core rubric golden trajectory suite — exact scores per branch;
 * negative fixtures isolate one violation condition.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_RUBRIC_GOLDEN_BRANCHES,
  CORE_RUBRIC_GOLDEN_FIXTURES_RELPATH,
  CORE_RUBRIC_ID,
  CORE_RUBRIC_VERSION,
  CriticContractError,
  assertCriticScore,
  createCoreRubricCritic,
  scoreCoreRubric,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, CORE_RUBRIC_GOLDEN_FIXTURES_RELPATH);
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

test("manifest covers every golden branch and pins rubric identity", () => {
  assert.equal(MANIFEST.rubricId, CORE_RUBRIC_ID);
  assert.equal(MANIFEST.rubricVersion, CORE_RUBRIC_VERSION);
  assert.ok(MANIFEST.agreementThreshold >= 0.85);
  const covered = new Set(MANIFEST.branches.map((b) => b.branch));
  for (const branch of CORE_RUBRIC_GOLDEN_BRANCHES) {
    assert.ok(covered.has(branch), `manifest missing branch ${branch}`);
  }
  const isolatedNegatives = MANIFEST.branches.filter(
    (b) =>
      b.isolation === true &&
      b.branch !== "reward_hack" &&
      b.branch !== "clean_success_disqualified" &&
      b.branch !== "human_discarded",
  );
  assert.ok(
    isolatedNegatives.length >= 4,
    "need ≥4 isolated negative branches (format/invariant/schema/rejected)",
  );
});

test("happy path: golden fixtures assert exact scores per branch", () => {
  const events = [];
  const critic = createCoreRubricCritic({
    onTelemetry: (e) => events.push(e),
  });

  let acceptedAgree = 0;
  let acceptedTotal = 0;

  for (const entry of MANIFEST.branches) {
    const trajectory = loadJson(entry.file);
    // Sovereignty: fixtures never embed learner utterance / keystroke bodies
    const blob = JSON.stringify(trajectory);
    assert.equal(
      /utterance|keystroke|rawContent|promptText/i.test(blob),
      false,
      entry.id,
    );
    assert.ok(trajectory.subjectId, entry.id);

    const score = critic.score(trajectory);
    assertCriticScore(score, CORE_RUBRIC_VERSION);
    assert.equal(score.total, entry.expectedTotal, entry.id);
    assertExactBreakdown(score.breakdown, entry.expectedBreakdown, entry.id);

    // Determinism: replay same fixture
    const again = scoreCoreRubric(trajectory);
    assert.equal(again.total, score.total, `${entry.id} replay`);

    if (entry.label === "ACCEPTED") {
      acceptedTotal += 1;
      if (score.total >= 1.0) acceptedAgree += 1;
    }
    if (entry.label === "REJECTED" || entry.label === "DISCARDED") {
      assert.ok(
        score.total <= 0,
        `${entry.id}: ${entry.label} must be non-positive`,
      );
      assert.equal(
        score.breakdown.human_accepted,
        undefined,
        `${entry.id}: no ACCEPTED component`,
      );
      assert.equal(
        score.breakdown.clean_success,
        undefined,
        `${entry.id}: no clean_success`,
      );
    }
  }

  assert.ok(acceptedTotal >= 1);
  assert.ok(
    acceptedAgree / acceptedTotal >= MANIFEST.agreementThreshold,
    "held-out ACCEPTED labels must meet agreement threshold",
  );
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
  assert.equal(
    /utterance|keystrokeText|rawContent/i.test(JSON.stringify(events)),
    false,
  );
});

test("edge: isolated negatives fire exactly one penalty component", () => {
  for (const entry of MANIFEST.branches.filter((b) => b.isolation === true)) {
    const trajectory = loadJson(entry.file);
    const score = scoreCoreRubric(trajectory);
    const keys = Object.keys(score.breakdown);
    if (entry.branch === "reward_hack") {
      assert.deepEqual(keys, ["reward_hack_guard"], entry.id);
      assert.equal(score.total, 0, entry.id);
      continue;
    }
    if (entry.branch === "human_discarded") {
      assert.deepEqual(keys, ["human_discarded"], entry.id);
      continue;
    }
    if (entry.branch === "clean_success_disqualified") {
      assert.deepEqual(keys, ["human_accepted"], entry.id);
      assert.equal(score.breakdown.clean_success, undefined, entry.id);
      continue;
    }
    // Exactly one condition: one breakdown key matching the branch
    assert.equal(keys.length, 1, `${entry.id}: isolation requires one key`);
    assert.equal(keys[0], Object.keys(entry.expectedBreakdown)[0], entry.id);
  }
});

test("edge: additive stack fixture scores exact sum of components", () => {
  const entry = MANIFEST.branches.find((b) => b.id === "stack-format-rejected");
  assert.ok(entry);
  const score = scoreCoreRubric(loadJson(entry.file));
  assert.equal(score.total, -2);
  assert.equal(score.breakdown.format_breach, -1);
  assert.equal(score.breakdown.human_rejected, -1);
});

test("sovereignty: cross-subject empty subjectId fails typed; fixtures stay scoped", () => {
  const critic = createCoreRubricCritic();
  assert.throws(
    () =>
      critic.score({
        ...loadJson("accepted-clean.json"),
        subjectId: "",
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.subject_scope",
  );
  const subjects = new Set(
    MANIFEST.branches.map((b) => loadJson(b.file).subjectId),
  );
  assert.ok(subjects.size >= MANIFEST.branches.length - 1);
});
