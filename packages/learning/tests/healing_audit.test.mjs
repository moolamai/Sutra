/**
 * Write-ahead healing audit record.
 * Run: pnpm --filter @moolam/learning run build && node --test packages/learning/tests/healing_audit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALING_AUDIT_ACTION_KINDS,
  HEALING_AUDIT_MUST_WRITE_AHEAD,
  HEALING_AUDIT_SCHEMA_VERSION,
  HealingAuditContractError,
  assertHealingWriteAhead,
  createInMemoryHealingAuditSink,
  hashTriggerEvidence,
  runWithHealingWriteAhead,
} from "../dist/healing_audit.js";

const SUBJECT = "subj.heal.audit.001";
const DEVICE = "dev.heal.audit";

test("write-ahead record includes required fields before effect", async () => {
  const events = [];
  const sink = createInMemoryHealingAuditSink({
    expectedSubjectId: SUBJECT,
    onTelemetry: (event) => events.push(event),
  });
  const evidenceHash = hashTriggerEvidence({
    tokens: ["fp.timeout.1", "cluster.tool_timeout"],
    subjectId: SUBJECT,
    deviceId: DEVICE,
  });

  let effectRan = false;
  const { audit, result } = await runWithHealingWriteAhead({
    sink,
    writeAhead: {
      subjectId: SUBJECT,
      deviceId: DEVICE,
      policyVersion: 3,
      patternId: "pattern.tool_timeout.v3",
      triggerEvidenceHash: evidenceHash,
      action: "adjust_retry_budget",
      idempotencyKey: "heal.exec.1",
      locality: "on-device",
      sliceId: "slice.tool",
      failureClass: "tool_timeout",
    },
    effect: async (row) => {
      effectRan = true;
      assert.equal(row.phase, "write_ahead");
      assert.equal(row.outcome, "pending");
      assert.equal(row.schemaVersion, HEALING_AUDIT_SCHEMA_VERSION);
      assert.equal(row.policyVersion, 3);
      assert.equal(row.patternId, "pattern.tool_timeout.v3");
      assert.equal(row.action, "adjust_retry_budget");
      assert.equal(row.subjectId, SUBJECT);
      assert.equal(row.sliceId, "slice.tool");
      assert.equal(row.failureClass, "tool_timeout");
      assert.ok(row.timestamp);
      assert.equal(row.triggerEvidenceHash, evidenceHash);
      return { applied: true };
    },
  });

  assert.equal(effectRan, true);
  assert.deepEqual(result, { applied: true });
  assert.equal(HEALING_AUDIT_ACTION_KINDS.length, 4);
  assert.match(HEALING_AUDIT_MUST_WRITE_AHEAD, /write-ahead/);

  const timeline = sink.records(SUBJECT);
  assert.ok(timeline.length >= 2);
  assert.equal(timeline[0]?.phase, "write_ahead");
  assert.equal(timeline[0]?.outcome, "pending");
  assert.ok(
    timeline.some((row) => row.phase === "effect" && row.outcome === "ok"),
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.healing_audit" &&
        event.phase === "write_ahead" &&
        event.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(timeline).includes("utterance"));
  assert.equal(audit.auditId, timeline[0]?.auditId);
});

test("effect without write-ahead is refused; forbidden actions and raw content denied", async () => {
  const sink = createInMemoryHealingAuditSink({
    expectedSubjectId: SUBJECT,
  });

  assert.throws(
    () =>
      assertHealingWriteAhead({
        sink,
        idempotencyKey: "missing",
        subjectId: SUBJECT,
        deviceId: DEVICE,
      }),
    (error) =>
      error instanceof HealingAuditContractError &&
      error.obligation === "healing_audit.write_ahead_required",
  );

  await assert.rejects(
    () =>
      sink.recordWriteAhead({
        subjectId: SUBJECT,
        deviceId: DEVICE,
        policyVersion: 1,
        patternId: "pattern.x",
        triggerEvidenceHash: "abc123def4567890",
        action: "widen_permissions",
        idempotencyKey: "forbid.1",
      }),
    (error) =>
      error instanceof HealingAuditContractError &&
      error.obligation === "healing_audit.forbidden_action",
  );

  assert.throws(
    () =>
      hashTriggerEvidence({
        tokens: ["utterance: secret learner text"],
        subjectId: SUBJECT,
      }),
    (error) =>
      error instanceof HealingAuditContractError &&
      error.obligation === "healing_audit.raw_content_forbidden",
  );

  await assert.rejects(
    () =>
      runWithHealingWriteAhead({
        sink: null,
        writeAhead: {
          subjectId: SUBJECT,
          deviceId: DEVICE,
          policyVersion: 1,
          patternId: "pattern.x",
          triggerEvidenceHash: "abc123def4567890abcd",
          action: "set_correction_loop_cap",
          idempotencyKey: "nosink.1",
        },
        effect: async () => "nope",
      }),
    (error) =>
      error instanceof HealingAuditContractError &&
      error.obligation === "healing_audit.sink_required",
  );
});

test("idempotent replay; cross-subject deny; partial failure leaves write-ahead", async () => {
  const sink = createInMemoryHealingAuditSink({
    expectedSubjectId: SUBJECT,
  });
  const hash = hashTriggerEvidence({
    tokens: ["fp.a"],
    subjectId: SUBJECT,
    deviceId: DEVICE,
  });

  const first = await sink.recordWriteAhead({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    policyVersion: 2,
    patternId: "pattern.retry",
    triggerEvidenceHash: hash,
    action: "adjust_retry_budget",
    idempotencyKey: "idem.heal.1",
  });
  const replay = await sink.recordWriteAhead({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    policyVersion: 2,
    patternId: "pattern.retry",
    triggerEvidenceHash: hash,
    action: "adjust_retry_budget",
    idempotencyKey: "idem.heal.1",
  });
  assert.equal(replay.auditId, first.auditId);
  assert.equal(
    sink.records(SUBJECT).filter((r) => r.phase === "write_ahead").length,
    1,
  );

  await assert.rejects(
    () =>
      sink.recordWriteAhead({
        subjectId: "subj.other",
        deviceId: DEVICE,
        policyVersion: 1,
        patternId: "pattern.x",
        triggerEvidenceHash: hash,
        action: "adjust_retry_budget",
        idempotencyKey: "xsubj.1",
      }),
    (error) =>
      error instanceof HealingAuditContractError &&
      error.obligation === "healing_audit.cross_subject_denied",
  );

  await assert.rejects(
    () =>
      runWithHealingWriteAhead({
        sink,
        writeAhead: {
          subjectId: SUBJECT,
          deviceId: DEVICE,
          policyVersion: 1,
          patternId: "pattern.fail",
          triggerEvidenceHash: hash,
          action: "set_routing_fallback",
          idempotencyKey: "partial.1",
        },
        effect: async () => {
          throw new Error("surface failed");
        },
      }),
    (error) => error instanceof Error && error.message === "surface failed",
  );
  assert.equal(sink.hasWriteAhead("partial.1"), true);
  assert.ok(
    sink
      .records(SUBJECT)
      .some(
        (row) => row.idempotencyKey === "partial.1" && row.outcome === "error",
      ),
  );
});
