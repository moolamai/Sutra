/**
 * AbortController registry per active turn (CK-07 emergency abort).
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ABORT_REASON_MANUAL,
  ABORT_REGISTRY_LIMIT,
  AbortPipeline,
  waitForAbortSignal,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: register turn → abort cascades to model and sandbox signals", async () => {
  const telemetry = [];
  const pipeline = new AbortPipeline({
    onTelemetry: (e) => telemetry.push(e),
  });

  const reg = pipeline.registerTurn({
    turnId: "turn-1",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  assert.equal(reg.ok, true);
  const handle = reg.handle;

  const modelWait = waitForAbortSignal(handle.modelSignal, 500);
  const sandboxWait = waitForAbortSignal(handle.sandboxSignal, 500);

  handle.appendEffect({
    effectId: "eff-1",
    toolName: "lookup",
    idempotencyKey: "idem-1",
  });
  assert.equal(handle.journal.size, 1);
  assert.equal(handle.journal.listUncommitted().length, 1);

  const result = await pipeline.abort("turn-1", { subjectId: "anika-k" });
  assert.equal(result.ok, true);
  assert.equal(result.action, "aborted");
  assert.equal(result.signalCascaded, true);
  assert.ok(result.cascadeLatencyMs >= 0);
  assert.equal(result.uncommittedCount, 1);
  assert.equal(result.abandonedCount, 1);
  assert.equal(result.locksReleased, 1);

  assert.equal(await modelWait, "aborted");
  assert.equal(await sandboxWait, "aborted");
  assert.equal(handle.modelSignal.aborted, true);
  assert.equal(handle.sandboxSignal.aborted, true);
  assert.equal(handle.signal.aborted, true);
  assert.equal(handle.journal.list()[0].status, "abandoned");
  assert.equal(pipeline.locks.isHeld("idem-1"), false);

  const abortTel = telemetry.find((e) => e.action === "aborted");
  assert.equal(abortTel?.subjectId, "anika-k");
  assert.equal(abortTel?.deviceId, "edge-aaaa");
  assert.equal(abortTel?.turnId, "turn-1");
  assert.ok(typeof abortTel?.cascadeLatencyMs === "number");
  log({
    event: "runtime.harness.abort_pipeline",
    outcome: "ok",
    case: "cascade",
    cascadeLatencyMs: result.cascadeLatencyMs,
  });
});

test("edge: double abort for same turnId is idempotent (no double cascade)", async () => {
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-dbl",
    subjectId: "anika-k",
  });
  assert.equal(reg.ok, true);
  reg.handle.appendEffect({ effectId: "e1" });

  const first = await pipeline.abort("turn-dbl", { subjectId: "anika-k" });
  const second = await pipeline.abort("turn-dbl", { subjectId: "anika-k" });
  assert.equal(first.action, "aborted");
  assert.equal(first.signalCascaded, true);
  assert.equal(second.action, "already_aborted");
  assert.equal(second.signalCascaded, false);
  assert.equal(second.rolledBackCount, 0);
  assert.equal(second.locksReleased, 0);
});

test("edge: abort with no in-flight turn → not_found", async () => {
  const pipeline = new AbortPipeline();
  const r = await pipeline.abort("missing-turn", { subjectId: "anika-k" });
  assert.equal(r.ok, false);
  assert.equal(r.failureClass, "not_found");
});

test("edge: accept-vs-abort — TURN_COMPLETE with committed effects → already_completed", async () => {
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-done",
    subjectId: "anika-k",
  });
  assert.equal(reg.ok, true);
  reg.handle.appendEffect({ effectId: "e-committed" });
  reg.handle.markEffectCommitted("e-committed");

  const done = pipeline.markTurnCompleted("turn-done", {
    subjectId: "anika-k",
    effectsCommitted: true,
  });
  assert.equal(done.ok, true);

  const r = await pipeline.abort("turn-done", { subjectId: "anika-k" });
  assert.equal(r.ok, true);
  assert.equal(r.action, "already_completed");
  assert.equal(r.signalCascaded, false);
  assert.equal(reg.handle.signal.aborted, false);
});

test("edge: abort before complete abandons uncommitted journal (zero durable)", async () => {
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-partial",
    subjectId: "anika-k",
  });
  reg.handle.appendEffect({ effectId: "e-a", idempotencyKey: "k-a" });
  reg.handle.appendEffect({ effectId: "e-b", idempotencyKey: "k-b" });
  reg.handle.markEffectCommitted("e-a");

  const r = await pipeline.abort("turn-partial", { subjectId: "anika-k" });
  assert.equal(r.action, "aborted");
  assert.equal(r.uncommittedCount, 1);
  assert.equal(r.abandonedCount, 1);
  const byId = Object.fromEntries(
    reg.handle.journal.list().map((e) => [e.effectId, e.status]),
  );
  assert.equal(byId["e-a"], "committed");
  assert.equal(byId["e-b"], "abandoned");
  assert.equal(pipeline.locks.isHeld("k-a"), false);
  assert.equal(pipeline.locks.isHeld("k-b"), false);
});

test("sovereignty: cross-subject abort / register is rejected", async () => {
  const pipeline = new AbortPipeline();
  assert.equal(
    pipeline.registerTurn({ turnId: "turn-iso", subjectId: "anika-k" }).ok,
    true,
  );

  const abortOther = await pipeline.abort("turn-iso", {
    subjectId: "other-learner",
  });
  assert.equal(abortOther.ok, false);
  assert.equal(abortOther.failureClass, "cross_subject");

  const dupOther = pipeline.registerTurn({
    turnId: "turn-iso",
    subjectId: "other-learner",
  });
  assert.equal(dupOther.ok, false);
  assert.equal(dupOther.failureClass, "cross_subject");

  const get = pipeline.getHandle("turn-iso", "other-learner");
  assert.equal(get.ok, false);
  assert.equal(get.failureClass, "cross_subject");
});

test("scalability: registry enforces maxActiveTurns bound", () => {
  const pipeline = new AbortPipeline({ maxActiveTurns: 2 });
  assert.equal(
    pipeline.registerTurn({ turnId: "t1", subjectId: "anika-k" }).ok,
    true,
  );
  assert.equal(
    pipeline.registerTurn({ turnId: "t2", subjectId: "anika-k" }).ok,
    true,
  );
  const full = pipeline.registerTurn({ turnId: "t3", subjectId: "anika-k" });
  assert.equal(full.ok, false);
  assert.equal(full.failureClass, "registry_full");
  assert.ok(ABORT_REGISTRY_LIMIT >= 2);
});

test("edge: concurrent turns for same subjectId keep independent signals", async () => {
  const pipeline = new AbortPipeline();
  const a = pipeline.registerTurn({ turnId: "turn-a", subjectId: "anika-k" });
  const b = pipeline.registerTurn({ turnId: "turn-b", subjectId: "anika-k" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  await pipeline.abort("turn-a", { subjectId: "anika-k" });
  assert.equal(a.handle.modelSignal.aborted, true);
  assert.equal(b.handle.modelSignal.aborted, false);
  assert.equal(b.handle.sandboxSignal.aborted, false);

  await pipeline.abort("turn-b", { subjectId: "anika-k" });
  assert.equal(b.handle.sandboxSignal.aborted, true);
});

test("deterministic fake: hung wait resolves when abort cascades", async () => {
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-hang",
    subjectId: "anika-k",
  });
  const pending = waitForAbortSignal(reg.handle.sandboxSignal, 2_000);
  setTimeout(() => {
    void pipeline.abort("turn-hang", {
      subjectId: "anika-k",
      reason: ABORT_REASON_MANUAL,
    });
  }, 5);
  assert.equal(await pending, "aborted");
});
