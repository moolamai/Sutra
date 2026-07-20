/**
 * Per-stream frame buffer indexed by sequenceIndex.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryStreamFrameBuffer,
  STREAM_BUFFER_RESYNC_ADVISORY,
  STREAM_FRAME_BUFFER_RETENTION_DEFAULT,
  StreamingTurnHost,
  harnessFrameSchema,
} from "../dist/index.js";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sessionFrame(seq, subject = "anika-k", stream = "corr-buf-01") {
  return {
    type: "SESSION_START",
    sequenceIndex: seq,
    correlationId: stream,
    subjectId: subject,
    protocolVersion: "1.0.0",
    pinnedAt: "2026-07-15T00:00:00.000Z",
  };
}

function answerFrame(seq, subject = "anika-k", stream = "corr-buf-01") {
  return {
    type: "ANSWER_DELTA",
    sequenceIndex: seq,
    correlationId: stream,
    subjectId: subject,
    delta: `chunk-${seq}`,
  };
}

test("happy path: store by sequenceIndex and lossless framesAfter", () => {
  const telemetry = [];
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-buf-01",
    deviceId: "edge-aaaa",
    retentionWindow: 16,
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(buf.retentionWindow, 16);
  assert.ok(STREAM_FRAME_BUFFER_RETENTION_DEFAULT >= 1);

  for (let i = 0; i < 3; i++) {
    const frame = i === 0 ? sessionFrame(0) : answerFrame(i);
    harnessFrameSchema.parse(frame);
    const r = buf.append(frame);
    assert.equal(r.ok, true);
    assert.equal(r.sequenceIndex, i);
    assert.equal(r.idempotentReplay, false);
  }
  assert.equal(buf.size, 3);
  assert.equal(buf.getBySequenceIndex(1)?.type, "ANSWER_DELTA");

  const replay = buf.framesAfter(0);
  assert.equal(replay.ok, true);
  assert.equal(replay.frames.length, 2);
  assert.equal(replay.frames[0].sequenceIndex, 1);
  assert.equal(replay.frames[1].sequenceIndex, 2);
  assert.ok(telemetry.every((e) => e.event === "runtime.harness.buffer"));
  assert.ok(telemetry.every((e) => !("delta" in e)));
  emit({
    event: "runtime.harness.buffer",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    phase: "store-replay",
    retained: buf.size,
  });
});

test("edge: duplicate sequenceIndex is idempotent (no duplicate side effects)", () => {
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-buf-01",
  });
  const frame = answerFrame(0);
  assert.equal(buf.append(sessionFrame(0)).ok, true);
  // Replace seq 0 attempt with same index different payload — first wins; second is idempotent accept
  const again = buf.append(sessionFrame(0));
  assert.equal(again.ok, true);
  assert.equal(again.idempotentReplay, true);
  assert.equal(buf.size, 1);
  emit({
    event: "runtime.harness.buffer",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: null,
    phase: "idempotent",
  });
});

test("edge: resume from never-issued sequenceIndex → GAP + RESYNC_REQUIRED", () => {
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-buf-01",
    retentionWindow: 8,
  });
  assert.equal(buf.append(sessionFrame(0)).ok, true);
  const gap = buf.framesAfter(99);
  assert.equal(gap.ok, false);
  assert.equal(gap.failureClass, "gap");
  assert.equal(gap.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  emit({
    event: "runtime.harness.buffer",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: null,
    failureClass: "gap",
    advisory: STREAM_BUFFER_RESYNC_ADVISORY,
  });
});

test("edge: empty buffer (restart) signals full resync advisory", () => {
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-buf-01",
  });
  const empty = buf.framesAfter(-1);
  assert.equal(empty.ok, false);
  assert.equal(empty.failureClass, "empty_buffer");
  assert.equal(empty.advisory, STREAM_BUFFER_RESYNC_ADVISORY);

  assert.equal(buf.append(sessionFrame(0)).ok, true);
  buf.clear();
  assert.equal(buf.size, 0);
  assert.equal(buf.resyncAdvisoryPending, true);
  const afterClear = buf.framesAfter(-1);
  assert.equal(afterClear.ok, false);
  assert.equal(afterClear.failureClass, "empty_buffer");
});

test("edge: retention window eviction then cold resume → GAP", () => {
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-buf-01",
    retentionWindow: 2,
  });
  assert.equal(buf.append(sessionFrame(0)).ok, true);
  assert.equal(buf.append(answerFrame(1)).ok, true);
  const third = buf.append(answerFrame(2));
  assert.equal(third.ok, true);
  assert.equal(third.evictionOccurred, true);
  assert.equal(third.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  assert.equal(buf.size, 2);
  assert.equal(buf.minSequenceIndex, 1);
  assert.equal(buf.getBySequenceIndex(0), undefined);

  // Client that already saw 0 can still resume losslessly from 0 → [1,2].
  const fromSeen = buf.framesAfter(0);
  assert.equal(fromSeen.ok, true);
  assert.deepEqual(
    fromSeen.frames.map((f) => f.sequenceIndex),
    [1, 2],
  );

  // Cold resume (lastSeen=-1) cannot recreate evicted 0 → GAP + resync.
  const gap = buf.framesAfter(-1);
  assert.equal(gap.ok, false);
  assert.equal(gap.failureClass, "gap");
  assert.equal(gap.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  emit({
    event: "runtime.harness.buffer",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: null,
    failureClass: "gap",
    advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    phase: "eviction",
  });
});

test("sovereignty: cross-subject frame rejected at buffer boundary", () => {
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-buf-01",
    deviceId: "edge-aaaa",
  });
  const bad = buf.append(answerFrame(0, "other-subject"));
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "cross_subject");
  assert.equal(buf.size, 0);
  emit({
    event: "runtime.harness.buffer",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    failureClass: "cross_subject",
  });
});

test("host wires buffer: emit fills sequenceIndex index", () => {
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-buf-host",
    retentionWindow: 32,
  });
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-buf-host",
    deviceId: "edge-aaaa",
    frameBuffer: buf,
  });
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  assert.equal(host.emitAnswerDelta("hello").ok, true);
  assert.equal(host.emitTurnComplete("turn-1").ok, true);
  assert.equal(buf.size, 3);
  assert.equal(buf.maxSequenceIndex, 2);
  const replay = buf.framesAfter(-1);
  assert.equal(replay.ok, true);
  assert.equal(replay.frames.length, 3);
  assert.equal(host.buffer, buf);
});

test("scalability: retention clamped; at-tip replay is empty", () => {
  assert.throws(
    () =>
      new InMemoryStreamFrameBuffer({
        subjectId: "anika-k",
        streamId: "x",
        retentionWindow: 0,
      }),
    /retentionWindow/,
  );
  assert.throws(
    () =>
      new InMemoryStreamFrameBuffer({
        subjectId: "anika-k",
        streamId: "x",
        retentionWindow: 9999,
      }),
    /retentionWindow/,
  );
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-buf-01",
    retentionWindow: 4,
  });
  for (let i = 0; i < 4; i++) {
    assert.equal(
      buf.append(i === 0 ? sessionFrame(0) : answerFrame(i)).ok,
      true,
    );
  }
  const tip = buf.framesAfter(3);
  assert.equal(tip.ok, true);
  assert.equal(tip.frames.length, 0);
});
