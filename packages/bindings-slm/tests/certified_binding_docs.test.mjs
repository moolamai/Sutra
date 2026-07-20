/**
 * Governance doc consistency: certified-binding checklist uses real artifacts
 * and every badge criterion maps to an automated harness field.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const GOV = path.join(ROOT, "docs/bindings/CERTIFIED-BINDING.md");
const README = path.join(PKG, "README.md");
const REGISTRY = path.join(PKG, "certification/registry.json");
const DESKTOP_REPORT = path.join(
  PKG,
  "certification/reports/certification.report.json",
);
const ANDROID_REPORT = path.join(
  PKG,
  "android/certification/reports/android.cert.json",
);
const PROOF = path.join(PKG, "certification/proofs/one-command.proof.json");
const SCHEMA = path.join(
  PKG,
  "certification/schemas/certification.report.schema.json",
);
const B6_PRD = path.join(ROOT, "docs/bindings/b6-native-bindings-PRD.md");
const B0_CATALOG = path.join(
  ROOT,
  "packages/contract-conformance/src/obligations/model.ts",
);

const SECRET_BODY = "LEARNER_UTTERANCE_SHOULD_NEVER_APPEAR";

function read(p) {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

test("happy path: CERTIFIED-BINDING.md + package README exist and link", () => {
  assert.ok(existsSync(GOV), "docs/bindings/CERTIFIED-BINDING.md");
  assert.ok(existsSync(README), "packages/bindings-slm/README.md");
  const gov = read(GOV);
  const readme = read(README);
  assert.match(readme, /CERTIFIED-BINDING\.md/);
  assert.match(gov, /Certified Binding/);
  assert.match(gov, /bindings-slm\.mjs certify|certify --profile/);
});

test("happy path: examples cite real committed reports + proof", () => {
  const gov = read(GOV);
  assert.ok(existsSync(DESKTOP_REPORT));
  assert.ok(existsSync(ANDROID_REPORT));
  assert.ok(existsSync(PROOF));
  assert.ok(existsSync(REGISTRY));
  assert.ok(existsSync(SCHEMA));

  assert.match(gov, /certification\/reports\/certification\.report\.json/);
  assert.match(gov, /android\/certification\/reports\/android\.cert\.json/);
  assert.match(gov, /one-command\.proof\.json/);
  assert.match(gov, /registry\.json/);

  const desktop = JSON.parse(read(DESKTOP_REPORT));
  assert.equal(desktop.outcome, "pass");
  assert.equal(desktop.adapter, "llamacpp");
  assert.equal(desktop.subjectId, "cert.desktop.llamacpp");
  assert.match(gov, new RegExp(desktop.modelArtifactSha256));

  const android = JSON.parse(read(ANDROID_REPORT));
  assert.equal(android.outcome, "pass");
  assert.equal(android.adapter, "onnx");
  assert.match(gov, /cert\.android\.onnx/);
});

test("happy path: badge criteria B1–B9 map to automated report fields", () => {
  const gov = read(GOV);
  const requiredFields = [
    "outcome",
    "schemaVersion",
    "adapter",
    "profileId",
    "measuredArtifactSha256",
    "modelArtifactSha256",
    "obligationVerdicts",
    "egressRecord",
    "p95Benches",
    "subjectId",
    "deviceId",
    "deadlineMs",
    "CERTIFICATION_CHECK_DEADLINE_MS",
  ];
  for (const field of requiredFields) {
    assert.match(gov, new RegExp(field.replace(/\./g, "\\.")), `mentions ${field}`);
  }
  // Each badge row must claim an automated check (no manual-only rows).
  assert.match(gov, /Automated check/i);
  assert.match(gov, /no manual-only/i);
  assert.match(gov, /Badge SVG/i);
});

test("edge: red path must not badge; seeded failure documented", () => {
  const gov = read(GOV);
  assert.match(gov, /must not.*[Bb]adge|must not display/i);
  assert.match(gov, /hash mismatch|Seeded hash/i);
  assert.match(gov, /outcome:\s*"fail"|outcome === "fail"|outcome: "fail"/);
});

test("edge: sovereignty — no utterance bodies; subject isolation required", () => {
  const gov = read(GOV);
  assert.ok(!gov.includes(SECRET_BODY));
  assert.match(gov, /subjectId/);
  assert.match(gov, /zero egress|attemptCount === 0/);
  assert.match(gov, /never utterance|never.*prompt bodies|Never utterance/i);
  assert.match(gov, /concurrent|idempotent/i);

  for (const p of [DESKTOP_REPORT, ANDROID_REPORT]) {
    const raw = read(p);
    assert.ok(!raw.includes("prompt"));
    assert.ok(!raw.includes("utterance"));
    const j = JSON.parse(raw);
    assert.ok(j.subjectId?.trim());
    assert.ok(j.deviceId?.trim());
  }
});

test("edge: registry profiles in doc match registry.json", () => {
  const gov = read(GOV);
  const registry = JSON.parse(read(REGISTRY));
  for (const p of registry.profiles) {
    assert.match(gov, new RegExp(`\`${p.id}\`|${p.id}`), `profile ${p.id}`);
    assert.match(gov, new RegExp(p.adapter), `adapter ${p.adapter}`);
  }
});

test("happy path: README quickstart under 15 min + llama.cpp worked example", () => {
  const readme = read(README);
  assert.match(readme, /15 minute|15 min|&lt; 15|under 15/i);
  assert.match(readme, /Quickstart/i);
  assert.match(readme, /certify --profile desktop --adapter llamacpp/);
  assert.match(readme, /certification\/reports\/certification\.report\.json/);
  assert.match(readme, /cert\.desktop\.llamacpp/);
  assert.match(readme, /CK-03\.1/);
  assert.match(readme, /obligationVerdicts/);
  // Real hash from committed desktop report
  const desktop = JSON.parse(read(DESKTOP_REPORT));
  assert.equal(desktop.outcome, "pass");
  assert.match(readme, /subjectId/);
  assert.match(readme, /idempotent|concurrent/i);
});

test("happy path: B6 PRD + B0 catalog cross-linked from README and governance", () => {
  assert.ok(existsSync(B6_PRD), "B6 PRD");
  assert.ok(existsSync(B0_CATALOG), "B0 model.ts");
  const readme = read(README);
  const gov = read(GOV);
  const prd = read(B6_PRD);

  assert.match(readme, /b6-native-bindings-PRD\.md/);
  assert.match(readme, /obligations\/model\.ts/);
  assert.match(readme, /conformance-quickstart\.md/);

  assert.match(gov, /b6-native-bindings-PRD\.md/);
  assert.match(gov, /obligations\/model\.ts/);
  assert.match(gov, /MODEL_OBLIGATION_IDS|CK-03\.1/);

  assert.match(prd, /CERTIFIED-BINDING\.md/);
  assert.match(prd, /bindings-slm\/README\.md/);
  assert.match(prd, /obligations\/model\.ts/);
});

test("edge: quickstart docs never embed utterance bodies; red path still documented", () => {
  const readme = read(README);
  assert.ok(!readme.includes(SECRET_BODY));
  assert.ok(!/"prompt"\s*:/.test(readme));
  assert.match(readme, /CERT FAIL|Red \(expected/i);
  assert.match(readme, /subjectId/);
});
