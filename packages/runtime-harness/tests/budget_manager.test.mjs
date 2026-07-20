/**
 * BudgetManager host API — setBudget / getRemaining / warning / exceeded.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_ADVISORY_EXCEEDED,
  BUDGET_ADVISORY_WARNING,
  BUDGET_SUBJECT_LIMIT,
  BUDGET_WARNING_THRESHOLD_DEFAULT,
  BudgetManager,
  isBudgetDecision,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const SCOPE = {
  subjectId: "anika-k",
  deviceId: "edge-aaaa",
  sessionId: "sess-1",
};

test("happy path: setBudget, getRemaining, warning at 80%, spend apply", () => {
  const warnings = [];
  const exceeded = [];
  const telemetry = [];
  const mgr = new BudgetManager({
    onTelemetry: (e) => telemetry.push(e),
  });
  mgr.onBudgetWarning((a) => warnings.push(a));
  mgr.onBudgetExceeded((a) => exceeded.push(a));

  assert.equal(BUDGET_WARNING_THRESHOLD_DEFAULT, 0.8);

  const set = mgr.setBudget(SCOPE, { limit: 100 });
  assert.equal(set.ok, true);
  assert.equal(set.snapshot.remaining, 100);
  assert.equal(set.snapshot.warningThreshold, 0.8);

  const rem = mgr.getRemaining(SCOPE);
  assert.equal(rem.ok, true);
  assert.equal(rem.remaining, 100);

  // Pre-turn gate allows under budget.
  const gate = mgr.checkTurn(SCOPE, 10);
  assert.equal(gate.ok, true);
  assert.equal(gate.decision, "allow");
  assert.equal(isBudgetDecision(gate.decision), true);

  // Spend to 80% → throttle + warning once.
  const spend = mgr.recordSpend(SCOPE, {
    freshInputTokens: 50,
    cachedInputTokens: 20,
    outputTokens: 10,
  });
  assert.equal(spend.ok, true);
  assert.equal(spend.decision, "throttle");
  assert.equal(spend.snapshot.freshInputTokens, 50);
  assert.equal(spend.snapshot.cachedInputTokens, 20);
  assert.equal(spend.snapshot.remaining, 20);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, BUDGET_ADVISORY_WARNING);
  assert.equal(exceeded.length, 0);

  // Second check while still over warning threshold does not re-fire warning.
  const again = mgr.checkTurn(SCOPE, 5);
  assert.equal(again.ok, true);
  assert.equal(again.decision, "throttle");
  assert.equal(warnings.length, 1);

  assert.ok(telemetry.some((t) => t.action === "set_budget" && t.outcome === "ok"));
  assert.ok(!JSON.stringify(telemetry).includes("utterance"));
  log({
    event: "runtime.harness.budget",
    outcome: "ok",
    case: "warning_threshold",
    subjectId: SCOPE.subjectId,
    deviceId: SCOPE.deviceId,
  });
});

test("edge: budget exactly zero blocks with budget_exceeded", () => {
  const exceeded = [];
  const mgr = new BudgetManager();
  mgr.onBudgetExceeded((a) => exceeded.push(a));

  assert.equal(mgr.setBudget(SCOPE, { limit: 0 }).ok, true);
  const gate = mgr.checkTurn(SCOPE, 0);
  assert.equal(gate.ok, true);
  assert.equal(gate.decision, "hardStop");
  assert.equal(gate.advisory.code, BUDGET_ADVISORY_EXCEEDED);
  assert.equal(exceeded.length, 1);

  // onBudgetExceeded fires once per breach unless reset.
  const gate2 = mgr.checkTurn(SCOPE, 1);
  assert.equal(gate2.decision, "hardStop");
  assert.equal(exceeded.length, 1);

  mgr.resetBreach(SCOPE);
  const gate3 = mgr.checkTurn(SCOPE, 0);
  assert.equal(gate3.decision, "hardStop");
  assert.equal(exceeded.length, 2);
});

test("edge: budget increased mid-session applies immediately and clears latch", () => {
  const exceeded = [];
  const mgr = new BudgetManager();
  mgr.onBudgetExceeded((a) => exceeded.push(a));

  mgr.setBudget(SCOPE, { limit: 10 });
  mgr.recordSpend(SCOPE, {
    freshInputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
  assert.equal(exceeded.length, 1);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 0);

  const raised = mgr.setBudget(SCOPE, { limit: 50 });
  assert.equal(raised.ok, true);
  assert.equal(raised.snapshot.remaining, 40);
  assert.equal(raised.snapshot.used, 10);

  const gate = mgr.checkTurn(SCOPE, 5);
  assert.equal(gate.decision, "allow");
  // New breach can fire again after remaining was restored.
  mgr.recordSpend(SCOPE, {
    freshInputTokens: 40,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
  assert.equal(exceeded.length, 2);
});

test("edge: concurrent reservations serialize per subjectId", async () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 30 });

  const [a, b, c] = await Promise.all([
    mgr.reserve(SCOPE, 20),
    mgr.reserve(SCOPE, 20),
    mgr.reserve(SCOPE, 20),
  ]);
  const ok = [a, b, c].filter((r) => r.ok);
  const blocked = [a, b, c].filter((r) => !r.ok);
  assert.equal(ok.length, 1);
  assert.equal(blocked.length, 2);
  assert.ok(blocked.every((r) => r.decision === "hardStop"));
  assert.ok(
    blocked.every((r) => r.advisory?.code === BUDGET_ADVISORY_EXCEEDED),
  );

  const rem = mgr.getRemaining(SCOPE);
  assert.equal(rem.remaining, 10);

  const commit = mgr.commitReservation(SCOPE, ok[0].reservationId, {
    freshInputTokens: 8,
    cachedInputTokens: 2,
    outputTokens: 1,
  });
  assert.equal(commit.ok, true);
  assert.equal(commit.snapshot.freshInputTokens, 8);
  assert.equal(commit.snapshot.cachedInputTokens, 2);
  assert.equal(commit.snapshot.used, 11);
  assert.equal(commit.snapshot.reserved, 0);
});

test("edge: idempotent recordSpend does not double-apply", () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 100 });
  const first = mgr.recordSpend(
    SCOPE,
    { freshInputTokens: 5, cachedInputTokens: 1, outputTokens: 2 },
    { idempotencyKey: "tick-1" },
  );
  const dup = mgr.recordSpend(
    SCOPE,
    { freshInputTokens: 5, cachedInputTokens: 1, outputTokens: 2 },
    { idempotencyKey: "tick-1" },
  );
  assert.equal(first.ok, true);
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 92);
});

test("edge: BudgetHook.onMeterTick accounts aborted partial spend", () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 50 });
  const decision = mgr.onMeterTick({
    subjectId: SCOPE.subjectId,
    deviceId: SCOPE.deviceId,
    sessionId: SCOPE.sessionId,
    inputTokens: 8,
    cachedInputTokens: 0,
    outputTokens: 1,
    latencyMs: 12,
    modelId: "slm-local",
    locality: "on-device",
    aborted: true,
  });
  assert.equal(decision, "allow");
  assert.equal(mgr.getRemaining(SCOPE).snapshot.used, 9);
});

test("sovereignty: ledgers are isolated per subjectId", () => {
  const mgr = new BudgetManager();
  mgr.setBudget({ subjectId: "anika-k" }, { limit: 10 });
  mgr.setBudget({ subjectId: "other-subject" }, { limit: 100 });
  mgr.recordSpend(
    { subjectId: "anika-k" },
    { freshInputTokens: 10, cachedInputTokens: 0, outputTokens: 0 },
  );
  assert.equal(mgr.getRemaining({ subjectId: "anika-k" }).remaining, 0);
  assert.equal(mgr.getRemaining({ subjectId: "other-subject" }).remaining, 100);

  const missing = mgr.getRemaining({ subjectId: "" });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
});

test("scalability: subject ledger is hard-capped", () => {
  const mgr = new BudgetManager({ maxSubjects: 4 });
  for (let i = 0; i < 4; i += 1) {
    assert.equal(
      mgr.setBudget({ subjectId: `s-${i}` }, { limit: 10 }).ok,
      true,
    );
  }
  const over = mgr.setBudget({ subjectId: "s-overflow" }, { limit: 10 });
  assert.equal(over.ok, false);
  assert.equal(over.failureClass, "subject_limit");
  assert.ok(BUDGET_SUBJECT_LIMIT >= 4);
});
