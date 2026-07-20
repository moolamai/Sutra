/**
 * Pre-turn budget gate on StreamingTurnHost.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_ADVISORY_EXCEEDED,
  BUDGET_ADVISORY_WARNING,
  BudgetManager,
  HARNESS_ERROR_BUDGET_EXCEEDED,
  HARNESS_ERROR_BUDGET_THROTTLE,
  StreamingTurnHost,
  runBudgetPreTurnGate,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const SCOPE = {
  subjectId: "anika-k",
  deviceId: "edge-aaaa",
  sessionId: "sess-1",
};

function hostWithBudget(mgr, overrides = {}) {
  const frames = [];
  const telemetry = [];
  const host = new StreamingTurnHost({
    subjectId: SCOPE.subjectId,
    correlationId: "corr-budget-gate",
    deviceId: SCOPE.deviceId,
    sessionId: SCOPE.sessionId,
    budgetManager: mgr,
    onFrame: (f) => frames.push(f),
    onTelemetry: (e) => telemetry.push(e),
    ...overrides,
  });
  return { host, frames, telemetry };
}

test("happy path: gate allows turn and holds reservation until commit", async () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 100 });
  const { host, telemetry } = hostWithBudget(mgr);

  const gate = await host.gateBudgetBeforeModel(20);
  assert.equal(gate.ok, true);
  assert.equal(gate.proceed, true);
  assert.equal(gate.decision, "allow");
  assert.ok(gate.reservationId);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 80);

  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  const commit = host.commitBudgetReservation({
    freshInputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 3,
  });
  assert.equal(commit.ok, true);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 85);
  assert.equal(mgr.getSnapshot(SCOPE).snapshot.freshInputTokens, 10);
  assert.equal(mgr.getSnapshot(SCOPE).snapshot.cachedInputTokens, 2);

  assert.ok(
    telemetry.some(
      (e) => e.event === "runtime.harness.budget_gate" && e.proceed === true,
    ),
  );
  log({
    event: "runtime.harness.budget_gate",
    outcome: "ok",
    case: "allow_and_commit",
    subjectId: SCOPE.subjectId,
  });
});

test("edge: zero budget blocks before model with budget_exceeded", async () => {
  const exceeded = [];
  const mgr = new BudgetManager();
  mgr.onBudgetExceeded((a) => exceeded.push(a));
  mgr.setBudget(SCOPE, { limit: 0 });
  const { host, frames } = hostWithBudget(mgr);

  const gate = await host.gateBudgetBeforeModel(1);
  assert.equal(gate.ok, true);
  assert.equal(gate.proceed, false);
  assert.equal(gate.decision, "hardStop");
  assert.equal(gate.advisory.code, BUDGET_ADVISORY_EXCEEDED);
  assert.equal(gate.harnessError.code, HARNESS_ERROR_BUDGET_EXCEEDED);
  assert.equal(exceeded.length, 1);
  // No stream frames yet — typed advisory only, no silent truncation.
  assert.equal(frames.length, 0);
});

test("edge: throttle rejects new turn with typed advisory (not mid-stream cut)", async () => {
  const warnings = [];
  const mgr = new BudgetManager();
  mgr.onBudgetWarning((a) => warnings.push(a));
  mgr.setBudget(SCOPE, { limit: 100 });
  mgr.recordSpend(SCOPE, {
    freshInputTokens: 70,
    cachedInputTokens: 10,
    outputTokens: 0,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, BUDGET_ADVISORY_WARNING);

  const { host, frames } = hostWithBudget(mgr);
  const gate = await host.gateBudgetBeforeModel(5);
  assert.equal(gate.ok, true);
  assert.equal(gate.proceed, false);
  assert.equal(gate.decision, "throttle");
  assert.equal(gate.advisory.code, BUDGET_ADVISORY_WARNING);
  assert.equal(gate.harnessError.code, HARNESS_ERROR_BUDGET_THROTTLE);
  // Reservation released — remaining unchanged by the rejected turn.
  assert.equal(mgr.getRemaining(SCOPE).remaining, 20);
  assert.equal(frames.length, 0);
});

test("edge: exceeded after SESSION_START terminates with HARNESS_ERROR", async () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 5 });
  const { host, frames } = hostWithBudget(mgr);
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);

  // Exhaust budget on the shared manager from another "turn".
  mgr.recordSpend(SCOPE, {
    freshInputTokens: 5,
    cachedInputTokens: 0,
    outputTokens: 0,
  });

  const gate = await host.gateBudgetBeforeModel(1);
  assert.equal(gate.proceed, false);
  assert.equal(gate.streamTerminated, true);
  assert.ok(frames.some((f) => f.type === "HARNESS_ERROR"));
  const err = frames.find((f) => f.type === "HARNESS_ERROR");
  assert.equal(err.code, HARNESS_ERROR_BUDGET_EXCEEDED);
  assert.equal(host.isTerminated, true);
});

test("edge: budget raised mid-session allows the next gated turn", async () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 10 });
  mgr.recordSpend(SCOPE, {
    freshInputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
  const { host } = hostWithBudget(mgr);
  const blocked = await host.gateBudgetBeforeModel(1);
  assert.equal(blocked.proceed, false);

  mgr.setBudget(SCOPE, { limit: 40 });
  const allowed = await host.gateBudgetBeforeModel(5);
  assert.equal(allowed.proceed, true);
  assert.equal(allowed.decision, "allow");
  host.releaseBudgetReservation();
  assert.equal(mgr.getRemaining(SCOPE).remaining, 30);
});

test("edge: ungated host without BudgetManager always proceeds", async () => {
  const host = new StreamingTurnHost({
    subjectId: SCOPE.subjectId,
    correlationId: "corr-ungated",
  });
  const gate = await host.gateBudgetBeforeModel(999);
  assert.equal(gate.proceed, true);
  assert.equal(gate.ungated, true);
});

test("sovereignty: pre-turn gate scope is host subjectId only", async () => {
  const mgr = new BudgetManager();
  // Host session scope must match — subject ledgers never cross.
  mgr.setBudget(SCOPE, { limit: 10 });
  mgr.setBudget({ subjectId: "other-subject" }, { limit: 0 });
  const { host } = hostWithBudget(mgr);
  const gate = await host.gateBudgetBeforeModel(5);
  assert.equal(gate.ok, true);
  assert.equal(gate.proceed, true);
  // Exhausting "other-subject" must not affect this host.
  assert.equal(mgr.getRemaining({ subjectId: "other-subject" }).remaining, 0);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 5);

  const cross = await runBudgetPreTurnGate(mgr, { subjectId: "" }, 1);
  assert.equal(cross.ok, false);
  assert.equal(cross.failureClass, "missing_subject");
});
