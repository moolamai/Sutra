/**
 * Budget exceeded integration: multi-turn exhaustion, throttle-before-overrun,
 * advisories + metering still recorded, ledger restart survival.
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
  TurnMeter,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const SCOPE = {
  subjectId: "anika-k",
  deviceId: "edge-aaaa",
  sessionId: "sess-budget-int",
};

function fakeBus() {
  const events = [];
  return {
    events,
    publish(e) {
      events.push(e);
    },
    subscribe() {
      return () => {};
    },
  };
}

/**
 * One gated turn: reserve → SESSION_START → meter → flushMeter → commit.
 * Returns gate + meter flush outcomes for assertions.
 */
async function runMeteredTurn(opts) {
  const {
    mgr,
    correlationId,
    estimatedTokens,
    spend,
    modelId = "slm-local",
    aborted = false,
  } = opts;
  const bus = fakeBus();
  const frames = [];
  const hostTelemetry = [];
  let clock = 1_000;
  const turnMeter = new TurnMeter({
    subjectId: SCOPE.subjectId,
    deviceId: SCOPE.deviceId,
    modelId,
    locality: "on-device",
    startedAtMs: clock,
    now: () => {
      clock += 25;
      return clock;
    },
  });
  const host = new StreamingTurnHost({
    subjectId: SCOPE.subjectId,
    correlationId,
    deviceId: SCOPE.deviceId,
    sessionId: SCOPE.sessionId,
    budgetManager: mgr,
    turnMeter,
    eventBus: bus,
    onFrame: (f) => frames.push(f),
    onTelemetry: (e) => hostTelemetry.push(e),
  });

  const gate = await host.gateBudgetBeforeModel(estimatedTokens);
  if (!gate.proceed) {
    return { gate, frames, bus, hostTelemetry, turnMeter, host };
  }

  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  turnMeter.record({
    freshInputTokens: spend.freshInputTokens,
    cachedInputTokens: spend.cachedInputTokens,
    outputTokens: spend.outputTokens,
    totalPromptTokens: spend.freshInputTokens + spend.cachedInputTokens,
  });
  if (aborted) {
    host.terminateWithError({
      code: "AGENT_MANUAL_ABORT",
      message: "abort",
      recoverable: false,
    });
    // terminate releases reservation; metering still flushed aborted.
    return { gate, frames, bus, hostTelemetry, turnMeter, host, aborted: true };
  }

  const flush = host.flushMeter();
  assert.equal(flush.ok, true);
  const commit = host.commitBudgetReservation({
    freshInputTokens: spend.freshInputTokens,
    cachedInputTokens: spend.cachedInputTokens,
    outputTokens: spend.outputTokens,
  });
  assert.equal(commit.ok, true);
  assert.equal(host.emitTurnComplete(`turn-${correlationId}`).ok, true);
  return { gate, flush, commit, frames, bus, hostTelemetry, turnMeter, host };
}

