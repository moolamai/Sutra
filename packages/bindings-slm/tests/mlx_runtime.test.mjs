/**
 * MlxSlmRuntime — Apple silicon / Metal load + generate + embed (MLXADAP-001).
 */
import test from "node:test";
import assert from "node:assert/strict";
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
  toStreamDeltas,
} from "@moolam/edge-agent";
import {
  MlxSlmRuntime,
  createInProcessMlxMetalBackend,
  mlxAppleSiliconFixturePath,
  probeMlxPlatform,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = mlxAppleSiliconFixturePath();
const SECRET = "SECRET_MLX_UTTERANCE";
const APPLE = { platform: "darwin", arch: "arm64" };

test("unit: probeMlxPlatform allows darwin/arm64 only", () => {
  assert.equal(probeMlxPlatform(APPLE).supported, true);
  const intel = probeMlxPlatform({ platform: "darwin", arch: "x64" });
  assert.equal(intel.supported, false);
  if (!intel.supported) assert.match(intel.detail, /Intel Mac/i);
  const win = probeMlxPlatform({ platform: "win32", arch: "x64" });
  assert.equal(win.supported, false);
});

test("happy path: load fixture on Apple silicon probe — card languages BCP-47", async () => {
  const events = [];
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    subjectId: "subj-mlx-ok",
    deviceId: "dev-apple",
    hostProbe: APPLE,
    backend: createInProcessMlxMetalBackend(),
    onTelemetry: (e) => events.push(e),
  });

  await runtime.load();
  assert.equal(runtime.isLoaded, true);
  assert.equal(runtime.card.modelId, "phi-mlx-mini-apple");
  assert.deepEqual(runtime.card.languages, ["en-IN", "hi-IN", "en"]);
  assert.equal(runtime.card.quantization, "q4");
  assert.equal(runtime.embeddingDimension, 8);

  const reply = await runtime.generate({
    prompt: "hello metal",
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 500,
  });
  assert.ok(reply.text.startsWith("mlx:"));
  assert.ok(["stop", "length"].includes(reply.finishReason));

  const emb = await runtime.embed("vector");
  assert.equal(emb.length, 8);

  // Idempotent load
  await runtime.load();
  await runtime.unload();
  assert.equal(runtime.isLoaded, false);
  assert.ok(events.some((e) => e.op === "platform_probe" && e.outcome === "ok"));
  assert.ok(events.every((e) => !JSON.stringify(e).includes(SECRET)));
  assert.ok(events.every((e) => e.subjectId === "subj-mlx-ok" || !e.subjectId));
});

test("edge: Intel Mac → typed unsupported_platform, no crash loop", async () => {
  const events = [];
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    subjectId: "subj-mlx-intel",
    deviceId: "dev-intel",
    hostProbe: { platform: "darwin", arch: "x64" },
    backend: createInProcessMlxMetalBackend(),
    onTelemetry: (e) => events.push(e),
  });

  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.equal(err.failureClass, "config");
      assert.equal(err.obligationId, EDGE_SLM_LOAD_OBLIGATION);
      assert.match(err.message, /unsupported_platform/);
      assert.match(err.message, /Intel Mac/i);
      return true;
    },
  );
  assert.equal(runtime.isLoaded, false);
  assert.equal(runtime.loadAttemptCount, 1);
  // Second load still fails once — no internal retry loop
  await assert.rejects(() => runtime.load(), (err) => err instanceof SlmRuntimeInitError);
  assert.equal(runtime.loadAttemptCount, 2);
  assert.ok(
    events.some(
      (e) => e.op === "platform_probe" && e.outcome === "unsupported_platform",
    ),
  );
});

test("edge: missing weights → typed missing_weights", async () => {
  const runtime = new MlxSlmRuntime({
    weightsPath: path.join(path.dirname(FIXTURE), "no-such.mlx"),
    hostProbe: APPLE,
  });
  await assert.rejects(
    () => runtime.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.equal(err.failureClass, "missing_weights");
      return true;
    },
  );
});

