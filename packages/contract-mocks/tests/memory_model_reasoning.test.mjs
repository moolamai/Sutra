/**
 * Memory / model / reasoning reference mocks.
 *
 * Happy path: CK-02, CK-03, CK-04 conformance registries pass against the mocks.
 * Edge: durable reinstantiate; subject isolation; delta stream concat; concurrent remember.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryObligationsRegistry,
  createModelObligationsRegistry,
  createReasoningObligationsRegistry,
  runConformance,
} from "@moolam/contract-conformance";
import {
  createMemoryDurableStore,
  createMemoryMock,
  createMemoryMockHarnessFactory,
  createModelMock,
  createModelMockHarnessFactory,
  createReasoningMock,
  createReasoningMockHarnessFactory,
  EPISODIC_HALF_LIFE_MS,
  kindAwareDecayFactor,
} from "../dist/index.js";

test("happy path: memory mock passes full CK-02 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createMemoryObligationsRegistry(),
    factory: createMemoryMockHarnessFactory({
      deviceId: "dev-mock-mem",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-mem",
    deviceId: "dev-mock-mem",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 3);
  assert.ok(events.some((e) => e.event === "contract_mocks.memory" && e.outcome === "ok"));
});

test("happy path: model mock passes full CK-03 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createModelObligationsRegistry(),
    factory: createModelMockHarnessFactory({
      deviceId: "dev-mock-model",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-model",
    deviceId: "dev-mock-model",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 3);
  assert.ok(events.some((e) => e.event === "contract_mocks.model" && e.outcome === "ok"));
});

test("happy path: reasoning mock passes full CK-04 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createReasoningObligationsRegistry(),
    factory: createReasoningMockHarnessFactory({
      deviceId: "dev-mock-reason",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-reason",
    deviceId: "dev-mock-reason",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
  assert.ok(
    events.some(
      (e) =>
        e.event === "contract_mocks.reasoning" &&
        e.outcome === "ok" &&
        e.stepCount >= 1,
    ),
  );
});

test("edge: remember is durable across reinstantiate before resolve returns", async () => {
  const store = createMemoryDurableStore();
  const mem = createMemoryMock({ store, deviceId: "dev-dur" });
  const saved = await mem.remember({
    subjectId: "subj-a",
    topicId: "t1",
    text: "probe.durable.token",
    kind: "episodic",
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  assert.ok(store.rows.has(saved.id), "store updated before await completes");
  const reopened = createMemoryMock({ store, deviceId: "dev-dur-reopen" });
  const hits = await reopened.recall({
    subjectId: "subj-a",
    query: "probe.durable.token",
    limit: 8,
  });
  assert.ok(hits.some((h) => h.item.id === saved.id));
});

test("edge: concurrent subjects never observe each other's entries", async () => {
  const mem = createMemoryMock({ deviceId: "dev-iso" });
  await Promise.all([
    mem.remember({
      subjectId: "subj-a",
      topicId: "t",
      text: "probe.a",
      kind: "preference",
      createdAt: "2026-07-15T00:00:00.000Z",
    }),
    mem.remember({
      subjectId: "subj-b",
      topicId: "t",
      text: "probe.b",
      kind: "preference",
      createdAt: "2026-07-15T00:00:00.000Z",
    }),
  ]);
  const a = await mem.recall({ subjectId: "subj-a", query: "probe", limit: 16 });
  const b = await mem.recall({ subjectId: "subj-b", query: "probe", limit: 16 });
  assert.ok(a.every((h) => h.item.subjectId === "subj-a"));
  assert.ok(b.every((h) => h.item.subjectId === "subj-b"));
  assert.equal(a.some((h) => h.item.text.includes(".b")), false);
  assert.equal(b.some((h) => h.item.text.includes(".a")), false);
});

test("edge: generateStream deltas concatenate to generate() text", async () => {
  const model = createModelMock({ deviceId: "dev-stream" });
  const messages = [{ role: "user", content: "probe.stream.token" }];
  const final = await model.generate(messages);
  const chunks = [];
  for await (const c of model.generateStream(messages)) chunks.push(c);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(""), final.text);
  assert.equal(model.descriptor.locality, "on-device");
  const e1 = await model.embed("probe.embed.a");
  const e2 = await model.embed("probe.embed.b");
  assert.equal(e1.length, e2.length);
});

test("edge: concurrent same-subject remembers are serialized and idempotent on replay read", async () => {
  const mem = createMemoryMock({ deviceId: "dev-race" });
  const createdAt = "2026-07-15T00:00:00.000Z";
  const [x, y] = await Promise.all([
    mem.remember({
      subjectId: "subj-race",
      topicId: "t",
      text: "probe.race.1",
      kind: "episodic",
      createdAt,
    }),
    mem.remember({
      subjectId: "subj-race",
      topicId: "t",
      text: "probe.race.2",
      kind: "episodic",
      createdAt,
    }),
  ]);
  assert.notEqual(x.id, y.id);
  const hits = await mem.recall({
    subjectId: "subj-race",
    query: "probe.race",
    limit: 16,
  });
  assert.equal(hits.length, 2);
  // Replay recall is idempotent (same item set).
  const again = await mem.recall({
    subjectId: "subj-race",
    query: "probe.race",
    limit: 16,
  });
  assert.deepEqual(
    again.map((h) => h.item.id).sort(),
    hits.map((h) => h.item.id).sort(),
  );
});

test("edge: kind-aware decay — corrections hold; episodics age", () => {
  const t0 = 1_700_000_000_000;
  const createdAt = new Date(t0).toISOString();
  assert.equal(kindAwareDecayFactor("correction", createdAt, t0), 1);
  assert.equal(kindAwareDecayFactor("episodic", createdAt, t0), 1);
  const later = t0 + 2 * EPISODIC_HALF_LIFE_MS;
  assert.equal(kindAwareDecayFactor("correction", createdAt, later), 1);
  assert.ok(kindAwareDecayFactor("episodic", createdAt, later) < 0.5);
});

test("edge: reasoning surfaces constraints and never returns empty steps", async () => {
  const reasoning = createReasoningMock({ deviceId: "dev-r" });
  const out = await reasoning.deliberate({
    proposition: "probe.prop",
    evidence: [],
    constraints: ["probe.constraint.a", "probe.constraint.b"],
  });
  assert.ok(out.steps.length >= 2);
  assert.deepEqual(out.unresolvedConstraints, [
    "probe.constraint.a",
    "probe.constraint.b",
  ]);
  assert.ok(out.steps.every((s) => s.statement.trim().length > 3));
});
