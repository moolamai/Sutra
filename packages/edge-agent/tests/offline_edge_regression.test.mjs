/**
 * Offline-edge golden regression suite.
 * Fixture: examples/offline-edge/golden-turn.json
 *
 * Pre-unification (bypass embed→SlmRuntime.generate) would omit CognitiveCore
 * and could drop fold assertions; this suite requires the unified path.
 * Run: pnpm --filter @moolam/edge-agent test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InProcessEventBus } from "@moolam/runtime";
import { parseCatalogEvent, TURN_COMPLETED } from "@moolam/observability";
import {
  createLocalVectorMemoryDriver,
  EdgeAgent,
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(
  HERE,
  "../../../examples/offline-edge/golden-turn.json",
);
const EDGE_AGENT_SRC = join(HERE, "../src/edge_agent.ts");
const EXAMPLE_MAIN = join(HERE, "../../../examples/offline-edge/main.mjs");

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));

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
        text: `On-device reply grounded in prompt of ${prompt.length} chars.`,
        tokensPerSecond: 42,
        finishReason: "stop",
      })),
    embed: async (text) => {
      // Deterministic small vector (no contract-mocks dependency in this pkg).
      const out = new Float32Array(8);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
      out[0] = (h % 997) / 997;
      out[1] = 0.42;
      return out;
    },
  };
}

function agentFromGolden(overrides = {}) {
  return new EdgeAgent({
    subjectId: golden.subjectId,
    deviceId: golden.deviceId,
    runtime: mockRuntime(),
    storage: createLocalVectorMemoryDriver(),
    profile: golden.profile,
    attachEventBusSpans: false,
    ...overrides,
  });
}

test("fixture: golden-turn names UNIFEDGETU-003 and offline-edge inputs", () => {
  assert.equal(golden.specId, "TASK-B-B3-EDGECOREUN-UNIFEDGETU-003");
  assert.equal(golden.designId, "DESIGN-B-B3-EDGECOREUN-UNIFEDGETU");
  assert.equal(golden.utterance, "Explain consistent hashing simply.");
  assert.equal(golden.friction.conceptId, "sd.consistent-hashing");
  assert.match(
    readFileSync(EXAMPLE_MAIN, "utf8"),
    /golden-turn\.json/,
  );
});

test("source invariant: unified path — no SlmRuntime.generate in edge_agent.ts", () => {
  const src = readFileSync(EDGE_AGENT_SRC, "utf8");
  assert.match(src, /CognitiveCore/);
  assert.doesNotMatch(src, /config\.runtime\.generate/);
  assert.doesNotMatch(src, /runtime\.generate\s*\(/);
});

test("happy path: offline-edge golden — servedLocally, friction fold, offline sync", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));

  const agent = agentFromGolden({ eventBus: bus });
  await agent.initialize();

  const reply = await agent.agentTurn(golden.utterance, {
    ...golden.friction,
  });
  const sync = await agent.syncNow();

  assert.equal(reply.servedLocally, golden.expect.servedLocally);
  assert.equal(reply.conceptId, golden.expect.conceptId);
  assert.ok(reply.text.startsWith(golden.expect.replyTextPrefix));
  assert.deepEqual(
    Object.keys(reply).sort(),
    [...golden.expect.replyKeys].sort(),
  );
  assert.equal(sync.status, golden.expect.syncStatus);

  const mastery = agent.cognitiveState.mastery[golden.expect.conceptId];
  assert.ok(mastery, "foldFriction must create mastery after golden turn");
  assert.equal(mastery.lastExercisedAt, golden.friction.capturedAt);

  assert.equal(seen.length, 1);
  assert.equal(parseCatalogEvent(seen[0]).ok, true);
  assert.equal(seen[0].payload.servedLocally, true);
  assert.equal(seen[0].payload.subjectId, golden.subjectId);
  assert.equal(seen[0].payload.deviceId, golden.deviceId);
  assert.doesNotMatch(
    JSON.stringify(seen[0]),
    new RegExp(golden.utterance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  agent.dispose();
});

test("edge: CognitiveCore throw → friction not folded (CAST-01)", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));

  const agent = agentFromGolden({
    eventBus: bus,
    runtime: mockRuntime({
      generate: async () => {
        throw new Error("deadline exceeded");
      },
    }),
  });
  await agent.initialize();

  await assert.rejects(
    () => agent.agentTurn(golden.utterance, { ...golden.friction }),
    /deadline exceeded/,
  );
  assert.equal(seen.length, 0);
  assert.equal(
    agent.cognitiveState.mastery[golden.expect.conceptId],
    undefined,
  );
  agent.dispose();
});

test("edge: conceptId maps to topicId on remember for golden concept", async () => {
  const agent = agentFromGolden({
    subjectId: "subj-offline-topic",
    deviceId: "dev-offline-topic",
  });
  await agent.initialize();

  await agent.agentTurn(golden.utterance, { ...golden.friction });
  const hits = await agent.vectorDb.search(
    "subj-offline-topic",
    await mockRuntime().embed(golden.utterance),
    { conceptId: golden.expect.conceptId, limit: 8 },
  );
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].record.conceptId, golden.expect.conceptId);
  agent.dispose();
});

test("sovereignty: golden subject mastery never bleeds across subjects", async () => {
  const a = agentFromGolden({
    subjectId: "subj-oa",
    deviceId: "dev-oa",
    storage: createLocalVectorMemoryDriver(),
  });
  const b = agentFromGolden({
    subjectId: "subj-ob",
    deviceId: "dev-ob",
    storage: createLocalVectorMemoryDriver(),
  });
  await a.initialize();
  await b.initialize();

  await a.agentTurn(golden.utterance, {
    ...golden.friction,
    conceptId: "a.only",
    capturedAt: "000000017000001:000000:dev-oa",
  });
  await b.agentTurn(golden.utterance, {
    ...golden.friction,
    conceptId: "b.only",
    capturedAt: "000000017000002:000000:dev-ob",
  });

  assert.ok(a.cognitiveState.mastery["a.only"]);
  assert.equal(a.cognitiveState.mastery["b.only"], undefined);
  assert.ok(b.cognitiveState.mastery["b.only"]);
  assert.equal(b.cognitiveState.mastery["a.only"], undefined);
  a.dispose();
  b.dispose();
});

test("edge: concurrent golden turns serialize without dropping mastery folds", async () => {
  const agent = agentFromGolden({ subjectId: "subj-conc-offline" });
  await agent.initialize();

  await Promise.all([
    agent.agentTurn(golden.utterance, {
      ...golden.friction,
      conceptId: "c.one",
      capturedAt: "000000017000010:000000:edge-demo-device",
    }),
    agent.agentTurn(golden.utterance, {
      ...golden.friction,
      conceptId: "c.two",
      capturedAt: "000000017000011:000000:edge-demo-device",
    }),
  ]);

  assert.ok(agent.cognitiveState.mastery["c.one"]);
  assert.ok(agent.cognitiveState.mastery["c.two"]);
  agent.dispose();
});
