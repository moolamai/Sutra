/**
 * Trajectory queue record schema + local encrypted transport (C4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRAJECTORY_SCHEMA_VERSION,
  TRAJECTORY_QUEUE_RECORD_SCHEMA_VERSION,
  TrajectoryQueueContractError,
  SubjectConsentLedger,
  assertTrajectoryQueueEnqueueConsent,
  buildTrajectoryQueueRecord,
  openLocalEncryptedTrajectoryQueue,
  openTrajectoryQueueTransport,
  proveTrajectoryQueueMicroRun,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSENT_FIXTURES = join(__dirname, "..", "fixtures", "consent");

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "subj.queue.01",
    sessionId: "sess.queue.01",
    turnId: "turn.queue.01",
    deviceId: "dev.queue.01",
    capturedAt: "2026-07-16T12:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    policyCheckpointHash: "ckpt:sha256:abcdef0123456789",
    ...overrides,
  };
}

test("happy path: micro-run enqueue/dequeue with lineage pins", () => {
  const root = mkdtempSync(join(tmpdir(), "sutra-tq-"));
  const events = [];
  try {
    const a = draft({ turnId: "turn.a", subjectId: "subj.a" });
    const b = draft({
      turnId: "turn.b",
      subjectId: "subj.b",
      policyCheckpointHash: "ckpt:sha256:fedcba9876543210",
      consent: {
        optedIn: true,
        consentClass: "product-improve",
        recordedAt: "2026-07-16T12:00:00.000Z",
      },
    });

    const proved = proveTrajectoryQueueMicroRun({
      rootDir: root,
      keyMaterial: "test-queue-key-material",
      trajectories: [a, b],
      onTelemetry: (e) => events.push(e),
    });

    assert.equal(proved.ok, true);
    assert.equal(proved.enqueued, 2);
    assert.equal(proved.dequeued, 2);
    assert.deepEqual(proved.policyCheckpointHashes, [
      "ckpt:sha256:abcdef0123456789",
      "ckpt:sha256:fedcba9876543210",
    ]);
    assert.ok(events.some((e) => e.event === "learning.trajectory_queue.enqueue"));
    assert.ok(events.some((e) => e.event === "learning.trajectory_queue.dequeue"));

    const record = buildTrajectoryQueueRecord({
      trajectory: a,
      queueRecordId: "qr.test.1",
      enqueuedAt: "2026-07-16T12:00:00.000Z",
    });
    assert.equal(record.schemaVersion, TRAJECTORY_QUEUE_RECORD_SCHEMA_VERSION);
    assert.equal(record.consentClass, "research");
    assert.ok(record.enqueuedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: queue full backpressure; missing checkpoint; floating latest", () => {
  const root = mkdtempSync(join(tmpdir(), "sutra-tq-full-"));
  try {
    const q = openLocalEncryptedTrajectoryQueue({
      rootDir: root,
      keyMaterial: "test-queue-key-material",
      maxDepth: 1,
    });

    q.enqueue({ trajectory: draft({ turnId: "t1" }) });
    assert.throws(
      () => q.enqueue({ trajectory: draft({ turnId: "t2", subjectId: "subj.2" }) }),
      (err) =>
        err instanceof TrajectoryQueueContractError &&
        err.obligation === "queue.full",
    );

    const missingCkpt = draft({ turnId: "t-miss" });
    delete missingCkpt.policyCheckpointHash;
    assert.throws(
      () =>
        buildTrajectoryQueueRecord({
          trajectory: missingCkpt,
          queueRecordId: "qr.x",
          enqueuedAt: "2026-07-16T12:00:00.000Z",
        }),
      (err) =>
        err instanceof TrajectoryQueueContractError &&
        err.obligation === "queue.missing_checkpoint_hash",
    );

    assert.throws(
      () =>
        buildTrajectoryQueueRecord({
          trajectory: draft({ policyCheckpointHash: "latest" }),
          queueRecordId: "qr.y",
          enqueuedAt: "2026-07-16T12:00:00.000Z",
        }),
      (err) =>
        err instanceof TrajectoryQueueContractError &&
        (err.obligation === "queue.floating_checkpoint" ||
          err.obligation === "queue.schema_violation"),
    );

    q.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: subject isolation dequeue; idempotent replay; redis fallback advisory", () => {
  const root = mkdtempSync(join(tmpdir(), "sutra-tq-subj-"));
  const events = [];
  try {
    const q = openTrajectoryQueueTransport({
      rootDir: root,
      keyMaterial: "test-queue-key-material",
      preferRedis: true,
      maxDepth: 8,
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(q.kind, "local-encrypted");
    assert.ok(
      events.some(
        (e) =>
          e.outcome === "advisory" &&
          e.failureClass === "queue.redis_unavailable",
      ),
    );

    q.enqueue({
      trajectory: draft({ subjectId: "subj.a", turnId: "ta" }),
      queueRecordId: "qr.idem.1",
    });
    const replay = q.enqueue({
      trajectory: draft({ subjectId: "subj.a", turnId: "ta" }),
      queueRecordId: "qr.idem.1",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(q.depth(), 1);

    q.enqueue({
      trajectory: draft({ subjectId: "subj.b", turnId: "tb" }),
      queueRecordId: "qr.b.1",
    });

    const onlyB = q.dequeue({ subjectId: "subj.b" });
    assert.equal(onlyB.dequeued, true);
    if (onlyB.dequeued) {
      assert.equal(onlyB.record.subjectId, "subj.b");
    }

    const cross = q.dequeue({ subjectId: "subj.missing" });
    assert.equal(cross.dequeued, false);

    const rest = q.dequeue({ subjectId: "subj.a" });
    assert.equal(rest.dequeued, true);
    q.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consent gate: opt-out and unknown-class fixtures rejected at enqueue", () => {
  const events = [];
  const optOut = JSON.parse(
    readFileSync(join(CONSENT_FIXTURES, "negative-opt-out-trajectory.json"), "utf8"),
  );
  optOut.policyCheckpointHash = "ckpt:sha256:optoutfixture01";

  assert.throws(
    () =>
      assertTrajectoryQueueEnqueueConsent(
        {
          subjectId: optOut.subjectId,
          consent: optOut.consent,
          deviceId: optOut.deviceId,
        },
        { onTelemetry: (e) => events.push(e) },
      ),
    (err) =>
      err instanceof TrajectoryQueueContractError &&
      err.obligation === "queue.consent_denied",
  );

  const unknown = JSON.parse(
    readFileSync(
      join(CONSENT_FIXTURES, "negative-unknown-class-trajectory.json"),
      "utf8",
    ),
  );
  assert.throws(
    () =>
      assertTrajectoryQueueEnqueueConsent({
        subjectId: unknown.subjectId,
        consent: unknown.consent,
        deviceId: unknown.deviceId,
      }),
    (err) =>
      err instanceof TrajectoryQueueContractError &&
      err.obligation === "queue.unknown_consent_class",
  );

  const root = mkdtempSync(join(tmpdir(), "sutra-tq-consent-"));
  try {
    const q = openLocalEncryptedTrajectoryQueue({
      rootDir: root,
      keyMaterial: "test-queue-key-material",
      maxDepth: 4,
      consentGate: { allowedConsentClasses: ["research"] },
      onTelemetry: (e) => events.push(e),
    });

    assert.throws(
      () => q.enqueue({ trajectory: optOut }),
      (err) =>
        err instanceof TrajectoryQueueContractError &&
        err.obligation === "queue.consent_denied",
    );
    assert.equal(q.depth(), 0);

    assert.throws(
      () =>
        q.enqueue({
          trajectory: draft({
            consent: {
              optedIn: true,
              consentClass: "personal",
              recordedAt: "2026-07-16T12:00:00.000Z",
            },
          }),
        }),
      (err) =>
        err instanceof TrajectoryQueueContractError &&
        err.obligation === "queue.consent_tier_mismatch",
    );
    assert.equal(q.depth(), 0);

    const ok = q.enqueue({ trajectory: draft() });
    assert.equal(ok.queued, true);
    assert.equal(ok.record.consentClass, "research");
    q.close();

    assert.ok(
      events.some(
        (e) =>
          e.event === "learning.trajectory_queue.consent_gate" &&
          e.outcome === "fail",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consent gate: revoked subject and missing consent rejected", () => {
  const ledger = new SubjectConsentLedger();
  ledger.revoke("subj.revoked");

  assert.throws(
    () =>
      assertTrajectoryQueueEnqueueConsent({
        subjectId: "subj.revoked",
        consent: {
          optedIn: true,
          consentClass: "research",
          recordedAt: "2026-07-16T12:00:00.000Z",
        },
        ledger,
      }),
    (err) =>
      err instanceof TrajectoryQueueContractError &&
      err.obligation === "queue.consent_revoked",
  );

  assert.throws(
    () =>
      assertTrajectoryQueueEnqueueConsent({
        subjectId: "subj.missing-consent",
        consent: null,
      }),
    (err) =>
      err instanceof TrajectoryQueueContractError &&
      err.obligation === "queue.missing_consent_class",
  );

  assert.throws(
    () =>
      buildTrajectoryQueueRecord({
        trajectory: draft({ subjectId: "subj.revoked" }),
        queueRecordId: "qr.rev",
        enqueuedAt: "2026-07-16T12:00:00.000Z",
        ledger,
      }),
    (err) =>
      err instanceof TrajectoryQueueContractError &&
      err.obligation === "queue.consent_revoked",
  );
});
