/**
 * Correction cap escalation regression (CK-07):
 * seed model always returns an invalid tool call → exactly maxCorrectionTurns
 * repairs, then terminal HARNESS_ERROR / CORRECTION_EXHAUSTED.
 *
 * Fixture: fixtures/correction-cap-escalation/always-invalid-tool-call.json
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORRECTION_CAP_ESCALATION_FIXTURE_RELPATH,
  CORRECTION_EXHAUSTED_CODE,
  CORRECTION_RULE_ENVELOPE,
  StreamingTurnCorrectionLoop,
  StreamingTurnHost,
  ToolCallParser,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const FIXTURE_PATH = join(PACKAGE_ROOT, CORRECTION_CAP_ESCALATION_FIXTURE_RELPATH);

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function loadFixture() {
  const raw = readFileSync(FIXTURE_PATH, "utf8").replace(/\r\n/g, "\n");
  return JSON.parse(raw);
}

function openScopedTurn(fixture, correlationId) {
  const frames = [];
  const hostTelemetry = [];
  const host = new StreamingTurnHost({
    subjectId: fixture.subjectId,
    correlationId,
    deviceId: fixture.deviceId,
    onFrame: (f) => frames.push(f),
    onTelemetry: (e) => hostTelemetry.push(e),
  });
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  const parser = new ToolCallParser({
    subjectId: fixture.subjectId,
    deviceId: fixture.deviceId,
  });
  return { host, parser, frames, hostTelemetry };
}

/**
 * Seed model that always re-emits the same invalid tool fence (never repairs).
 * Host re-validates each resume as another envelope failure.
 */
function alwaysInvalidResumeModel(fixture, probes) {
  return async ({ systemError, depth }) => {
    probes.resumeCount += 1;
    probes.depthsSeen.push(depth);
    probes.systemErrors.push(systemError);
    assert.equal(systemError.role, "system");
    const body = JSON.parse(systemError.content);
    assert.equal(body.rule, fixture.failure.rule);
    assert.ok(
      !JSON.stringify(systemError).includes("at Object"),
      "seed path must not forward stack frames to the model",
    );
    return { chunks: [fixture.invalidToolChunk] };
  };
}

test("fixture: always-invalid-tool-call is wired for CK-07", () => {
  const fixture = loadFixture();
  assert.equal(fixture.specId, "CK-07");
  assert.equal(fixture.id, "always-invalid-tool-call");
  assert.match(fixture.protects, /CK-07/);
  assert.equal(fixture.failure.rule, CORRECTION_RULE_ENVELOPE);
  assert.equal(
    fixture.expected.exhaustedCode,
    CORRECTION_EXHAUSTED_CODE,
  );
  assert.equal(
    fixture.expected.correctionsAccepted,
    fixture.maxCorrectionTurns,
  );
  log({
    event: "runtime.harness.correction_cap_escalation",
    outcome: "ok",
    case: "fixture_meta",
    subjectId: fixture.subjectId,
    specId: fixture.specId,
  });
});

