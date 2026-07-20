/**
 * Knowledge obligations : citations, offline, truthful asOf.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_CHECK_CLOCK_MS,
  KNOWLEDGE_OBLIGATION_IDS,
  KNOWLEDGE_VIOLATION_FIXTURES,
  MUST_ASOF_TRUTHFUL,
  MUST_BUNDLED_OFFLINE,
  MUST_CITATION_RESOLVABLE,
  buildAsOfProbeQuery,
  buildCitationProbeQuery,
  buildOfflineProbeQuery,
  createCitationPresenceObligationRegistry,
  createCitedKnowledgeHarnessFactory,
  createFutureAsOfKnowledgeHarnessFactory,
  createKnowledgeObligationsRegistry,
  createOfflineLiarKnowledgeHarnessFactory,
  createOfflineStalenessObligationRegistry,
  createUncitedKnowledgeHarnessFactory,
  createUnresolvedSourceKnowledgeHarnessFactory,
  listKnowledgeViolationFixtures,
  parseAsOfMs,
  runConformance,
} from "../dist/index.js";

test("happy path: cited reference mock passes CK-09.1", async () => {
  const events = [];
  const report = await runConformance({
    registry: createCitationPresenceObligationRegistry(),
    factory: createCitedKnowledgeHarnessFactory(),
    subjectId: "subj-knowledge-good",
    deviceId: "dev-knowledge",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    KNOWLEDGE_OBLIGATION_IDS.citationPresence,
  );
  assert.equal(report.verdicts[0].mustText, MUST_CITATION_RESOLVABLE);
  assert.ok(
    events.some(
      (e) =>
        e.event === "conformance.runner" &&
        e.outcome === "pass" &&
        e.obligationId === "CK-09.1" &&
        e.subjectId &&
        e.deviceId === "dev-knowledge",
    ),
  );
});

test("happy path: cited reference passes CK-09.2 and CK-09.3", async () => {
  const events = [];
  const report = await runConformance({
    registry: createOfflineStalenessObligationRegistry(),
    factory: createCitedKnowledgeHarnessFactory(),
    subjectId: "subj-offline-good",
    deviceId: "dev-offline",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
  assert.deepEqual(
    report.verdicts.map((v) => v.obligationId).sort(),
    [
      KNOWLEDGE_OBLIGATION_IDS.bundledOffline,
      KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf,
    ].sort(),
  );
  assert.ok(events.some((e) => e.outcome === "pass" && e.obligationId === "CK-09.2"));
  assert.ok(events.some((e) => e.outcome === "pass" && e.obligationId === "CK-09.3"));
});

test("happy path: full knowledge registry passes CK-09.1/2/3", async () => {
  const report = await runConformance({
    registry: createKnowledgeObligationsRegistry(),
    factory: createCitedKnowledgeHarnessFactory(),
    subjectId: "subj-knowledge-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 3);
});

test("violation: uncited passage fails CK-09.1 exactly", async () => {
  const report = await runConformance({
    registry: createCitationPresenceObligationRegistry(),
    factory: createUncitedKnowledgeHarnessFactory(),
    subjectId: "subj-uncited",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    KNOWLEDGE_OBLIGATION_IDS.citationPresence,
  );
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.equal(report.verdicts[0].mustText, MUST_CITATION_RESOLVABLE);
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /empty citation/i);
});

test("violation: unresolved sourceId fails CK-09.1", async () => {
  const report = await runConformance({
    registry: createCitationPresenceObligationRegistry(),
    factory: createUnresolvedSourceKnowledgeHarnessFactory(),
    subjectId: "subj-unresolved-source",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    KNOWLEDGE_OBLIGATION_IDS.citationPresence,
  );
  assert.match(report.verdicts[0].message ?? "", /does not resolve|describe/i);
});

test("violation: offline-liar fails CK-09.2 exactly", async () => {
  const report = await runConformance({
    registry: createOfflineStalenessObligationRegistry(),
    factory: createOfflineLiarKnowledgeHarnessFactory(),
    subjectId: "subj-offline-liar",
    obligationIds: [KNOWLEDGE_OBLIGATION_IDS.bundledOffline],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    KNOWLEDGE_OBLIGATION_IDS.bundledOffline,
  );
  assert.equal(report.verdicts[0].mustText, MUST_BUNDLED_OFFLINE);
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /network was denied|no passages/i);
});

test("violation: future asOf fails CK-09.3 exactly", async () => {
  const report = await runConformance({
    registry: createOfflineStalenessObligationRegistry(),
    factory: createFutureAsOfKnowledgeHarnessFactory(),
    subjectId: "subj-future-asof",
    obligationIds: [KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf,
  );
  assert.equal(report.verdicts[0].mustText, MUST_ASOF_TRUTHFUL);
  assert.match(report.verdicts[0].message ?? "", /postdates|untruthful/i);
});

test("edge: citation / offline / asOf probes are subject-scoped metadata", () => {
  const ctx = {
    subjectId: "subj-a::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  assert.match(buildCitationProbeQuery(ctx).query, /subj-a\.peer/);
  assert.match(buildOfflineProbeQuery(ctx).query, /subj-a\.peer/);
  assert.match(buildAsOfProbeQuery(ctx).query, /subj-a\.peer/);
  assert.doesNotMatch(buildOfflineProbeQuery(ctx).query, /password|ssn/i);
});

test("edge: independent factory runs share no mutable state", async () => {
  const factory = createCitedKnowledgeHarnessFactory();
  const a = factory();
  const b = factory();
  a.setNetworkAllowed(false);
  b.setNetworkAllowed(true);
  assert.equal(a.isNetworkAllowed(), false);
  assert.equal(b.isNetworkAllowed(), true);
  const [ra, rb] = await Promise.all([
    a.knowledge.retrieve({ query: "probe.a", limit: 2 }),
    b.knowledge.retrieve({ query: "probe.b", limit: 2 }),
  ]);
  assert.ok(ra.length > 0);
  assert.ok(rb.length > 0);
  assert.notEqual(a, b);
});

test("edge: concurrent offline retrieve still answers under network deny", async () => {
  const harness = createCitedKnowledgeHarnessFactory()();
  harness.setNetworkAllowed(false);
  const batches = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.knowledge.retrieve({ query: `probe.concurrent.${i}`, limit: 2 }),
    ),
  );
  assert.ok(batches.every((p) => p.length > 0));
});

test("edge: offline-liar still passes CK-09.3 when selected alone", async () => {
  const report = await runConformance({
    registry: createKnowledgeObligationsRegistry(),
    factory: createOfflineLiarKnowledgeHarnessFactory(),
    subjectId: "subj-liar-partial",
    obligationIds: [KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: replay of CK-09.2 violation is idempotent", async () => {
  const opts = {
    registry: createOfflineStalenessObligationRegistry(),
    factory: createOfflineLiarKnowledgeHarnessFactory(),
    subjectId: "subj-replay-offline",
    obligationIds: [KNOWLEDGE_OBLIGATION_IDS.bundledOffline],
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, first.exitCode);
  assert.equal(second.failed, first.failed);
});

test("edge: parseAsOfMs and check clock boundary", () => {
  assert.ok(parseAsOfMs("2024-06-01") < KNOWLEDGE_CHECK_CLOCK_MS);
  assert.ok(parseAsOfMs("2099-01-01") > KNOWLEDGE_CHECK_CLOCK_MS);
});

/* ── two fixtures, each fails exactly its target ── */

