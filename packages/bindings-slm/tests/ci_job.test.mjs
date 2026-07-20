/**
 * CI wiring for llama-cpp-desktop-cert job (CERT-002).
 * Run: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS,
} from "@moolam/contract-conformance";
import {
  DESKTOP_PROFILE_PATH,
  loadCertProfile,
  runBindingsSlmCli,
  runCertifyProfile,
} from "../dist/index.js";

import {
  extractJobBlock,
  loadNightlyCi,
} from "../../../scripts/ci-workflow-test-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const PKG_JSON = path.join(PKG_ROOT, "package.json");
const SECRET = "SECRET_CI_CERT_MUST_NOT_LEAK";

function loadCi() {
  return loadNightlyCi();
}

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write(chunk) { out.push(String(chunk)); } },
      stderr: { write(chunk) { err.push(String(chunk)); } },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "bindings_slm.ci_job.test", ...event })}\n`,
  );
}

test("happy path: llama-cpp-desktop-cert job runs ci:certify + uploads report", () => {
  const yml = loadCi();
  assert.match(yml, /ci:certify/);
  const block = extractJobBlock(yml, "certifications");
  assert.doesNotMatch(block, /needs:\s*\[typescript\]/);
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.match(block, /pnpm build/);
  assert.match(block, /sutra-bindings-slm run ci:certify/);
  assert.match(block, /tee artifacts\/llama-cpp-desktop-cert\/certify\.log/);
  assert.match(block, /upload-artifact@v4/);
  assert.match(block, /llama-cpp-desktop-cert|Run desktop certify/i);
  assert.match(block, /if:\s*always\(\)/);
  assert.match(block, /pnpm\/action-setup@v4/);
  assert.match(block, /version:\s*10\.30\.3/);
  assert.match(block, /node-version:\s*22/);
  assert.match(block, /offline-edge:llamacpp/);
  assert.match(block, /Prove offline-edge llama\.cpp turn/);
  assert.doesNotMatch(block, /strategy:\s*\n\s*matrix:/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(typeof pkg.scripts["ci:certify"], "string");
  assert.match(pkg.scripts["ci:certify"], /--report-out/);
  assert.match(
    pkg.scripts["ci:certify"],
    /artifacts\/llama-cpp-desktop-cert\/desktop\.cert\.json/,
  );

  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  assert.equal(profile.reportArtifact?.schemaVersion, "bindings-slm.cert-report.v1");
  log({ outcome: "ok", case: "ci-job-wired", subjectId: profile.subjectId });
});

test("happy path: --report-out writes durable JSON with verdicts + egress + p95", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cert-report-"));
  const reportPath = path.join(dir, "desktop.cert.json");
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  const cap = captureIo();

  const { exitCode, report } = await runCertifyProfile(profile, cap.io, {
    reportOutPath: reportPath,
  });
  assert.equal(exitCode, 0, cap.err());
  assert.ok(existsSync(reportPath));

  const disk = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(disk.schemaVersion, "bindings-slm.cert-report.v1");
  assert.equal(disk.outcome, "pass");
  assert.equal(disk.modelArtifactSha256, profile.modelArtifact.artifactSha256);
  assert.equal(
    disk.llamaCppPinnedRevision,
    profile.modelArtifact.llamaCppPinnedRevision,
  );
  assert.equal(disk.measuredArtifactSha256, disk.modelArtifactSha256);
  assert.equal(disk.obligationVerdicts.length, 3);
  assert.deepEqual(
    disk.obligationVerdicts.map((v) => v.obligationId).sort(),
    [...DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS].sort(),
  );
  assert.equal(disk.egressRecord.ok, true);
  assert.equal(disk.egressRecord.attemptCount, 0);
  assert.ok(disk.egressRecord.zeroEgressOps.includes("generate"));
  assert.equal(typeof disk.p95Benches.first_token.measuredMs, "number");
  assert.equal(disk.p95Benches.first_token.ok, true);
  assert.equal(disk.p95Benches.core_loop.configured, true);
  assert.equal(disk.offlineTurn.ok, true, disk.offlineTurn.failures?.join("\n"));
  assert.equal(disk.offlineTurn.servedLocally, true);
  assert.equal(disk.offlineTurn.egressAttemptCount, 0);
  assert.equal(disk.offlineTurn.restartSurvived, true);
  assert.ok(profile.reportArtifact?.contains?.includes("offlineTurn"));
  assert.equal(disk.subjectId, profile.subjectId);
  assert.ok(!JSON.stringify(disk).includes(SECRET));
  assert.equal(report.schemaVersion, "bindings-slm.cert-report.v1");

  rmSync(dir, { recursive: true, force: true });
  log({ outcome: "ok", case: "report-artifact", subjectId: profile.subjectId });
});

test("edge: broken hash → red report artifact + CERT FAIL DIFF; revert → green", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cert-prove-"));
  const redPath = path.join(dir, "red.cert.json");
  const greenPath = path.join(dir, "green.cert.json");
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);

  const broken = structuredClone(profile);
  broken.modelArtifact.artifactSha256 = "0".repeat(64);

  const redCap = captureIo();
  const red = await runCertifyProfile(broken, redCap.io, {
    reportOutPath: redPath,
  });
  assert.equal(red.exitCode, 1);
  assert.equal(red.report.outcome, "fail");
  assert.match(redCap.err(), /artifact hash mismatch/i);
  assert.ok(existsSync(redPath));
  const redDisk = JSON.parse(readFileSync(redPath, "utf8"));
  assert.equal(redDisk.outcome, "fail");
  assert.ok(redDisk.failures.some((f) => /hash mismatch/i.test(f)));

  const greenCap = captureIo();
  const green = await runCertifyProfile(profile, greenCap.io, {
    reportOutPath: greenPath,
  });
  assert.equal(green.exitCode, 0, greenCap.err());
  assert.equal(green.report.outcome, "pass");
  const greenDisk = JSON.parse(readFileSync(greenPath, "utf8"));
  assert.equal(greenDisk.outcome, "pass");
  assert.equal(greenDisk.failures.length, 0);

  rmSync(dir, { recursive: true, force: true });
  log({ outcome: "ok", case: "prove-red-green", subjectId: profile.subjectId });
});

test("edge: CLI --report-out path; subject isolation in artifact", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cert-cli-out-"));
  const reportPath = path.join(dir, "out.cert.json");
  const cap = captureIo();
  const code = await runBindingsSlmCli(
    [
      "certify",
      "--profile",
      "desktop",
      "--adapter",
      "llamacpp",
      "--report-out",
      reportPath,
    ],
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const disk = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(disk.subjectId, "cert.desktop.llamacpp");
  assert.equal(disk.deviceId, "ci-desktop-cpu");
  assert.ok(!JSON.stringify(disk).includes(SECRET));
  rmSync(dir, { recursive: true, force: true });
});
