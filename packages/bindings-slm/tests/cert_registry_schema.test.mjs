/**
 * Certification report schema + profile registry (desktop / android-mid / apple-silicon).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CERTIFICATION_REPORT_SCHEMA_VERSION,
  CERT_PROFILE_REGISTRY_SCHEMA_VERSION,
  CERT_REGISTRY_PROFILE_IDS,
  CertifyValidationError,
  assertCertificationReportValid,
  certProfileRegistryPath,
  certificationReportSchemaPath,
  loadCertProfileRegistry,
  lookupCertProfileRegistryEntry,
  resolveProfilePath,
  validateCertificationReport,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
import { loadNightlyCi } from "../../../scripts/ci-workflow-test-helpers.mjs";
const SAMPLE_REPORT = path.join(
  PKG,
  "certification/reports/certification.report.json",
);

test("happy path: registry loads desktop + android-mid + apple-silicon", () => {
  const reg = loadCertProfileRegistry({
    certificationDir: path.join(PKG, "certification"),
  });
  assert.equal(reg.schemaVersion, CERT_PROFILE_REGISTRY_SCHEMA_VERSION);
  assert.equal(reg.reportSchemaVersion, CERTIFICATION_REPORT_SCHEMA_VERSION);
  assert.deepEqual(
    reg.profiles.map((p) => p.id).sort(),
    [...CERT_REGISTRY_PROFILE_IDS].sort(),
  );

  const desktop = lookupCertProfileRegistryEntry("desktop", { registry: reg });
  assert.equal(desktop.adapter, "llamacpp");
  const androidMid = lookupCertProfileRegistryEntry("android-mid", {
    registry: reg,
  });
  assert.equal(androidMid.adapter, "onnx");
  assert.ok(androidMid.aliases.includes("android"));
  const apple = lookupCertProfileRegistryEntry("apple-silicon", {
    registry: reg,
  });
  assert.equal(apple.adapter, "mlx");

  assert.ok(existsSync(certProfileRegistryPath(path.join(PKG, "certification"))));
  assert.ok(
    existsSync(certificationReportSchemaPath(path.join(PKG, "certification"))),
  );
});

test("happy path: resolveProfilePath via registry (android alias → android.profile.json)", () => {
  const dir = path.join(PKG, "certification");
  const androidPath = resolveProfilePath("android-mid", {
    certificationDir: dir,
  });
  assert.ok(androidPath.endsWith("android.profile.json"));
  const aliasPath = resolveProfilePath("android", { certificationDir: dir });
  assert.equal(aliasPath, androidPath);
  const desktopPath = resolveProfilePath("desktop", { certificationDir: dir });
  assert.ok(desktopPath.endsWith("desktop.profile.json"));
});

test("happy path: committed certification.report.json validates against schema", () => {
  assert.ok(existsSync(SAMPLE_REPORT), "run certify once to seed report");
  const report = JSON.parse(readFileSync(SAMPLE_REPORT, "utf8"));
  const diffs = validateCertificationReport(report, {
    schemaPath: certificationReportSchemaPath(path.join(PKG, "certification")),
  });
  assert.deepEqual(diffs, []);
  assert.doesNotThrow(() =>
    assertCertificationReportValid(report, {
      schemaPath: certificationReportSchemaPath(path.join(PKG, "certification")),
    }),
  );
  assert.equal(report.adapter, "llamacpp");
  assert.ok(report.modelArtifactSha256);
  assert.ok(Array.isArray(report.obligationVerdicts));
  assert.equal(typeof report.egressRecord.ok, "boolean");
  assert.ok(report.p95Benches.first_token);
  assert.ok(report.p95Benches.core_loop);
  assert.ok(!("prompt" in report));
});

test("edge: broken report missing adapter → schema DIFF", () => {
  const report = JSON.parse(readFileSync(SAMPLE_REPORT, "utf8"));
  delete report.adapter;
  const diffs = validateCertificationReport(report, {
    schemaPath: certificationReportSchemaPath(path.join(PKG, "certification")),
  });
  assert.ok(diffs.some((d) => /adapter/i.test(d)));
  assert.throws(
    () => assertCertificationReportValid(report),
    (err) => {
      assert.ok(err instanceof CertifyValidationError);
      assert.match(err.message, /schema breach/);
      return true;
    },
  );
});

test("edge: unknown registry profile → typed DIFF", () => {
  assert.throws(
    () =>
      lookupCertProfileRegistryEntry("no-such-profile", {
        certificationDir: path.join(PKG, "certification"),
      }),
    (err) => {
      assert.ok(err instanceof CertifyValidationError);
      assert.match(err.message, /unknown certification profile/);
      return true;
    },
  );
});

test("edge: sovereignty — content-body field rejected", () => {
  const report = JSON.parse(readFileSync(SAMPLE_REPORT, "utf8"));
  report.prompt = "SECRET_SHOULD_NOT_BE_IN_REPORT";
  const diffs = validateCertificationReport(report);
  assert.ok(diffs.some((d) => /sovereignty/i.test(d) && /prompt/i.test(d)));
});

test("ci: binding-certify-harness validates registry + schema", () => {
  const yml = loadNightlyCi();
  assert.match(yml, /ci:certify:harness/);
  assert.match(yml, /certification\/registry\.json/);
  assert.match(yml, /certification\.report\.schema\.json/);
});
