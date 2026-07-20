/**
 * Aggregation rollup schema, consent attachment, and subject-scoped edge seam.
 * Run: pnpm --filter @moolam/telemetry test (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FRICTION_AGGREGATION_SCHEMA_VERSION,
  SubjectScopedAggregationSeam,
  assertAggregationExportConsent,
  attachAggregationConsent,
  buildFrictionAggregationRollup,
  dedupeFrictionSamplesByCapturedAt,
  emitAggregationObservability,
  enqueueAggregationWrite,
  parseFrictionAggregationRollup,
  rollupLocalFrictionSamples,
  toFrictionAggregationJsonSchema,
} from "../dist/index.js";
import { PROTOCOL_VERSION, encodeHLC } from "@moolam/sync-protocol";

function hlc(ms, logical, device = "edge-dev1") {
  return encodeHLC(ms, logical, device);
}

function sample(overrides = {}) {
  return {
    conceptId: "ratios",
    hesitationMs: 1200,
    inputVelocity: 3.5,
    revisionCount: 1,
    assistanceRequested: false,
    outcome: "partial",
    capturedAt: hlc(1_700_000_000_000, 1),
    ...overrides,
  };
}

function activeConsent(overrides = {}) {
  return {
    consentRecordId: "consent-agg-001",
    subjectId: "learner-a",
    optedIn: true,
    active: true,
    scope: "aggregation",
    recordedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

test("happy path: schema round-trip with consentRecordId", () => {
  const built = buildFrictionAggregationRollup({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    locality: "on-device",
    rolledUpAt: hlc(1_700_000_000_100, 2),
    samples: [
      sample({ conceptId: "ratios", outcome: "correct", capturedAt: hlc(1, 1) }),
      sample({
        conceptId: "fractions",
        outcome: "incorrect",
        hesitationMs: 3000,
        assistanceRequested: true,
        capturedAt: hlc(1, 2),
      }),
    ],
  });
  assert.equal(built.ok, true);
  assert.equal(built.record.schemaVersion, FRICTION_AGGREGATION_SCHEMA_VERSION);
  assert.equal(built.record.consentRecordId, "consent-agg-001");
  assert.equal(built.record.sampleCount, 2);
  assert.equal(built.record.concepts.length, 2);

  const again = parseFrictionAggregationRollup(
    JSON.parse(JSON.stringify(built.record)),
  );
  assert.equal(again.ok, true);
  assert.deepEqual(again.record, built.record);

  emitAggregationObservability({
    event: "telemetry.aggregation",
    outcome: "ok",
    subjectId: built.record.subjectId,
    deviceId: built.record.deviceId,
    sampleCount: built.record.sampleCount,
    conceptCount: built.record.concepts.length,
  });
});

test("happy path: JSON Schema export embeds protocol + aggregation versions", () => {
  const doc = toFrictionAggregationJsonSchema(PROTOCOL_VERSION);
  assert.equal(doc.title, "FrictionAggregationRollup");
  assert.equal(doc["x-protocol-version"], PROTOCOL_VERSION);
  assert.equal(doc["x-aggregation-schema-version"], "aggregation.v1");
  assert.equal(doc.type, "object");
  const required = /** @type {string[]} */ (doc.required ?? []);
  assert.ok(required.includes("consentRecordId"));
  assert.ok(!("keystrokes" in (doc.properties ?? {})));
});

test("edge: duplicate capturedAt is idempotent — never double-count", () => {
  const twin = sample({
    capturedAt: hlc(1, 5),
    hesitationMs: 100,
    outcome: "correct",
  });
  const dup = sample({
    capturedAt: hlc(1, 5),
    hesitationMs: 999,
    outcome: "incorrect",
  });
  const deduped = dedupeFrictionSamplesByCapturedAt([twin, dup]);
  assert.equal(deduped.length, 1);

  const built = buildFrictionAggregationRollup({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    locality: "self-hosted",
    rolledUpAt: hlc(1, 9),
    samples: [twin, dup, twin],
  });
  assert.equal(built.ok, true);
  assert.equal(built.record.sampleCount, 1);
  assert.equal(built.record.concepts[0].sampleCount, 1);
});

