/**
 * MLX streaming deltas + native deadline abort (MLXADAP-002).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MlxSlmRuntime,
  createInProcessMlxMetalBackend,
  mapMlxFinishReason,
  mlxAppleSiliconFixturePath,
} from "../dist/index.js";

const FIXTURE = mlxAppleSiliconFixturePath();
const APPLE = { platform: "darwin", arch: "arm64" };
const SECRET = "SECRET_MLX_STREAM_BODY";

function isCumulativeStreamFrame(prior, frame) {
  if (prior.length === 0) return false;
  if (frame.length <= prior.length) return false;
  return frame.startsWith(prior);
}

test("unit: mapMlxFinishReason matches edge-agent cancel mapping", () => {
  assert.equal(
    mapMlxFinishReason({
      deadlineHit: true,
      signalAborted: true,
      elapsedMs: 10,
      deadlineMs: 50,
      tokensEmitted: 0,
      maxTokens: 8,
    }),
    "deadline",
  );
  assert.equal(
    mapMlxFinishReason({
      deadlineHit: false,
      signalAborted: true,
      elapsedMs: 10,
      deadlineMs: 50,
      tokensEmitted: 0,
      maxTokens: 8,
    }),
    "aborted",
  );
  assert.equal(
    mapMlxFinishReason({
      deadlineHit: false,
      signalAborted: false,
      elapsedMs: 5,
      deadlineMs: 50,
      tokensEmitted: 8,
      maxTokens: 8,
    }),
    "length",
  );
  assert.equal(
    mapMlxFinishReason({
      deadlineHit: false,
      signalAborted: false,
      elapsedMs: 5,
      deadlineMs: 50,
      tokensEmitted: 3,
      maxTokens: 8,
    }),
    "stop",
  );
});

test("happy path: generateStream deltas concat to generate(); never cumulative", async () => {
  const events = [];
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    subjectId: "subj-mlx-delta",
    deviceId: "dev-mlx-delta",
    hostProbe: APPLE,
    backend: createInProcessMlxMetalBackend({ streamChunkChars: 2 }),
    onTelemetry: (e) => events.push(e),
  });
  await runtime.load();

  const final = await runtime.generate({
    prompt: SECRET,
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 5_000,
  });
  assert.ok(final.text.length > 0);
  assert.ok(["stop", "length"].includes(final.finishReason));

  const chunks = [];
  let accumulated = "";
  for await (const frame of runtime.generateStream({
    prompt: SECRET,
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 5_000,
  })) {
    assert.equal(typeof frame, "string");
    assert.ok(frame.length > 0);
    assert.equal(isCumulativeStreamFrame(accumulated, frame), false);
    accumulated += frame;
    chunks.push(frame);
  }

  assert.ok(chunks.length >= 2, "expected multiple incremental token deltas");
  assert.equal(accumulated, final.text);
  assert.ok(
    events.some(
      (e) =>
        e.op === "generateStream" &&
        e.outcome === "ok" &&
        e.subjectId === "subj-mlx-delta" &&
        typeof e.deltaCount === "number" &&
        e.deltaCount >= 2,
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  await runtime.unload();
});

test("edge: mid-stream deadline aborts; prior deltas flushed; AbortSignal armed", async () => {
  const events = [];
  let clock = 1_000;
  /** @type {AbortSignal | undefined} */
  let seenSignal;
  const base = createInProcessMlxMetalBackend();
  const backend = {
    kind: "in-process",
    load: (w, c) => base.load(w, c),
    unload: (h) => base.unload(h),
    embed: (h, t) => base.embed(h, t),
    async generate(handle, params) {
      seenSignal = params.signal;
      return base.generate(handle, params);
    },
    async *generateStream(_handle, params) {
      seenSignal = params.signal;
      assert.ok(params.signal, "native AbortSignal must reach Metal seam");
      yield "aa";
      yield "bb";
      yield "cc";
    },
  };

  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    subjectId: "subj-mlx-abort",
    deviceId: "dev-mlx-abort",
    hostProbe: APPLE,
    nowMs: () => clock,
    backend,
    onTelemetry: (e) => events.push(e),
  });
  await runtime.load();

  const frames = [];
  const stream = runtime.generateStream({
    prompt: "x",
    maxTokens: 8,
    temperature: 0,
    deadlineMs: 50,
  });
  const it = stream[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.done, false);
  frames.push(first.value);
  clock += 100;
  const second = await it.next();
  assert.equal(second.done, true);
  assert.deepEqual(frames, ["aa"]);
  assert.ok(seenSignal, "AbortSignal reached native seam");
  assert.ok(
    events.some(
      (e) =>
        e.op === "generateStream" &&
        e.outcome === "deadline" &&
        e.deltaCount === 1 &&
        e.subjectId === "subj-mlx-abort",
    ),
  );
  await runtime.unload();
});

