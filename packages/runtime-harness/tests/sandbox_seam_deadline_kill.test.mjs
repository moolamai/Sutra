/**
 * Integration: hung sandbox tool killed at deadline; turn completes with
 * TOOL_STATUS error; host loop is not blocked.
 *
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  InProcessFakeToolRegistry,
  StreamingTurnHost,
  createSandboxSeam,
  harnessFrameSchema,
  invokeSandboxAndMap,
  mapSandboxResultToToolStatus,
} from "../dist/index.js";

/** Soft wall clock for hang kill — well under turn NFR budgets. */
const HANG_DEADLINE_MS = 50;
const HOST_LOOP_BUDGET_MS = 1500;

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function hangDescriptor(name = "hang-tool") {
  return {
    name,
    description: "never-resolving probe",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    riskClass: "compute",
  };
}

function writeHangDescriptor() {
  return {
    name: "hang-write",
    description: "never-resolving write probe",
    parameters: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
    riskClass: "write",
  };
}

function readDescriptor(name = "lookup") {
  return {
    name,
    description: "fast read after hang",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    riskClass: "read",
  };
}

test("happy path: hung tool → deadline kill → TOOL_STATUS error → TURN_COMPLETE", async () => {
  const registry = new InProcessFakeToolRegistry();
  const hang = hangDescriptor();
  registry.register({ descriptor: hang, hang: true });
  const telemetry = [];
  const seam = createSandboxSeam({
    registry,
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    onTelemetry: (e) => telemetry.push(e),
  });

  const frames = [];
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-hang-01",
    deviceId: "edge-aaaa",
    onFrame: (f) => frames.push(f),
  });

  const t0 = Date.now();
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  assert.equal(
    host.emitToolStatus({ toolCallId: "inv-hang-1", status: "running" }).ok,
    true,
  );

  const mapped = await invokeSandboxAndMap(
    seam,
    hang,
    { q: "x" },
    {
      subjectId: "anika-k",
      deviceId: "edge-aaaa",
      invocationId: "inv-hang-1",
      deadlineMs: HANG_DEADLINE_MS,
    },
    {
      subjectId: "anika-k",
      correlationId: "corr-hang-01",
      sequenceIndex: host.peekNextSequenceIndex(),
      toolCallId: "inv-hang-1",
    },
  );

  assert.equal(mapped.result.ok, false);
  assert.equal(mapped.result.failureClass, "deadline_exceeded");
  assert.equal(mapped.toolStatus.status, "error");
  assert.match(mapped.toolStatus.detail, /deadline/i);

  assert.equal(
    host.emitToolStatus({
      toolCallId: mapped.toolStatus.toolCallId,
      status: mapped.toolStatus.status,
      detail: mapped.toolStatus.detail,
    }).ok,
    true,
  );
  assert.equal(host.emitTurnComplete("turn-hang-01").ok, true);

  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < HOST_LOOP_BUDGET_MS,
    `host loop must not block on hung tool; elapsed=${elapsed}`,
  );
  assert.equal(host.isTerminated, true);
  assert.equal(host.assertMonotonic().ok, true);

  const errorStatus = frames.find(
    (f) => f.type === "TOOL_STATUS" && f.status === "error",
  );
  assert.ok(errorStatus, "turn must complete with TOOL_STATUS error frame");
  harnessFrameSchema.parse(errorStatus);
  assert.equal(frames[frames.length - 1].type, "TURN_COMPLETE");

  assert.ok(
    telemetry.some(
      (t) =>
        t.outcome === "rejected" && t.failureClass === "deadline_exceeded",
    ),
  );
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(!JSON.stringify(telemetry).includes("secret"));

  // No effect phase for a hung kill.
  assert.ok(!registry.invokeOrder.some((t) => t.phase === "effect"));

  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    failureClass: "deadline_exceeded",
    case: "turn_completes_with_error_frame",
    elapsedMs: elapsed,
  });
});

test("edge: after hung kill, host loop continues with a successful tool", async () => {
  const registry = new InProcessFakeToolRegistry();
  const hang = hangDescriptor("hang-then-ok");
  const okTool = readDescriptor("after-hang");
  registry.register({ descriptor: hang, hang: true });
  registry.register({
    descriptor: okTool,
    effect: (args) => ({ hit: args.q }),
  });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });

  const hung = await invokeSandboxAndMap(
    seam,
    hang,
    { q: "blocked" },
    {
      subjectId: "anika-k",
      invocationId: "inv-a",
      deadlineMs: HANG_DEADLINE_MS,
    },
    {
      subjectId: "anika-k",
      correlationId: "corr-cont",
      sequenceIndex: 1,
    },
  );
  assert.equal(hung.result.failureClass, "deadline_exceeded");

  const t1 = Date.now();
  const next = await invokeSandboxAndMap(
    seam,
    okTool,
    { q: "ok" },
    {
      subjectId: "anika-k",
      invocationId: "inv-b",
      deadlineMs: 200,
    },
    {
      subjectId: "anika-k",
      correlationId: "corr-cont",
      sequenceIndex: 2,
    },
  );
  const elapsed = Date.now() - t1;
  assert.equal(next.result.ok, true);
  assert.equal(next.toolStatus.status, "success");
  assert.ok(elapsed < 500, `post-hang invoke should be fast; elapsed=${elapsed}`);
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "host_loop_not_blocked",
    elapsedMs: elapsed,
  });
});

