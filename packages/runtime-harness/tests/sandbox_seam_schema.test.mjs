/**
 * Result-schema validation + TOOL_STATUS / tool_response mapping.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX_RESULT_SCHEMA_OBLIGATION,
  SANDBOX_SCHEMA_ISSUE_LIMIT,
  InProcessFakeToolRegistry,
  createSandboxSeam,
  mapSandboxResultToToolResponse,
  mapSandboxResultToToolStatus,
  validateToolResultSchema,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    hit: { type: "string" },
    score: { type: "number" },
  },
  required: ["hit"],
  additionalProperties: false,
};

function lookupDescriptor() {
  return {
    name: "lookup",
    description: "schema-validated lookup",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    riskClass: "read",
  };
}

test("happy path: result schema pass → TOOL_STATUS success + tool_response", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = lookupDescriptor();
  registry.register({
    descriptor,
    resultSchema: RESULT_SCHEMA,
    effect: (args) => ({ hit: String(args.q), score: 1 }),
  });
  const telemetry = [];
  const seam = createSandboxSeam({
    registry,
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    onTelemetry: (e) => telemetry.push(e),
  });
  const result = await seam.invoke(descriptor, { q: "ratio" }, {
    subjectId: "anika-k",
    invocationId: "inv-ok",
    deadlineMs: 200,
  });
  assert.equal(result.ok, true);

  const status = mapSandboxResultToToolStatus(result, {
    subjectId: "anika-k",
    correlationId: "corr-1",
    sequenceIndex: 3,
  });
  assert.equal(status.type, "TOOL_STATUS");
  assert.equal(status.status, "success");
  assert.equal(status.toolCallId, "inv-ok");
  assert.equal(status.subjectId, "anika-k");
  assert.equal(status.correlationId, "corr-1");
  assert.equal(status.sequenceIndex, 3);

  const response = mapSandboxResultToToolResponse(result);
  assert.equal(response.role, "tool");
  assert.equal(response.toolCallId, "inv-ok");
  const body = JSON.parse(response.content);
  assert.equal(body.status, "ok");
  assert.deepEqual(body.output, { hit: "ratio", score: 1 });
  assert.ok(telemetry.some((t) => t.outcome === "ok"));
  assert.ok(!JSON.stringify(telemetry).includes("ratio"));
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    case: "schema_ok_mapped",
  });
});

test("edge: schema-invalid result → TOOL_STATUS error + structured tool_response", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = lookupDescriptor();
  registry.register({
    descriptor,
    resultSchema: RESULT_SCHEMA,
    // Missing required "hit"; extra key forbidden.
    effect: () => ({ score: "not-a-number", leak: "secret-ratio" }),
  });
  const seam = createSandboxSeam({
    registry,
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  const result = await seam.invoke(descriptor, { q: "x" }, {
    subjectId: "anika-k",
    invocationId: "inv-bad",
    deadlineMs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "schema_invalid");
  assert.equal(result.error.obligationId, SANDBOX_RESULT_SCHEMA_OBLIGATION);
  assert.ok(Array.isArray(result.error.issues));
  assert.ok(result.error.issues.length >= 1);
  assert.ok(result.error.issues.length <= SANDBOX_SCHEMA_ISSUE_LIMIT);
  // Raw poison fields must not be returned as success output.
  assert.equal("output" in result, false);

  const status = mapSandboxResultToToolStatus(result, {
    subjectId: "anika-k",
    correlationId: "corr-bad",
    sequenceIndex: 4,
  });
  assert.equal(status.status, "error");
  assert.match(status.detail, /SANDBOX\.RESULT_SCHEMA/);
  assert.ok(!status.detail.includes("secret-ratio"));

  const response = mapSandboxResultToToolResponse(result);
  const body = JSON.parse(response.content);
  assert.equal(body.status, "error");
  assert.equal(body.error.kind, "schema_invalid");
  assert.equal(body.error.obligationId, SANDBOX_RESULT_SCHEMA_OBLIGATION);
  assert.ok(!response.content.includes("secret-ratio"));
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    failureClass: "schema_invalid",
    case: "schema_mapped_error",
  });
});

test("edge: oversize still maps to typed TOOL_STATUS error (not raw blob)", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = lookupDescriptor();
  registry.register({
    descriptor,
    resultSchema: { type: "object", required: ["hit"] },
    maxBytes: 24,
    effect: () => ({ hit: "x".repeat(100) }),
  });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  const result = await seam.invoke(descriptor, { q: "x" }, {
    subjectId: "anika-k",
    invocationId: "inv-big",
    deadlineMs: 200,
  });
  assert.equal(result.failureClass, "payload_oversize");
  const status = mapSandboxResultToToolStatus(result, {
    subjectId: "anika-k",
    correlationId: "corr-big",
    sequenceIndex: 5,
  });
  assert.equal(status.status, "error");
  assert.match(status.detail, /payload_oversize|maxBytes/i);
  const response = mapSandboxResultToToolResponse(result);
  assert.ok(!response.content.includes("xxxxxxxxxx"));
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    failureClass: "payload_oversize",
    case: "oversize_mapped",
  });
});

test("edge: validateToolResultSchema bounds issues and type checks", () => {
  const ok = validateToolResultSchema(RESULT_SCHEMA, { hit: "a", score: 2 });
  assert.equal(ok.ok, true);
  const bad = validateToolResultSchema(RESULT_SCHEMA, { score: "nope", x: 1 });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.length <= SANDBOX_SCHEMA_ISSUE_LIMIT);
  assert.ok(bad.issues.some((i) => i.path.includes("hit")));
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "schema_unit",
  });
});

test("sovereignty: mapping keeps subjectId; rejects cross-subject invoke", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = lookupDescriptor();
  registry.register({
    descriptor,
    resultSchema: RESULT_SCHEMA,
    effect: () => ({ hit: "ok" }),
  });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  const cross = await seam.invoke(descriptor, { q: "x" }, {
    subjectId: "other",
    invocationId: "inv-x",
    deadlineMs: 100,
  });
  assert.equal(cross.failureClass, "cross_subject");
  const status = mapSandboxResultToToolStatus(cross, {
    subjectId: "anika-k",
    correlationId: "corr-x",
    sequenceIndex: 0,
  });
  assert.equal(status.subjectId, "anika-k");
  assert.equal(status.status, "error");
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "subject_map",
  });
});

test("scalability: schema issue list soft-capped", () => {
  const props = {};
  const required = [];
  for (let i = 0; i < SANDBOX_SCHEMA_ISSUE_LIMIT + 8; i++) {
    const k = `f${i}`;
    props[k] = { type: "string" };
    required.push(k);
  }
  const bad = validateToolResultSchema(
    { type: "object", properties: props, required },
    {},
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.length <= SANDBOX_SCHEMA_ISSUE_LIMIT);
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "issue_cap",
    issues: bad.issues.length,
  });
});
