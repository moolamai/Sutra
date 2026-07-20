/**
 * CI wiring + red→green prove for Indic speech conformance certification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFinalOnlySpeechHarnessFactory,
  createNoFallbackSpeechHarnessFactory,
} from "@moolam/contract-conformance";
import {
  DEFAULT_SPEECH_CERT_PROFILE,
  SPEECH_CERT_OBLIGATION_IDS,
  SPEECH_CERT_REPORT_SCHEMA_VERSION,
  loadSpeechCertProfile,
  proveSpeechCertificationGate,
  runSpeechCertification,
} from "../dist/index.js";

import {
  extractJobBlock,
  loadNightlyCi,
} from "../../../scripts/ci-workflow-test-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const PKG_JSON = path.join(PKG_ROOT, "package.json");
const SECRET = "LEARNER_SPEECH_CERT_MUST_NOT_LEAK";

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

test("unit: profile declares STT+TTS, CK-05.1/2, Indic fixtures, and NFR-07 voiceRtt", () => {
  assert.ok(existsSync(DEFAULT_SPEECH_CERT_PROFILE));
  const profile = loadSpeechCertProfile();
  assert.equal(profile.schemaVersion, "bindings-speech.cert-profile.v1");
  assert.equal(profile.locality, "on-device");
  assert.deepEqual(profile.obligationIds, [...SPEECH_CERT_OBLIGATION_IDS]);
  assert.ok(profile.bindings.includes("stt"));
  assert.ok(profile.bindings.includes("tts"));
  assert.ok(profile.indicFixtures.requiredUtteranceIds.includes("hi-greeting"));
  assert.ok(
    profile.indicFixtures.requiredUtteranceIds.includes("hi-en-codeswitch"),
  );
  assert.ok(profile.indicFixtures.requiredUtteranceIds.includes("ta-greeting"));
  assert.equal(profile.voiceRtt?.nfrId, "NFR-07");
  assert.equal(profile.voiceRtt?.enabled, true);
});

test("happy path: speech-conformance-cert job wires ci:certify:speech + prove", () => {
  const yml = loadCi();
  const block = extractJobBlock(yml, "certifications");
  assert.doesNotMatch(block, /needs:\s*\[typescript\]/);
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.match(block, /pnpm build/);
  assert.match(block, /sutra-bindings-speech run ci:certify:speech/);
  assert.match(block, /tee artifacts\/speech-conformance-cert\/certify\.log/);
  assert.match(block, /ci:prove:speech-cert/);
  assert.match(block, /upload-artifact@v4/);
  assert.match(block, /if:\s*always\(\)/);
  assert.match(block, /pnpm\/action-setup@v4/);
  assert.match(block, /version:\s*10\.30\.3/);
  assert.match(block, /node-version:\s*22/);
  assert.match(block, /Indic speech conformance/i);
  assert.match(block, /NFR-07/);
  assert.match(block, /voice-rtt\.baseline\.json/);
  assert.doesNotMatch(block, /strategy:\s*\n\s*matrix:/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(typeof pkg.scripts["ci:certify:speech"], "string");
  assert.match(
    pkg.scripts["ci:certify:speech"],
    /artifacts\/speech-conformance-cert\/speech\.cert\.json/,
  );
  assert.equal(typeof pkg.scripts["ci:prove:speech-cert"], "string");
});

test("happy path: certify STT+TTS + Indic fixtures writes pass report", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-speech-cert-"));
  const reportPath = path.join(dir, "speech.cert.json");
  const cap = captureIo();
  const { exitCode, report } = await runSpeechCertification(cap.io, {
    reportOutPath: reportPath,
  });
  assert.equal(exitCode, 0, cap.err());
  assert.equal(report.outcome, "pass");
  assert.equal(report.schemaVersion, SPEECH_CERT_REPORT_SCHEMA_VERSION);
  assert.equal(report.bindings.length, 2);
  assert.ok(report.bindings.every((b) => b.outcome === "pass"));
  assert.equal(report.indicFixtures.outcome, "pass");
  assert.ok(report.indicFixtures.utteranceCount >= 5);
  assert.ok(report.voiceRtt?.ok, JSON.stringify(report.voiceRtt));
  assert.equal(report.voiceRtt?.nfrId, "NFR-07");
  assert.equal(report.voiceRtt?.clock, "performance.now");
  assert.equal(report.failures.length, 0);
  assert.equal(report.subjectId, "cert.speech.indic");
  assert.ok(existsSync(reportPath));
  const disk = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(disk.outcome, "pass");
  assert.ok(disk.voiceRtt?.ok);
  assert.ok(!JSON.stringify(disk).includes(SECRET));
  assert.ok(!cap.out().includes(SECRET));
  assert.ok(!cap.err().includes(SECRET));
  rmSync(dir, { recursive: true, force: true });
});

test("edge: seeded final-only STT + no-fallback TTS → red with loud DIFF; revert green", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-speech-cert-prove-"));
  const redPath = path.join(dir, "red.cert.json");
  const greenPath = path.join(dir, "green.cert.json");

  const redCap = captureIo();
  const red = await runSpeechCertification(redCap.io, {
    skipIndicFixtures: true,
    skipVoiceRtt: true,
    sttFactory: createFinalOnlySpeechHarnessFactory(),
    ttsFactory: createNoFallbackSpeechHarnessFactory(),
    reportOutPath: redPath,
  });
  assert.equal(red.exitCode, 1);
  assert.equal(red.report.outcome, "fail");
  assert.match(redCap.err(), /SPEECH CERT FAIL DIFF/);
  assert.ok(
    red.report.failures.some((f) => /CK-05\.1/.test(f)) ||
      red.report.bindings.some((b) =>
        b.verdicts.some((v) => v.obligationId === "CK-05.1" && v.outcome !== "pass"),
      ),
  );
  assert.ok(
    red.report.failures.some((f) => /CK-05\.2/.test(f)) ||
      red.report.bindings.some((b) =>
        b.verdicts.some((v) => v.obligationId === "CK-05.2" && v.outcome !== "pass"),
      ),
  );
  assert.match(redCap.err(), /MUST/i);
  assert.ok(!redCap.err().includes(SECRET));

  const greenCap = captureIo();
  const green = await runSpeechCertification(greenCap.io, {
    reportOutPath: greenPath,
  });
  assert.equal(green.exitCode, 0, greenCap.err());
  assert.equal(green.report.outcome, "pass");
  assert.equal(green.report.failures.length, 0);
  assert.ok(green.report.voiceRtt?.ok);

  rmSync(dir, { recursive: true, force: true });
});

test("edge: proveSpeechCertificationGate green→red→green", async () => {
  const cap = captureIo();
  const result = await proveSpeechCertificationGate(cap.io);
  assert.equal(result.exitCode, 0);
  assert.ok(result.phases.some((p) => p.phase === "seeded.red.ck05" && p.status === 1));
  assert.ok(result.phases.some((p) => p.phase === "seeded.red.nfr07" && p.status === 1));
  assert.ok(result.phases.some((p) => p.phase === "restore.green" && p.status === 0));
  assert.match(cap.out() + cap.err(), /NFR-07|CK-05/);
  assert.ok(existsSync(path.join(PKG_ROOT, "certification/reports/speech.cert.json")));
});

test("sovereignty: concurrent subjects stay isolated in cert report telemetry", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-speech-cert-iso-"));
  const aPath = path.join(dir, "a.json");
  const bPath = path.join(dir, "b.json");
  const capA = captureIo();
  const capB = captureIo();
  const [a, b] = await Promise.all([
    runSpeechCertification(capA.io, {
      reportOutPath: aPath,
      skipIndicFixtures: true,
      skipVoiceRtt: true,
    }),
    runSpeechCertification(capB.io, {
      reportOutPath: bPath,
      skipIndicFixtures: true,
      skipVoiceRtt: true,
    }),
  ]);
  assert.equal(a.exitCode, 0, capA.err());
  assert.equal(b.exitCode, 0, capB.err());
  assert.equal(a.report.telemetry.subjectId, a.report.subjectId);
  assert.equal(b.report.telemetry.subjectId, b.report.subjectId);
  assert.ok(!JSON.stringify(a.report).includes(SECRET));
  rmSync(dir, { recursive: true, force: true });
});