test("edge: missing consentRecordId rejected", () => {
  const parsed = parseFrictionAggregationRollup({
    schemaVersion: "aggregation.v1",
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    locality: "on-device",
    rolledUpAt: hlc(1, 1),
    sampleCount: 0,
    concepts: [],
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.failureClass, "consent_missing");
});

test("edge: revoked consent mid-batch rejects export", () => {
  const built = buildFrictionAggregationRollup({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    locality: "on-device",
    rolledUpAt: hlc(1, 1),
    samples: [sample()],
  });
  assert.equal(built.ok, true);

  const ledger = new Map([
    ["consent-agg-001", activeConsent({ active: false })],
  ]);
  const gate = assertAggregationExportConsent(built.record, (id) =>
    ledger.get(id),
  );
  assert.equal(gate.ok, false);
  assert.equal(gate.failureClass, "consent_revoked");
});

test("edge: attachAggregationConsent refuses inactive opt-in", () => {
  const body = {
    schemaVersion: "aggregation.v1",
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    locality: "on-device",
    rolledUpAt: hlc(1, 1),
    sampleCount: 0,
    concepts: [],
  };
  const denied = attachAggregationConsent(
    body,
    activeConsent({ optedIn: false }),
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.failureClass, "consent_denied");

  const ok = attachAggregationConsent(body, activeConsent());
  assert.equal(ok.ok, true);
  assert.equal(ok.record.consentRecordId, "consent-agg-001");
});

test("sovereignty: cross-subject consent is a defect", () => {
  const built = buildFrictionAggregationRollup({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    locality: "on-device",
    rolledUpAt: hlc(1, 1),
    samples: [sample()],
  });
  assert.equal(built.ok, true);

  const gate = assertAggregationExportConsent(built.record, () =>
    activeConsent({ subjectId: "learner-b" }),
  );
  assert.equal(gate.ok, false);
  assert.equal(gate.failureClass, "cross_subject");
});

test("sovereignty: raw keystrokes forbidden on rollup wire", () => {
  const built = buildFrictionAggregationRollup({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    locality: "on-device",
    rolledUpAt: hlc(1, 1),
    samples: [sample()],
  });
  assert.equal(built.ok, true);
  const poisoned = { ...built.record, keystrokes: "typed-secret" };
  const parsed = parseFrictionAggregationRollup(poisoned);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.failureClass, "keystroke_forbidden");
});

test("edge: async write queues without blocking the turn", async () => {
  const built = buildFrictionAggregationRollup({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    locality: "on-device",
    rolledUpAt: hlc(1, 1),
    samples: [sample()],
  });
  assert.equal(built.ok, true);

  let writerDone = false;
  const events = [];
  const queued = enqueueAggregationWrite(
    built.record,
    async () => {
      await new Promise((r) => setTimeout(r, 30));
      writerDone = true;
    },
    { onTelemetry: (e) => events.push(e) },
  );
  assert.equal(queued.queued, true);
  assert.equal(writerDone, false, "turn must continue before durable write finishes");
  assert.equal(events[0]?.outcome, "queued");

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(writerDone, true);
  assert.ok(events.some((e) => e.outcome === "ok"));
  assert.ok(events.every((e) => !("keystrokes" in e) && !("prompt" in e)));
});

test("edge: rollupLocalFrictionSamples gates consent when ledger provided", () => {
  const ok = rollupLocalFrictionSamples({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    samples: [sample()],
    rolledUpAt: hlc(1, 1),
    resolveConsent: () => activeConsent(),
  });
  assert.equal(ok.ok, true);

  const revoked = rollupLocalFrictionSamples({
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    samples: [sample()],
    rolledUpAt: hlc(1, 1),
    resolveConsent: () => activeConsent({ active: false }),
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.failureClass, "consent_revoked");
});

function frictionStorage(rows, options = {}) {
  return {
    queryCount: 0,
    executeCount: 0,
    async execute() {
      this.executeCount++;
    },
    async query(sql, params) {
      this.queryCount++;
      if (options.queryError) throw options.queryError;
      assert.match(sql, /FROM friction_samples/);
      assert.match(sql, /ORDER BY captured_at ASC/);
      assert.match(sql, /LIMIT \d+/);
      if (options.queryDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.queryDelayMs),
        );
      }
      let selected = [...rows];
      if (sql.includes("captured_at >= ?")) {
        selected = selected.filter((row) => row.captured_at >= params[0]);
      }
      if (sql.includes("captured_at <= ?")) {
        const index = sql.includes("captured_at >= ?") ? 1 : 0;
        selected = selected.filter((row) => row.captured_at <= params[index]);
      }
      const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] ?? selected.length);
      return selected
        .sort((a, b) => a.captured_at.localeCompare(b.captured_at))
        .slice(0, limit);
    },
  };
}

function frictionRow(overrides = {}) {
  return {
    captured_at: hlc(1_700_000_000_000, 1),
    concept_id: "ratios",
    hesitation_ms: 1200,
    input_velocity: 3.5,
    revision_count: 1,
    assistance_requested: 0,
    outcome: "partial",
    ...overrides,
  };
}

