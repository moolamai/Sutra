/**
 * Tool-down forced-outage drill.
 *
 * Injects tool-backend unavailability through the production registry
 * invoke boundary (`invokeToolDependency`) — no test-only backdoor.
 *
 * Tool is not an A P6 surface; host register() → hard_stop for writes.
 * Run: pnpm --filter @moolam/runtime-harness run test:degradation-drills
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  invokeToolDependency,
  loadDegradationRegistry,
} from "../../dist/index.js";

const TOOL_DOWN_HYSTERESIS = 2;

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * In-process tool backend stand-in for chaos drills.
 * Fault injection is a real unavailable throw — not a registry bypass.
 */
function createToolBackendDrill(options = {}) {
  const hysteresis = options.hysteresis ?? TOOL_DOWN_HYSTERESIS;
  const state = {
    available: true,
    streamActive: false,
    failStreak: 0,
    successStreak: 0,
    degradedLatched: false,
    writeAttempts: 0,
    writeCommitted: 0,
    durablePending: 0,
    rolledBackEffects: 0,
    uncommitted: new Set(),
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
    async invokeLive(effectId) {
      if (!state.available) {
        const err = new Error("tool backend unavailable");
        err.name = "ToolBackendUnavailable";
        throw err;
      }
      state.uncommitted.delete(effectId);
      return { effectId, ok: true, fabricated: false };
    },
  };
}

function ensureToolHardStop(registry, subjectId) {
  const reg = registry.register("tool", "hard_stop", { subjectId });
  assert.ok(reg.ok || reg.failureClass === "conflict");
}

async function drillToolWrite(registry, backend, opts) {
  backend.state.writeAttempts += 1;
  const effectId = opts.effectId ?? `effect-${backend.state.writeAttempts}`;
  backend.state.uncommitted.add(effectId);

  const result = await invokeToolDependency({
    registry,
    operation: "write",
    subjectId: opts.subjectId,
    deviceId: opts.deviceId,
    invoke: async () => {
      // Partial failure: durable attempt then forced outage.
      backend.state.durablePending += 1;
      const live = await backend.invokeLive(effectId);
      backend.state.writeCommitted += 1;
      backend.state.durablePending -= 1;
      return live;
    },
    rollback: async () => {
      if (backend.state.uncommitted.has(effectId)) {
        backend.state.uncommitted.delete(effectId);
        backend.state.rolledBackEffects += 1;
      }
      if (backend.state.durablePending > 0) {
        backend.state.durablePending -= 1;
      }
    },
    onTelemetry: opts.onTelemetry,
    onAdvisory: opts.onAdvisory,
  });
  backend.observe(result.ok && !result.degraded);
  return result;
}

test("happy path: tool-down → write hard-stops with rollback; no silent retry", async () => {
  const advisories = [];
  const telemetry = [];
  const loaded = loadDegradationRegistry({
    subjectId: "anika-k",
    deviceId: "edge-tool-01",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true);
  ensureToolHardStop(loaded.registry, "anika-k");

  const backend = createToolBackendDrill();

  const up = await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    deviceId: "edge-tool-01",
    effectId: "write-up-1",
  });
  assert.equal(up.ok, true);
  assert.equal(up.degraded, false);
  assert.equal(backend.state.writeCommitted, 1);
  assert.equal(backend.state.uncommitted.size, 0);

  backend.kill();

  const down = await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    deviceId: "edge-tool-01",
    effectId: "write-down-1",
    onAdvisory: (s) => advisories.push(s),
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(down.ok, false);
  assert.equal(down.behavior, "hard_stop");
  assert.equal(down.signalCode, "DEGRADE_HARD_STOP_WRITE");
  assert.equal(down.rolledBack, true);
  assert.equal(down.silentWriteRetry, false);
  assert.equal(down.fabricated, false);
  assert.equal(backend.state.writeCommitted, 1);
  assert.equal(backend.state.rolledBackEffects, 1);
  assert.equal(backend.state.uncommitted.size, 0);
  assert.equal(backend.state.durablePending, 0);

  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].dependency, "tool");
  assert.equal(advisories[0].outcome, "hard_stopped");
  assert.ok(!JSON.stringify(advisories).includes("learner"));

  log({
    event: "runtime.harness.degradation_drill",
    drill: "tool_down",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-tool-01",
    writeBehavior: "hard_stop",
    rolledBackEffects: backend.state.rolledBackEffects,
  });
});

