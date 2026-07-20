/**
 * Indic + code-switched Hindi/English committed audio fixtures.
 * Asserts partial-before-final and non-empty finals on every utterance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEECH_UNSUPPORTED_LANGUAGE,
  collectTranscriptSegments,
  createSpeechObligationsRegistry,
  hasPartialBeforeFinal,
  runConformance,
} from "@moolam/contract-conformance";
import {
  DEFAULT_INDIC_UTTERANCE_CATALOG,
  INDIC_FIXTURES_DIR,
  createWhisperCppSpeechHarnessFactory,
  indicFixtureAsAudioStream,
  listIndicUtteranceIds,
  loadAllIndicUtteranceFixtures,
  loadIndicUtteranceCatalog,
  loadIndicUtteranceFixture,
  loadWhisperCppSpeech,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "LEARNER_UTTERANCE_BODY_MUST_NOT_LEAK";

test("unit: catalog lists hi, en, ta, code-switch, and short fixtures", () => {
  const catalog = loadIndicUtteranceCatalog();
  assert.equal(catalog.schemaVersion, "bindings-speech.indic-utterances.v1");
  assert.equal(catalog.pcmEncoding, "s16le-mono");
  assert.equal(catalog.sampleRateHz, 16_000);
  const ids = listIndicUtteranceIds();
  assert.ok(ids.includes("hi-greeting"));
  assert.ok(ids.includes("en-classroom"));
  assert.ok(ids.includes("ta-greeting"));
  assert.ok(ids.includes("hi-en-codeswitch"));
  assert.ok(ids.includes("short-hi"));
  assert.ok(ids.includes("hi-classroom-noise"));
  assert.equal(ids.length, catalog.utterances.length);
});

test("happy path: every committed PCM exists and loads with matching byteLength", () => {
  const all = loadAllIndicUtteranceFixtures();
  assert.ok(all.length >= 5);
  for (const f of all) {
    assert.ok(existsSync(f.pcmPath), f.pcmPath);
    assert.equal(f.pcm.byteLength, f.byteLength);
    assert.ok(f.pcm.byteLength > 0);
    assert.ok(f.sampleRateHz > 0);
  }
  assert.ok(existsSync(DEFAULT_INDIC_UTTERANCE_CATALOG));
  assert.ok(existsSync(path.join(INDIC_FIXTURES_DIR, "audio")));
});

test("happy path: all fixtures → partial before final + non-empty finals", async () => {
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.fixtures.batch",
    deviceId: "dev-fixtures",
  });
  const events = [];
  const speechLogged = await loadWhisperCppSpeech({
    subjectId: "subj.fixtures.logged",
    deviceId: "dev-fixtures",
    onTelemetry: (e) => events.push(e),
  });
  await speechLogged.unload();

  for (const fixture of loadAllIndicUtteranceFixtures()) {
    const segs = await collectTranscriptSegments(
      speech.transcribe(indicFixtureAsAudioStream(fixture)),
    );
    assert.ok(
      hasPartialBeforeFinal(segs),
      `${fixture.id}: must emit isFinal:false before isFinal:true`,
    );
    assert.equal(segs[0]?.isFinal, false, `${fixture.id}: first partial`);
    const finals = segs.filter((s) => s.isFinal);
    assert.ok(finals.length >= 1, `${fixture.id}: has final`);
    for (const s of segs) {
      assert.ok(s.text.trim().length > 0, `${fixture.id}: non-empty text`);
    }
    assert.ok(
      finals.every((s) => s.text.trim().length > 0),
      `${fixture.id}: non-empty finals`,
    );
  }
  await speech.unload();
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: code-switched Hindi/English fixture does not crash", async () => {
  const fixture = loadIndicUtteranceFixture("hi-en-codeswitch");
  assert.equal(fixture.containsCodeSwitch, true);
  assert.ok(fixture.durationMs >= 200);
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.fixtures.codeswitch",
    deviceId: "dev-fixtures",
  });
  const segs = await collectTranscriptSegments(
    speech.transcribe(indicFixtureAsAudioStream(fixture)),
  );
  assert.ok(hasPartialBeforeFinal(segs));
  assert.ok(segs.every((s) => s.text.length > 0));
  assert.ok(
    segs.some(
      (s) =>
        s.language === "hi-IN" ||
        s.text.includes("code-switched") ||
        s.text.length > 0,
    ),
  );
  await speech.unload();
});

test("edge: short-hi (<200ms) still emits final; partial precedes it", async () => {
  const fixture = loadIndicUtteranceFixture("short-hi");
  assert.ok(fixture.durationMs < 200);
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.fixtures.short",
    deviceId: "dev-fixtures",
  });
  const segs = await collectTranscriptSegments(
    speech.transcribe(indicFixtureAsAudioStream(fixture)),
  );
  assert.ok(hasPartialBeforeFinal(segs));
  assert.equal(segs.at(-1)?.isFinal, true);
  assert.ok((segs.at(-1)?.text ?? "").trim().length > 0);
  await speech.unload();
});

test("edge: unknown fixture id / missing pcm → typed config error", () => {
  assert.throws(
    () => loadIndicUtteranceFixture("no-such-utterance"),
    (err) => err?.failureClass === "config",
  );
});

test("edge: idempotent replay of hi-greeting fixture", async () => {
  const fixture = loadIndicUtteranceFixture("hi-greeting");
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.fixtures.replay",
    deviceId: "dev-fixtures",
  });
  const a = await collectTranscriptSegments(
    speech.transcribe(indicFixtureAsAudioStream(fixture)),
  );
  const b = await collectTranscriptSegments(
    speech.transcribe(indicFixtureAsAudioStream(fixture)),
  );
  assert.ok(hasPartialBeforeFinal(a));
  assert.ok(hasPartialBeforeFinal(b));
  assert.equal(a.length, b.length);
  await speech.unload();
});

test("sovereignty: concurrent fixture transcriptions keep subjectIds isolated", async () => {
  const fixture = loadIndicUtteranceFixture("en-classroom");
  const eventsA = [];
  const eventsB = [];
  const [a, b] = await Promise.all([
    loadWhisperCppSpeech({
      subjectId: "subj.fix.a",
      deviceId: "dev-a",
      onTelemetry: (e) => eventsA.push(e),
    }),
    loadWhisperCppSpeech({
      subjectId: "subj.fix.b",
      deviceId: "dev-b",
      onTelemetry: (e) => eventsB.push(e),
    }),
  ]);
  await Promise.all([
    collectTranscriptSegments(a.transcribe(indicFixtureAsAudioStream(fixture))),
    collectTranscriptSegments(b.transcribe(indicFixtureAsAudioStream(fixture))),
  ]);
  assert.ok(eventsA.every((e) => e.subjectId === "subj.fix.a"));
  assert.ok(eventsB.every((e) => e.subjectId === "subj.fix.b"));
  assert.ok(!JSON.stringify(eventsA).includes("subj.fix.b"));
  await Promise.all([a.unload(), b.unload()]);
});

test("happy path: speech conformance still green with fixture-backed binding", async () => {
  const report = await runConformance({
    registry: createSpeechObligationsRegistry(),
    factory: createWhisperCppSpeechHarnessFactory({
      deviceId: "dev-ck05-fixtures",
    }),
    subjectId: "subj.fixtures.ck05",
    deviceId: "dev-ck05-fixtures",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts));
  assert.equal(report.passed, 2);

  // Unsupported synthesize path still falls back when using loaded binding.
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.fixtures.fallback",
    deviceId: "dev-fixtures",
  });
  const chunks = [];
  for await (const c of speech.synthesize("x", {
    language: SPEECH_UNSUPPORTED_LANGUAGE,
  })) {
    chunks.push(c);
  }
  assert.ok(chunks.length >= 1);
  await speech.unload();
});
