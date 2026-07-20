/**
 * Unified certify orchestrator: factory + profile → B0/B1/P4 → certification.report.json
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CERTIFICATION_CHECK_DEADLINE_MS } from "@moolam/contract-conformance";
import {
  CERTIFICATION_REPORT_FILENAME,
  CERTIFICATION_REPORT_SCHEMA_VERSION,
  CERTIFY_PHASE_ORDER,
  DESKTOP_PROFILE_PATH,
  createLlamaCppModelAdapterHarnessFactory,
  defaultCertificationReportPath,
  loadCertProfile,
  runUnifiedCertifyOrchestration,
  toUnifiedCertProfileInput,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
import { loadNightlyCi } from "../../../scripts/ci-workflow-test-helpers.mjs";
const SECRET = "SECRET_UNIFIED_CERT_BODY";

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write(c) { out.push(String(c)); } },
      stderr: { write(c) { err.push(String(c)); } },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

test("unit: phase order + deadline match B0 runner default", () => {
  assert.deepEqual([...CERTIFY_PHASE_ORDER], ["artifact", "b0", "b1", "p4"]);
  assert.equal(CERTIFICATION_CHECK_DEADLINE_MS, 5_000);
});

test("happy path: unified orchestrator green + writes certification.report.json", async () => {
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-unified-cert-"));
  const reportPath = path.join(dir, CERTIFICATION_REPORT_FILENAME);
  const fixture = path.join(PKG, profile.modelArtifact.fixtureRelpath);
  const cap = captureIo();

  const { exitCode, report } = await runUnifiedCertifyOrchestration({
    profile: toUnifiedCertProfileInput(profile),
    factory: createLlamaCppModelAdapterHarnessFactory({
      weightsPath: fixture,
      deviceId: profile.deviceId,
    }),
    io: cap.io,
    reportOutPath: reportPath,
    deadlineMs: CERTIFICATION_CHECK_DEADLINE_MS,
    packageRoot: PKG,
  });

  assert.equal(exitCode, 0, cap.err());
  assert.equal(report.schemaVersion, CERTIFICATION_REPORT_SCHEMA_VERSION);
  assert.equal(report.outcome, "pass");
  assert.deepEqual(report.phaseOrder, ["artifact", "b0", "b1", "p4"]);
  assert.equal(report.phases.length, 4);
  assert.ok(report.phases.every((p) => p.ok));
  assert.equal(report.obligationVerdicts.length, 3);
  assert.equal(report.egressRecord.ok, true);
  assert.equal(report.egressRecord.attemptCount, 0);
  assert.equal(report.p95Benches.first_token.ok, true);
  assert.equal(report.deadlineMs, CERTIFICATION_CHECK_DEADLINE_MS);
  assert.ok(existsSync(reportPath));
  const onDisk = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(onDisk.schemaVersion, CERTIFICATION_REPORT_SCHEMA_VERSION);
  assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.ok(cap.out().includes("phase_pass") || cap.out().includes('"phase"'));

  rmSync(dir, { recursive: true, force: true });
});

test("edge: missing artifact → fail fast before B0 (DIFF on stderr)", async () => {
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  const broken = structuredClone(toUnifiedCertProfileInput(profile));
  broken.modelArtifact.fixtureRelpath = "fixtures/__does_not_exist__.gguf";
  const cap = captureIo();

  const { exitCode, report } = await runUnifiedCertifyOrchestration({
    profile: broken,
    factory: createLlamaCppModelAdapterHarnessFactory({
      weightsPath: path.join(PKG, profile.modelArtifact.fixtureRelpath),
      deviceId: profile.deviceId,
    }),
    io: cap.io,
    writeReport: false,
    packageRoot: PKG,
  });

  assert.equal(exitCode, 1);
  assert.equal(report.outcome, "fail");
  assert.ok(report.failures.some((f) => /missing-artifact/i.test(f)));
  assert.match(cap.err(), /missing-artifact|CERT FAIL/);
  const artifactPhase = report.phases.find((p) => p.phase === "artifact");
  assert.equal(artifactPhase?.ok, false);
  // B0 skipped — only artifact phase recorded on early return
  assert.equal(report.phases.length, 1);
});

test("edge: broken hash → CERT FAIL DIFF; revert path green", async () => {
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  const unified = toUnifiedCertProfileInput(profile);
  const broken = structuredClone(unified);
  broken.modelArtifact.artifactSha256 = "0".repeat(64);
  const fixture = path.join(PKG, profile.modelArtifact.fixtureRelpath);
  const factory = createLlamaCppModelAdapterHarnessFactory({
    weightsPath: fixture,
    deviceId: profile.deviceId,
  });

  const red = captureIo();
  const fail = await runUnifiedCertifyOrchestration({
    profile: broken,
    factory,
    io: red.io,
    writeReport: false,
    packageRoot: PKG,
  });
  assert.equal(fail.exitCode, 1);
  assert.match(red.err(), /artifact hash mismatch/i);

  const green = captureIo();
  const pass = await runUnifiedCertifyOrchestration({
    profile: unified,
    factory,
    io: green.io,
    writeReport: false,
    packageRoot: PKG,
  });
  assert.equal(pass.exitCode, 0, green.err());
});

test("sovereignty: concurrent subjects stay isolated in report ids", async () => {
  const base = loadCertProfile(DESKTOP_PROFILE_PATH);
  const fixture = path.join(PKG, base.modelArtifact.fixtureRelpath);
  const a = structuredClone(toUnifiedCertProfileInput(base));
  const b = structuredClone(toUnifiedCertProfileInput(base));
  a.subjectId = "cert.unified.a";
  a.deviceId = "dev-a";
  b.subjectId = "cert.unified.b";
  b.deviceId = "dev-b";

  const [ra, rb] = await Promise.all([
    runUnifiedCertifyOrchestration({
      profile: a,
      factory: createLlamaCppModelAdapterHarnessFactory({
        weightsPath: fixture,
        deviceId: "dev-a",
      }),
      io: captureIo().io,
      writeReport: false,
      packageRoot: PKG,
    }),
    runUnifiedCertifyOrchestration({
      profile: b,
      factory: createLlamaCppModelAdapterHarnessFactory({
        weightsPath: fixture,
        deviceId: "dev-b",
      }),
      io: captureIo().io,
      writeReport: false,
      packageRoot: PKG,
    }),
  ]);

  assert.equal(ra.exitCode, 0, JSON.stringify(ra.report.failures));
  assert.equal(rb.exitCode, 0, JSON.stringify(rb.report.failures));
  assert.equal(ra.report.subjectId, "cert.unified.a");
  assert.equal(rb.report.subjectId, "cert.unified.b");
  assert.ok(!JSON.stringify(ra.report).includes("cert.unified.b"));
});

test("ci: binding-certify-harness job wired", () => {
  const yml = loadNightlyCi();
  assert.match(yml, /ci:certify:harness/);
  assert.match(yml, /artifacts\/binding-certify-harness/);
  assert.ok(
    defaultCertificationReportPath(PKG).endsWith(
      path.join("certification", "reports", CERTIFICATION_REPORT_FILENAME),
    ),
  );
});

test("edge: invalid deadlineMs rejected", async () => {
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  await assert.rejects(
    () =>
      runUnifiedCertifyOrchestration({
        profile: toUnifiedCertProfileInput(profile),
        factory: createLlamaCppModelAdapterHarnessFactory({
          weightsPath: path.join(PKG, profile.modelArtifact.fixtureRelpath),
          deviceId: profile.deviceId,
        }),
        deadlineMs: 0,
        writeReport: false,
        packageRoot: PKG,
      }),
    /deadlineMs/,
  );
});
