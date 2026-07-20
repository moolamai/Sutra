/**
 * TrajectoryCritic contract + CriticRegistry (C3 critic-interface).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRAJECTORY_SCHEMA_VERSION,
  CriticContractError,
  CriticRegistry,
  assertCriticScore,
  assertDeterministicScores,
  createContractSmokeCritic,
  createCriticScore,
  isRewardHackFixture,
  sumBreakdown,
} from "../dist/index.js";

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "subj.critic.test",
    sessionId: "sess-1",
    turnId: "turn-1",
    deviceId: "dev-critic-01",
    capturedAt: "2026-07-16T12:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    ...overrides,
  };
}

test("happy path: contract smoke critic is deterministic and totals breakdown", () => {
  const events = [];
  const critic = createContractSmokeCritic({
    onTelemetry: (e) => events.push(e),
  });
  const record = draft();
  const a = critic.score(record);
  const b = critic.score(record);
  assertCriticScore(a, critic.rubricVersion);
  assertDeterministicScores(a, b);
  assert.equal(a.total, sumBreakdown(a.breakdown));
  assert.ok(a.total > 0);
  assert.ok(events.some((e) => e.outcome === "ok" && e.subjectId === record.subjectId));
});

test("edge: empty stages / tool spam reward-hack fixtures score zero", () => {
  const critic = createContractSmokeCritic();
  const empty = draft({ stages: [] });
  assert.equal(isRewardHackFixture(empty), true);
  assert.equal(critic.score(empty).total, 0);

  const spam = draft({
    toolCallIds: Array.from({ length: 10 }, (_, i) => `tool-${i}`),
    stages: [{ stage: "act", status: "error" }],
  });
  assert.equal(isRewardHackFixture(spam), true);
  assert.equal(critic.score(spam).total, 0);
});

test("edge: missing subjectId throws typed subject_scope error", () => {
  const critic = createContractSmokeCritic();
  const bad = draft({ subjectId: "" });
  assert.throws(
    () => critic.score(bad),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.subject_scope",
  );
});

test("edge: score total must equal breakdown sum", () => {
  assert.throws(
    () =>
      assertCriticScore({
        total: 99,
        breakdown: { a: 1 },
        rubricVersion: "1.0.0",
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.invalid_score",
  );
  const ok = createCriticScore({ a: 0.5, b: 0.25 }, "1.0.0");
  assert.equal(ok.total, 0.75);
});

test("registry: register / require / refuse silent replace", () => {
  const events = [];
  const registry = new CriticRegistry({
    onTelemetry: (e) => events.push(e),
  });
  const critic = createContractSmokeCritic({ rubricVersion: "1.0.0" });
  registry.register(critic, { oracleKind: "contract-smoke" });
  assert.equal(registry.require(critic.rubricId, critic.rubricVersion), critic);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.listHooks()[0].oracleKind, "contract-smoke");

  const other = createContractSmokeCritic({ rubricVersion: "1.0.0" });
  assert.throws(
    () => registry.register(other),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.invalid_rubric",
  );
  assert.throws(
    () => registry.require("missing", "9.9.9"),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.not_registered",
  );
  assert.ok(events.some((e) => e.event === "learning.critic.register"));
});

test("sovereignty: telemetry never carries utterance / keystroke bodies", () => {
  const events = [];
  const critic = createContractSmokeCritic({
    onTelemetry: (e) => events.push(e),
  });
  critic.score(draft());
  const blob = JSON.stringify(events);
  assert.equal(/utterance|keystrokeText|rawContent/i.test(blob), false);
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
});
