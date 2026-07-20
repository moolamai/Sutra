/**
 * Last-Event-ID resume and SEQUENCE_GAP detection.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryStreamFrameBuffer,
  STREAM_BUFFER_RESYNC_ADVISORY,
  STREAM_RESUME_GAP_CODE,
  StreamingTurnHost,
  buildSequenceGapFrame,
  harnessFrameSchema,
  parseLastEventId,
  resolveStreamResume,
} from "../dist/index.js";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function seedHostWithBuffer() {
  const telemetry = [];
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-resume-01",
    deviceId: "edge-bbbb",
    retentionWindow: 32,
  });
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-resume-01",
    deviceId: "edge-bbbb",
    frameBuffer: buf,
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  assert.equal(host.emitAnswerDelta("hello").ok, true);
  assert.equal(host.emitAnswerDelta(" world").ok, true);
  assert.equal(host.emitTurnComplete("turn-resume-1").ok, true);
  return { host, buf, telemetry };
}

test("happy path: Last-Event-ID resumes from N+1 losslessly", () => {
  const { host, telemetry } = seedHostWithBuffer();
  const parsed = parseLastEventId("1");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, "present");
  assert.equal(parsed.lastSeenSequenceIndex, 1);

  const resume = host.resumeFromLastEventId("1");
  assert.equal(resume.ok, true);
  assert.equal(resume.action, "replay");
  assert.equal(resume.attach, true);
  assert.deepEqual(
    resume.frames.map((f) => f.sequenceIndex),
    [2, 3],
  );
  assert.equal(resume.frames[0].type, "ANSWER_DELTA");
  assert.equal(resume.frames[1].type, "TURN_COMPLETE");

  const resumeEvents = telemetry.filter(
    (e) => e.event === "runtime.harness.resume",
  );
  assert.equal(resumeEvents.length, 1);
  assert.equal(resumeEvents[0].outcome, "ok");
  assert.equal(resumeEvents[0].action, "replay");
  assert.equal(resumeEvents[0].replayCount, 2);
  assert.equal(resumeEvents[0].subjectId, "anika-k");
  emit({
    case: "resume_happy",
    outcome: "ok",
    replayCount: resume.frames.length,
  });
});

test("edge: never-issued Last-Event-ID → SEQUENCE_GAP + RESYNC_REQUIRED", () => {
  const { host } = seedHostWithBuffer();
  const resume = host.resumeFromLastEventId("99");
  assert.equal(resume.ok, false);
  assert.equal(resume.action, "gap");
  assert.equal(resume.failureClass, "gap");
  assert.equal(resume.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  assert.equal(resume.gapFrame.type, "HARNESS_ERROR");
  assert.equal(resume.gapFrame.code, STREAM_RESUME_GAP_CODE);
  assert.equal(resume.gapFrame.recoverable, false);
  assert.match(resume.gapFrame.message, /RESYNC_REQUIRED/);
  assert.equal(harnessFrameSchema.safeParse(resume.gapFrame).success, true);
  emit({ case: "resume_never_issued", outcome: "gap" });
});

test("edge: empty buffer (server restart) → GAP + full resync advisory", () => {
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-empty",
  });
  const resume = resolveStreamResume({
    lastEventIdHeader: "2",
    buffer: buf,
    subjectId: "anika-k",
    streamId: "corr-empty",
  });
  assert.equal(resume.ok, false);
  assert.equal(resume.action, "gap");
  assert.equal(resume.failureClass, "empty_buffer");
  assert.equal(resume.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  assert.equal(resume.gapFrame.code, STREAM_RESUME_GAP_CODE);
  emit({ case: "resume_empty_buffer", outcome: "gap" });
});

test("edge: duplicate Last-Event-ID is idempotent (empty at tip)", () => {
  const { host } = seedHostWithBuffer();
  const first = host.resumeFromLastEventId("3");
  const second = host.resumeFromLastEventId("3");
  assert.equal(first.ok, true);
  assert.equal(first.action, "replay");
  assert.equal(first.frames.length, 0);
  assert.deepEqual(second.frames, first.frames);
  emit({ case: "resume_idempotent_tip", outcome: "ok" });
});

test("edge: invalid Last-Event-ID → GAP (not silent stall)", () => {
  const bad = parseLastEventId("1.5");
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "invalid_last_event_id");

  const resume = resolveStreamResume({
    lastEventIdHeader: "abc",
    buffer: null,
    subjectId: "anika-k",
    streamId: "corr-bad",
  });
  assert.equal(resume.ok, false);
  assert.equal(resume.action, "gap");
  assert.equal(resume.failureClass, "invalid_last_event_id");
  assert.equal(resume.gapFrame.code, STREAM_RESUME_GAP_CODE);
  emit({ case: "resume_invalid_header", outcome: "gap" });
});

test("edge: missing buffer on resume → GAP (full resync)", () => {
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-nobuf",
  });
  const resume = host.resumeFromLastEventId("0");
  assert.equal(resume.ok, false);
  assert.equal(resume.action, "gap");
  assert.equal(resume.failureClass, "missing_buffer");
  assert.equal(resume.advisory, STREAM_BUFFER_RESYNC_ADVISORY);
  emit({ case: "resume_missing_buffer", outcome: "gap" });
});

test("sovereignty: cross-subject buffer attach is rejected", () => {
  const buf = new InMemoryStreamFrameBuffer({
    subjectId: "anika-k",
    streamId: "corr-x",
  });
  buf.append({
    type: "SESSION_START",
    sequenceIndex: 0,
    correlationId: "corr-x",
    subjectId: "anika-k",
    protocolVersion: "1.0.0",
    pinnedAt: "2026-07-15T00:00:00.000Z",
  });
  const resume = resolveStreamResume({
    lastEventIdHeader: "0",
    buffer: buf,
    subjectId: "other-subject",
    streamId: "corr-x",
  });
  assert.equal(resume.ok, false);
  assert.equal(resume.action, "reject");
  assert.equal(resume.failureClass, "cross_subject");
  emit({ case: "resume_cross_subject", outcome: "rejected" });
});

test("absent Last-Event-ID → fresh open (no attach)", () => {
  const resume = resolveStreamResume({
    lastEventIdHeader: null,
    buffer: null,
    subjectId: "anika-k",
    streamId: "corr-fresh",
  });
  assert.equal(resume.ok, true);
  assert.equal(resume.action, "fresh");
  emit({ case: "resume_absent", outcome: "fresh" });
});

test("SEQUENCE_GAP frame round-trips harness schema", () => {
  const frame = buildSequenceGapFrame({
    subjectId: "anika-k",
    correlationId: "corr-gap",
    sequenceIndex: 6,
    detail: "sequenceIndex 6 evicted",
  });
  assert.equal(harnessFrameSchema.safeParse(frame).success, true);
  assert.equal(frame.code, "SEQUENCE_GAP");
  emit({ case: "gap_frame_schema", outcome: "ok" });
});