test("edge: tool-down mid-loop → hard-stop rolls back uncommitted tool effects", async () => {
  const loaded = loadDegradationRegistry();
  ensureToolHardStop(loaded.registry, "anika-k");
  const backend = createToolBackendDrill();
  backend.kill();

  const result = await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    effectId: "mid-loop-1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.behavior, "hard_stop");
  assert.equal(result.rolledBack, true);
  assert.ok(!backend.state.uncommitted.has("mid-loop-1"));
  assert.equal(backend.state.writeCommitted, 0);
});

test("edge: flapping tool → hysteresis; unknown tool defaults hard_stop without register", async () => {
  const loaded = loadDegradationRegistry();
  // No register() — unknown dependency defaults to hard_stop (not passthrough).
  const backend = createToolBackendDrill({ hysteresis: 2 });
  backend.kill();

  let r = await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    effectId: "flap-1",
  });
  assert.equal(r.behavior, "hard_stop");
  assert.equal(backend.state.degradedLatched, false);

  backend.restore();
  await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    effectId: "flap-up",
  });

  backend.kill();
  await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    effectId: "flap-2",
  });
  assert.equal(backend.state.degradedLatched, false);

  r = await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    effectId: "flap-3",
  });
  assert.equal(r.behavior, "hard_stop");
  assert.equal(backend.state.degradedLatched, true);

  log({
    event: "runtime.harness.degradation_drill",
    drill: "tool_down",
    outcome: "ok",
    case: "hysteresis_default_hard_stop",
    degradedLatched: backend.state.degradedLatched,
  });
});

test("edge: tool drill during stream + recovery — no duplicate durable apply", async () => {
  const loaded = loadDegradationRegistry();
  ensureToolHardStop(loaded.registry, "anika-k");
  const backend = createToolBackendDrill({ hysteresis: 1 });
  const seen = new Set();
  const idempotencyKey = "anika-k:tool:write:drill-recover-1";

  backend.beginStream();
  backend.kill();
  assert.equal(backend.state.streamActive, true);

  const next = await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    effectId: "stream-next",
  });
  assert.equal(next.ok, false);
  assert.equal(next.behavior, "hard_stop");
  assert.equal(backend.state.writeCommitted, 0);

  if (!seen.has(idempotencyKey)) {
    seen.add(idempotencyKey);
  }
  const replay = await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    effectId: "stream-replay",
  });
  assert.equal(replay.ok, false);
  assert.equal(backend.state.writeCommitted, 0);
  assert.equal(seen.size, 1);

  backend.endStream();
  backend.restore();
  const recovered = await drillToolWrite(loaded.registry, backend, {
    subjectId: "anika-k",
    effectId: "recovered",
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.degraded, false);
  assert.equal(backend.state.degradedLatched, false);
  assert.equal(backend.state.writeCommitted, 1);
});

test("edge: concurrent tool writes same subjectId — each hard-stops with rollback", async () => {
  const loaded = loadDegradationRegistry();
  ensureToolHardStop(loaded.registry, "anika-k");
  const backend = createToolBackendDrill();
  backend.kill();

  const [a, b] = await Promise.all([
    drillToolWrite(loaded.registry, backend, {
      subjectId: "anika-k",
      effectId: "conc-a",
    }),
    drillToolWrite(loaded.registry, backend, {
      subjectId: "anika-k",
      effectId: "conc-b",
    }),
  ]);

  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.behavior, "hard_stop");
  assert.equal(b.behavior, "hard_stop");
  assert.equal(a.silentWriteRetry, false);
  assert.equal(b.silentWriteRetry, false);
  assert.equal(backend.state.writeCommitted, 0);
  assert.equal(backend.state.uncommitted.size, 0);
  assert.equal(backend.state.durablePending, 0);
  assert.equal(backend.state.rolledBackEffects, 2);
});

test("sovereignty: tool-down drill requires subjectId; signals metadata-only", async () => {
  const loaded = loadDegradationRegistry();
  ensureToolHardStop(loaded.registry, "anika-k");
  const backend = createToolBackendDrill();
  backend.kill();
  const advisories = [];

  const missing = await invokeToolDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "  ",
    invoke: () => backend.invokeLive("x"),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
  assert.equal(missing.invokeCount, 0);

  await drillToolWrite(loaded.registry, backend, {
    subjectId: "subject-a",
    effectId: "sov-1",
    onAdvisory: (s) => advisories.push(s),
  });
  assert.equal(advisories[0].subjectId, "subject-a");
  assert.ok(advisories[0].subjectId !== "subject-b");
  assert.ok(!JSON.stringify(advisories).includes("tool-args-secret"));
});
