/**
 * Local TTS binding — synthesize + CK-05 language fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SPEECH_UNSUPPORTED_LANGUAGE,
  collectAudioChunks,
  createSpeechObligationsRegistry,
  runConformance,
} from "@moolam/contract-conformance";
import {
  LOCAL_TTS_ENGINE,
  LocalTtsError,
  createLocalTtsSpeechHarnessFactory,
  languagesFromVoices,
  loadLocalTts,
  loadTtsVoicesManifest,
  resolveTtsVoice,
} from "../dist/index.js";

const SECRET = "LEARNER_SYNTHESIS_TEXT_MUST_NOT_APPEAR";

test("unit: voices manifest declares hi + en + ta; fallback in set", () => {
  const m = loadTtsVoicesManifest();
  assert.equal(m.engine, LOCAL_TTS_ENGINE);
  const langs = languagesFromVoices(m.voices);
  assert.ok(langs.includes("hi-IN"));
  assert.ok(langs.includes("en-IN"));
  assert.ok(langs.includes("ta-IN"));
  assert.ok(langs.includes(m.fallbackLanguage));
  assert.ok(m.mixedScriptPolicy?.length);
});

test("happy path: load declares supportedLanguages from voices only", async () => {
  const events = [];
  const tts = await loadLocalTts({
    subjectId: "subj.tts.load",
    deviceId: "dev-tts",
    onTelemetry: (e) => events.push(e),
  });
  assert.deepEqual(tts.supportedLanguages, ["hi-IN", "en-IN", "ta-IN"]);
  assert.equal(tts.fallbackLanguage, "en-IN");
  assert.equal(tts.engine, LOCAL_TTS_ENGINE);
  assert.ok(events.some((e) => e.op === "load" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  await tts.unload();
});

test("happy path: synthesize supported language streams PCM chunks", async () => {
  const events = [];
  const tts = await loadLocalTts({
    subjectId: "subj.tts.ok",
    deviceId: "dev-tts",
    onTelemetry: (e) => events.push(e),
  });
  const chunks = await collectAudioChunks(
    tts.synthesize("नमस्ते", { language: "hi-IN" }),
  );
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((c) => c.data.byteLength > 0 && c.sampleRateHz > 0));
  assert.ok(
    events.some(
      (e) =>
        e.op === "synthesize" &&
        e.outcome === "ok" &&
        e.usedFallback === false &&
        e.effectiveLanguage === "hi-IN",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("नमस्ते"));
  await tts.unload();
});

test("happy path: CK-05 speech conformance green on local TTS", async () => {
  const report = await runConformance({
    registry: createSpeechObligationsRegistry(),
    factory: createLocalTtsSpeechHarnessFactory({ deviceId: "dev-ck05-tts" }),
    subjectId: "subj.tts.ck05",
    deviceId: "dev-ck05-tts",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
  assert.equal(report.passed, 2);
});

test("edge: unsupported language falls back (never fails) with surfaced signal", async () => {
  const events = [];
  const tts = await loadLocalTts({
    subjectId: "subj.tts.fallback",
    deviceId: "dev-tts",
    onTelemetry: (e) => events.push(e),
  });
  const chunks = await collectAudioChunks(
    tts.synthesize("hello", { language: SPEECH_UNSUPPORTED_LANGUAGE }),
  );
  assert.ok(chunks.length >= 1);
  const fb = events.find((e) => e.op === "synthesize");
  assert.equal(fb?.outcome, "fallback");
  assert.equal(fb?.usedFallback, true);
  assert.equal(fb?.effectiveLanguage, "en-IN");
  assert.equal(fb?.requestedLanguage, SPEECH_UNSUPPORTED_LANGUAGE);
  assert.match(fb?.detail ?? "", /fallback/i);
  await tts.unload();
});

test("edge: empty text → typed validation error before synthesis", async () => {
  const tts = await loadLocalTts({
    subjectId: "subj.tts.empty",
    deviceId: "dev-tts",
  });
  await assert.rejects(
    () => collectAudioChunks(tts.synthesize("   ", { language: "en-IN" })),
    (err) => err instanceof LocalTtsError && err.failureClass === "validation",
  );
  await assert.rejects(
    () => collectAudioChunks(tts.synthesize("", { language: "en-IN" })),
    (err) => err instanceof LocalTtsError && err.failureClass === "validation",
  );
  await tts.unload();
});

test("edge: mixed-script Devanagari+Latin synthesizes without crash", async () => {
  const tts = await loadLocalTts({
    subjectId: "subj.tts.mixed",
    deviceId: "dev-tts",
  });
  const chunks = await collectAudioChunks(
    tts.synthesize("नमस्ते class, open books", { language: "hi-IN" }),
  );
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[0].data.byteLength > 0);
  await tts.unload();
});

test("edge: resolveTtsVoice never silently swaps without usedFallback", () => {
  const m = loadTtsVoicesManifest();
  const ok = resolveTtsVoice({
    voices: m.voices,
    fallbackLanguage: m.fallbackLanguage,
    requestedLanguage: "ta-IN",
  });
  assert.equal(ok.usedFallback, false);
  assert.equal(ok.effectiveLanguage, "ta-IN");

  const fb = resolveTtsVoice({
    voices: m.voices,
    fallbackLanguage: m.fallbackLanguage,
    requestedLanguage: "xx-ZZ",
  });
  assert.equal(fb.usedFallback, true);
  assert.equal(fb.effectiveLanguage, m.fallbackLanguage);
});

test("sovereignty: concurrent TTS subjects stay isolated in telemetry", async () => {
  const eventsA = [];
  const eventsB = [];
  const [a, b] = await Promise.all([
    loadLocalTts({
      subjectId: "subj.tts.a",
      deviceId: "dev-a",
      onTelemetry: (e) => eventsA.push(e),
    }),
    loadLocalTts({
      subjectId: "subj.tts.b",
      deviceId: "dev-b",
      onTelemetry: (e) => eventsB.push(e),
    }),
  ]);
  await Promise.all([
    collectAudioChunks(a.synthesize("alpha", { language: "en-IN" })),
    collectAudioChunks(b.synthesize("beta", { language: "hi-IN" })),
  ]);
  assert.ok(eventsA.every((e) => e.subjectId === "subj.tts.a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj.tts.b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj.tts.b"));
  assert.ok(!JSON.stringify(eventsA).includes("alpha"));
  await Promise.all([a.unload(), b.unload()]);
});

test("edge: idempotent replay of same synthesize call", async () => {
  const tts = await loadLocalTts({
    subjectId: "subj.tts.replay",
    deviceId: "dev-tts",
  });
  const first = await collectAudioChunks(
    tts.synthesize("replay", { language: "en-IN" }),
  );
  const second = await collectAudioChunks(
    tts.synthesize("replay", { language: "en-IN" }),
  );
  assert.equal(first.length, second.length);
  assert.ok(first[0].data.byteLength > 0);
  await tts.unload();
});

test("edge: corrupt voices manifest → typed config error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-tts-"));
  const bad = path.join(dir, "bad.json");
  writeFileSync(
    bad,
    JSON.stringify({
      schemaVersion: "x",
      fallbackLanguage: "en-IN",
      voices: [],
    }),
    "utf8",
  );
  assert.throws(
    () => loadTtsVoicesManifest(bad),
    (err) => err instanceof LocalTtsError && err.failureClass === "config",
  );
  rmSync(dir, { recursive: true, force: true });
});
