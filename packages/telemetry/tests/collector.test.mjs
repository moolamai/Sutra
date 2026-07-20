// Unit tests for the friction collector over an in-memory storage driver.
// Run: node --test tests/  (after pnpm build)
import test from "node:test";
import assert from "node:assert/strict";
import { CognitiveTelemetryCollector } from "../dist/index.js";
import { HlcClock } from "@moolam/sync-protocol";

/** Minimal in-memory StorageDriver for tests. */
function memoryDriver() {
  const rows = new Map();
  return {
    rows,
    async execute(sql, params = []) {
      if (sql.startsWith("CREATE")) return;
      if (sql.includes("INSERT")) {
        if (!rows.has(params[0])) {
          rows.set(params[0], { captured_at: params[0], concept_id: params[1], hesitation_ms: params[2], input_velocity: params[3], revision_count: params[4], assistance_requested: params[5], outcome: params[6], synced: 0 });
        }
        return;
      }
      if (sql.includes("UPDATE")) {
        const row = rows.get(params[0]);
        if (row) row.synced = 1;
      }
    },
    async query(sql) {
      if (typeof sql === "string" && sql.includes("COUNT(*)")) {
        if (sql.includes("synced = 0")) {
          return [{ n: [...rows.values()].filter((r) => r.synced === 0).length }];
        }
        return [{ n: rows.size }];
      }
      if (typeof sql === "string" && /LIMIT\s+\d+/i.test(sql) && sql.includes("captured_at")) {
        const sorted = [...rows.values()].sort((a, b) =>
          a.captured_at < b.captured_at ? -1 : 1,
        );
        if (sorted.length === 0) return [];
        const row = /DESC/i.test(sql) ? sorted[sorted.length - 1] : sorted[0];
        return [{ captured_at: row.captured_at }];
      }
      return [...rows.values()]
        .filter((r) => r.synced === 0)
        .sort((a, b) => (a.captured_at < b.captured_at ? -1 : 1));
    },
  };
}

test("collector folds an exercise window into a durable friction sample", async () => {
  const driver = memoryDriver();
  const collector = new CognitiveTelemetryCollector(driver, new HlcClock("test-device"));
  await collector.initialize();

  collector.observe({ type: "prompt-rendered", conceptId: "c1", atMs: 0 });
  collector.observe({ type: "input", charsDelta: 5, atMs: 2000 });
  collector.observe({ type: "deletion", atMs: 2500 });
  collector.observe({ type: "assistance-requested", atMs: 3000 });
  collector.observe({ type: "input", charsDelta: 8, atMs: 4000 });

  const sample = await collector.submitted("partial", 5000);
  assert.ok(sample);
  assert.equal(sample.conceptId, "c1");
  assert.equal(sample.hesitationMs, 2000);
  assert.equal(sample.revisionCount, 1);
  assert.equal(sample.assistanceRequested, true);
  assert.equal(sample.outcome, "partial");
  assert.equal(driver.rows.size, 1, "sample persisted write-ahead");

  const unsynced = await collector.unsynced();
  assert.equal(unsynced.length, 1);
  await collector.markSynced([sample.capturedAt]);
  assert.equal((await collector.unsynced()).length, 0);
});

test("events outside an open exercise window are dropped by design", async () => {
  const collector = new CognitiveTelemetryCollector(memoryDriver(), new HlcClock("test-device"));
  collector.observe({ type: "input", charsDelta: 3, atMs: 100 });
  const sample = await collector.submitted("correct", 200);
  assert.equal(sample, null, "no open window means no partial evidence");
});

test("injectable nowMs seam advances without wall-clock wait", async () => {
  let now = 1_700_000_000_000;
  const collector = new CognitiveTelemetryCollector(
    memoryDriver(),
    new HlcClock("test-device", () => now),
    { nowMs: () => now },
  );
  await collector.initialize();
  assert.equal(collector.nowMs(), now);
  now += 86_400_000;
  assert.equal(collector.nowMs(), 1_700_000_000_000 + 86_400_000);
  const sampleTick = collector.hlcClock.tick();
  assert.equal(Number(sampleTick.slice(0, 15)), now);
});

test("durableSampleCount is O(1) aggregate — no row materialization", async () => {
  const driver = memoryDriver();
  const collector = new CognitiveTelemetryCollector(driver, new HlcClock("test-device"));
  await collector.initialize();
  assert.equal(await collector.durableSampleCount(), 0);
  collector.observe({ type: "prompt-rendered", conceptId: "c1", atMs: 0 });
  await collector.submitted("correct", 10);
  collector.observe({ type: "prompt-rendered", conceptId: "c2", atMs: 20 });
  await collector.submitted("incorrect", 30);
  assert.equal(await collector.durableSampleCount(), 2);
});

test("castIntegrityProbe uses aggregates + edge keys (no full table materialization)", async () => {
  const driver = memoryDriver();
  const collector = new CognitiveTelemetryCollector(driver, new HlcClock("test-device"));
  await collector.initialize();
  collector.observe({ type: "prompt-rendered", conceptId: "c1", atMs: 0 });
  const a = await collector.submitted("correct", 10);
  collector.observe({ type: "prompt-rendered", conceptId: "c2", atMs: 20 });
  const b = await collector.submitted("incorrect", 30);
  assert.ok(a && b);
  const probe = await collector.castIntegrityProbe();
  assert.equal(probe.durableCount, 2);
  assert.equal(probe.unsyncedCount, 2);
  assert.equal(probe.earliestCapturedAt, a.capturedAt);
  assert.equal(probe.latestCapturedAt, b.capturedAt);
  await collector.markSynced([a.capturedAt]);
  const after = await collector.castIntegrityProbe();
  assert.equal(after.durableCount, 2);
  assert.equal(after.unsyncedCount, 1);
  assert.ok(collector.approxDurableStoreBytes() > 0);
  assert.ok(collector.lastPersistLatencyMs() >= 0);
  assert.ok(
    CognitiveTelemetryCollector.estimateSampleStoreBytes(a) <=
      NFR02_STORE_BYTES_HINT,
  );
});

/** Aligns with EdgeAgent NFR02_PROOF_THRESHOLDS.storeBytesPerSampleMax. */
const NFR02_STORE_BYTES_HINT = 512;