/**
 * Sync chaos — Redis/Postgres partition during sync roundtrip.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createPartitionedSyncTransport,
  runPartitionRedisPostgresDrill,
  canonicalStateEqual,
  formatSyncChaosGateReport,
} from "../_shared/sync_chaos_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRILL = path.join(__dirname, "../chaos/sync_chaos.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.sync_chaos.partition.test", ...event })}\n`,
  );
}

test("happy path: redis pause still converges; postgres pause then restore converges", async () => {
  const result = await runPartitionRedisPostgresDrill({
    subjectId: "subj-part-happy",
    deviceId: "edge-part-happy",
    sleep: async () => {},
  });
  assert.equal(result.ok, true, result.failureClass);
  assert.equal(result.drill, "partition_redis_postgres");
  assert.equal(result.underRedis.status, "converged");
  assert.notEqual(result.midPartition.status, "converged");
  assert.equal(result.edgeKeptLocal, true);
  assert.equal(result.outcome.status, "converged");
  assert.equal(result.applyCount, 1);
  assert.equal(result.replicasEqual, true);
  assert.equal(result.auditsPreserved, true);
  assert.ok(result.auditCount >= 2);
  assert.match(formatSyncChaosGateReport(result), /PASS/);
  assert.match(formatSyncChaosGateReport(result), /audit_rows=/);
  log({
    outcome: "ok",
    case: "partition-recover",
    subjectId: result.subjectId,
    auditCount: result.auditCount,
  });
});

test("edge: postgres partition mid-merge — edge authoritative, no double-apply on resume", async () => {
  const partitionAttemptId = randomUUID();
  const transport = createPartitionedSyncTransport();
  const result = await runPartitionRedisPostgresDrill({
    transport,
    subjectId: "subj-part-pg",
    deviceId: "edge-part-pg",
    partitionAttemptId,
    sleep: async () => {},
  });
  assert.equal(result.ok, true, result.failureClass);
  assert.equal(result.syncAttemptId, partitionAttemptId);
  assert.equal(result.applyCount, 1);
  assert.ok(
    transport.events.some((e) => e.kind === "partition_postgres"),
  );
  assert.ok(
    transport.events.some((e) => e.kind === "postgres_partition_reject"),
  );
  assert.ok(
    transport.events.some((e) => e.kind === "audit_appended"),
  );
  // Seed audit must still be present after partition restore.
  const audits = transport.getAuditLog("subj-part-pg");
  assert.ok(audits.some((a) => a.syncAttemptId === result.seedAttemptId));
  assert.ok(audits.some((a) => a.syncAttemptId === partitionAttemptId));
  log({
    outcome: "ok",
    case: "pg-authoritative-idempotent",
    subjectId: "subj-part-pg",
  });
});

test("edge: sticky postgres partition exhausts without fabricating merge", async () => {
  const transport = createPartitionedSyncTransport();
  // Seed once while healthy.
  transport.unpausePostgres();
  const seed = await runPartitionRedisPostgresDrill({
    transport: createPartitionedSyncTransport(),
    subjectId: "subj-part-exhaust-seed",
    sleep: async () => {},
  });
  assert.equal(seed.ok, true);

  const stuck = createPartitionedSyncTransport({ postgresPaused: true });
  const { SyncEngine, PROTOCOL_VERSION } = await import("sutra-sdk");
  const { buildEdgeStateWithPendingSamples } = await import(
    "../_shared/sync_convergence_probe.mjs"
  );
  const edge = buildEdgeStateWithPendingSamples("edge-x", "subj-stuck", 4);
  const outcome = await new SyncEngine(stuck, {
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 5,
    sleep: async () => {},
    random: () => 0.5,
  }).synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "edge-x",
    edgeState: edge,
    lastKnownCloudVector: {},
    syncAttemptId: randomUUID(),
  });
  assert.equal(outcome.status, "exhausted");
  assert.equal(stuck.getCloudState("subj-stuck"), null);
  assert.equal(stuck.getAuditLog("subj-stuck").length, 0);
  log({ outcome: "rejected", case: "sticky-pg-no-fabricate", subjectId: null });
});

test("sovereignty: audits scoped by subjectId; drill mentions compose pause", async () => {
  const a = await runPartitionRedisPostgresDrill({
    subjectId: "subj-part-iso-a",
    deviceId: "edge-a",
    sleep: async () => {},
  });
  const b = await runPartitionRedisPostgresDrill({
    subjectId: "subj-part-iso-b",
    deviceId: "edge-b",
    sleep: async () => {},
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.ok(!canonicalStateEqual(a.outcome.state, b.outcome.state));
  const auditsA = a.transport.getAuditLog("subj-part-iso-a");
  const auditsB = b.transport.getAuditLog("subj-part-iso-b");
  assert.ok(auditsA.every((r) => r.subjectId === "subj-part-iso-a"));
  assert.ok(auditsB.every((r) => r.subjectId === "subj-part-iso-b"));

  const blob = JSON.stringify({ auditsA: auditsA.length, status: a.outcome.status });
  assert.ok(!blob.includes("utterance"));

  const src = readFileSync(DRILL, "utf8");
  assert.match(src, /partition|pause|runPartitionRedisPostgresDrill|runComposePartitionDrill/);
  assert.doesNotMatch(src, /test-only backdoor|BYPASS/i);
  log({ outcome: "ok", case: "subject-isolation", subjectId: null });
});
