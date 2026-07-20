/**
 * Tool-envelope wire fixtures + committed JSON Schema governance.
 * Shared with Python: fixtures/tool-envelope/manifest.json
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_ENVELOPE_ERROR_CODES,
  classifyToolEnvelopeValue,
  makeToolEnvelopeError,
  parseToolCallEnvelope,
  parseToolCallEnvelopeJson,
  toolCallEnvelopeSchema,
  toolEnvelopeErrorSchema,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE_DIR = join(PKG, "fixtures", "tool-envelope");
const MANIFEST = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
);

function loadFixture(rel) {
  return readFileSync(join(FIXTURE_DIR, rel), "utf8");
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: valid fixtures parse; schemas committed", () => {
  assert.ok(existsSync(join(PKG, "schemas", "ToolCallEnvelope.json")));
  assert.ok(existsSync(join(PKG, "schemas", "ToolEnvelopeError.json")));
  const envSchema = JSON.parse(
    readFileSync(join(PKG, "schemas", "ToolCallEnvelope.json"), "utf8"),
  );
  assert.equal(envSchema.title, "ToolCallEnvelope");
  assert.equal(envSchema["x-protocol-version"], "1.0.0");

  for (const entry of MANIFEST.valid) {
    const value = JSON.parse(loadFixture(entry.file));
    const parsed = toolCallEnvelopeSchema.parse(value);
    assert.ok(parsed);
    emit({
      event: "tool.envelope.fixture",
      outcome: "ok",
      kind: "valid",
      id: entry.id,
      subjectId: "anika-k",
    });
  }
});

test("happy path: manifest covers every ToolEnvelopeErrorCode once", () => {
  const codes = MANIFEST.violations.map((v) => v.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of TOOL_ENVELOPE_ERROR_CODES) {
    assert.ok(codes.includes(code), `manifest missing violation for ${code}`);
  }
});

test("edge: each violation fixture rejects with the documented code (TS)", () => {
  for (const violation of MANIFEST.violations) {
    const raw = loadFixture(violation.file);
    let code;
    if (violation.kind === "json-text") {
      const result = parseToolCallEnvelopeJson(raw);
      assert.equal(result.ok, false, violation.code);
      code = result.error.code;
    } else if (violation.kind === "fence-text") {
      // Host maps missing fence → MISSING_FENCE (no ```tool_call in body).
      assert.doesNotMatch(raw, /```(?:tool_call|json)/i);
      code = makeToolEnvelopeError("MISSING_FENCE").code;
    } else if (violation.kind === "subject-scope") {
      const value = JSON.parse(raw);
      const result = parseToolCallEnvelope(value, {
        subjectId: violation.subjectId ?? "",
      });
      assert.equal(result.outcome, "rejected");
      code = result.errorCode;
    } else {
      const value = JSON.parse(raw);
      const err = classifyToolEnvelopeValue(value);
      assert.ok(err, violation.code);
      code = err.code;
    }
    assert.equal(code, violation.code, violation.file);
    emit({
      event: "tool.envelope.fixture",
      outcome: "rejected",
      errorCode: code,
      subjectId: "anika-k",
    });
  }
});

test("edge: ToolEnvelopeError schema rejects unknown codes and secret fields", () => {
  const ok = toolEnvelopeErrorSchema.parse({
    code: "INVALID_JSON",
    message: "tool-call fence body is not valid JSON",
    issuePath: "(root)",
  });
  assert.equal(ok.code, "INVALID_JSON");

  const badCode = toolEnvelopeErrorSchema.safeParse({
    code: "NOT_A_CODE",
    message: "x",
    issuePath: "(root)",
  });
  assert.equal(badCode.success, false);

  const sneaky = toolEnvelopeErrorSchema.safeParse({
    code: "SCHEMA_VIOLATION",
    message: "tool-call envelope failed schema validation",
    issuePath: "(root)",
    stack: "Error: at Object.",
    arguments: { secret: "nope" },
  });
  assert.equal(sneaky.success, false);
});

test("subject isolation + observability: reject payloads never leak stacks", () => {
  const raw = loadFixture("violations/invalid-arguments.json");
  const value = JSON.parse(raw);
  const result = parseToolCallEnvelope(value, {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  assert.equal(result.outcome, "rejected");
  assert.equal(result.errorCode, "INVALID_ARGUMENTS");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /stack|SyntaxError|at Object\./i);
  assert.equal(result.subjectId, "anika-k");
  assert.equal(result.deviceId, "edge-aaaa");
});
