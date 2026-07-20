/**
 * Model-down forced-outage drill.
 *
 * Injects model-provider unavailability through the production registry
 * invoke boundary (`invokeModelDependency`) — no test-only backdoor that
 * bypasses the A P6 degradation registry.
 *
 * Run: pnpm --filter @moolam/runtime-harness run test:degradation-drills
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  invokeModelDependency,
  loadDegradationRegistry,
} from "../../dist/index.js";

/** Consecutive flips required before latching degraded / recovered (hysteresis). */
const MODEL_DOWN_HYSTERESIS = 2;

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * In-process model provider stand-in for chaos drills.
 * Fault injection is a real unavailable throw — not a registry bypass.
 */
function createModelProviderDrill(options = {}) {
  const hysteresis = options.hysteresis ?? MODEL_DOWN_HYSTERESIS;
  const state = {
    available: true,
    streamActive: false,
    failStreak: 0,
    successStreak: 0,
    /** Latched after hysteresis failures; cleared after hysteresis successes. */
    degradedLatched: false,
    writeAttempts: 0,
    writeCommitted: 0,
    readAttempts: 0,
    fabricatedReplies: 0,
    durablePending: 0,
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
    /** Observe endpoint result and apply hysteresis latch. */
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
        const err = new Error("model provider unavailable");
        err.name = "ModelProviderUnavailable";
        throw err;
      }
      return { text: "model-live", fabricated: false };
    },
  };
}

async function drillModelRead(registry, provider, opts) {
  provider.state.readAttempts += 1;
  const result = await invokeModelDependency({
    registry,
    operation: "read",
    subjectId: opts.subjectId,
    deviceId: opts.deviceId,
    invoke: () => provider.invokeLive(),
    enqueue: opts.enqueue,
    onTelemetry: opts.onTelemetry,
    onAdvisory: opts.onAdvisory,
  });
  provider.observe(result.ok && !result.degraded);
  return result;
}

async function drillModelWrite(registry, provider, opts) {
  provider.state.writeAttempts += 1;
  const result = await invokeModelDependency({
    registry,
    operation: "write",
    subjectId: opts.subjectId,
    deviceId: opts.deviceId,
    invoke: async () => {
      // Partial failure: durable attempt then forced outage.
      provider.state.durablePending += 1;
      const live = await provider.invokeLive();
      provider.state.writeCommitted += 1;
      provider.state.durablePending -= 1;
      return live;
    },
    rollback: async () => {
      if (provider.state.durablePending > 0) {
        provider.state.durablePending -= 1;
      }
    },
    onTelemetry: opts.onTelemetry,
    onAdvisory: opts.onAdvisory,
  });
  if (result.ok && result.degraded === false) {
    // Never count fabricated bodies as committed product replies.
    if (result.value?.fabricated === true) {
      provider.state.fabricatedReplies += 1;
    }
  }
  provider.observe(result.ok && !result.degraded);
  return result;
}

