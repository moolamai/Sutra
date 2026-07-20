/**
 * CK-06 fixture conformance: oversize + schema-valid + invalid JSON.
 * Each catalog fixture maps to B0 vision obligation ids CK-06.1 / CK-06.2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  MUST_REJECT_OVERSIZED,
  MUST_SCHEMA_VALID_JSON,
  VISION_OBLIGATION_IDS,
  createRejectOversizedObligationRegistry,
  createSchemaValidJsonObligationRegistry,
  createVisionObligationsRegistry,
  runConformance,
  validateAnswerAgainstSchema,
} from "@moolam/contract-conformance";
import {
  DEFAULT_CK06_FIXTURE_CATALOG,
  createLocalVlmVisionHarnessFactory,
  listCk06FixtureIds,
  loadAllCk06Fixtures,
  loadCk06Fixture,
  loadCk06FixtureCatalog,
  runAllCk06Fixtures,
  runCk06Fixture,
} from "../dist/index.js";

const SECRET = "LEARNER_PRESCRIPTION_PHOTO_MUST_NOT_LEAK";

test("unit: catalog lists oversize + valid schema + invalid JSON fixtures", () => {
  assert.ok(existsSync(DEFAULT_CK06_FIXTURE_CATALOG));
  const catalog = loadCk06FixtureCatalog();
  assert.equal(catalog.schemaVersion, "bindings-vision.ck06-fixtures.v1");
  const ids = listCk06FixtureIds();
  assert.ok(ids.includes("image-over-limit"));
  assert.ok(ids.includes("valid-schema-answer"));
  assert.ok(ids.includes("model-returned-invalid-json"));
  assert.equal(ids.length, catalog.fixtures.length);
});

test("unit: each fixture maps to CK-06.1 or CK-06.2", () => {
  const catalog = loadCk06FixtureCatalog();
  for (const f of catalog.fixtures) {
    assert.ok(
      f.obligationId === VISION_OBLIGATION_IDS.rejectOversized ||
        f.obligationId === VISION_OBLIGATION_IDS.schemaValidJson,
      `${f.id} obligationId=${f.obligationId}`,
    );
  }
  const over = catalog.fixtures.find((f) => f.id === "image-over-limit");
  assert.equal(over?.obligationId, "CK-06.1");
  const valid = catalog.fixtures.find((f) => f.id === "valid-schema-answer");
  assert.equal(valid?.obligationId, "CK-06.2");
  const invalid = catalog.fixtures.find(
    (f) => f.id === "model-returned-invalid-json",
  );
  assert.equal(invalid?.obligationId, "CK-06.2");
});

test("happy path: every committed fixture file loads with matching byteLength", () => {
  const all = loadAllCk06Fixtures();
  assert.equal(all.length, 3);
  for (const f of all) {
    assert.ok(existsSync(f.imagePath), f.imagePath);
    assert.equal(f.imageBytes.byteLength, f.byteLength);
    assert.ok(!f.instruction.includes(SECRET));
  }
});

test("happy path: image-over-limit → CK-06.1 typed reject before processing", async () => {
  const fixture = loadCk06Fixture("image-over-limit");
  assert.equal(fixture.obligationId, "CK-06.1");
  assert.ok(fixture.byteLength > fixture.maxInputBytes);
  const result = await runCk06Fixture(fixture, {
    subjectId: "subj.ck06.oversize",
    deviceId: "dev-ck06",
  });
  assert.equal(result.outcome, "pass", result.detail);
  assert.equal(result.obligationId, VISION_OBLIGATION_IDS.rejectOversized);
});

test("happy path: valid-schema-answer → CK-06.2 schema-valid JSON", async () => {
  const fixture = loadCk06Fixture("valid-schema-answer");
  assert.equal(fixture.obligationId, "CK-06.2");
  assert.ok(fixture.schema);
  assert.ok(fixture.answerText);
  const committed = validateAnswerAgainstSchema(
    fixture.answerText.trim(),
    fixture.schema,
  );
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const result = await runCk06Fixture(fixture, {
    subjectId: "subj.ck06.valid",
  });
  assert.equal(result.outcome, "pass", result.detail);
  assert.equal(result.obligationId, VISION_OBLIGATION_IDS.schemaValidJson);
});

test("edge: model-returned-invalid-json → CK-06.2 typed schema reject (never prose)", async () => {
  const fixture = loadCk06Fixture("model-returned-invalid-json");
  assert.equal(fixture.obligationId, "CK-06.2");
  assert.match(fixture.answerText ?? "", /not-json|prose/i);
  const result = await runCk06Fixture(fixture, {
    subjectId: "subj.ck06.invalid",
  });
  assert.equal(result.outcome, "pass", result.detail);
  assert.equal(result.obligationId, VISION_OBLIGATION_IDS.schemaValidJson);
});

test("happy path: runAllCk06Fixtures all green; no content bodies in ids", async () => {
  const results = await runAllCk06Fixtures({
    subjectId: "subj.ck06.batch",
    deviceId: "dev-ck06-batch",
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.outcome === "pass"), JSON.stringify(results));
  assert.ok(results.some((r) => r.obligationId === "CK-06.1"));
  assert.ok(results.filter((r) => r.obligationId === "CK-06.2").length >= 2);
  assert.ok(!JSON.stringify(results).includes(SECRET));
});

test("happy path: B0 vision conformance green with local VLM harness", async () => {
  const report = await runConformance({
    registry: createVisionObligationsRegistry(),
    factory: createLocalVlmVisionHarnessFactory({
      maxInputBytes: 64,
      deviceId: "dev-ck06-conf",
    }),
    subjectId: "subj.ck06.conf",
    deviceId: "dev-ck06-conf",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
  assert.equal(report.passed, 2);
  assert.ok(
    report.verdicts.every(
      (v) =>
        v.obligationId === "CK-06.1" || v.obligationId === "CK-06.2",
    ),
  );
  assert.equal(
    report.verdicts.find((v) => v.obligationId === "CK-06.1")?.mustText,
    MUST_REJECT_OVERSIZED,
  );
  assert.equal(
    report.verdicts.find((v) => v.obligationId === "CK-06.2")?.mustText,
    MUST_SCHEMA_VALID_JSON,
  );
});

test("edge: isolated CK-06.1 / CK-06.2 registries stay green on local VLM", async () => {
  const size = await runConformance({
    registry: createRejectOversizedObligationRegistry(),
    factory: createLocalVlmVisionHarnessFactory({ maxInputBytes: 64 }),
    subjectId: "subj.ck06.size.only",
  });
  assert.equal(size.exitCode, 0);
  assert.equal(size.verdicts[0]?.obligationId, "CK-06.1");

  const schema = await runConformance({
    registry: createSchemaValidJsonObligationRegistry(),
    factory: createLocalVlmVisionHarnessFactory({ maxInputBytes: 64 }),
    subjectId: "subj.ck06.schema.only",
  });
  assert.equal(schema.exitCode, 0);
  assert.equal(schema.verdicts[0]?.obligationId, "CK-06.2");
});

test("edge: idempotent replay of oversize fixture reject", async () => {
  const fixture = loadCk06Fixture("image-over-limit");
  const first = await runCk06Fixture(fixture, { subjectId: "subj.ck06.replay" });
  const second = await runCk06Fixture(fixture, { subjectId: "subj.ck06.replay" });
  assert.equal(first.outcome, "pass");
  assert.equal(second.outcome, "pass");
  assert.equal(first.obligationId, second.obligationId);
});

test("sovereignty: concurrent fixture runs keep subjectIds isolated", async () => {
  const [a, b] = await Promise.all([
    runAllCk06Fixtures({ subjectId: "subj.ck06.a", deviceId: "dev-a" }),
    runAllCk06Fixtures({ subjectId: "subj.ck06.b", deviceId: "dev-b" }),
  ]);
  assert.ok(a.every((r) => r.outcome === "pass"), JSON.stringify(a));
  assert.ok(b.every((r) => r.outcome === "pass"), JSON.stringify(b));
  assert.ok(!JSON.stringify(a).includes(SECRET));
});
