/**
 * LlamaCppSlmRuntime → ModelInterface (B3 adapter) for CognitiveCore.
 * Run: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  MODEL_OBLIGATION_IDS,
  assertLocality,
  createModelObligationsRegistry,
  runConformance,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import {
  EDGE_MODEL_OBLIGATION_INIT,
  EDGE_PROMPT_OBLIGATION_SUBJECT,
  SlmModelAdapterError,
  assembleChatMessagesToPrompt,
} from "@moolam/edge-agent";
import {
  LlamaCppSlmRuntime,
  createLlamaCppModelAdapter,
  createLlamaCppModelAdapterHarnessFactory,
  loadLlamaCppModelAdapter,
  writeMinimalGguf,
} from "../dist/index.js";

const SECRET = "SECRET_MODEADAP_LLAMA_MUST_NOT_LEAK";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "sutra-llama-adap-"));
}

function writeGguf(dir, name = "model.gguf") {
  const weightsPath = path.join(dir, name);
  writeFileSync(
    weightsPath,
    writeMinimalGguf({
      name: "phi-adapter-fixture",
      contextLength: 4096,
      fileType: 15,
      languages: ["en"],
    }),
  );
  return weightsPath;
}

test("happy path: loadLlamaCppModelAdapter → on-device generate/stream/embed", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const events = [];
  const { model, runtime } = await loadLlamaCppModelAdapter(
    {
      weightsPath,
      subjectId: "subj-adap-ok",
      deviceId: "dev-adap-ok",
    },
    {
      subjectId: "subj-adap-ok",
      deviceId: "dev-adap-ok",
      emit: (e) => events.push(e),
    },
  );

  assert.equal(model.descriptor.locality, "on-device");
  assert.equal(model.descriptor.modelId, "phi-adapter-fixture");
  assert.equal(model.descriptor.contextWindow, 4096);
  assert.equal(runtime.isLoaded, true);

  const messages = [
    { role: "system", content: "charter" },
    { role: "user", content: SECRET },
  ];
  const expectedPrompt = assembleChatMessagesToPrompt(messages, {
    contextWindow: 4096,
    subjectId: "subj-adap-ok",
  });

  const out = await model.generate(messages, {
    deadlineMs: 5_000,
    maxTokens: 16,
  });
  assert.equal(out.finishReason, "stop");
  assert.ok(out.text.length > 0);
  assert.ok(out.text.includes(String(expectedPrompt.length)));

  const chunks = [];
  for await (const d of model.generateStream(messages, {
    deadlineMs: 5_000,
    maxTokens: 16,
  })) {
    chunks.push(d);
  }
  assert.equal(chunks.join(""), out.text);

  const v = await model.embed("probe");
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, runtime.embeddingDimension);

  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.slm_model_adapter" &&
        e.outcome === "ok" &&
        e.subjectId === "subj-adap-ok" &&
        e.locality === "on-device",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));

  await runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("edge: createLlamaCppModelAdapter before load → typed init error", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const runtime = new LlamaCppSlmRuntime({ weightsPath });
  assert.equal(runtime.isLoaded, false);

  assert.throws(
    () =>
      createLlamaCppModelAdapter(runtime, {
        subjectId: "subj-nolood",
      }),
    (err) => {
      assert.ok(err instanceof SlmModelAdapterError);
      assert.equal(err.obligationId, EDGE_MODEL_OBLIGATION_INIT);
      assert.equal(err.errorCode, "RUNTIME_NOT_LOADED");
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test("edge: missing subjectId → SUBJECT_REQUIRED", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const runtime = new LlamaCppSlmRuntime({ weightsPath });
  await runtime.load();

  assert.throws(
    () => createLlamaCppModelAdapter(runtime, { subjectId: "  " }),
    (err) => {
      assert.ok(err instanceof SlmModelAdapterError);
      assert.equal(err.obligationId, EDGE_PROMPT_OBLIGATION_SUBJECT);
      return true;
    },
  );
  await runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("edge: aborted AbortSignal → finishReason deadline", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const events = [];
  const { runtime } = await loadLlamaCppModelAdapter(
    { weightsPath },
    { subjectId: "subj-dl", deviceId: "dev-dl" },
  );

  const ac = new AbortController();
  ac.abort();
  const modelAbort = createLlamaCppModelAdapter(runtime, {
    subjectId: "subj-dl",
    deviceId: "dev-dl",
    signal: ac.signal,
    emit: (e) => events.push(e),
  });
  const out = await modelAbort.generate([{ role: "user", content: "z" }], {
    deadlineMs: 5_000,
  });
  assert.equal(out.finishReason, "deadline");
  assert.equal(out.text, "");
  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.slm_model_adapter" &&
        (e.outcome === "deadline" || e.outcome === "aborted") &&
        e.subjectId === "subj-dl",
    ),
  );

  await runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("sovereignty: subject-scoped telemetry; zero cross-subject ids", async () => {
  const dir = tempDir();
  const weightsPath = writeGguf(dir);
  const eventsA = [];
  const eventsB = [];
  const a = await loadLlamaCppModelAdapter(
    { weightsPath, subjectId: "subj-a" },
    {
      subjectId: "subj-a",
      deviceId: "dev-a",
      emit: (e) => eventsA.push(e),
    },
  );
  const b = await loadLlamaCppModelAdapter(
    { weightsPath, subjectId: "subj-b" },
    {
      subjectId: "subj-b",
      deviceId: "dev-b",
      emit: (e) => eventsB.push(e),
    },
  );

  await a.model.generate([{ role: "user", content: "a" }], {
    deadlineMs: 3_000,
    maxTokens: 8,
  });
  await b.model.generate([{ role: "user", content: "b" }], {
    deadlineMs: 3_000,
    maxTokens: 8,
  });

  assert.ok(eventsA.every((e) => e.subjectId === "subj-a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj-b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj-b"));
  assert.ok(!JSON.stringify(eventsB).includes("subj-a"));

  await a.runtime.unload();
  await b.runtime.unload();
  rmSync(dir, { recursive: true, force: true });
});

test("contract: CK-03 full registry green against llama.cpp adapter", async () => {
  const events = [];
  const report = await runConformance({
    registry: createModelObligationsRegistry(),
    factory: createLlamaCppModelAdapterHarnessFactory({
      deviceId: "dev-ck03-llama",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-ck03-llama",
    deviceId: "dev-ck03-llama",
    emit: (e) => events.push(e),
  });

  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts, null, 2));
  assert.equal(report.passed, 3);
  assert.deepEqual(
    report.verdicts.map((v) => v.obligationId).sort(),
    [
      MODEL_OBLIGATION_IDS.embedDimensionStable,
      MODEL_OBLIGATION_IDS.localityTruthful,
      MODEL_OBLIGATION_IDS.streamDeltas,
    ].sort(),
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.slm_model_adapter" &&
        e.locality === "on-device" &&
        typeof e.subjectId === "string" &&
        e.subjectId.startsWith("subj-ck03-llama"),
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_/);
});

test("locality: llama adapter generate/embed zero egress under recorder", async () => {
  const assertEvents = [];
  const { turn, value } = await withEgressRecordingTurn(
    {
      subjectId: "subj-llama-loc",
      deviceId: "dev-llama-loc",
      caller: { principalId: "runtbind-003", subjectScope: "*" },
      selfHostedHosts: ["school.local"],
    },
    async (api) => {
      const mock = api.mockAgent();
      assert.ok(mock);
      mock
        .get("https://vendor.example")
        .intercept({ path: "/v1/infer", method: "POST" })
        .reply(200, { ok: true })
        .times(5);

      const harness = await createLlamaCppModelAdapterHarnessFactory({
        deviceId: "dev-llama-loc",
      })({ subjectId: "subj-llama-loc" });

      return api.withPayloadClass("model-prompt", async () => {
        harness.setNetworkAllowed(false);
        const out = await harness.model.generate(
          [{ role: "user", content: "probe.locality.llama" }],
          { deadlineMs: 5_000, maxTokens: 16 },
        );
        await harness.model.embed("probe.embed.llama");
        return out.text;
      });
    },
  );

  assert.ok(typeof value === "string" && value.length > 0);
  assert.equal(turn.noEgress, true);
  assert.equal(turn.attempts.length, 0);

  const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY, {
    emit: (e) => assertEvents.push(e),
  });
  assert.equal(asserted.ok, true);
});
