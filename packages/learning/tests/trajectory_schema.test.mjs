/**
 * TurnTrajectoryRecord training-field extensions (C0 schema finalization).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROUTER_REPLAY_MAP_FORWARD_COMPAT,
  TRAJECTORY_SCHEMA_VERSION,
  assertTrajectoryExportConsent,
  enqueueTrajectoryWrite,
  parseTurnTrajectoryRecord,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function b9Base(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "anika-k",
    sessionId: "sess-1",
    turnId: "turn-1",
    deviceId: "edge-aaaa",
    capturedAt: "2026-07-15T18:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T18:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.invoke", status: "ok" }],
    ...overrides,
  };
}

test("happy path: B9 record without training fields parses (additive)", () => {
  const parsed = parseTurnTrajectoryRecord(b9Base());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.schemaVersion, "trajectory.v1");
  assert.equal(parsed.record.policyCheckpointHash, undefined);
  assert.equal(parsed.record.routerReplayMap, undefined);
  assert.equal(ROUTER_REPLAY_MAP_FORWARD_COMPAT.denseSlmMayOmit, true);
  log({
    event: "learning.trajectory",
    outcome: "ok",
    case: "b9_base",
    subjectId: parsed.subjectId,
  });
});

test("happy path: training fields round-trip including routerReplayMap", () => {
  const parsed = parseTurnTrajectoryRecord(
    b9Base({
      policyCheckpointHash: "sha256:abcdef0123456789",
      rolloutSeed: 42,
      precisionFormat: "int4",
      executionState: {
        commandExecuted: "tool.persist",
        statusCode: "aborted",
      },
      routerReplayMap: { intent: "route-a", fallback: "dense-slm" },
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.policyCheckpointHash, "sha256:abcdef0123456789");
  assert.equal(parsed.record.rolloutSeed, 42);
  assert.equal(parsed.record.precisionFormat, "int4");
  assert.equal(parsed.record.executionState.commandExecuted, "tool.persist");
  assert.deepEqual(parsed.record.routerReplayMap, {
    intent: "route-a",
    fallback: "dense-slm",
  });
});

test("edge: dense SLM omits routerReplayMap — still valid", () => {
  const parsed = parseTurnTrajectoryRecord(
    b9Base({
      policyCheckpointHash: "ckpt-abc12345",
      precisionFormat: "fp16",
      executionState: { commandExecuted: "model.generate", statusCode: 200 },
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.routerReplayMap, undefined);
});

test("edge: floating policyCheckpointHash 'latest' rejected", () => {
  const parsed = parseTurnTrajectoryRecord(
    b9Base({ policyCheckpointHash: "latest" }),
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.failureClass, "floating_checkpoint");
});

test("edge: stream abort records executionState (not omitted)", () => {
  const parsed = parseTurnTrajectoryRecord(
    b9Base({
      stages: [{ stage: "act", status: "aborted" }],
      executionState: {
        commandExecuted: "tool.write",
        statusCode: "stream_aborted",
      },
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.executionState.commandExecuted, "tool.write");
  assert.equal(parsed.record.executionState.statusCode, "stream_aborted");
});

test("edge: raw keystrokes forbidden", () => {
  const parsed = parseTurnTrajectoryRecord(
    b9Base({ keystrokes: "typed-secret" }),
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.failureClass, "keystroke_forbidden");
});

test("sovereignty: consent gate denies export without opt-in", () => {
  const parsed = parseTurnTrajectoryRecord(
    b9Base({
      consent: {
        optedIn: false,
        consentClass: "research",
        recordedAt: "2026-07-15T18:00:00.000Z",
      },
    }),
  );
  assert.equal(parsed.ok, true);
  const gate = assertTrajectoryExportConsent(parsed.record);
  assert.equal(gate.ok, false);
  assert.equal(gate.failureClass, "consent_denied");

  const allowed = assertTrajectoryExportConsent(
    parseTurnTrajectoryRecord(b9Base()).record,
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.subjectId, "anika-k");
});

test("edge: async write queues without blocking the turn", async () => {
  let writerStarted = false;
  let writerDone = false;
  const telemetry = [];

  const record = parseTurnTrajectoryRecord(b9Base()).record;
  const result = enqueueTrajectoryWrite(
    record,
    async () => {
      writerStarted = true;
      await new Promise((r) => setTimeout(r, 40));
      writerDone = true;
    },
    { onTelemetry: (e) => telemetry.push(e) },
  );

  assert.equal(result.queued, true);
  assert.equal(writerDone, false);
  assert.ok(telemetry.some((t) => t.outcome === "queued"));
  assert.ok(!JSON.stringify(telemetry).includes("learner"));

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(writerStarted, true);
  assert.equal(writerDone, true);
  assert.ok(telemetry.some((t) => t.outcome === "ok"));
});

test("fixture: schemas/trajectory/v1.json documents training fields + forward-compat", () => {
  const schemaPath = join(REPO_ROOT, "schemas", "trajectory", "v1.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.equal(schema.title, "TurnTrajectoryRecord");
  assert.ok(schema.properties.policyCheckpointHash);
  assert.ok(schema.properties.rolloutSeed);
  assert.ok(schema.properties.precisionFormat);
  assert.ok(schema.properties.executionState);
  assert.ok(schema.properties.routerReplayMap);
  assert.equal(schema.properties.routerReplayMap.description.includes("omit"), true);
  assert.equal(schema["x-forward-compat"].routerReplayMap.denseSlmMayOmit, true);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.keystrokes, undefined);
});
