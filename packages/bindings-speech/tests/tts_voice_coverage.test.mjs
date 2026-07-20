/**
 * TTS voice coverage model card + README parity + CK-05 fallback-not-failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEECH_UNSUPPORTED_LANGUAGE,
  collectAudioChunks,
  createSpeechObligationsRegistry,
  runConformance,
} from "@moolam/contract-conformance";
import {
  DEFAULT_TTS_MODEL_CARD,
  LocalTtsError,
  assertTtsModelCardMatchesVoices,
  createLocalTtsSpeechHarnessFactory,
  languageVoiceCoverageTable,
  loadLocalTts,
  loadTtsVoiceModelCard,
  loadTtsVoicesManifest,
} from "../dist/index.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = path.join(PKG, "README.md");
const SECRET = "LEARNER_SYNTHESIS_TEXT_MUST_NOT_APPEAR";

test("unit: model card declares hi + en + ta with fallback en-IN", () => {
  assert.ok(existsSync(DEFAULT_TTS_MODEL_CARD));
  const card = loadTtsVoiceModelCard();
  assert.equal(card.schemaVersion, "bindings-speech.tts-model-card.v1");
  assert.equal(card.locality, "on-device");
  assert.equal(card.fallbackLanguage, "en-IN");
  const langs = card.coverage.map((r) => r.language);
  assert.deepEqual(langs, ["hi-IN", "en-IN", "ta-IN"]);
  assert.ok(card.fallbackPolicy.unsupportedBcp47.includes("fallback"));
  assert.ok(card.fallbackPolicy.emptyText.includes("validation"));
  assert.ok(card.observability.requiredFields.includes("subjectId"));
  assert.match(card.observability.neverEmit, /raw/i);
});

test("happy path: model card language→voice matches voices.json", () => {
  const card = loadTtsVoiceModelCard();
  const voices = loadTtsVoicesManifest();
  assert.doesNotThrow(() => assertTtsModelCardMatchesVoices(card, voices));
  const table = languageVoiceCoverageTable(card);
  assert.deepEqual(table, [
    { language: "hi-IN", voiceId: "indic-hi-f1", role: "primary-indic" },
    { language: "en-IN", voiceId: "indic-en-f1", role: "fallback-english" },
    { language: "ta-IN", voiceId: "indic-ta-f1", role: "additional-indic" },
  ]);
});

test("happy path: README language→voice table matches model card", () => {
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /tts-voices\.model-card\.json/);
  assert.match(readme, /fallbackLanguage/);
  const card = loadTtsVoiceModelCard();
  for (const row of card.coverage) {
    assert.ok(
      readme.includes(`\`${row.language}\``),
      `README missing language ${row.language}`,
    );
    assert.ok(
      readme.includes(`\`${row.voiceId}\``),
      `README missing voice ${row.voiceId}`,
    );
    assert.ok(readme.includes(row.role), `README missing role ${row.role}`);
  }
  assert.match(readme, /never throw/i);
  assert.match(readme, /usedFallback/);
  assert.ok(!readme.includes(SECRET));
});

test("happy path: CK-05 fallback-not-failure conformance green", async () => {
  const report = await runConformance({
    registry: createSpeechObligationsRegistry(),
    factory: createLocalTtsSpeechHarnessFactory({
      deviceId: "dev-ck05-coverage",
    }),
    subjectId: "subj.tts.coverage.ck05",
    deviceId: "dev-ck05-coverage",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
  assert.equal(report.passed, 2);
});

test("edge: unsupported BCP-47 never fails; fallback matches model card", async () => {
  const card = loadTtsVoiceModelCard();
  const events = [];
  const tts = await loadLocalTts({
    subjectId: "subj.tts.coverage.fallback",
    deviceId: "dev-tts-cov",
    onTelemetry: (e) => events.push(e),
  });
  assert.deepEqual(
    tts.supportedLanguages,
    card.coverage.map((r) => r.language),
  );
  assert.equal(tts.fallbackLanguage, card.fallbackLanguage);

  const chunks = await collectAudioChunks(
    tts.synthesize("hello", { language: SPEECH_UNSUPPORTED_LANGUAGE }),
  );
  assert.ok(chunks.length >= 1);
  const fb = events.find((e) => e.op === "synthesize");
  assert.equal(fb?.outcome, "fallback");
  assert.equal(fb?.usedFallback, true);
  assert.equal(fb?.effectiveLanguage, card.fallbackLanguage);
  assert.equal(fb?.requestedLanguage, SPEECH_UNSUPPORTED_LANGUAGE);
  assert.ok(!JSON.stringify(events).includes(SECRET));
  await tts.unload();
});

test("edge: corrupt model card → typed config error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-tts-card-"));
  const bad = path.join(dir, "bad.card.json");
  writeFileSync(
    bad,
    JSON.stringify({
      schemaVersion: "x",
      engine: "local-tts-v1",
      locality: "on-device",
      coverage: [],
    }),
    "utf8",
  );
  assert.throws(
    () => loadTtsVoiceModelCard(bad),
    (err) => err instanceof LocalTtsError && err.failureClass === "config",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("sovereignty: coverage load stays on-device; telemetry never carries peer subject", async () => {
  const card = loadTtsVoiceModelCard();
  assert.equal(card.locality, "on-device");
  const eventsA = [];
  const eventsB = [];
  const [a, b] = await Promise.all([
    loadLocalTts({
      subjectId: "subj.tts.cov.a",
      deviceId: "dev-a",
      onTelemetry: (e) => eventsA.push(e),
    }),
    loadLocalTts({
      subjectId: "subj.tts.cov.b",
      deviceId: "dev-b",
      onTelemetry: (e) => eventsB.push(e),
    }),
  ]);
  await Promise.all([
    collectAudioChunks(a.synthesize("one", { language: "en-IN" })),
    collectAudioChunks(b.synthesize("two", { language: "ta-IN" })),
  ]);
  assert.ok(eventsA.every((e) => e.subjectId === "subj.tts.cov.a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj.tts.cov.b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj.tts.cov.b"));
  await Promise.all([a.unload(), b.unload()]);
});
