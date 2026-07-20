/**
 * flushMeter → METER_TICK frames + P3 harness.meter spine.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TurnMeter,
  StreamingTurnHost,
  buildHarnessMeterRuntimeEvent,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fakeBus() {
  const events = [];
  return {
    events,
    publish(event) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
  };
}

function hostWithMeter(overrides = {}) {
  let t = 1_000;
  const turnMeter = new TurnMeter({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    modelId: "slm-local",
    locality: "on-device",
    startedAtMs: 1_000,
    now: () => {
      t += 35;
      return t;
    },
  });
  const bus = fakeBus();
  const frames = [];
  const telemetry = [];
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-meter-emit",
    deviceId: "edge-aaaa",
    sessionId: "sess-1",
    turnMeter,
    eventBus: bus,
    onFrame: (f) => frames.push(f),
    onTelemetry: (e) => telemetry.push(e),
    ...overrides,
  });
  host.emitSessionStart("2026-07-15T00:00:00.000Z");
  return { host, turnMeter, bus, frames, telemetry };
}

test("happy path: flushMeter emits METER_TICK and harness.meter spine", () => {
  const { host, turnMeter, bus, frames, telemetry } = hostWithMeter();
  turnMeter.record({
    freshInputTokens: 12,
    cachedInputTokens: 2,
    outputTokens: 4,
    totalPromptTokens: 14,
  });

  const result = host.flushMeter();
  assert.equal(result.ok, true);
  assert.equal(result.framesEmitted, 1);
  assert.equal(result.spinePublished, 1);
  assert.equal(result.discrepancy, false);
  assert.equal(result.totalPromptTokens, 14);

  const meterFrames = frames.filter((f) => f.type === "METER_TICK");
  assert.equal(meterFrames.length, 1);
  assert.equal(meterFrames[0].tick.inputTokens, 12);
  assert.equal(meterFrames[0].tick.cachedInputTokens, 2);
  assert.equal(meterFrames[0].subjectId, "anika-k");

  assert.equal(bus.events.length, 1);
  assert.equal(bus.events[0].type, "harness.meter");
  assert.equal(bus.events[0].payload.subjectId, "anika-k");
  assert.equal(bus.events[0].payload.sessionId, "sess-1");
  assert.equal(bus.events[0].payload.inputTokens, 12);
  assert.equal(bus.events[0].payload.cachedInputTokens, 2);
  assert.equal(bus.events[0].payload.aborted, false);
  // Never leak content keys onto the spine.
  assert.equal("prompt" in bus.events[0].payload, false);
  assert.equal("completion" in bus.events[0].payload, false);

  assert.ok(
    telemetry.some(
      (e) => e.event === "runtime.harness.meter_emit" && e.outcome === "ok",
    ),
  );

  const complete = host.emitTurnComplete("turn-1");
  assert.equal(complete.ok, true);

  log({
    event: "runtime.harness.meter_emit",
    outcome: "ok",
    case: "meter_tick_and_spine",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
});

test("edge: cache-hit-only turn emits valid METER_TICK with fresh=0", () => {
  const { host, turnMeter, bus } = hostWithMeter();
  turnMeter.record({
    freshInputTokens: 0,
    cachedInputTokens: 48,
    outputTokens: 0,
  });
  const result = host.flushMeter();
  assert.equal(result.ok, true);
  assert.equal(result.events[0].inputTokens, 0);
  assert.equal(result.events[0].cachedInputTokens, 48);
  assert.equal(bus.events[0].payload.cachedInputTokens, 48);
});

test("edge: multi-model flush emits one METER_TICK + spine event per modelId", () => {
  const { host, turnMeter, bus, frames } = hostWithMeter();
  turnMeter.record({ freshInputTokens: 10, cachedInputTokens: 5, outputTokens: 1 });
  turnMeter.record({
    modelId: "cloud-handoff",
    locality: "external-api",
    freshInputTokens: 3,
    outputTokens: 2,
  });
  const result = host.flushMeter();
  assert.equal(result.ok, true);
  assert.equal(result.framesEmitted, 2);
  assert.equal(result.spinePublished, 2);
  const ticks = frames.filter((f) => f.type === "METER_TICK");
  assert.equal(ticks[0].tick.modelId, "slm-local");
  assert.equal(ticks[1].tick.modelId, "cloud-handoff");
  assert.equal(bus.events[1].payload.locality, "external-api");
});

test("edge: abort via terminateWithError still emits aborted metering", () => {
  const { host, turnMeter, bus, frames } = hostWithMeter();
  turnMeter.record({ freshInputTokens: 8, outputTokens: 1 });
  const err = host.terminateWithError({
    code: "AGENT_MANUAL_ABORT",
    message: "abort",
    recoverable: false,
  });
  assert.equal(err.ok, true);
  assert.equal(turnMeter.isAborted, true);
  assert.equal(turnMeter.isFlushed, true);

  const ticks = frames.filter((f) => f.type === "METER_TICK");
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].tick.aborted, true);
  assert.equal(bus.events[0].payload.aborted, true);
  assert.equal(bus.events[0].payload.inputTokens, 8);
});

test("edge: flushMeter replay is idempotent (no double spine / frames)", () => {
  const { host, turnMeter, bus, frames } = hostWithMeter();
  turnMeter.record({ freshInputTokens: 5, cachedInputTokens: 1, outputTokens: 2 });
  const first = host.flushMeter();
  const second = host.flushMeter();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replay, true);
  assert.equal(frames.filter((f) => f.type === "METER_TICK").length, 1);
  assert.equal(bus.events.length, 1);
});

test("edge: provider discrepancy flag retained on emit", () => {
  const { host, turnMeter } = hostWithMeter();
  turnMeter.record({
    freshInputTokens: 12,
    cachedInputTokens: 2,
    outputTokens: 4,
  });
  turnMeter.setProviderUsage({
    inputTokens: 15,
    cachedInputTokens: 0,
    outputTokens: 4,
  });
  const result = host.flushMeter();
  assert.equal(result.ok, true);
  assert.equal(result.discrepancy, true);
  // Local tick still emitted with local split (not conflated).
  assert.equal(result.events[0].inputTokens, 12);
  assert.equal(result.events[0].cachedInputTokens, 2);
});

test("sovereignty: missing meter and content-free spine builder", () => {
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-no-meter",
  });
  host.emitSessionStart("2026-07-15T00:00:00.000Z");
  const missing = host.flushMeter();
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_meter");

  const built = buildHarnessMeterRuntimeEvent(
    {
      inputTokens: 1,
      outputTokens: 0,
      cachedInputTokens: 0,
      latencyMs: 1,
      modelId: "slm-local",
      locality: "on-device",
      aborted: false,
    },
    { subjectId: "anika-k", deviceId: "edge-aaaa" },
  );
  assert.equal(built.ok, true);
  assert.equal(built.event.payload.subjectId, "anika-k");
  assert.equal("text" in built.event.payload, false);

  const noSubject = buildHarnessMeterRuntimeEvent(
    {
      inputTokens: 1,
      outputTokens: 0,
      cachedInputTokens: 0,
      latencyMs: 1,
      modelId: "slm-local",
      locality: "on-device",
      aborted: false,
    },
    { subjectId: "" },
  );
  assert.equal(noSubject.ok, false);
  assert.equal(noSubject.failureClass, "missing_subject");
});
