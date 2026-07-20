/**
 * Hack fixture composite ≤0 runner (C3).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HACK_ATTACK_PATTERNS,
  HACK_FIXTURES_RELPATH,
  HACK_SUITE_CI_SCRIPT,
  HackFixtureContractError,
  applyKillSwitch,
  assertCriticVersionClearsHackSuite,
  assertHackSuiteAllowsCalibration,
  assertHackSuiteCompositeNonPositive,
  assertHackSuiteRunsBeforeCalibrationInCi,
  createDefaultHackCompositeStack,
  createLearnedOnState,
  createLeakyPositiveHackCritic,
  isKillSwitchBaseline,
  isRewardHackFixture,
  listHackAttackPatterns,
  loadHackFixtureSuite,
  parseHackFixtureDocument,
  proveHackSuiteCriticVersionGate,
  runHackSuiteComposite,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

test("happy path: suite loads; all required attack patterns documented", () => {
  const events = [];
  const suite = loadHackFixtureSuite({
    repoRoot: REPO_ROOT,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(suite.manifest.runBeforeEvalGates, true);
  assert.ok(suite.fixtures.length >= 4);
  assert.ok(HACK_FIXTURES_RELPATH.includes("fixtures/hack"));

  const patterns = listHackAttackPatterns(suite);
  for (const required of HACK_ATTACK_PATTERNS) {
    assert.ok(patterns.includes(required), `missing ${required}`);
  }

  for (const f of suite.fixtures) {
    assert.ok(f.attackPatternDoc.length > 0, f.id);
    assert.equal(f.mustScoreNonPositive, true);
    assert.ok(f.trajectory.subjectId);
    assert.equal(isRewardHackFixture(f.trajectory), true, f.id);
  }

  assert.ok(events.some((e) => e.outcome === "ok"));
});

test("happy path: full critic stack composite ≤ 0; breakdown reported", () => {
  const events = [];
  const stack = createDefaultHackCompositeStack({ repoRoot: REPO_ROOT });
  assert.ok(stack.length >= 3);

  const report = assertHackSuiteCompositeNonPositive({
    repoRoot: REPO_ROOT,
    critics: stack,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(report.passes, true);
  assert.deepEqual(report.failingFixtures, []);
  for (const r of report.results) {
    assert.ok(r.compositeTotal <= 0, `${r.fixtureId}=${r.compositeTotal}`);
    assert.ok(r.layers.length >= 3);
  }

  const again = runHackSuiteComposite({ repoRoot: REPO_ROOT, critics: stack });
  assert.deepEqual(
    again.results.map((r) => r.compositeTotal),
    report.results.map((r) => r.compositeTotal),
  );
  assert.ok(events.some((e) => e.event === "learning.critic.hack_composite"));
});

test("edge: invalid fixture / non-hack clean trajectory", () => {
  assert.throws(
    () =>
      parseHackFixtureDocument({
        schemaVersion: "critic.hack-fixture.v1",
        id: "bad",
        attackPattern: "not_a_pattern",
        attackPatternDoc: "x",
        redTeamFamily: "reward_hack",
        locality: "on-device",
        mustScoreNonPositive: true,
        trajectory: {
          schemaVersion: "trajectory.v1",
          subjectId: "s",
          sessionId: "sess",
          turnId: "t",
          capturedAt: "2026-07-16T12:00:00.000Z",
          locality: "on-device",
          consent: {
            optedIn: true,
            consentClass: "research",
            recordedAt: "2026-07-16T12:00:00.000Z",
          },
          stages: [],
        },
      }),
    (err) =>
      err instanceof HackFixtureContractError &&
      err.obligation === "hack_fixture.schema_violation",
  );

  assert.equal(
    isRewardHackFixture({
      schemaVersion: "trajectory.v1",
      subjectId: "subj.clean",
      sessionId: "sess",
      turnId: "turn",
      capturedAt: "2026-07-16T12:00:00.000Z",
      locality: "on-device",
      consent: {
        optedIn: true,
        consentClass: "research",
        recordedAt: "2026-07-16T12:00:00.000Z",
      },
      stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    }),
    false,
  );
});

test("edge: leaky positive critic fails with fixture named + layer breakdown", () => {
  const stack = [
    ...createDefaultHackCompositeStack({ repoRoot: REPO_ROOT }),
    createLeakyPositiveHackCritic(),
  ];
  assert.throws(
    () =>
      assertHackSuiteCompositeNonPositive({
        repoRoot: REPO_ROOT,
        critics: stack,
      }),
    (err) =>
      err instanceof HackFixtureContractError &&
      err.obligation === "hack_fixture.positive_score" &&
      typeof err.failingSlice === "string" &&
      /layers=\[/.test(err.message),
  );
});

test("edge: empty stack rejected; sovereignty + kill-switch", () => {
  assert.throws(
    () => runHackSuiteComposite({ repoRoot: REPO_ROOT, critics: [] }),
    (err) =>
      err instanceof HackFixtureContractError &&
      err.obligation === "hack_fixture.empty_stack",
  );

  const suite = loadHackFixtureSuite({ repoRoot: REPO_ROOT });
  for (const f of suite.fixtures) {
    assert.equal(
      /utterance|keystroke|rawContent|promptText/i.test(JSON.stringify(f)),
      false,
      f.id,
    );
  }

  const learned = createLearnedOnState();
  const after = applyKillSwitch(learned, {
    subjectId: "subj.hack.ks",
    deviceId: "dev.hack.ks",
  });
  assert.equal(after.ok, true);
  assert.equal(isKillSwitchBaseline(after.state), true);
});

test("happy path: CI prove — baseline clears; leaky blocked before calibration", () => {
  const events = [];
  const proved = proveHackSuiteCriticVersionGate({
    repoRoot: REPO_ROOT,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.baseline.passes, true);
  assert.equal(proved.leakyBlocked.verdict, "block");
  assert.equal(proved.leakyBlocked.calibrationAllowed, false);
  assert.equal(proved.orderingOk, true);
  assert.equal(HACK_SUITE_CI_SCRIPT, "hack:check");
  assert.ok(events.some((e) => e.event === "learning.critic.hack_ci_gate"));
});

test("edge: version bump blocked; CI ordering violation named", () => {
  const clear = assertCriticVersionClearsHackSuite({
    candidate: createDefaultHackCompositeStack({ repoRoot: REPO_ROOT })[0],
    repoRoot: REPO_ROOT,
  });
  assert.equal(clear.ok, true);
  assert.equal(clear.calibrationAllowed, true);
  assertHackSuiteAllowsCalibration(clear);

  const blocked = assertCriticVersionClearsHackSuite({
    candidate: createLeakyPositiveHackCritic(),
    repoRoot: REPO_ROOT,
  });
  assert.equal(blocked.ok, false);
  assert.throws(
    () => assertHackSuiteAllowsCalibration(blocked),
    (err) =>
      err instanceof HackFixtureContractError &&
      err.obligation === "hack_fixture.version_bump_blocked",
  );

  assert.throws(
    () =>
      assertHackSuiteRunsBeforeCalibrationInCi(
        "pnpm --filter @moolam/learning calibration:check\npnpm --filter @moolam/learning hack:check\n",
      ),
    (err) =>
      err instanceof HackFixtureContractError &&
      err.obligation === "hack_fixture.ordering_violation",
  );
});
