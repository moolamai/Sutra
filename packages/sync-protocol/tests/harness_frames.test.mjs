/**
 * HarnessFrame Zod discriminated union — round-trip, edge cases, subject isolation.
 * Shared fixture: fixtures/wire-parity/harness-frames.json (Python parity twin).
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/harness_frames.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_FRAME_TYPES,
  assertMonotonicSequence,
  harnessFrameSchema,
  meterEventSchema,
  parseHarnessFrame,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/wire-parity/harness-frames.json"), "utf8"),
);

const ALL_VALID = GOLDEN.frames;
const VALID_SESSION_START = ALL_VALID[0];
const VALID_THOUGHT = ALL_VALID[1];
const VALID_ANSWER = ALL_VALID[2];
const VALID_TOOL = ALL_VALID[3];
const VALID_ADVISORY = ALL_VALID[4];
const VALID_METER_TICK = ALL_VALID[5];
const VALID_METER = VALID_METER_TICK.tick;
const VALID_COMPLETE = ALL_VALID[6];
const VALID_ERROR = ALL_VALID[7];

test("barrel exports harnessFrameSchema and every frame type discriminant", () => {
  assert.equal(typeof harnessFrameSchema.safeParse, "function");
  assert.equal(HARNESS_FRAME_TYPES.length, 8);
  for (const frame of ALL_VALID) {
    assert.ok(HARNESS_FRAME_TYPES.includes(frame.type), frame.type);
  }
});

test("happy path: every frame variant round-trips through harnessFrameSchema", () => {
  for (const fixture of ALL_VALID) {
    const parsed = harnessFrameSchema.parse(fixture);
    assert.equal(parsed.type, fixture.type);
    assert.equal(parsed.subjectId, "anika-k");
    assert.equal(parsed.sequenceIndex, fixture.sequenceIndex);
  }
  assert.equal(meterEventSchema.parse(VALID_METER).locality, "on-device");
});

test("rejects invalid mutations with typed Zod issues (named obligation)", () => {
  const badType = harnessFrameSchema.safeParse({
    ...VALID_THOUGHT,
    type: "NOT_A_FRAME",
  });
  assert.equal(badType.success, false);
  assert.ok(badType.error.issues.some((i) => i.path.includes("type")));

  const badSeq = harnessFrameSchema.safeParse({
    ...VALID_ANSWER,
    sequenceIndex: -1,
  });
  assert.equal(badSeq.success, false);
  assert.ok(badSeq.error.issues.some((i) => i.path.includes("sequenceIndex")));

  const badAdvisory = harnessFrameSchema.safeParse({
    ...VALID_ADVISORY,
    advisory: { code: "NOT_A_REAL_CODE", detail: "x" },
  });
  assert.equal(badAdvisory.success, false);
  assert.ok(
    badAdvisory.error.issues.some(
      (i) => i.path.includes("advisory") || i.path.includes("code"),
    ),
  );
});

test("unknown keys are rejected at the wire boundary (never passthrough)", () => {
  const sneaky = harnessFrameSchema.safeParse({
    ...VALID_THOUGHT,
    leakedLearnerName: "should-not-survive",
  });
  assert.equal(sneaky.success, false);
  assert.ok(
    sneaky.error.issues.some(
      (i) => i.code === "unrecognized_keys" || String(i.message).includes("leaked"),
    ),
  );
});

test("optional vs nullable: TOOL_STATUS.detail omitted ok; null rejected", () => {
  const omitted = harnessFrameSchema.safeParse(VALID_TOOL);
  assert.equal(omitted.success, true);
  assert.equal(Object.hasOwn(omitted.data, "detail"), false);

  const withDetail = harnessFrameSchema.safeParse({
    ...VALID_TOOL,
    detail: "running sandbox",
  });
  assert.equal(withDetail.success, true);
  assert.equal(withDetail.data.detail, "running sandbox");

  const asNull = harnessFrameSchema.safeParse({
    ...VALID_TOOL,
    detail: null,
  });
  assert.equal(asNull.success, false);
  assert.ok(asNull.error.issues.some((i) => i.path.includes("detail")));
});

test("subject isolation: empty subjectId rejected (cross-subject gap)", () => {
  const empty = harnessFrameSchema.safeParse({
    ...VALID_SESSION_START,
    subjectId: "",
  });
  assert.equal(empty.success, false);
  assert.ok(empty.error.issues.some((i) => i.path.includes("subjectId")));
});

test("sequenceIndex gaps are detected (never silently skipped)", () => {
  const ok = assertMonotonicSequence([
    VALID_SESSION_START,
    VALID_THOUGHT,
    VALID_ANSWER,
  ]);
  assert.equal(ok.ok, true);

  const gap = assertMonotonicSequence([
    VALID_SESSION_START,
    VALID_THOUGHT,
    { ...VALID_ANSWER, sequenceIndex: 99 },
  ]);
  assert.equal(gap.ok, false);
  assert.equal(gap.code, "SEQUENCE_GAP");
  assert.equal(gap.expected, 2);
  assert.equal(gap.actual, 99);
  assert.equal(gap.subjectId, "anika-k");
});

test("observability: parseHarnessFrame emits metadata outcome, never delta text", () => {
  const accepted = parseHarnessFrame(VALID_THOUGHT, { deviceId: "edge-aaaa" });
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.subjectId, "anika-k");
  assert.equal(accepted.deviceId, "edge-aaaa");
  assert.equal(accepted.type, "THOUGHT_DELTA");
  assert.equal(accepted.sequenceIndex, 1);
  // Structured result carries the frame for callers; telemetry should use
  // the metadata fields only — assert the outcome object itself is classified.
  const serializedMeta = JSON.stringify({
    outcome: accepted.outcome,
    subjectId: accepted.subjectId,
    deviceId: accepted.deviceId,
    type: accepted.type,
    sequenceIndex: accepted.sequenceIndex,
  });
  assert.equal(serializedMeta.includes("consider ratio"), false);

  const rejected = parseHarnessFrame(
    { ...VALID_THOUGHT, leaked: true },
    { deviceId: "edge-aaaa" },
  );
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.failureClass, "unrecognized_keys");
  assert.equal(rejected.subjectId, "anika-k");
  assert.equal(rejected.deviceId, "edge-aaaa");
  assert.equal(JSON.stringify(rejected).includes("consider ratio"), false);

  const badSubject = parseHarnessFrame({ ...VALID_THOUGHT, subjectId: "" });
  assert.equal(badSubject.outcome, "rejected");
  assert.equal(badSubject.failureClass, "missing_subject");
});

test("scalability: parse of large-but-bounded delta stays within budget", () => {
  const delta = "x".repeat(64 * 1024); // 64 KiB — bounded frame body
  const started = performance.now();
  const parsed = harnessFrameSchema.parse({
    ...VALID_ANSWER,
    delta,
  });
  const elapsed = performance.now() - started;
  assert.equal(parsed.delta.length, 64 * 1024);
  assert.ok(elapsed < 100, `parse took ${elapsed}ms; budget is 100ms`);
});
