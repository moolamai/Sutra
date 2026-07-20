/**
 * Document-understanding schemas: CBSE worksheet + textbook page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  CBSE_WORKSHEET_SCHEMA_PATH,
  CBSE_WORKSHEET_SCHEMA_VERSION,
  DEFAULT_DOCUMENT_FIXTURE_CATALOG,
  TEXTBOOK_PAGE_SCHEMA_PATH,
  TEXTBOOK_PAGE_SCHEMA_VERSION,
  assertSingleDocumentImage,
  listDocumentExtractionProfiles,
  loadAllDocumentFixtures,
  loadDocumentFixture,
  loadDocumentFixtureCatalog,
  loadDocumentResponseSchema,
  proveDocumentSchemaFixture,
  validateDocumentExtractionAnswer,
  VisionInputTooLargeError,
  loadLocalVlm,
} from "../dist/index.js";

const SECRET = "LEARNER_WORKSHEET_PHOTO_MUST_NOT_LEAK";

test("unit: committed schemas exist with versioned ids", () => {
  assert.ok(existsSync(CBSE_WORKSHEET_SCHEMA_PATH));
  assert.ok(existsSync(TEXTBOOK_PAGE_SCHEMA_PATH));
  const profiles = listDocumentExtractionProfiles();
  assert.equal(profiles.length, 3);
  assert.ok(profiles.every((p) => p.singlePageOnly === true));
  assert.ok(profiles.every((p) => p.maxItems === 64));
  const ws = loadDocumentResponseSchema("cbse-worksheet", {
    subjectId: "subj.doc.schema",
  });
  assert.equal(ws.schemaVersion, CBSE_WORKSHEET_SCHEMA_VERSION);
  assert.equal(
    (ws.properties)?.documentKind?.const,
    "cbse-worksheet",
  );
  const page = loadDocumentResponseSchema("textbook-page");
  assert.equal(page.schemaVersion, TEXTBOOK_PAGE_SCHEMA_VERSION);
  assert.equal((page.properties)?.documentKind?.const, "textbook-page");
});

test("happy path: fixture catalog loads worksheet + textbook page probes", () => {
  assert.ok(existsSync(DEFAULT_DOCUMENT_FIXTURE_CATALOG));
  const catalog = loadDocumentFixtureCatalog();
  assert.equal(catalog.schemaVersion, "bindings-vision.document-fixtures.v1");
  const ids = catalog.fixtures.map((f) => f.id);
  assert.ok(ids.includes("cbse-worksheet-probe"));
  assert.ok(ids.includes("textbook-page-probe"));
  assert.ok(ids.includes("prescription-sketch-probe"));
  const all = loadAllDocumentFixtures();
  assert.equal(all.length, 3);
  for (const f of all) {
    assert.equal(f.imageBytes.byteLength, f.byteLength);
    assert.ok(!f.instruction.includes(SECRET));
  }
});

test("happy path: committed answers validate against schemas", () => {
  const events = [];
  for (const id of ["cbse-worksheet-probe", "textbook-page-probe"]) {
    const result = proveDocumentSchemaFixture(id, {
      subjectId: `subj.doc.${id}`,
      deviceId: "dev-doc",
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) {
      assert.ok(result.schemaVersion.startsWith("bindings-vision."));
      assert.equal(result.value.pageIndex, 0);
      assert.equal(typeof result.value.partial, "boolean");
      assert.equal(typeof result.value.confidence, "number");
    }
  }
  assert.ok(events.some((e) => e.outcome === "ok" && e.op === "validate"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: analyze with worksheet responseSchema stays schema-valid", async () => {
  const fixture = loadDocumentFixture("cbse-worksheet-probe");
  const schema = loadDocumentResponseSchema("cbse-worksheet");
  const vlm = await loadLocalVlm({
    subjectId: "subj.doc.analyze",
    deviceId: "dev-doc",
    maxInputBytes: fixture.maxInputBytes,
    backend: {
      kind: "in-process",
      load: async () => ({ id: "doc-backend" }),
      unload: async () => {},
      analyze: async () => ({
        answer: fixture.answerText.trim(),
        confidence: 0.82,
      }),
    },
  });
  const result = await vlm.analyze({
    input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
    instruction: fixture.instruction,
    responseSchema: schema,
  });
  const validated = validateDocumentExtractionAnswer(result.answer, schema, {
    profileId: "cbse-worksheet",
    subjectId: "subj.doc.analyze",
  });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  await vlm.unload();
});

test("edge: nullable unknown marks allowed; invented grade string rejected", () => {
  const schema = loadDocumentResponseSchema("cbse-worksheet");
  const withNull = {
    schemaVersion: CBSE_WORKSHEET_SCHEMA_VERSION,
    documentKind: "cbse-worksheet",
    board: null,
    classLevel: null,
    subject: null,
    title: null,
    pageIndex: 0,
    confidence: 0.4,
    items: [
      {
        index: 1,
        promptText: null,
        learnerResponse: null,
        marksAllocated: null,
        marksAwarded: null,
        confidence: 0.1,
      },
    ],
    partial: true,
    unresolvedFields: ["title", "items[0].promptText"],
  };
  assert.equal(
    validateDocumentExtractionAnswer(JSON.stringify(withNull), schema, {
      profileId: "cbse-worksheet",
    }).ok,
    true,
  );

  const invented = {
    ...withNull,
    items: [
      {
        index: 1,
        promptText: "x",
        learnerResponse: "y",
        marksAllocated: 1,
        marksAwarded: "A+",
        confidence: 0.9,
      },
    ],
  };
  const bad = validateDocumentExtractionAnswer(JSON.stringify(invented), schema, {
    profileId: "cbse-worksheet",
  });
  assert.equal(bad.ok, false);
  assert.match(String(bad.message), /type mismatch|marksAwarded/i);
});

test("edge: multi-image batch rejected; single page ok", () => {
  const batch = assertSingleDocumentImage(
    [{}, {}],
    { subjectId: "subj.doc.batch", deviceId: "dev-doc" },
  );
  assert.equal(batch.ok, false);
  assert.equal(batch.failureClass, "batch");

  const single = assertSingleDocumentImage([{}], {
    subjectId: "subj.doc.batch",
    deviceId: "dev-doc",
  });
  assert.equal(single.ok, true);

  const scalar = assertSingleDocumentImage({}, {
    subjectId: "subj.doc.batch",
    deviceId: "dev-doc",
  });
  assert.equal(scalar.ok, true);
});

test("edge: oversized document fixture image → typed size reject before processing", async () => {
  const fixture = loadDocumentFixture("cbse-worksheet-probe");
  const vlm = await loadLocalVlm({
    subjectId: "subj.doc.over",
    deviceId: "dev-doc",
    maxInputBytes: 8,
  });
  const before = vlm.processedCount();
  await assert.rejects(
    () =>
      vlm.analyze({
        input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
        instruction: fixture.instruction,
      }),
    (err) => err instanceof VisionInputTooLargeError,
  );
  assert.equal(vlm.processedCount(), before);
  await vlm.unload();
});

test("sovereignty: concurrent schema validates stay subject-scoped in telemetry", async () => {
  const eventsA = [];
  const eventsB = [];
  const [a, b] = await Promise.all([
    Promise.resolve(
      proveDocumentSchemaFixture("cbse-worksheet-probe", {
        subjectId: "subj.doc.a",
        deviceId: "dev-a",
        onTelemetry: (e) => eventsA.push(e),
      }),
    ),
    Promise.resolve(
      proveDocumentSchemaFixture("textbook-page-probe", {
        subjectId: "subj.doc.b",
        deviceId: "dev-b",
        onTelemetry: (e) => eventsB.push(e),
      }),
    ),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.ok(eventsA.every((e) => e.subjectId === "subj.doc.a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj.doc.b"));
  assert.ok(!JSON.stringify(eventsA).includes(SECRET));
  assert.ok(!JSON.stringify(eventsB).includes(SECRET));
});

