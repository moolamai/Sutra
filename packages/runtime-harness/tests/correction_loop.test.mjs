/**
 * Correction depth tracker + system-error formatter.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CORRECTION_EXHAUSTED_CODE,
  CORRECTION_RULE_ENVELOPE,
  CORRECTION_RULE_RESULT_SCHEMA,
  CorrectionDepthTracker,
  MAX_CORRECTION_TURNS,
  PROCESS_REWARD_ABS_CAP,
  PROCESS_REWARD_CORRECTION_FIXTURES_RELPATH,
  buildCorrectionCycleFeatures,
  formatCorrectionSystemError,
  snapshotCorrectionCycleFeatures,
} from "../dist/correction_loop.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const envelopeFailure = {
  kind: "envelope_invalid",
  rule: CORRECTION_RULE_ENVELOPE,
  code: "INVALID_JSON",
  issuePath: "arguments",
  message: "tool call JSON is not valid",
  requiresParserReset: true,
};

test("happy path: seeded invalid tool call corrected within cap", () => {
  const telemetry = [];
  const tracker = new CorrectionDepthTracker({
    subjectId: "anika-k",
    turnId: "turn-1",
    deviceId: "edge-aaaa",
    maxCorrectionTurns: 3,
    onTelemetry: (e) => telemetry.push(e),
  });

  const r1 = tracker.recordFailure(envelopeFailure, { subjectId: "anika-k" });
  assert.equal(r1.ok, true);
  assert.equal(r1.depth, 1);
  assert.equal(r1.remaining, 2);
  assert.equal(r1.systemError.role, "system");
  assert.equal(r1.systemError.requiresParserReset, true);

  const body = JSON.parse(r1.systemError.content);
  assert.equal(body.kind, "correction");
  assert.equal(body.rule, CORRECTION_RULE_ENVELOPE);
  assert.equal(body.depth, 1);
  assert.equal(body.maxDepth, 3);
  assert.equal(body.code, "INVALID_JSON");
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.length > 0);
  assert.equal(body.requiresParserReset, true);

  const r2 = tracker.recordFailure(
    {
      kind: "schema_mismatch",
      rule: CORRECTION_RULE_RESULT_SCHEMA,
      code: "SCHEMA_VIOLATION",
      issuePath: "result.score",
    },
    { subjectId: "anika-k" },
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.depth, 2);
  assert.equal(r2.repeatedFailure, false);

  assert.equal(telemetry.length, 2);
  assert.equal(telemetry[0].event, "runtime.harness.correction_loop");
  assert.equal(telemetry[0].outcome, "corrected");
  assert.equal(telemetry[0].subjectId, "anika-k");
  assert.equal(telemetry[0].deviceId, "edge-aaaa");
  assert.equal(telemetry[0].turnId, "turn-1");
  assert.equal(telemetry[0].depth, 1);
  log({ ok: true, case: "within_cap", depth: tracker.currentDepth });
});

test("edge: identical invalid call after correction still counts toward cap", () => {
  const tracker = new CorrectionDepthTracker({
    subjectId: "anika-k",
    turnId: "turn-rep",
    maxCorrectionTurns: 3,
  });
  const a = tracker.recordFailure(envelopeFailure);
  const b = tracker.recordFailure(envelopeFailure);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.repeatedFailure, true);
  assert.equal(b.depth, 2);
  assert.equal(tracker.remaining, 1);
});

test("edge: cap breach escalates with CORRECTION_EXHAUSTED harness error", () => {
  const telemetry = [];
  const tracker = new CorrectionDepthTracker({
    subjectId: "anika-k",
    turnId: "turn-cap",
    deviceId: "edge-bbbb",
    maxCorrectionTurns: 2,
    onTelemetry: (e) => telemetry.push(e),
  });

  assert.equal(tracker.recordFailure(envelopeFailure).ok, true);
  assert.equal(tracker.recordFailure(envelopeFailure).ok, true);
  assert.equal(tracker.currentDepth, 2);
  assert.equal(tracker.exhausted, true);

  const exhausted = tracker.recordFailure(envelopeFailure, {
    subjectId: "anika-k",
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.failureClass, "correction_exhausted");
  assert.equal(exhausted.harnessError?.code, CORRECTION_EXHAUSTED_CODE);
  assert.equal(exhausted.harnessError?.recoverable, false);
  assert.equal(exhausted.depth, 2);
  assert.match(exhausted.harnessError.message, /exhausted/i);

  const last = telemetry.at(-1);
  assert.equal(last.outcome, "exhausted");
  assert.equal(last.subjectId, "anika-k");
  assert.equal(last.deviceId, "edge-bbbb");
  assert.equal(last.failureClass, "correction_exhausted");
  log({ ok: true, case: "cap_breach", code: CORRECTION_EXHAUSTED_CODE });
});

test("edge: formatter never forwards stack traces to the model", () => {
  const formatted = formatCorrectionSystemError(
    {
      kind: "policy_denial",
      rule: "TOOL.POLICY",
      message:
        "denied\n    at Object.invoke (sandbox.ts:42:11)\n    at async run (host.ts:10:5)\nError: boom stack",
      requiresParserReset: true,
    },
    1,
    MAX_CORRECTION_TURNS,
  );
  assert.ok(!formatted.content.includes("at Object.invoke"));
  assert.ok(!/sandbox\.ts:\d+/.test(formatted.content));
  const body = JSON.parse(formatted.content);
  assert.ok(!/at\s+\w+/.test(body.message));
  assert.equal(body.rule, "TOOL.POLICY");
});

test("edge: tool-buffer correction requests parser reset", () => {
  const tracker = new CorrectionDepthTracker({
    subjectId: "anika-k",
    turnId: "turn-buf",
    maxCorrectionTurns: 4,
  });
  const r = tracker.recordFailure({
    kind: "envelope_invalid",
    rule: CORRECTION_RULE_ENVELOPE,
    requiresParserReset: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.systemError.requiresParserReset, true);
  const body = JSON.parse(r.systemError.content);
  assert.equal(body.requiresParserReset, true);
});

test("sovereignty: cross-subject recordFailure is rejected", () => {
  const telemetry = [];
  const tracker = new CorrectionDepthTracker({
    subjectId: "anika-k",
    turnId: "turn-iso",
    onTelemetry: (e) => telemetry.push(e),
  });
  const before = tracker.currentDepth;
  const r = tracker.recordFailure(envelopeFailure, {
    subjectId: "other-learner",
  });
  assert.equal(r.ok, false);
  assert.equal(r.failureClass, "cross_subject");
  assert.equal(tracker.currentDepth, before);
  assert.equal(telemetry.at(-1)?.failureClass, "cross_subject");
});

test("sovereignty: empty scope subjectId is rejected", () => {
  const tracker = new CorrectionDepthTracker({
    subjectId: "anika-k",
    turnId: "turn-miss",
  });
  const r = tracker.recordFailure(envelopeFailure, { subjectId: "  " });
  assert.equal(r.ok, false);
  assert.equal(r.failureClass, "missing_subject");
});

test("scalability: correction depth is hard-capped (no unbounded loop)", () => {
  const max = 5;
  const tracker = new CorrectionDepthTracker({
    subjectId: "anika-k",
    turnId: "turn-bound",
    maxCorrectionTurns: max,
  });
  for (let i = 0; i < max + 20; i += 1) {
    tracker.recordFailure(envelopeFailure);
  }
  assert.equal(tracker.currentDepth, max);
  assert.equal(tracker.exhausted, true);
  assert.ok(tracker.currentDepth <= max);
});

test("constructor requires subjectId and turnId", () => {
  assert.throws(
    () => new CorrectionDepthTracker({ subjectId: "", turnId: "t" }),
    /subjectId/,
  );
  assert.throws(
    () => new CorrectionDepthTracker({ subjectId: "s", turnId: "" }),
    /turnId/,
  );
});

test("process features: snapshot respects cap; synthetic retry loses first-pass", () => {
  const tracker = new CorrectionDepthTracker({
    subjectId: "anika-k",
    turnId: "turn-feat",
    deviceId: "edge-feat",
    maxCorrectionTurns: 2,
  });
  assert.equal(tracker.recordFailure(envelopeFailure).ok, true);
  assert.equal(tracker.recordFailure(envelopeFailure).ok, true);

  const capped = snapshotCorrectionCycleFeatures(tracker, {
    firstPassValidToolCall: true,
  });
  assert.equal(capped.cappedAtMax, true);
  assert.equal(capped.effectiveDepth, 2);
  assert.equal(capped.firstPassBonusEligible, false);
  assert.equal(capped.maxCorrectionTurns, 2);

  const synthetic = buildCorrectionCycleFeatures({
    subjectId: "anika-k",
    turnId: "turn-synth",
    correctionDepth: 0,
    maxCorrectionTurns: MAX_CORRECTION_TURNS,
    firstPassValidToolCall: true,
    syntheticRetryAfterExhaustion: true,
  });
  assert.equal(synthetic.firstPassValidToolCall, false);
  assert.equal(synthetic.firstPassBonusEligible, false);
  assert.equal(synthetic.syntheticRetryAfterExhaustion, true);
  assert.ok(Math.abs(PROCESS_REWARD_ABS_CAP) < 2.0);
  assert.equal(
    typeof PROCESS_REWARD_CORRECTION_FIXTURES_RELPATH,
    "string",
  );
  assert.ok(
    PROCESS_REWARD_CORRECTION_FIXTURES_RELPATH.includes("process-rewards"),
  );
});
