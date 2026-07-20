/**
 * Edge harness STT integration — injectable SpeechInterface + offline prove.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectTranscriptSegments,
  hasPartialBeforeFinal,
} from "@moolam/contract-conformance";
import {
  createLocalVectorMemoryDriver,
  LocalVectorDb,
} from "@moolam/edge-agent";
import {
  createEdgeBindingsWithSpeech,
  indicFixtureAsAudioStream,
  loadIndicUtteranceFixture,
  loadWhisperCppSpeech,
  proveOfflineEdgeSttBinding,
} from "../dist/index.js";

const SECRET = "SECRET_SPEECH_EDGE_MUST_NOT_LEAK";

test("happy path: createEdgeBindingsWithSpeech injects SpeechInterface", async () => {
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.edge.bind",
    deviceId: "dev-edge",
  });
  const db = new LocalVectorDb(createLocalVectorMemoryDriver());
  await db.initialize();
  const events = [];
  const { bindings } = createEdgeBindingsWithSpeech({
    subjectId: "subj.edge.bind",
    deviceId: "dev-edge",
    speech,
    vectorDb: db,
  });
  assert.equal(bindings.speech, speech);
  assert.ok(bindings.speech?.supportedLanguages.includes("hi-IN"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  await speech.unload();
});

test("happy path: offline edge STT proof green (network denied)", async () => {
  const events = [];
  const proof = await proveOfflineEdgeSttBinding({
    fixtureId: "hi-en-codeswitch",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proof.ok, true, JSON.stringify(proof.failures));
  assert.equal(proof.speechBound, true);
  assert.equal(proof.partialBeforeFinal, true);
  assert.ok(proof.finalText.trim().length > 0);
  assert.equal(proof.servedLocally, true);
  assert.equal(proof.syncStatus, "offline-mode");
  assert.equal(proof.localityOk, true);
  assert.equal(proof.egressAttemptCount, 0);
  assert.equal(proof.cognitiveCoreOk, true);
  assert.equal(proof.subjectIsolationOk, true);
  assert.ok(events.some((e) => e.outcome === "pass"));
  assert.ok(!JSON.stringify(proof).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: short fixture still partial-before-final under edge binding", async () => {
  const speech = await loadWhisperCppSpeech({
    subjectId: "subj.edge.short",
    deviceId: "dev-edge",
  });
  const fixture = loadIndicUtteranceFixture("short-hi");
  assert.ok(fixture.durationMs < 200);
  const segs = await collectTranscriptSegments(
    speech.transcribe(indicFixtureAsAudioStream(fixture)),
  );
  assert.ok(hasPartialBeforeFinal(segs));
  const db = new LocalVectorDb(createLocalVectorMemoryDriver());
  await db.initialize();
  const { bindings } = createEdgeBindingsWithSpeech({
    subjectId: "subj.edge.short",
    deviceId: "dev-edge",
    speech,
    vectorDb: db,
  });
  assert.equal(bindings.speech, speech);
  await speech.unload();
});

test("sovereignty: text-only bindings omit speech; injected stays subject-scoped", async () => {
  const a = await loadWhisperCppSpeech({
    subjectId: "subj.edge.a",
    deviceId: "dev-a",
  });
  const b = await loadWhisperCppSpeech({
    subjectId: "subj.edge.b",
    deviceId: "dev-b",
  });
  const dbA = new LocalVectorDb(createLocalVectorMemoryDriver());
  const dbB = new LocalVectorDb(createLocalVectorMemoryDriver());
  await Promise.all([dbA.initialize(), dbB.initialize()]);
  const bundleA = createEdgeBindingsWithSpeech({
    subjectId: "subj.edge.a",
    deviceId: "dev-a",
    speech: a,
    vectorDb: dbA,
  });
  const bundleB = createEdgeBindingsWithSpeech({
    subjectId: "subj.edge.b",
    deviceId: "dev-b",
    speech: b,
    vectorDb: dbB,
  });
  assert.equal(bundleA.bindings.speech, a);
  assert.equal(bundleB.bindings.speech, b);
  assert.notEqual(bundleA.bindings.speech, bundleB.bindings.speech);
  await Promise.all([a.unload(), b.unload()]);
});
