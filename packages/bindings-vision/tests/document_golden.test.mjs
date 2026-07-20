/**
 * Teacher/doctor document golden fixtures + rubric + CI wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DOCUMENT_GOLDEN_CATALOG,
  assertNoPiiInText,
  loadAllDocumentGoldenFixtures,
  loadDocumentGoldenCatalog,
  loadDocumentGoldenFixture,
  loadDocumentGoldenRubric,
  proveDocumentGoldenGate,
  runDocumentGoldenSuite,
  scoreDocumentGoldenAnswer,
} from "../dist/index.js";

import {
  extractJobBlock,
  loadNightlyCi,
} from "../../../scripts/ci-workflow-test-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const PKG_JSON = path.join(PKG_ROOT, "package.json");
const SECRET = "PATIENT_PRESCRIPTION_PHOTO_MUST_NOT_LEAK";

function loadCi() {
  return loadNightlyCi();
}

test("unit: golden catalog lists teacher + doctor fixtures; no PII", () => {
  assert.ok(existsSync(DEFAULT_DOCUMENT_GOLDEN_CATALOG));
  const catalog = loadDocumentGoldenCatalog();
  assert.equal(catalog.schemaVersion, "bindings-vision.document-golden.v1");
  const domains = new Set(catalog.fixtures.map((f) => f.domain));
  assert.ok(domains.has("teacher"));
  assert.ok(domains.has("doctor"));
  assert.ok(catalog.fixtures.some((f) => f.id === "teacher-cbse-worksheet"));
  assert.ok(catalog.fixtures.some((f) => f.id === "teacher-textbook-page"));
  assert.ok(catalog.fixtures.some((f) => f.id === "doctor-prescription-sketch"));

  const all = loadAllDocumentGoldenFixtures();
  assert.equal(all.length, 3);
  for (const f of all) {
    assert.equal(f.imageBytes.byteLength, f.byteLength);
    const pii = assertNoPiiInText(`${f.id}\n${f.expectedText}\n${f.instruction}`);
    assert.equal(pii.ok, true, pii.detail);
    assert.ok(!f.expectedText.includes(SECRET));
  }
});

test("happy path: rubric scores exact golden answers above minScore", () => {
  const rubric = loadDocumentGoldenRubric();
  assert.equal(rubric.minScore, 0.85);
  for (const id of [
    "teacher-cbse-worksheet",
    "teacher-textbook-page",
    "doctor-prescription-sketch",
  ]) {
    const fixture = loadDocumentGoldenFixture(id);
    const scored = scoreDocumentGoldenAnswer(fixture.expectedText, fixture, rubric);
    assert.equal(scored.ok, true, JSON.stringify(scored));
    assert.ok(scored.score >= rubric.minScore);
    assert.equal(
      scored.dimensions.find((d) => d.id === "noPii")?.score,
      1,
    );
  }
});

test("happy path: document golden suite green (CK-06 + rubric)", async () => {
  const events = [];
  const report = await runDocumentGoldenSuite({
    subjectId: "subj.golden.suite",
    deviceId: "dev-golden",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.visionConformanceOk, true);
  assert.equal(report.fixtureScores.length, 3);
  assert.ok(report.fixtureScores.every((s) => s.ok));
  assert.ok(report.fixtureScores.some((s) => s.domain === "teacher"));
  assert.ok(report.fixtureScores.some((s) => s.domain === "doctor"));
  assert.ok(events.some((e) => e.outcome === "pass"));
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test("edge: invented non-null over expected null fails nullableHonesty", () => {
  const fixture = loadDocumentGoldenFixture("doctor-prescription-sketch");
  const rubric = loadDocumentGoldenRubric();
  const invented = {
    ...fixture.expected,
    lines: [
      {
        index: 1,
        drug: "probe.drug.beta",
        dose: "250 mg",
        frequency: "TID",
        duration: "invented-7-days",
        confidence: 0.65,
      },
      {
        index: 2,
        drug: "invented-drug",
        dose: "1 mg",
        frequency: "QD",
        duration: null,
        confidence: 0.9,
      },
    ],
  };
  const scored = scoreDocumentGoldenAnswer(
    JSON.stringify(invented),
    fixture,
    rubric,
  );
  assert.equal(scored.ok, false);
  assert.ok(
    scored.failures.some((f) => /nullableHonesty|fieldMatch/i.test(f)),
  );
});

test("edge: PII patterns rejected in golden text", () => {
  assert.equal(assertNoPiiInText("probe.drug.alpha").ok, true);
  assert.equal(assertNoPiiInText("patient@example.com").ok, false);
  assert.equal(assertNoPiiInText("SECRET_MUST_NOT_LEAK").ok, false);
  assert.equal(assertNoPiiInText("+91 9876543210").ok, false);
});

test("edge: multi-domain suite rejects oversized via vision binding path", async () => {
  const fixture = loadDocumentGoldenFixture("teacher-cbse-worksheet");
  assert.ok(fixture.byteLength > 8);
  // Suite itself uses fixture maxInputBytes; this asserts fixture still size-gated
  // when a host lowers the ceiling (same invariant as document path).
  const { loadLocalVlm, VisionInputTooLargeError } = await import(
    "../dist/index.js"
  );
  const vlm = await loadLocalVlm({
    subjectId: "subj.golden.over",
    deviceId: "dev-golden",
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

test("happy path: prove gate baseline→seeded red→restore green", async () => {
  const proof = await proveDocumentGoldenGate({
    subjectId: "subj.golden.prove",
  });
  assert.equal(proof.ok, true, JSON.stringify(proof.failures));
  assert.equal(proof.baselineOk, true);
  assert.equal(proof.seededRed, true);
  assert.equal(proof.restoredOk, true);
});

test("sovereignty: concurrent golden suite runs stay subject-scoped", async () => {
  const eventsA = [];
  const eventsB = [];
  const [a, b] = await Promise.all([
    runDocumentGoldenSuite({
      subjectId: "subj.golden.a",
      deviceId: "dev-a",
      onTelemetry: (e) => eventsA.push(e),
    }),
    runDocumentGoldenSuite({
      subjectId: "subj.golden.b",
      deviceId: "dev-b",
      onTelemetry: (e) => eventsB.push(e),
    }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.ok(eventsA.every((e) => e.subjectId === "subj.golden.a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj.golden.b"));
});

test("ci: vision-document-golden job wires certify + prove", () => {
  const yml = loadCi();
  const block = extractJobBlock(yml, "certifications");
  assert.doesNotMatch(block, /needs:\s*\[typescript\]/);
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.match(block, /pnpm build/);
  assert.match(block, /sutra-bindings-vision run ci:certify:document-golden/);
  assert.match(block, /ci:prove:document-golden/);
  assert.match(block, /upload-artifact@v4/);
  assert.match(block, /if:\s*always\(\)/);
  assert.match(block, /pnpm\/action-setup@v4/);
  assert.match(block, /version:\s*10\.30\.3/);
  assert.match(block, /node-version:\s*22/);
  assert.match(block, /teacher|doctor|document golden/i);
  assert.doesNotMatch(block, /strategy:\s*\n\s*matrix:/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(typeof pkg.scripts["ci:certify:document-golden"], "string");
  assert.match(
    pkg.scripts["ci:certify:document-golden"],
    /artifacts\/vision-document-golden\/document\.golden\.json/,
  );
  assert.equal(typeof pkg.scripts["ci:prove:document-golden"], "string");
});

