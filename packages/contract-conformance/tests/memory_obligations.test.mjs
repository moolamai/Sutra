/**
 * Memory obligations + named violation fixtures .
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  EPISODIC_HALF_LIFE_MS,
  MEMORY_OBLIGATION_IDS,
  MEMORY_VIOLATION_FIXTURES,
  MUST_CONCURRENT_SUBJECTS,
  MUST_KIND_AWARE_DECAY,
  MUST_REMEMBER_DURABLE,
  createAsyncWriteAfterResolveMemoryHarnessFactory,
  createDurableMemoryHarnessFactory,
  createLeakySubjectMemoryHarnessFactory,
  createMemoryDecayObligationRegistry,
  createMemoryDurabilityIsolationRegistry,
  createMemoryObligationsRegistry,
  createNoDecayMemoryHarnessFactory,
  createUniformDecayMemoryHarnessFactory,
  createVolatileMemoryHarnessFactory,
  kindAwareDecayFactor,
  listMemoryViolationFixtures,
  runConformance,
} from "../dist/index.js";

test("happy path: durable reference mock passes CK-02.1 and CK-02.3", async () => {
  const events = [];
  const report = await runConformance({
    registry: createMemoryDurabilityIsolationRegistry(),
    factory: createDurableMemoryHarnessFactory(),
    subjectId: "subj-memory-good",
    deviceId: "dev-mem",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
  assert.deepEqual(
    report.verdicts.map((v) => v.obligationId).sort(),
    [MEMORY_OBLIGATION_IDS.durability, MEMORY_OBLIGATION_IDS.concurrentSubjects].sort(),
  );
  assert.ok(events.some((e) => e.event === "conformance.runner" && e.outcome === "pass"));
});

test("happy path: kind-aware reference mock passes CK-02.2 decay", async () => {
  const events = [];
  const report = await runConformance({
    registry: createMemoryDecayObligationRegistry(),
    factory: createDurableMemoryHarnessFactory(),
    subjectId: "subj-decay-good",
    deviceId: "dev-decay",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(report.verdicts[0].obligationId, MEMORY_OBLIGATION_IDS.decay);
  assert.equal(report.verdicts[0].mustText, MUST_KIND_AWARE_DECAY);
  assert.ok(events.some((e) => e.outcome === "pass" && e.obligationId === "CK-02.2"));
});

test("happy path: full memory registry passes CK-02.1/2/3", async () => {
  const report = await runConformance({
    registry: createMemoryObligationsRegistry(),
    factory: createDurableMemoryHarnessFactory(),
    subjectId: "subj-memory-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 3);
});

test("violation: volatile store fails CK-02.1 with durable MUST text", async () => {
  const report = await runConformance({
    registry: createMemoryDurabilityIsolationRegistry(),
    factory: createVolatileMemoryHarnessFactory(),
    subjectId: "subj-volatile",
    obligationIds: [MEMORY_OBLIGATION_IDS.durability],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(report.verdicts[0].obligationId, MEMORY_OBLIGATION_IDS.durability);
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.equal(report.verdicts[0].mustText, MUST_REMEMBER_DURABLE);
  assert.equal(report.verdicts[0].attribution, "implementation");
});

test("violation: leaky subject store fails CK-02.3 exactly", async () => {
  const report = await runConformance({
    registry: createMemoryDurabilityIsolationRegistry(),
    factory: createLeakySubjectMemoryHarnessFactory(),
    subjectId: "subj-leak",
    obligationIds: [MEMORY_OBLIGATION_IDS.concurrentSubjects],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].obligationId, MEMORY_OBLIGATION_IDS.concurrentSubjects);
  assert.equal(report.verdicts[0].mustText, MUST_CONCURRENT_SUBJECTS);
  assert.equal(report.verdicts[0].outcome, "fail");
});

test("violation: uniform decay fails CK-02.2 (corrections must not decay)", async () => {
  const report = await runConformance({
    registry: createMemoryDecayObligationRegistry(),
    factory: createUniformDecayMemoryHarnessFactory(),
    subjectId: "subj-uniform-decay",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].obligationId, MEMORY_OBLIGATION_IDS.decay);
  assert.equal(report.verdicts[0].mustText, MUST_KIND_AWARE_DECAY);
  assert.equal(report.verdicts[0].outcome, "fail");
});

test("violation: no-decay store fails CK-02.2 ordering after aging", async () => {
  const report = await runConformance({
    registry: createMemoryDecayObligationRegistry(),
    factory: createNoDecayMemoryHarnessFactory(),
    subjectId: "subj-no-decay",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].obligationId, MEMORY_OBLIGATION_IDS.decay);
  assert.match(report.verdicts[0].message ?? "", /episodic score did not decay|must outrank/i);
});

test("edge: durable mock still passes isolation when only CK-02.3 selected", async () => {
  const report = await runConformance({
    registry: createMemoryDurabilityIsolationRegistry(),
    factory: createDurableMemoryHarnessFactory(),
    subjectId: "subj-iso-only",
    obligationIds: [MEMORY_OBLIGATION_IDS.concurrentSubjects],
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts[0].obligationId, MEMORY_OBLIGATION_IDS.concurrentSubjects);
});

test("edge: obligations are independent — volatile fails durability only", async () => {
  const report = await runConformance({
    registry: createMemoryDurabilityIsolationRegistry(),
    factory: createVolatileMemoryHarnessFactory(),
    subjectId: "subj-partial",
  });
  assert.equal(report.exitCode, 1);
  const byId = Object.fromEntries(
    report.verdicts.map((v) => [v.obligationId, v.outcome]),
  );
  assert.equal(byId[MEMORY_OBLIGATION_IDS.durability], "fail");
  assert.equal(byId[MEMORY_OBLIGATION_IDS.concurrentSubjects], "pass");
});

test("edge: uniform-decay still passes durability when selected alone", async () => {
  const report = await runConformance({
    registry: createMemoryObligationsRegistry(),
    factory: createUniformDecayMemoryHarnessFactory(),
    subjectId: "subj-uniform-partial",
    obligationIds: [MEMORY_OBLIGATION_IDS.durability],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: replay of decay-obligation run is idempotent on exit code", async () => {
  const opts = {
    registry: createMemoryDecayObligationRegistry(),
    factory: createDurableMemoryHarnessFactory(),
    subjectId: "subj-replay-decay",
  };
  const a = await runConformance(opts);
  const b = await runConformance(opts);
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, a.exitCode);
});

test("edge: kindAwareDecayFactor keeps correction at 1 across half-lives", () => {
  const t0 = 1_700_000_000_000;
  const createdAt = new Date(t0).toISOString();
  const later = t0 + 3 * EPISODIC_HALF_LIFE_MS;
  assert.equal(kindAwareDecayFactor("correction", createdAt, later), 1);
  assert.ok(kindAwareDecayFactor("episodic", createdAt, later) < 0.2);
});

/* ── three fixtures, each fails exactly its target ── */

