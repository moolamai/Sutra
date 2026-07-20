/**
 * AICore graceful absence + edge load planner fallback delegation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import { SlmRuntimeInitError } from "@moolam/edge-agent";
import {
  AicoreSlmRuntime,
  EdgeSlmLoadPlanError,
  UnavailableSlmRuntime,
  buildAicoreCapability,
  createAicoreSlmRuntimeCandidate,
  createInProcessAicoreBackend,
  isUnavailableSlmRuntime,
  planEdgeSlmRuntimeLoad,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const ANDROID = { platform: "android", apiLevel: 34 };
const SECRET = "SECRET_FALLBACK_BODY";
const KOTLIN = path.join(
  PKG,
  "android/src/main/kotlin/com/moolam/bindings/slm/aicore/AicoreFallbackPlanner.kt",
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

function stubFallbackRuntime(id) {
  let loaded = false;
  const card = {
    modelId: `fallback-${id}`,
    contextWindow: 2048,
    quantization: "int8",
    memoryFootprintMiB: 512,
    languages: ["en"],
  };
  return {
    card,
    get isLoaded() {
      return loaded;
    },
    async load() {
      loaded = true;
    },
    async unload() {
      loaded = false;
    },
    async generate(params) {
      return {
        text: `fallback:${params.prompt}`,
        tokensPerSecond: 10,
        finishReason: "stop",
      };
    },
    async *generateStream(params) {
      yield `fallback:${params.prompt}`;
    },
    async embed(text) {
      return new Float32Array([text.length, 0, 0, 0]);
    },
  };
}

test("happy path: capable factory returns AicoreSlmRuntime; planner selects it", async () => {
  assert.ok(existsSync(KOTLIN));
  const events = [];
  const candidate = await createAicoreSlmRuntimeCandidate({
    subjectId: "subj-fb-ok",
    deviceId: "dev-ok",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend(),
    onAbsent: "unavailable",
  });
  assert.ok(candidate instanceof AicoreSlmRuntime);
  assert.equal(isUnavailableSlmRuntime(candidate), false);

  const plan = await planEdgeSlmRuntimeLoad(
    [
      {
        id: "aicore",
        create: async () => candidate,
      },
      {
        id: "onnx-mobile",
        create: async () => stubFallbackRuntime("onnx"),
      },
    ],
    {
      subjectId: "subj-fb-ok",
      deviceId: "dev-ok",
      onTelemetry: (e) => events.push(e),
    },
  );

  assert.equal(plan.selectedCandidateId, "aicore");
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.runtime.isLoaded, true);
  assert.equal(plan.runtime.card.modelId, "gemini-nano-aicore");
  assert.ok(events.some((e) => e.op === "selected" && e.selectedCandidateId === "aicore"));
  assert.ok(events.every((e) => !JSON.stringify(e).includes(SECRET)));
});

test("edge: absent probe → factory null; planner tries next without crash", async () => {
  const absent = buildAicoreCapability({ aicorePresent: false });
  const events = [];
  const aicore = await createAicoreSlmRuntimeCandidate({
    subjectId: "subj-fb-null",
    deviceId: "dev-null",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend({ capability: absent }),
    onAbsent: "null",
  });
  assert.equal(aicore, null);

  const plan = await planEdgeSlmRuntimeLoad(
    [
      {
        id: "aicore",
        create: async () =>
          createAicoreSlmRuntimeCandidate({
            subjectId: "subj-fb-null",
            deviceId: "dev-null",
            hostProbe: ANDROID,
            backend: createInProcessAicoreBackend({ capability: absent }),
            onAbsent: "null",
          }),
      },
      {
        id: "onnx-mobile",
        create: async () => stubFallbackRuntime("onnx"),
      },
    ],
    {
      subjectId: "subj-fb-null",
      deviceId: "dev-null",
      onTelemetry: (e) => events.push(e),
    },
  );

  assert.equal(plan.selectedCandidateId, "onnx-mobile");
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "null");
  assert.equal(plan.runtime.card.modelId, "fallback-onnx");
  const reply = await plan.runtime.generate({
    prompt: "hi",
    maxTokens: 8,
    temperature: 0,
    deadlineMs: 100,
  });
  assert.equal(reply.text, "fallback:hi");
  assert.ok(events.some((e) => e.op === "skip" && e.skipReason === "null"));
});

test("edge: absent → UnavailableSlmRuntime; planner skips typed unavailable", async () => {
  const absent = buildAicoreCapability({ aicorePresent: false });
  const unavailable = await createAicoreSlmRuntimeCandidate({
    subjectId: "subj-fb-unavail",
    deviceId: "dev-unavail",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend({ capability: absent }),
    onAbsent: "unavailable",
  });
  assert.ok(unavailable instanceof UnavailableSlmRuntime);
  assert.equal(isUnavailableSlmRuntime(unavailable), true);
  assert.equal(unavailable.absenceReason, "aicore_absent");

  await assert.rejects(
    () => unavailable.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.match(err.message, /aicore_absent/);
      return true;
    },
  );
  assert.equal(unavailable.loadAttemptCount, 1);

  const plan = await planEdgeSlmRuntimeLoad(
    [
      { id: "aicore", create: async () => unavailable },
      { id: "onnx-mobile", create: async () => stubFallbackRuntime("onnx2") },
    ],
    { subjectId: "subj-fb-unavail", deviceId: "dev-unavail" },
  );
  assert.equal(plan.selectedCandidateId, "onnx-mobile");
  assert.equal(plan.skipped[0].reason, "unavailable");
});

test("edge: downloading → not_ready unavailable; planner falls through", async () => {
  const downloading = buildAicoreCapability({
    aicorePresent: true,
    models: [{ ...READY_MODEL, readiness: "downloading" }],
  });
  const candidate = await createAicoreSlmRuntimeCandidate({
    subjectId: "subj-fb-dl",
    deviceId: "dev-dl",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackend({ capability: downloading }),
    onAbsent: "unavailable",
  });
  assert.ok(isUnavailableSlmRuntime(candidate));
  assert.equal(candidate.absenceReason, "model_downloading");

  const plan = await planEdgeSlmRuntimeLoad(
    [
      { id: "aicore", create: async () => candidate },
      { id: "onnx-mobile", create: async () => stubFallbackRuntime("onnx-dl") },
    ],
    { subjectId: "subj-fb-dl", deviceId: "dev-dl" },
  );
  assert.equal(plan.selectedCandidateId, "onnx-mobile");
});

test("edge: all candidates exhausted → typed EdgeSlmLoadPlanError (no crash loop)", async () => {
  const absent = buildAicoreCapability({ aicorePresent: false });
  let aicoreCreates = 0;
  await assert.rejects(
    () =>
      planEdgeSlmRuntimeLoad(
        [
          {
            id: "aicore",
            create: async () => {
              aicoreCreates += 1;
              return createAicoreSlmRuntimeCandidate({
                hostProbe: ANDROID,
                backend: createInProcessAicoreBackend({ capability: absent }),
                onAbsent: "null",
              });
            },
          },
          {
            id: "onnx-mobile",
            create: async () => null,
          },
        ],
        { subjectId: "subj-fb-ex", deviceId: "dev-ex", maxCandidates: 2 },
      ),
    (err) => {
      assert.ok(err instanceof EdgeSlmLoadPlanError);
      assert.equal(err.skipped.length, 2);
      assert.match(err.message, /no SlmRuntime candidate/);
      return true;
    },
  );
  assert.equal(aicoreCreates, 1);
});

test("edge: OEM modelId pin failure on load → skip to fallback", async () => {
  const plan = await planEdgeSlmRuntimeLoad(
    [
      {
        id: "aicore",
        create: async () =>
          new AicoreSlmRuntime({
            subjectId: "subj-fb-oem",
            deviceId: "dev-oem",
            hostProbe: ANDROID,
            expectedModelId: "gemini-nano-v1-old",
            backend: createInProcessAicoreBackend(),
          }),
      },
      {
        id: "onnx-mobile",
        create: async () => stubFallbackRuntime("after-oem"),
      },
    ],
    { subjectId: "subj-fb-oem", deviceId: "dev-oem" },
  );
  assert.equal(plan.selectedCandidateId, "onnx-mobile");
  assert.ok(
    plan.skipped[0].reason === "load_error" || plan.skipped[0].reason === "absent",
  );
  assert.match(plan.skipped[0].detail, /modelId mismatch/);
});

test("sovereignty: fallback path generate/embed zero egress", async () => {
  const absent = buildAicoreCapability({ aicorePresent: false });
  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-fb-loc",
      deviceId: "dev-loc",
      caller: { principalId: "aicore-fallback", subjectScope: "*" },
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
        const plan = await planEdgeSlmRuntimeLoad(
          [
            {
              id: "aicore",
              create: async () =>
                createAicoreSlmRuntimeCandidate({
                  subjectId: "subj-fb-loc",
                  deviceId: "dev-loc",
                  hostProbe: ANDROID,
                  backend: createInProcessAicoreBackend({ capability: absent }),
                  onAbsent: "unavailable",
                }),
            },
            {
              id: "onnx-mobile",
              create: async () => stubFallbackRuntime("loc"),
            },
          ],
          { subjectId: "subj-fb-loc", deviceId: "dev-loc" },
        );
        await plan.runtime.generate({
          prompt: "local",
          maxTokens: 8,
          temperature: 0,
          deadlineMs: 200,
        });
        await plan.runtime.embed("e");
        return true;
      });
    },
  );
  assert.equal(turn.attempts.length, 0);
  assert.equal(assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY).ok, true);
});

test("sovereignty: concurrent planners keep subjectIds isolated in telemetry", async () => {
  const absent = buildAicoreCapability({ aicorePresent: false });
  const eventsA = [];
  const eventsB = [];
  const [pa, pb] = await Promise.all([
    planEdgeSlmRuntimeLoad(
      [
        {
          id: "aicore",
          create: async () =>
            createAicoreSlmRuntimeCandidate({
              subjectId: "subj-a",
              hostProbe: ANDROID,
              backend: createInProcessAicoreBackend({ capability: absent }),
              onAbsent: "null",
            }),
        },
        { id: "onnx-a", create: async () => stubFallbackRuntime("a") },
      ],
      {
        subjectId: "subj-a",
        deviceId: "dev-a",
        onTelemetry: (e) => eventsA.push(e),
      },
    ),
    planEdgeSlmRuntimeLoad(
      [
        {
          id: "aicore",
          create: async () =>
            createAicoreSlmRuntimeCandidate({
              subjectId: "subj-b",
              hostProbe: ANDROID,
              backend: createInProcessAicoreBackend({ capability: absent }),
              onAbsent: "null",
            }),
        },
        { id: "onnx-b", create: async () => stubFallbackRuntime("b") },
      ],
      {
        subjectId: "subj-b",
        deviceId: "dev-b",
        onTelemetry: (e) => eventsB.push(e),
      },
    ),
  ]);
  assert.equal(pa.selectedCandidateId, "onnx-a");
  assert.equal(pb.selectedCandidateId, "onnx-b");
  assert.ok(eventsA.every((e) => e.subjectId === "subj-a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj-b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj-b"));
});
