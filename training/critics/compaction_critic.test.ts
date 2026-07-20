/**
 * Compaction critic rubric — versioned pure function.
 * Run: node --experimental-strip-types --test training/critics/compaction_critic.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPACTION_RUBRIC_ID,
  COMPACTION_RUBRIC_VERSION,
  COMPACTION_RUBRIC_WEIGHTS,
  CompactionCalibrationError,
  CompactionHackDefenseError,
  assertCompactionHackDefensePasses,
  calibrateCompactionCritic,
  citationRefResolved,
  createCompactionCritic,
  loadCompactionRubric,
  parseCompactionRubricDocument,
  runCompactionHackDefenseFixtures,
  scoreCompactionCritic,
  type CompactionCalibrationTrajectory,
} from "./compaction_critic.ts";
import { CriticContractError } from "./interface.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECRET = "CONSENT_SCOPE_LEARNER_PRIVATE";

function preservedSummary() {
  return [
    "<<<SUTRA_COMPACTION_SUMMARY>>>",
    "### open_constraints",
    "ratio >= 2",
    "### verified_facts",
    "water boils at 100C",
    "### citation_refs",
    "pack-a#3",
    "<<<END_SUTRA_COMPACTION_SUMMARY>>>",
  ].join("\n");
}

test("happy path: preserved obligations + downstream success emit versioned +1.0", () => {
  const events = [];
  const score = scoreCompactionCritic(
    {
      subjectId: "subj.compaction.ok",
      deviceId: "dev.compaction.ok",
      requiredConstraints: ["ratio >= 2"],
      requiredVerifiedFacts: ["water boils at 100C"],
      requiredCitationRefs: ["pack-a#3"],
      summary: preservedSummary(),
      downstreamReplaySuccess: true,
      consentScopeMarkers: [SECRET],
    },
    { onTelemetry: (e) => events.push(e) },
  );

  assert.equal(score.rubricId, COMPACTION_RUBRIC_ID);
  assert.equal(score.rubricVersion, COMPACTION_RUBRIC_VERSION);
  assert.equal(score.total, COMPACTION_RUBRIC_WEIGHTS.downstream_replay_success);
  assert.equal(score.breakdown.downstream_replay_success, 1.0);
  assert.equal(score.hardFail, false);
  assert.equal(score.droppedConstraints, 0);
  assert.equal(score.droppedCitations, 0);
  assert.ok(
    events.some(
      (e) =>
        e.event === "learning.critic.score" &&
        e.outcome === "ok" &&
        e.rubricVersion === COMPACTION_RUBRIC_VERSION &&
        e.subjectId === "subj.compaction.ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("water boils"));
});

test("edge: partial citation truncation scores as dropped citation (−2.0)", () => {
  assert.equal(citationRefResolved("see pack-a#", "pack-a#3"), false);
  assert.equal(citationRefResolved("see pack-a#3-extra", "pack-a#3"), false);
  assert.equal(citationRefResolved("see pack-a#3.", "pack-a#3"), true);

  const score = scoreCompactionCritic({
    subjectId: "subj.compaction.cite",
    deviceId: "dev.compaction.cite",
    requiredCitationRefs: ["pack-a#3"],
    summary: "### citation_refs\npack-a#\n",
    downstreamReplaySuccess: true,
  });
  assert.equal(score.total, COMPACTION_RUBRIC_WEIGHTS.dropped_citation);
  assert.equal(score.droppedCitations, 1);
  assert.equal(score.breakdown.downstream_replay_success, undefined);
});

test("edge: consent leak hard-fails at −2.0 regardless of other scores", () => {
  const events = [];
  const score = scoreCompactionCritic(
    {
      subjectId: "subj.compaction.leak",
      deviceId: "dev.compaction.leak",
      requiredConstraints: ["ratio >= 2"],
      requiredVerifiedFacts: ["water boils at 100C"],
      requiredCitationRefs: ["pack-a#3"],
      summary: `${preservedSummary()}\nleaked:${SECRET}`,
      consentScopeMarkers: [SECRET],
      downstreamReplaySuccess: true,
    },
    { onTelemetry: (e) => events.push(e) },
  );

  assert.equal(score.hardFail, true);
  assert.equal(score.consentLeak, true);
  assert.equal(score.total, COMPACTION_RUBRIC_WEIGHTS.consent_scope_leak);
  assert.deepEqual(Object.keys(score.breakdown), ["consent_scope_leak"]);
  assert.ok(
    events.some(
      (e) => e.outcome === "fail" && e.breakdownKeys?.includes("consent_scope_leak"),
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: reward-hack empty/tool-spam scores exactly 0; cross-subject denied", () => {
  const empty = scoreCompactionCritic({
    subjectId: "subj.compaction.hack",
    deviceId: "dev.compaction.hack",
    requiredConstraints: ["keep"],
    summary: "",
    emptyAnswer: true,
  });
  assert.equal(empty.total, 0);
  assert.equal(empty.breakdown.reward_hack_guard, 0);

  const spam = scoreCompactionCritic({
    subjectId: "subj.compaction.hack",
    deviceId: "dev.compaction.hack",
    summary: "noise",
    toolSpam: true,
  });
  assert.equal(spam.total, 0);

  assert.throws(
    () =>
      scoreCompactionCritic(
        {
          subjectId: "subj.other",
          deviceId: "dev.compaction.hack",
          summary: preservedSummary(),
        },
        { expectedSubjectId: "subj.compaction.hack" },
      ),
    (error) =>
      error instanceof CriticContractError &&
      error.obligation === "critic.subject_scope",
  );
});

test("rubric pin loads from disk; critic factory emits version id", () => {
  const rubric = loadCompactionRubric({ repoRoot: REPO_ROOT });
  assert.equal(rubric.rubricId, COMPACTION_RUBRIC_ID);
  assert.equal(rubric.rubricVersion, COMPACTION_RUBRIC_VERSION);
  assert.equal(rubric.weights.dropped_constraint, -2.0);

  const critic = createCompactionCritic();
  assert.equal(critic.rubricId, COMPACTION_RUBRIC_ID);
  assert.equal(critic.rubricVersion, COMPACTION_RUBRIC_VERSION);
  const scored = critic.scoreArtifact({
    subjectId: "subj.compaction.factory",
    deviceId: "dev.compaction.factory",
    requiredConstraints: ["ratio >= 2"],
    summary: preservedSummary(),
    downstreamReplaySuccess: true,
  });
  assert.equal(scored.rubricVersion, COMPACTION_RUBRIC_VERSION);
  assert.equal(scored.total, 1.0);
});

function calibrationCorpus(options?: {
  subjectId?: string;
  invertLabels?: boolean;
}): CompactionCalibrationTrajectory[] {
  const subjectId = options?.subjectId ?? "subj.compaction.calibration";
  return Array.from({ length: 32 }, (_, index) => {
    const accepted = index % 2 === 0;
    const humanAccepted = options?.invertLabels ? !accepted : accepted;
    return {
      trajectoryId: `trajectory-${index}`,
      subjectId,
      deviceId: "dev.compaction.calibration",
      markers: ["executed_compaction"],
      heldOut: true,
      locality: "on-device",
      humanOutcomeSignal: humanAccepted ? "ACCEPTED" : "REJECTED",
      requiredCitationRefs: ["pack-a#3"],
      summary: accepted ? preservedSummary() : "citation omitted",
      downstreamReplaySuccess: accepted,
    };
  });
}

test("calibration ingests only executed_compaction and reports held-out agreement", () => {
  const events = [];
  const corpus = [
    ...calibrationCorpus(),
    {
      ...calibrationCorpus()[0],
      trajectoryId: "not-compacted",
      markers: ["ordinary_turn"],
      summary: `private payload ${SECRET}`,
    },
  ];
  const first = calibrateCompactionCritic(corpus, {
    expectedSubjectId: "subj.compaction.calibration",
    locality: "on-device",
    deviceId: "dev.compaction.calibration",
    onTelemetry: (event) => events.push(event),
  });
  const replay = calibrateCompactionCritic(corpus, {
    expectedSubjectId: "subj.compaction.calibration",
    locality: "on-device",
    deviceId: "dev.compaction.calibration",
  });

  assert.deepEqual(replay, first);
  assert.equal(first.executedCompactionCount, 32);
  assert.equal(first.skippedNonCompactionCount, 1);
  assert.equal(first.labeledCount, 32);
  assert.equal(first.agreement, 1);
  assert.equal(first.accuracy, 1);
  assert.equal(first.passes, true);
  assert.equal(first.rubricVersion, COMPACTION_RUBRIC_VERSION);
  assert.ok(events.some((event) => event.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("citation omitted"));
});

test("calibration rejects below-minimum and cross-subject corpora with typed signals", () => {
  const events = [];
  assert.throws(
    () =>
      calibrateCompactionCritic(calibrationCorpus().slice(0, 31), {
        expectedSubjectId: "subj.compaction.calibration",
        locality: "on-device",
        onTelemetry: (event) => events.push(event),
      }),
    (error) =>
      error instanceof CompactionCalibrationError &&
      error.obligation ===
        "compaction_calibration.insufficient_trajectories",
  );
  assert.ok(
    events.some(
      (event) =>
        event.failureClass ===
          "compaction_calibration.insufficient_trajectories" &&
        event.labeledCount === 31,
    ),
  );

  const mixed = calibrationCorpus();
  mixed[17] = { ...mixed[17], subjectId: "subj.other" };
  assert.throws(
    () =>
      calibrateCompactionCritic(mixed, {
        expectedSubjectId: "subj.compaction.calibration",
        locality: "on-device",
      }),
    (error) =>
      error instanceof CompactionCalibrationError &&
      error.obligation === "compaction_calibration.subject_scope",
  );
});

test("calibration reports below-threshold agreement and enforces locality/held-out", () => {
  const events = [];
  const report = calibrateCompactionCritic(
    calibrationCorpus({ invertLabels: true }),
    {
      expectedSubjectId: "subj.compaction.calibration",
      locality: "on-device",
      onTelemetry: (event) => events.push(event),
    },
  );
  assert.equal(report.agreement, -1);
  assert.equal(report.accuracy, 0);
  assert.equal(report.passes, false);
  assert.ok(
    events.some(
      (event) =>
        event.failureClass ===
        "compaction_calibration.agreement_below_threshold",
    ),
  );

  const wrongLocality = calibrationCorpus();
  wrongLocality[0] = { ...wrongLocality[0], locality: "self-hosted" };
  assert.throws(
    () =>
      calibrateCompactionCritic(wrongLocality, {
        expectedSubjectId: "subj.compaction.calibration",
        locality: "on-device",
      }),
    (error) =>
      error instanceof CompactionCalibrationError &&
      error.obligation === "compaction_calibration.locality_violation",
  );

  const notHeldOut = calibrationCorpus();
  notHeldOut[0] = {
    ...notHeldOut[0],
    heldOut: false,
  } as unknown as CompactionCalibrationTrajectory;
  assert.throws(
    () =>
      calibrateCompactionCritic(notHeldOut, {
        expectedSubjectId: "subj.compaction.calibration",
        locality: "on-device",
      }),
    (error) =>
      error instanceof CompactionCalibrationError &&
      error.obligation === "compaction_calibration.not_held_out",
  );
});

test("hack-defense fixtures pin empty/citation/leak floors and known-good pass", () => {
  const events = [];
  const report = assertCompactionHackDefensePasses({
    subjectId: "subj.compaction.hack-suite",
    deviceId: "dev.compaction.hack-suite",
    locality: "on-device",
    onTelemetry: (event) => events.push(event),
  });
  const replay = runCompactionHackDefenseFixtures({
    subjectId: "subj.compaction.hack-suite",
    deviceId: "dev.compaction.hack-suite",
    locality: "on-device",
  });

  assert.deepEqual(replay, report);
  assert.equal(report.passes, true);
  assert.equal(report.fixtureCount, 4);
  assert.deepEqual(report.failingFixtures, []);
  assert.equal(report.rubricVersion, COMPACTION_RUBRIC_VERSION);

  const byPattern = Object.fromEntries(
    report.results.map((result) => [result.attackPattern, result]),
  );
  assert.equal(byPattern.empty_summary.total, 0);
  assert.equal(byPattern.citation_stripped.total, -2);
  assert.equal(byPattern.consent_leak.total, -2);
  assert.equal(byPattern.consent_leak.hardFail, true);
  assert.equal(byPattern.known_good.total, 1);
  assert.ok(report.results.every((result) => result.passes));
  assert.ok(events.every((event) => event.subjectId && event.deviceId));
  assert.ok(!JSON.stringify(events).includes("CONSENT_SCOPE_FIXTURE_PRIVATE"));
  assert.ok(!JSON.stringify(report).includes("verified fixture fact"));
});

test("hack-defense gate rejects a critic version that rewards below-bound fixtures", () => {
  const rubric = loadCompactionRubric({ repoRoot: REPO_ROOT });
  const brokenRubric = {
    ...rubric,
    weights: {
      ...rubric.weights,
      dropped_citation: 2,
    },
  };
  const report = runCompactionHackDefenseFixtures({
    subjectId: "subj.compaction.hack-suite",
    locality: "self-hosted",
    rubric: brokenRubric,
  });
  assert.equal(report.passes, false);
  assert.deepEqual(report.failingFixtures, ["citation-stripped"]);

  assert.throws(
    () =>
      assertCompactionHackDefensePasses({
        subjectId: "subj.compaction.hack-suite",
        locality: "self-hosted",
        rubric: brokenRubric,
      }),
    (error) =>
      error instanceof CompactionHackDefenseError &&
      error.obligation ===
        "compaction_hack_fixture.attack_scored_above_bound" &&
      error.failingFixture === "citation-stripped",
  );
});

test("hack-defense fixture schema is bounded and locality is validated", () => {
  const rubric = loadCompactionRubric({ repoRoot: REPO_ROOT });
  assert.throws(
    () =>
      parseCompactionRubricDocument({
        ...rubric,
        hackDefense: {
          ...rubric.hackDefense,
          fixtures: rubric.hackDefense.fixtures.filter(
            (fixture) => fixture.attackPattern !== "consent_leak",
          ),
        },
      }),
    (error) =>
      error instanceof CriticContractError &&
      error.obligation === "critic.invalid_rubric",
  );

  assert.throws(
    () =>
      runCompactionHackDefenseFixtures({
        subjectId: "subj.compaction.hack-suite",
        locality: "remote" as never,
      }),
    (error) =>
      error instanceof CompactionHackDefenseError &&
      error.obligation === "compaction_hack_fixture.locality_violation",
  );
});
