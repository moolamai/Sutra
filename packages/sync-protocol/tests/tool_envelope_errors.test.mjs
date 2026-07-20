/**
 * ToolEnvelopeErrorCode closed enum + repair-loop validation rules.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/tool_envelope_errors.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_CALL_ENVELOPE_MAX_CALLS,
  TOOL_ENVELOPE_ERROR_CODES,
  TOOL_ENVELOPE_VALIDATION_RULES,
  classifyToolEnvelopeValue,
  makeToolEnvelopeError,
  parseToolCallEnvelope,
  parseToolCallEnvelopeJson,
  toolEnvelopeErrorSchema,
  toolEnvelopeRuleFor,
} from "../dist/index.js";

test("happy path: closed enum catalogues every validation rule exactly once", () => {
  assert.equal(TOOL_ENVELOPE_ERROR_CODES.length, TOOL_ENVELOPE_VALIDATION_RULES.length);
  const ruleCodes = new Set(TOOL_ENVELOPE_VALIDATION_RULES.map((r) => r.code));
  for (const code of TOOL_ENVELOPE_ERROR_CODES) {
    assert.ok(ruleCodes.has(code), `missing rule for ${code}`);
    const rule = toolEnvelopeRuleFor(code);
    assert.equal(rule.code, code);
    assert.ok(rule.message.length > 0);
    assert.ok(rule.message.length <= 256);
    assert.doesNotMatch(rule.message, /Error:| at Object\.|\.ts:\d+|\.js:\d+|SyntaxError|stack trace/i);
  }
  // Round-trip each code through the Zod error payload schema.
  for (const code of TOOL_ENVELOPE_ERROR_CODES) {
    const err = makeToolEnvelopeError(code);
    assert.equal(toolEnvelopeErrorSchema.parse(err).code, code);
  }
});

test("happy path: classifyToolEnvelopeValue null for valid single/array", () => {
  assert.equal(
    classifyToolEnvelopeValue({
      toolName: "lookup",
      arguments: {},
    }),
    null,
  );
  assert.equal(
    classifyToolEnvelopeValue([{ toolName: "a", arguments: {} }]),
    null,
  );
});

test("edge: each major violation maps to a distinct closed code", () => {
  assert.equal(
    classifyToolEnvelopeValue({ arguments: {} })?.code,
    "MISSING_TOOL_NAME",
  );
  assert.equal(
    classifyToolEnvelopeValue({
      toolName: "lookup",
      arguments: ["x"],
    })?.code,
    "INVALID_ARGUMENTS",
  );
  assert.equal(
    classifyToolEnvelopeValue({
      toolName: "lookup",
      arguments: {},
      callId: null,
    })?.code,
    "INVALID_CALL_ID",
  );
  assert.equal(classifyToolEnvelopeValue([])?.code, "EMPTY_ENVELOPE");
  assert.equal(
    classifyToolEnvelopeValue(
      Array.from({ length: TOOL_CALL_ENVELOPE_MAX_CALLS + 1 }, (_, i) => ({
        toolName: `t${i}`,
        arguments: {},
      })),
    )?.code,
    "TOO_MANY_CALLS",
  );
  assert.equal(
    classifyToolEnvelopeValue([{ toolName: "a", arguments: {} }, "x"])?.code,
    "AMBIGUOUS_ARRAY",
  );
  assert.equal(
    classifyToolEnvelopeValue("please call lookup")?.code,
    "SCHEMA_VIOLATION",
  );
});

test("edge: parseToolCallEnvelopeJson emits INVALID_JSON without stacks", () => {
  const bad = parseToolCallEnvelopeJson("{not-json");
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "INVALID_JSON");
  assert.doesNotMatch(bad.error.message, /SyntaxError|Unexpected token|stack/i);

  const good = parseToolCallEnvelopeJson(
    JSON.stringify({ toolName: "lookup", arguments: { q: 1 } }),
  );
  assert.equal(good.ok, true);
  assert.equal(good.envelope[0].toolName, "lookup");
});

test("subject isolation: SUBJECT_REQUIRED is distinct and not repairable", () => {
  const rule = toolEnvelopeRuleFor("SUBJECT_REQUIRED");
  assert.equal(rule.repairable, false);
  const rejected = parseToolCallEnvelope(
    { toolName: "lookup", arguments: {} },
    { subjectId: "" },
  );
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.errorCode, "SUBJECT_REQUIRED");
  assert.equal(rejected.subjectId, null);
});

test("observability: structured error payload never carries argument secrets", () => {
  const rejected = parseToolCallEnvelope(
    {
      toolName: "lookup",
      arguments: "not-an-object",
      leakedUtterance: "student said 42",
    },
    { subjectId: "anika-k", deviceId: "edge-aaaa" },
  );
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.errorCode, "INVALID_ARGUMENTS");
  assert.equal(rejected.deviceId, "edge-aaaa");
  const serialized = JSON.stringify(rejected);
  assert.equal(serialized.includes("student said"), false);
  assert.equal(serialized.includes("leakedUtterance"), false);
  assert.ok(TOOL_ENVELOPE_ERROR_CODES.includes(rejected.errorCode));
});

test("idempotent: classifying the same bad payload twice is stable", () => {
  const input = [{ toolName: "a", arguments: {} }, [1, 2]];
  const a = classifyToolEnvelopeValue(input);
  const b = classifyToolEnvelopeValue(input);
  assert.deepEqual(a, b);
  assert.equal(a?.code, "AMBIGUOUS_ARRAY");
  assert.equal(a?.callIndex, 1);
});