test("happy path: seed always-invalid → exactly MAX repairs then HARNESS_ERROR", async () => {
  const fixture = loadFixture();
  const { host, parser, frames } = openScopedTurn(
    fixture,
    fixture.correlationId,
  );
  const correctionTelemetry = [];
  const probes = { resumeCount: 0, depthsSeen: [], systemErrors: [] };

  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: fixture.turnId,
    config: { maxCorrectionTurns: fixture.maxCorrectionTurns },
    resumeModel: alwaysInvalidResumeModel(fixture, probes),
    onTelemetry: (e) => correctionTelemetry.push(e),
  });

  // Leave parser mid tool-buffer so each cycle must reset before re-feed.
  parser.feed("```tool_call\n");
  assert.equal(parser.currentMode, "tool_buffer");

  const accepted = [];
  for (let i = 1; i <= fixture.maxCorrectionTurns; i += 1) {
    const r = await loop.handleValidationFailure(fixture.failure, {
      subjectId: fixture.subjectId,
    });
    assert.equal(r.ok, true, `correction ${i} should be accepted`);
    assert.equal(r.action, "corrected");
    assert.equal(r.depth, i);
    assert.equal(r.parserReset, true);
    accepted.push(r);
  }

  assert.equal(accepted.length, fixture.expected.correctionsAccepted);
  assert.equal(probes.resumeCount, fixture.maxCorrectionTurns);
  assert.deepEqual(
    probes.depthsSeen,
    Array.from({ length: fixture.maxCorrectionTurns }, (_, i) => i + 1),
  );
  assert.equal(loop.exhausted, true);
  assert.equal(loop.currentDepth, fixture.maxCorrectionTurns);

  const exhausted = await loop.handleValidationFailure(fixture.failure, {
    subjectId: fixture.subjectId,
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.action, "exhausted");
  assert.equal(exhausted.failureClass, "correction_exhausted");
  assert.equal(exhausted.harnessError.code, fixture.expected.exhaustedCode);
  assert.equal(exhausted.harnessError.recoverable, fixture.expected.recoverable);
  assert.equal(exhausted.terminated, true);
  assert.equal(host.isTerminated, true);

  // No further model resume after cap.
  assert.equal(probes.resumeCount, fixture.maxCorrectionTurns);

  const terminals = frames.filter((f) => f.type === "HARNESS_ERROR");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, fixture.expected.terminalFrame);
  assert.equal(terminals[0].code, CORRECTION_EXHAUSTED_CODE);
  assert.equal(terminals[0].recoverable, false);
  assert.equal(terminals[0].subjectId, fixture.subjectId);

  // Observability: corrected per depth, then exhausted — metadata only.
  const corrected = correctionTelemetry.filter((e) => e.outcome === "corrected");
  const exhaustedTel = correctionTelemetry.filter(
    (e) => e.outcome === "exhausted",
  );
  assert.equal(corrected.length, fixture.maxCorrectionTurns);
  assert.equal(exhaustedTel.length, 1);
  for (const ev of correctionTelemetry) {
    assert.equal(ev.subjectId, fixture.subjectId);
    assert.equal(ev.deviceId, fixture.deviceId);
    assert.ok(!JSON.stringify(ev).includes("not-json"));
    assert.ok(!JSON.stringify(ev).includes("at Object"));
  }
  log({
    event: "runtime.harness.correction_cap_escalation",
    outcome: "ok",
    case: "exactly_max_then_harness_error",
    subjectId: fixture.subjectId,
    deviceId: fixture.deviceId,
    correctionsAccepted: accepted.length,
    resumes: probes.resumeCount,
  });
});

test("edge: identical invalid call after each correction still counts toward cap", async () => {
  const fixture = loadFixture();
  const { host, parser } = openScopedTurn(fixture, "corr-cap-esc-rep");
  const probes = { resumeCount: 0, depthsSeen: [], systemErrors: [] };
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-rep",
    config: { maxCorrectionTurns: fixture.maxCorrectionTurns },
    resumeModel: alwaysInvalidResumeModel(fixture, probes),
  });

  for (let i = 0; i < fixture.maxCorrectionTurns; i += 1) {
    const r = await loop.handleValidationFailure(fixture.failure);
    assert.equal(r.ok, true);
    if (i > 0) assert.equal(r.repeatedFailure, true);
  }
  const exhausted = await loop.handleValidationFailure(fixture.failure);
  assert.equal(exhausted.action, "exhausted");
  assert.equal(loop.currentDepth, fixture.maxCorrectionTurns);
});

test("edge: mid-stream cap → correction_exhausted HARNESS_ERROR surface", async () => {
  const fixture = loadFixture();
  const { host, parser, frames } = openScopedTurn(fixture, "corr-cap-esc-mid");
  const probes = { resumeCount: 0, depthsSeen: [], systemErrors: [] };
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-mid",
    config: { maxCorrectionTurns: 2 },
    resumeModel: alwaysInvalidResumeModel(fixture, probes),
  });

  assert.equal((await loop.handleValidationFailure(fixture.failure)).ok, true);
  assert.equal((await loop.handleValidationFailure(fixture.failure)).ok, true);
  const exhausted = await loop.handleValidationFailure(fixture.failure);
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.harnessError.code, CORRECTION_EXHAUSTED_CODE);
  const err = frames.find((f) => f.type === "HARNESS_ERROR");
  assert.ok(err, "advisory/error surface must include terminal HARNESS_ERROR");
  assert.equal(err.code, CORRECTION_EXHAUSTED_CODE);
  assert.equal(err.message.includes("exhausted"), true);
});

