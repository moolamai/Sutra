/**
 * Grammar filter for distillation candidates — report with counts per class.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISTILLATION_REQUIRED_FRAME_TAGS,
  GRAMMAR_FILTER_SCHEMA_VERSION,
  GRAMMAR_VIOLATION_CLASSES,
  canonicalGrammarFilterReportBytes,
  evaluateTeacherTraceGrammar,
  filterDistillationCandidates,
  filterTeacherTraceCandidate,
  generateTeacherTrace,
} from "../dist/generate_traces.js";

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

test("unit: grammar filter schema + required tags declared", () => {
  assert.equal(
    GRAMMAR_FILTER_SCHEMA_VERSION,
    "training.distillation-grammar-filter.v1",
  );
  assert.deepEqual([...GRAMMAR_VIOLATION_CLASSES], [
    "protocol_tag",
    "tool_envelope",
    "missing_required_tag",
  ]);
  assert.ok(DISTILLATION_REQUIRED_FRAME_TAGS.includes("SESSION_START"));
  assert.ok(DISTILLATION_REQUIRED_FRAME_TAGS.includes("TURN_COMPLETE"));
});

test("happy path: filterDistillationCandidates accepts valid + reports zeros", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const events = [];
  const result = await filterDistillationCandidates(
    [baseFromFixture(fx)],
    {
      subjectId: fx.subjectId,
      deviceId: fx.deviceId,
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.accepted.length, 1);
  assert.equal(result.report.scanned, 1);
  assert.equal(result.report.accepted, 1);
  assert.equal(result.report.dropped, 0);
  assert.equal(result.report.counts.tool_envelope, 0);
  assert.equal(result.report.counts.protocol_tag, 0);
  assert.equal(result.report.counts.missing_required_tag, 0);
  assert.ok(events.some((e) => e.op === "filter" && e.outcome === "ok"));
  assert.ok(events.every((e) => e.subjectId === fx.subjectId));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: malformed envelope counted as tool_envelope in report", async () => {
  const good = loadFixture("valid-thought-answer.json");
  const bad = loadFixture("negative-bad-envelope.json");
  const result = await filterDistillationCandidates([
    baseFromFixture(good, { turnId: "turn-ok", correlationId: "corr-ok" }),
    baseFromFixture(bad, { turnId: "turn-env", correlationId: "corr-env" }),
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.accepted.length, 1);
  assert.equal(result.report.scanned, 2);
  assert.equal(result.report.dropped, 1);
  assert.equal(result.report.counts.tool_envelope, 1);
  assert.equal(result.report.droppedEntries[0]?.violationClass, "tool_envelope");
});

test("edge: missing TURN_COMPLETE → missing_required_tag", () => {
  const fx = loadFixture("negative-missing-required-tag.json");
  const evaluated = evaluateTeacherTraceGrammar(fx.frames, {
    subjectId: fx.subjectId,
  });
  assert.equal(evaluated.ok, false);
  if (evaluated.ok) return;
  assert.equal(evaluated.violationClass, "missing_required_tag");
  assert.match(evaluated.detail, /TURN_COMPLETE/);

  const filtered = filterTeacherTraceCandidate(fx);
  assert.equal(filtered.ok, false);
  if (filtered.ok) return;
  assert.equal(filtered.violationClass, "missing_required_tag");
});

test("edge: wrong protocolVersion → protocol_tag", () => {
  const frames = [
    {
      type: "SESSION_START",
      sequenceIndex: 0,
      correlationId: "c",
      subjectId: "subj.x",
      protocolVersion: "0.0.0",
      pinnedAt: "2026-07-16T00:00:00.000Z",
    },
    {
      type: "ANSWER_DELTA",
      sequenceIndex: 1,
      correlationId: "c",
      subjectId: "subj.x",
      delta: "x",
    },
    {
      type: "TURN_COMPLETE",
      sequenceIndex: 2,
      correlationId: "c",
      subjectId: "subj.x",
      turnId: "t1",
    },
  ];
  const evaluated = evaluateTeacherTraceGrammar(frames, {
    subjectId: "subj.x",
  });
  assert.equal(evaluated.ok, false);
  if (evaluated.ok) return;
  assert.equal(evaluated.violationClass, "protocol_tag");
});

test("sovereignty: cross-subject frame rejected as protocol_tag", () => {
  const frames = [
    {
      type: "SESSION_START",
      sequenceIndex: 0,
      correlationId: "c",
      subjectId: "subj.a",
      protocolVersion: "1.0.0",
      pinnedAt: "2026-07-16T00:00:00.000Z",
    },
    {
      type: "ANSWER_DELTA",
      sequenceIndex: 1,
      correlationId: "c",
      subjectId: "subj.OTHER",
      delta: "x",
    },
    {
      type: "TURN_COMPLETE",
      sequenceIndex: 2,
      correlationId: "c",
      subjectId: "subj.a",
      turnId: "t1",
    },
  ];
  const evaluated = evaluateTeacherTraceGrammar(frames, {
    subjectId: "subj.a",
  });
  assert.equal(evaluated.ok, false);
  if (evaluated.ok) return;
  assert.equal(evaluated.violationClass, "protocol_tag");
  assert.match(evaluated.detail, /cross-subject/);
});

test("idempotent: filter report bytes stable across runs", async () => {
  const good = loadFixture("valid-thought-answer.json");
  const bad = loadFixture("negative-bad-envelope.json");
  const jobs = [
    baseFromFixture(good, { turnId: "turn-a", correlationId: "corr-a" }),
    baseFromFixture(bad, { turnId: "turn-b", correlationId: "corr-b" }),
  ];
  const a = await filterDistillationCandidates(jobs);
  const b = await filterDistillationCandidates(jobs);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(
    canonicalGrammarFilterReportBytes(a.report),
    canonicalGrammarFilterReportBytes(b.report),
  );
});

test("happy path: generated valid trace passes evaluateTeacherTraceGrammar", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const generated = await generateTeacherTrace(baseFromFixture(fx));
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  const evaluated = evaluateTeacherTraceGrammar(generated.frames, {
    subjectId: generated.subjectId,
  });
  assert.equal(evaluated.ok, true);
});
