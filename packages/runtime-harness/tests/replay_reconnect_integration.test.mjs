/**
 * Replay-reconnect integration: host + buffer + Last-Event-ID resume.
 * Simulates disconnect after frame 5, resume from 5 → 6..N; gap at 99.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryStreamFrameBuffer,
  STREAM_BUFFER_RESYNC_ADVISORY,
  STREAM_RESUME_GAP_CODE,
  StreamingTurnHost,
  assertMonotonicSequence,
  harnessFrameSchema,
  resolveStreamResume,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Produce a multi-frame turn with TOOL_STATUS in-flight, then terminal.
 * Sequence layout (0..N):
 *   0 SESSION_START
 *   1 THOUGHT_DELTA
 *   2 ANSWER_DELTA
 *   3 TOOL_STATUS running   ← in-flight tool (must not restart on resume)
 *   4 ANSWER_DELTA
 *   5 ANSWER_DELTA          ← client disconnects after this (Last-Event-ID: 5)
 *   6 TOOL_STATUS succeeded
 *   7 ANSWER_DELTA
 *   8 METER_TICK
 *   9 TURN_COMPLETE
 */
function seedFullTurn(opts = {}) {
  const subjectId = opts.subjectId ?? "anika-k";
  const streamId = opts.streamId ?? "corr-int-reconnect-01";
  const deviceId = opts.deviceId ?? "edge-aaaa";
  const retentionWindow = opts.retentionWindow ?? 64;
  const telemetry = [];
  const sideEffects = { toolRunningEmits: 0, toolSuccessEmits: 0 };

  const buf = new InMemoryStreamFrameBuffer({
    subjectId,
    streamId,
    deviceId,
    retentionWindow,
    onTelemetry: (e) => telemetry.push(e),
  });

  const host = new StreamingTurnHost({
    subjectId,
    correlationId: streamId,
    deviceId,
    frameBuffer: buf,
    onTelemetry: (e) => telemetry.push(e),
    onFrame: (frame) => {
      if (frame.type === "TOOL_STATUS" && frame.status === "running") {
        sideEffects.toolRunningEmits += 1;
      }
      if (frame.type === "TOOL_STATUS" && frame.status === "success") {
        sideEffects.toolSuccessEmits += 1;
      }
    },
  });

  assert.equal(host.emitSessionStart("2026-07-15T12:00:00.000Z").ok, true); // 0
  assert.equal(host.emitThoughtDelta("planning…").ok, true); // 1
  assert.equal(host.emitAnswerDelta("A ratio ").ok, true); // 2
  assert.equal(
    host.emitToolStatus({
      toolCallId: "tool-calc-1",
      status: "running",
      detail: "compute",
    }).ok,
    true,
  ); // 3
  assert.equal(host.emitAnswerDelta("compares ").ok, true); // 4
  assert.equal(host.emitAnswerDelta("two quantities.").ok, true); // 5
  assert.equal(
    host.emitToolStatus({
      toolCallId: "tool-calc-1",
      status: "success",
    }).ok,
    true,
  ); // 6
  assert.equal(host.emitAnswerDelta(" Done.").ok, true); // 7
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
  ); // 8
  assert.equal(host.emitTurnComplete("turn-int-1").ok, true); // 9

  assert.equal(host.sequenceLength, 10);
  assert.equal(sideEffects.toolRunningEmits, 1);
  return { host, buf, telemetry, sideEffects, subjectId, streamId, deviceId };
}

test("integration: disconnect after frame 5, resume → lossless 6..N", () => {
  const { host, buf, telemetry, sideEffects } = seedFullTurn();

  // Client received 0..5; disconnect. Buffered state still has full turn.
  const clientSeen = host.getFrames().slice(0, 6);
  assert.equal(clientSeen[5].sequenceIndex, 5);
  assert.equal(buf.size, 10);

  const retained = buf.framesAfter(-1);
  assert.equal(retained.ok, true);
  assert.equal(retained.frames.length, 10);

  // Reconnect with Last-Event-ID: 5 — attach only, no new tool side effects.
  const resume = host.resumeFromLastEventId("5");
  assert.equal(resume.ok, true);
  assert.equal(resume.action, "replay");
  assert.equal(resume.attach, true);
  assert.deepEqual(
    resume.frames.map((f) => f.sequenceIndex),
    [6, 7, 8, 9],
  );
  assert.equal(resume.frames[0].type, "TOOL_STATUS");
  assert.equal(resume.frames[0].status, "success");
  assert.equal(resume.frames[3].type, "TURN_COMPLETE");

  for (const frame of resume.frames) {
    assert.equal(harnessFrameSchema.safeParse(frame).success, true);
  }
  assert.equal(assertMonotonicSequence(resume.frames).ok, true);

  // Attach must not re-emit in-flight tool starts (no restart).
  assert.equal(sideEffects.toolRunningEmits, 1);
  assert.equal(sideEffects.toolSuccessEmits, 1);

  const resumeTel = telemetry.filter(
    (e) => e.event === "runtime.harness.resume" && e.action === "replay",
  );
  assert.equal(resumeTel.length, 1);
  assert.equal(resumeTel[0].outcome, "ok");
  assert.equal(resumeTel[0].subjectId, "anika-k");
  assert.equal(resumeTel[0].deviceId, "edge-aaaa");
  assert.equal(resumeTel[0].replayCount, 4);

  log({
    case: "disconnect_after_5",
    outcome: "ok",
    replayFrom: 6,
    replayTo: 9,
  });
});

