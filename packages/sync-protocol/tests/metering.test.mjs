/**
 * MeterEvent Zod schema + METER_TICK payload binding.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/metering.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  harnessFrameSchema,
  meterEventSchema,
  parseHarnessFrame,
  parseMeterEvent,
  reconcileMeterTokens,
  sumMeterTokenTotals,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, "../fixtures/wire-parity/harness-frames.json"),
    "utf8",
  ),
);

const VALID_METER_TICK = GOLDEN.frames.find((f) => f.type === "METER_TICK");
const VALID_METER = VALID_METER_TICK.tick;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: MeterEvent parses; METER_TICK carries tick payload", () => {
  const meter = meterEventSchema.parse(VALID_METER);
  assert.equal(meter.inputTokens, 12);
  assert.equal(meter.cachedInputTokens, 2);
  assert.equal(meter.outputTokens, 4);
  assert.equal(meter.aborted, false);
  assert.equal(meter.locality, "on-device");

  const frame = harnessFrameSchema.parse(VALID_METER_TICK);
  assert.equal(frame.type, "METER_TICK");
  assert.deepEqual(frame.tick, meter);
  assert.equal(frame.subjectId, "anika-k");

  emit({
    event: "harness.meter",
    outcome: "ok",
    subjectId: frame.subjectId,
    deviceId: "edge-aaaa",
    aborted: meter.aborted,
    modelId: meter.modelId,
    locality: meter.locality,
  });
});

test("happy path: totals reconcile with provider-reported usage", () => {
  const meter = meterEventSchema.parse(VALID_METER);
  const ok = reconcileMeterTokens(meter, {
    inputTokens: 12,
    outputTokens: 4,
    cachedInputTokens: 2,
  });
  assert.equal(ok.ok, true);
});

test("edge: cached vs fresh input tokens stay distinguishable", () => {
  const meter = meterEventSchema.parse({
    ...VALID_METER,
    inputTokens: 10,
    cachedInputTokens: 5,
  });
  // Conflating into a single summed input must fail field-wise reconcile.
  const conflated = reconcileMeterTokens(meter, {
    inputTokens: 15,
    outputTokens: meter.outputTokens,
    cachedInputTokens: 0,
  });
  assert.equal(conflated.ok, false);
  assert.equal(conflated.code, "TOKEN_MISMATCH");
  assert.equal(conflated.field, "inputTokens");

  const totals = sumMeterTokenTotals([
    meter,
    { ...meter, inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
  ]);
  assert.equal(totals.inputTokens, 13);
  assert.equal(totals.cachedInputTokens, 6);
  assert.equal(totals.outputTokens, 6);
  // Aggregates keep the two input channels distinct (never a collapsed sum field).
  assert.equal(totals.inputTokens + totals.cachedInputTokens, 19);
});

test("edge: aborted partial turn still validates and accounts spend", () => {
  const partial = {
    inputTokens: 8,
    outputTokens: 1,
    cachedInputTokens: 0,
    latencyMs: 12,
    modelId: "slm-local",
    locality: "on-device",
    aborted: true,
  };
  const parsed = meterEventSchema.parse(partial);
  assert.equal(parsed.aborted, true);
  assert.equal(parsed.inputTokens, 8);

  const accepted = parseMeterEvent(partial, {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.aborted, true);
  assert.equal(accepted.event.outputTokens, 1);

  emit({
    event: "harness.meter",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    aborted: true,
  });
});

test("edge: content / unknown keys rejected (metadata-only contract)", () => {
  const withPrompt = meterEventSchema.safeParse({
    ...VALID_METER,
    prompt: "learner utterance must not ride the meter",
  });
  assert.equal(withPrompt.success, false);

  const rejected = parseMeterEvent(
    { ...VALID_METER, completion: "secret" },
    { subjectId: "anika-k", deviceId: "edge-aaaa" },
  );
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.failureClass, "content_leak");
  const serialized = JSON.stringify(rejected);
  assert.doesNotMatch(serialized, /secret|learner utterance/i);
});

test("subject isolation: empty subjectId rejected on parseMeterEvent and METER_TICK", () => {
  const unscoped = parseMeterEvent(VALID_METER, { subjectId: "" });
  assert.equal(unscoped.outcome, "rejected");
  assert.equal(unscoped.failureClass, "missing_subject");

  const frame = parseHarnessFrame({
    ...VALID_METER_TICK,
    subjectId: "",
  });
  assert.equal(frame.outcome, "rejected");
  assert.equal(frame.failureClass, "missing_subject");
});

test("idempotency: identical MeterEvent parses and reconciles the same way twice", () => {
  const a = meterEventSchema.parse(VALID_METER);
  const b = meterEventSchema.parse(VALID_METER);
  assert.deepEqual(a, b);
  assert.deepEqual(
    reconcileMeterTokens(a, VALID_METER),
    reconcileMeterTokens(b, VALID_METER),
  );
});

test("scalability: bounded multi-tick sum stays within parse budget", () => {
  const ticks = Array.from({ length: 64 }, (_, i) => ({
    ...VALID_METER,
    inputTokens: i,
    cachedInputTokens: i % 3,
    outputTokens: 1,
    latencyMs: 1,
  }));
  const started = performance.now();
  for (const t of ticks) {
    meterEventSchema.parse(t);
  }
  const totals = sumMeterTokenTotals(ticks);
  const elapsed = performance.now() - started;
  assert.equal(totals.outputTokens, 64);
  assert.ok(elapsed < 50, `aggregate took ${elapsed}ms; budget is 50ms`);
});
