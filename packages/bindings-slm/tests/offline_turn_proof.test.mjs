/**
 * Full offline CognitiveCore turn with LlamaCppSlmRuntime (CERT-003).
 * Run: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_PROFILE_PATH,
  loadCertProfile,
  proveLlamaCppOfflineDesktopTurn,
  runCertifyProfile,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
import { loadNightlyCi } from "../../../scripts/ci-workflow-test-helpers.mjs";
const SECRET = "SECRET_OFFLINE_PROOF_BODY";

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

test("happy path: offline desktop turn green — servedLocally, fold, zero egress, restart", async () => {
  const events = [];
  const proof = await proveLlamaCppOfflineDesktopTurn({
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proof.ok, true, proof.failures.join("\n"));
  assert.equal(proof.servedLocally, true);
  assert.equal(proof.frictionFolded, true);
  assert.equal(proof.syncStatus, "offline-mode");
  assert.equal(proof.localityOk, true);
  assert.equal(proof.egressAttemptCount, 0);
  assert.equal(proof.turnCompletedEmitted, true);
  assert.equal(proof.restartSurvived, true);
  assert.equal(proof.subjectIsolationOk, true);
  assert.ok(proof.reply?.text);
  assert.equal(
    proof.llamaCppPinnedRevision,
    loadCertProfile(DESKTOP_PROFILE_PATH).modelArtifact.llamaCppPinnedRevision,
  );
  assert.equal(
    proof.measuredArtifactSha256,
    proof.modelArtifactSha256.toLowerCase(),
  );
  assert.ok(events.some((e) => e.outcome === "pass"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(proof).includes(SECRET));
});

test("edge: profile hash pin must match fixture (fail loudly)", async () => {
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  const broken = structuredClone(profile);
  broken.modelArtifact.artifactSha256 = "f".repeat(64);
  const proof = await proveLlamaCppOfflineDesktopTurn({ profile: broken });
  assert.equal(proof.ok, false);
  assert.ok(proof.failures.some((f) => /hash mismatch/i.test(f)));
});

test("sovereignty: concurrent subject ids stay isolated in telemetry", async () => {
  const a = [];
  const b = [];
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  await Promise.all([
    proveLlamaCppOfflineDesktopTurn({
      subjectId: "subj-ot-a",
      deviceId: "dev-ot-a",
      onTelemetry: (e) => a.push(e),
    }),
    proveLlamaCppOfflineDesktopTurn({
      subjectId: "subj-ot-b",
      deviceId: "dev-ot-b",
      onTelemetry: (e) => b.push(e),
    }),
  ]);
  assert.ok(a.every((e) => e.subjectId === "subj-ot-a" || e.subjectId.startsWith("subj-ot-a")));
  assert.ok(b.every((e) => e.subjectId === "subj-ot-b" || e.subjectId.startsWith("subj-ot-b")));
  assert.ok(!JSON.stringify(a).includes("subj-ot-b"));
  assert.ok(!JSON.stringify(b).includes("subj-ot-a"));
  void profile;
});

test("happy path: certify report includes offlineTurn pass", async () => {
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  const cap = captureIo();
  const { exitCode, report } = await runCertifyProfile(profile, cap.io);
  assert.equal(exitCode, 0, cap.err());
  assert.equal(report.offlineTurn.ok, true, report.offlineTurn.failures.join("\n"));
  assert.equal(report.offlineTurn.servedLocally, true);
  assert.equal(report.offlineTurn.egressAttemptCount, 0);
  assert.equal(report.offlineTurn.restartSurvived, true);
});

test("ci: llama-cpp-desktop-cert runs offline-edge:llamacpp prove step", () => {
  const yml = loadNightlyCi().replace(/\r\n/g, "\n");
  assert.match(yml, /offline-edge:llamacpp/);
  assert.match(yml, /offline-turn\.log/);
  assert.match(yml, /Prove offline-edge llama\.cpp turn/);
});
