/**
 * StreamingTurnHost scaffold — package wiring + A P6 frame contract surface.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  A_P6_HARNESS_FRAME_SCHEMA_PATH,
  HARNESS_FRAME_TYPES,
  STREAMING_TURN_MAX_FRAMES,
  StreamingTurnHost,
  harnessFrameSchema,
  parseHarnessFrame,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: package exports host + A P6 frame schema path exists", () => {
  assert.equal(
    A_P6_HARNESS_FRAME_SCHEMA_PATH,
    "packages/sync-protocol/schemas/HarnessFrame.json",
  );
  const schemaPath = join(REPO_ROOT, A_P6_HARNESS_FRAME_SCHEMA_PATH);
  assert.ok(existsSync(schemaPath), "committed HarnessFrame.json missing");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.equal(schema.title, "HarnessFrame");
  assert.ok(Array.isArray(HARNESS_FRAME_TYPES));
  assert.ok(HARNESS_FRAME_TYPES.includes("SESSION_START"));
  assert.ok(HARNESS_FRAME_TYPES.includes("HARNESS_ERROR"));
  emit({
    event: "runtime.harness.scaffold",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    phase: "schema-path",
  });
});

test("happy path: SESSION_START → ANSWER → TURN_COMPLETE round-trips schema", () => {
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-rh-01",
    deviceId: "edge-aaaa",
  });
  const start = host.createSessionStart("2026-07-15T00:00:00.000Z");
  assert.equal(start.sequenceIndex, 0);
  assert.equal(host.appendValidated(start).ok, true);

  const answer = {
    type: "ANSWER_DELTA",
    sequenceIndex: 1,
    correlationId: "corr-rh-01",
    subjectId: "anika-k",
    delta: "A ratio compares quantities.",
  };
  assert.equal(harnessFrameSchema.parse(answer).type, "ANSWER_DELTA");
  assert.equal(host.appendValidated(answer).ok, true);

  const done = {
    type: "TURN_COMPLETE",
    sequenceIndex: 2,
    correlationId: "corr-rh-01",
    subjectId: "anika-k",
    turnId: "turn-rh-01",
  };
  assert.equal(host.appendValidated(done).ok, true);
  assert.equal(host.isTerminated, true);
  assert.equal(host.assertMonotonic().ok, true);
  assert.equal(host.assertTerminalPresent().ok, true);
  emit({
    event: "runtime.harness.scaffold",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    phase: "round-trip",
    frameCount: host.sequenceLength,
  });
});

test("edge: truncated stream scaffold requires HARNESS_ERROR terminal", () => {
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-rh-02",
    deviceId: "edge-aaaa",
  });
  assert.equal(
    host.appendValidated(host.createSessionStart("2026-07-15T00:00:00.000Z")).ok,
    true,
  );
  const missing = host.assertTerminalPresent();
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_terminal");

  const errFrame = {
    type: "HARNESS_ERROR",
    sequenceIndex: 1,
    correlationId: "corr-rh-02",
    subjectId: "anika-k",
    code: "STREAM_TRUNCATED",
    message: "peer closed before TURN_COMPLETE",
    recoverable: true,
  };
  assert.equal(host.appendValidated(errFrame).ok, true);
  assert.equal(host.assertTerminalPresent().ok, true);
  emit({
    event: "runtime.harness.scaffold",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    phase: "terminal-error",
    failureClass: "missing_terminal",
  });
});

test("edge: duplicate sequenceIndex is a protocol defect", () => {
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-rh-03",
    deviceId: "edge-aaaa",
  });
  assert.equal(
    host.appendValidated(host.createSessionStart("2026-07-15T00:00:00.000Z")).ok,
    true,
  );
  const dup = host.appendValidated({
    type: "ANSWER_DELTA",
    sequenceIndex: 0,
    correlationId: "corr-rh-03",
    subjectId: "anika-k",
    delta: "dup",
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.failureClass, "duplicate_sequence");
  emit({
    event: "runtime.harness.scaffold",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    failureClass: dup.failureClass,
  });
});

test("sovereignty: cross-subject frame is rejected at validate boundary", () => {
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-rh-04",
    deviceId: "edge-aaaa",
  });
  const result = host.validateForWire({
    type: "ANSWER_DELTA",
    sequenceIndex: 0,
    correlationId: "corr-rh-04",
    subjectId: "other-subject",
    delta: "leak",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "cross_subject");
  const parsed = parseHarnessFrame({
    type: "ANSWER_DELTA",
    sequenceIndex: 0,
    correlationId: "corr-rh-04",
    subjectId: "other-subject",
    delta: "leak",
  });
  assert.equal(parsed.outcome, "accepted");
  assert.notEqual(parsed.subjectId, host.subjectId);
  emit({
    event: "runtime.harness.scaffold",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    failureClass: "cross_subject",
  });
});

test("scalability: host enforces STREAMING_TURN_MAX_FRAMES budget", () => {
  assert.ok(STREAMING_TURN_MAX_FRAMES <= 256);
  assert.ok(STREAMING_TURN_MAX_FRAMES >= 8);
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-rh-05",
  });
  // Append SESSION_START + ANSWER frames until one below terminal; then budget.
  assert.equal(
    host.appendValidated(
      host.createSessionStart("2026-07-15T00:00:00.000Z"),
    ).ok,
    true,
  );
  for (let i = 1; i < STREAMING_TURN_MAX_FRAMES; i++) {
    const r = host.appendValidated({
      type: "ANSWER_DELTA",
      sequenceIndex: i,
      correlationId: "corr-rh-05",
      subjectId: "anika-k",
      delta: "x",
    });
    assert.equal(r.ok, true, `seq ${i}`);
  }
  const over = host.appendValidated({
    type: "ANSWER_DELTA",
    sequenceIndex: STREAMING_TURN_MAX_FRAMES,
    correlationId: "corr-rh-05",
    subjectId: "anika-k",
    delta: "overflow",
  });
  assert.equal(over.ok, false);
  assert.equal(over.failureClass, "stream_budget_exceeded");
  emit({
    event: "runtime.harness.scaffold",
    outcome: "rejected",
    subjectId: "anika-k",
    deviceId: null,
    failureClass: over.failureClass,
    frameCount: host.sequenceLength,
  });
});

test("edge: empty subjectId rejected at construction", () => {
  assert.throws(
    () =>
      new StreamingTurnHost({
        subjectId: "",
        correlationId: "corr-x",
      }),
    /subjectId/,
  );
});