test("integration: gap fixture Last-Event-ID 99 → SEQUENCE_GAP + RESYNC_REQUIRED", () => {
  const { host, telemetry } = seedFullTurn();
  const resume = host.resumeFromLastEventId("99");
  assert.equal(resume.ok, false);
  assert.equal(resume.action, "gap");
  assert.equal(resume.failureClass, "gap");
  assert.equal(resume.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  assert.equal(resume.gapFrame.code, STREAM_RESUME_GAP_CODE);
  assert.equal(resume.gapFrame.recoverable, false);
  assert.match(resume.gapFrame.message, /RESYNC_REQUIRED/);
  assert.equal(harnessFrameSchema.safeParse(resume.gapFrame).success, true);

  const gapTel = telemetry.filter(
    (e) => e.event === "runtime.harness.resume" && e.action === "gap",
  );
  assert.ok(gapTel.length >= 1);
  assert.equal(gapTel[0].advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  log({ case: "gap_fixture_99", outcome: "gap", advisory: resume.advisory });
});

test("integration: server restart clears buffer → full resync advisory", () => {
  const { host, buf, telemetry } = seedFullTurn();
  buf.clear();
  const resume = host.resumeFromLastEventId("5");
  assert.equal(resume.ok, false);
  assert.equal(resume.action, "gap");
  assert.equal(resume.failureClass, "empty_buffer");
  assert.equal(resume.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  assert.equal(resume.gapFrame.code, STREAM_RESUME_GAP_CODE);

  const events = telemetry.filter(
    (e) =>
      e.failureClass === "empty_buffer" ||
      (e.event === "runtime.harness.resume" && e.action === "gap"),
  );
  assert.ok(events.length >= 1);
  log({ case: "restart_empty_buffer", outcome: "gap" });
});

test("integration: duplicate Last-Event-ID is idempotent (no extra side effects)", () => {
  const { host, sideEffects } = seedFullTurn();
  const a = host.resumeFromLastEventId("5");
  const b = host.resumeFromLastEventId("5");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(
    a.frames.map((f) => f.sequenceIndex),
    b.frames.map((f) => f.sequenceIndex),
  );
  assert.equal(sideEffects.toolRunningEmits, 1);
  assert.equal(sideEffects.toolSuccessEmits, 1);
  log({ case: "idempotent_last_event_id", outcome: "ok" });
});

test("integration: concurrent devices attach to same stream — same replay, no double tools", () => {
  const { buf, sideEffects, subjectId, streamId } = seedFullTurn();
  const telA = [];
  const telB = [];

  const deviceA = resolveStreamResume({
    lastEventIdHeader: "5",
    buffer: buf,
    subjectId,
    streamId,
    deviceId: "edge-aaaa",
    onTelemetry: (e) => telA.push(e),
  });
  const deviceB = resolveStreamResume({
    lastEventIdHeader: "5",
    buffer: buf,
    subjectId,
    streamId,
    deviceId: "edge-bbbb",
    onTelemetry: (e) => telB.push(e),
  });

  assert.equal(deviceA.ok, true);
  assert.equal(deviceB.ok, true);
  assert.deepEqual(
    deviceA.frames.map((f) => f.sequenceIndex),
    deviceB.frames.map((f) => f.sequenceIndex),
  );
  assert.equal(sideEffects.toolRunningEmits, 1);
  assert.equal(telA[0].deviceId, "edge-aaaa");
  assert.equal(telB[0].deviceId, "edge-bbbb");
  log({ case: "concurrent_device_attach", outcome: "ok" });
});

test("integration sovereignty: cross-subject resume rejected (no frame leak)", () => {
  const { buf, streamId } = seedFullTurn();
  const resume = resolveStreamResume({
    lastEventIdHeader: "5",
    buffer: buf,
    subjectId: "stranger",
    streamId,
    deviceId: "edge-evil",
  });
  assert.equal(resume.ok, false);
  assert.equal(resume.action, "reject");
  assert.equal(resume.failureClass, "cross_subject");
  assert.equal("frames" in resume, false);
  log({ case: "cross_subject_reject", outcome: "rejected" });
});

test("integration: retention eviction then cold resume → GAP advisory", () => {
  const { host, buf } = seedFullTurn({ retentionWindow: 4 });
  // Window 4 on a 10-frame turn → early indices evicted.
  assert.ok(buf.retentionWindow <= 4);
  const cold = host.resumeFromLastEventId("0");
  assert.equal(cold.ok, false);
  assert.equal(cold.action, "gap");
  assert.equal(cold.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  log({ case: "eviction_cold_resume", outcome: "gap" });
});
