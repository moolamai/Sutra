/**
 * Catalog-valid turn.completed after every on-device reply.
 * Run: pnpm --filter @moolam/edge-agent test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus } from "@moolam/runtime";
import {
  hashOpCode,
  parseCatalogEvent,
  TURN_COMPLETED,
} from "@moolam/observability";
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
    load: async () => {},
    generate:
      opts.generate ??
      (async ({ prompt }) => ({
        text: `SECRET_REPLY_BODY for ${prompt.length}`,
        tokensPerSecond: 40,
        finishReason: "stop",
      })),
    embed: async () => Float32Array.from([0.1, 0.2, 0.3]),
  };
}

function friction(overrides = {}) {
  return {
    conceptId: "sd.hashing",
    hesitationMs: 500,
    inputVelocity: 3,
    revisionCount: 0,
    assistanceRequested: false,
    outcome: "ungraded",
    capturedAt: "000000000001000:000000:device-a",
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    subjectId: "subj-turn-a",
    deviceId: "device-turn-a",
    runtime: mockRuntime(),
    storage: memoryDriver(),
    profile: { ageBand: "adult", track: "math-l1", language: "en-IN" },
    attachEventBusSpans: false,
    ...overrides,
  };
}

test("happy path: agentTurn publishes catalog-valid turn.completed", async () => {
  // Bare bus: lifecycle ready (001) is not yet cataloged; turn.completed is.
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));

  const agent = new EdgeAgent(baseConfig({ eventBus: bus }));
  await agent.initialize();

  const utterance = "Explain consistent hashing with SECRET_UTTERANCE.";
  const reply = await agent.agentTurn(utterance, friction());

  assert.equal(seen.length, 1);
  const parsed = parseCatalogEvent(seen[0]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.type, TURN_COMPLETED);
  assert.equal(parsed.event.payload.subjectId, "subj-turn-a");
  assert.equal(parsed.event.payload.deviceId, "device-turn-a");
  assert.equal(parsed.event.payload.conceptId, "sd.hashing");
  assert.equal(parsed.event.payload.servedLocally, true);
  assert.ok(parsed.event.payload.latencyMs >= 0);
  assert.match(parsed.event.payload.turnIdHash, /^[a-f0-9]{16}$/);
  assert.equal(reply.servedLocally, true);

  const blob = JSON.stringify(seen[0]);
  assert.doesNotMatch(blob, /SECRET_UTTERANCE|SECRET_REPLY_BODY|Explain consistent/i);
  agent.dispose();
});

test("edge: generate failure before fold → no turn.completed (CAST-01 discard)", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));

  const agent = new EdgeAgent(
    baseConfig({
      eventBus: bus,
      runtime: mockRuntime({
        generate: async () => {
          throw new Error("deadline exceeded");
        },
      }),
    }),
  );
  await agent.initialize();

  await assert.rejects(
    () => agent.agentTurn("partial turn utterance", friction()),
    /deadline exceeded/,
  );
  assert.equal(seen.length, 0);
  agent.dispose();
});

test("edge: offline host still emits turn.completed with servedLocally true", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));

  const agent = new EdgeAgent(baseConfig({ eventBus: bus }));
  // no transport
  await agent.initialize();
  await agent.agentTurn("offline turn", friction({ conceptId: "offline.concept" }));

  assert.equal(seen[0].payload.servedLocally, true);
  assert.equal(seen[0].payload.conceptId, "offline.concept");
  assert.equal(parseCatalogEvent(seen[0]).ok, true);
  assert.equal((await agent.syncNow()).status, "offline-mode");
  agent.dispose();
});

test("sovereignty: subject A turn.completed never carries subject B", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));

  const a = new EdgeAgent(
    baseConfig({ subjectId: "subj-ta", deviceId: "dev-ta", eventBus: bus }),
  );
  const b = new EdgeAgent(
    baseConfig({ subjectId: "subj-tb", deviceId: "dev-tb", eventBus: bus }),
  );
  await a.initialize();
  await b.initialize();

  await a.agentTurn("only A", friction({ conceptId: "a.only" }));
  await b.agentTurn("only B", friction({ conceptId: "b.only" }));

  assert.equal(seen.length, 2);
  const onlyA = seen.find((e) => e.payload.subjectId === "subj-ta");
  assert.ok(onlyA);
  assert.equal(onlyA.payload.conceptId, "a.only");
  assert.equal(parseCatalogEvent(onlyA).ok, true);
  assert.doesNotMatch(JSON.stringify(onlyA), /subj-tb|b\.only/);
  a.dispose();
  b.dispose();
});

test("observability: turnId is hashed — raw UUID never on the bus", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));

  const agent = new EdgeAgent(baseConfig({ eventBus: bus }));
  await agent.initialize();
  await agent.agentTurn("hash check", friction());

  const hash = seen[0].payload.turnIdHash;
  assert.equal(hash.length, 16);
  assert.notEqual(hash, hashOpCode("hash check")); // utterance is never the turnId
  assert.doesNotMatch(JSON.stringify(seen[0]), /[0-9a-f-]{36}/i);
  agent.dispose();
});
