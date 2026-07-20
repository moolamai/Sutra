/**
 * Model obligations ( / CK-03): embed stability, delta streams,
 * truthful locality.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_OBLIGATION_IDS,
  MODEL_REFERENCE_EMBED_DIM,
  MUST_EMBED_DIMENSION_STABLE,
  MUST_LOCALITY_TRUTHFUL,
  MUST_STREAM_DELTAS,
  buildModelEmbedProbeTexts,
  buildModelProbeMessages,
  collectStreamChunks,
  createCumulativeStreamModelHarnessFactory,
  createEmbedDimensionStableObligationRegistry,
  createLocalityLiarModelHarnessFactory,
  createLocalityTruthfulObligationRegistry,
  createModelObligationsRegistry,
  createSelfHostedModelHarnessFactory,
  createStableModelHarnessFactory,
  createStreamDeltasObligationRegistry,
  createUnstableEmbedModelHarnessFactory,
  isCumulativeStreamFrame,
  runConformance,
} from "../dist/index.js";

test("happy path: stable reference passes CK-03.1", async () => {
  const events = [];
  const report = await runConformance({
    registry: createEmbedDimensionStableObligationRegistry(),
    factory: createStableModelHarnessFactory(),
    subjectId: "subj-model-embed-good",
    deviceId: "dev-model",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    MODEL_OBLIGATION_IDS.embedDimensionStable,
  );
  assert.equal(report.verdicts[0].mustText, MUST_EMBED_DIMENSION_STABLE);
  assert.ok(
    events.some(
      (e) =>
        e.event === "conformance.runner" &&
        e.outcome === "pass" &&
        e.obligationId === "CK-03.1" &&
        e.subjectId &&
        e.deviceId === "dev-model",
    ),
  );
});

test("happy path: stable reference passes CK-03.2", async () => {
  const events = [];
  const report = await runConformance({
    registry: createStreamDeltasObligationRegistry(),
    factory: createStableModelHarnessFactory(),
    subjectId: "subj-model-stream-good",
    deviceId: "dev-stream",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(report.verdicts[0].obligationId, MODEL_OBLIGATION_IDS.streamDeltas);
  assert.equal(report.verdicts[0].mustText, MUST_STREAM_DELTAS);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-03.2" &&
        e.deviceId === "dev-stream",
    ),
  );
});

test("happy path: stable reference passes CK-03.3", async () => {
  const events = [];
  const report = await runConformance({
    registry: createLocalityTruthfulObligationRegistry(),
    factory: createStableModelHarnessFactory(),
    subjectId: "subj-model-locality-good",
    deviceId: "dev-locality",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    MODEL_OBLIGATION_IDS.localityTruthful,
  );
  assert.equal(report.verdicts[0].mustText, MUST_LOCALITY_TRUTHFUL);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-03.3" &&
        e.deviceId === "dev-locality",
    ),
  );
});

test("happy path: full model registry passes CK-03.1/2/3", async () => {
  const report = await runConformance({
    registry: createModelObligationsRegistry(),
    factory: createStableModelHarnessFactory(),
    subjectId: "subj-model-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 3);
});

test("happy path: self-hosted reference passes locality under network deny", async () => {
  const report = await runConformance({
    registry: createLocalityTruthfulObligationRegistry(),
    factory: createSelfHostedModelHarnessFactory(),
    subjectId: "subj-model-self-hosted",
  });
  assert.equal(report.exitCode, 0);
});

test("violation: unstable embed fails CK-03.1 exactly", async () => {
  const report = await runConformance({
    registry: createEmbedDimensionStableObligationRegistry(),
    factory: createUnstableEmbedModelHarnessFactory(),
    subjectId: "subj-model-unstable",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    MODEL_OBLIGATION_IDS.embedDimensionStable,
  );
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /unstable|dimension/i);
});

test("violation: cumulative stream fails CK-03.2 exactly", async () => {
  const report = await runConformance({
    registry: createStreamDeltasObligationRegistry(),
    factory: createCumulativeStreamModelHarnessFactory(),
    subjectId: "subj-model-cumulative",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    MODEL_OBLIGATION_IDS.streamDeltas,
  );
  assert.match(report.verdicts[0].message ?? "", /cumulative|delta/i);
});

test("violation: locality liar fails CK-03.3 exactly", async () => {
  const report = await runConformance({
    registry: createLocalityTruthfulObligationRegistry(),
    factory: createLocalityLiarModelHarnessFactory(),
    subjectId: "subj-model-liar",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    MODEL_OBLIGATION_IDS.localityTruthful,
  );
  assert.match(report.verdicts[0].message ?? "", /network|locality/i);
});

test("edge: probe messages and embed texts are subject-scoped metadata", () => {
  const ctx = {
    subjectId: "subj-a::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  const msgs = buildModelProbeMessages(ctx);
  assert.match(msgs[0].content, /subj-a\.peer/);
  assert.doesNotMatch(msgs[0].content, /password|ssn/i);
  const embeds = buildModelEmbedProbeTexts(ctx);
  assert.ok(embeds.every((t) => t.includes("subj-a.peer")));
});

test("edge: isCumulativeStreamFrame detects restated prefixes", () => {
  assert.equal(isCumulativeStreamFrame("", "Hello"), false);
  assert.equal(isCumulativeStreamFrame("Hello", " world"), false);
  assert.equal(isCumulativeStreamFrame("Hello", "Hello world"), true);
});

test("edge: independent factory runs share no mutable network state", async () => {
  const factory = createStableModelHarnessFactory();
  const a = factory();
  const b = factory();
  a.setNetworkAllowed(false);
  assert.equal(a.isNetworkAllowed(), false);
  assert.equal(b.isNetworkAllowed(), true);
});

test("edge: concurrent embeds keep stable dimension", async () => {
  const harness = createStableModelHarnessFactory()();
  const vectors = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.model.embed(`probe.ck03.conc.${i}`),
    ),
  );
  assert.ok(vectors.every((v) => v.length === MODEL_REFERENCE_EMBED_DIM));
});

test("edge: concurrent delta streams concatenate without cumulative frames", async () => {
  const harness = createStableModelHarnessFactory()();
  const messages = [{ role: "user", content: "probe.ck03.conc.stream" }];
  const batches = await Promise.all(
    Array.from({ length: 4 }, () =>
      collectStreamChunks(harness.model.generateStream(messages)),
    ),
  );
  for (const chunks of batches) {
    let acc = "";
    for (const frame of chunks) {
      assert.equal(isCumulativeStreamFrame(acc, frame), false);
      acc += frame;
    }
    const final = await harness.model.generate(messages);
    assert.equal(acc, final.text);
  }
});

test("edge: cumulative fixture still passes CK-03.1 when selected alone", async () => {
  const report = await runConformance({
    registry: createModelObligationsRegistry(),
    factory: createCumulativeStreamModelHarnessFactory(),
    subjectId: "subj-model-partial",
    obligationIds: [MODEL_OBLIGATION_IDS.embedDimensionStable],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: locality liar still passes CK-03.1 under network allow", async () => {
  const report = await runConformance({
    registry: createEmbedDimensionStableObligationRegistry(),
    factory: createLocalityLiarModelHarnessFactory(),
    subjectId: "subj-liar-embed",
  });
  assert.equal(report.exitCode, 0);
});

test("edge: replay of CK-03.3 violation is idempotent", async () => {
  const opts = {
    registry: createLocalityTruthfulObligationRegistry(),
    factory: createLocalityLiarModelHarnessFactory(),
    subjectId: "subj-replay-locality",
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, first.exitCode);
  assert.equal(second.failed, first.failed);
});
