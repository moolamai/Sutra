/**
 * FP-002: noisy Indic classroom STT fixture — confidence drop without utterance export.
 * Run: pnpm --filter sutra-bindings-speech test (or node --test this file after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectTranscriptSegments,
  hasPartialBeforeFinal,
} from "@moolam/contract-conformance";
import {
  indicFixtureAsAudioStream,
  loadIndicUtteranceCatalog,
  loadIndicUtteranceFixture,
  loadWhisperCppSpeech,
} from "../dist/index.js";

const CONFIDENCE_NOISE_CEILING = 0.4;

test("FP-002 fixture: hi-classroom-noise is catalogued with ambientNoise", () => {
  const catalog = loadIndicUtteranceCatalog();
  const row = catalog.utterances.find((u) => u.id === "hi-classroom-noise");
  assert.ok(row, "hi-classroom-noise must be in Indic catalog");
  assert.equal(row.ambientNoise, true);
  assert.equal(row.language, "hi-IN");
  assert.ok(row.containsCodeSwitch);
});

test("FP-002: classroom-noise STT emits partial→final with depressed confidence", async () => {
  const events = [];
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.fp002.noise",
    deviceId: "dev-fp002-ci",
    onTelemetry: (e) => events.push(e),
  });
  try {
    const fixture = loadIndicUtteranceFixture("hi-classroom-noise");
    const segs = await collectTranscriptSegments(
      speech.transcribe(indicFixtureAsAudioStream(fixture)),
    );
    assert.ok(hasPartialBeforeFinal(segs));
    const finals = segs.filter((s) => s.isFinal);
    assert.ok(finals.length >= 1);
    const conf = finals[0]?.confidence;
    assert.ok(
      typeof conf === "number" && conf <= CONFIDENCE_NOISE_CEILING,
      `expected confidence ≤ ${CONFIDENCE_NOISE_CEILING}, got ${conf}`,
    );
    // Sovereignty: telemetry must not carry raw utterance bodies.
    const blob = JSON.stringify(events);
    assert.doesNotMatch(blob, /LEARNER_UTTERANCE/);
    assert.ok(events.every((e) => e.subjectId === "subj.fp002.noise"));
  } finally {
    await speech.unload();
  }
});

test("FP-002: quiet hi-greeting keeps high confidence (noise is not global)", async () => {
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.fp002.quiet",
    deviceId: "dev-fp002-ci",
  });
  try {
    const fixture = loadIndicUtteranceFixture("hi-greeting");
    const segs = await collectTranscriptSegments(
      speech.transcribe(indicFixtureAsAudioStream(fixture)),
    );
    const finals = segs.filter((s) => s.isFinal);
    assert.ok((finals[0]?.confidence ?? 0) > CONFIDENCE_NOISE_CEILING);
  } finally {
    await speech.unload();
  }
});
