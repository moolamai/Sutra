/**
 * EventBus wired into EdgeAgent construction + lifecycle ready.
 * Run: pnpm --filter @moolam/edge-agent test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus } from "@moolam/runtime";
import { EDGE_LIFECYCLE_READY } from "@moolam/observability";
import { EdgeAgent } from "../dist/index.js";

function memoryDriver() {
  return {
    async execute() {},
    async query() {
      return [];
    },
  };
}

function mockRuntime(opts = {}) {
  return {
    descriptor: {
      modelId: "mock-phi",
      quantization: "q4",
      contextWindow: 4096,
      languages: ["en-IN"],
    },
    load: opts.load ?? (async () => {}),
    generate: async ({ prompt }) => ({
      text: `reply-for:${prompt.slice(0, 24)}`,
      tokensPerSecond: 40,
      finishReason: "stop",
    }),
    embed: async () => Float32Array.from([0.1, 0.2, 0.3]),
  };
}

function baseConfig(overrides = {}) {
  return {
    subjectId: "subj-edge-a",
    deviceId: "device-a",
    runtime: mockRuntime(),
    storage: memoryDriver(),
    profile: { ageBand: "adult", track: "math-l1", language: "en-IN" },
    attachEventBusSpans: false,
    ...overrides,
  };
}

test("happy path: initialize publishes edge.lifecycle.ready on default bus", async () => {
  const agent = new EdgeAgent(baseConfig());
  const seen = [];
  agent.bus.subscribe(EDGE_LIFECYCLE_READY, (e) => seen.push(e));

  await agent.initialize();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, EDGE_LIFECYCLE_READY);
  assert.equal(seen[0].payload.subjectId, "subj-edge-a");
  assert.equal(seen[0].payload.deviceId, "device-a");
  assert.equal(seen[0].payload.outcome, "ok");
  assert.equal(seen[0].payload.connectivity, "offline-mode");
  const blob = JSON.stringify(seen[0]);
  assert.doesNotMatch(blob, /utterance|Explain|reply-for/i);
  agent.dispose();
});

test("edge: permanently offline (no transport) still emits lifecycle with offline-mode", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(EDGE_LIFECYCLE_READY, (e) => seen.push(e));

  const agent = new EdgeAgent(baseConfig({ eventBus: bus }));
  // no transport → sovereign offline
  await agent.initialize();

  assert.equal(seen[0].payload.connectivity, "offline-mode");
  const sync = await agent.syncNow();
  assert.equal(sync.status, "offline-mode");
  agent.dispose();
});

test("edge: runtime.load failure before ready → no lifecycle event (partial discard)", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(EDGE_LIFECYCLE_READY, (e) => seen.push(e));

  const agent = new EdgeAgent(
    baseConfig({
      eventBus: bus,
      runtime: mockRuntime({
        load: async () => {
          throw new Error("model weights unavailable");
        },
      }),
    }),
  );

  await assert.rejects(() => agent.initialize(), /model weights unavailable/);
  assert.equal(seen.length, 0);
  agent.dispose();
});

test("sovereignty: two subjects keep lifecycle events isolated on shared bus", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(EDGE_LIFECYCLE_READY, (e) => seen.push(e));

  const a = new EdgeAgent(
    baseConfig({ subjectId: "subj-iso-a", deviceId: "dev-a", eventBus: bus }),
  );
  const b = new EdgeAgent(
    baseConfig({ subjectId: "subj-iso-b", deviceId: "dev-b", eventBus: bus }),
  );

  await a.initialize();
  await b.initialize();

  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((e) => e.payload.subjectId).sort(),
    ["subj-iso-a", "subj-iso-b"],
  );
  // Negative: A must never observe B's subject on A's lifecycle payload alone.
  const onlyA = seen.find((e) => e.payload.subjectId === "subj-iso-a");
  assert.notEqual(onlyA.payload.subjectId, "subj-iso-b");
  assert.doesNotMatch(JSON.stringify(onlyA), /subj-iso-b/);

  a.dispose();
  b.dispose();
});

test("observability: re-initialize is idempotent (single ready event)", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(EDGE_LIFECYCLE_READY, (e) => seen.push(e));

  const agent = new EdgeAgent(baseConfig({ eventBus: bus }));
  await agent.initialize();
  await agent.initialize();
  assert.equal(seen.length, 1);
  agent.dispose();
});

test("public AgentReply shape unchanged after turn (no bus fields)", async () => {
  const agent = new EdgeAgent(baseConfig());
  await agent.initialize();

  const reply = await agent.agentTurn("Explain hashing.", {
    conceptId: "sd.hashing",
    hesitationMs: 500,
    inputVelocity: 3,
    revisionCount: 0,
    assistanceRequested: false,
    outcome: "ungraded",
    capturedAt: "000000000001000:000000:device-a",
  });

  assert.equal(reply.servedLocally, true);
  assert.equal(reply.conceptId, "sd.hashing");
  assert.equal(typeof reply.text, "string");
  assert.deepEqual(Object.keys(reply).sort(), [
    "conceptId",
    "servedLocally",
    "text",
  ]);
  agent.dispose();
});
