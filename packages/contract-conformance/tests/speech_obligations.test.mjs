/**
 * Speech obligations ( / CK-05): streaming partials + language fallback.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MUST_LANGUAGE_FALLBACK,
  MUST_TRANSCRIBE_PARTIALS,
  SPEECH_OBLIGATION_IDS,
  SPEECH_UNSUPPORTED_LANGUAGE,
  buildSpeechProbeAudioChunk,
  collectAudioChunks,
  collectTranscriptSegments,
  createFinalOnlySpeechHarnessFactory,
  createLanguageFallbackObligationRegistry,
  createNoFallbackSpeechHarnessFactory,
  createSpeechObligationsRegistry,
  createStreamingSpeechHarnessFactory,
  createTranscribePartialsObligationRegistry,
  createUndeclaredLanguagesSpeechHarnessFactory,
  hasPartialBeforeFinal,
  runConformance,
  speechProbeAudioStream,
} from "../dist/index.js";

test("happy path: streaming reference passes CK-05.1", async () => {
  const events = [];
  const report = await runConformance({
    registry: createTranscribePartialsObligationRegistry(),
    factory: createStreamingSpeechHarnessFactory(),
    subjectId: "subj-speech-partial-good",
    deviceId: "dev-speech",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    SPEECH_OBLIGATION_IDS.transcribePartials,
  );
  assert.equal(report.verdicts[0].mustText, MUST_TRANSCRIBE_PARTIALS);
  assert.ok(
    events.some(
      (e) =>
        e.event === "conformance.runner" &&
        e.outcome === "pass" &&
        e.obligationId === "CK-05.1" &&
        e.subjectId &&
        e.deviceId === "dev-speech",
    ),
  );
});

test("happy path: streaming reference passes CK-05.2", async () => {
  const events = [];
  const report = await runConformance({
    registry: createLanguageFallbackObligationRegistry(),
    factory: createStreamingSpeechHarnessFactory(),
    subjectId: "subj-speech-lang-good",
    deviceId: "dev-lang",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    SPEECH_OBLIGATION_IDS.languageFallback,
  );
  assert.equal(report.verdicts[0].mustText, MUST_LANGUAGE_FALLBACK);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-05.2" &&
        e.deviceId === "dev-lang",
    ),
  );
});

test("happy path: full speech registry passes CK-05.1 and CK-05.2", async () => {
  const report = await runConformance({
    registry: createSpeechObligationsRegistry(),
    factory: createStreamingSpeechHarnessFactory(),
    subjectId: "subj-speech-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
});

test("violation: final-only transcription fails CK-05.1 exactly", async () => {
  const report = await runConformance({
    registry: createTranscribePartialsObligationRegistry(),
    factory: createFinalOnlySpeechHarnessFactory(),
    subjectId: "subj-speech-final-only",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    SPEECH_OBLIGATION_IDS.transcribePartials,
  );
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /partial|isFinal/i);
});

test("violation: no-fallback synthesize fails CK-05.2 exactly", async () => {
  const report = await runConformance({
    registry: createLanguageFallbackObligationRegistry(),
    factory: createNoFallbackSpeechHarnessFactory(),
    subjectId: "subj-speech-no-fallback",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    SPEECH_OBLIGATION_IDS.languageFallback,
  );
  assert.match(report.verdicts[0].message ?? "", /fallback|fail|unsupported/i);
});

test("violation: empty supportedLanguages fails CK-05.2", async () => {
  const report = await runConformance({
    registry: createLanguageFallbackObligationRegistry(),
    factory: createUndeclaredLanguagesSpeechHarnessFactory(),
    subjectId: "subj-speech-undeclared",
  });
  assert.equal(report.exitCode, 1);
  assert.match(report.verdicts[0].message ?? "", /supportedLanguages|non-empty/i);
});

test("edge: probe audio is subject-scoped metadata", () => {
  const ctx = {
    subjectId: "subj-a::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  const chunk = buildSpeechProbeAudioChunk(ctx);
  const decoded = new TextDecoder().decode(chunk.data);
  assert.match(decoded, /subj-a\.peer/);
  assert.doesNotMatch(decoded, /password|ssn/i);
});

test("edge: hasPartialBeforeFinal requires partial then final", () => {
  assert.equal(
    hasPartialBeforeFinal([
      { text: "a", language: "en-US", startMs: 0, endMs: 1, confidence: 1, isFinal: true },
    ]),
    false,
  );
  assert.equal(
    hasPartialBeforeFinal([
      { text: "a", language: "en-US", startMs: 0, endMs: 1, confidence: 1, isFinal: false },
      { text: "ab", language: "en-US", startMs: 0, endMs: 2, confidence: 1, isFinal: true },
    ]),
    true,
  );
});

test("edge: independent factory runs share no mutable language lists", () => {
  const factory = createStreamingSpeechHarnessFactory();
  const a = factory();
  const b = factory();
  a.speech.supportedLanguages.push("xx-MUTATE");
  assert.equal(b.speech.supportedLanguages.includes("xx-MUTATE"), false);
});

test("edge: concurrent transcribe runs each emit partial-before-final", async () => {
  const harness = createStreamingSpeechHarnessFactory()();
  const ctx = {
    subjectId: "subj-conc",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  const batches = await Promise.all(
    Array.from({ length: 8 }, () =>
      collectTranscriptSegments(harness.speech.transcribe(speechProbeAudioStream(ctx))),
    ),
  );
  assert.ok(batches.every((segs) => hasPartialBeforeFinal(segs)));
});

test("edge: concurrent unsupported synthesize calls fallback without throw", async () => {
  const harness = createStreamingSpeechHarnessFactory()();
  const batches = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      collectAudioChunks(
        harness.speech.synthesize(`probe.ck05.conc.${i}`, {
          language: SPEECH_UNSUPPORTED_LANGUAGE,
        }),
      ),
    ),
  );
  assert.ok(batches.every((c) => c.length > 0 && c[0].data.length > 0));
});

test("edge: final-only still passes CK-05.2 when selected alone", async () => {
  const report = await runConformance({
    registry: createSpeechObligationsRegistry(),
    factory: createFinalOnlySpeechHarnessFactory(),
    subjectId: "subj-speech-partial-select",
    obligationIds: [SPEECH_OBLIGATION_IDS.languageFallback],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: replay of CK-05.1 violation is idempotent", async () => {
  const opts = {
    registry: createTranscribePartialsObligationRegistry(),
    factory: createFinalOnlySpeechHarnessFactory(),
    subjectId: "subj-replay-speech",
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, first.exitCode);
  assert.equal(second.failed, first.failed);
});