function edgeInput(overrides = {}) {
  return {
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    consentRecordId: "consent-agg-001",
    rolledUpAt: hlc(1_700_000_000_100, 2),
    ...overrides,
  };
}

test("edge seam: rolls up bounded local rows with on-device default", async () => {
  const driver = frictionStorage([
    frictionRow(),
    frictionRow({
      captured_at: hlc(1_700_000_000_001, 1),
      concept_id: "fractions",
      outcome: "correct",
    }),
  ]);
  const events = [];
  const seam = new SubjectScopedAggregationSeam({
    subjectId: "learner-a",
    driver,
    resolveConsent: async () => activeConsent(),
    onTelemetry: (event) => events.push(event),
  });

  const result = await seam.rollup(edgeInput());
  assert.equal(result.ok, true);
  assert.equal(result.record.locality, "on-device");
  assert.equal(result.record.sampleCount, 2);
  assert.equal(result.record.concepts.length, 2);
  assert.equal(driver.queryCount, 1);
  assert.equal(driver.executeCount, 0, "rollup has no durable side effects");
  assert.deepEqual(events.at(-1), {
    event: "telemetry.aggregation.edge",
    operation: "rollup",
    outcome: "ok",
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    sampleCount: 2,
    conceptCount: 2,
  });
});

test("edge seam: missing consent rejects before reading friction storage", async () => {
  const driver = frictionStorage([frictionRow()]);
  const events = [];
  const seam = new SubjectScopedAggregationSeam({
    subjectId: "learner-a",
    driver,
    resolveConsent: async () => null,
    onTelemetry: (event) => events.push(event),
  });

  const result = await seam.rollup(edgeInput());
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "consent_missing");
  assert.equal(driver.queryCount, 0);
  assert.equal(events.at(-1).failureClass, "consent_missing");
  assert.ok(!("prompt" in events.at(-1)));
});

test("edge seam: cross-subject request is rejected before storage access", async () => {
  const driver = frictionStorage([frictionRow()]);
  let consentReads = 0;
  const seam = new SubjectScopedAggregationSeam({
    subjectId: "learner-a",
    driver,
    resolveConsent: async () => {
      consentReads++;
      return activeConsent();
    },
  });

  const result = await seam.rollup(edgeInput({ subjectId: "learner-b" }));
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "cross_subject");
  assert.equal(driver.queryCount, 0);
  assert.equal(consentReads, 0);
});

test("edge seam: consent revoked during batch rejects completed read", async () => {
  const driver = frictionStorage([frictionRow()]);
  let consentReads = 0;
  const seam = new SubjectScopedAggregationSeam({
    subjectId: "learner-a",
    driver,
    resolveConsent: async () => {
      consentReads++;
      return activeConsent({ active: consentReads === 1 });
    },
  });

  const result = await seam.rollup(edgeInput());
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "consent_revoked");
  assert.equal(consentReads, 2);
  assert.equal(driver.queryCount, 1);
  assert.equal(driver.executeCount, 0);
});

test("edge seam: bounded result refuses truncation", async () => {
  const driver = frictionStorage([
    frictionRow(),
    frictionRow({ captured_at: hlc(1_700_000_000_001, 1) }),
  ]);
  const seam = new SubjectScopedAggregationSeam({
    subjectId: "learner-a",
    driver,
    resolveConsent: async () => activeConsent(),
  });

  const result = await seam.rollup(edgeInput({ limit: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "sample_limit");
  assert.equal(driver.queryCount, 1);
});

test("edge seam: dependency timeout is a typed observable failure", async () => {
  const driver = frictionStorage([frictionRow()], { queryDelayMs: 50 });
  const events = [];
  const seam = new SubjectScopedAggregationSeam({
    subjectId: "learner-a",
    driver,
    resolveConsent: async () => activeConsent(),
    timeoutMs: 5,
    onTelemetry: (event) => events.push(event),
  });

  const result = await seam.rollup(edgeInput());
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "storage_timeout");
  assert.equal(events.at(-1).failureClass, "storage_timeout");
});

test("edge seam: concurrent replay is deterministic and never writes", async () => {
  const duplicate = frictionRow();
  const driver = frictionStorage([duplicate, duplicate]);
  const seam = new SubjectScopedAggregationSeam({
    subjectId: "learner-a",
    driver,
    resolveConsent: async () => activeConsent(),
  });

  const [left, right] = await Promise.all([
    seam.rollup(edgeInput()),
    seam.rollup(edgeInput()),
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.deepEqual(left.record, right.record);
  assert.equal(left.record.sampleCount, 1, "capturedAt replay counted once");
  assert.equal(driver.executeCount, 0);
});
