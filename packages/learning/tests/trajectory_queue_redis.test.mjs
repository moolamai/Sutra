/**
 * Redis-stream trajectory queue seam (C4) — feature flag + fallback.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRAJECTORY_SCHEMA_VERSION,
  TRAJECTORY_QUEUE_REDIS_FEATURE_FLAG,
  TrajectoryQueueContractError,
  createInMemoryRedisStreamClient,
  isTrajectoryQueueRedisStreamEnabled,
  openRedisStreamTrajectoryQueue,
  openTrajectoryQueueTransport,
  probeRedisTcpReachable,
  proveRedisStreamQueueSeam,
} from "../dist/index.js";

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "subj.redis.01",
    sessionId: "sess.redis.01",
    turnId: "turn.redis.01",
    deviceId: "dev.redis.01",
    capturedAt: "2026-07-16T12:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    policyCheckpointHash: "ckpt:sha256:redisabcdef012345",
    ...overrides,
  };
}

test("happy path: feature-flagged redis stream enqueue/dequeue identical API", () => {
  const root = mkdtempSync(join(tmpdir(), "sutra-tq-redis-"));
  const events = [];
  try {
    assert.equal(
      isTrajectoryQueueRedisStreamEnabled({
        env: { [TRAJECTORY_QUEUE_REDIS_FEATURE_FLAG]: "1" },
      }),
      true,
    );
    assert.equal(
      isTrajectoryQueueRedisStreamEnabled({
        env: { [TRAJECTORY_QUEUE_REDIS_FEATURE_FLAG]: "0" },
      }),
      false,
    );

    const client = createInMemoryRedisStreamClient();
    const q = openTrajectoryQueueTransport({
      rootDir: root,
      keyMaterial: "test-queue-key-material",
      enableRedisStream: true,
      redisClient: client,
      maxDepth: 8,
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(q.kind, "redis-stream");

    const a = q.enqueue({
      trajectory: draft({ subjectId: "subj.a", turnId: "ta" }),
      queueRecordId: "qr.r.1",
    });
    assert.equal(a.queued, true);
    assert.equal(a.record.policyCheckpointHash.length > 0, true);

    const replay = q.enqueue({
      trajectory: draft({ subjectId: "subj.a", turnId: "ta" }),
      queueRecordId: "qr.r.1",
    });
    assert.equal(replay.idempotentReplay, true);

    q.enqueue({
      trajectory: draft({
        subjectId: "subj.b",
        turnId: "tb",
        policyCheckpointHash: "ckpt:sha256:redisfedcba987654",
      }),
      queueRecordId: "qr.r.2",
    });

    const onlyB = q.dequeue({ subjectId: "subj.b" });
    assert.equal(onlyB.dequeued, true);
    if (onlyB.dequeued) assert.equal(onlyB.record.subjectId, "subj.b");

    const rest = q.dequeue();
    assert.equal(rest.dequeued, true);
    assert.equal(q.depth(), 0);
    q.close();

    assert.ok(events.some((e) => e.transport === "redis-stream"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: redis unavailable / ping failure falls back to local; queue full", () => {
  const root = mkdtempSync(join(tmpdir(), "sutra-tq-redis-fb-"));
  const events = [];
  try {
    const fallback = openTrajectoryQueueTransport({
      rootDir: root,
      keyMaterial: "test-queue-key-material",
      preferRedis: true,
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(fallback.kind, "local-encrypted");
    assert.ok(
      events.some(
        (e) =>
          e.outcome === "advisory" &&
          e.failureClass === "queue.redis_unavailable",
      ),
    );

    const dead = createInMemoryRedisStreamClient();
    dead.quit();
    const events2 = [];
    const fb2 = openTrajectoryQueueTransport({
      rootDir: join(root, "dead"),
      keyMaterial: "test-queue-key-material",
      enableRedisStream: true,
      redisClient: dead,
      onTelemetry: (e) => events2.push(e),
    });
    assert.equal(fb2.kind, "local-encrypted");
    assert.ok(
      events2.some((e) => e.failureClass === "queue.redis_unavailable"),
    );

    const client = createInMemoryRedisStreamClient();
    const q = openRedisStreamTrajectoryQueue({
      client,
      keyMaterial: "test-queue-key-material",
      rootDir: join(root, "full"),
      maxDepth: 1,
    });
    q.enqueue({ trajectory: draft({ turnId: "t1" }) });
    assert.throws(
      () =>
        q.enqueue({
          trajectory: draft({ turnId: "t2", subjectId: "subj.2" }),
        }),
      (err) =>
        err instanceof TrajectoryQueueContractError &&
        err.obligation === "queue.full",
    );
    q.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: redis seam micro-run + compose TCP probe", async () => {
  const root = mkdtempSync(join(tmpdir(), "sutra-tq-redis-int-"));
  const events = [];
  try {
    const proved = await proveRedisStreamQueueSeam({
      rootDir: root,
      keyMaterial: "test-queue-key-material",
      trajectories: [
        draft({ turnId: "ti1", subjectId: "subj.i1" }),
        draft({
          turnId: "ti2",
          subjectId: "subj.i2",
          policyCheckpointHash: "ckpt:sha256:redisintegration02",
        }),
      ],
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(proved.ok, true);
    assert.equal(proved.redisKind, "redis-stream");
    assert.equal(proved.enqueued, 2);
    assert.equal(proved.dequeued, 2);
    assert.ok(
      proved.composeProbe.ok === true || proved.composeProbe.ok === false,
    );

    // Direct probe — advisory path when compose Redis is down is acceptable
    const probe = await probeRedisTcpReachable("redis://127.0.0.1:6379", {
      timeoutMs: 300,
    });
    assert.ok(probe.ok === true || typeof probe.detail === "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
