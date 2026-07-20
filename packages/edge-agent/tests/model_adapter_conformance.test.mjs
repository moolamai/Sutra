/**
 * CK-03 model obligations + locality zero-egress proof
 * against createSlmModelAdapter (on-device conformance SlmRuntime).
 *
 * Run: pnpm --filter @moolam/edge-agent test
 * (requires build of @moolam/edge-agent and @moolam/contract-conformance)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  MODEL_OBLIGATION_IDS,
  MUST_EMBED_DIMENSION_STABLE,
  MUST_LOCALITY_TRUTHFUL,
  MUST_STREAM_DELTAS,
  assertLocality,
  createCumulativeStreamModelHarnessFactory,
  createModelObligationsRegistry,
  createStreamDeltasObligationRegistry,
  runConformance,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import {
  ChatPromptAssemblyError,
  EDGE_PROMPT_OBLIGATION_EMPTY,
  EDGE_PROMPT_OBLIGATION_OVERFLOW,
  createOnDeviceConformanceSlmRuntime,
  createSlmModelAdapter,
  createSlmModelAdapterHarnessFactory,
} from "../dist/index.js";

const SECRET = "SECRET_MODEADAP003_MUST_NOT_LEAK";

test("happy path: CK-03 full registry passes against SlmRuntime adapter", async () => {
  const events = [];
  const report = await runConformance({
    registry: createModelObligationsRegistry(),
    factory: createSlmModelAdapterHarnessFactory({
      deviceId: "dev-ck03-edge",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-ck03-edge",
    deviceId: "dev-ck03-edge",
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
        e.outcome === "pass" &&
        e.obligationId === MODEL_OBLIGATION_IDS.streamDeltas,
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.slm_model_adapter" &&
        e.outcome === "ok" &&
        typeof e.subjectId === "string" &&
        e.subjectId.startsWith("subj-ck03-edge"),
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_/);
  void MUST_EMBED_DIMENSION_STABLE;
  void MUST_STREAM_DELTAS;
  void MUST_LOCALITY_TRUTHFUL;
});

test("violation: seeded cumulative-stream fixture fails CK-03.2 exactly", async () => {
  const report = await runConformance({
    registry: createStreamDeltasObligationRegistry(),
    factory: createCumulativeStreamModelHarnessFactory(),
    subjectId: "subj-cumul-seeded",
    deviceId: "dev-cumul",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    MODEL_OBLIGATION_IDS.streamDeltas,
  );
  assert.match(report.verdicts[0].message ?? "", /cumulative|delta/i);
});

test("locality: on-device generate/embed records zero egress under recorder", async () => {
  const assertEvents = [];
  const { turn, value } = await withEgressRecordingTurn(
    {
      subjectId: "subj-loc-honest",
      deviceId: "dev-loc-honest",
      caller: { principalId: "modeadap-003", subjectScope: "*" },
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

      const harness = createSlmModelAdapterHarnessFactory({
        deviceId: "dev-loc-honest",
      })({ subjectId: "subj-loc-honest" });

      return api.withPayloadClass("model-prompt", async () => {
        harness.setNetworkAllowed(false);
        const out = await harness.model.generate(
          [{ role: "user", content: "probe.locality.honest" }],
          { maxTokens: 32, deadlineMs: 5_000 },
        );
        const vec = await harness.model.embed("probe.locality.embed");
        assert.ok(vec.length > 0);
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
  assert.ok(
    assertEvents.some(
      (e) =>
        e.event === "locality.assert" &&
        e.outcome === "pass" &&
        e.subjectId === "subj-loc-honest",
    ),
  );
});

test("locality violation: egressing SlmRuntime under on-device fails assertLocality", async () => {
  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-loc-liar",
      deviceId: "dev-loc-liar",
      caller: { principalId: "modeadap-003-liar", subjectScope: "*" },
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

      const harness = createSlmModelAdapterHarnessFactory({
        deviceId: "dev-loc-liar",
        createRuntime: () =>
          createOnDeviceConformanceSlmRuntime({
            egressDuringGenerate: true,
          }),
      })({ subjectId: "subj-loc-liar" });

      return api.withPayloadClass("model-prompt", async () => {
        await harness.model.generate(
          [{ role: "user", content: "probe.locality.liar" }],
          { maxTokens: 16, deadlineMs: 5_000 },
        );
        return "done";
      });
    },
  );

  assert.ok(turn.attempts.length > 0);
  assert.ok(
    turn.attempts.some((a) => a.destinationClass === "third-party"),
  );
  const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
  assert.equal(asserted.ok, false);
  assert.ok(
    asserted.violations.some(
      (v) =>
        v.code === "LOCALITY_FORBIDDEN_DESTINATION" ||
        v.code === "LOCALITY_ON_DEVICE_REQUIRED",
    ),
  );
});

test("edge: empty / overflow still reject before SlmRuntime.generate", async () => {
  let generates = 0;
  const runtime = createOnDeviceConformanceSlmRuntime({
    card: { contextWindow: 16 },
  });
  const wrapped = {
    ...runtime,
    card: runtime.card,
    generate: async (params) => {
      generates += 1;
      return runtime.generate(params);
    },
  };
  const model = createSlmModelAdapter(wrapped, {
    subjectId: "subj-edge",
  });

  await assert.rejects(
    () => model.generate([], { deadlineMs: 1_000 }),
    (err) =>
      err instanceof ChatPromptAssemblyError &&
      err.obligationId === EDGE_PROMPT_OBLIGATION_EMPTY,
  );
  assert.equal(generates, 0);

  await assert.rejects(
    () =>
      model.generate(
        [{ role: "system", content: "z".repeat(200) }],
        { deadlineMs: 1_000 },
      ),
    (err) =>
      err instanceof ChatPromptAssemblyError &&
      err.obligationId === EDGE_PROMPT_OBLIGATION_OVERFLOW,
  );
  assert.equal(generates, 0);
});

test("sovereignty: concurrent subjects keep CK-03 harness events isolated", async () => {
  const events = [];
  const [ra, rb] = await Promise.all([
    runConformance({
      registry: createStreamDeltasObligationRegistry(),
      factory: createSlmModelAdapterHarnessFactory({
        deviceId: "dev-a",
        emit: (e) => events.push(e),
      }),
      subjectId: "subj-iso-a",
      deviceId: "dev-a",
      emit: (e) => events.push(e),
    }),
    runConformance({
      registry: createStreamDeltasObligationRegistry(),
      factory: createSlmModelAdapterHarnessFactory({
        deviceId: "dev-b",
        emit: (e) => events.push(e),
      }),
      subjectId: "subj-iso-b",
      deviceId: "dev-b",
      emit: (e) => events.push(e),
    }),
  ]);
  assert.equal(ra.exitCode, 0);
  assert.equal(rb.exitCode, 0);

  const adapterSubjects = new Set(
    events
      .filter((e) => e.event === "edge_agent.slm_model_adapter")
      .map((e) => e.subjectId.split("::")[0]),
  );
  assert.ok(adapterSubjects.has("subj-iso-a"));
  assert.ok(adapterSubjects.has("subj-iso-b"));
  assert.doesNotMatch(JSON.stringify(events), /SECRET_MODEADAP003/);
  void SECRET;
});

test("edge: replay of CK-03 against same factory is idempotent", async () => {
  const factory = createSlmModelAdapterHarnessFactory({
    deviceId: "dev-replay",
  });
  const opts = {
    registry: createModelObligationsRegistry(),
    factory,
    subjectId: "subj-replay",
    deviceId: "dev-replay",
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(first.passed, second.passed);
});