test("catalog: three named memory violation fixtures", () => {
  const fixtures = listMemoryViolationFixtures();
  assert.equal(fixtures.length, 3);
  assert.deepEqual(
    fixtures.map((f) => f.fixtureId).sort(),
    [
      "memory.violation.async-write-after-resolve",
      "memory.violation.decaying-corrections",
      "memory.violation.shared-subject-store",
    ].sort(),
  );
  assert.deepEqual(
    fixtures.map((f) => f.targetObligationId).sort(),
    ["CK-02.1", "CK-02.2", "CK-02.3"].sort(),
  );
});

test("violation isolation: each MEMOOBLI-003 fixture fails only its target", async () => {
  for (const fixture of listMemoryViolationFixtures()) {
    const events = [];
    const report = await runConformance({
      registry: createMemoryObligationsRegistry(),
      factory: fixture.createFactory(),
      subjectId: `subj-fixture-${fixture.fixtureId.split(".").pop()}`,
      deviceId: "dev-fix-isolation",
      emit: (e) => events.push(e),
    });
    assert.equal(report.exitCode, 1, fixture.fixtureId);
    assert.equal(report.passed, 2, fixture.fixtureId);
    assert.equal(report.failed, 1, fixture.fixtureId);
    const byId = Object.fromEntries(
      report.verdicts.map((v) => [v.obligationId, v]),
    );
    for (const id of Object.values(MEMORY_OBLIGATION_IDS)) {
      if (id === fixture.targetObligationId) {
        assert.equal(byId[id].outcome, "fail", `${fixture.fixtureId} → ${id}`);
        assert.equal(byId[id].mustText, fixture.mustText);
        assert.equal(byId[id].attribution, "implementation");
      } else {
        assert.equal(byId[id].outcome, "pass", `${fixture.fixtureId} → ${id}`);
      }
    }
    assert.ok(
      events.some(
        (e) =>
          e.event === "conformance.runner" &&
          e.outcome === "fail" &&
          e.obligationId === fixture.targetObligationId &&
          e.subjectId,
      ),
      `observability for ${fixture.fixtureId}`,
    );
  }
});