test("integration: exhaust budget — throttle before overrun, then exceeded; metering recorded", async () => {
  const warnings = [];
  const exceeded = [];
  const mgrTelemetry = [];
  const mgr = new BudgetManager({
    onTelemetry: (e) => mgrTelemetry.push(e),
  });
  mgr.onBudgetWarning((a) => warnings.push(a));
  mgr.onBudgetExceeded((a) => exceeded.push(a));
  mgr.setBudget(SCOPE, { limit: 100 });

  // Turn 1 — under warning threshold; metering + spine publish.
  const t1 = await runMeteredTurn({
    mgr,
    correlationId: "corr-budget-t1",
    estimatedTokens: 40,
    spend: { freshInputTokens: 20, cachedInputTokens: 5, outputTokens: 5 },
  });
  assert.equal(t1.gate.proceed, true);
  assert.equal(t1.flush.ok, true);
  assert.equal(t1.flush.framesEmitted, 1);
  assert.equal(t1.bus.events[0].type, "harness.meter");
  assert.equal(t1.bus.events[0].payload.inputTokens, 20);
  assert.equal(t1.bus.events[0].payload.cachedInputTokens, 5);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 70);
  assert.equal(warnings.length, 0);
  assert.equal(exceeded.length, 0);

  // Turn 2 — crosses 80% warning on spend; next gate will throttle.
  const t2 = await runMeteredTurn({
    mgr,
    correlationId: "corr-budget-t2",
    estimatedTokens: 40,
    spend: { freshInputTokens: 40, cachedInputTokens: 10, outputTokens: 0 },
  });
  assert.equal(t2.gate.proceed, true);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 20);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, BUDGET_ADVISORY_WARNING);
  assert.ok(
    mgrTelemetry.some(
      (e) =>
        e.action === "budget_warning" &&
        e.advisoryCode === BUDGET_ADVISORY_WARNING,
    ),
  );

  // Turn 3 — throttle rejects before overrun (typed advisory, no mid-stream cut).
  const t3 = await runMeteredTurn({
    mgr,
    correlationId: "corr-budget-t3",
    estimatedTokens: 10,
    spend: { freshInputTokens: 5, cachedInputTokens: 0, outputTokens: 0 },
  });
  assert.equal(t3.gate.proceed, false);
  assert.equal(t3.gate.decision, "throttle");
  assert.equal(t3.gate.advisory.code, BUDGET_ADVISORY_WARNING);
  assert.equal(t3.gate.harnessError.code, HARNESS_ERROR_BUDGET_THROTTLE);
  assert.equal(t3.frames.length, 0);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 20);

  // Mid-session raise clears latch path for further allow.
  mgr.setBudget(SCOPE, { limit: 120 });
  assert.equal(mgr.getRemaining(SCOPE).remaining, 40);

  // Turn 4 — allowed after raise; exhausts remaining → exceeded.
  const t4 = await runMeteredTurn({
    mgr,
    correlationId: "corr-budget-t4",
    estimatedTokens: 40,
    spend: { freshInputTokens: 30, cachedInputTokens: 5, outputTokens: 5 },
  });
  assert.equal(t4.gate.proceed, true);
  assert.equal(mgr.getRemaining(SCOPE).remaining, 0);
  assert.equal(exceeded.length, 1);
  assert.equal(exceeded[0].code, BUDGET_ADVISORY_EXCEEDED);
  assert.ok(
    mgrTelemetry.some(
      (e) =>
        e.action === "budget_exceeded" &&
        e.advisoryCode === BUDGET_ADVISORY_EXCEEDED,
    ),
  );

  // Turn 5 — hardStop; onBudgetExceeded does not re-fire.
  const t5 = await runMeteredTurn({
    mgr,
    correlationId: "corr-budget-t5",
    estimatedTokens: 1,
    spend: { freshInputTokens: 1, cachedInputTokens: 0, outputTokens: 0 },
  });
  assert.equal(t5.gate.proceed, false);
  assert.equal(t5.gate.decision, "hardStop");
  assert.equal(t5.gate.advisory.code, BUDGET_ADVISORY_EXCEEDED);
  assert.equal(t5.gate.harnessError.code, HARNESS_ERROR_BUDGET_EXCEEDED);
  assert.equal(exceeded.length, 1);

  // Channels stay distinguishable across the sequence.
  const snap = mgr.getSnapshot(SCOPE).snapshot;
  assert.equal(snap.freshInputTokens, 90);
  assert.equal(snap.cachedInputTokens, 20);
  assert.equal(snap.outputTokens, 10);

  const telBlob = JSON.stringify([...mgrTelemetry, ...t1.hostTelemetry]);
  assert.ok(!telBlob.includes("utterance"));
  assert.ok(!telBlob.includes("prompt"));

  log({
    event: "runtime.harness.budget",
    outcome: "ok",
    case: "exhaust_throttle_then_exceed",
    subjectId: SCOPE.subjectId,
    deviceId: SCOPE.deviceId,
    remaining: snap.remaining,
    used: snap.used,
  });
});