test("edge: write-ahead audit before hang; no effect on deadline kill", async () => {
  const registry = new InProcessFakeToolRegistry();
  const hang = writeHangDescriptor();
  registry.register({ descriptor: hang, hang: true });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });

  const result = await seam.invoke(
    hang,
    { note: "n" },
    {
      subjectId: "anika-k",
      invocationId: "inv-w-hang",
      deadlineMs: HANG_DEADLINE_MS,
      writeAheadRecorded: true,
    },
  );
  assert.equal(result.failureClass, "deadline_exceeded");
  const phases = registry.invokeOrder
    .filter((t) => t.invocationId === "inv-w-hang")
    .map((t) => t.phase);
  assert.deepEqual(phases, ["audit"]);
  assert.ok(!phases.includes("effect"));
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    failureClass: "deadline_exceeded",
    case: "audit_without_effect_on_hang",
  });
});

test("edge: concurrent hang same idempotency key — at-most-once, shared deadline", async () => {
  const registry = new InProcessFakeToolRegistry();
  const hang = hangDescriptor("hang-idem");
  registry.register({ descriptor: hang, hang: true });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  const ctx = {
    subjectId: "anika-k",
    invocationId: "inv-idem-hang",
    idempotencyKey: "idem-hang-1",
    deadlineMs: HANG_DEADLINE_MS,
  };
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    seam.invoke(hang, { q: "1" }, ctx),
    seam.invoke(hang, { q: "2" }, ctx),
  ]);
  const elapsed = Date.now() - t0;
  assert.equal(a.failureClass, "deadline_exceeded");
  assert.equal(b.failureClass, "deadline_exceeded");
  assert.ok(elapsed < HOST_LOOP_BUDGET_MS);
  // Idempotent replay after kill is immediate (cached), not a second hang wait.
  const t1 = Date.now();
  const replay = await seam.invoke(hang, { q: "3" }, ctx);
  const replayElapsed = Date.now() - t1;
  assert.equal(replay.failureClass, "deadline_exceeded");
  assert.ok(
    replayElapsed < HANG_DEADLINE_MS,
    `replay must use cache; elapsed=${replayElapsed}`,
  );
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    failureClass: "deadline_exceeded",
    case: "concurrent_idempotent_hang",
    elapsedMs: elapsed,
    replayElapsedMs: replayElapsed,
  });
});

test("sovereignty: hung-kill telemetry scoped; mapped frame subjectId forced", async () => {
  const registry = new InProcessFakeToolRegistry();
  const hang = hangDescriptor("hang-scope");
  registry.register({ descriptor: hang, hang: true });
  const telemetry = [];
  const seam = createSandboxSeam({
    registry,
    subjectId: "anika-k",
    deviceId: "edge-scope",
    onTelemetry: (e) => telemetry.push(e),
  });
  const result = await seam.invoke(
    hang,
    { q: "learner-private" },
    {
      subjectId: "anika-k",
      invocationId: "inv-scope",
      deadlineMs: HANG_DEADLINE_MS,
    },
  );
  assert.equal(result.failureClass, "deadline_exceeded");
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(!JSON.stringify(telemetry).includes("learner-private"));

  const cross = await seam.invoke(
    hang,
    { q: "x" },
    {
      subjectId: "other-subject",
      invocationId: "inv-cross",
      deadlineMs: HANG_DEADLINE_MS,
    },
  );
  assert.equal(cross.failureClass, "cross_subject");

  const frame = mapSandboxResultToToolStatus(result, {
    subjectId: "anika-k",
    correlationId: "corr-scope",
    sequenceIndex: 0,
  });
  assert.equal(frame.subjectId, "anika-k");
  assert.equal(frame.status, "error");
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-scope",
    case: "sovereignty_hang_kill",
  });
});

test("scalability: hang deadline stays within soft kill budget", async () => {
  const registry = new InProcessFakeToolRegistry();
  const hang = hangDescriptor("hang-budget");
  registry.register({ descriptor: hang, hang: true });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  assert.ok(HANG_DEADLINE_MS <= 100);
  assert.ok(HOST_LOOP_BUDGET_MS <= 2000);
  const t0 = Date.now();
  const result = await seam.invoke(
    hang,
    { q: "x" },
    {
      subjectId: "anika-k",
      invocationId: "inv-budget",
      deadlineMs: HANG_DEADLINE_MS,
    },
  );
  const elapsed = Date.now() - t0;
  assert.equal(result.failureClass, "deadline_exceeded");
  assert.ok(elapsed >= HANG_DEADLINE_MS - 5);
  assert.ok(elapsed < HOST_LOOP_BUDGET_MS);
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    failureClass: "deadline_exceeded",
    case: "budget",
    elapsedMs: elapsed,
    deadlineMs: HANG_DEADLINE_MS,
  });
});
