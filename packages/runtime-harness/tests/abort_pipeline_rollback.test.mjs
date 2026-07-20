/**
 * Rollback uncommitted effects + idempotency lock release (CK-07).
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AbortPipeline,
  IdempotencyLockTable,
  InProcessFakeDurableEffects,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: mid-write abort compensates durable effect and releases locks", async () => {
  const telemetry = [];
  const durable = new InProcessFakeDurableEffects();
  const pipeline = new AbortPipeline({
    onTelemetry: (e) => telemetry.push(e),
  });

  const reg = pipeline.registerTurn({
    turnId: "turn-rb",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  assert.equal(reg.ok, true);
  const handle = reg.handle;

  // Simulate tool mid-write with compensator (descriptor-bound reverse).
  durable.apply("write-1", { note: "partial" });
  const appended = handle.appendEffect({
    effectId: "write-1",
    toolName: "persist",
    idempotencyKey: "idem-write-1",
    riskClass: "write",
    midWrite: true,
    compensate: (entry) => {
      durable.compensate(entry.effectId);
    },
  });
  assert.equal(appended.ok, true);
  assert.equal(pipeline.locks.isHeld("idem-write-1"), true);
  assert.equal(durable.has("write-1"), true);

  const result = await pipeline.abort("turn-rb", { subjectId: "anika-k" });
  assert.equal(result.ok, true);
  assert.equal(result.action, "aborted");
  assert.equal(result.rolledBackCount, 1);
  assert.equal(result.abandonedCount, 0);
  assert.equal(result.locksReleased, 1);
  assert.equal(result.compensateFailures, 0);
  assert.equal(durable.size, 0);
  assert.equal(pipeline.locks.isHeld("idem-write-1"), false);
  assert.equal(handle.journal.list()[0].status, "rolled_back");

  assert.ok(telemetry.some((e) => e.action === "rollback"));
  assert.ok(telemetry.some((e) => e.action === "locks_released"));
  const abortTel = telemetry.find((e) => e.action === "aborted");
  assert.equal(abortTel?.subjectId, "anika-k");
  assert.equal(abortTel?.deviceId, "edge-aaaa");
  assert.equal(abortTel?.rolledBackCount, 1);
  assert.equal(abortTel?.locksReleased, 1);
  log({
    event: "runtime.harness.abort_pipeline",
    outcome: "ok",
    case: "mid_write_rollback",
    rolledBackCount: result.rolledBackCount,
    locksReleased: result.locksReleased,
  });
});

test("edge: double abort does not double-compensate or double-release locks", async () => {
  const durable = new InProcessFakeDurableEffects();
  let compensateCalls = 0;
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-once",
    subjectId: "anika-k",
  });

  durable.apply("w1");
  reg.handle.appendEffect({
    effectId: "w1",
    idempotencyKey: "lock-once",
    midWrite: true,
    compensate: () => {
      compensateCalls += 1;
      durable.compensate("w1");
    },
  });

  const first = await pipeline.abort("turn-once", { subjectId: "anika-k" });
  const second = await pipeline.abort("turn-once", { subjectId: "anika-k" });
  assert.equal(first.rolledBackCount, 1);
  assert.equal(first.locksReleased, 1);
  assert.equal(second.action, "already_aborted");
  assert.equal(second.rolledBackCount, 0);
  assert.equal(second.locksReleased, 0);
  assert.equal(compensateCalls, 1);
  assert.equal(durable.size, 0);
});

test("edge: pending without compensator is abandoned; keys released in finally", async () => {
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-pend",
    subjectId: "anika-k",
  });
  reg.handle.appendEffect({
    effectId: "p1",
    idempotencyKey: "pend-1",
    midWrite: false,
  });
  const r = await pipeline.abort("turn-pend", { subjectId: "anika-k" });
  assert.equal(r.abandonedCount, 1);
  assert.equal(r.rolledBackCount, 0);
  assert.equal(r.locksReleased, 1);
  assert.equal(reg.handle.journal.list()[0].status, "abandoned");
  assert.equal(pipeline.locks.isHeld("pend-1"), false);
});

test("edge: compensator throw still releases locks (finally) and marks abandoned", async () => {
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-fail",
    subjectId: "anika-k",
  });
  reg.handle.appendEffect({
    effectId: "boom",
    idempotencyKey: "lock-boom",
    midWrite: true,
    compensate: () => {
      throw new Error("compensate failed");
    },
  });
  const r = await pipeline.abort("turn-fail", { subjectId: "anika-k" });
  assert.equal(r.action, "aborted");
  assert.equal(r.compensateFailures, 1);
  assert.equal(r.abandonedCount, 1);
  assert.equal(r.locksReleased, 1);
  assert.equal(pipeline.locks.isHeld("lock-boom"), false);
  assert.equal(reg.handle.journal.list()[0].status, "abandoned");
});

test("edge: concurrent turns do not release each other's locks", async () => {
  const pipeline = new AbortPipeline();
  const a = pipeline.registerTurn({ turnId: "ta", subjectId: "anika-k" });
  const b = pipeline.registerTurn({ turnId: "tb", subjectId: "anika-k" });
  a.handle.appendEffect({ effectId: "ea", idempotencyKey: "ka" });
  b.handle.appendEffect({ effectId: "eb", idempotencyKey: "kb" });

  await pipeline.abort("ta", { subjectId: "anika-k" });
  assert.equal(pipeline.locks.isHeld("ka"), false);
  assert.equal(pipeline.locks.isHeld("kb"), true);

  await pipeline.abort("tb", { subjectId: "anika-k" });
  assert.equal(pipeline.locks.isHeld("kb"), false);
});

test("edge: lock held by another turn rejects append (no double-apply)", () => {
  const locks = new IdempotencyLockTable();
  const pipeline = new AbortPipeline({ lockTable: locks });
  const a = pipeline.registerTurn({ turnId: "t-lock-a", subjectId: "anika-k" });
  const b = pipeline.registerTurn({ turnId: "t-lock-b", subjectId: "anika-k" });
  assert.equal(
    a.handle.appendEffect({ effectId: "ea", idempotencyKey: "shared" }).ok,
    true,
  );
  const conflict = b.handle.appendEffect({
    effectId: "eb",
    idempotencyKey: "shared",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.failureClass, "lock_held");
});

test("sovereignty: cross-subject cannot release or abort another journal", async () => {
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-iso-rb",
    subjectId: "anika-k",
  });
  reg.handle.appendEffect({
    effectId: "e",
    idempotencyKey: "iso-k",
    midWrite: true,
    compensate: () => {},
  });

  const stolen = await pipeline.abort("turn-iso-rb", {
    subjectId: "other-learner",
  });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.failureClass, "cross_subject");
  assert.equal(pipeline.locks.isHeld("iso-k"), true);
});

test("scalability: journal + lock table stay bounded", async () => {
  const pipeline = new AbortPipeline({
    lockTable: new IdempotencyLockTable(3),
  });
  const reg = pipeline.registerTurn({
    turnId: "turn-bound",
    subjectId: "anika-k",
  });
  assert.equal(
    reg.handle.appendEffect({ effectId: "1", idempotencyKey: "l1" }).ok,
    true,
  );
  assert.equal(
    reg.handle.appendEffect({ effectId: "2", idempotencyKey: "l2" }).ok,
    true,
  );
  assert.equal(
    reg.handle.appendEffect({ effectId: "3", idempotencyKey: "l3" }).ok,
    true,
  );
  const full = reg.handle.appendEffect({
    effectId: "4",
    idempotencyKey: "l4",
  });
  assert.equal(full.ok, false);
  assert.equal(full.failureClass, "lock_table_full");

  await pipeline.abort("turn-bound", { subjectId: "anika-k" });
  assert.equal(pipeline.locks.size, 0);
});

test("edge: escalate pending → mid_write then compensate on abort", async () => {
  const durable = new InProcessFakeDurableEffects();
  const pipeline = new AbortPipeline();
  const reg = pipeline.registerTurn({
    turnId: "turn-esc",
    subjectId: "anika-k",
  });
  reg.handle.appendEffect({
    effectId: "esc-1",
    idempotencyKey: "esc-k",
    compensate: (e) => {
      durable.compensate(e.effectId);
    },
  });
  durable.apply("esc-1");
  assert.equal(reg.handle.markEffectMidWrite("esc-1"), true);
  assert.equal(reg.handle.journal.list()[0].status, "mid_write");

  const r = await pipeline.abort("turn-esc", { subjectId: "anika-k" });
  assert.equal(r.rolledBackCount, 1);
  assert.equal(durable.has("esc-1"), false);
});
