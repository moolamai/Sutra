/**
 * Fixture-driven AICore device integration: capable / absent / downloading.
 * Load planner selects ONNX fallback when seam reports absent; zero egress on
 * the capable present path.
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
  createSlmModelAdapter,
  SlmRuntimeInitError,
} from "@moolam/edge-agent";
import {
  OnnxSlmRuntime,
  aicoreScenarioPath,
  createAicoreSlmRuntimeCandidate,
  createInProcessAicoreBackendFromFixture,
  createInProcessOnnxMobileBackend,
  loadAicoreDeviceScenario,
  planEdgeSlmRuntimeLoad,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const ANDROID = { platform: "android", apiLevel: 34 };
const ONNX_WITHIN = path.join(PKG, "android/fixtures/within-budget.onnx");
const SECRET = "SECRET_AICORE_DEVICE_BODY";

function createOnnxFallbackCandidate(opts = {}) {
  return new OnnxSlmRuntime({
    weightsPath: ONNX_WITHIN,
    subjectId: opts.subjectId ?? "subj-onnx-fallback",
    deviceId: opts.deviceId ?? "dev-onnx-fallback",
    backend: createInProcessOnnxMobileBackend(),
    ...(opts.onTelemetry ? { onTelemetry: opts.onTelemetry } : {}),
  });
}

async function planForScenario(scenarioId, opts = {}) {
  const { scenario, capability, capabilityFixtureAbs } = loadAicoreDeviceScenario(
    aicoreScenarioPath(scenarioId, PKG),
    PKG,
  );
  const planEvents = [];
  const plan = await planEdgeSlmRuntimeLoad(
    [
      {
        id: "aicore",
        create: async () =>
          createAicoreSlmRuntimeCandidate({
            subjectId: opts.subjectId ?? `subj-${scenarioId}`,
            deviceId: opts.deviceId ?? `dev-${scenarioId}`,
            hostProbe: ANDROID,
            backend: createInProcessAicoreBackendFromFixture(capabilityFixtureAbs),
            onAbsent: opts.onAbsent ?? "unavailable",
            ...(opts.aicoreTelemetry
              ? { onTelemetry: opts.aicoreTelemetry }
              : {}),
          }),
      },
      {
        id: "onnx-mobile",
        create: async () =>
          createOnnxFallbackCandidate({
            subjectId: opts.subjectId ?? `subj-${scenarioId}`,
            deviceId: opts.deviceId ?? `dev-${scenarioId}`,
            ...(opts.onnxTelemetry ? { onTelemetry: opts.onnxTelemetry } : {}),
          }),
      },
    ],
    {
      subjectId: opts.subjectId ?? `subj-${scenarioId}`,
      deviceId: opts.deviceId ?? `dev-${scenarioId}`,
      onTelemetry: (e) => planEvents.push(e),
    },
  );
  return { scenario, capability, plan, planEvents };
}

test("fixture: capable / absent / downloading scenarios load truthfully", () => {
  for (const id of ["capable", "absent", "downloading"]) {
    const { scenario, capability } = loadAicoreDeviceScenario(
      aicoreScenarioPath(id, PKG),
      PKG,
    );
    assert.equal(scenario.scenarioId, id);
    assert.equal(
      capability.onDeviceGenerationAvailable,
      scenario.expectOnDeviceGenerationAvailable,
    );
    if (scenario.expectAbsenceReason) {
      assert.equal(capability.absenceReason, scenario.expectAbsenceReason);
    }
  }
});

test("happy path: capable device → planner selects aicore; generate/embed; zero egress", async () => {
  const aicoreEvents = [];
  const { scenario, plan, planEvents } = await planForScenario("capable", {
    subjectId: "subj-cap",
    deviceId: "dev-cap",
    aicoreTelemetry: (e) => aicoreEvents.push(e),
  });

  assert.equal(plan.selectedCandidateId, scenario.expectSelectedCandidateId);
  assert.equal(plan.selectedCandidateId, "aicore");
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.runtime.card.modelId, "gemini-nano-aicore");
  assert.ok(plan.runtime.isLoaded);

  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-cap",
      deviceId: "dev-cap",
      caller: { principalId: "aicore-device-cap", subjectScope: "*" },
      selfHostedHosts: ["school.local"],
    },
    async (api) => {
      api
        .mockAgent()
        ?.get("https://vendor.example")
        .intercept({ path: "/v1/infer", method: "POST" })
        .reply(200, { ok: true })
        .times(5);

      return api.withPayloadClass("model-prompt", async () => {
        const reply = await plan.runtime.generate({
          prompt: "capable on-device",
          maxTokens: 16,
          temperature: 0,
          deadlineMs: 500,
        });
        assert.ok(reply.text.startsWith("aicore:"));
        const emb = await plan.runtime.embed("vec");
        assert.equal(emb.length, 8);
        return true;
      });
    },
  );

  assert.equal(turn.attempts.length, 0);
  assert.equal(assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY).ok, true);
  assert.ok(planEvents.some((e) => e.op === "selected" && e.candidateId === "aicore"));
  assert.ok(aicoreEvents.every((e) => !JSON.stringify(e).includes(SECRET)));
  assert.ok(aicoreEvents.every((e) => e.subjectId === "subj-cap" || !e.subjectId));
});

test("happy path: absent device → planner selects onnx-mobile fallback", async () => {
  const { scenario, capability, plan, planEvents } = await planForScenario(
    "absent",
    { subjectId: "subj-abs", deviceId: "dev-abs" },
  );

  assert.equal(capability.absenceReason, "aicore_absent");
  assert.equal(plan.selectedCandidateId, scenario.expectSelectedCandidateId);
  assert.equal(plan.selectedCandidateId, "onnx-mobile");
  assert.equal(plan.skipped.length, 1);
  assert.ok(
    plan.skipped[0].reason === "unavailable" || plan.skipped[0].reason === "null",
  );
  assert.equal(plan.runtime.card.modelId, "phi-mini-int8-within");
  assert.ok(plan.runtime.isLoaded);

  const reply = await plan.runtime.generate({
    prompt: "fallback",
    maxTokens: 16,
    temperature: 0,
    deadlineMs: 500,
  });
  assert.ok(reply.text.startsWith("onnx:"));
  assert.ok(
    planEvents.some(
      (e) => e.op === "selected" && e.selectedCandidateId === "onnx-mobile",
    ),
  );
});

test("edge: downloading device → not_ready skipped; onnx-mobile selected (no hang)", async () => {
  const { scenario, capability, plan } = await planForScenario("downloading", {
    subjectId: "subj-dl",
    deviceId: "dev-dl",
  });

  assert.equal(capability.absenceReason, "model_downloading");
  assert.equal(plan.selectedCandidateId, scenario.expectSelectedCandidateId);
  assert.equal(plan.runtime.card.modelId, "phi-mini-int8-within");

  // Direct AICore load still typed not_ready if forced.
  const forced = await createAicoreSlmRuntimeCandidate({
    subjectId: "subj-dl-force",
    deviceId: "dev-dl",
    hostProbe: ANDROID,
    backend: createInProcessAicoreBackendFromFixture(
      path.join(PKG, scenario.capabilityFixtureRelpath),
    ),
    onAbsent: "unavailable",
  });
  await assert.rejects(
    () => forced.load(),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.match(err.message, /not_ready/);
      return true;
    },
  );
});

test("edge: deadline abort on capable path → finishReason deadline", async () => {
  const { capabilityFixtureAbs } = loadAicoreDeviceScenario(
    aicoreScenarioPath("capable", PKG),
    PKG,
  );
  const backend = createInProcessAicoreBackendFromFixture(capabilityFixtureAbs);
  const wrapped = {
    kind: "in-process",
    probe: (h) => backend.probe(h),
    load: (m) => backend.load(m),
    unload: (h) => backend.unload(h),
    embed: (h, t) => backend.embed(h, t),
    generateStream: (h, p) => backend.generateStream(h, p),
    async generate(_h, params) {
      if (params.deadlineMs <= 1 || params.signal?.aborted) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }
      return backend.generate(_h, params);
    },
  };
  const runtime = await createAicoreSlmRuntimeCandidate({
    subjectId: "subj-deadline",
    deviceId: "dev-deadline",
    hostProbe: ANDROID,
    backend: wrapped,
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

test("edge: corrupt capability fixture → typed init error (no crash loop)", () => {
  const bad = path.join(PKG, "android/aicore/fixtures/__missing__.capability.json");
  assert.throws(
    () => createInProcessAicoreBackendFromFixture(bad),
    (err) => {
      assert.ok(err instanceof SlmRuntimeInitError);
      assert.equal(err.failureClass, "missing_weights");
      return true;
    },
  );
});

test("contract: CK-03 green on capable device via ModelInterface", async () => {
  const { capabilityFixtureAbs } = loadAicoreDeviceScenario(
    aicoreScenarioPath("capable", PKG),
    PKG,
  );
  const report = await runConformance({
    registry: createModelObligationsRegistry(),
    factory: async ({ subjectId }) => {
      const plan = await planEdgeSlmRuntimeLoad(
        [
          {
            id: "aicore",
            create: async () =>
              createAicoreSlmRuntimeCandidate({
                subjectId,
                deviceId: "dev-ck-cap",
                hostProbe: ANDROID,
                backend: createInProcessAicoreBackendFromFixture(
                  capabilityFixtureAbs,
                ),
              }),
          },
          {
            id: "onnx-mobile",
            create: async () =>
              createOnnxFallbackCandidate({
                subjectId,
                deviceId: "dev-ck-cap",
              }),
          },
        ],
        { subjectId, deviceId: "dev-ck-cap" },
      );
      assert.equal(plan.selectedCandidateId, "aicore");
      let networkAllowed = true;
      return {
        model: createSlmModelAdapter(plan.runtime, {
          subjectId,
          deviceId: "dev-ck-cap",
          locality: "on-device",
        }),
        isNetworkAllowed: () => networkAllowed,
        setNetworkAllowed: (v) => {
          networkAllowed = v;
        },
      };
    },
    subjectId: "subj-ck-cap",
    deviceId: "dev-ck-cap",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
});

test("sovereignty: absent→onnx path zero egress; concurrent subjects isolated", async () => {
  const { capabilityFixtureAbs } = loadAicoreDeviceScenario(
    aicoreScenarioPath("absent", PKG),
    PKG,
  );

  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-abs-loc",
      deviceId: "dev-abs-loc",
      caller: { principalId: "aicore-device-abs", subjectScope: "*" },
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
                  subjectId: "subj-abs-loc",
                  deviceId: "dev-abs-loc",
                  hostProbe: ANDROID,
                  backend: createInProcessAicoreBackendFromFixture(
                    capabilityFixtureAbs,
                  ),
                  onAbsent: "unavailable",
                }),
            },
            {
              id: "onnx-mobile",
              create: async () =>
                createOnnxFallbackCandidate({
                  subjectId: "subj-abs-loc",
                  deviceId: "dev-abs-loc",
                }),
            },
          ],
          { subjectId: "subj-abs-loc", deviceId: "dev-abs-loc" },
        );
        assert.equal(plan.selectedCandidateId, "onnx-mobile");
        await plan.runtime.generate({
          prompt: "local",
          maxTokens: 8,
          temperature: 0,
          deadlineMs: 500,
        });
        await plan.runtime.embed("e");
        return true;
      });
    },
  );
  assert.equal(turn.attempts.length, 0);
  assert.equal(assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY).ok, true);

  const eventsA = [];
  const eventsB = [];
  await Promise.all([
    planEdgeSlmRuntimeLoad(
      [
        {
          id: "aicore",
          create: async () =>
            createAicoreSlmRuntimeCandidate({
              subjectId: "subj-a",
              hostProbe: ANDROID,
              backend: createInProcessAicoreBackendFromFixture(
                capabilityFixtureAbs,
              ),
              onAbsent: "null",
            }),
        },
        {
          id: "onnx-mobile",
          create: async () =>
            createOnnxFallbackCandidate({
              subjectId: "subj-a",
              deviceId: "dev-a",
            }),
        },
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
              backend: createInProcessAicoreBackendFromFixture(
                capabilityFixtureAbs,
              ),
              onAbsent: "null",
            }),
        },
        {
          id: "onnx-mobile",
          create: async () =>
            createOnnxFallbackCandidate({
              subjectId: "subj-b",
              deviceId: "dev-b",
            }),
        },
      ],
      {
        subjectId: "subj-b",
        deviceId: "dev-b",
        onTelemetry: (e) => eventsB.push(e),
      },
    ),
  ]);
  assert.ok(eventsA.every((e) => e.subjectId === "subj-a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj-b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj-b"));
});
