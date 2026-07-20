/**
 * Vision obligations ( / CK-06): oversized rejection + schema JSON.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MUST_REJECT_OVERSIZED,
  MUST_SCHEMA_VALID_JSON,
  VISION_OBLIGATION_IDS,
  VISION_REFERENCE_MAX_INPUT_BYTES,
  buildVisionProbeInput,
  buildVisionProbeInstruction,
  buildVisionProbeResponseSchema,
  createAcceptOversizedVisionHarnessFactory,
  createInvalidSchemaAnswerVisionHarnessFactory,
  createProcessBeforeRejectVisionHarnessFactory,
  createRejectOversizedObligationRegistry,
  createSchemaValidJsonObligationRegistry,
  createStrictVisionHarnessFactory,
  createUntypedSizeErrorVisionHarnessFactory,
  createVisionObligationsRegistry,
  createVisionSizeLimitError,
  isTypedSizeLimitError,
  runConformance,
  validateAnswerAgainstSchema,
} from "../dist/index.js";

test("happy path: strict reference passes CK-06.1", async () => {
  const events = [];
  const report = await runConformance({
    registry: createRejectOversizedObligationRegistry(),
    factory: createStrictVisionHarnessFactory(),
    subjectId: "subj-vision-size-good",
    deviceId: "dev-vision",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    VISION_OBLIGATION_IDS.rejectOversized,
  );
  assert.equal(report.verdicts[0].mustText, MUST_REJECT_OVERSIZED);
  assert.ok(
    events.some(
      (e) =>
        e.event === "conformance.runner" &&
        e.outcome === "pass" &&
        e.obligationId === "CK-06.1" &&
        e.subjectId &&
        e.deviceId === "dev-vision",
    ),
  );
});

test("happy path: strict reference passes CK-06.2", async () => {
  const events = [];
  const report = await runConformance({
    registry: createSchemaValidJsonObligationRegistry(),
    factory: createStrictVisionHarnessFactory(),
    subjectId: "subj-vision-schema-good",
    deviceId: "dev-schema",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    VISION_OBLIGATION_IDS.schemaValidJson,
  );
  assert.equal(report.verdicts[0].mustText, MUST_SCHEMA_VALID_JSON);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-06.2" &&
        e.deviceId === "dev-schema",
    ),
  );
});

test("happy path: full vision registry passes CK-06.1 and CK-06.2", async () => {
  const report = await runConformance({
    registry: createVisionObligationsRegistry(),
    factory: createStrictVisionHarnessFactory(),
    subjectId: "subj-vision-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
});

test("violation: accept-oversized fails CK-06.1 exactly", async () => {
  const report = await runConformance({
    registry: createRejectOversizedObligationRegistry(),
    factory: createAcceptOversizedVisionHarnessFactory(),
    subjectId: "subj-vision-accept",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    VISION_OBLIGATION_IDS.rejectOversized,
  );
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /degradation|oversized/i);
});

test("violation: untyped size error fails CK-06.1", async () => {
  const report = await runConformance({
    registry: createRejectOversizedObligationRegistry(),
    factory: createUntypedSizeErrorVisionHarnessFactory(),
    subjectId: "subj-vision-untyped",
  });
  assert.equal(report.exitCode, 1);
  assert.match(report.verdicts[0].message ?? "", /typed|size/i);
});

test("violation: process-before-reject fails CK-06.1", async () => {
  const report = await runConformance({
    registry: createRejectOversizedObligationRegistry(),
    factory: createProcessBeforeRejectVisionHarnessFactory(),
    subjectId: "subj-vision-process-first",
  });
  assert.equal(report.exitCode, 1);
  assert.match(report.verdicts[0].message ?? "", /before processing|processed/i);
});

test("violation: invalid schema answer fails CK-06.2 exactly", async () => {
  const report = await runConformance({
    registry: createSchemaValidJsonObligationRegistry(),
    factory: createInvalidSchemaAnswerVisionHarnessFactory(),
    subjectId: "subj-vision-bad-schema",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    VISION_OBLIGATION_IDS.schemaValidJson,
  );
  assert.match(report.verdicts[0].message ?? "", /schema|JSON|json/i);
});

test("edge: probe input/instruction are subject-scoped metadata", () => {
  const ctx = {
    subjectId: "subj-a::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  assert.match(buildVisionProbeInstruction(ctx), /subj-a\.peer/);
  const decoded = new TextDecoder().decode(
    buildVisionProbeInput(32, ctx).data,
  );
  assert.match(decoded, /subj-a\.peer/);
  assert.doesNotMatch(decoded, /password|ssn/i);
});

test("edge: isTypedSizeLimitError and validateAnswerAgainstSchema helpers", () => {
  assert.equal(isTypedSizeLimitError(createVisionSizeLimitError(64, 65)), true);
  assert.equal(isTypedSizeLimitError(new Error("failed")), false);
  const schema = buildVisionProbeResponseSchema();
  assert.equal(
    validateAnswerAgainstSchema('{"label":"x","score":1}', schema).ok,
    true,
  );
  assert.equal(validateAnswerAgainstSchema("plain", schema).ok, false);
  assert.equal(validateAnswerAgainstSchema('{"label":"x"}', schema).ok, false);
});

test("edge: independent factory runs share no mutable process counters", async () => {
  const factory = createStrictVisionHarnessFactory();
  const a = factory();
  const b = factory();
  await a.vision.analyze({
    input: buildVisionProbeInput(8, {
      subjectId: "s",
      deviceId: "d",
      deadlineMs: 1,
      emit() {},
    }),
    instruction: "probe",
  });
  assert.ok(a.processedCount() > 0);
  assert.equal(b.processedCount(), 0);
});

test("edge: concurrent in-limit schema analyzes stay valid", async () => {
  const harness = createStrictVisionHarnessFactory()();
  const schema = buildVisionProbeResponseSchema();
  const ctx = {
    subjectId: "subj-conc",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.vision.analyze({
        input: buildVisionProbeInput(8, ctx),
        instruction: `probe.ck06.conc.${i}`,
        responseSchema: schema,
      }),
    ),
  );
  assert.ok(
    results.every((r) => validateAnswerAgainstSchema(r.answer, schema).ok),
  );
});

test("edge: concurrent oversized rejects stay typed and unprocessed", async () => {
  const harness = createStrictVisionHarnessFactory()();
  const ctx = {
    subjectId: "subj-over",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, async () => {
      try {
        await harness.vision.analyze({
          input: buildVisionProbeInput(VISION_REFERENCE_MAX_INPUT_BYTES + 1, ctx),
          instruction: "probe.over",
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, typed: isTypedSizeLimitError(err) };
      }
    }),
  );
  assert.ok(outcomes.every((o) => o.ok === false && o.typed === true));
  assert.equal(harness.processedCount(), 0);
});

test("edge: accept-oversized still passes CK-06.2 when selected alone", async () => {
  const report = await runConformance({
    registry: createVisionObligationsRegistry(),
    factory: createAcceptOversizedVisionHarnessFactory(),
    subjectId: "subj-vision-partial",
    obligationIds: [VISION_OBLIGATION_IDS.schemaValidJson],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: replay of CK-06.1 violation is idempotent", async () => {
  const opts = {
    registry: createRejectOversizedObligationRegistry(),
    factory: createAcceptOversizedVisionHarnessFactory(),
    subjectId: "subj-replay-vision",
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, first.exitCode);
  assert.equal(second.failed, first.failed);
});
