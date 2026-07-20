/**
 * Edge harness VLM integration — injectable VisionInterface + offline prove.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalVectorMemoryDriver,
  LocalVectorDb,
} from "@moolam/edge-agent";
import {
  createEdgeBindingsWithVision,
  loadCk06Fixture,
  loadLocalVlm,
  proveOfflineEdgeVisionBinding,
} from "../dist/index.js";

const SECRET = "SECRET_VISION_EDGE_MUST_NOT_LEAK";

test("happy path: createEdgeBindingsWithVision injects VisionInterface", async () => {
  const vision = await loadLocalVlm({
    subjectId: "subj.edge.vision.bind",
    deviceId: "dev-edge-vision",
    maxInputBytes: 64,
  });
  const db = new LocalVectorDb(createLocalVectorMemoryDriver());
  await db.initialize();
  const { bindings } = createEdgeBindingsWithVision({
    subjectId: "subj.edge.vision.bind",
    deviceId: "dev-edge-vision",
    vision,
    vectorDb: db,
  });
  assert.equal(bindings.vision, vision);
  assert.ok(vision.maxInputBytes > 0);
  assert.ok(!JSON.stringify(bindings).includes(SECRET));
  await vision.unload();
});

test("happy path: offline edge vision proof green (network denied)", async () => {
  const events = [];
  const proof = await proveOfflineEdgeVisionBinding({
    fixtureId: "valid-schema-answer",
    vlmOptions: { maxInputBytes: 64 },
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proof.ok, true, JSON.stringify(proof.failures));
  assert.equal(proof.visionBound, true);
  assert.ok(proof.analyzeAnswerChars > 0);
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

test("edge: oversize fixture still typed-rejects under edge binding", async () => {
  const vision = await loadLocalVlm({
    subjectId: "subj.edge.vision.over",
    deviceId: "dev-edge-vision",
    maxInputBytes: 64,
  });
  const fixture = loadCk06Fixture("image-over-limit");
  assert.ok(fixture.byteLength > fixture.maxInputBytes);
  const before = vision.processedCount();
  await assert.rejects(
    () =>
      vision.analyze({
        input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
        instruction: fixture.instruction,
      }),
    (err) => err?.name === "VisionInputTooLargeError",
  );
  assert.equal(vision.processedCount(), before);
  const db = new LocalVectorDb(createLocalVectorMemoryDriver());
  await db.initialize();
  const { bindings } = createEdgeBindingsWithVision({
    subjectId: "subj.edge.vision.over",
    deviceId: "dev-edge-vision",
    vision,
    vectorDb: db,
  });
  assert.equal(bindings.vision, vision);
  await vision.unload();
});

test("sovereignty: text-only bindings omit vision; injected stays subject-scoped", async () => {
  const a = await loadLocalVlm({
    subjectId: "subj.edge.vision.a",
    deviceId: "dev-a",
  });
  const b = await loadLocalVlm({
    subjectId: "subj.edge.vision.b",
    deviceId: "dev-b",
  });
  const dbA = new LocalVectorDb(createLocalVectorMemoryDriver());
  const dbB = new LocalVectorDb(createLocalVectorMemoryDriver());
  await Promise.all([dbA.initialize(), dbB.initialize()]);
  const bundleA = createEdgeBindingsWithVision({
    subjectId: "subj.edge.vision.a",
    deviceId: "dev-a",
    vision: a,
    vectorDb: dbA,
  });
  const bundleB = createEdgeBindingsWithVision({
    subjectId: "subj.edge.vision.b",
    deviceId: "dev-b",
    vision: b,
    vectorDb: dbB,
  });
  assert.equal(bundleA.bindings.vision, a);
  assert.equal(bundleB.bindings.vision, b);
  assert.notEqual(bundleA.bindings.vision, bundleB.bindings.vision);
  await Promise.all([a.unload(), b.unload()]);
});

