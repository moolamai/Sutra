/**
 * LocalWeightSlmRuntime — missing/corrupt weights typed init failure.
 * Run: pnpm --filter @moolam/edge-agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessEventBus } from "@moolam/runtime";
import { EDGE_LIFECYCLE_READY } from "@moolam/observability";
import {
  EdgeAgent,
  EDGE_SLM_LOAD_OBLIGATION,
  LocalWeightSlmRuntime,
  SLM_WEIGHTS_MAGIC,
  SlmRuntimeInitError,
} from "../dist/index.js";

const SECRET = "SECRET_SLM_WEIGHTS_UTTERANCE";

function card() {
  return {
    modelId: "phi-drill-q4",
    contextWindow: 4096,
    quantization: "q4",
    memoryFootprintMiB: 64,
    languages: ["en"],
  };
}

function memoryDriver() {
  return {
    async execute() {},
    async query() {
      return [];
    },
  };
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "sutra-slm-weights-"));
}

test("happy path: valid magic weights load; telemetry ok; generate allowed", async () => {
  const dir = tempDir();
  const weightsPath = path.join(dir, "model.bin");
  writeFileSync(weightsPath, `${SLM_WEIGHTS_MAGIC}\npayload`);
  const events = [];
  const runtime = new LocalWeightSlmRuntime(card(), {
    weightsPath,
    subjectId: "subj-slm-ok",
    deviceId: "edge-slm-ok",
    onTelemetry: (e) => events.push(e),
  });

  await runtime.load();
  assert.equal(runtime.isLoaded, true);
  assert.equal(runtime.loadAttemptCount, 1);
  await runtime.load(); // idempotent
  assert.equal(runtime.loadAttemptCount, 2);
  assert.ok(events.some((e) => e.outcome === "ok" && e.op === "load"));
  assert.ok(!JSON.stringify(events).includes(SECRET));

  const result = await runtime.generate({
    prompt: SECRET,
    maxTokens: 4,
    temperature: 0,
    deadlineMs: 1000,
  });
  assert.equal(result.finishReason, "stop");
  assert.ok(!result.text.includes(SECRET));

  await runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("edge: missing weights → SlmRuntimeInitError missing_weights + telemetry", async () => {
  const dir = tempDir();
  const weightsPath = path.join(dir, "absent.bin");
  const events = [];
  const runtime = new LocalWeightSlmRuntime(card(), {
    weightsPath,
    subjectId: "subj-slm-miss",
    deviceId: "edge-slm-miss",
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
        e.subjectId === "subj-slm-miss",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("utterance"));
  rmSync(dir, { recursive: true, force: true });
});

test("edge: corrupt magic → corrupt_weights; no crash loop on repeated load", async () => {
  const dir = tempDir();
  const weightsPath = path.join(dir, "bad.bin");
  writeFileSync(weightsPath, "NOT-A-VALID-WEIGHT-FILE");
  const events = [];
  const runtime = new LocalWeightSlmRuntime(card(), {
    weightsPath,
    subjectId: "subj-slm-corrupt",
    deviceId: "edge-slm-corrupt",
    onTelemetry: (e) => events.push(e),
  });

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => runtime.load(), (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.equal(err.failureClass, "corrupt_weights");
      return true;
    });
  }
  // Exactly one attempt per call — harness does not spin internally.
  assert.equal(runtime.loadAttemptCount, 3);
  assert.equal(
    events.filter((e) => e.outcome === "init_error").length,
    3,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("edge: EdgeAgent initialize surfaces typed error; no lifecycle ready", async () => {
  const dir = tempDir();
  const weightsPath = path.join(dir, "gone.bin");
  const bus = new InProcessEventBus();
  const ready = [];
  bus.subscribe(EDGE_LIFECYCLE_READY, (e) => ready.push(e));
  const telemetry = [];
  const runtime = new LocalWeightSlmRuntime(card(), {
    weightsPath,
    subjectId: "subj-slm-host",
    deviceId: "edge-slm-host",
    onTelemetry: (e) => telemetry.push(e),
  });

  const agent = new EdgeAgent({
    subjectId: "subj-slm-host",
    deviceId: "edge-slm-host",
    runtime,
    storage: memoryDriver(),
    profile: { ageBand: "adult", track: "math-l1", language: "en-IN" },
    eventBus: bus,
    attachEventBusSpans: false,
  });

  await assert.rejects(() => agent.initialize(), (err) => {
    assert.ok(err instanceof SlmRuntimeInitError);
    assert.equal(err.failureClass, "missing_weights");
    return true;
  });
  assert.equal(ready.length, 0);
  assert.ok(telemetry.some((e) => e.outcome === "init_error"));
  agent.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("sovereignty: telemetry scoped by subjectId; no cross-subject bleed", async () => {
  const dir = tempDir();
  const weightsPath = path.join(dir, "gone.bin");
  const eventsA = [];
  const eventsB = [];
  const a = new LocalWeightSlmRuntime(card(), {
    weightsPath,
    subjectId: "subj-a",
    deviceId: "dev-a",
    onTelemetry: (e) => eventsA.push(e),
  });
  const b = new LocalWeightSlmRuntime(card(), {
    weightsPath,
    subjectId: "subj-b",
    deviceId: "dev-b",
    onTelemetry: (e) => eventsB.push(e),
  });

  await assert.rejects(() => a.load());
  await assert.rejects(() => b.load());
  assert.equal(eventsA[0].subjectId, "subj-a");
  assert.equal(eventsB[0].subjectId, "subj-b");
  assert.doesNotMatch(JSON.stringify(eventsA), /subj-b/);
  assert.doesNotMatch(JSON.stringify(eventsB), /subj-a/);
  rmSync(dir, { recursive: true, force: true });
});
