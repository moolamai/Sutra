/**
 * LlamaCppSlmRuntime — GGUF load, deadline, locality, embed stability.
 * Run: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EDGE_SLM_LOAD_OBLIGATION, SlmRuntimeInitError } from "@moolam/edge-agent";
import {
  LlamaCppSlmRuntime,
  createInProcessLlamaCppBackend,
  writeMinimalGguf,
} from "../dist/index.js";

const SECRET = "SECRET_LLAMA_PROMPT_BODY_NEVER_IN_TELEM";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "sutra-bindings-slm-"));
}

function writeGguf(dir, name = "model.gguf") {
  const weightsPath = path.join(dir, name);
  const bytes = writeMinimalGguf({
    name: "phi-ll-fixture",
    contextLength: 4096,
    fileType: 15,
    languages: ["en"],
  });
  writeFileSync(weightsPath, bytes);
  return weightsPath;
}

test("happy path: GGUF card truth + generate/embed + idempotent load/unload", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const events = [];
  const runtime = new LlamaCppSlmRuntime({
    weightsPath,
    subjectId: "subj-llama-ok",
    deviceId: "dev-llama-ok",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(runtime.card.modelId, "unloaded");
  await runtime.load();
  assert.equal(runtime.isLoaded, true);
  assert.equal(runtime.card.modelId, "phi-ll-fixture");
  assert.equal(runtime.card.contextWindow, 4096);
  assert.equal(runtime.card.quantization, "Q4_K_M");
  assert.deepEqual(runtime.card.languages, ["en"]);
  assert.ok(runtime.embeddingDimension > 0);

  await runtime.load();
  assert.equal(runtime.loadAttemptCount, 2);

  const result = await runtime.generate({
    prompt: SECRET,
    maxTokens: 8,
    temperature: 0,
    deadlineMs: 5_000,
  });
  assert.equal(result.finishReason, "stop");
  assert.ok(result.text.length > 0);
  assert.ok(!result.text.includes(SECRET));

  const v1 = await runtime.embed("alpha");
  const v2 = await runtime.embed("alpha");
  assert.equal(v1.length, runtime.embeddingDimension);
  assert.equal(v2.length, v1.length);
  assert.deepEqual(Array.from(v1), Array.from(v2));

  const frames = [];
  let streamAccum = "";
  for await (const f of runtime.generateStream({
    prompt: "hi",
    maxTokens: 4,
    temperature: 0,
    deadlineMs: 5_000,
  })) {
    assert.equal(typeof f, "string");
    assert.ok(f.length > 0);
    // No cumulative restatement of prior frames.
    assert.equal(
      streamAccum.length > 0 &&
        f.length > streamAccum.length &&
        f.startsWith(streamAccum),
      false,
    );
    streamAccum += f;
    frames.push(f);
  }
  assert.ok(frames.length >= 1);
  assert.equal(streamAccum, frames.join(""));

  await runtime.unload();
  assert.equal(runtime.isLoaded, false);
  await runtime.load();
  assert.equal(runtime.isLoaded, true);
  assert.equal(runtime.card.modelId, "phi-ll-fixture");

  assert.ok(events.some((e) => e.op === "load" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.op === "generate" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.op === "embed" && e.outcome === "ok"));
  assert.ok(events.every((e) => e.subjectId === "subj-llama-ok"));
  assert.ok(events.every((e) => e.deviceId === "dev-llama-ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));

  await runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("edge: missing GGUF → missing_weights typed error + telemetry", async () => {
  const dir = tempDir();
  const weightsPath = path.join(dir, "absent.gguf");
  const events = [];
  const runtime = new LlamaCppSlmRuntime({
    weightsPath,
    subjectId: "subj-miss",
    deviceId: "dev-miss",
    onTelemetry: (e) => events.push(e),
  });

  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.equal(err.failureClass, "missing_weights");
      assert.equal(err.reason, "missing");
      assert.equal(err.obligationId, EDGE_SLM_LOAD_OBLIGATION);
      return true;
    },
  );
  assert.equal(runtime.isLoaded, false);
  assert.equal(runtime.loadAttemptCount, 1);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "init_error" &&
        e.failureClass === "missing_weights" &&
        e.subjectId === "subj-miss",
    ),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("edge: corrupt GGUF → corrupt_weights; no crash loop", async () => {
  const dir = tempDir();
  const weightsPath = path.join(dir, "bad.gguf");
  writeFileSync(weightsPath, "NOT-GGUF");
  const runtime = new LlamaCppSlmRuntime({
    weightsPath,
    subjectId: "subj-corrupt",
  });

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(
      () => runtime.load(),
      (err) => {
        assert.ok(err instanceof SlmRuntimeInitError);
        assert.equal(err.failureClass, "corrupt_weights");
        return true;
      },
    );
  }
  assert.equal(runtime.loadAttemptCount, 3);
  assert.equal(runtime.isLoaded, false);
  rmSync(dir, { recursive: true, force: true });
});

test("edge: deadlineMs → finishReason deadline", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  let clock = 1_000;
  const runtime = new LlamaCppSlmRuntime({
    weightsPath,
    nowMs: () => clock,
    backend: {
      ...createInProcessLlamaCppBackend(),
      async generate() {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      },
      async *generateStream() {
        /* empty */
      },
    },
  });
  await runtime.load();
  const result = await runtime.generate({
    prompt: "x",
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 10,
  });
  assert.equal(result.finishReason, "deadline");
  assert.equal(result.text, "");
  clock += 100;
  rmSync(dir, { recursive: true, force: true });
});

test("edge: embed dimension drift → hard SlmRuntimeInitError", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const base = createInProcessLlamaCppBackend({ defaultEmbedDim: 8 });
  let calls = 0;
  const backend = {
    ...base,
    async embed(handle, text) {
      calls += 1;
      if (calls === 1) return base.embed(handle, text);
      return new Float32Array(3);
    },
  };
  const runtime = new LlamaCppSlmRuntime({ weightsPath, backend });
  await runtime.load();
  await runtime.embed("ok");
  await assert.rejects(
    () => runtime.embed("drift"),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.equal(err.failureClass, "config");
      assert.match(err.message, /dimension drift/);
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test("sovereignty: zero egress during generate/embed (no fetch)", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (..._args) => {
    fetchCalls += 1;
    throw new Error("unexpected fetch");
  };

  try {
    const runtime = new LlamaCppSlmRuntime({
      weightsPath,
      subjectId: "subj-local",
      deviceId: "dev-local",
    });
    await runtime.load();
    await runtime.generate({
      prompt: SECRET,
      maxTokens: 4,
      temperature: 0,
      deadlineMs: 2_000,
    });
    await runtime.embed(SECRET);
    assert.equal(fetchCalls, 0);
    await runtime.unload();
  } finally {
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete globalThis.fetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
