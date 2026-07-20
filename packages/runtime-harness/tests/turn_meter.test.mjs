/**
 * TurnMeter collector — cached vs fresh input split.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TURN_METER_SEGMENT_LIMIT,
  TurnMeter,
  StreamingTurnHost,
} from "../dist/index.js";
import {
  meterEventSchema,
  reconcileMeterTokens,
} from "@moolam/sync-protocol";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function meter(overrides = {}) {
  let t = 1_000;
  return new TurnMeter({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    modelId: "slm-local",
    locality: "on-device",
    startedAtMs: 1_000,
    now: () => {
      t += 35;
      return t;
    },
    ...overrides,
  });
}

test("happy path: accumulate cached vs fresh; flush validates MeterEvent", () => {
  const m = meter();
  const rec = m.record({
    freshInputTokens: 12,
    cachedInputTokens: 2,
    outputTokens: 4,
    totalPromptTokens: 14,
  });
  assert.equal(rec.ok, true);
  assert.equal(rec.totalPromptTokens, 14);

  const flushed = m.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.events.length, 1);
  assert.equal(flushed.totalPromptTokens, 14);
  assert.equal(flushed.totals.inputTokens, 12);
  assert.equal(flushed.totals.cachedInputTokens, 2);
  assert.equal(flushed.totals.outputTokens, 4);
  assert.equal(flushed.discrepancy, false);
  assert.equal(flushed.aborted, false);

  const event = meterEventSchema.parse(flushed.events[0]);
  assert.equal(event.inputTokens, 12);
  assert.equal(event.cachedInputTokens, 2);
  assert.equal(event.modelId, "slm-local");
  assert.equal(event.latencyMs, 35);

  // Host attach for stream path (emit of METER_TICK is a later slice).
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-meter-01",
    deviceId: "edge-aaaa",
    turnMeter: meter(),
  });
  assert.equal(host.meter?.subjectId, "anika-k");

  log({
    event: "runtime.harness.turn_meter",
    outcome: "ok",
    case: "cached_vs_fresh",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
});

test("edge: zero fresh tokens with cache hit only is valid", () => {
  const m = meter();
  assert.equal(
    m.record({
      freshInputTokens: 0,
      cachedInputTokens: 48,
      outputTokens: 0,
      totalPromptTokens: 48,
    }).ok,
    true,
  );
  const flushed = m.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.events[0].inputTokens, 0);
  assert.equal(flushed.events[0].cachedInputTokens, 48);
  assert.equal(flushed.totalPromptTokens, 48);
});

test("edge: abort still flushes partial spend with aborted true", () => {
  const m = meter();
  m.record({ freshInputTokens: 8, outputTokens: 1 });
  m.markAborted();
  const flushed = m.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.aborted, true);
  assert.equal(flushed.events[0].aborted, true);
  assert.equal(flushed.events[0].inputTokens, 8);
  assert.equal(flushed.events[0].outputTokens, 1);

  // terminateWithError on host marks attached meter aborted
  const hostMeter = meter();
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-meter-abort",
    turnMeter: hostMeter,
  });
  host.emitSessionStart("2026-07-15T00:00:00.000Z");
  hostMeter.record({ freshInputTokens: 3, outputTokens: 1 });
  host.terminateWithError({
    code: "AGENT_MANUAL_ABORT",
    message: "abort",
    recoverable: false,
  });
  assert.equal(hostMeter.isAborted, true);
  const partial = hostMeter.flush();
  assert.equal(partial.ok, true);
  assert.equal(partial.aborted, true);
});

test("edge: provider discrepancy flag when local estimate differs", () => {
  const m = meter();
  m.record({
    freshInputTokens: 12,
    cachedInputTokens: 2,
    outputTokens: 4,
  });
  const set = m.setProviderUsage({
    inputTokens: 15,
    cachedInputTokens: 0,
    outputTokens: 4,
  });
  assert.equal(set.ok, true);
  assert.equal(set.discrepancy, true);

  const flushed = m.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.discrepancy, true);
  assert.ok(flushed.provider);
  // Local and provider both retained — never conflated into one input field.
  assert.equal(
    reconcileMeterTokens(flushed.events[0], flushed.provider).ok,
    false,
  );
});

test("edge: multi-model handoff yields separate MeterEvent segments", () => {
  const m = meter({ modelId: "edge-slm" });
  m.record({ freshInputTokens: 10, cachedInputTokens: 5, outputTokens: 2 });
  m.record({
    modelId: "cloud-handoff",
    locality: "external-api",
    freshInputTokens: 3,
    outputTokens: 6,
  });
  assert.equal(m.segmentCount, 2);
  const flushed = m.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.events.length, 2);
  assert.equal(flushed.events[0].modelId, "edge-slm");
  assert.equal(flushed.events[0].cachedInputTokens, 5);
  assert.equal(flushed.events[1].modelId, "cloud-handoff");
  assert.equal(flushed.events[1].locality, "external-api");
  assert.equal(flushed.totalPromptTokens, 18);
  assert.equal(flushed.totals.inputTokens, 13);
  assert.equal(flushed.totals.cachedInputTokens, 5);
});

test("edge: idempotent record + flush replay do not double-count", () => {
  const m = meter();
  assert.equal(
    m.record({
      freshInputTokens: 5,
      cachedInputTokens: 1,
      outputTokens: 2,
      idempotencyKey: "usage-1",
    }).ok,
    true,
  );
  const dup = m.record({
    freshInputTokens: 5,
    cachedInputTokens: 1,
    outputTokens: 2,
    idempotencyKey: "usage-1",
  });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(m.totalPromptTokens, 6);

  const first = m.flush();
  const second = m.flush();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replay, true);
  assert.equal(second.totals.inputTokens, first.totals.inputTokens);
  assert.equal(second.totals.outputTokens, first.totals.outputTokens);
});

test("edge: prompt split mismatch rejected", () => {
  const m = meter();
  const bad = m.record({
    freshInputTokens: 10,
    cachedInputTokens: 2,
    totalPromptTokens: 99,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "prompt_split_mismatch");
});

test("sovereignty: cross-subject attachTurnMeter rejected", () => {
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-meter-iso",
  });
  const other = new TurnMeter({
    subjectId: "other-subject",
    modelId: "slm-local",
    locality: "on-device",
  });
  const attached = host.attachTurnMeter(other);
  assert.equal(attached.ok, false);
  assert.equal(attached.failureClass, "cross_subject");
  assert.equal(host.meter, undefined);

  assert.throws(
    () =>
      new StreamingTurnHost({
        subjectId: "anika-k",
        correlationId: "corr-meter-iso-2",
        turnMeter: other,
      }),
    /turnMeter\.subjectId must match/,
  );
});

test("scalability: model segment budget is hard-capped", () => {
  const m = meter({ modelId: "m0" });
  for (let i = 1; i < TURN_METER_SEGMENT_LIMIT; i += 1) {
    assert.equal(m.record({ modelId: `m${i}`, outputTokens: 1 }).ok, true);
  }
  const over = m.record({ modelId: "overflow", outputTokens: 1 });
  assert.equal(over.ok, false);
  assert.equal(over.failureClass, "segment_limit");
  assert.equal(m.segmentCount, TURN_METER_SEGMENT_LIMIT);
});