test("edge: generate deadline via AbortController discards partial text", async () => {
  const events = [];
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    subjectId: "subj-mlx-gen-dl",
    deviceId: "dev-mlx-gen-dl",
    hostProbe: APPLE,
    onTelemetry: (e) => events.push(e),
    backend: {
      ...createInProcessMlxMetalBackend(),
      async generate(_handle, params) {
        assert.ok(params.signal);
        await new Promise((resolve) => {
          if (params.signal.aborted) {
            resolve(undefined);
            return;
          }
          params.signal.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
        });
        return { text: "SHOULD_DISCARD", tokensEmitted: 4, deadlineHit: true };
      },
      async *generateStream() {},
    },
  });
  await runtime.load();

  const result = await runtime.generate({
    prompt: SECRET,
    maxTokens: 8,
    temperature: 0,
    deadlineMs: 25,
  });
  assert.equal(result.finishReason, "deadline");
  assert.equal(result.text, "");
  assert.ok(
    events.some(
      (e) =>
        e.op === "generate" &&
        e.outcome === "deadline" &&
        e.subjectId === "subj-mlx-gen-dl",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("SHOULD_DISCARD"));
  await runtime.unload();
});

test("edge: unload cooperative cancel maps finishReason aborted", async () => {
  const base = createInProcessMlxMetalBackend();
  let armed;
  const armedPromise = new Promise((r) => {
    armed = r;
  });
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    hostProbe: APPLE,
    nowMs: () => 1_000,
    backend: {
      kind: "in-process",
      load: (w, c) => base.load(w, c),
      unload: (h) => base.unload(h),
      embed: (h, t) => base.embed(h, t),
      async *generateStream() {},
      async generate(_h, params) {
        assert.ok(params.signal);
        await new Promise((resolve) => {
          if (params.signal.aborted) {
            armed();
            resolve(undefined);
            return;
          }
          armed();
          params.signal.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
        });
        // Cooperative cancel without wall-clock breach.
        return {
          text: "partial",
          tokensEmitted: 2,
          deadlineHit: false,
        };
      },
    },
  });
  await runtime.load();

  const genPromise = runtime.generate({
    prompt: "x",
    maxTokens: 8,
    temperature: 0,
    deadlineMs: 60_000,
  });
  await armedPromise;
  await runtime.unload();
  const result = await genPromise;
  assert.equal(result.finishReason, "aborted");
  assert.equal(result.text, "");
});

test("sovereignty: stream+deadline path has zero egress", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected fetch");
  };
  try {
    const runtime = new MlxSlmRuntime({
      weightsPath: FIXTURE,
      subjectId: "subj-mlx-local-stream",
      hostProbe: APPLE,
    });
    await runtime.load();
    for await (const _ of runtime.generateStream({
      prompt: SECRET,
      maxTokens: 8,
      temperature: 0,
      deadlineMs: 2_000,
    })) {
      /* drain */
    }
    assert.equal(fetchCalls, 0);
    await runtime.unload();
  } finally {
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete globalThis.fetch;
  }
});

test("sovereignty: concurrent stream subjects stay isolated in telemetry", async () => {
  const a = [];
  const b = [];
  await Promise.all([
    (async () => {
      const rt = new MlxSlmRuntime({
        weightsPath: FIXTURE,
        subjectId: "subj-stream-a",
        deviceId: "dev-a",
        hostProbe: APPLE,
        onTelemetry: (e) => a.push(e),
      });
      await rt.load();
      for await (const _ of rt.generateStream({
        prompt: "a",
        maxTokens: 8,
        temperature: 0,
        deadlineMs: 500,
      })) {
        /* drain */
      }
      await rt.unload();
    })(),
    (async () => {
      const rt = new MlxSlmRuntime({
        weightsPath: FIXTURE,
        subjectId: "subj-stream-b",
        deviceId: "dev-b",
        hostProbe: APPLE,
        onTelemetry: (e) => b.push(e),
      });
      await rt.load();
      for await (const _ of rt.generateStream({
        prompt: "b",
        maxTokens: 8,
        temperature: 0,
        deadlineMs: 500,
      })) {
        /* drain */
      }
      await rt.unload();
    })(),
  ]);
  assert.ok(a.every((e) => e.subjectId === "subj-stream-a"));
  assert.ok(b.every((e) => e.subjectId === "subj-stream-b"));
  assert.ok(!JSON.stringify(a).includes("subj-stream-b"));
});
