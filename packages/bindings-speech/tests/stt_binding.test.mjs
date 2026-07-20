/**
 * whisper.cpp-class STT binding — CK-05 partials + language fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEECH_OBLIGATION_IDS,
  SPEECH_UNSUPPORTED_LANGUAGE,
  collectTranscriptSegments,
  createSpeechObligationsRegistry,
  hasPartialBeforeFinal,
  runConformance,
  speechProbeAudioStream,
} from "@moolam/contract-conformance";
import {
  DEFAULT_INDIC_LANGUAGES_MANIFEST,
  WHISPER_CPP_CLASS_ENGINE,
  WhisperCppSpeechError,
  createWhisperCppSpeechHarnessFactory,
  loadIndicLanguagesManifest,
  loadWhisperCppSpeech,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const SECRET = "LEARNER_AUDIO_BYTES_MUST_NOT_APPEAR_IN_TELEMETRY";

async function* pcmChunks(text, sampleRateHz = 16_000, durationMs = 400) {
  const bytesPerMs = (sampleRateHz * 2) / 1000;
  const pcm = new Uint8Array(Math.max(2, Math.floor(durationMs * bytesPerMs)));
  const encoded = new TextEncoder().encode(text);
  pcm.set(encoded.slice(0, Math.min(encoded.length, pcm.length)));
  yield { data: pcm, sampleRateHz };
}

test("unit: Indic languages manifest declares hi + en + ≥1 Indic (ta)", () => {
  const m = loadIndicLanguagesManifest(DEFAULT_INDIC_LANGUAGES_MANIFEST);
  assert.equal(m.engine, WHISPER_CPP_CLASS_ENGINE);
  assert.ok(m.languages.includes("hi-IN"));
  assert.ok(m.languages.includes("en-IN"));
  assert.ok(m.languages.includes("ta-IN"));
  assert.ok(m.languages.includes(m.fallbackLanguage));
});

test("happy path: load declares supportedLanguages from manifest only", async () => {
  const events = [];
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.stt.load",
    deviceId: "dev-stt",
    onTelemetry: (e) => events.push(e),
  });
  assert.deepEqual(speech.supportedLanguages, ["hi-IN", "en-IN", "ta-IN"]);
  assert.equal(speech.engine, WHISPER_CPP_CLASS_ENGINE);
  assert.ok(events.some((e) => e.op === "load" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  await speech.unload();
});

test("happy path: transcribe emits partial before final", async () => {
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.stt.partial",
    deviceId: "dev-stt",
  });
  const segs = await collectTranscriptSegments(
    speech.transcribe(pcmChunks("hello classroom")),
  );
  assert.ok(hasPartialBeforeFinal(segs));
  assert.equal(segs[0].isFinal, false);
  assert.equal(segs.at(-1).isFinal, true);
  assert.ok(segs[0].text.length > 0);
  await speech.unload();
});

test("happy path: speech conformance CK-05.1 + CK-05.2 green", async () => {
  const events = [];
  const report = await runConformance({
    registry: createSpeechObligationsRegistry(),
    factory: createWhisperCppSpeechHarnessFactory({
      deviceId: "dev-ck05",
      onTelemetry: (e) => events.push(e),
    }),
    subjectId: "subj.stt.ck05",
    deviceId: "dev-ck05",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
  assert.equal(report.passed, 2);
  assert.ok(
    report.verdicts.every((v) =>
      [SPEECH_OBLIGATION_IDS.transcribePartials, SPEECH_OBLIGATION_IDS.languageFallback].includes(
        v.obligationId,
      ),
    ),
  );
});

test("edge: short utterance (<200ms) still emits partial then final", async () => {
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.stt.short",
    deviceId: "dev-stt",
  });
  // ~100ms of silence-ish PCM
  const segs = await collectTranscriptSegments(
    speech.transcribe(pcmChunks("", 16_000, 100)),
  );
  assert.ok(hasPartialBeforeFinal(segs));
  assert.equal(segs.at(-1).isFinal, true);
  await speech.unload();
});

test("edge: code-switched Hindi/English does not crash; non-empty partials", async () => {
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.stt.codeswitch",
    deviceId: "dev-stt",
  });
  const segs = await collectTranscriptSegments(
    speech.transcribe(pcmChunks("नमस्ते class, open your books")),
  );
  assert.ok(hasPartialBeforeFinal(segs));
  assert.ok(segs.every((s) => s.text.length > 0));
  assert.ok(segs.some((s) => s.language === "hi-IN" || s.text.includes("code-switched")));
  await speech.unload();
});

test("edge: unsupported synthesize language falls back (never fails)", async () => {
  const events = [];
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.stt.fallback",
    deviceId: "dev-stt",
    onTelemetry: (e) => events.push(e),
  });
  const chunks = [];
  for await (const c of speech.synthesize("probe", {
    language: SPEECH_UNSUPPORTED_LANGUAGE,
  })) {
    chunks.push(c);
  }
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[0].data.byteLength > 0);
  assert.ok(events.some((e) => e.op === "synthesize" && e.outcome === "fallback"));
  await speech.unload();
});

test("sovereignty: concurrent subjects stay isolated in telemetry", async () => {
  const eventsA = [];
  const eventsB = [];
  const [a, b] = await Promise.all([
    loadWhisperCppSpeech({
      subjectId: "subj.stt.a",
      deviceId: "dev-a",
      onTelemetry: (e) => eventsA.push(e),
    }),
    loadWhisperCppSpeech({
      subjectId: "subj.stt.b",
      deviceId: "dev-b",
      onTelemetry: (e) => eventsB.push(e),
    }),
  ]);
  await Promise.all([
    collectTranscriptSegments(a.transcribe(speechProbeAudioStream({
      subjectId: "subj.stt.a",
      deviceId: "dev-a",
      deadlineMs: 5000,
      emit() {},
    }))),
    collectTranscriptSegments(b.transcribe(speechProbeAudioStream({
      subjectId: "subj.stt.b",
      deviceId: "dev-b",
      deadlineMs: 5000,
      emit() {},
    }))),
  ]);
  assert.ok(eventsA.every((e) => e.subjectId === "subj.stt.a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj.stt.b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj.stt.b"));
  assert.ok(!JSON.stringify(eventsB).includes("subj.stt.a"));
  await Promise.all([a.unload(), b.unload()]);
});

test("edge: idempotent replay of same probe yields partial-before-final twice", async () => {
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.stt.replay",
    deviceId: "dev-stt",
  });
  const first = await collectTranscriptSegments(
    speech.transcribe(pcmChunks("replay me")),
  );
  const second = await collectTranscriptSegments(
    speech.transcribe(pcmChunks("replay me")),
  );
  assert.ok(hasPartialBeforeFinal(first));
  assert.ok(hasPartialBeforeFinal(second));
  assert.equal(first.length, second.length);
  await speech.unload();
});

test("edge: missing subjectId / corrupt manifest → typed config error", async () => {
  await assert.rejects(
    () =>
      loadWhisperCppSpeech({
        subjectId: "  ",
        deviceId: "dev",
      }),
    (err) => err instanceof WhisperCppSpeechError && err.failureClass === "config",
  );

  const dir = mkdtempSync(path.join(tmpdir(), "sutra-speech-"));
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ schemaVersion: "x", languages: [] }), "utf8");
  assert.throws(
    () => loadIndicLanguagesManifest(bad),
    (err) => err instanceof WhisperCppSpeechError && err.failureClass === "config",
  );
  rmSync(dir, { recursive: true, force: true });
});