test("integration: aborted turn still records metering after budget allow", async () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 50, resetUsed: true });
  const t = await runMeteredTurn({
    mgr,
    correlationId: "corr-budget-abort",
    estimatedTokens: 20,
    spend: { freshInputTokens: 8, cachedInputTokens: 0, outputTokens: 1 },
    aborted: true,
  });
  assert.equal(t.gate.proceed, true);
  assert.equal(t.turnMeter.isAborted, true);
  assert.equal(t.turnMeter.isFlushed, true);
  const meterFrame = t.frames.find((f) => f.type === "METER_TICK");
  assert.ok(meterFrame);
  assert.equal(meterFrame.tick.aborted, true);
  assert.equal(meterFrame.tick.inputTokens, 8);
  // Reservation released on terminate — spend not double-committed.
  assert.equal(mgr.getRemaining(SCOPE).remaining, 50);
});

test("integration: ledger export/import survives restart; cross-subject import rejected", async () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 80 });
  mgr.recordSpend(
    SCOPE,
    { freshInputTokens: 20, cachedInputTokens: 4, outputTokens: 2 },
    { idempotencyKey: "restart-tick-1" },
  );
  const exported = mgr.exportLedger(SCOPE);
  assert.equal(exported.ok, true);
  assert.equal(exported.ledger.used, 26);
  assert.equal(exported.ledger.freshInputTokens, 20);
  assert.equal(exported.ledger.cachedInputTokens, 4);

  const restarted = new BudgetManager();
  const imported = restarted.importLedger(exported.ledger, SCOPE);
  assert.equal(imported.ok, true);
  assert.equal(imported.snapshot.remaining, 54);
  assert.equal(imported.snapshot.freshInputTokens, 20);

  // Idempotent replay of the same spend key on a fresh manager is independent
  // (idem keys are not exported) — export captures totals, not keys.
  const dup = restarted.recordSpend(
    SCOPE,
    { freshInputTokens: 20, cachedInputTokens: 4, outputTokens: 2 },
    { idempotencyKey: "restart-tick-1" },
  );
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, undefined);
  assert.equal(restarted.getRemaining(SCOPE).remaining, 28);

  const cross = restarted.importLedger(exported.ledger, {
    subjectId: "other-subject",
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.failureClass, "cross_subject");
});

test("integration: concurrent gated turns serialize; only one reserves", async () => {
  const mgr = new BudgetManager();
  mgr.setBudget(SCOPE, { limit: 30, resetUsed: true });

  const hosts = [1, 2, 3].map((i) => {
    const frames = [];
    return new StreamingTurnHost({
      subjectId: SCOPE.subjectId,
      correlationId: `corr-conc-${i}`,
      deviceId: SCOPE.deviceId,
      sessionId: SCOPE.sessionId,
      budgetManager: mgr,
      onFrame: (f) => frames.push(f),
    });
  });

  const results = await Promise.all(
    hosts.map((h) => h.gateBudgetBeforeModel(20)),
  );
  const allowed = results.filter((r) => r.proceed);
  const blocked = results.filter((r) => !r.proceed);
  assert.equal(allowed.length, 1);
  assert.equal(blocked.length, 2);
  assert.ok(blocked.every((r) => r.decision === "hardStop"));
  assert.equal(mgr.getRemaining(SCOPE).remaining, 10);

  for (const h of hosts) {
    await h.releaseBudgetReservation();
  }
  assert.equal(mgr.getRemaining(SCOPE).remaining, 30);
});

test("edge: budget exactly zero blocks with budget_exceeded telemetry", async () => {
  const mgrTelemetry = [];
  const mgr = new BudgetManager({
    onTelemetry: (e) => mgrTelemetry.push(e),
  });
  mgr.setBudget(SCOPE, { limit: 0, resetUsed: true });
  const host = new StreamingTurnHost({
    subjectId: SCOPE.subjectId,
    correlationId: "corr-zero",
    deviceId: SCOPE.deviceId,
    sessionId: SCOPE.sessionId,
    budgetManager: mgr,
  });
  const gate = await host.gateBudgetBeforeModel(0);
  assert.equal(gate.proceed, false);
  assert.equal(gate.advisory.code, BUDGET_ADVISORY_EXCEEDED);
  assert.ok(mgrTelemetry.some((e) => e.action === "budget_exceeded"));
});