test("catalog: two named knowledge violation fixtures", () => {
  const fixtures = listKnowledgeViolationFixtures();
  assert.equal(fixtures.length, 2);
  assert.deepEqual(
    fixtures.map((f) => f.fixtureId).sort(),
    [
      "knowledge.violation.offline-liar",
      "knowledge.violation.uncited-passage",
    ].sort(),
  );
  assert.deepEqual(
    fixtures.map((f) => f.targetObligationId).sort(),
    ["CK-09.1", "CK-09.2"].sort(),
  );
});

test("violation isolation: each KNOWOBLI-003 fixture fails only its target", async () => {
  for (const fixture of listKnowledgeViolationFixtures()) {
    const events = [];
    const report = await runConformance({
      registry: createKnowledgeObligationsRegistry(),
      factory: fixture.createFactory(),
      subjectId: `subj-fixture-${fixture.fixtureId.split(".").pop()}`,
      deviceId: "dev-know-isolation",
      emit: (e) => events.push(e),
    });
    assert.equal(report.exitCode, 1, fixture.fixtureId);
    assert.equal(report.passed, 2, fixture.fixtureId);
    assert.equal(report.failed, 1, fixture.fixtureId);
    const byId = Object.fromEntries(
      report.verdicts.map((v) => [v.obligationId, v]),
    );
    for (const id of Object.values(KNOWLEDGE_OBLIGATION_IDS)) {
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
          e.subjectId &&
          e.deviceId === "dev-know-isolation",
      ),
      `observability for ${fixture.fixtureId}`,
    );
  }
});

test("edge: uncited fixture still answers under network deny", async () => {
  const harness = KNOWLEDGE_VIOLATION_FIXTURES.uncitedPassage.createFactory()();
  harness.setNetworkAllowed(false);
  const hits = await harness.knowledge.retrieve({
    query: "probe.offline.uncited",
    limit: 2,
  });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].citation, "");
});

test("edge: concurrent retrieve on offline-liar stays empty when denied", async () => {
  const harness = KNOWLEDGE_VIOLATION_FIXTURES.offlineLiar.createFactory()();
  harness.setNetworkAllowed(false);
  const batches = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.knowledge.retrieve({ query: `probe.liar.${i}`, limit: 2 }),
    ),
  );
  assert.ok(batches.every((p) => p.length === 0));
});

test("edge: replay of full fixture-isolation suite is idempotent", async () => {
  const fixture = KNOWLEDGE_VIOLATION_FIXTURES.uncitedPassage;
  const opts = {
    registry: createKnowledgeObligationsRegistry(),
    factory: fixture.createFactory(),
    subjectId: "subj-replay-know-fixture",
  };
  const a = await runConformance(opts);
  const b = await runConformance(opts);
  assert.equal(a.exitCode, 1);
  assert.equal(b.exitCode, a.exitCode);
  assert.equal(a.failed, b.failed);
  assert.equal(a.passed, b.passed);
});
