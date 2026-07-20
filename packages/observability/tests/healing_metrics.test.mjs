/**
 * Healing audit write-ahead ack on the P3 observability spine.
 * Run: pnpm --filter @moolam/observability test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALING_REMEDIATIONS_ATTEMPTED_COUNTER,
  HEALING_REMEDIATIONS_DISABLED_COUNTER,
  HEALING_REMEDIATIONS_SUCCEEDED_COUNTER,
  HEALING_TIME_TO_RESOLUTION_HISTOGRAM,
  HEALING_AUDIT_WRITE_AHEAD_EVENT,
  HealingMetricsContractError,
  assertHealingMetricAttrKeysAllowed,
  createHealingMetricsSink,
  createInMemoryHealingMetricsSink,
  emitHealingAuditOutcome,
  emitHealingAuditWriteAheadAck,
  toHealingAuditWriteAheadSpineEvent,
} from "../dist/healing_metrics.js";

function audit(overrides = {}) {
  return {
    auditId: "heal.audit.1",
    subjectId: "subj.spine.1",
    deviceId: "dev.spine",
    policyVersion: 5,
    patternId: "pattern.degradation",
    triggerEvidenceHash: "abcdef0123456789abcdef0123456789",
    action: "switch_degradation_mode",
    idempotencyKey: "spine.idem.1",
    locality: "on-device",
    timestamp: "2026-07-17T00:00:00.000Z",
    sliceId: "slice.model",
    failureClass: "degradation",
    ...overrides,
  };
}

test("spine write-ahead ack is metadata-only and durable-shaped", async () => {
  const { sink, events } = createInMemoryHealingMetricsSink({
    expectedSubjectId: "subj.spine.1",
  });
  const row = audit();

  const mapped = toHealingAuditWriteAheadSpineEvent(row);
  assert.equal(mapped.event, HEALING_AUDIT_WRITE_AHEAD_EVENT);
  assert.equal(mapped.policyVersion, 5);
  assert.equal(mapped.sliceId, "slice.model");
  assert.equal(mapped.failureClass, "degradation");

  const emitted = await emitHealingAuditWriteAheadAck({
    audit: row,
    metrics: sink,
  });
  assert.equal(emitted.auditId, "heal.audit.1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subjectId, "subj.spine.1");
  assert.deepEqual(sink.snapshot(), {
    attempted: 1,
    succeeded: 0,
    disabled: 0,
    timeToResolutionMs: [],
    activeAuditCount: 1,
    completedAuditCount: 0,
  });
  assert.ok(!JSON.stringify(events).includes("utterance"));
  assert.ok(!JSON.stringify(events).includes("secret"));
});

test("counts attempted/succeeded/disabled and records resolution histogram", async () => {
  const { sink, events } = createInMemoryHealingMetricsSink();
  const succeeded = audit();
  const disabled = audit({
    auditId: "heal.audit.2",
    idempotencyKey: "spine.idem.2",
    action: "adjust_retry_budget",
    patternId: "pattern.timeout",
    sliceId: "slice.tool",
    failureClass: "tool_timeout",
  });

  await emitHealingAuditWriteAheadAck({ audit: succeeded, metrics: sink });
  await emitHealingAuditWriteAheadAck({ audit: disabled, metrics: sink });
  await emitHealingAuditOutcome({
    audit: succeeded,
    outcome: "succeeded",
    timestamp: "2026-07-17T00:00:01.250Z",
    metrics: sink,
  });
  await emitHealingAuditOutcome({
    audit: disabled,
    outcome: "disabled",
    timestamp: "2026-07-17T00:00:02.500Z",
    metrics: sink,
  });

  assert.deepEqual(sink.snapshot(), {
    attempted: 2,
    succeeded: 1,
    disabled: 1,
    timeToResolutionMs: [1250, 2500],
    activeAuditCount: 0,
    completedAuditCount: 2,
  });
  assert.equal(events.at(-1)?.sliceId, "slice.tool");
  assert.equal(events.at(-1)?.failureClass, "tool_timeout");
  assert.equal(events.at(-1)?.resolutionMs, 2500);
});

test("duplicate metric payloads are idempotent; conflicting replay is refused", async () => {
  const { sink, events } = createInMemoryHealingMetricsSink();
  const row = audit();
  const first = await emitHealingAuditWriteAheadAck({ audit: row, metrics: sink });
  await sink.emitWriteAheadAck(first);
  const outcome = await emitHealingAuditOutcome({
    audit: row,
    outcome: "succeeded",
    timestamp: "2026-07-17T00:00:00.100Z",
    metrics: sink,
  });
  await sink.emitOutcome(outcome);

  assert.equal(sink.snapshot().attempted, 1);
  assert.equal(sink.snapshot().succeeded, 1);
  assert.equal(events.length, 2);

  assert.throws(
    () =>
      sink.emitOutcome({
        ...outcome,
        outcome: "disabled",
      }),
    (error) =>
      error instanceof HealingMetricsContractError &&
      error.obligation === "healing_metrics.idempotent_conflict",
  );
});

test("subject isolation, write-ahead ordering, and attribute privacy are enforced", async () => {
  const { sink } = createInMemoryHealingMetricsSink({
    expectedSubjectId: "subj.spine.1",
  });

  await assert.rejects(
    () =>
      emitHealingAuditWriteAheadAck({
        audit: audit({ subjectId: "subj.other" }),
        metrics: sink,
      }),
    (error) =>
      error instanceof HealingMetricsContractError &&
      error.obligation === "healing_metrics.cross_subject_denied",
  );

  assert.throws(
    () =>
      sink.emitOutcome({
        event: "observability.healing.outcome",
        outcome: "succeeded",
        subjectId: "subj.spine.1",
        deviceId: "dev.spine",
        auditId: "heal.missing",
        patternId: "pattern.missing",
        policyVersion: 1,
        action: "set_routing_fallback",
        locality: "on-device",
        timestamp: "2026-07-17T00:00:00.000Z",
        resolutionMs: 1,
      }),
    (error) =>
      error instanceof HealingMetricsContractError &&
      error.obligation === "healing_metrics.missing_attempt",
  );

  assert.throws(
    () =>
      assertHealingMetricAttrKeysAllowed({
        "sutra.subject_id": "subj.spine.1",
        utterance: "forbidden",
      }),
    (error) =>
      error instanceof HealingMetricsContractError &&
      error.obligation === "healing_metrics.raw_content_forbidden",
  );
});

test("P3 OpenTelemetry instruments receive closed slice attributes", async () => {
  const counters = new Map();
  const histograms = new Map();
  const fakeMeter = {
    createCounter(name) {
      const values = [];
      counters.set(name, values);
      return {
        add(value, attrs) {
          values.push({ value, attrs });
        },
      };
    },
    createHistogram(name) {
      const values = [];
      histograms.set(name, values);
      return {
        record(value, attrs) {
          values.push({ value, attrs });
        },
      };
    },
  };
  const sink = createHealingMetricsSink({
    observability: { meter: fakeMeter },
  });
  const row = audit();
  await emitHealingAuditWriteAheadAck({ audit: row, metrics: sink });
  await emitHealingAuditOutcome({
    audit: row,
    outcome: "succeeded",
    timestamp: "2026-07-17T00:00:00.500Z",
    metrics: sink,
  });

  assert.equal(
    counters.get(HEALING_REMEDIATIONS_ATTEMPTED_COUNTER)?.[0]?.value,
    1,
  );
  assert.equal(
    counters.get(HEALING_REMEDIATIONS_SUCCEEDED_COUNTER)?.[0]?.value,
    1,
  );
  assert.equal(
    counters.get(HEALING_REMEDIATIONS_DISABLED_COUNTER)?.length,
    0,
  );
  const sample = histograms.get(HEALING_TIME_TO_RESOLUTION_HISTOGRAM)?.[0];
  assert.equal(sample?.value, 500);
  assert.equal(sample?.attrs["sutra.slice_id"], "slice.model");
  assert.equal(sample?.attrs["sutra.failure_class"], "degradation");
  assert.ok(
    Object.keys(sample?.attrs ?? {}).every(
      (key) => !/utterance|content|body|secret/i.test(key),
    ),
  );
});
