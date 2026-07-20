/**
 * Speech / vision / runtime reference mocks.
 *
 * Happy path: CK-05, CK-06, RT-01..04 conformance registries pass.
 * Edge: partial-before-final; language fallback; oversized typed reject;
 * schema JSON; idempotent initialize; subscriber isolation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeObligationsRegistry,
  createSpeechObligationsRegistry,
  createVisionObligationsRegistry,
  runConformance,
} from "@moolam/contract-conformance";
import {
  RUNTIME_SUBSCRIBER_ERROR_TYPE,
  VISION_REFERENCE_MAX_INPUT_BYTES,
  createRuntimeMockHarnessFactory,
  createSpeechMock,
  createSpeechMockHarnessFactory,
  createVisionMock,
  createVisionMockHarnessFactory,
} from "../dist/index.js";

test("happy path: speech mock passes full CK-05 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createSpeechObligationsRegistry(),
    factory: createSpeechMockHarnessFactory({
      deviceId: "dev-mock-speech",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-speech",
    deviceId: "dev-mock-speech",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
  assert.ok(
    events.some((e) => e.event === "contract_mocks.speech" && e.outcome === "ok"),
  );
});

test("happy path: vision mock passes full CK-06 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createVisionObligationsRegistry(),
    factory: createVisionMockHarnessFactory({
      deviceId: "dev-mock-vision",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-vision",
    deviceId: "dev-mock-vision",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
  assert.ok(
    events.some((e) => e.event === "contract_mocks.vision" && e.outcome === "ok"),
  );
});

test("happy path: runtime mock passes full RT-01..04 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createRuntimeObligationsRegistry(),
    factory: createRuntimeMockHarnessFactory({
      deviceId: "dev-mock-runtime",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-runtime",
    deviceId: "dev-mock-runtime",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 6);
  assert.ok(
    events.some((e) => e.event === "contract_mocks.runtime" && e.outcome === "ok"),
  );
});

test("edge: transcribe emits partial before final", async () => {
  const speech = createSpeechMock();
  async function* audio() {
    yield { data: new TextEncoder().encode("probe"), sampleRateHz: 16000 };
  }
  const segs = [];
  for await (const s of speech.transcribe(audio())) segs.push(s);
  assert.ok(segs.length >= 2);
  assert.equal(segs[0].isFinal, false);
  assert.equal(segs[segs.length - 1].isFinal, true);
});

test("edge: unsupported synthesize language falls back (never throws)", async () => {
  const speech = createSpeechMock({ supportedLanguages: ["en-US"] });
  const chunks = [];
  for await (const c of speech.synthesize("probe.hello", {
    language: "xx-PROBE-UNSUPPORTED",
  })) {
    chunks.push(c);
  }
  assert.equal(chunks.length, 1);
  const text = new TextDecoder().decode(chunks[0].data);
  assert.match(text, /en-US/);
});

test("edge: oversized vision rejects with typed error before processing", async () => {
  const vision = createVisionMock({
    maxInputBytes: VISION_REFERENCE_MAX_INPUT_BYTES,
  });
  assert.equal(vision.processedCount(), 0);
  await assert.rejects(
    () =>
      vision.analyze({
        input: {
          data: new Uint8Array(VISION_REFERENCE_MAX_INPUT_BYTES + 8),
          mimeType: "image/png",
        },
        instruction: "probe",
      }),
    (err) => {
      assert.equal(err.kind, "size_limit");
      assert.equal(err.code, "input_too_large");
      return true;
    },
  );
  assert.equal(vision.processedCount(), 0);
});

test("edge: schema response returns valid JSON object", async () => {
  const vision = createVisionMock();
  const out = await vision.analyze({
    input: { data: new Uint8Array(8), mimeType: "image/png" },
    instruction: "probe",
    responseSchema: {
      type: "object",
      properties: { label: { type: "string" }, score: { type: "number" } },
      required: ["label", "score"],
    },
  });
  const parsed = JSON.parse(out.answer);
  assert.equal(typeof parsed.label, "string");
  assert.equal(typeof parsed.score, "number");
});

test("edge: runtime initialize idempotent; subscriber throw isolated", async () => {
  const harness = createRuntimeMockHarnessFactory()();
  await harness.lifecycle.initialize();
  await harness.lifecycle.initialize();
  assert.equal(harness.initializeBodyCount(), 1);

  let isolated = 0;
  harness.bus.subscribe(RUNTIME_SUBSCRIBER_ERROR_TYPE, () => {
    isolated += 1;
  });
  harness.bus.subscribe("probe.event", () => {
    throw new Error("subscriber boom");
  });
  assert.doesNotThrow(() =>
    harness.bus.publish({
      type: "probe.event",
      at: "2026-07-15T00:00:00.000Z",
      payload: {},
    }),
  );
  assert.equal(isolated, 1);

  await harness.storage.execute("UPSERT", ["k1", "v1"]);
  assert.ok(harness.durableRows().some((r) => r.key === "k1"));
});