test("edge: async-write pending still visible on same-instance recall", async () => {
  const harness = createAsyncWriteAfterResolveMemoryHarnessFactory()();
  const remembered = await harness.memory.remember({
    subjectId: "subj-pending",
    topicId: "topic.pending",
    text: "probe.pending.token",
    kind: "episodic",
    createdAt: "000000001000000:000010:conformance",
  });
  const beforeCrash = await harness.memory.recall({
    subjectId: "subj-pending",
    query: "probe",
    topicId: "topic.pending",
    limit: 4,
  });
  assert.ok(
    beforeCrash.some((h) => h.item.id === remembered.id),
    "naive same-process recall must see pending (documents why reinstantiate is required)",
  );
  const afterCrash = await (await harness.reinstantiate()).recall({
    subjectId: "subj-pending",
    query: "probe",
    topicId: "topic.pending",
    limit: 4,
  });
  assert.equal(
    afterCrash.some((h) => h.item.id === remembered.id),
    false,
    "reinstantiate before deferred flush must lose the write",
  );
});

test("edge: async-write fixture scopes recall by subjectId", async () => {
  const harness = MEMORY_VIOLATION_FIXTURES.asyncWriteAfterResolve.createFactory()();
  await harness.memory.remember({
    subjectId: "subj-a",
    topicId: "topic.iso",
    text: "probe.a",
    kind: "preference",
    createdAt: "000000001000000:000011:conformance",
  });
  await harness.memory.remember({
    subjectId: "subj-b",
    topicId: "topic.iso",
    text: "probe.b",
    kind: "preference",
    createdAt: "000000001000000:000012:conformance",
  });
  const hits = await harness.memory.recall({
    subjectId: "subj-a",
    query: "probe",
    topicId: "topic.iso",
    limit: 8,
  });
  assert.ok(hits.every((h) => h.item.subjectId === "subj-a"));
  assert.equal(hits.length, 1);
});

test("edge: replay of full violation-isolation suite is idempotent", async () => {
  const fixture = MEMORY_VIOLATION_FIXTURES.decayingCorrections;
  const opts = {
    registry: createMemoryObligationsRegistry(),
    factory: fixture.createFactory(),
    subjectId: "subj-replay-fixture",
  };
  const a = await runConformance(opts);
  const b = await runConformance(opts);
  assert.equal(a.exitCode, 1);
  assert.equal(b.exitCode, a.exitCode);
  assert.equal(a.failed, b.failed);
  assert.equal(a.passed, b.passed);
});
