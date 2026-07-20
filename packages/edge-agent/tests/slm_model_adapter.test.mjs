/**
 * SlmRuntime → ModelInterface generate/stream + deadline.
 * Run: pnpm --filter @moolam/edge-agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatPromptAssemblyError,
  EDGE_MODEL_OBLIGATION_DEADLINE,
  EDGE_MODEL_OBLIGATION_EMBED_DIM,
  EDGE_MODEL_OBLIGATION_INIT,
  EDGE_PROMPT_OBLIGATION_EMPTY,
  SlmModelAdapterError,
  assembleChatMessagesToPrompt,
  createSlmModelAdapter,
  toStreamDeltas,
} from "../dist/index.js";

const SECRET = "SECRET_ADAPTER_UTTERANCE_MUST_NOT_LEAK";

function card(overrides = {}) {
  return {
    modelId: "mock-phi-adapter",
    contextWindow: 4096,
    quantization: "q4",
    memoryFootprintMiB: 128,
    languages: ["en"],
    ...overrides,
  };
}

function mockRuntime(overrides = {}) {
  let generateCalls = 0;
  let streamCalls = 0;
  const rt = {
    card: card(overrides.card),
    load: async () => {},
    unload: async () => {},
    generate:
      overrides.generate ??
      (async ({ prompt, deadlineMs }) => {
        generateCalls += 1;
        if (overrides.slowMs) {
          await new Promise((r) => setTimeout(r, overrides.slowMs));
        }
        return {
          text: `echo:${prompt.length}`,
          tokensPerSecond: 40,
          finishReason: "stop",
          _deadlineMs: deadlineMs,
        };
      }),
    generateStream:
      overrides.generateStream ??
      (async function* ({ prompt }) {
        streamCalls += 1;
        const full = `delta-a|delta-b|${prompt.length}`;
        // Yield cumulative frames — adapter must convert to CK-03.2 deltas.
        yield full.slice(0, 7);
        yield full.slice(0, 15);
        yield full;
      }),
    embed:
      overrides.embed ??
      (async () => Float32Array.from([0.1, 0.2, 0.3, 0.4])),
    _stats: () => ({ generateCalls, streamCalls }),
  };
  return rt;
}

test("happy path: generate assembles prompt and maps stop finishReason", async () => {
  const events = [];
  const runtime = mockRuntime();
  const model = createSlmModelAdapter(runtime, {
    subjectId: "subj-gen",
    deviceId: "dev-gen",
    emit: (e) => events.push(e),
  });

  assert.equal(model.descriptor.locality, "on-device");
  assert.equal(model.descriptor.modelId, "mock-phi-adapter");

  const messages = [
    { role: "system", content: "charter" },
    { role: "user", content: "hello" },
  ];
  const expectedPrompt = assembleChatMessagesToPrompt(messages, {
    contextWindow: 4096,
    subjectId: "subj-gen",
  });

  const out = await model.generate(messages, { deadlineMs: 5_000, maxTokens: 64 });
  assert.equal(out.finishReason, "stop");
  assert.equal(out.text, `echo:${expectedPrompt.length}`);
  assert.equal(runtime._stats().generateCalls, 1);

  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.slm_model_adapter" &&
        e.op === "generate" &&
        e.outcome === "ok" &&
        e.subjectId === "subj-gen" &&
        e.deviceId === "dev-gen",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /charter|hello|SECRET/);
});

test("happy path: generateStream yields deltas that concatenate to full text", async () => {
  const runtime = mockRuntime();
  const model = createSlmModelAdapter(runtime, { subjectId: "subj-stream" });
  const messages = [{ role: "user", content: "stream me" }];
  const expectedPrompt = assembleChatMessagesToPrompt(messages, {
    contextWindow: 4096,
    subjectId: "subj-stream",
  });
  const expected = `delta-a|delta-b|${expectedPrompt.length}`;

  const parts = [];
  for await (const d of model.generateStream(messages, { deadlineMs: 5_000 })) {
    parts.push(d);
  }
  assert.ok(parts.length >= 2);
  assert.equal(parts.join(""), expected);
  // No cumulative re-yield of prior content as a frame.
  for (let i = 1; i < parts.length; i += 1) {
    assert.ok(!parts[i].startsWith(parts.slice(0, i).join("")));
  }
});

test("toStreamDeltas: cumulative frames become pure deltas", async () => {
  async function* cumulative() {
    yield "hel";
    yield "hell";
    yield "hello";
  }
  const parts = [];
  for await (const d of toStreamDeltas(cumulative())) {
    parts.push(d);
  }
  assert.deepEqual(parts, ["hel", "l", "o"]);
  assert.equal(parts.join(""), "hello");
});

test("edge: empty messages → typed error; SlmRuntime.generate never called", async () => {
  const runtime = mockRuntime();
  const model = createSlmModelAdapter(runtime, { subjectId: "subj-empty" });
  await assert.rejects(
    () => model.generate([], { deadlineMs: 1_000 }),
    (err) =>
      err instanceof ChatPromptAssemblyError &&
      err.obligationId === EDGE_PROMPT_OBLIGATION_EMPTY,
  );
  assert.equal(runtime._stats().generateCalls, 0);
});

test("edge: token generation slower than deadline → finishReason deadline", async () => {
  const runtime = mockRuntime({
    generate: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { text: "late", tokensPerSecond: 1, finishReason: "stop" };
    },
  });
  const model = createSlmModelAdapter(runtime, { subjectId: "subj-dl" });
  const out = await model.generate(
    [{ role: "user", content: "x" }],
    { deadlineMs: 15 },
  );
  assert.equal(out.finishReason, "deadline");
  assert.equal(out.text, "");
});

test("edge: AbortSignal abort → deadline without hang", async () => {
  const ac = new AbortController();
  const runtime = mockRuntime({
    generate: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { text: "never", tokensPerSecond: 1, finishReason: "stop" };
    },
  });
  const model = createSlmModelAdapter(runtime, {
    subjectId: "subj-abort",
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 10);
  const started = Date.now();
  const out = await model.generate(
    [{ role: "user", content: "x" }],
    { deadlineMs: 5_000 },
  );
  assert.equal(out.finishReason, "deadline");
  assert.ok(Date.now() - started < 500, "must not hang on abort");
});

test("edge: invalid card → typed init error", () => {
  assert.throws(
    () =>
      createSlmModelAdapter(
        mockRuntime({ card: { modelId: "", contextWindow: 0 } }),
        { subjectId: "subj-init" },
      ),
    (err) =>
      err instanceof SlmModelAdapterError &&
      err.obligationId === EDGE_MODEL_OBLIGATION_INIT,
  );
});

test("edge: embed dimension mismatch is a hard error", async () => {
  let n = 0;
  const runtime = mockRuntime({
    embed: async () => {
      n += 1;
      return n === 1
        ? Float32Array.from([1, 2, 3])
        : Float32Array.from([1, 2, 3, 4]);
    },
  });
  const model = createSlmModelAdapter(runtime, { subjectId: "subj-emb" });
  await model.embed("a");
  await assert.rejects(
    () => model.embed("b"),
    (err) =>
      err instanceof SlmModelAdapterError &&
      err.obligationId === EDGE_MODEL_OBLIGATION_EMBED_DIM,
  );
});

test("sovereignty: per-subject adapters isolate events; no raw content", async () => {
  const events = [];
  const a = createSlmModelAdapter(mockRuntime(), {
    subjectId: "subj-a",
    deviceId: "dev-a",
    emit: (e) => events.push(e),
  });
  const b = createSlmModelAdapter(mockRuntime(), {
    subjectId: "subj-b",
    deviceId: "dev-b",
    emit: (e) => events.push(e),
  });
  await Promise.all([
    a.generate([{ role: "user", content: SECRET }], { deadlineMs: 2_000 }),
    b.generate([{ role: "user", content: "other" }], { deadlineMs: 2_000 }),
  ]);
  const subjects = new Set(
    events
      .filter((e) => e.event === "edge_agent.slm_model_adapter")
      .map((e) => e.subjectId),
  );
  assert.deepEqual([...subjects].sort(), ["subj-a", "subj-b"]);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_ADAPTER/);
});

test("edge: stream aborts on deadlineMs without hanging", async () => {
  const runtime = mockRuntime({
    generateStream: async function* () {
      yield "a";
      await new Promise((r) => setTimeout(r, 60));
      yield "b";
      yield "c";
    },
  });
  const model = createSlmModelAdapter(runtime, { subjectId: "subj-sdl" });
  const parts = [];
  const started = Date.now();
  for await (const d of model.generateStream(
    [{ role: "user", content: "x" }],
    { deadlineMs: 25 },
  )) {
    parts.push(d);
  }
  assert.ok(Date.now() - started < 400);
  assert.ok(parts.length <= 2);
  void EDGE_MODEL_OBLIGATION_DEADLINE;
});
