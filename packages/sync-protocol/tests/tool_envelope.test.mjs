/**
 * ToolCallEnvelope Zod schema — single/array forms, strip unknown keys.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/tool_envelope.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_CALL_ENVELOPE_MAX_CALLS,
  normalizeToolCallEnvelope,
  parseToolCallEnvelope,
  toolCallEnvelopeSchema,
  toolCallSchema,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "../fixtures/tool-envelope");

const VALID_SINGLE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "valid-single.json"), "utf8"),
);
const VALID_ARRAY = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "valid-array.json"), "utf8"),
);

test("barrel exports toolCallEnvelopeSchema; fixtures round-trip", () => {
  assert.equal(typeof toolCallEnvelopeSchema.safeParse, "function");
  assert.equal(typeof toolCallSchema.safeParse, "function");

  const single = toolCallEnvelopeSchema.parse(VALID_SINGLE);
  assert.equal(single.toolName, "lookup");
  assert.equal(single.callId, "c1");
  assert.deepEqual(single.arguments, { query: "ratio" });

  const arr = toolCallEnvelopeSchema.parse(VALID_ARRAY);
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, 2);
  assert.equal(arr[0].toolName, "lookup");
  assert.equal(arr[1].toolName, "calculator");
  assert.equal(Object.hasOwn(arr[1], "callId"), false);

  assert.deepEqual(normalizeToolCallEnvelope(single).map((c) => c.toolName), [
    "lookup",
  ]);
  assert.equal(normalizeToolCallEnvelope(arr).length, 2);
});

test("unknown keys are stripped at the wire boundary (never passthrough)", () => {
  const parsed = toolCallSchema.parse({
    ...VALID_SINGLE,
    evil: "nope",
    providerMeta: { raw: true },
  });
  assert.equal(Object.hasOwn(parsed, "evil"), false);
  assert.equal(Object.hasOwn(parsed, "providerMeta"), false);
  assert.equal(parsed.toolName, "lookup");
});

/** Zod union issues nest per-branch errors — flatten paths for assertions. */
function issuePaths(result) {
  const out = [];
  const walk = (issues) => {
    for (const issue of issues ?? []) {
      if (issue.path?.length) out.push(...issue.path.map(String));
      if (Array.isArray(issue.errors)) {
        for (const branch of issue.errors) walk(branch);
      }
    }
  };
  walk(result.error?.issues);
  return out;
}

test("rejects invalid mutations with typed Zod issues", () => {
  const missingName = toolCallEnvelopeSchema.safeParse({
    arguments: {},
  });
  assert.equal(missingName.success, false);
  assert.ok(issuePaths(missingName).includes("toolName"));

  const badArgs = toolCallEnvelopeSchema.safeParse({
    toolName: "lookup",
    arguments: ["not", "an", "object"],
  });
  assert.equal(badArgs.success, false);
  assert.ok(issuePaths(badArgs).includes("arguments"));

  const emptyArray = toolCallEnvelopeSchema.safeParse([]);
  assert.equal(emptyArray.success, false);

  const prose = toolCallEnvelopeSchema.safeParse("please call lookup");
  assert.equal(prose.success, false);

  const tooMany = toolCallEnvelopeSchema.safeParse(
    Array.from({ length: TOOL_CALL_ENVELOPE_MAX_CALLS + 1 }, (_, i) => ({
      toolName: `t${i}`,
      arguments: {},
    })),
  );
  assert.equal(tooMany.success, false);
});

test("optional vs nullable: callId omitted ok; null rejected", () => {
  const omitted = toolCallSchema.safeParse({
    toolName: "lookup",
    arguments: {},
  });
  assert.equal(omitted.success, true);
  assert.equal(Object.hasOwn(omitted.data, "callId"), false);

  const asNull = toolCallSchema.safeParse({
    toolName: "lookup",
    arguments: {},
    callId: null,
  });
  assert.equal(asNull.success, false);
  assert.ok(asNull.error.issues.some((i) => i.path.includes("callId")));
});

test("subject isolation: scoped parse requires non-empty subjectId", () => {
  const empty = parseToolCallEnvelope(VALID_SINGLE, { subjectId: "" });
  assert.equal(empty.outcome, "rejected");
  assert.equal(empty.errorCode, "SUBJECT_REQUIRED");

  const ok = parseToolCallEnvelope(VALID_SINGLE, {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  assert.equal(ok.outcome, "accepted");
  assert.equal(ok.subjectId, "anika-k");
  assert.equal(ok.deviceId, "edge-aaaa");
  assert.equal(ok.callCount, 1);
  assert.deepEqual(ok.toolNames, ["lookup"]);
});

test("observability: rejected outcomes never embed argument bodies", () => {
  const rejected = parseToolCallEnvelope(
    { toolName: "", arguments: { secretLearnerAnswer: "42" } },
    { subjectId: "anika-k" },
  );
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.errorCode, "MISSING_TOOL_NAME");
  const serialized = JSON.stringify(rejected);
  assert.equal(serialized.includes("secretLearnerAnswer"), false);
  assert.equal(serialized.includes("42"), false);
  assert.doesNotMatch(serialized, /at Object\.|Error:|stack/i);
});

test("idempotent re-parse of the same fixture yields identical calls", () => {
  const a = normalizeToolCallEnvelope(toolCallEnvelopeSchema.parse(VALID_ARRAY));
  const b = normalizeToolCallEnvelope(toolCallEnvelopeSchema.parse(VALID_ARRAY));
  assert.deepEqual(a, b);
});

test("scalability: array at max bound parses within budget", () => {
  const calls = Array.from({ length: TOOL_CALL_ENVELOPE_MAX_CALLS }, (_, i) => ({
    toolName: `tool_${i}`,
    arguments: { n: i },
  }));
  const started = performance.now();
  const parsed = toolCallEnvelopeSchema.parse(calls);
  const elapsed = performance.now() - started;
  assert.equal(parsed.length, TOOL_CALL_ENVELOPE_MAX_CALLS);
  assert.ok(elapsed < 100, `parse took ${elapsed}ms; budget is 100ms`);
});
