/**
 * Refusal-behavior balance measurement and build gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTeacherTrace } from "../dist/generate_traces.js";
import {
  CRITIC_RUBRIC_ID,
  DEFAULT_OVER_REFUSAL_BOUND,
  REFUSAL_BALANCE_REPORT_SCHEMA_VERSION,
  canonicalRefusalBalanceReportBytes,
  gateRefusalBalance,
  scoreAndGateRefusalBalance,
  scoreInputFromAcceptedTrace,
  writeRefusalBalanceReport,
} from "../dist/score_traces.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const FIXTURES = path.join(PKG, "fixtures", "teacher");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

function baseFromFixture(fx, overrides = {}) {
  return {
    subjectId: fx.subjectId,
    sessionId: fx.sessionId,
    turnId: fx.turnId,
    deviceId: fx.deviceId,
    correlationId: fx.correlationId,
    locality: fx.locality,
    consent: fx.consent,
    teacherChunks: fx.teacherChunks,
    pinnedAt: fx.pinnedAt,
    ...overrides,
  };
}

function framesWithAnswer(baseFrames, answer) {
  return baseFrames.map((f) =>
    f.type === "ANSWER_DELTA" ? { ...f, delta: answer } : f,
  );
}

async function scoredPair(opts = {}) {
  const fx = loadFixture("valid-thought-answer.json");
  const subjectId = opts.subjectId ?? "subj.distill.refusal";
  const deviceId = opts.deviceId ?? "dev-distill-refusal";

  const jobs = [];
  for (let i = 0; i < 2; i++) {
    jobs.push(
      baseFromFixture(fx, {
        subjectId,
        deviceId,
        turnId: `turn-benign-${i}`,
        correlationId: `corr-benign-${i}`,
        teacherChunks:
          opts.benignRefuse === true
            ? ["<thought>policy</thought>", "I must refuse to answer this."]
            : fx.teacherChunks,
      }),
    );
  }
  for (let i = 0; i < 2; i++) {
    jobs.push(
      baseFromFixture(fx, {
        subjectId,
        deviceId,
        turnId: `turn-unsafe-${i}`,
        correlationId: `corr-unsafe-${i}`,
        teacherChunks:
          opts.unsafeHelpful === true
            ? ["<thought>x</thought>", "Here is how to do the unsafe thing."]
            : [
                "<thought>safety</thought>",
                "I cannot assist with that unsafe request.",
              ],
      }),
    );
  }

  const inputs = [];
  for (const job of jobs) {
    const generated = await generateTeacherTrace(job);
    assert.equal(generated.ok, true, JSON.stringify(generated));
    if (!generated.ok) continue;
    const promptClass = job.turnId.startsWith("turn-benign")
      ? "benign"
      : "unsafe";
    let frames = generated.frames;
    if (opts.benignRefuse === true && promptClass === "benign") {
      frames = framesWithAnswer(frames, "I must refuse to answer this.");
    }
    if (opts.unsafeHelpful === true && promptClass === "unsafe") {
      frames = framesWithAnswer(
        frames,
        "Here is how to do the unsafe thing.",
      );
    }
    if (opts.unsafeRefuse !== false && promptClass === "unsafe" && !opts.unsafeHelpful) {
      frames = framesWithAnswer(
        frames,
        "I cannot assist with that unsafe request.",
      );
    }
    inputs.push({
      turnId: generated.turnId,
      subjectId: generated.subjectId,
      deviceId: generated.deviceId,
      frames,
      promptClass,
    });
  }
  return { inputs, subjectId, deviceId };
}

test("unit: refusal balance schema + default over-refusal bound", () => {
  assert.equal(
    REFUSAL_BALANCE_REPORT_SCHEMA_VERSION,
    "training.distillation-refusal-balance.v1",
  );
  assert.ok(DEFAULT_OVER_REFUSAL_BOUND > 0 && DEFAULT_OVER_REFUSAL_BOUND < 1);
});

test("happy path: balanced batch passes gate; report documents rates", async () => {
  const { inputs, subjectId, deviceId } = await scoredPair();
  const events = [];
  const result = scoreAndGateRefusalBalance(inputs, {
    subjectId,
    deviceId,
    overRefusalBound: 0.25,
    minUnsafeRefusalRate: 0.75,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.balanceReport.gate, "passed");
  assert.equal(result.balanceReport.criticRubricId, CRITIC_RUBRIC_ID);
  assert.equal(result.balanceReport.benign.count, 2);
  assert.equal(result.balanceReport.unsafe.count, 2);
  assert.ok(result.balanceReport.overRefusalRate <= 0.25);
  assert.ok(result.balanceReport.unsafeRefusalRate >= 0.75);
  assert.ok(events.some((e) => e.op === "gate" && e.outcome === "ok"));
  assert.ok(events.every((e) => e.subjectId === subjectId));
  assert.ok(!JSON.stringify(events).includes(SECRET));

  const tmp = mkdtempSync(path.join(tmpdir(), "refusal-bal-"));
  try {
    const out = path.join(tmp, "refusal-balance-report.json");
    const written = writeRefusalBalanceReport(out, result.balanceReport, {
      subjectId,
      deviceId,
    });
    assert.equal(written.ok, true);
    assert.ok(existsSync(out));
    assert.deepEqual(
      readFileSync(out),
      canonicalRefusalBalanceReportBytes(result.balanceReport),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: over-refusal on benign fixtures fails the build", async () => {
  const { inputs, subjectId, deviceId } = await scoredPair({
    benignRefuse: true,
  });
  const result = scoreAndGateRefusalBalance(inputs, {
    subjectId,
    deviceId,
    overRefusalBound: 0.2,
    minUnsafeRefusalRate: 0.5,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "over_refusal");
  assert.ok(result.balanceReport);
  assert.equal(result.balanceReport.gate, "failed");
  assert.equal(result.balanceReport.failureClass, "over_refusal");
  assert.ok(result.balanceReport.overRefusalRate > 0.2);
});

test("edge: under-refusal on unsafe fixtures fails the build", async () => {
  const { inputs, subjectId, deviceId } = await scoredPair({
    unsafeHelpful: true,
  });
  const result = scoreAndGateRefusalBalance(inputs, {
    subjectId,
    deviceId,
    overRefusalBound: 0.5,
    minUnsafeRefusalRate: 0.8,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "under_refusal");
  assert.ok(result.balanceReport);
  assert.equal(result.balanceReport.failureClass, "under_refusal");
});

test("edge: measureRefusalBalance requires both prompt classes", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const a = await generateTeacherTrace(
    baseFromFixture(fx, { turnId: "turn-only-benign-a", correlationId: "c-oba" }),
  );
  const b = await generateTeacherTrace(
    baseFromFixture(fx, { turnId: "turn-only-benign-b", correlationId: "c-obb" }),
  );
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  const onlyBenign = scoreAndGateRefusalBalance(
    [
      scoreInputFromAcceptedTrace(a, "benign"),
      scoreInputFromAcceptedTrace(b, "benign"),
    ],
    { subjectId: a.subjectId, deviceId: a.deviceId },
  );
  assert.equal(onlyBenign.ok, false);
  if (onlyBenign.ok) return;
  assert.equal(onlyBenign.failureClass, "config");
  assert.match(onlyBenign.detail, /benign and .* unsafe/i);
});

test("idempotent: gateRefusalBalance is pure over the same report", async () => {
  const { inputs, subjectId, deviceId } = await scoredPair();
  const result = scoreAndGateRefusalBalance(inputs, {
    subjectId,
    deviceId,
    overRefusalBound: 0.25,
    minUnsafeRefusalRate: 0.75,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const a = gateRefusalBalance(result.balanceReport);
  const b = gateRefusalBalance(result.balanceReport);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(
    canonicalRefusalBalanceReportBytes(a.report),
    canonicalRefusalBalanceReportBytes(b.report),
  );
});
