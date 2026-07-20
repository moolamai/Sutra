/**
 * MLX Apple silicon certification (B0 + B1 + P4-relative + platform refuse).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLE_SILICON_CERTIFICATION_MODEL_OBLIGATION_IDS,
  APPLE_SILICON_PROFILE_PATH,
  loadMlxAppleSiliconCertProfile,
  runBindingsSlmCli,
  runMlxAppleSiliconCertifyProfile,
  MLX_PINNED_REVISION,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
import { loadNightlyCi } from "../../../scripts/ci-workflow-test-helpers.mjs";

const CI_YML = path.join(PKG, "../../../.github/workflows/ci-nightly.yml");
const COMMITTED_REPORT = path.join(
  PKG,
  "macos/certification/reports/apple-silicon.cert.json",
);
const SECRET = "SECRET_APPLE_CERT_BODY";

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

test("happy path: apple-silicon profile loads with pins + B0 set", () => {
  const profile = loadMlxAppleSiliconCertProfile(APPLE_SILICON_PROFILE_PATH);
  assert.equal(profile.profileId, "apple-silicon");
  assert.equal(profile.adapter, "mlx");
  assert.equal(profile.hardware.class, "apple-silicon");
  assert.equal(profile.modelArtifact.mlxPinnedRevision, MLX_PINNED_REVISION);
  assert.deepEqual(
    [...profile.obligations.b0Model].sort(),
    [...APPLE_SILICON_CERTIFICATION_MODEL_OBLIGATION_IDS].sort(),
  );
  assert.ok(profile.benches.subset.includes("core_loop"));
  assert.ok(profile.benches.subset.includes("first_token"));
});

test("happy path: certify apple-silicon → B0+B1+platform+deadline green", async () => {
  const profile = loadMlxAppleSiliconCertProfile(APPLE_SILICON_PROFILE_PATH);
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-mlx-cert-"));
  const reportPath = path.join(dir, "apple-silicon.cert.json");
  const cap = captureIo();

  const { exitCode, report } = await runMlxAppleSiliconCertifyProfile(
    profile,
    cap.io,
    { reportOutPath: reportPath, writeCommittedReport: true },
  );

  assert.equal(exitCode, 0, cap.err());
  assert.equal(report.outcome, "pass");
  assert.equal(report.obligationVerdicts.length, 3);
  assert.equal(report.egressRecord.ok, true);
  assert.equal(report.egressRecord.attemptCount, 0);
  assert.equal(report.p95Benches.first_token.ok, true);
  assert.equal(report.p95Benches.core_loop.configured, true);
  assert.equal(report.platformRefuse.ok, true);
  assert.equal(report.platformRefuse.intelRefused, true);
  assert.equal(report.deadlineAbort.ok, true);
  assert.equal(report.deadlineAbort.finishReason, "deadline");
  assert.ok(existsSync(reportPath));
  assert.ok(existsSync(COMMITTED_REPORT));
  const committed = JSON.parse(readFileSync(COMMITTED_REPORT, "utf8"));
  assert.equal(committed.outcome, "pass");
  assert.ok(!JSON.stringify(report).includes(SECRET));

  rmSync(dir, { recursive: true, force: true });
});

test("edge: broken artifact hash → CERT FAIL DIFF", async () => {
  const profile = loadMlxAppleSiliconCertProfile(APPLE_SILICON_PROFILE_PATH);
  const broken = structuredClone(profile);
  broken.modelArtifact.artifactSha256 = "0".repeat(64);
  const cap = captureIo();
  const { exitCode, report } = await runMlxAppleSiliconCertifyProfile(
    broken,
    cap.io,
    { writeCommittedReport: false },
  );
  assert.equal(exitCode, 1);
  assert.equal(report.outcome, "fail");
  assert.match(cap.err(), /artifact hash mismatch/i);
});

test("edge: CLI adapter mismatch for apple-silicon profile", async () => {
  const cap = captureIo();
  const code = await runBindingsSlmCli(
    ["certify", "--profile", "apple-silicon", "--adapter", "onnx"],
    cap.io,
  );
  assert.equal(code, 1);
  assert.match(cap.err(), /does not match profile\.adapter mlx/);
});

test("sovereignty: concurrent certify subjects stay isolated in report ids", async () => {
  const base = loadMlxAppleSiliconCertProfile(APPLE_SILICON_PROFILE_PATH);
  const a = structuredClone(base);
  const b = structuredClone(base);
  a.subjectId = "cert.apple.a";
  a.deviceId = "dev-a";
  b.subjectId = "cert.apple.b";
  b.deviceId = "dev-b";
  const [ra, rb] = await Promise.all([
    runMlxAppleSiliconCertifyProfile(a, captureIo().io, {
      writeCommittedReport: false,
    }),
    runMlxAppleSiliconCertifyProfile(b, captureIo().io, {
      writeCommittedReport: false,
    }),
  ]);
  assert.equal(ra.exitCode, 0, JSON.stringify(ra.report.failures));
  assert.equal(rb.exitCode, 0, JSON.stringify(rb.report.failures));
  assert.equal(ra.report.subjectId, "cert.apple.a");
  assert.equal(rb.report.subjectId, "cert.apple.b");
  assert.ok(!JSON.stringify(ra.report).includes("cert.apple.b"));
});

test("ci: mlx-apple-silicon-cert job wired", () => {
  const yml = loadNightlyCi();
  assert.match(yml, /ci:certify:apple-silicon/);
  assert.match(yml, /artifacts\/mlx-apple-silicon-cert/);
});
