/**
 * Hack fixture suite — authoring + composite ≤0 gate (C3).
 * Degenerate trajectories scored under full critic stack (core + process + pack oracles).
 *
 * Run:
 *   pnpm --filter @moolam/training-critics test:hack-suite
 *   pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HACK_ATTACK_PATTERNS,
  HACK_FIXTURES_RELPATH,
  HackFixtureContractError,
  applyKillSwitch,
  assertHackSuiteCompositeNonPositive,
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
} from "@moolam/learning";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

test("happy path: suite loads; all required attack patterns documented", () => {
  const events: Array<Record<string, unknown>> = [];
  const suite = loadHackFixtureSuite({
    repoRoot: REPO_ROOT,
    onTelemetry: (e) => events.push(e as unknown as Record<string, unknown>),
  });

  assert.equal(suite.manifest.runBeforeEvalGates, true);
  assert.equal(suite.manifest.suiteId, "critic.hack-suite.v1");
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
    assert.equal(isRewardHackFixture(f.trajectory as never), true, f.id);
  }

  assert.ok(events.some((e) => e.outcome === "ok"));
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
});

test("happy path: full critic stack composite ≤ 0 on entire suite; breakdown reported", () => {
  const events: Array<Record<string, unknown>> = [];
  const stack = createDefaultHackCompositeStack({ repoRoot: REPO_ROOT });
  assert.ok(stack.length >= 3, "core + process + ≥1 pack oracle");

  const report = assertHackSuiteCompositeNonPositive({
    repoRoot: REPO_ROOT,
    critics: stack,
    onTelemetry: (e) => events.push(e as unknown as Record<string, unknown>),
  });

  assert.equal(report.passes, true);
  assert.deepEqual(report.failingFixtures, []);
  assert.ok(report.fixtureCount >= 4);
  assert.ok(report.layerCount >= 3);

  for (const r of report.results) {
    assert.ok(r.compositeTotal <= 0, `${r.fixtureId} total=${r.compositeTotal}`);
    assert.equal(r.passes, true);
    assert.ok(r.layers.length >= 3);
    for (const layer of r.layers) {
      assert.ok(typeof layer.rubricId === "string");
      assert.ok(Number.isFinite(layer.total));
      assert.ok(Object.keys(layer.breakdown).length >= 1);
    }
  }

  const again = runHackSuiteComposite({
    repoRoot: REPO_ROOT,
    critics: stack,
  });
  assert.equal(again.passes, report.passes);
  assert.deepEqual(
    again.results.map((r) => r.compositeTotal),
    report.results.map((r) => r.compositeTotal),
  );

  assert.ok(
    events.some(
      (e) =>
        e.event === "learning.critic.hack_composite" && e.outcome === "ok",
    ),
  );
  assert.equal(
    /utterance|keystroke|rawContent|promptText/i.test(JSON.stringify(report)),
    false,
  );
});

test("edge: pattern gap / invalid fixture rejected with obligation named", () => {
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
    (err: unknown) =>
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
    } as never),
    false,
  );
});

test("edge: leaky positive critic fails suite with fixture named + breakdown", () => {
  const stack = [
    ...createDefaultHackCompositeStack({ repoRoot: REPO_ROOT }),
    createLeakyPositiveHackCritic(),
  ];
  const report = runHackSuiteComposite({
    repoRoot: REPO_ROOT,
    critics: stack,
  });
  assert.equal(report.passes, false);
  assert.ok(report.failingFixtures.length >= 1);

  assert.throws(
    () =>
      assertHackSuiteCompositeNonPositive({
        repoRoot: REPO_ROOT,
        critics: stack,
      }),
    (err: unknown) =>
      err instanceof HackFixtureContractError &&
      err.obligation === "hack_fixture.positive_score" &&
      typeof err.failingSlice === "string" &&
      /layers=\[/.test(err.message),
  );
});

test("edge: empty composite stack rejected", () => {
  assert.throws(
    () =>
      runHackSuiteComposite({
        repoRoot: REPO_ROOT,
        critics: [],
      }),
    (err: unknown) =>
      err instanceof HackFixtureContractError &&
      err.obligation === "hack_fixture.empty_stack",
  );
});

test("edge: sovereignty — fixtures never embed utterance/keystroke bodies", () => {
  const suite = loadHackFixtureSuite({ repoRoot: REPO_ROOT });
  for (const f of suite.fixtures) {
    const blob = JSON.stringify(f);
    assert.equal(
      /utterance|keystroke|rawContent|promptText/i.test(blob),
      false,
      f.id,
    );
  }
});

test("sovereignty: kill-switch drill restores baseline beside hack suite load", () => {
  const suite = loadHackFixtureSuite({ repoRoot: REPO_ROOT });
  assert.ok(suite.fixtures.length >= 4);

  const learned = createLearnedOnState();
  assert.equal(isKillSwitchBaseline(learned), false);
  const after = applyKillSwitch(learned, {
    subjectId: "subj.hack.ks",
    deviceId: "dev.hack.ks",
  });
  assert.equal(after.ok, true);
  assert.equal(isKillSwitchBaseline(after.state), true);
});

test("CI gate: proveHackSuiteCriticVersionGate — before calibration; leaky blocked", () => {
  const proved = proveHackSuiteCriticVersionGate({ repoRoot: REPO_ROOT });
  assert.equal(proved.ok, true);
  assert.equal(proved.baseline.passes, true);
  assert.equal(proved.leakyBlocked.calibrationAllowed, false);
  assert.equal(proved.orderingOk, true);
});