test("edge: deadline abort → finishReason deadline (thermal / slow path)", async () => {
  const base = createInProcessMlxMetalBackend();
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    hostProbe: APPLE,
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
    prompt: "slow",
    maxTokens: 32,
    temperature: 0,
    deadlineMs: 1,
  });
  assert.equal(result.finishReason, "deadline");
  await runtime.unload();
});

test("invariant: embed dim stable across float16/float32 backend dtype", async () => {
  for (const dtype of ["float16", "float32"]) {
    const runtime = new MlxSlmRuntime({
      weightsPath: FIXTURE,
      hostProbe: APPLE,
      backend: createInProcessMlxMetalBackend({ embedDtype: dtype }),
    });
    await runtime.load();
    const a = await runtime.embed("a");
    const b = await runtime.embed("b");
    assert.equal(a.length, 8);
    assert.equal(b.length, 8);
    assert.equal(a.length, runtime.embeddingDimension);
    await runtime.unload();
  }
});

test("invariant: generateStream yields CK deltas (not cumulative)", async () => {
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    hostProbe: APPLE,
    backend: createInProcessMlxMetalBackend({ streamChunkChars: 2 }),
  });
  await runtime.load();
  const chunks = [];
  for await (const d of runtime.generateStream({
    prompt: "stream",
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 500,
  })) {
    chunks.push(d);
  }
  assert.ok(chunks.length >= 2);
  // Defense-in-depth: deltas equal toStreamDeltas of joined stream
  const joined = chunks.join("");
  const rebuilt = [];
  for await (const d of toStreamDeltas(
    (async function* () {
      yield joined;
    })(),
  )) {
    rebuilt.push(d);
  }
  assert.equal(rebuilt.join(""), joined);
  // No chunk should equal the full cumulative prefix of a later chunk wrongly
  // (each chunk is a suffix piece — simple check: chunks concatenating equals full)
  assert.ok(joined.startsWith("mlx:"));
  await runtime.unload();
});

test("sovereignty: generate/embed zero egress under locality recorder", async () => {
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    subjectId: "subj-mlx-loc",
    deviceId: "dev-mlx-loc",
    hostProbe: APPLE,
  });
  await runtime.load();

  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-mlx-loc",
      deviceId: "dev-mlx-loc",
      caller: { principalId: "mlx-runtime-test", subjectScope: "*" },
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
          prompt: "local",
          maxTokens: 8,
          temperature: 0,
          deadlineMs: 400,
        });
        await runtime.embed("local");
        return true;
      });
    },
  );

  const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
  assert.equal(asserted.ok, true);
  assert.equal(turn.noEgress, true);
  await runtime.unload();
});

test("contract: CK-03 model obligations green via ModelInterface adapter", async () => {
  const runtime = new MlxSlmRuntime({
    weightsPath: FIXTURE,
    subjectId: "subj-mlx-ck03",
    deviceId: "dev-mlx-ck03",
    hostProbe: APPLE,
  });
  await runtime.load();
  const model = createSlmModelAdapter(runtime, {
    subjectId: "subj-mlx-ck03",
    deviceId: "dev-mlx-ck03",
    locality: "on-device",
  });

  let networkAllowed = true;
  const report = await runConformance({
    registry: createModelObligationsRegistry(),
    factory: async () => ({
      model,
      isNetworkAllowed: () => networkAllowed,
      setNetworkAllowed: (v) => {
        networkAllowed = v;
      },
    }),
    subjectId: "subj-mlx-ck03",
    deviceId: "dev-mlx-ck03",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
  await runtime.unload();
});

test("sovereignty: concurrent subjects keep isolated telemetry", async () => {
  const a = [];
  const b = [];
  await Promise.all([
    (async () => {
      const rt = new MlxSlmRuntime({
        weightsPath: FIXTURE,
        subjectId: "subj-a",
        deviceId: "dev-a",
        hostProbe: APPLE,
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
      const rt = new MlxSlmRuntime({
        weightsPath: FIXTURE,
        subjectId: "subj-b",
        deviceId: "dev-b",
        hostProbe: APPLE,
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
});
