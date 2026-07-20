/**
 * Wire degradation registry into model / sync / tool invoke sites.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertStaleReadPayload } from "@moolam/sync-protocol";
import {
  invokeModelDependency,
  invokeSyncDependency,
  invokeToolDependency,
  loadDegradationRegistry,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: model invoke succeeds once without degradation", async () => {
  const telemetry = [];
  const loaded = loadDegradationRegistry({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true);

  let calls = 0;
  const result = await invokeModelDependency({
    registry: loaded.registry,
    operation: "read",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    invoke: async () => {
      calls += 1;
      return { text: "ok" };
    },
    onTelemetry: (e) => telemetry.push(e),
  });

  assert.equal(result.ok, true);
  assert.equal(result.degraded, false);
  assert.equal(result.invokeCount, 1);
  assert.equal(calls, 1);
  assert.deepEqual(result.value, { text: "ok" });
  assert.ok(
    telemetry.some((t) => t.action === "invoke" && t.outcome === "ok"),
  );
  log({
    event: "runtime.harness.degradation_registry",
    outcome: "ok",
    case: "model_up",
    invokeCount: result.invokeCount,
  });
});

test("edge: sync read down → stale_with_marker + freshness + advisory", async () => {
  const advisories = [];
  const telemetry = [];
  const loaded = loadDegradationRegistry();
  assert.equal(loaded.ok, true);

  let calls = 0;
  const result = await invokeSyncDependency({
    registry: loaded.registry,
    operation: "read",
    subjectId: "anika-k",
    deviceId: "edge-bbbb",
    lastKnownGood: { stateVector: { a: 1 }, local: true },
    capturedAt: "2026-07-15T10:00:00.000Z",
    freshnessSource: "last-known-good",
    invoke: async () => {
      calls += 1;
      throw new Error("sync transport down");
    },
    onTelemetry: (e) => telemetry.push(e),
    onAdvisory: (s) => advisories.push(s),
  });

  assert.equal(calls, 1, "exactly one invoke — no silent retry");
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.behavior, "stale_with_marker");
  assert.equal(result.fabricated, false);
  assert.equal(result.silentWriteRetry, false);
  assert.equal(result.signalCode, "DEGRADE_STALE_READ");
  assert.equal(result.freshnessMarker.source, "last-known-good");
  assert.equal(result.freshnessMarker.capturedAt, "2026-07-15T10:00:00.000Z");

  const asserted = assertStaleReadPayload(result.payload, {
    subjectId: "anika-k",
  });
  assert.equal(asserted.ok, true);

  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].event, "runtime.harness.degradation_advisory");
  assert.equal(advisories[0].outcome, "stale_served");
  assert.equal(advisories[0].subjectId, "anika-k");
  assert.equal(advisories[0].deviceId, "edge-bbbb");
  assert.ok(
    telemetry.some(
      (t) =>
        t.action === "invoke" &&
        t.outcome === "advisory" &&
        t.advisoryOutcome === "stale_served",
    ),
  );
  assert.ok(!JSON.stringify(advisories).includes("learner"));
  log({
    event: "runtime.harness.degradation_advisory",
    outcome: "stale_served",
    case: "sync_read_down",
    signalCode: result.signalCode,
  });
});

test("edge: sync write down → hard_stop + rollback once; never silent retry", async () => {
  const advisories = [];
  const loaded = loadDegradationRegistry();
  let invokeCalls = 0;
  let rollbackCalls = 0;

  const result = await invokeSyncDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "anika-k",
    invoke: async () => {
      invokeCalls += 1;
      throw new Error("sync write failed");
    },
    rollback: async () => {
      rollbackCalls += 1;
    },
    onAdvisory: (s) => advisories.push(s),
  });

  assert.equal(invokeCalls, 1);
  assert.equal(rollbackCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.behavior, "hard_stop");
  assert.equal(result.failureClass, "write_hard_stopped");
  assert.equal(result.rolledBack, true);
  assert.equal(result.silentWriteRetry, false);
  assert.equal(result.signalCode, "DEGRADE_HARD_STOP_WRITE");
  assert.equal(advisories[0].outcome, "hard_stopped");
  log({
    event: "runtime.harness.degradation_advisory",
    outcome: "hard_stopped",
    case: "sync_write_down",
    rolledBack: true,
  });
});

test("edge: tool down mid-loop → hard_stop + rollback of uncommitted effects", async () => {
  const loaded = loadDegradationRegistry();
  loaded.registry.register("tool", "hard_stop", { subjectId: "anika-k" });

  const effects = new Set(["pending-write"]);
  const result = await invokeToolDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "anika-k",
    invoke: async () => {
      throw new Error("tool backend down");
    },
    rollback: () => {
      effects.delete("pending-write");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.behavior, "hard_stop");
  assert.equal(result.rolledBack, true);
  assert.equal(effects.size, 0);
  assert.equal(result.fabricated, false);
});

test("partial outage: model up, sync write down → local read ok, sync hard_stop signal", async () => {
  const loaded = loadDegradationRegistry();
  const advisories = [];

  const modelUp = await invokeModelDependency({
    registry: loaded.registry,
    operation: "read",
    subjectId: "anika-k",
    invoke: async () => ({ reply: "local" }),
  });
  assert.equal(modelUp.ok, true);
  assert.equal(modelUp.degraded, false);

  const syncDown = await invokeSyncDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "anika-k",
    invoke: async () => {
      throw new Error("sync down");
    },
    onAdvisory: (s) => advisories.push(s),
  });
  assert.equal(syncDown.ok, false);
  assert.equal(syncDown.behavior, "hard_stop");
  assert.equal(advisories[0].dependency, "sync");
  assert.equal(advisories[0].signalCode, "DEGRADE_HARD_STOP_WRITE");
});

test("edge: stale path without LKG never fabricates — hard_stop", async () => {
  const loaded = loadDegradationRegistry();
  const result = await invokeSyncDependency({
    registry: loaded.registry,
    operation: "read",
    subjectId: "anika-k",
    invoke: async () => {
      throw new Error("down");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "missing_last_known_good");
  assert.equal(result.fabricated, false);
  assert.equal(result.advisory?.outcome, "blocked_no_lkg");
});

test("edge: model read down → queue advisory (blocked, not silent continue)", async () => {
  const loaded = loadDegradationRegistry();
  const queued = [];
  const result = await invokeModelDependency({
    registry: loaded.registry,
    operation: "read",
    subjectId: "anika-k",
    invoke: async () => {
      throw new Error("model provider down");
    },
    enqueue: (entry) => {
      queued.push(entry);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.behavior, "queue");
  assert.equal(result.queued, true);
  assert.equal(result.signalCode, "DEGRADE_QUEUE_AND_WARN");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].dependency, "model");
});

test("sovereignty: invoke requires subjectId; cross-subject not ambient", async () => {
  const loaded = loadDegradationRegistry();
  const missing = await invokeToolDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "  ",
    invoke: async () => {
      throw new Error("should not run");
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
  assert.equal(missing.invokeCount, 0);

  // Subject-scoped: advisory always carries the invoke subjectId, never swaps.
  const advisories = [];
  await invokeSyncDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "subject-a",
    invoke: async () => {
      throw new Error("down");
    },
    onAdvisory: (s) => advisories.push(s),
  });
  assert.equal(advisories[0].subjectId, "subject-a");
  assert.ok(advisories[0].subjectId !== "subject-b");
});
