/**
 * Sync-down forced-outage drill.
 *
 * Injects sync-transport unavailability through the production registry
 * invoke boundary (`invokeSyncDependency`) — no test-only backdoor.
 *
 * Registry default: sync read → stale_with_marker; sync write → hard_stop.
 * Run: pnpm --filter @moolam/runtime-harness run test:degradation-drills
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertStaleReadPayload } from "@moolam/sync-protocol";
import {
  invokeSyncDependency,
  loadDegradationRegistry,
} from "../../dist/index.js";

const SYNC_DOWN_HYSTERESIS = 2;

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * In-process sync transport stand-in for chaos drills.
 * Fault injection is a real unavailable throw — not a registry bypass.
 */
function createSyncTransportDrill(options = {}) {
  const hysteresis = options.hysteresis ?? SYNC_DOWN_HYSTERESIS;
  const state = {
    available: true,
    streamActive: false,
    failStreak: 0,
    successStreak: 0,
    degradedLatched: false,
    writeAttempts: 0,
    writeCommitted: 0,
    readAttempts: 0,
    durablePending: 0,
    fabricatedCitations: 0,
    lastKnownGood: {
      stateVector: { d1: 3 },
      local: true,
      fabricated: false,
    },
    capturedAt: "2026-07-15T14:00:00.000Z",
  };

  return {
    state,
    kill() {
      state.available = false;
    },
    restore() {
      state.available = true;
    },
    beginStream() {
      state.streamActive = true;
    },
    endStream() {
      state.streamActive = false;
    },
    observe(ok) {
      if (ok) {
        state.successStreak += 1;
        state.failStreak = 0;
        if (state.successStreak >= hysteresis) {
          state.degradedLatched = false;
        }
      } else {
        state.failStreak += 1;
        state.successStreak = 0;
        if (state.failStreak >= hysteresis) {
          state.degradedLatched = true;
        }
      }
    },
    async invokeLive() {
      if (!state.available) {
        const err = new Error("sync transport unavailable");
        err.name = "SyncTransportUnavailable";
        throw err;
      }
      return {
        stateVector: { d1: 4 },
        local: false,
        fabricated: false,
      };
    },
  };
}

async function drillSyncRead(registry, transport, opts) {
  transport.state.readAttempts += 1;
  const withLkg = opts.withLastKnownGood !== false;
  const result = await invokeSyncDependency({
    registry,
    operation: "read",
    subjectId: opts.subjectId,
    deviceId: opts.deviceId,
    ...(withLkg
      ? {
          lastKnownGood: transport.state.lastKnownGood,
          capturedAt: transport.state.capturedAt,
          freshnessSource: "last-known-good",
        }
      : {}),
    invoke: () => transport.invokeLive(),
    onTelemetry: opts.onTelemetry,
    onAdvisory: opts.onAdvisory,
  });
  transport.observe(result.ok && !result.degraded);
  return result;
}

async function drillSyncWrite(registry, transport, opts) {
  transport.state.writeAttempts += 1;
  const result = await invokeSyncDependency({
    registry,
    operation: "write",
    subjectId: opts.subjectId,
    deviceId: opts.deviceId,
    invoke: async () => {
      transport.state.durablePending += 1;
      const live = await transport.invokeLive();
      transport.state.writeCommitted += 1;
      transport.state.durablePending -= 1;
      return live;
    },
    rollback: async () => {
      if (transport.state.durablePending > 0) {
        transport.state.durablePending -= 1;
      }
    },
    enqueue: opts.enqueue,
    onTelemetry: opts.onTelemetry,
    onAdvisory: opts.onAdvisory,
  });
  if (
    result.ok &&
    result.degraded &&
    result.behavior === "stale_with_marker" &&
    result.value?.fabricated === true
  ) {
    transport.state.fabricatedCitations += 1;
  }
  transport.observe(result.ok && !result.degraded);
  return result;
}

