/**
 * ONNX mobile memory ceilings + mid-range device profile.
 * Run: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import {
  EDGE_SLM_LOAD_OBLIGATION,
  SlmRuntimeInitError,
} from "@moolam/edge-agent";
import {
  MID_RANGE_DEVICE_PROFILE_PATH,
  OnnxSlmRuntime,
  createInProcessOnnxMobileBackend,
  loadMidRangeDeviceProfile,
  planOnnxMobileLoad,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const WITHIN = path.join(PKG, "android/fixtures/within-budget.onnx");
const OVER = path.join(PKG, "android/fixtures/over-budget.onnx");
const SECRET = "SECRET_ONNX_UTTERANCE_BODY";

test("happy path: mid-range profile load within budget materializes + card truthful", async () => {
  const profile = loadMidRangeDeviceProfile(MID_RANGE_DEVICE_PROFILE_PATH);
  assert.equal(profile.profileId, "android-mid-range");
  assert.equal(profile.maxMemoryMiB, 1536);
  assert.equal(profile.hardwareClass, "mid-range");

  let materialized = 0;
  const events = [];
  const runtime = new OnnxSlmRuntime({
    weightsPath: WITHIN,
    subjectId: "subj-onnx-ok",
    deviceId: "dev-mid-range",
    backend: createInProcessOnnxMobileBackend({
      onMaterialize: () => {
        materialized += 1;
      },
    }),
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(runtime.memoryCeilingMiB, 1536);
  await runtime.load();
  assert.equal(materialized, 1);
  assert.equal(runtime.isLoaded, true);
  assert.equal(runtime.card.modelId, "phi-mini-int8-within");
  assert.equal(runtime.card.memoryFootprintMiB, 512);
  assert.equal(runtime.card.quantization, "int8");
  assert.ok(events.some((e) => e.op === "plan" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.op === "load" && e.outcome === "ok"));
  assert.ok(events.every((e) => !JSON.stringify(e).includes(SECRET)));

  await runtime.load(); // idempotent
  assert.equal(materialized, 1);

  const reply = await runtime.generate({
    prompt: "hello",
    maxTokens: 32,
    temperature: 0,
    deadlineMs: 500,
  });
  assert.ok(reply.text.startsWith("onnx:"));
  assert.ok(["stop", "length"].includes(reply.finishReason));

  const emb = await runtime.embed("vec");
  assert.equal(emb.length, 8);

  await runtime.unload();
  assert.equal(runtime.isLoaded, false);
});

test("edge: declared footprint over ceiling → typed reject, zero materialization", async () => {
  let materialized = 0;
  const events = [];
  const runtime = new OnnxSlmRuntime({
    weightsPath: OVER,
    subjectId: "subj-onnx-ceil",
    deviceId: "dev-mid-range",
    backend: createInProcessOnnxMobileBackend({
      onMaterialize: () => {
        materialized += 1;
      },
    }),
    onTelemetry: (e) => events.push(e),
  });

  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.equal(err.failureClass, "config");
      assert.equal(err.obligationId, EDGE_SLM_LOAD_OBLIGATION);
      assert.match(err.message, /exceeds device ceiling/i);
      assert.match(err.message, /4096/);
      assert.match(err.message, /1536/);
      return true;
    },
  );
  assert.equal(materialized, 0);
  assert.equal(runtime.isLoaded, false);
  assert.ok(
    events.some(
      (e) => e.op === "plan" && e.outcome === "memory_ceiling_reject",
    ),
  );
  assert.ok(events.every((e) => e.subjectId === "subj-onnx-ceil"));
});

test("edge: configurable maxMemoryMiB overrides mid-range profile", async () => {
  let materialized = 0;
  const runtime = new OnnxSlmRuntime({
    weightsPath: WITHIN,
    maxMemoryMiB: 256,
    backend: createInProcessOnnxMobileBackend({
      onMaterialize: () => {
        materialized += 1;
      },
    }),
  });
  assert.equal(runtime.memoryCeilingMiB, 256);
  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.match(err.message, /maxMemoryMiB=256/);
      return true;
    },
  );
  assert.equal(materialized, 0);

  const ok = new OnnxSlmRuntime({
    weightsPath: OVER,
    maxMemoryMiB: 8192,
    backend: createInProcessOnnxMobileBackend({
      onMaterialize: () => {
        materialized += 1;
      },
    }),
  });
  await ok.load();
  assert.equal(materialized, 1);
  await ok.unload();
});

test("edge: graph I/O name mismatch → typed error, no materialization", async () => {
  let materialized = 0;
  const events = [];
  const runtime = new OnnxSlmRuntime({
    weightsPath: WITHIN,
    requiredGraphInputs: ["input_ids", "attention_mask"],
    backend: createInProcessOnnxMobileBackend({
      onMaterialize: () => {
        materialized += 1;
      },
    }),
    onTelemetry: (e) => events.push(e),
  });
  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.match(err.message, /missing input tensor: attention_mask/);
      return true;
    },
  );
  assert.equal(materialized, 0);
  assert.ok(events.some((e) => e.outcome === "graph_mismatch"));
});

test("edge: deadline abort returns finishReason deadline (no hang)", async () => {
  const base = createInProcessOnnxMobileBackend();
  const runtime = new OnnxSlmRuntime({
    weightsPath: WITHIN,
    backend: {
      kind: "in-process",
      load: (w, c) => base.load(w, c),
      unload: (h) => base.unload(h),
      embed: (h, t) => base.embed(h, t),
      generateStream: (h, p) => base.generateStream(h, p),
      async generate(_h, params) {
        if (params.deadlineMs <= 1 || params.signal?.aborted) {
          return { text: "", tokensEmitted: 0, deadlineHit: true };
        }
        return base.generate(_h, params);
      },
    },
  });
  await runtime.load();
  const result = await runtime.generate({
    prompt: "x",
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 1,
  });
  assert.equal(result.finishReason, "deadline");
  await runtime.unload();
});

test("sovereignty: generate/embed zero egress under locality recorder", async () => {
  const runtime = new OnnxSlmRuntime({
    weightsPath: WITHIN,
    subjectId: "subj-onnx-loc",
    deviceId: "dev-onnx-loc",
  });
  await runtime.load();

  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-onnx-loc",
      deviceId: "dev-onnx-loc",
      caller: { principalId: "onnx-ceiling-test", subjectScope: "*" },
      selfHostedHosts: ["school.local"],
    },
    async (api) => {
      const mock = api.mockAgent();
      mock
        ?.get("https://vendor.example")
        .intercept({ path: "/v1/infer", method: "POST" })
        .reply(200, { ok: true })
        .times(3);

      return api.withPayloadClass("model-prompt", async () => {
        await runtime.generate({
          prompt: "local only",
          maxTokens: 4,
          temperature: 0,
          deadlineMs: 500,
        });
        await runtime.embed("local embed");
        return true;
      });
    },
  );

  const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
  assert.equal(asserted.ok, true);
  assert.equal(turn.noEgress, true);
  assert.equal(turn.attempts.length, 0);
  await runtime.unload();
});

test("sovereignty: concurrent subjects keep isolated telemetry subjectIds", async () => {
  const a = [];
  const b = [];
  await Promise.all([
    (async () => {
      const rt = new OnnxSlmRuntime({
        weightsPath: WITHIN,
        subjectId: "subj-a",
        deviceId: "dev-a",
        onTelemetry: (e) => a.push(e),
      });
      await rt.load();
      await rt.generate({
        prompt: "a",
        maxTokens: 4,
        temperature: 0,
        deadlineMs: 300,
      });
      await rt.unload();
    })(),
    (async () => {
      const rt = new OnnxSlmRuntime({
        weightsPath: WITHIN,
        subjectId: "subj-b",
        deviceId: "dev-b",
        onTelemetry: (e) => b.push(e),
      });
      await rt.load();
      await rt.generate({
        prompt: "b",
        maxTokens: 4,
        temperature: 0,
        deadlineMs: 300,
      });
      await rt.unload();
    })(),
  ]);
  assert.ok(a.every((e) => e.subjectId === "subj-a"));
  assert.ok(b.every((e) => e.subjectId === "subj-b"));
  assert.ok(!JSON.stringify(a).includes("subj-b"));
  assert.ok(!JSON.stringify(b).includes("subj-a"));
});

test("unit: planOnnxMobileLoad rejects over budget", () => {
  const ok = planOnnxMobileLoad({
    declaredFootprintMiB: 512,
    maxMemoryMiB: 1536,
    modelId: "m",
  });
  assert.equal(ok.allowed, true);
  const bad = planOnnxMobileLoad({
    declaredFootprintMiB: 2048,
    maxMemoryMiB: 1536,
    modelId: "m",
  });
  assert.equal(bad.allowed, false);
  if (!bad.allowed) assert.match(bad.message, /exceeds device ceiling/);
});
