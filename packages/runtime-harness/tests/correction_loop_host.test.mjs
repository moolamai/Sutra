/**
 * StreamingTurnCorrectionLoop — host + parser + model resume integration.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CORRECTION_EXHAUSTED_CODE,
  CORRECTION_RULE_ENVELOPE,
  MAX_CORRECTION_TURNS,
  StreamingTurnCorrectionLoop,
  StreamingTurnHost,
  ToolCallParser,
  resolveMaxCorrectionTurns,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const envelopeFailure = {
  kind: "envelope_invalid",
  rule: CORRECTION_RULE_ENVELOPE,
  code: "INVALID_JSON",
  toolCallId: "c1",
  message: "tool call JSON is not valid",
  requiresParserReset: true,
};

function openHost(opts = {}) {
  const frames = [];
  const telemetry = [];
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: opts.correlationId ?? "corr-corrloop-002",
    deviceId: "edge-aaaa",
    onFrame: (f) => frames.push(f),
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);
  return { host, frames, telemetry };
}

test("resolveMaxCorrectionTurns wires config override", () => {
  assert.equal(resolveMaxCorrectionTurns(), MAX_CORRECTION_TURNS);
  assert.equal(resolveMaxCorrectionTurns({ maxCorrectionTurns: 3 }), 3);
  assert.throws(() => resolveMaxCorrectionTurns({ maxCorrectionTurns: 0 }));
});

test("happy path: invalid tool call corrected within cap via host resume", async () => {
  const correctionTelemetry = [];
  const { host, frames } = openHost();
  const parser = new ToolCallParser({ subjectId: "anika-k", deviceId: "edge-aaaa" });

  // Leave parser in tool_buffer so reset-to-safe-mode is exercised.
  parser.feed("```tool_call\n");
  assert.equal(parser.currentMode, "tool_buffer");

  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-ok",
    config: { maxCorrectionTurns: 3 },
    resumeModel: async ({ systemError, depth }) => {
      assert.equal(systemError.role, "system");
      const body = JSON.parse(systemError.content);
      assert.equal(body.rule, CORRECTION_RULE_ENVELOPE);
      assert.equal(body.depth, depth);
      assert.ok(!systemError.content.includes("at Object"));
      return { chunks: ["Corrected after repair."] };
    },
    onTelemetry: (e) => correctionTelemetry.push(e),
  });

  const result = await loop.handleValidationFailure(envelopeFailure, {
    subjectId: "anika-k",
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "corrected");
  assert.equal(result.depth, 1);
  assert.equal(result.parserReset, true);
  assert.equal(parser.currentMode, "answer");
  assert.ok(result.framesEmitted >= 1);

  const types = frames.map((f) => f.type);
  assert.ok(types.includes("TOOL_STATUS"));
  assert.ok(types.includes("ANSWER_DELTA"));
  const toolErr = frames.find(
    (f) => f.type === "TOOL_STATUS" && f.status === "error",
  );
  assert.equal(toolErr?.toolCallId, "c1");
  assert.equal(toolErr?.detail, CORRECTION_RULE_ENVELOPE);

  assert.equal(correctionTelemetry[0]?.outcome, "corrected");
  assert.equal(correctionTelemetry[0]?.subjectId, "anika-k");
  assert.equal(correctionTelemetry[0]?.deviceId, "edge-aaaa");
  log({ ok: true, case: "within_cap_host", depth: result.depth });
});

test("edge: cap breach mid-stream terminates with CORRECTION_EXHAUSTED", async () => {
  const { host, frames } = openHost({ correlationId: "corr-cap" });
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  let resumes = 0;
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-cap",
    config: { maxCorrectionTurns: 2 },
    resumeModel: async () => {
      resumes += 1;
      return { chunks: [`attempt-${resumes}`] };
    },
  });

  assert.equal((await loop.handleValidationFailure(envelopeFailure)).ok, true);
  assert.equal((await loop.handleValidationFailure(envelopeFailure)).ok, true);
  assert.equal(loop.exhausted, true);

  const exhausted = await loop.handleValidationFailure(envelopeFailure);
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.action, "exhausted");
  assert.equal(exhausted.harnessError.code, CORRECTION_EXHAUSTED_CODE);
  assert.equal(exhausted.terminated, true);
  assert.equal(host.isTerminated, true);

  const err = frames.find((f) => f.type === "HARNESS_ERROR");
  assert.equal(err?.code, CORRECTION_EXHAUSTED_CODE);
  assert.equal(err?.recoverable, false);
  assert.equal(resumes, 2);
  log({ ok: true, case: "cap_breach_host", resumes });
});

test("edge: identical invalid call after correction still counts toward cap", async () => {
  const { host } = openHost({ correlationId: "corr-rep" });
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-rep",
    config: { maxCorrectionTurns: 3 },
    resumeModel: async () => ({ chunks: ["ok"] }),
  });
  const a = await loop.handleValidationFailure(envelopeFailure);
  const b = await loop.handleValidationFailure(envelopeFailure);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.repeatedFailure, true);
  assert.equal(loop.currentDepth, 2);
});

test("edge: correction during tool-buffer resets parser before re-feed", async () => {
  const { host } = openHost({ correlationId: "corr-buf" });
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  parser.feed("```tool_call\n{\"toolName\":");
  assert.equal(parser.currentMode, "tool_buffer");

  let modeAtResume = null;
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-buf",
    config: { maxCorrectionTurns: 4 },
    resumeModel: async () => {
      modeAtResume = parser.currentMode;
      return { chunks: ["safe answer"] };
    },
  });

  const r = await loop.handleValidationFailure({
    ...envelopeFailure,
    requiresParserReset: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.parserReset, true);
  assert.equal(modeAtResume, "answer");
  assert.equal(parser.currentMode, "answer");
});

test("sovereignty: cross-subject validation failure is rejected", async () => {
  const { host, frames } = openHost({ correlationId: "corr-iso" });
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-iso",
    resumeModel: async () => ({ chunks: ["should-not-run"] }),
  });

  const r = await loop.handleValidationFailure(envelopeFailure, {
    subjectId: "other-learner",
  });
  assert.equal(r.ok, false);
  assert.equal(r.failureClass, "cross_subject");
  assert.equal(loop.currentDepth, 0);
  assert.ok(!frames.some((f) => f.type === "ANSWER_DELTA"));
});

test("edge: duplicated failure with same idempotency key is not double-applied", async () => {
  const { host } = openHost({ correlationId: "corr-idemp" });
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  let resumes = 0;
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-idemp",
    config: { maxCorrectionTurns: 4 },
    resumeModel: async () => {
      resumes += 1;
      return { chunks: ["once"] };
    },
  });

  const a = await loop.handleValidationFailure(envelopeFailure, {
    idempotencyKey: "fail-1",
  });
  const b = await loop.handleValidationFailure(envelopeFailure, {
    idempotencyKey: "fail-1",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(resumes, 1);
  assert.equal(loop.currentDepth, 1);
});

test("scalability: config cap bounds correction cycles", async () => {
  const { host } = openHost({ correlationId: "corr-bound" });
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  const max = 3;
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-bound",
    config: { maxCorrectionTurns: max },
    resumeModel: async () => ({ chunks: ["x"] }),
  });
  for (let i = 0; i < max + 10; i += 1) {
    await loop.handleValidationFailure(envelopeFailure);
  }
  assert.equal(loop.currentDepth, max);
  assert.equal(host.isTerminated, true);
});

test("downstream resume throw → typed MODEL_RESUME_FAILED, not unhandled", async () => {
  const { host, frames } = openHost({ correlationId: "corr-resume" });
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  const loop = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId: "turn-resume",
    resumeModel: async () => {
      throw new Error("provider timeout");
    },
  });
  const r = await loop.handleValidationFailure(envelopeFailure);
  assert.equal(r.ok, false);
  assert.equal(r.failureClass, "model_resume_failed");
  const err = frames.find((f) => f.type === "HARNESS_ERROR");
  assert.equal(err?.code, "MODEL_RESUME_FAILED");
});
