/**
 * NFR-07 voice RTT: final transcript → first TTS audio on mid-range profile.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  DEFAULT_VOICE_RTT_BASELINE,
  DEFAULT_VOICE_RTT_DEVICE_PROFILE,
  NFR_07_BUDGET_P95_MS,
  NFR_07_ID,
  evaluateVoiceRttGates,
  loadVoiceRttBaseline,
  loadVoiceRttDeviceProfile,
  percentileMs,
  runVoiceRttProof,
} from "../dist/index.js";

const SECRET = "LEARNER_VOICE_RTT_MUST_NOT_LEAK";

test("unit: mid-range device profile declares NFR-07 ≤2500ms", () => {
  assert.ok(existsSync(DEFAULT_VOICE_RTT_DEVICE_PROFILE));
  const p = loadVoiceRttDeviceProfile();
  assert.equal(p.nfr.nfrId, NFR_07_ID);
  assert.equal(p.nfr.metric, "final_transcript_to_first_audio");
  assert.equal(p.nfr.voiceRttP95Ms, NFR_07_BUDGET_P95_MS);
  assert.equal(p.hardwareClass, "mid-range");
});

test("unit: baseline is relative gate input (never auto-raise)", () => {
  assert.ok(existsSync(DEFAULT_VOICE_RTT_BASELINE));
  const b = loadVoiceRttBaseline();
  assert.equal(b.nfrId, NFR_07_ID);
  assert.ok(b.p95Ms > 0);
  assert.ok(b.tolerancePercent >= 0);
  assert.ok(b.sampleCount >= 3);
});

test("unit: percentileMs nearest-rank p95", () => {
  assert.equal(percentileMs([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.ok(Number.isNaN(percentileMs([], 95)));
});

test("happy path: voice RTT proof green with performance.now clock", async () => {
  const proof = await runVoiceRttProof({
    subjectId: "subj.voice.rtt.ok",
    deviceId: "dev-rtt",
    sampleCount: 4,
    warmupCount: 1,
  });
  assert.equal(proof.nfrId, NFR_07_ID);
  assert.equal(proof.clock, "performance.now");
  assert.equal(proof.policy, "absolute-ceiling-plus-relative-baseline");
  assert.equal(proof.ok, true, proof.failures.join("\n"));
  assert.ok(proof.measuredP95Ms <= proof.budgetP95Ms);
  assert.ok(proof.measuredP95Ms <= proof.allowedRelativeP95Ms);
  assert.ok(!JSON.stringify(proof).includes(SECRET));
});

test("edge: real first-audio delay → absolute NFR-07 red with loud failure", async () => {
  const proof = await runVoiceRttProof({
    subjectId: "subj.voice.rtt.delay",
    deviceId: "dev-rtt",
    injectFirstAudioDelayMs: 3_200,
    sampleCount: 2,
    warmupCount: 0,
  });
  assert.equal(proof.ok, false);
  assert.equal(proof.absoluteOk, false);
  assert.ok(proof.measuredP95Ms > NFR_07_BUDGET_P95_MS);
  assert.ok(proof.failures.some((f) => /NFR-07 absolute/.test(f)));
});

test("edge: tight relative baseline → red DIFF; revert budget green", () => {
  const red = evaluateVoiceRttGates({
    measuredP95Ms: 200,
    budgetP95Ms: 2500,
    baselineP95Ms: 50,
    tolerancePercent: 50,
  });
  assert.equal(red.absoluteOk, true);
  assert.equal(red.relativeOk, false);
  assert.match(red.failures.join("\n"), /NFR-07 relative/);

  const green = evaluateVoiceRttGates({
    measuredP95Ms: 40,
    budgetP95Ms: 2500,
    baselineP95Ms: 50,
    tolerancePercent: 50,
  });
  assert.equal(green.absoluteOk, true);
  assert.equal(green.relativeOk, true);
  assert.equal(green.failures.length, 0);
});

test("sovereignty: concurrent voice RTT subjects stay isolated", async () => {
  const [a, b] = await Promise.all([
    runVoiceRttProof({
      subjectId: "subj.voice.rtt.a",
      deviceId: "dev-a",
      sampleCount: 2,
      warmupCount: 0,
    }),
    runVoiceRttProof({
      subjectId: "subj.voice.rtt.b",
      deviceId: "dev-b",
      sampleCount: 2,
      warmupCount: 0,
    }),
  ]);
  assert.equal(a.ok, true, a.failures.join("\n"));
  assert.equal(b.ok, true, b.failures.join("\n"));
  assert.equal(a.subjectId, "subj.voice.rtt.a");
  assert.equal(b.subjectId, "subj.voice.rtt.b");
  assert.ok(!JSON.stringify(a).includes("subj.voice.rtt.b"));
});
