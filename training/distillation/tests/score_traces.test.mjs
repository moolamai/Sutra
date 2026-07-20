/**
 * Deterministic critic scoring for distillation traces.
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
  CRITIC_RUBRIC_PRIMITIVES,
  CRITIC_SCORE_MANIFEST_SCHEMA_VERSION,
  canonicalCriticScoreManifestBytes,
  detectRefusalDeterministic,
  scoreDistillationTrace,
  scoreDistillationTraces,
  scoreInputFromAcceptedTrace,
  writeCriticScoreManifest,
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
  return baseFrames.map((f) => {
    if (f.type === "ANSWER_DELTA") {
      return { ...f, delta: answer };
    }
    return f;
  });
}

test("unit: critic rubric id and primitives are versioned", () => {
  assert.equal(CRITIC_RUBRIC_ID, "training.distillation-critic-rubric.v1");
  assert.equal(
    CRITIC_SCORE_MANIFEST_SCHEMA_VERSION,
    "training.distillation-score-manifest.v1",
  );
  assert.equal(CRITIC_RUBRIC_PRIMITIVES.length, 5);
  assert.ok(CRITIC_RUBRIC_PRIMITIVES.includes("refusal_alignment"));
});

test("happy path: benign helpful trace passes threshold; rubric id on manifest", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const generated = await generateTeacherTrace(baseFromFixture(fx));
  assert.equal(generated.ok, true);
  if (!generated.ok) return;

  const events = [];
  const scored = scoreDistillationTrace(
    scoreInputFromAcceptedTrace(generated, "benign"),
    { onTelemetry: (e) => events.push(e) },
  );
  assert.equal(scored.ok, true, JSON.stringify(scored));
  if (!scored.ok) return;
  assert.equal(scored.value.criticRubricId, CRITIC_RUBRIC_ID);
  assert.equal(scored.value.passedThreshold, true);
  assert.equal(scored.value.primitives.schema_valid, 1);
  assert.equal(scored.value.primitives.refusal_alignment, 1);
  assert.ok(scored.value.score >= 0.6);

  const batch = scoreDistillationTraces(
    [scoreInputFromAcceptedTrace(generated, "benign")],
    {
      subjectId: fx.subjectId,
      deviceId: fx.deviceId,
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(batch.ok, true);
  if (!batch.ok) return;
  assert.equal(batch.manifest.criticRubricId, CRITIC_RUBRIC_ID);
  assert.equal(batch.accepted.length, 1);

  const tmp = mkdtempSync(path.join(tmpdir(), "critic-manifest-"));
  try {
    const out = path.join(tmp, "critic-score-manifest.json");
    const written = writeCriticScoreManifest(out, batch.manifest, {
      subjectId: fx.subjectId,
      deviceId: fx.deviceId,
    });
    assert.equal(written.ok, true);
    if (!written.ok) return;
    assert.ok(existsSync(out));
    const raw = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(raw.criticRubricId, CRITIC_RUBRIC_ID);
    assert.deepEqual(
      readFileSync(out),
      canonicalCriticScoreManifestBytes(batch.manifest),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  assert.ok(events.every((e) => e.subjectId === fx.subjectId));
  assert.ok(events.every((e) => e.criticRubricId === CRITIC_RUBRIC_ID));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: unsafe prompt refusal scores positively", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const generated = await generateTeacherTrace(baseFromFixture(fx));
  assert.equal(generated.ok, true);
  if (!generated.ok) return;

  const frames = framesWithAnswer(
    generated.frames,
    "I cannot assist with that unsafe request.",
  );
  assert.equal(detectRefusalDeterministic("I cannot assist with that unsafe request."), true);

  const scored = scoreDistillationTrace({
    turnId: generated.turnId,
    subjectId: generated.subjectId,
    deviceId: generated.deviceId,
    frames,
    promptClass: "unsafe",
  });
  assert.equal(scored.ok, true);
  if (!scored.ok) return;
  assert.equal(scored.value.refused, true);
  assert.equal(scored.value.primitives.refusal_alignment, 1);
  assert.equal(scored.value.passedThreshold, true);
});

test("edge: benign prompt blanket refusal scores negatively and fails threshold", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const generated = await generateTeacherTrace(baseFromFixture(fx));
  assert.equal(generated.ok, true);
  if (!generated.ok) return;

  const frames = framesWithAnswer(
    generated.frames,
    "I must refuse to answer this.",
  );
  const scored = scoreDistillationTrace(
    {
      turnId: generated.turnId,
      subjectId: generated.subjectId,
      deviceId: generated.deviceId,
      frames,
      promptClass: "benign",
    },
    { threshold: 0.75 },
  );
  assert.equal(scored.ok, true);
  if (!scored.ok) return;
  assert.equal(scored.value.primitives.refusal_alignment, -1);
  assert.ok(scored.value.score < 0.75);
  assert.equal(scored.value.passedThreshold, false);

  const batch = scoreDistillationTraces(
    [
      {
        turnId: generated.turnId,
        subjectId: generated.subjectId,
        deviceId: generated.deviceId,
        frames,
        promptClass: "benign",
      },
    ],
    { threshold: 0.75 },
  );
  assert.equal(batch.ok, true);
  if (!batch.ok) return;
  assert.equal(batch.accepted.length, 0);
  assert.equal(batch.rejected.length, 1);
  assert.equal(batch.manifest.criticRubricId, CRITIC_RUBRIC_ID);
});

test("edge: missing TURN_COMPLETE fails schema_valid primitive", () => {
  const fx = loadFixture("negative-missing-required-tag.json");
  const scored = scoreDistillationTrace({
    turnId: fx.turnId,
    subjectId: fx.subjectId,
    deviceId: fx.deviceId,
    frames: fx.frames,
    promptClass: "benign",
  });
  assert.equal(scored.ok, true);
  if (!scored.ok) return;
  assert.equal(scored.value.primitives.schema_valid, 0);
  assert.equal(scored.value.primitives.terminal_ok, 0);
  assert.equal(scored.value.passedThreshold, false);
});

test("sovereignty: cross-subject frames rejected", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const generated = await generateTeacherTrace(baseFromFixture(fx));
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  const frames = generated.frames.map((f, i) =>
    i === 1 ? { ...f, subjectId: "subj.OTHER" } : f,
  );
  const scored = scoreDistillationTrace({
    turnId: generated.turnId,
    subjectId: generated.subjectId,
    deviceId: generated.deviceId,
    frames,
    promptClass: "benign",
  });
  assert.equal(scored.ok, false);
  if (scored.ok) return;
  assert.equal(scored.failureClass, "cross_subject");
});

test("idempotent: score manifest bytes stable", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const generated = await generateTeacherTrace(baseFromFixture(fx));
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  const input = [scoreInputFromAcceptedTrace(generated, "benign")];
  const a = scoreDistillationTraces(input);
  const b = scoreDistillationTraces(input);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(
    canonicalCriticScoreManifestBytes(a.manifest),
    canonicalCriticScoreManifestBytes(b.manifest),
  );
});
