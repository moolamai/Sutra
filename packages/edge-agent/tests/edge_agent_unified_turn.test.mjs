/**
 * AgentTurn delegates to CognitiveCore; no bypass loop.
 * Run: pnpm --filter @moolam/edge-agent test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { InProcessEventBus } from "@moolam/runtime";
import { TURN_COMPLETED } from "@moolam/observability";
import {
  createLocalVectorMemoryDriver,
  EdgeAgent,
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE_AGENT_SRC = join(HERE, "../src/edge_agent.ts");

function mockRuntime(opts = {}) {
  let generates = 0;
  return {
    card: {
      modelId: "mock-phi-unified",
      contextWindow: 4096,
      quantization: "q4",
      memoryFootprintMiB: 64,
      languages: ["en-IN"],
    },
    load: async () => {},
    unload: async () => {},
    generate:
      opts.generate ??
      (async ({ prompt }) => {
        generates += 1;
        return {
          text: `unified-reply:${prompt.length}`,
          tokensPerSecond: 40,
          finishReason: "stop",
        };
      }),
    generateStream: async function* ({ prompt }) {
      yield `unified-reply:${prompt.length}`;
    },
    embed: async (text) => {
      const out = new Float32Array(8);
      out[0] = (text.length % 97) / 97;
      out[1] = 0.35;
      return out;
    },
    _generates: () => generates,
  };
}

function friction(overrides = {}) {
  return {
    conceptId: "sd.hashing",
    hesitationMs: 500,
    inputVelocity: 3,
    revisionCount: 0,
    assistanceRequested: false,
    outcome: "correct",
    capturedAt: "000000000001000:000000:device-u",
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    subjectId: "subj-unified",
    deviceId: "device-unified",
    runtime: mockRuntime(),
    storage: createLocalVectorMemoryDriver(),
    profile: { ageBand: "adult", track: "math-l1", language: "en-IN" },
    attachEventBusSpans: false,
    ...overrides,
  };
}

test("source invariant: edge_agent.ts never calls SlmRuntime.generate directly", () => {
  const src = readFileSync(EDGE_AGENT_SRC, "utf8");
  assert.doesNotMatch(src, /runtime\.generate\s*\(/);
  assert.doesNotMatch(src, /config\.runtime\.generate/);
  assert.doesNotMatch(src, /buildPrompt\s*\(/);
  assert.match(src, /CognitiveCore/);
  assert.match(src, /\.turn\s*\(/);
});

test("happy path: agentTurn via CognitiveCore returns AgentReply and folds friction", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));
  const runtime = mockRuntime();

  const agent = new EdgeAgent(baseConfig({ eventBus: bus, runtime }));
  await agent.initialize();

  const reply = await agent.agentTurn("Explain hashing simply.", friction());

  assert.equal(reply.servedLocally, true);
  assert.equal(reply.conceptId, "sd.hashing");
  assert.match(reply.text, /^unified-reply:/);
  assert.ok(runtime._generates() >= 1, "model generate must run via adapter/core");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.servedLocally, true);
  assert.ok(agent.cognitiveState.mastery["sd.hashing"]);
  assert.ok(
    (agent.cognitiveState.mastery["sd.hashing"].alpha["device-unified"] ?? 0) > 0,
  );
  agent.dispose();
});

test("edge: CognitiveCore throw skips foldFriction and turn.completed", async () => {
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
    () => agent.agentTurn("partial turn", friction()),
    /deadline exceeded/,
  );
  assert.equal(seen.length, 0);
  assert.equal(
    Object.keys(agent.cognitiveState.mastery).length,
    0,
    "friction must not fold on core failure",
  );
  agent.dispose();
});

test("edge: permanently offline still serves locally", async () => {
  const agent = new EdgeAgent(baseConfig());
  await agent.initialize();

  const reply = await agent.agentTurn(
    "offline unified turn",
    friction({ conceptId: "offline.concept" }),
  );

  assert.equal(reply.servedLocally, true);
  assert.equal(reply.conceptId, "offline.concept");
  assert.equal((await agent.syncNow()).status, "offline-mode");
  agent.dispose();
});

test("edge: active conceptId maps to topicId on remember", async () => {
  const agent = new EdgeAgent(
    baseConfig({
      subjectId: "subj-topic-map",
      deviceId: "dev-topic-map",
    }),
  );
  await agent.initialize();

  const conceptId = "concept.topic.map";
  const utterance = "remember this concept";
  await agent.agentTurn(utterance, friction({ conceptId }));

  const hits = await agent.vectorDb.search(
    "subj-topic-map",
    await mockRuntime().embed(utterance),
    { conceptId, limit: 8 },
  );
  assert.ok(hits.length >= 1, "episode should persist under concept topic");
  assert.equal(hits[0].record.conceptId, conceptId);
  agent.dispose();
});

test("sovereignty: subject A turn never writes subject B mastery", async () => {
  const a = new EdgeAgent(
    baseConfig({
      subjectId: "subj-ua",
      deviceId: "dev-ua",
      storage: createLocalVectorMemoryDriver(),
    }),
  );
  const b = new EdgeAgent(
    baseConfig({
      subjectId: "subj-ub",
      deviceId: "dev-ub",
      storage: createLocalVectorMemoryDriver(),
    }),
  );
  await a.initialize();
  await b.initialize();

  await a.agentTurn("only A", friction({ conceptId: "a.only" }));
  await b.agentTurn("only B", friction({ conceptId: "b.only" }));

  assert.ok(a.cognitiveState.mastery["a.only"]);
  assert.equal(a.cognitiveState.mastery["b.only"], undefined);
  assert.ok(b.cognitiveState.mastery["b.only"]);
  assert.equal(b.cognitiveState.mastery["a.only"], undefined);
  a.dispose();
  b.dispose();
});

test("edge: concurrent turns on one agent serialize without dropping mastery", async () => {
  const agent = new EdgeAgent(baseConfig({ subjectId: "subj-conc" }));
  await agent.initialize();

  await Promise.all([
    agent.agentTurn("turn one", friction({ conceptId: "c.one", outcome: "correct" })),
    agent.agentTurn("turn two", friction({ conceptId: "c.two", outcome: "correct" })),
  ]);

  assert.ok(agent.cognitiveState.mastery["c.one"]);
  assert.ok(agent.cognitiveState.mastery["c.two"]);
  agent.dispose();
});