test("edge: concurrent turns same subjectId do not share correction depth", async () => {
  const fixture = loadFixture();
  const a = openScopedTurn(fixture, "corr-cap-esc-a");
  const b = openScopedTurn(fixture, "corr-cap-esc-b");
  const probesA = { resumeCount: 0, depthsSeen: [], systemErrors: [] };
  const probesB = { resumeCount: 0, depthsSeen: [], systemErrors: [] };

  const loopA = new StreamingTurnCorrectionLoop({
    host: a.host,
    parser: a.parser,
    turnId: "turn-a",
    config: { maxCorrectionTurns: 2 },
    resumeModel: alwaysInvalidResumeModel(fixture, probesA),
  });
  const loopB = new StreamingTurnCorrectionLoop({
    host: b.host,
    parser: b.parser,
    turnId: "turn-b",
    config: { maxCorrectionTurns: 2 },
    resumeModel: alwaysInvalidResumeModel(fixture, probesB),
  });

  assert.equal((await loopA.handleValidationFailure(fixture.failure)).ok, true);
  assert.equal((await loopB.handleValidationFailure(fixture.failure)).ok, true);
  assert.equal(loopA.currentDepth, 1);
  assert.equal(loopB.currentDepth, 1);

  assert.equal((await loopA.handleValidationFailure(fixture.failure)).ok, true);
  assert.equal(loopA.exhausted, true);
  assert.equal(loopB.exhausted, false);
  assert.equal(loopB.currentDepth, 1);
});

test("edge: duplicated exhaustion with same idempotency key is not double-applied", async () => {
  const fixture = loadFixture();
  const { host, parser, frames } = openScopedTurn(fixture, "corr-cap-esc-idemp");
  const probes = { resumeCount: 0, depthsSeen: [], systemErrors: [] };
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-idemp",
    config: { maxCorrectionTurns: 1 },
    resumeModel: alwaysInvalidResumeModel(fixture, probes),
  });

  assert.equal((await loop.handleValidationFailure(fixture.failure)).ok, true);
  const e1 = await loop.handleValidationFailure(fixture.failure, {
    idempotencyKey: "cap-hit",
  });
  const e2 = await loop.handleValidationFailure(fixture.failure, {
    idempotencyKey: "cap-hit",
  });
  assert.equal(e1.action, "exhausted");
  assert.equal(e2.action, "exhausted");
  assert.equal(frames.filter((f) => f.type === "HARNESS_ERROR").length, 1);
  assert.equal(probes.resumeCount, 1);
});

test("sovereignty: cross-subject seed cycle is rejected without consuming cap", async () => {
  const fixture = loadFixture();
  const { host, parser, frames } = openScopedTurn(fixture, "corr-cap-esc-iso");
  let resumes = 0;
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-iso",
    config: { maxCorrectionTurns: fixture.maxCorrectionTurns },
    resumeModel: async () => {
      resumes += 1;
      return { chunks: [fixture.invalidToolChunk] };
    },
  });

  const r = await loop.handleValidationFailure(fixture.failure, {
    subjectId: "other-learner",
  });
  assert.equal(r.ok, false);
  assert.equal(r.failureClass, "cross_subject");
  assert.equal(loop.currentDepth, 0);
  assert.equal(resumes, 0);
  assert.ok(!frames.some((f) => f.type === "HARNESS_ERROR"));
});

test("scalability: always-invalid seed cannot exceed configured maxCorrectionTurns", async () => {
  const fixture = loadFixture();
  const { host, parser } = openScopedTurn(fixture, "corr-cap-esc-bound");
  const probes = { resumeCount: 0, depthsSeen: [], systemErrors: [] };
  const max = fixture.maxCorrectionTurns;
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-bound",
    config: { maxCorrectionTurns: max },
    resumeModel: alwaysInvalidResumeModel(fixture, probes),
  });

  for (let i = 0; i < max + 50; i += 1) {
    await loop.handleValidationFailure(fixture.failure);
  }
  assert.equal(loop.currentDepth, max);
  assert.equal(probes.resumeCount, max);
  assert.equal(host.isTerminated, true);
});