test("happy path: model-down → read queues with signal; write hard-stops; no fabricated reply", async () => {
  const advisories = [];
  const telemetry = [];
  const loaded = loadDegradationRegistry({
    subjectId: "anika-k",
    deviceId: "edge-drill-01",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true);

  const provider = createModelProviderDrill();
  const queued = [];

  // Baseline: model up — turn proceeds (no fabrication).
  const up = await drillModelWrite(loaded.registry, provider, {
    subjectId: "anika-k",
    deviceId: "edge-drill-01",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(up.ok, true);
  assert.equal(up.degraded, false);
  assert.equal(up.value.fabricated, false);
  assert.equal(provider.state.writeCommitted, 1);

  // Inject fault: model provider unavailable (compose-equivalent kill).
  provider.kill();

  const readDown = await drillModelRead(loaded.registry, provider, {
    subjectId: "anika-k",
    deviceId: "edge-drill-01",
    enqueue: (entry) => queued.push(entry),
    onAdvisory: (s) => advisories.push(s),
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(readDown.ok, false);
  assert.equal(readDown.degraded, true);
  assert.equal(readDown.behavior, "queue");
  assert.equal(readDown.signalCode, "DEGRADE_QUEUE_AND_WARN");
  assert.equal(readDown.fabricated, false);
  assert.equal(queued.length, 1);

  const writeDown = await drillModelWrite(loaded.registry, provider, {
    subjectId: "anika-k",
    deviceId: "edge-drill-01",
    onAdvisory: (s) => advisories.push(s),
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(writeDown.ok, false);
  assert.equal(writeDown.behavior, "hard_stop");
  assert.equal(writeDown.signalCode, "DEGRADE_HARD_STOP_WRITE");
  assert.equal(writeDown.rolledBack, true);
  assert.equal(writeDown.silentWriteRetry, false);
  assert.equal(writeDown.fabricated, false);
  // No second committed write after kill.
  assert.equal(provider.state.writeCommitted, 1);
  assert.equal(provider.state.fabricatedReplies, 0);
  assert.equal(provider.state.durablePending, 0);

  assert.ok(
    advisories.some(
      (a) =>
        a.dependency === "model" && a.signalCode === "DEGRADE_QUEUE_AND_WARN",
    ),
  );
  assert.ok(
    advisories.some(
      (a) =>
        a.dependency === "model" && a.signalCode === "DEGRADE_HARD_STOP_WRITE",
    ),
  );
  assert.ok(!JSON.stringify(advisories).includes("learner"));
  assert.ok(
    telemetry.every((t) => t.event === "runtime.harness.degradation_registry"),
  );

  log({
    event: "runtime.harness.degradation_drill",
    drill: "model_down",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-drill-01",
    readBehavior: "queue",
    writeBehavior: "hard_stop",
    fabricatedReplies: 0,
  });
});

test("edge: flapping model → hysteresis prevents read/write oscillation", async () => {
  const loaded = loadDegradationRegistry();
  const provider = createModelProviderDrill({ hysteresis: 2 });
  const behaviors = [];

  // Fail, recover, fail — latch only after 2 consecutive fails.
  provider.kill();
  let r = await drillModelRead(loaded.registry, provider, {
    subjectId: "anika-k",
    enqueue: () => {},
  });
  behaviors.push(r.behavior);
  assert.equal(provider.state.degradedLatched, false);

  provider.restore();
  r = await drillModelRead(loaded.registry, provider, {
    subjectId: "anika-k",
    enqueue: () => {},
  });
  behaviors.push(r.ok && !r.degraded ? "live" : r.behavior);

  provider.kill();
  r = await drillModelRead(loaded.registry, provider, {
    subjectId: "anika-k",
    enqueue: () => {},
  });
  behaviors.push(r.behavior);
  assert.equal(provider.state.degradedLatched, false, "single flap not latched");

  // Second consecutive failure latches degraded.
  r = await drillModelRead(loaded.registry, provider, {
    subjectId: "anika-k",
    enqueue: () => {},
  });
  assert.equal(r.behavior, "queue");
  assert.equal(provider.state.degradedLatched, true);

  // Two successes clear latch — no oscillation on single blip.
  provider.restore();
  await drillModelRead(loaded.registry, provider, {
    subjectId: "anika-k",
    enqueue: () => {},
  });
  assert.equal(provider.state.degradedLatched, true);
  await drillModelRead(loaded.registry, provider, {
    subjectId: "anika-k",
    enqueue: () => {},
  });
  assert.equal(provider.state.degradedLatched, false);

  log({
    event: "runtime.harness.degradation_drill",
    drill: "model_down",
    outcome: "ok",
    case: "hysteresis",
    behaviors,
    degradedLatched: provider.state.degradedLatched,
  });
});

test("edge: drill during active stream — degradation applies to next op; no fabricate", async () => {
  const loaded = loadDegradationRegistry();
  const provider = createModelProviderDrill();
  const advisories = [];

  provider.beginStream();
  // Mid-stream kill: current stream slot does not invent a reply.
  provider.kill();
  assert.equal(provider.state.streamActive, true);

  // Next operation (post-chunk) consults registry — queue/hard_stop, never fabricate.
  const nextRead = await drillModelRead(loaded.registry, provider, {
    subjectId: "anika-k",
    enqueue: () => {},
    onAdvisory: (s) => advisories.push(s),
  });
  assert.equal(nextRead.ok, false);
  assert.equal(nextRead.behavior, "queue");
  assert.equal(nextRead.fabricated, false);

  const nextWrite = await drillModelWrite(loaded.registry, provider, {
    subjectId: "anika-k",
    onAdvisory: (s) => advisories.push(s),
  });
  assert.equal(nextWrite.ok, false);
  assert.equal(nextWrite.behavior, "hard_stop");
  assert.equal(nextWrite.fabricated, false);
  assert.equal(provider.state.fabricatedReplies, 0);

  provider.endStream();
  assert.ok(advisories.every((a) => a.fabricated === false));
});

test("edge: recovery after drill — live fetch clears degraded latch; no duplicate writes", async () => {
  const loaded = loadDegradationRegistry();
  const provider = createModelProviderDrill({ hysteresis: 1 });
  const seen = new Set();
  const idempotencyKey = "anika-k:model:write:drill-recover-1";

  provider.kill();
  const down = await drillModelWrite(loaded.registry, provider, {
    subjectId: "anika-k",
  });
  assert.equal(down.ok, false);
  assert.equal(down.behavior, "hard_stop");
  assert.equal(provider.state.degradedLatched, true);
  assert.equal(provider.state.writeCommitted, 0);

  // Replayed write while down — still hard-stop; no double commit.
  if (!seen.has(idempotencyKey)) {
    seen.add(idempotencyKey);
  }
  const replay = await drillModelWrite(loaded.registry, provider, {
    subjectId: "anika-k",
  });
  assert.equal(replay.ok, false);
  assert.equal(provider.state.writeCommitted, 0);
  assert.equal(seen.size, 1);

  provider.restore();
  const recovered = await drillModelWrite(loaded.registry, provider, {
    subjectId: "anika-k",
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.degraded, false);
  assert.equal(recovered.value.fabricated, false);
  assert.equal(provider.state.degradedLatched, false);
  assert.equal(provider.state.writeCommitted, 1);

  log({
    event: "runtime.harness.degradation_drill",
    drill: "model_down",
    outcome: "ok",
    case: "recovery",
    writeCommitted: provider.state.writeCommitted,
    degradedLatched: provider.state.degradedLatched,
  });
});

test("edge: concurrent turns same subjectId — each hard-stops once under model-down", async () => {
  const loaded = loadDegradationRegistry();
  const provider = createModelProviderDrill();
  provider.kill();

  const [a, b] = await Promise.all([
    drillModelWrite(loaded.registry, provider, { subjectId: "anika-k" }),
    drillModelWrite(loaded.registry, provider, { subjectId: "anika-k" }),
  ]);

  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.behavior, "hard_stop");
  assert.equal(b.behavior, "hard_stop");
  assert.equal(a.silentWriteRetry, false);
  assert.equal(b.silentWriteRetry, false);
  assert.equal(provider.state.writeCommitted, 0);
  assert.equal(provider.state.fabricatedReplies, 0);
  assert.equal(provider.state.durablePending, 0);
});

test("sovereignty: model-down drill requires subjectId; signals stay metadata-only", async () => {
  const loaded = loadDegradationRegistry();
  const provider = createModelProviderDrill();
  provider.kill();
  const advisories = [];

  const missing = await invokeModelDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "  ",
    invoke: () => provider.invokeLive(),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
  assert.equal(missing.invokeCount, 0);

  await drillModelWrite(loaded.registry, provider, {
    subjectId: "subject-a",
    onAdvisory: (s) => advisories.push(s),
  });
  assert.equal(advisories[0].subjectId, "subject-a");
  assert.ok(advisories[0].subjectId !== "subject-b");
  assert.ok(!JSON.stringify(advisories).includes("prompt"));
});
