/**
 * Edge post-reflect trajectory hook: active consent, absent-consent skip,
 * subject isolation, and CognitiveCore completion wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EdgeAgent } from "../dist/index.js";
import { EdgeTrajectoryCaptureWriter } from "../dist/trajectory_capture.js";

function trajectoryDriver() {
  const pending = new Map();
  const stored = new Map();
  let writes = 0;
  return {
    pending,
    stored,
    get writes() {
      return writes;
    },
    async execute(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return;
      if (sql.includes("INSERT OR IGNORE INTO trajectory_write_ahead")) {
        writes++;
        pending.set(`${params[0]}\0${params[1]}`, String(params[4]));
        return;
      }
      if (sql.includes("INSERT OR IGNORE INTO turn_trajectories")) {
        writes++;
        stored.set(`${params[0]}\0${params[1]}`, JSON.parse(String(params[6])));
        return;
      }
      if (sql.includes("DELETE FROM trajectory_write_ahead")) {
        writes++;
        pending.delete(`${params[0]}\0${params[1]}`);
        return;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async query() {
      return [];
    },
  };
}

function hookInput(overrides = {}) {
  return {
    turnId: "turn-edge-hook-1",
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    sessionId: "session-edge-1",
    capturedAt: "001700000000100:000002:edge-dev1",
    utterance: "SECRET_EDGE_UTTERANCE",
    reply: "SECRET_EDGE_REPLY",
    modelId: "edge-model-v1",
    declined: false,
    ...overrides,
  };
}

function activeConsent() {
  return {
    consentRecordId: "consent-traj-edge-1",
    subjectId: "learner-a",
    scope: "trajectory",
    optedIn: true,
    active: true,
  };
}

test("active consent schedules post-reflect hash and queues metadata only", async () => {
  const storage = trajectoryDriver();
  const events = [];
  const writer = new EdgeTrajectoryCaptureWriter({
    storage,
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    resolveActiveConsentRecordId: () => "consent-traj-edge-1",
    resolveConsent: () => activeConsent(),
    onHookTelemetry: (event) => events.push(event),
  });
  await writer.initialize();

  const scheduled = writer.captureAfterReflect(hookInput());
  assert.equal(scheduled.scheduled, true);
  assert.equal(storage.stored.size, 0, "turn path must not await hashing/storage");
  assert.equal(await writer.flush(1_000), true);
  assert.equal(storage.stored.size, 1);

  const record = [...storage.stored.values()][0];
  assert.equal(record.consentRecordId, "consent-traj-edge-1");
  assert.equal(record.subjectId, "learner-a");
  assert.match(record.promptHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(record.responseHash, /^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /SECRET_EDGE_UTTERANCE|SECRET_EDGE_REPLY/);
  assert.ok(events.some((event) => event.outcome === "scheduled"));
  assert.ok(events.some((event) => event.outcome === "queued"));
  assert.doesNotMatch(JSON.stringify(events), /SECRET_EDGE_UTTERANCE|SECRET_EDGE_REPLY/);
});

test("absent consent skips capture and creates no empty record", async () => {
  const storage = trajectoryDriver();
  const events = [];
  const writer = new EdgeTrajectoryCaptureWriter({
    storage,
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    resolveActiveConsentRecordId: () => null,
    resolveConsent: () => null,
    onHookTelemetry: (event) => events.push(event),
  });
  await writer.initialize();

  const result = writer.captureAfterReflect(hookInput());
  assert.equal(result.scheduled, false);
  assert.equal(result.failureClass, "consent_missing");
  assert.equal(await writer.flush(100), true);
  assert.equal(storage.writes, 0);
  assert.equal(storage.stored.size, 0);
  assert.ok(
    events.some(
      (event) =>
        event.outcome === "skipped" &&
        event.failureClass === "consent_missing",
    ),
  );
});

test("cross-subject hook input is rejected before hashing or storage", async () => {
  const storage = trajectoryDriver();
  const writer = new EdgeTrajectoryCaptureWriter({
    storage,
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    resolveActiveConsentRecordId: () => "consent-traj-edge-1",
    resolveConsent: () => activeConsent(),
  });
  await writer.initialize();

  const result = writer.captureAfterReflect(
    hookInput({ subjectId: "learner-b" }),
  );
  assert.equal(result.scheduled, false);
  assert.equal(result.failureClass, "cross_subject");
  assert.equal(storage.writes, 0);
});

function edgeRuntime({ fail = false } = {}) {
  return {
    card: {
      modelId: "edge-hook-model",
      contextWindow: 4096,
      quantization: "q4",
      memoryFootprintMiB: 64,
      languages: ["en-IN"],
    },
    load: async () => {},
    unload: async () => {},
    generate: async () => {
      if (fail) throw new Error("model failed");
      return {
        text: "edge hook reply",
        tokensPerSecond: 30,
        finishReason: "stop",
      };
    },
    generateStream: async function* () {
      yield "edge hook reply";
    },
    embed: async () => Float32Array.from([0.1, 0.2, 0.3]),
  };
}

function permissiveStorage() {
  return {
    async execute() {},
    async query() {
      return [];
    },
  };
}

function friction() {
  return {
    conceptId: "math.ratios",
    hesitationMs: 100,
    inputVelocity: 2,
    revisionCount: 0,
    assistanceRequested: false,
    outcome: "correct",
    capturedAt: "001700000000200:000001:edge-dev1",
  };
}

test("EdgeAgent invokes hook only after successful CognitiveCore reflect", async () => {
  const calls = [];
  const hook = {
    initialized: false,
    async initialize() {
      this.initialized = true;
    },
    captureAfterReflect(input) {
      calls.push(input);
      return {
        scheduled: true,
        subjectId: input.subjectId,
        turnId: input.turnId,
      };
    },
  };
  const agent = new EdgeAgent({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    runtime: edgeRuntime(),
    storage: permissiveStorage(),
    profile: { ageBand: "adult", track: "math", language: "en-IN" },
    attachEventBusSpans: false,
    trajectoryCaptureWriter: hook,
  });
  await agent.initialize();
  assert.equal(hook.initialized, true);

  await agent.agentTurn("edge hook utterance", friction());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subjectId, "learner-a");
  assert.equal(calls[0].capturedAt, friction().capturedAt);
  assert.equal(calls[0].modelId, "edge-hook-model");
  agent.dispose();

  const failedCalls = [];
  const failed = new EdgeAgent({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    runtime: edgeRuntime({ fail: true }),
    storage: permissiveStorage(),
    profile: { ageBand: "adult", track: "math", language: "en-IN" },
    attachEventBusSpans: false,
    trajectoryCaptureWriter: {
      async initialize() {},
      captureAfterReflect(input) {
        failedCalls.push(input);
      },
    },
  });
  await failed.initialize();
  await assert.rejects(
    () => failed.agentTurn("failed edge turn", friction()),
    /model failed/,
  );
  assert.equal(failedCalls.length, 0);
  failed.dispose();
});
