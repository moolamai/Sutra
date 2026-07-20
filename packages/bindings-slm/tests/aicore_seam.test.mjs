/**
 * AICore capability probe + SlmRuntime shim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  createModelObligationsRegistry,
  runConformance,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import {
  EDGE_SLM_LOAD_OBLIGATION,
  SlmRuntimeInitError,
  createSlmModelAdapter,
} from "@moolam/edge-agent";
import {
  AicoreSlmRuntime,
  aicoreCapableFixturePath,
  buildAicoreCapability,
  createInProcessAicoreBackend,
  mapAicoreFinishReason,
  probeAicoreCapability,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const ANDROID = { platform: "android", apiLevel: 34 };
const SECRET = "SECRET_AICORE_UTTERANCE";
const KOTLIN = path.join(
  PKG,
  "android/src/main/kotlin/com/moolam/bindings/slm/aicore/AicoreCapabilityProbe.kt",
);

const READY_MODEL = {
  modelId: "gemini-nano-aicore",
  contextWindow: 4096,
  memoryClass: "mid",
  memoryFootprintMiB: 768,
  quantization: "int4-system",
  languages: ["en-IN", "hi-IN", "en"],
  embedDim: 8,
  readiness: "ready",
};

test("unit: mapAicoreFinishReason prefers deadline", () => {
  assert.equal(
    mapAicoreFinishReason({
      deadlineHit: true,
      signalAborted: false,
      elapsedMs: 10,
      deadlineMs: 5,
      tokensEmitted: 1,
      maxTokens: 16,
    }),
    "deadline",
  );
  assert.equal(
    mapAicoreFinishReason({
      deadlineHit: false,
      signalAborted: true,
      elapsedMs: 1,
      deadlineMs: 100,
      tokensEmitted: 1,
      maxTokens: 16,
    }),
    "aborted",
  );
});

test("happy path: probe declares models + context; load/generate/embed", async () => {
  const events = [];
  const runtime = new AicoreSlmRuntime({
    subjectId: "subj-aicore-ok",
    deviceId: "dev-pixel",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend(),
    onTelemetry: (e) => events.push(e),
  });

  const cap = await runtime.probe();
  assert.equal(cap.aicorePresent, true);
  assert.equal(cap.onDeviceGenerationAvailable, true);
  assert.equal(cap.memoryClass, "mid");
  assert.equal(cap.models[0].modelId, "gemini-nano-aicore");
  assert.equal(cap.models[0].contextWindow, 4096);
  assert.ok(existsSync(aicoreCapableFixturePath()));
  const fixture = JSON.parse(
    readFileSync(aicoreCapableFixturePath(), "utf8"),
  );
  assert.equal(fixture.models[0].modelId, cap.models[0].modelId);

  await runtime.load();
  assert.equal(runtime.isLoaded, true);
  assert.equal(runtime.card.modelId, "gemini-nano-aicore");
  assert.equal(runtime.embeddingDimension, 8);

  const reply = await runtime.generate({
    prompt: "hello aicore",
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 500,
  });
  assert.ok(reply.text.startsWith("aicore:"));
  assert.ok(["stop", "length"].includes(reply.finishReason));

  const emb = await runtime.embed("vector");
  assert.equal(emb.length, 8);

  await runtime.load();
  await runtime.unload();
  assert.equal(runtime.isLoaded, false);
  assert.ok(events.some((e) => e.op === "probe" && e.outcome === "ok"));
  assert.ok(events.every((e) => !JSON.stringify(e).includes(SECRET)));
  assert.ok(existsSync(KOTLIN));
});

test("edge: AICore absent → typed absence on probe; load refuses (no crash loop)", async () => {
  const events = [];
  const absent = buildAicoreCapability({ aicorePresent: false });
  const runtime = new AicoreSlmRuntime({
    subjectId: "subj-aicore-absent",
    deviceId: "dev-old",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend({ capability: absent }),
    onTelemetry: (e) => events.push(e),
  });

  const cap = await runtime.probe();
  assert.equal(cap.aicorePresent, false);
  assert.equal(cap.onDeviceGenerationAvailable, false);
  assert.equal(cap.absenceReason, "aicore_absent");

  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.equal(err.failureClass, "config");
      assert.equal(err.obligationId, EDGE_SLM_LOAD_OBLIGATION);
      assert.match(err.message, /aicore_absent/);
      return true;
    },
  );
  assert.equal(runtime.isLoaded, false);
  assert.equal(runtime.loadAttemptCount, 1);
  assert.ok(events.some((e) => e.op === "load" && e.outcome === "absent"));
});

test("edge: model downloading → load not_ready (never hang in generate)", async () => {
  const downloading = buildAicoreCapability({
    aicorePresent: true,
    models: [{ ...READY_MODEL, readiness: "downloading" }],
  });
  assert.equal(downloading.absenceReason, "model_downloading");

  const runtime = new AicoreSlmRuntime({
    subjectId: "subj-aicore-dl",
    deviceId: "dev-dl",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend({ capability: downloading }),
  });

  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.match(err.message, /not_ready/);
      return true;
    },
  );
  assert.equal(runtime.isLoaded, false);
  await assert.rejects(() =>
    runtime.generate({
      prompt: "nope",
      maxTokens: 8,
      temperature: 0,
      deadlineMs: 100,
    }),
  );
});

test("edge: OEM modelId change → load rejects incompatible card", async () => {
  const runtime = new AicoreSlmRuntime({
    subjectId: "subj-aicore-oem",
    deviceId: "dev-oem",
    hostProbe: ANDROID,
    expectedModelId: "gemini-nano-v1-old",
    backend: createInProcessAicoreBackend(),
  });

  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.match(err.message, /modelId mismatch/);
      return true;
    },
  );
});

test("edge: embed dimension probe at load rejects drift", async () => {
  const runtime = new AicoreSlmRuntime({
    subjectId: "subj-aicore-dim",
    deviceId: "dev-dim",
    hostProbe: ANDROID,
    expectedEmbedDim: 16,
    backend: createInProcessAicoreBackend(),
  });

  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.match(err.message, /embed dimension mismatch/);
      return true;
    },
  );
});

test("edge: deadline abort → finishReason deadline", async () => {
  const base = createInProcessAicoreBackend();
  const runtime = new AicoreSlmRuntime({
    subjectId: "subj-aicore-deadline",
    deviceId: "dev-deadline",
    hostProbe: ANDROID,
    backend: {
      kind: "in-process",
      probe: (h) => base.probe(h),
      load: (m) => base.load(m),
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
    prompt: "slow",
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 1,
  });
  assert.equal(result.finishReason, "deadline");
  assert.equal(result.text, "");
});

test("invariant: generateStream yields CK deltas (not cumulative)", async () => {
  const runtime = new AicoreSlmRuntime({
    subjectId: "subj-aicore-stream",
    deviceId: "dev-stream",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend({ streamChunkChars: 2 }),
  });
  await runtime.load();
  const deltas = [];
  for await (const d of runtime.generateStream({
    prompt: "stream",
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 500,
  })) {
    deltas.push(d);
  }
  assert.ok(deltas.length >= 2);
  assert.ok(!deltas.some((d, i) => i > 0 && d.startsWith(deltas[0]) && d.length > deltas[0].length && d.includes(deltas.slice(0, i).join(""))));
  const joined = deltas.join("");
  assert.ok(joined.startsWith("aicore:"));
});

test("sovereignty: generate/embed zero egress under locality recorder", async () => {
  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-aicore-loc",
      deviceId: "dev-loc",
      caller: { principalId: "aicore-test", subjectScope: "*" },
      selfHostedHosts: ["school.local"],
    },
    async (api) => {
      api
        .mockAgent()
        ?.get("https://vendor.example")
        .intercept({ path: "/v1/infer", method: "POST" })
        .reply(200, { ok: true })
        .times(3);

      return api.withPayloadClass("model-prompt", async () => {
        const runtime = new AicoreSlmRuntime({
          subjectId: "subj-aicore-loc",
          deviceId: "dev-loc",
          hostProbe: ANDROID,
          backend: createInProcessAicoreBackend(),
        });
        await runtime.load();
        await runtime.generate({
          prompt: "local",
          maxTokens: 8,
          temperature: 0,
          deadlineMs: 500,
        });
        await runtime.embed("e");
        return true;
      });
    },
  );
  assert.equal(turn.attempts.length, 0);
  const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
  assert.equal(asserted.ok, true);
});

test("sovereignty: concurrent subjects keep isolated telemetry", async () => {
  const eventsA = [];
  const eventsB = [];
  const a = new AicoreSlmRuntime({
    subjectId: "subj-a",
    deviceId: "dev-a",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend(),
    onTelemetry: (e) => eventsA.push(e),
  });
  const b = new AicoreSlmRuntime({
    subjectId: "subj-b",
    deviceId: "dev-b",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend(),
    onTelemetry: (e) => eventsB.push(e),
  });
  await Promise.all([a.load(), b.load()]);
  await Promise.all([
    a.generate({ prompt: "a", maxTokens: 8, temperature: 0, deadlineMs: 500 }),
    b.generate({ prompt: "b", maxTokens: 8, temperature: 0, deadlineMs: 500 }),
  ]);
  assert.ok(eventsA.every((e) => e.subjectId === "subj-a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj-b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj-b"));
});

test("contract: CK-03 model obligations green via ModelInterface adapter", async () => {
  const report = await runConformance({
    registry: createModelObligationsRegistry(),
    factory: async ({ subjectId }) => {
      const runtime = new AicoreSlmRuntime({
        subjectId,
        deviceId: "dev-ck",
        hostProbe: ANDROID,
        backend: createInProcessAicoreBackend(),
      });
      await runtime.load();
      let networkAllowed = true;
      return {
        model: createSlmModelAdapter(runtime, {
          subjectId,
          deviceId: "dev-ck",
          locality: "on-device",
        }),
        isNetworkAllowed: () => networkAllowed,
        setNetworkAllowed: (v) => {
          networkAllowed = v;
        },
      };
    },
    subjectId: "subj-aicore-ck",
    deviceId: "dev-ck",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
});

test("probeAicoreCapability standalone is side-effect free (repeatable)", async () => {
  const backend = createInProcessAicoreBackend();
  const a = await probeAicoreCapability({ backend, hostProbe: ANDROID });
  const b = await probeAicoreCapability({ backend, hostProbe: ANDROID });
  assert.deepEqual(a, b);
  assert.equal(a.onDeviceGenerationAvailable, true);
});
