/**
 * CognitiveBindings factory for EdgeAgent.
 * Run: pnpm --filter @moolam/edge-agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CognitiveCore } from "@moolam/cognitive-core";
import {
  EdgeAgent,
  createEdgeCognitiveBindings,
  createLocalVectorMemoryDriver,
  LocalVectorDb,
  mapConceptIdToTopicId,
  mapTrackToDomainId,
} from "../dist/index.js";

const SECRET = "SECRET_BINDINGS_MUST_NOT_LEAK";

function mockRuntime(overrides = {}) {
  let generates = 0;
  return {
    card: {
      modelId: "mock-phi-bind",
      contextWindow: 4096,
      quantization: "q4",
      memoryFootprintMiB: 64,
      languages: ["en"],
      ...overrides.card,
    },
    load: async () => {},
    unload: async () => {},
    generate: async ({ prompt }) => {
      generates += 1;
      return {
        text: `on-device:${prompt.length}`,
        tokensPerSecond: 40,
        finishReason: "stop",
      };
    },
    generateStream: async function* ({ prompt }) {
      const t = `on-device:${prompt.length}`;
      yield t.slice(0, 5);
      yield t.slice(5);
    },
    embed: async (text) => {
      const out = new Float32Array(8);
      out[0] = (text.length % 97) / 97;
      out[1] = 0.4;
      return out;
    },
    _generates: () => generates,
  };
}

test("happy path: factory assembles all CognitiveBindings primitives", async () => {
  const events = [];
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const runtime = mockRuntime();

  const { bindings, profile, topicId } = createEdgeCognitiveBindings({
    subjectId: "subj-bind",
    deviceId: "dev-bind",
    runtime,
    vectorDb: db,
    track: "math-l1",
    language: "en-IN",
    activeConceptId: "sd.hashing",
    emit: (e) => events.push(e),
  });

  assert.equal(profile.domainId, "edge.math-l1");
  assert.equal(topicId, "sd.hashing");
  assert.ok(bindings.memory && bindings.model);
  assert.ok(bindings.reasoning && bindings.planning);
  assert.ok(bindings.tools && bindings.knowledge);
  assert.equal(bindings.model.descriptor.locality, "on-device");
  assert.equal(bindings.knowledge.sources[0].locality, "bundled-offline");

  const gen = await bindings.model.generate(
    [{ role: "user", content: "hello" }],
    { deadlineMs: 2_000 },
  );
  assert.match(gen.text, /^on-device:/);
  assert.equal(runtime._generates(), 1);

  await bindings.memory.remember({
    subjectId: "subj-bind",
    topicId,
    text: "pin memory",
    kind: "episodic",
    createdAt: new Date().toISOString(),
  });
  const hits = await bindings.memory.recall({
    subjectId: "subj-bind",
    query: "pin",
    topicId,
  });
  assert.ok(hits.length >= 1);

  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.cognitive_bindings" &&
        e.outcome === "ok" &&
        e.subjectId === "subj-bind" &&
        e.servedLocally === true,
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_|hello|pin memory/);
});

test("happy path: injected speech lands on CognitiveBindings", async () => {
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const speech = {
    supportedLanguages: ["hi-IN", "en-IN"],
    async *transcribe() {
      yield {
        text: "partial",
        language: "en-IN",
        startMs: 0,
        endMs: 1,
        confidence: 0.7,
        isFinal: false,
      };
      yield {
        text: "final",
        language: "en-IN",
        startMs: 0,
        endMs: 2,
        confidence: 0.9,
        isFinal: true,
      };
    },
    async *synthesize() {
      yield { data: new Uint8Array([1, 2]), sampleRateHz: 16_000 };
    },
  };
  const events = [];
  const { bindings } = createEdgeCognitiveBindings({
    subjectId: "subj-speech",
    deviceId: "dev-speech",
    runtime: mockRuntime(),
    vectorDb: db,
    track: "math-l1",
    language: "en-IN",
    speech,
    emit: (e) => events.push(e),
  });
  assert.equal(bindings.speech, speech);
  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.cognitive_bindings" &&
        e.hasSpeech === true &&
        e.outcome === "ok",
    ),
  );

  const agent = new EdgeAgent({
    subjectId: "subj-speech-ea",
    deviceId: "dev-speech-ea",
    runtime: mockRuntime(),
    storage: createLocalVectorMemoryDriver(),
    speech,
    profile: { ageBand: "adult", track: "math-l1", language: "en-IN" },
    attachEventBusSpans: false,
  });
  await agent.initialize();
  const bundle = agent.buildCognitiveBindings();
  assert.equal(bundle.bindings.speech, speech);
});

test("edge: omitting speech keeps text-only binding set", async () => {
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const { bindings } = createEdgeCognitiveBindings({
    subjectId: "subj-nospeech",
    deviceId: "dev-nospeech",
    runtime: mockRuntime(),
    vectorDb: db,
    track: "math-l1",
    language: "en",
  });
  assert.equal(bindings.speech, undefined);
});

test("happy path: injected vision lands on CognitiveBindings", async () => {
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const vision = {
    maxInputBytes: 1024,
    analyze: async () => ({
      answer: '{"label":"probe","score":0.9}',
      confidence: 0.9,
    }),
  };
  const events = [];
  const { bindings } = createEdgeCognitiveBindings({
    subjectId: "subj-vision",
    deviceId: "dev-vision",
    runtime: mockRuntime(),
    vectorDb: db,
    track: "math-l1",
    language: "en-IN",
    vision,
    emit: (e) => events.push(e),
  });
  assert.equal(bindings.vision, vision);
  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.cognitive_bindings" &&
        e.hasVision === true &&
        e.outcome === "ok",
    ),
  );

  const agent = new EdgeAgent({
    subjectId: "subj-vision-ea",
    deviceId: "dev-vision-ea",
    runtime: mockRuntime(),
    storage: createLocalVectorMemoryDriver(),
    vision,
    profile: { ageBand: "adult", track: "math-l1", language: "en-IN" },
    attachEventBusSpans: false,
  });
  await agent.initialize();
  const bundle = agent.buildCognitiveBindings();
  assert.equal(bundle.bindings.vision, vision);
});

test("edge: omitting vision keeps text-only binding set", async () => {
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const { bindings } = createEdgeCognitiveBindings({
    subjectId: "subj-novision",
    deviceId: "dev-novision",
    runtime: mockRuntime(),
    vectorDb: db,
    track: "math-l1",
    language: "en",
  });
  assert.equal(bindings.vision, undefined);
});

test("happy path: EdgeAgent.buildCognitiveBindings maps track/concept", async () => {
  const agent = new EdgeAgent({
    subjectId: "subj-ea",
    deviceId: "dev-ea",
    runtime: mockRuntime(),
    storage: createLocalVectorMemoryDriver(),
    profile: { ageBand: "adult", track: "system-design-l5", language: "en-IN" },
    attachEventBusSpans: false,
  });
  await agent.initialize();
  const bundle = agent.buildCognitiveBindings({
    activeConceptId: "sd.consistent-hashing",
  });
  assert.equal(bundle.profile.domainId, mapTrackToDomainId("system-design-l5"));
  assert.equal(
    bundle.topicId,
    mapConceptIdToTopicId("sd.consistent-hashing"),
  );
  assert.equal(bundle.bindings.model.descriptor.locality, "on-device");
});

test("happy path: CognitiveCore.turn accepts edge bindings (factory smoke)", async () => {
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const { bindings, profile } = createEdgeCognitiveBindings({
    subjectId: "subj-core",
    deviceId: "dev-core",
    runtime: mockRuntime(),
    vectorDb: db,
    track: "math-l1",
    language: "en",
    activeConceptId: "fractions",
  });

  const core = new CognitiveCore(profile, bindings);
  const out = await core.turn({
    subjectId: "subj-core",
    sessionId: "sess-core",
    utterance: "What is a ratio?",
  });
  assert.equal(typeof out.reply, "string");
  assert.ok(out.reply.length > 0);
  assert.equal(out.declined, false);
});

test("edge: missing subjectId fails typed; permanently offline still assembles", async () => {
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();

  assert.throws(
    () =>
      createEdgeCognitiveBindings({
        subjectId: "  ",
        deviceId: "dev-x",
        runtime: mockRuntime(),
        vectorDb: db,
        track: "t",
        language: "en",
      }),
    /subjectId/i,
  );

  const agent = new EdgeAgent({
    subjectId: "subj-off",
    deviceId: "dev-off",
    runtime: mockRuntime(),
    storage: createLocalVectorMemoryDriver(),
    // no transport — permanently offline
    profile: { ageBand: "adult", track: "math-l1", language: "en" },
    attachEventBusSpans: false,
  });
  await agent.initialize();
  const bundle = agent.buildCognitiveBindings();
  assert.equal(bundle.bindings.model.descriptor.locality, "on-device");
  assert.deepEqual(await bundle.bindings.knowledge.retrieve({ query: "x" }), []);
});

test("sovereignty: per-subject bindings isolate memory; events scrub content", async () => {
  const events = [];
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();

  const a = createEdgeCognitiveBindings({
    subjectId: "subj-a",
    deviceId: "dev-a",
    runtime: mockRuntime(),
    vectorDb: db,
    track: "t",
    language: "en",
    activeConceptId: "c1",
    emit: (e) => events.push(e),
  });
  const b = createEdgeCognitiveBindings({
    subjectId: "subj-b",
    deviceId: "dev-b",
    runtime: mockRuntime(),
    vectorDb: db,
    track: "t",
    language: "en",
    activeConceptId: "c1",
    emit: (e) => events.push(e),
  });

  await a.bindings.memory.remember({
    subjectId: "subj-a",
    topicId: a.topicId,
    text: SECRET,
    kind: "episodic",
    createdAt: new Date().toISOString(),
  });
  const hitsB = await b.bindings.memory.recall({
    subjectId: "subj-b",
    query: "hash",
    topicId: b.topicId,
  });
  assert.ok(!hitsB.some((h) => h.item.text.includes("SECRET")));
  assert.doesNotMatch(JSON.stringify(events), /SECRET_BINDINGS/);
});

test("map helpers: empty concept/track fall back deterministically", () => {
  assert.equal(mapConceptIdToTopicId(null), "edge.general");
  assert.equal(mapConceptIdToTopicId("  "), "edge.general");
  assert.equal(mapTrackToDomainId(""), "edge.offline");
  assert.equal(mapTrackToDomainId("math-l1"), "edge.math-l1");
});
