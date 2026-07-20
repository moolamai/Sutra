/**
 * ONNX mobile Android certification (B0 + B1 + memory ceiling + report).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANDROID_CERTIFICATION_MODEL_OBLIGATION_IDS,
  ANDROID_PROFILE_PATH,
  loadOnnxAndroidCertProfile,
  runBindingsSlmCli,
  runOnnxAndroidCertifyProfile,
  ONNX_RUNTIME_MOBILE_PINNED_VERSION,
  ONNX_MOBILE_SUPPORTED_QUANT_FORMATS,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
import { loadNightlyCi } from "../../../scripts/ci-workflow-test-helpers.mjs";

const CI_YML = path.join(PKG, "../../../.github/workflows/ci-nightly.yml");
const COMMITTED_REPORT = path.join(
  PKG,
  "android/certification/reports/android.cert.json",
);
const QUANT_DOC = path.join(PKG, "android/SUPPORTED_QUANT_FORMATS.json");
const SECRET = "SECRET_ANDROID_CERT_BODY";

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

test("happy path: android profile loads with pins + supported quants", () => {
  const profile = loadOnnxAndroidCertProfile(ANDROID_PROFILE_PATH);
  assert.equal(profile.profileId, "android");
  assert.equal(profile.adapter, "onnx");
  assert.equal(profile.hardware.class, "mid-range-android");
  assert.equal(
    profile.modelArtifact.onnxRuntimePinnedVersion,
    ONNX_RUNTIME_MOBILE_PINNED_VERSION,
  );
  assert.deepEqual(
    [...profile.obligations.b0Model].sort(),
    [...ANDROID_CERTIFICATION_MODEL_OBLIGATION_IDS].sort(),
  );
  assert.ok(existsSync(QUANT_DOC));
  const quants = JSON.parse(readFileSync(QUANT_DOC, "utf8"));
  assert.ok(quants.supportedQuantFormats.some((q) => q.id === "int8"));
  assert.ok(quants.supportedQuantFormats.some((q) => q.id === "int4"));
  assert.ok(ONNX_MOBILE_SUPPORTED_QUANT_FORMATS.includes("int8"));
});

test("happy path: certify android → B0+B1 green, memory ceiling, committed report", async () => {
  const profile = loadOnnxAndroidCertProfile(ANDROID_PROFILE_PATH);
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-onnx-cert-"));
  const reportPath = path.join(dir, "android.cert.json");
  const cap = captureIo();

  const { exitCode, report } = await runOnnxAndroidCertifyProfile(
    profile,
    cap.io,
    { reportOutPath: reportPath, writeCommittedReport: true },
  );

  assert.equal(exitCode, 0, cap.err());
  assert.equal(report.outcome, "pass");
  assert.equal(report.obligationVerdicts.length, 3);
  assert.equal(report.egressRecord.ok, true);
  assert.equal(report.egressRecord.attemptCount, 0);
  assert.equal(report.memoryCeiling.ok, true);
  assert.equal(report.memoryCeiling.overBudgetRefused, true);
  assert.equal(report.memoryCeiling.materializeCountOnReject, 0);
  assert.equal(report.p95Benches.first_token.ok, true);
  assert.ok(report.supportedQuantFormats.includes("int8"));
  assert.ok(existsSync(reportPath));
  assert.ok(existsSync(COMMITTED_REPORT));
  const committed = JSON.parse(readFileSync(COMMITTED_REPORT, "utf8"));
  assert.equal(committed.outcome, "pass");
  assert.ok(!JSON.stringify(report).includes(SECRET));

  rmSync(dir, { recursive: true, force: true });
});

test("edge: broken artifact hash → CERT FAIL DIFF", async () => {
  const profile = loadOnnxAndroidCertProfile(ANDROID_PROFILE_PATH);
  const broken = structuredClone(profile);
  broken.modelArtifact.artifactSha256 = "0".repeat(64);
  const cap = captureIo();
  const { exitCode, report } = await runOnnxAndroidCertifyProfile(broken, cap.io, {
    writeCommittedReport: false,
  });
  assert.equal(exitCode, 1);
  assert.equal(report.outcome, "fail");
  assert.match(cap.err(), /artifact hash mismatch/i);
  assert.ok(report.failures.some((f) => /hash mismatch/i.test(f)));
});

test("edge: CLI adapter mismatch for android profile", async () => {
  const cap = captureIo();
  const code = await runBindingsSlmCli(
    ["certify", "--profile", "android", "--adapter", "llamacpp"],
    cap.io,
  );
  assert.equal(code, 1);
  assert.match(cap.err(), /does not match profile\.adapter onnx/);
});

test("sovereignty: concurrent certify subjects stay isolated in report ids", async () => {
  const base = loadOnnxAndroidCertProfile(ANDROID_PROFILE_PATH);
  const a = structuredClone(base);
  const b = structuredClone(base);
  a.subjectId = "cert.android.a";
  a.deviceId = "dev-a";
  b.subjectId = "cert.android.b";
  b.deviceId = "dev-b";
  const [ra, rb] = await Promise.all([
    runOnnxAndroidCertifyProfile(a, captureIo().io, {
      writeCommittedReport: false,
    }),
    runOnnxAndroidCertifyProfile(b, captureIo().io, {
      writeCommittedReport: false,
    }),
  ]);
  assert.equal(ra.exitCode, 0, JSON.stringify(ra.report.failures));
  assert.equal(rb.exitCode, 0, JSON.stringify(rb.report.failures));
  assert.equal(ra.report.subjectId, "cert.android.a");
  assert.equal(rb.report.subjectId, "cert.android.b");
  assert.ok(!JSON.stringify(ra.report).includes("cert.android.b"));
  assert.ok(!JSON.stringify(rb.report).includes("cert.android.a"));
});

test("ci: onnx-mobile-android-cert job wired", () => {
  const yml = loadNightlyCi();
  assert.match(yml, /ci:certify:android/);
  assert.match(yml, /artifacts\/onnx-mobile-android-cert/);
});
