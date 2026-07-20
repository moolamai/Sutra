/**
 * Deadline abort + CK-03.2 streaming deltas for LlamaCppSlmRuntime.
 * Run: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LlamaCppSlmRuntime,
  createInProcessLlamaCppBackend,
  writeMinimalGguf,
} from "../dist/index.js";

const SECRET = "SECRET_STREAM_BODY_NEVER_IN_TELEM";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "sutra-ll-stream-"));
}

function writeGguf(dir) {
  const weightsPath = path.join(dir, "model.gguf");
  writeFileSync(
    weightsPath,
    writeMinimalGguf({
      name: "phi-stream-fixture",
      contextLength: 4096,
      fileType: 15,
      languages: ["en"],
    }),
  );
  return weightsPath;
}

/** CK-03.2 cumulative-frame detector (same rule as contract-conformance). */
function isCumulativeStreamFrame(prior, frame) {
  if (prior.length === 0) return false;
  if (frame.length <= prior.length) return false;
  return frame.startsWith(prior);
}

test("happy path: generateStream yields deltas that concat to generate()", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const events = [];
  const runtime = new LlamaCppSlmRuntime({
    weightsPath,
    subjectId: "subj-delta",
    deviceId: "dev-delta",
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

  assert.ok(chunks.length >= 2, "expected multiple delta frames");
  assert.equal(accumulated, final.text);
  assert.ok(
    events.some(
      (e) =>
        e.op === "generateStream" &&
        e.outcome === "ok" &&
        e.subjectId === "subj-delta" &&
        typeof e.deltaCount === "number" &&
        e.deltaCount >= 2,
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));

  await runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("edge: mid-stream deadline aborts; prior deltas flushed; native signal armed", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  let clock = 1_000;
  const events = [];
  const base = createInProcessLlamaCppBackend();
  /** @type {AbortSignal | undefined} */
  let seenSignal;
  const backend = {
    ...base,
    async load(pathArg, meta) {
      return base.load(pathArg, meta);
    },
    async unload(handle) {
      return base.unload(handle);
    },
    async embed(handle, text) {
      return base.embed(handle, text);
    },
    async generate(handle, params) {
      seenSignal = params.signal;
      return base.generate(handle, params);
    },
    async *generateStream(_handle, params) {
      seenSignal = params.signal;
      assert.ok(params.signal, "native AbortSignal must be passed");
      yield "aa";
      yield "bb";
      yield "cc";
    },
  };

  const runtime = new LlamaCppSlmRuntime({
    weightsPath,
    subjectId: "subj-abort",
    deviceId: "dev-abort",
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
  // Breach deadline before the next delta is flushed to the consumer.
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
        e.subjectId === "subj-abort",
    ),
  );

  await runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("edge: generate deadline via AbortController discards partial text", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const events = [];
  const runtime = new LlamaCppSlmRuntime({
    weightsPath,
    subjectId: "subj-gen-dl",
    deviceId: "dev-gen-dl",
    onTelemetry: (e) => events.push(e),
    backend: {
      ...createInProcessLlamaCppBackend(),
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
        e.subjectId === "subj-gen-dl",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("SHOULD_DISCARD"));

  await runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("sovereignty: stream+deadline path has zero egress", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected fetch");
  };
  try {
    const runtime = new LlamaCppSlmRuntime({
      weightsPath,
      subjectId: "subj-local-stream",
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
    rmSync(dir, { recursive: true, force: true });
  }
});
