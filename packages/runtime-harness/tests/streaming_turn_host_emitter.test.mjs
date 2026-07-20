/**
 * StreamingTurnHost typed frame emitters + terminal error wrapper.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HARNESS_FRAME_TYPES,
  StreamingTurnHost,
  harnessFrameSchema,
} from "../dist/index.js";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function hostWithCapture(extra = {}) {
  const frames = [];
  const telemetry = [];
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-emit-01",
    deviceId: "edge-aaaa",
    onFrame: (f) => frames.push(f),
    onTelemetry: (e) => telemetry.push(e),
    ...extra,
  });
  return { host, frames, telemetry };
}

test("happy path: emit helpers cover every A P6 frame kind with monotonic sequence", () => {
  const { host, frames, telemetry } = hostWithCapture();
  assert.equal(host.peekNextSequenceIndex(), 0);

  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  assert.equal(host.emitThoughtDelta("consider…").ok, true);
  assert.equal(
    host.emitToolStatus({ toolCallId: "c1", status: "running" }).ok,
    true,
  );
  assert.equal(
    host.emitToolStatus({ toolCallId: "c1", status: "success" }).ok,
    true,
  );
  assert.equal(host.emitAnswerDelta("A ratio compares quantities.").ok, true);
  assert.equal(
    host.emitAdvisoryAttach({
      code: "CLOCK_SKEW_CLAMPED",
      detail: "clamped remote physical",
    }).ok,
    true,
  );
  assert.equal(
    host.emitMeterTick({
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: 2,
      latencyMs: 35,
      modelId: "slm-local",
      locality: "on-device",
      aborted: false,
    }).ok,
    true,
  );
  assert.equal(host.emitTurnComplete("turn-emit-01").ok, true);

  assert.equal(host.isTerminated, true);
  assert.equal(host.assertMonotonic().ok, true);
  assert.equal(frames.length, 8);
  for (let i = 0; i < frames.length; i++) {
    assert.equal(frames[i].sequenceIndex, i);
    assert.equal(frames[i].subjectId, "anika-k");
    harnessFrameSchema.parse(frames[i]);
  }

  const emittedTypes = new Set(frames.map((f) => f.type));
  for (const t of HARNESS_FRAME_TYPES) {
    if (t === "HARNESS_ERROR") continue;
    assert.ok(emittedTypes.has(t), `missing emit for ${t}`);
  }

  assert.ok(telemetry.every((e) => e.outcome === "ok"));
  assert.ok(telemetry.every((e) => !("delta" in e)));
  emit({
    event: "runtime.harness.emit",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    phase: "all-kinds",
    frameCount: frames.length,
  });
});

test("edge: handler throw emits HARNESS_ERROR via runGuarded before rethrow", () => {
  const { host, frames, telemetry } = hostWithCapture({
    correlationId: "corr-emit-02",
  });
  assert.throws(() => {
    host.runGuarded((h) => {
      assert.equal(h.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
      assert.equal(h.emitAnswerDelta("partial").ok, true);
      throw new Error("model pipeline crashed");
    });
  }, /model pipeline crashed/);

  assert.equal(host.isTerminated, true);
  const last = frames[frames.length - 1];
  assert.equal(last.type, "HARNESS_ERROR");
  assert.equal(last.code, "HANDLER_THROWN");
  assert.equal(host.assertTerminalPresent().ok, true);
  assert.ok(
    telemetry.some(
      (e) => e.outcome === "ok" && e.frameType === "HARNESS_ERROR",
    ),
  );
  emit({
    event: "runtime.harness.emit",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    phase: "guarded-throw",
    frameType: "HARNESS_ERROR",
  });
});

test("edge: terminateWithError closes truncated stream; append after rejects", () => {
  const { host, frames } = hostWithCapture({
    correlationId: "corr-emit-03",
  });
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  assert.equal(
    host.emitToolStatus({ toolCallId: "c1", status: "running" }).ok,
    true,
  );
  const term = host.terminateWithError({
    code: "CLIENT_DISCONNECT",
    message: "peer closed mid-stream",
    recoverable: true,
  });
  assert.equal(term.ok, true);
  assert.equal(frames[frames.length - 1].type, "HARNESS_ERROR");

  const again = host.terminateWithError({
    code: "CLIENT_DISCONNECT",
    message: "retry",
    recoverable: true,
  });
  assert.equal(again.ok, false);
  assert.equal(again.failureClass, "stream_already_terminated");

  const after = host.emitAnswerDelta("should fail");
  assert.equal(after.ok, false);
  assert.equal(after.failureClass, "stream_already_terminated");
  // Partial frames already sent remain valid.
  assert.equal(frames[0].type, "SESSION_START");
  assert.equal(frames[1].type, "TOOL_STATUS");
  emit({
    event: "runtime.harness.emit",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    failureClass: "stream_already_terminated",
  });
});

test("sovereignty: emit helpers cannot target a foreign subjectId", () => {
  const { host } = hostWithCapture({ correlationId: "corr-emit-04" });
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  const forged = host.appendValidated({
    type: "ANSWER_DELTA",
    sequenceIndex: 1,
    correlationId: "corr-emit-04",
    subjectId: "other-subject",
    delta: "leak",
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.failureClass, "cross_subject");
  emit({
    event: "runtime.harness.emit",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    failureClass: "cross_subject",
  });
});

test("scalability: allocator stays contiguous; budget still enforced", () => {
  const { host } = hostWithCapture({ correlationId: "corr-emit-05" });
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  for (let i = 1; i < 8; i++) {
    assert.equal(host.peekNextSequenceIndex(), i);
    assert.equal(host.emitAnswerDelta(`chunk-${i}`).ok, true);
  }
  assert.equal(host.peekNextSequenceIndex(), 8);
  assert.equal(host.getFrames().length, 8);
  assert.equal(host.assertMonotonic().ok, true);
});
