/**
 * Local VLM binding — VisionInterface.analyze + CK-06 gates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVisionProbeInput,
  buildVisionProbeInstruction,
  buildVisionProbeResponseSchema,
  createVisionObligationsRegistry,
  isTypedSizeLimitError,
  runConformance,
  validateAnswerAgainstSchema,
} from "@moolam/contract-conformance";
import {
  DEFAULT_MAX_INPUT_BYTES,
  LOCAL_VLM_ENGINE,
  LocalVlmError,
  VisionFormatError,
  VisionInputTooLargeError,
  VisionSchemaError,
  assertDecodableVisualInput,
  createInProcessLocalVlmBackend,
  createLocalVlmVisionHarnessFactory,
  loadLocalVlm,
} from "../dist/index.js";

const SECRET = "LEARNER_WORKSHEET_PHOTO_MUST_NOT_APPEAR";

function tinyPng() {
  // Minimal valid PNG signature + IHDR stub bytes (not a full decode).
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
}

test("happy path: load declares maxInputBytes and engine", async () => {
  const events = [];
  const vlm = await loadLocalVlm({
    subjectId: "subj.vlm.load",
    deviceId: "dev-vlm",
    maxInputBytes: 1024,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(vlm.maxInputBytes, 1024);
  assert.equal(vlm.engine, LOCAL_VLM_ENGINE);
  assert.ok(events.some((e) => e.op === "load" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  await vlm.unload();
});

test("happy path: analyze without schema returns free-text answer", async () => {
  const events = [];
  const vlm = await loadLocalVlm({
    subjectId: "subj.vlm.free",
    deviceId: "dev-vlm",
    maxInputBytes: 4096,
    onTelemetry: (e) => events.push(e),
  });
  const result = await vlm.analyze({
    input: { data: tinyPng(), mimeType: "image/png" },
    instruction: "describe worksheet",
  });
  assert.ok(typeof result.answer === "string" && result.answer.length > 0);
  assert.ok(result.confidence > 0);
  assert.equal(vlm.processedCount(), 1);
  assert.ok(
    events.some(
      (e) =>
        e.op === "analyze" &&
        e.outcome === "ok" &&
        e.hasResponseSchema === false,
    ),
  );
  assert.ok(!JSON.stringify(events).includes("describe worksheet"));
  await vlm.unload();
});

test("happy path: analyze with responseSchema returns schema-valid JSON", async () => {
  const vlm = await loadLocalVlm({
    subjectId: "subj.vlm.schema",
    deviceId: "dev-vlm",
    maxInputBytes: 4096,
  });
  const schema = buildVisionProbeResponseSchema();
  const result = await vlm.analyze({
    input: { data: tinyPng(), mimeType: "image/png" },
    instruction: "extract label",
    responseSchema: schema,
  });
  const validated = validateAnswerAgainstSchema(result.answer, schema);
  assert.equal(validated.ok, true, JSON.stringify(validated));
  await vlm.unload();
});

test("happy path: CK-06 vision conformance green on local VLM", async () => {
  const report = await runConformance({
    registry: createVisionObligationsRegistry(),
    factory: createLocalVlmVisionHarnessFactory({
      deviceId: "dev-ck06-vlm",
      maxInputBytes: 64,
    }),
    subjectId: "subj.vlm.ck06",
    deviceId: "dev-ck06-vlm",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
  assert.equal(report.passed, 2);
});

test("edge: oversized input → typed size error before processing", async () => {
  const events = [];
  const vlm = await loadLocalVlm({
    subjectId: "subj.vlm.oversize",
    deviceId: "dev-vlm",
    maxInputBytes: 32,
    onTelemetry: (e) => events.push(e),
  });
  const before = vlm.processedCount();
  await assert.rejects(
    () =>
      vlm.analyze({
        input: { data: new Uint8Array(40), mimeType: "image/png" },
        instruction: "should not run",
      }),
    (err) =>
      err instanceof VisionInputTooLargeError &&
      isTypedSizeLimitError(err) &&
      err.actualBytes === 40 &&
      err.maxInputBytes === 32,
  );
  assert.equal(vlm.processedCount(), before);
  assert.ok(
    events.some(
      (e) =>
        e.op === "analyze" &&
        e.outcome === "error" &&
        e.failureClass === "size_limit",
    ),
  );
  await vlm.unload();
});

test("edge: JPEG magic with image/png mime → typed format error", async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.throws(
    () => assertDecodableVisualInput({ data: jpeg, mimeType: "image/png" }),
    (err) => err instanceof VisionFormatError,
  );
  const vlm = await loadLocalVlm({
    subjectId: "subj.vlm.format",
    deviceId: "dev-vlm",
    maxInputBytes: 4096,
  });
  await assert.rejects(
    () =>
      vlm.analyze({
        input: { data: jpeg, mimeType: "image/png" },
        instruction: "decode",
      }),
    (err) => err instanceof VisionFormatError,
  );
  // Format failure happens after size gate but counts as processing attempt
  // only after format passes — format rejects before model; processed stays 0
  // if we reject before increment... Looking at impl: assertDecodable before
  // processedCount++. Good.
  assert.equal(vlm.processedCount(), 0);
  await vlm.unload();
});

test("edge: backend prose under responseSchema → typed schema error", async () => {
  const backend = createInProcessLocalVlmBackend();
  const wrapped = {
    ...backend,
    async analyze(handle, params) {
      if (params.responseSchema) {
        return { answer: "not-json free text prose", confidence: 0.5 };
      }
      return backend.analyze(handle, params);
    },
  };
  const vlm = await loadLocalVlm({
    subjectId: "subj.vlm.schema.bad",
    deviceId: "dev-vlm",
    maxInputBytes: 4096,
    backend: wrapped,
  });
  await assert.rejects(
    () =>
      vlm.analyze({
        input: { data: tinyPng(), mimeType: "image/png" },
        instruction: "extract",
        responseSchema: buildVisionProbeResponseSchema(),
      }),
    (err) => err instanceof VisionSchemaError,
  );
  await vlm.unload();
});

test("edge: empty instruction / missing subjectId → typed validation/config", async () => {
  await assert.rejects(
    () => loadLocalVlm({ subjectId: "  ", deviceId: "dev" }),
    (err) => err instanceof LocalVlmError && err.failureClass === "config",
  );
  const vlm = await loadLocalVlm({
    subjectId: "subj.vlm.empty",
    deviceId: "dev-vlm",
  });
  await assert.rejects(
    () =>
      vlm.analyze({
        input: { data: tinyPng(), mimeType: "image/png" },
        instruction: "   ",
      }),
    (err) => err instanceof LocalVlmError && err.failureClass === "validation",
  );
  await vlm.unload();
});

test("edge: idempotent replay of same analyze request", async () => {
  const vlm = await loadLocalVlm({
    subjectId: "subj.vlm.replay",
    deviceId: "dev-vlm",
  });
  const req = {
    input: { data: tinyPng(), mimeType: "image/png" },
    instruction: "replay",
    responseSchema: buildVisionProbeResponseSchema(),
  };
  const a = await vlm.analyze(req);
  const b = await vlm.analyze(req);
  assert.equal(a.answer, b.answer);
  assert.equal(vlm.processedCount(), 2);
  await vlm.unload();
});

test("sovereignty: concurrent subjects stay isolated in telemetry", async () => {
  const eventsA = [];
  const eventsB = [];
  const [a, b] = await Promise.all([
    loadLocalVlm({
      subjectId: "subj.vlm.a",
      deviceId: "dev-a",
      onTelemetry: (e) => eventsA.push(e),
    }),
    loadLocalVlm({
      subjectId: "subj.vlm.b",
      deviceId: "dev-b",
      onTelemetry: (e) => eventsB.push(e),
    }),
  ]);
  await Promise.all([
    a.analyze({
      input: { data: tinyPng(), mimeType: "image/png" },
      instruction: "alpha",
    }),
    b.analyze({
      input: { data: tinyPng(), mimeType: "image/png" },
      instruction: "beta",
    }),
  ]);
  assert.ok(eventsA.every((e) => e.subjectId === "subj.vlm.a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj.vlm.b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj.vlm.b"));
  assert.ok(!JSON.stringify(eventsA).includes("alpha"));
  await Promise.all([a.unload(), b.unload()]);
});

test("unit: default maxInputBytes is positive; probe helpers still usable", () => {
  assert.ok(DEFAULT_MAX_INPUT_BYTES > 64);
  const input = buildVisionProbeInput(8, {
    subjectId: "subj",
    obligationId: "CK-06.2",
    signal: new AbortController().signal,
  });
  assert.equal(input.mimeType, "image/png");
  assert.match(buildVisionProbeInstruction({
    subjectId: "subj",
    obligationId: "CK-06.2",
    signal: new AbortController().signal,
  }), /probe\.ck06/);
});
