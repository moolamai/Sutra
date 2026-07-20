/**
 * Kind-aware decay + correction pinning / recall ordering.
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
  EPISODIC_HALF_LIFE_MS,
  LocalVectorDb,
  compareScoredMemories,
  createLocalVectorMemoryAdapter,
  createLocalVectorMemoryDriver,
  createLocalVectorMemoryHarnessFactory,
  kindAwareDecayFactor,
  memoryKindPinRank,
  pinCorrectionsInWorkingSet,
} from "../dist/index.js";

const SECRET = "SECRET_DECAY_PIN_MUST_NOT_LEAK";

function clusteredEmbed(text, dim = 8) {
  const out = new Float32Array(dim);
  let h = 0;
  for (let i = 0; i < Math.min(text.length, 96); i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < dim; i++) out[i] = ((h + i * 17) % 1000) / 1000;
  // Cluster probe.decay.* for equal-relevance ordering asserts.
  if (text.includes("probe.decay") || text.includes("pin.")) {
    out[0] = 0.92;
    out[1] = 0.88;
    out[2] = 0.5;
  }
  return out;
}

test("happy path: kindAwareDecayFactor — correction pinned, episodic decays", () => {
  const t0 = 1_700_000_000_000;
  const createdAt = new Date(t0).toISOString();
  assert.equal(
    kindAwareDecayFactor("correction", createdAt, t0 + 2 * EPISODIC_HALF_LIFE_MS),
    1,
  );
  assert.equal(
    kindAwareDecayFactor("semantic", createdAt, t0 + 2 * EPISODIC_HALF_LIFE_MS),
    1,
  );
  const epi = kindAwareDecayFactor(
    "episodic",
    createdAt,
    t0 + 2 * EPISODIC_HALF_LIFE_MS,
  );
  assert.ok(epi < 0.5 && epi > 0);
  assert.ok(memoryKindPinRank("correction") < memoryKindPinRank("episodic"));
});

test("happy path: aged correction outranks equal-relevance episodic on recall", async () => {
  const events = [];
  const factory = createLocalVectorMemoryHarnessFactory({
    deviceId: "dev-pin",
    emit: (e) => events.push(e),
  });
  const harness = factory();
  const t0 = harness.nowMs();
  const createdAt = new Date(t0).toISOString();

  const corr = await harness.memory.remember({
    subjectId: "subj-pin",
    topicId: "topic.pin",
    text: "probe.decay.correction",
    kind: "correction",
    createdAt,
  });
  const epi = await harness.memory.remember({
    subjectId: "subj-pin",
    topicId: "topic.pin",
    text: "probe.decay.episodic",
    kind: "episodic",
    createdAt,
  });

  harness.setNowMs(t0 + 2 * EPISODIC_HALF_LIFE_MS);
  const hits = await harness.memory.recall({
    subjectId: "subj-pin",
    query: "probe.decay",
    topicId: "topic.pin",
    limit: 8,
  });

  const corrHit = hits.find((h) => h.item.id === corr.id);
  const epiHit = hits.find((h) => h.item.id === epi.id);
  assert.ok(corrHit && epiHit, "both kinds must remain retrievable");
  assert.ok(
    corrHit.score > epiHit.score,
    `correction (${corrHit.score}) must outrank aged episodic (${epiHit.score})`,
  );
  assert.ok(
    hits.findIndex((h) => h.item.id === corr.id) <
      hits.findIndex((h) => h.item.id === epi.id),
  );
  assert.ok(
    events.some(
      (e) =>
        e.op === "recall" &&
        e.outcome === "ok" &&
        e.correctionCount >= 1 &&
        e.subjectId === "subj-pin",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_|probe\.decay/);
});

test("happy path: pinCorrectionsInWorkingSet never drops corrections under cap", () => {
  const rows = [
    { kind: "episodic", created_at: "2020-01-01T00:00:00.000Z", id: "e1" },
    { kind: "correction", created_at: "2019-01-01T00:00:00.000Z", id: "c1" },
    { kind: "episodic", created_at: "2021-01-01T00:00:00.000Z", id: "e2" },
    { kind: "correction", created_at: "2018-01-01T00:00:00.000Z", id: "c2" },
    { kind: "episodic", created_at: "2022-01-01T00:00:00.000Z", id: "e3" },
  ];
  const pinned = pinCorrectionsInWorkingSet(rows, 3);
  assert.equal(pinned.filter((r) => r.kind === "correction").length, 2);
  assert.ok(pinned.some((r) => r.id === "c1"));
  assert.ok(pinned.some((r) => r.id === "c2"));
  assert.equal(pinned.length, 3);
});

test("happy path: score ties break toward correction pin rank", () => {
  const a = {
    record: { kind: "episodic" },
    score: 0.5,
  };
  const b = {
    record: { kind: "correction" },
    score: 0.5,
  };
  assert.ok(compareScoredMemories(b, a) < 0);
  assert.ok(compareScoredMemories(a, b) > 0);
});

test("happy path: CK-02 registry still green after pinning hardening", async () => {
  const report = await runConformance({
    registry: createMemoryObligationsRegistry(),
    factory: createLocalVectorMemoryHarnessFactory({
      deviceId: "dev-ck02-pin",
    }),
    subjectId: "subj-ck02-pin",
    deviceId: "dev-ck02-pin",
  });
  assert.equal(report.exitCode, 0, JSON.stringify(report.verdicts, null, 2));
  assert.equal(report.passed, 3);
  assert.ok(
    report.verdicts.some(
      (v) => v.obligationId === MEMORY_OBLIGATION_IDS.decay,
    ),
  );
});

test("edge: empty recall stays []; sovereignty keeps decay scores isolated", async () => {
  let now = 1_700_000_000_000;
  const driver = createLocalVectorMemoryDriver();
  const db = new LocalVectorDb(driver, {
    maxResidentVectors: 4,
    episodicHalfLifeDays: 30,
    nowMs: () => now,
  });
  await db.initialize();
  const memory = createLocalVectorMemoryAdapter(db, {
    embed: async (t) => clusteredEmbed(t),
    nowMs: () => now,
  });

  assert.deepEqual(
    await memory.recall({ subjectId: "subj-none", query: "x" }),
    [],
  );

  const createdAt = new Date(now).toISOString();
  await memory.remember({
    subjectId: "subj-a",
    topicId: "t",
    text: `${SECRET} pin.correction`,
    kind: "correction",
    createdAt,
  });
  // Flood with episodics that would crowd out correction under a naïve LIMIT.
  for (let i = 0; i < 6; i++) {
    await memory.remember({
      subjectId: "subj-a",
      topicId: "t",
      text: `pin.episodic.${i}`,
      kind: "episodic",
      createdAt: new Date(now + i).toISOString(),
    });
  }
  await memory.remember({
    subjectId: "subj-b",
    topicId: "t",
    text: "pin.other-subject",
    kind: "episodic",
    createdAt,
  });

  now += 2 * EPISODIC_HALF_LIFE_MS;
  const a = await memory.recall({
    subjectId: "subj-a",
    query: "pin.",
    topicId: "t",
    limit: 8,
  });
  const b = await memory.recall({
    subjectId: "subj-b",
    query: "pin.",
    topicId: "t",
    limit: 8,
  });

  assert.ok(a.some((h) => h.item.kind === "correction"));
  assert.ok(a.every((h) => h.item.subjectId === "subj-a"));
  assert.ok(b.every((h) => h.item.subjectId === "subj-b"));
  assert.ok(!b.some((h) => h.item.text.includes("SECRET")));
});

test("edge: concurrent remember does not lose corrections under pin policy", async () => {
  const harness = createLocalVectorMemoryHarnessFactory()();
  const t0 = harness.nowMs();
  const createdAt = new Date(t0).toISOString();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.memory.remember({
        subjectId: "subj-conc-pin",
        topicId: "t",
        text: i % 2 === 0 ? `probe.decay.correction.${i}` : `probe.decay.episodic.${i}`,
        kind: i % 2 === 0 ? "correction" : "episodic",
        createdAt,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.kind === "correction").length, 4);
  harness.setNowMs(t0 + 3 * EPISODIC_HALF_LIFE_MS);
  const hits = await harness.memory.recall({
    subjectId: "subj-conc-pin",
    query: "probe.decay",
    topicId: "t",
    limit: 16,
  });
  const corrections = hits.filter((h) => h.item.kind === "correction");
  const episodics = hits.filter((h) => h.item.kind === "episodic");
  assert.equal(corrections.length, 4, "no lost corrections");
  if (episodics.length > 0) {
    const minCorr = Math.min(...corrections.map((h) => h.score));
    const maxEpi = Math.max(...episodics.map((h) => h.score));
    assert.ok(minCorr > maxEpi);
  }
});
