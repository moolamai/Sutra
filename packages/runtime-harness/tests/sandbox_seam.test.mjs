/**
 * SandboxSeam + InProcessFakeToolRegistry.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX_DEFAULT_DEADLINE_MS,
  SANDBOX_MAX_BYTES_DEFAULT,
  SANDBOX_REGISTRY_LIMIT,
  InProcessFakeToolRegistry,
  createSandboxSeam,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function readTool(name = "lookup") {
  return {
    name,
    description: "read probe",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    riskClass: "read",
  };
}

function writeTool(name = "persist") {
  return {
    name,
    description: "write probe",
    parameters: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
    riskClass: "write",
  };
}

test("happy path: seam invoke returns ok through InProcessFakeToolRegistry", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = readTool();
  registry.register({
    descriptor,
    effect: (args) => ({ hit: args.q }),
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
    deviceId: "edge-aaaa",
    invocationId: "inv-1",
    deadlineMs: SANDBOX_DEFAULT_DEADLINE_MS,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, { hit: "ratio" });
  assert.equal(result.subjectId, "anika-k");
  assert.ok(telemetry.some((t) => t.outcome === "ok"));
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(!JSON.stringify(telemetry).includes("ratio"));
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    case: "happy_path",
  });
});

test("edge: hung tool terminated at deadline without hanging", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = readTool("hangme");
  registry.register({ descriptor, hang: true });
  const seam = createSandboxSeam({
    registry,
    subjectId: "anika-k",
  });
  const t0 = Date.now();
  const result = await seam.invoke(descriptor, { q: "x" }, {
    subjectId: "anika-k",
    invocationId: "inv-hang",
    deadlineMs: 40,
  });
  const elapsed = Date.now() - t0;
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "deadline_exceeded");
  assert.equal(result.error.kind, "deadline_exceeded");
  assert.ok(elapsed < 2000, `should not hang; elapsed=${elapsed}`);
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    failureClass: "deadline_exceeded",
    case: "deadline_kill",
  });
});

test("edge: write/critical without write-ahead audit is denied", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = writeTool();
  let effectRan = false;
  registry.register({
    descriptor,
    effect: () => {
      effectRan = true;
      return { wrote: true };
    },
  });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  const denied = await seam.invoke(descriptor, { note: "n" }, {
    subjectId: "anika-k",
    invocationId: "inv-w1",
    deadlineMs: 200,
    writeAheadRecorded: false,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.failureClass, "audit_required");
  assert.equal(effectRan, false);
  assert.ok(registry.invokeOrder.some((t) => t.phase === "denied"));

  const ok = await seam.invoke(descriptor, { note: "n" }, {
    subjectId: "anika-k",
    invocationId: "inv-w2",
    deadlineMs: 200,
    writeAheadRecorded: true,
  });
  assert.equal(ok.ok, true);
  const phases = registry.invokeOrder
    .filter((t) => t.invocationId === "inv-w2")
    .map((t) => t.phase);
  assert.deepEqual(phases, ["audit", "effect"]);
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "audit_ordering",
  });
});

test("edge: oversize payload → payload_oversize tool error", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = readTool("big");
  registry.register({
    descriptor,
    maxBytes: 32,
    effect: () => ({ blob: "x".repeat(100) }),
  });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  const result = await seam.invoke(descriptor, { q: "x" }, {
    subjectId: "anika-k",
    invocationId: "inv-big",
    deadlineMs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "payload_oversize");
  assert.ok(SANDBOX_MAX_BYTES_DEFAULT >= 1024);
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    failureClass: "payload_oversize",
    case: "oversize",
  });
});

test("edge: schema-invalid result is tool error, never raw passthrough", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = readTool("poison");
  registry.register({ descriptor, invalidResult: true });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  const result = await seam.invoke(descriptor, { q: "x" }, {
    subjectId: "anika-k",
    invocationId: "inv-poison",
    deadlineMs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "schema_invalid");
  assert.equal(result.status, "error");
  assert.ok(result.error);
  assert.notEqual(typeof result.error, "symbol");
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "rejected",
    subjectId: "anika-k",
    failureClass: "schema_invalid",
    case: "schema_invalid",
  });
});

test("edge: concurrent idempotency key → at-most-once effect", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = readTool("once");
  let runs = 0;
  registry.register({
    descriptor,
    effect: async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { runs };
    },
  });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  const ctx = {
    subjectId: "anika-k",
    invocationId: "inv-idem",
    idempotencyKey: "idem-1",
    deadlineMs: 500,
  };
  const [a, b] = await Promise.all([
    seam.invoke(descriptor, { q: "a" }, ctx),
    seam.invoke(descriptor, { q: "b" }, ctx),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(runs, 1);
  assert.deepEqual(a.output, b.output);
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "idempotent",
    runs,
  });
});

test("sovereignty: missing / cross-subject reject; registry bound by seam subject", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = readTool();
  registry.register({ descriptor });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });

  const missing = await seam.invoke(descriptor, { q: "x" }, {
    subjectId: "",
    invocationId: "inv-m",
    deadlineMs: 100,
  });
  assert.equal(missing.failureClass, "missing_subject");

  const cross = await seam.invoke(descriptor, { q: "x" }, {
    subjectId: "other-subject",
    invocationId: "inv-x",
    deadlineMs: 100,
  });
  assert.equal(cross.failureClass, "cross_subject");

  assert.throws(() => createSandboxSeam({ registry, subjectId: "" }));
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "subject_scope",
  });
});

test("scalability: registry soft cap enforced", () => {
  const registry = new InProcessFakeToolRegistry();
  for (let i = 0; i < SANDBOX_REGISTRY_LIMIT; i++) {
    registry.register({
      descriptor: readTool(`t${i}`),
    });
  }
  assert.throws(() =>
    registry.register({ descriptor: readTool("overflow") }),
  );
  assert.equal(registry.list().length, SANDBOX_REGISTRY_LIMIT);
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "registry_cap",
    limit: SANDBOX_REGISTRY_LIMIT,
  });
});

test("edge: ToolInterface adapter routes through seam", async () => {
  const registry = new InProcessFakeToolRegistry();
  const descriptor = readTool("via-iface");
  registry.register({
    descriptor,
    effect: (args) => ({ via: args.q }),
  });
  const seam = createSandboxSeam({ registry, subjectId: "anika-k" });
  const tools = registry.asToolInterface(seam, "anika-k");
  const result = await tools.invoke(
    {
      toolName: "via-iface",
      arguments: { q: "ok" },
      invocationId: "inv-iface",
    },
    200,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, { via: "ok" });
  log({
    event: "runtime.harness.sandbox_seam",
    outcome: "ok",
    subjectId: "anika-k",
    case: "tool_interface_adapter",
  });
});
