/**
 * Teacher trace generator through production runtime harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISTILLATION_PACKAGE_ROOT,
  STREAMING_TURN_PROTOCOL_VERSION,
  TEACHER_TRACE_BATCH_LIMIT,
  TEACHER_CHUNK_LIMIT,
  deterministicFakeTeacherChunks,
  generateTeacherTrace,
  generateTeacherTraces,
} from "../dist/generate_traces.js";
import { STREAMING_TURN_PROTOCOL_VERSION as HARNESS_PROTOCOL } from "@moolam/runtime-harness";

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

test("unit: package root + protocol version align with harness", () => {
  assert.equal(DISTILLATION_PACKAGE_ROOT, PKG);
  assert.equal(STREAMING_TURN_PROTOCOL_VERSION, HARNESS_PROTOCOL);
  assert.equal(STREAMING_TURN_PROTOCOL_VERSION, "1.0.0");
});

test("happy path: thought+answer through harness tagged with protocol version", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const events = [];
  const result = await generateTeacherTrace(
    baseFromFixture(fx, {
      onTelemetry: (e) => events.push(e),
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.protocolVersion, "1.0.0");
  assert.equal(result.frames[0]?.type, "SESSION_START");
  assert.equal(result.frames[0]?.protocolVersion, "1.0.0");
  assert.ok(result.frames.some((f) => f.type === "THOUGHT_DELTA"));
  assert.ok(result.frames.some((f) => f.type === "ANSWER_DELTA"));
  assert.equal(result.frames.at(-1)?.type, "TURN_COMPLETE");
  assert.ok(result.canonicalFramesJson.includes("SESSION_START"));
  assert.ok(events.some((e) => e.op === "generate" && e.outcome === "ok"));
  assert.ok(events.every((e) => e.subjectId === fx.subjectId));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: tool fence invokes sandbox; tool results captured", async () => {
  const events = [];
  const chunks = deterministicFakeTeacherChunks("teacher-seed-1");
  const result = await generateTeacherTrace({
    subjectId: "subj.distill.tools",
    sessionId: "sess-tools",
    turnId: "turn-tools",
    deviceId: "dev-distill",
    correlationId: "corr-tools",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T00:00:00.000Z",
    },
    teacherChunks: chunks,
    pinnedAt: "2026-07-16T00:00:00.000Z",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.ok(result.toolCallIds.length >= 1);
  assert.ok(result.toolResults.some((t) => t.status === "success"));
  assert.ok(result.frames.some((f) => f.type === "TOOL_STATUS"));
  assert.equal(result.protocolVersion, "1.0.0");
});

test("edge: malformed tool envelope is dropped with reason code", async () => {
  const fx = loadFixture("negative-bad-envelope.json");
  const events = [];
  const result = await generateTeacherTrace(
    baseFromFixture(fx, {
      onTelemetry: (e) => events.push(e),
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "tool_envelope");
  assert.equal(result.dropReason, "tool_envelope");
  assert.ok(
    events.some(
      (e) =>
        e.op === "drop" &&
        e.outcome === "error" &&
        e.dropReason === "tool_envelope",
    ),
  );
});

test("edge: frontier teacher with personal consent is excluded", async () => {
  const result = await generateTeacherTrace({
    subjectId: "subj.distill.frontier",
    sessionId: "sess-f",
    turnId: "turn-f",
    deviceId: "dev-distill",
    correlationId: "corr-f",
    locality: "self-hosted",
    consent: {
      optedIn: true,
      consentClass: "personal",
      recordedAt: "2026-07-16T00:00:00.000Z",
    },
    teacherMode: "frontier",
    teacherChunks: ["<thought>x</thought>", "answer"],
    pinnedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "third_party_excluded");
  assert.equal(result.dropReason, "third_party_excluded");
});

test("sovereignty: SUBJECT_RAW marker blocked on frontier path", async () => {
  const result = await generateTeacherTrace({
    subjectId: "subj.distill.raw",
    sessionId: "sess-raw",
    turnId: "turn-raw",
    deviceId: "dev-distill",
    correlationId: "corr-raw",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T00:00:00.000Z",
    },
    teacherMode: "frontier",
    teacherChunks: [
      `<thought>CONTEXT SUBJECT_RAW:${SECRET}</thought>`,
      "answer",
    ],
    pinnedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "subject_data_unconsented");
});

test("idempotent: same chunks yield identical canonical frames", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const a = await generateTeacherTrace(baseFromFixture(fx));
  const b = await generateTeacherTrace(baseFromFixture(fx));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.canonicalFramesJson, b.canonicalFramesJson);
});

test("batch: dropCounts accumulate; accepted excludes dropped", async () => {
  const good = loadFixture("valid-thought-answer.json");
  const bad = loadFixture("negative-bad-envelope.json");
  const batch = await generateTeacherTraces([
    baseFromFixture(good, { turnId: "turn-a", correlationId: "corr-a" }),
    baseFromFixture(bad, { turnId: "turn-b", correlationId: "corr-b" }),
  ]);
  assert.equal(batch.ok, true);
  if (!batch.ok) return;
  assert.equal(batch.accepted.length, 1);
  assert.equal(batch.dropCounts.tool_envelope, 1);
});

test("scalability: batch and chunk limits are finite", () => {
  assert.ok(TEACHER_TRACE_BATCH_LIMIT > 0 && TEACHER_TRACE_BATCH_LIMIT <= 256);
  assert.ok(TEACHER_CHUNK_LIMIT > 0 && TEACHER_CHUNK_LIMIT <= 512);
});
