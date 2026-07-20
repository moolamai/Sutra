/**
 * MemoryInterface over LocalVectorDb.
 * Run: pnpm --filter @moolam/edge-agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_OBLIGATION_IDS,
  createMemoryObligationsRegistry,
  runConformance,
} from "@moolam/contract-conformance";
import {
  EDGE_MEMORY_OBLIGATION_EMBED_DIM,
  EDGE_MEMORY_OBLIGATION_SUBJECT,
  LocalVectorDb,
  LocalVectorMemoryError,
  createLocalVectorMemoryAdapter,
  createLocalVectorMemoryDriver,
  createLocalVectorMemoryHarnessFactory,
} from "../dist/index.js";

const SECRET = "SECRET_MEMOADAP_MUST_NOT_LEAK";
const EPISODIC_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

function hashEmbed(text, dim = 8) {
  const out = new Float32Array(dim);
  let h = 0;
  for (let i = 0; i < Math.min(text.length, 96); i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < dim; i++) out[i] = ((h + i * 17) % 1000) / 1000;
  if (text.includes("probe") || text.includes("hash")) {
    out[0] = 0.9;
    out[1] = 0.85;
  }
  return out;
}

test("happy path: remember / recall maps topicId↔conceptId and kinds", async () => {
  const events = [];
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver, { nowMs: () => Date.now() });
  await db.initialize();
  const memory = createLocalVectorMemoryAdapter(db, {
    deviceId: "dev-mem",
    embed: async (t) => hashEmbed(t),
    emit: (e) => events.push(e),
  });

  const stored = await memory.remember({
    subjectId: "subj-a",
    topicId: "math.ratios",
    text: "confused ratio with fraction",
    kind: "correction",
    createdAt: new Date().toISOString(),
  });
  assert.ok(stored.id);
  assert.equal(stored.kind, "correction");
  assert.equal(stored.topicId, "math.ratios");

  const semantic = await memory.remember({
    subjectId: "subj-a",
    topicId: "math.ratios",
    text: "ratios compare two quantities",
    kind: "semantic",
    createdAt: new Date().toISOString(),
  });
  assert.equal(semantic.kind, "semantic");

  const hits = await memory.recall({
    subjectId: "subj-a",
    query: "ratio fraction",
    topicId: "math.ratios",
    limit: 8,
  });
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.item.subjectId === "subj-a"));
  assert.ok(hits.some((h) => h.item.kind === "correction"));
  assert.ok(hits.some((h) => h.item.kind === "semantic"));
  assert.ok(
    events.some(
      (e) =>
        e.event === "edge_agent.local_vector_memory" &&
        e.op === "remember" &&
        e.outcome === "ok" &&
        e.subjectId === "subj-a",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_|confused/);
});

test("happy path: CK-02 full registry passes against LocalVectorDb adapter", async () => {
  const events = [];
  const report = await runConformance({
    registry: createMemoryObligationsRegistry(),
    factory: createLocalVectorMemoryHarnessFactory({
      deviceId: "dev-ck02",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-ck02-edge",
    deviceId: "dev-ck02",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts, null, 2));
  assert.equal(report.passed, 3);
  assert.deepEqual(
    report.verdicts.map((v) => v.obligationId).sort(),
    [
      MEMORY_OBLIGATION_IDS.concurrentSubjects,
      MEMORY_OBLIGATION_IDS.decay,
      MEMORY_OBLIGATION_IDS.durability,
    ].sort(),
  );
});

test("edge: empty recall returns [] (not error)", async () => {
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const memory = createLocalVectorMemoryAdapter(db, {
    embed: async (t) => hashEmbed(t),
  });
  const hits = await memory.recall({
    subjectId: "subj-empty",
    query: "nothing here",
    limit: 4,
  });
  assert.deepEqual(hits, []);
});

test("edge: forget removes item; concurrent remember preserves corrections", async () => {
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const memory = createLocalVectorMemoryAdapter(db, {
    embed: async (t) => hashEmbed(t),
  });

  const [a, b] = await Promise.all([
    memory.remember({
      subjectId: "subj-conc",
      topicId: "t1",
      text: "correction-a",
      kind: "correction",
      createdAt: "2020-01-01T00:00:00.000Z",
    }),
    memory.remember({
      subjectId: "subj-conc",
      topicId: "t1",
      text: "correction-b",
      kind: "correction",
      createdAt: "2020-01-02T00:00:00.000Z",
    }),
  ]);
  assert.notEqual(a.id, b.id);

  await memory.forget(a.id);
  const hits = await memory.recall({
    subjectId: "subj-conc",
    query: "correction",
    topicId: "t1",
    limit: 8,
  });
  assert.ok(!hits.some((h) => h.item.id === a.id));
  assert.ok(hits.some((h) => h.item.id === b.id));
});

test("edge: embedding dimension mismatch is a hard error on remember/recall", async () => {
  let dim = 8;
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const memory = createLocalVectorMemoryAdapter(db, {
    embed: async (t) => hashEmbed(t, dim),
  });
  await memory.remember({
    subjectId: "subj-dim",
    topicId: "t",
    text: "seed",
    kind: "episodic",
    createdAt: new Date().toISOString(),
  });
  dim = 4;
  await assert.rejects(
    () =>
      memory.remember({
        subjectId: "subj-dim",
        topicId: "t",
        text: "other",
        kind: "episodic",
        createdAt: new Date().toISOString(),
      }),
    (err) =>
      err instanceof LocalVectorMemoryError &&
      err.obligationId === EDGE_MEMORY_OBLIGATION_EMBED_DIM,
  );
});

test("sovereignty: subjects never see each other's memories", async () => {
  const events = [];
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver);
  await db.initialize();
  const memory = createLocalVectorMemoryAdapter(db, {
    embed: async (t) => hashEmbed(t),
    emit: (e) => events.push(e),
  });
  await memory.remember({
    subjectId: "subj-a",
    topicId: "shared-topic",
    text: SECRET,
    kind: "episodic",
    createdAt: new Date().toISOString(),
  });
  await memory.remember({
    subjectId: "subj-b",
    topicId: "shared-topic",
    text: "other",
    kind: "episodic",
    createdAt: new Date().toISOString(),
  });
  const a = await memory.recall({
    subjectId: "subj-a",
    query: "hash",
    topicId: "shared-topic",
  });
  const b = await memory.recall({
    subjectId: "subj-b",
    query: "hash",
    topicId: "shared-topic",
  });
  assert.ok(a.every((h) => h.item.subjectId === "subj-a"));
  assert.ok(b.every((h) => h.item.subjectId === "subj-b"));
  assert.ok(!b.some((h) => h.item.text.includes("SECRET")));
  await assert.rejects(
    () =>
      memory.remember({
        subjectId: "  ",
        topicId: "t",
        text: "x",
        kind: "episodic",
        createdAt: new Date().toISOString(),
      }),
    (err) =>
      err instanceof LocalVectorMemoryError &&
      err.obligationId === EDGE_MEMORY_OBLIGATION_SUBJECT,
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_MEMOADAP/);
});

test("edge: durable remember survives reinstantiate; decay clock ages episodic", async () => {
  const factory = createLocalVectorMemoryHarnessFactory({
    deviceId: "dev-dur",
  });
  const harness = factory();
  const t0 = harness.nowMs();
  const createdAt = new Date(t0).toISOString();
  const stored = await harness.memory.remember({
    subjectId: "subj-dur",
    topicId: "topic.d",
    text: "probe.durable.token",
    kind: "episodic",
    createdAt,
  });
  const reopened = await harness.reinstantiate();
  const hits = await reopened.recall({
    subjectId: "subj-dur",
    query: "probe.durable.token",
    topicId: "topic.d",
  });
  assert.ok(hits.some((h) => h.item.id === stored.id));

  const corr = await harness.memory.remember({
    subjectId: "subj-dur",
    topicId: "topic.d",
    text: "probe.decay.correction",
    kind: "correction",
    createdAt,
  });
  const epi = await harness.memory.remember({
    subjectId: "subj-dur",
    topicId: "topic.d",
    text: "probe.decay.episodic",
    kind: "episodic",
    createdAt,
  });
  const before = await harness.memory.recall({
    subjectId: "subj-dur",
    query: "probe.decay",
    topicId: "topic.d",
  });
  const corrB = before.find((h) => h.item.id === corr.id);
  const epiB = before.find((h) => h.item.id === epi.id);
  assert.ok(corrB && epiB);
  harness.setNowMs(t0 + 2 * EPISODIC_HALF_LIFE_MS);
  const after = await harness.memory.recall({
    subjectId: "subj-dur",
    query: "probe.decay",
    topicId: "topic.d",
  });
  const corrA = after.find((h) => h.item.id === corr.id);
  const epiA = after.find((h) => h.item.id === epi.id);
  assert.ok(corrA && epiA);
  assert.ok(corrA.score + 1e-9 >= corrB.score);
  assert.ok(epiA.score < epiB.score - 1e-9);
});
