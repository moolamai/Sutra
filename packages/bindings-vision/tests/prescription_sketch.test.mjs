/**
 * Prescription-sketch structured extraction path (doctor-domain schema).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  PRESCRIPTION_SKETCH_SCHEMA_PATH,
  PRESCRIPTION_SKETCH_SCHEMA_VERSION,
  assertSingleDocumentImage,
  extractPrescriptionSketch,
  listDocumentExtractionProfiles,
  loadDocumentFixture,
  loadDocumentResponseSchema,
  proveDocumentSchemaFixture,
  provePrescriptionSketchExtraction,
  validateDocumentExtractionAnswer,
  VisionInputTooLargeError,
  loadLocalVlm,
} from "../dist/index.js";

const SECRET = "PATIENT_PRESCRIPTION_PHOTO_MUST_NOT_LEAK";

test("unit: prescription-sketch schema committed and registered", () => {
  assert.ok(existsSync(PRESCRIPTION_SKETCH_SCHEMA_PATH));
  const profiles = listDocumentExtractionProfiles();
  assert.ok(profiles.some((p) => p.profileId === "prescription-sketch"));
  assert.equal(profiles.length, 3);
  const schema = loadDocumentResponseSchema("prescription-sketch", {
    subjectId: "subj.rx.schema",
  });
  assert.equal(schema.schemaVersion, PRESCRIPTION_SKETCH_SCHEMA_VERSION);
  assert.equal(
    (schema.properties)?.documentKind?.const,
    "prescription-sketch",
  );
  const lineProps = (schema.properties)?.lines?.items?.properties;
  assert.ok(lineProps?.drug);
  assert.ok(lineProps?.dose);
  assert.ok(lineProps?.frequency);
});

test("happy path: prescription fixture validates; extract path green", async () => {
  const events = [];
  const proved = proveDocumentSchemaFixture("prescription-sketch-probe", {
    subjectId: "subj.rx.fixture",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proved.ok, true, JSON.stringify(proved));

  const extract = await provePrescriptionSketchExtraction({
    subjectId: "subj.rx.extract",
    deviceId: "dev-rx",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(extract.ok, true, JSON.stringify(extract));
  if (extract.ok) {
    assert.equal(extract.value.documentKind, "prescription-sketch");
    assert.equal(extract.value.pageIndex, 0);
    assert.equal(extract.value.partial, true);
    assert.ok(Array.isArray(extract.value.lines));
    assert.ok(extract.analysis.answer.length > 0);
  }
  assert.ok(events.some((e) => e.op === "extract" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: nullable drug/dose/frequency allowed; invented diagnosis field rejected", () => {
  const schema = loadDocumentResponseSchema("prescription-sketch");
  const withNulls = {
    schemaVersion: PRESCRIPTION_SKETCH_SCHEMA_VERSION,
    documentKind: "prescription-sketch",
    prescriberName: null,
    datedOn: null,
    pageIndex: 0,
    confidence: 0.3,
    lines: [
      {
        index: 1,
        drug: null,
        dose: null,
        frequency: null,
        duration: null,
        confidence: 0.1,
      },
    ],
    partial: true,
    unresolvedFields: ["lines[0].drug", "lines[0].dose", "lines[0].frequency"],
  };
  assert.equal(
    validateDocumentExtractionAnswer(JSON.stringify(withNulls), schema, {
      profileId: "prescription-sketch",
    }).ok,
    true,
  );

  const withDiagnosis = {
    ...withNulls,
    diagnosis: "invented-diagnosis",
  };
  const bad = validateDocumentExtractionAnswer(
    JSON.stringify(withDiagnosis),
    schema,
    { profileId: "prescription-sketch" },
  );
  assert.equal(bad.ok, false);
  assert.match(String(bad.message), /unexpected property|diagnosis/i);
});

test("edge: multi-image batch rejected on extract path", async () => {
  const fixture = loadDocumentFixture("prescription-sketch-probe");
  const vlm = await loadLocalVlm({
    subjectId: "subj.rx.batch",
    deviceId: "dev-rx",
    maxInputBytes: 64,
    backend: {
      kind: "in-process",
      load: async () => ({ id: "rx-batch" }),
      unload: async () => {},
      analyze: async () => ({
        answer: fixture.answerText.trim(),
        confidence: 0.5,
      }),
    },
  });
  const result = await extractPrescriptionSketch({
    vision: vlm,
    input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
    subjectId: "subj.rx.batch",
    deviceId: "dev-rx",
    imageBatch: [fixture.imageBytes, fixture.imageBytes],
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "batch");
  await vlm.unload();

  const gate = assertSingleDocumentImage([1, 2], {
    subjectId: "subj.rx.batch",
    deviceId: "dev-rx",
  });
  assert.equal(gate.ok, false);
});

test("edge: oversized prescription image → typed size reject before extract completes", async () => {
  const fixture = loadDocumentFixture("prescription-sketch-probe");
  const vlm = await loadLocalVlm({
    subjectId: "subj.rx.over",
    deviceId: "dev-rx",
    maxInputBytes: 8,
  });
  const before = vlm.processedCount();
  const result = await extractPrescriptionSketch({
    vision: vlm,
    input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
    subjectId: "subj.rx.over",
    deviceId: "dev-rx",
  });
  assert.equal(result.ok, false);
  assert.equal(vlm.processedCount(), before);
  assert.match(String(result.message), /maxInputBytes|too large|size/i);
  await assert.rejects(
    () =>
      vlm.analyze({
        input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
        instruction: "x",
      }),
    (err) => err instanceof VisionInputTooLargeError,
  );
  await vlm.unload();
});

test("edge: invalid model JSON under prescription schema → typed extract failure", async () => {
  const fixture = loadDocumentFixture("prescription-sketch-probe");
  const vlm = await loadLocalVlm({
    subjectId: "subj.rx.bad",
    deviceId: "dev-rx",
    maxInputBytes: 64,
    backend: {
      kind: "in-process",
      load: async () => ({ id: "rx-bad" }),
      unload: async () => {},
      analyze: async () => ({
        answer: "not-json free text prose",
        confidence: 0.1,
      }),
    },
  });
  const result = await extractPrescriptionSketch({
    vision: vlm,
    input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
    subjectId: "subj.rx.bad",
    deviceId: "dev-rx",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "schema");
  await vlm.unload();
});

test("sovereignty: concurrent prescription extracts keep subjectIds isolated", async () => {
  const eventsA = [];
  const eventsB = [];
  const [a, b] = await Promise.all([
    provePrescriptionSketchExtraction({
      subjectId: "subj.rx.a",
      deviceId: "dev-a",
      onTelemetry: (e) => eventsA.push(e),
    }),
    provePrescriptionSketchExtraction({
      subjectId: "subj.rx.b",
      deviceId: "dev-b",
      onTelemetry: (e) => eventsB.push(e),
    }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.ok(eventsA.every((e) => e.subjectId === "subj.rx.a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj.rx.b"));
  assert.ok(!JSON.stringify(eventsA).includes(SECRET));
  assert.ok(!JSON.stringify(eventsB).includes(SECRET));
});