test("happy path: sync-down → read stale_with_marker; write hard-stops; no fabrication", async () => {
  const advisories = [];
  const telemetry = [];
  const loaded = loadDegradationRegistry({
    subjectId: "anika-k",
    deviceId: "edge-sync-01",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true);

  const transport = createSyncTransportDrill();

  const up = await drillSyncWrite(loaded.registry, transport, {
    subjectId: "anika-k",
    deviceId: "edge-sync-01",
  });
  assert.equal(up.ok, true);
  assert.equal(up.degraded, false);
  assert.equal(transport.state.writeCommitted, 1);

  transport.kill();

  const readDown = await drillSyncRead(loaded.registry, transport, {
    subjectId: "anika-k",
    deviceId: "edge-sync-01",
    onAdvisory: (s) => advisories.push(s),
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(readDown.ok, true);
  assert.equal(readDown.degraded, true);
  assert.equal(readDown.behavior, "stale_with_marker");
  assert.equal(readDown.signalCode, "DEGRADE_STALE_READ");
  assert.equal(readDown.fabricated, false);
  assert.equal(readDown.freshnessMarker.source, "last-known-good");
  const asserted = assertStaleReadPayload(readDown.payload, {
    subjectId: "anika-k",
  });
  assert.equal(asserted.ok, true);

  const writeDown = await drillSyncWrite(loaded.registry, transport, {
    subjectId: "anika-k",
    deviceId: "edge-sync-01",
    onAdvisory: (s) => advisories.push(s),
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(writeDown.ok, false);
  assert.equal(writeDown.behavior, "hard_stop");
  assert.equal(writeDown.signalCode, "DEGRADE_HARD_STOP_WRITE");
  assert.equal(writeDown.rolledBack, true);
  assert.equal(writeDown.silentWriteRetry, false);
  assert.equal(transport.state.writeCommitted, 1);
  assert.equal(transport.state.durablePending, 0);
  assert.equal(transport.state.fabricatedCitations, 0);

  assert.ok(
    advisories.some(
      (a) => a.dependency === "sync" && a.signalCode === "DEGRADE_STALE_READ",
    ),
  );
  assert.ok(
    advisories.some(
      (a) =>
        a.dependency === "sync" && a.signalCode === "DEGRADE_HARD_STOP_WRITE",
    ),
  );
  assert.ok(!JSON.stringify(advisories).includes("learner"));

  log({
    event: "runtime.harness.degradation_drill",
    drill: "sync_down",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-sync-01",
    readBehavior: "stale_with_marker",
    writeBehavior: "hard_stop",
    fabricatedCitations: 0,
  });
});

test("edge: sync-down without LKG blocks — never fabricates stale payload", async () => {
  const loaded = loadDegradationRegistry();
  const transport = createSyncTransportDrill();
  transport.kill();

  const blocked = await drillSyncRead(loaded.registry, transport, {
    subjectId: "anika-k",
    withLastKnownGood: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failureClass, "missing_last_known_good");
  assert.equal(blocked.fabricated, false);
  assert.equal(blocked.advisory?.outcome, "blocked_no_lkg");
});

test("edge: flapping sync → hysteresis prevents read/write oscillation", async () => {
  const loaded = loadDegradationRegistry();
  const transport = createSyncTransportDrill({ hysteresis: 2 });

  transport.kill();
  await drillSyncRead(loaded.registry, transport, { subjectId: "anika-k" });
  assert.equal(transport.state.degradedLatched, false);

  transport.restore();
  await drillSyncRead(loaded.registry, transport, { subjectId: "anika-k" });

  transport.kill();
  await drillSyncRead(loaded.registry, transport, { subjectId: "anika-k" });
  assert.equal(transport.state.degradedLatched, false, "single flap not latched");

  await drillSyncRead(loaded.registry, transport, { subjectId: "anika-k" });
  assert.equal(transport.state.degradedLatched, true);

  transport.restore();
  await drillSyncRead(loaded.registry, transport, { subjectId: "anika-k" });
  assert.equal(transport.state.degradedLatched, true);
  await drillSyncRead(loaded.registry, transport, { subjectId: "anika-k" });
  assert.equal(transport.state.degradedLatched, false);

  log({
    event: "runtime.harness.degradation_drill",
    drill: "sync_down",
    outcome: "ok",
    case: "hysteresis",
    degradedLatched: transport.state.degradedLatched,
  });
});

test("edge: sync drill during active stream — next op degrades; recovery clears latch", async () => {
  const loaded = loadDegradationRegistry();
  const transport = createSyncTransportDrill({ hysteresis: 1 });
  const seen = new Set();
  const idempotencyKey = "anika-k:sync:write:drill-recover-1";

  transport.beginStream();
  transport.kill();
  assert.equal(transport.state.streamActive, true);

  const nextRead = await drillSyncRead(loaded.registry, transport, {
    subjectId: "anika-k",
  });
  assert.equal(nextRead.degraded, true);
  assert.equal(nextRead.behavior, "stale_with_marker");
  assert.equal(nextRead.fabricated, false);

  const nextWrite = await drillSyncWrite(loaded.registry, transport, {
    subjectId: "anika-k",
  });
  assert.equal(nextWrite.ok, false);
  assert.equal(nextWrite.behavior, "hard_stop");
  assert.equal(transport.state.writeCommitted, 0);

  if (!seen.has(idempotencyKey)) {
    seen.add(idempotencyKey);
  }
  const replay = await drillSyncWrite(loaded.registry, transport, {
    subjectId: "anika-k",
  });
  assert.equal(replay.ok, false);
  assert.equal(transport.state.writeCommitted, 0);
  assert.equal(seen.size, 1);

  transport.endStream();
  transport.restore();
  const recovered = await drillSyncWrite(loaded.registry, transport, {
    subjectId: "anika-k",
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.degraded, false);
  assert.equal(transport.state.degradedLatched, false);
  assert.equal(transport.state.writeCommitted, 1);
});

test("edge: concurrent sync writes same subjectId — each hard-stops; no double apply", async () => {
  const loaded = loadDegradationRegistry();
  const transport = createSyncTransportDrill();
  transport.kill();

  const [a, b] = await Promise.all([
    drillSyncWrite(loaded.registry, transport, { subjectId: "anika-k" }),
    drillSyncWrite(loaded.registry, transport, { subjectId: "anika-k" }),
  ]);

  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.behavior, "hard_stop");
  assert.equal(b.behavior, "hard_stop");
  assert.equal(a.silentWriteRetry, false);
  assert.equal(b.silentWriteRetry, false);
  assert.equal(transport.state.writeCommitted, 0);
  assert.equal(transport.state.durablePending, 0);
});

test("sovereignty: sync-down drill requires subjectId; signals metadata-only", async () => {
  const loaded = loadDegradationRegistry();
  const transport = createSyncTransportDrill();
  transport.kill();
  const advisories = [];

  const missing = await invokeSyncDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "  ",
    invoke: () => transport.invokeLive(),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
  assert.equal(missing.invokeCount, 0);

  await drillSyncWrite(loaded.registry, transport, {
    subjectId: "subject-a",
    onAdvisory: (s) => advisories.push(s),
  });
  assert.equal(advisories[0].subjectId, "subject-a");
  assert.ok(advisories[0].subjectId !== "subject-b");
  assert.ok(!JSON.stringify(advisories).includes("utterance"));
});
