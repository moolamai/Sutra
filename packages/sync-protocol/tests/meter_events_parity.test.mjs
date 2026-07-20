/**
 * MeterEvent wire parity — shared golden fixture + catalog harness.meter.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/meter_events_parity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCatalogEvent } from "@moolam/observability";
import {
  meterEventSchema,
  parseMeterEvent,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE = JSON.parse(
  readFileSync(join(PKG, "fixtures/wire-parity/meter-events.json"), "utf8"),
);

test("happy path: committed MeterEvent + EventHarnessMeter schemas exist", () => {
  assert.ok(existsSync(join(PKG, "schemas", "MeterEvent.json")));
  assert.ok(existsSync(join(PKG, "schemas", "EventHarnessMeter.json")));
  const meterDoc = JSON.parse(
    readFileSync(join(PKG, "schemas", "MeterEvent.json"), "utf8"),
  );
  assert.equal(meterDoc.title, "MeterEvent");
  assert.equal(meterDoc["x-protocol-version"], "1.0.0");
});

test("happy path: shared golden meters parse via Zod", () => {
  for (const entry of FIXTURE.meters) {
    const parsed = meterEventSchema.parse(entry.meter);
    assert.equal(parsed.modelId, entry.meter.modelId);
    assert.equal(parsed.aborted, entry.meter.aborted);
    assert.equal(parsed.inputTokens, entry.meter.inputTokens);
    assert.equal(parsed.cachedInputTokens, entry.meter.cachedInputTokens);
  }
  // Cached vs fresh stay distinct on fixtures that exercise both channels.
  const withCache = FIXTURE.meters.find((e) => e.meter.cachedInputTokens > 0);
  assert.ok(withCache);
  assert.notEqual(
    withCache.meter.inputTokens,
    withCache.meter.inputTokens + withCache.meter.cachedInputTokens,
  );
});

test("happy path: catalog harness.meter envelope validates", () => {
  const result = parseCatalogEvent(FIXTURE.catalogEnvelope);
  assert.equal(result.ok, true);
  assert.equal(result.event.type, "harness.meter");
  assert.equal(result.event.payload.subjectId, "anika-k");
  assert.equal(result.event.payload.cachedInputTokens, 2);
});

test("edge: aborted partial meter still accepts", () => {
  const aborted = FIXTURE.meters.find((e) => e.id === "aborted-partial");
  const result = parseMeterEvent(aborted.meter, {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  assert.equal(result.outcome, "accepted");
  assert.equal(result.aborted, true);
});

test("edge: None/missing-key semantics — optional session fields omitted ok", () => {
  const { sessionId: _omit, ...payload } = FIXTURE.catalogEnvelope.payload;
  const result = parseCatalogEvent({
    ...FIXTURE.catalogEnvelope,
    payload,
  });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.event.payload, "sessionId"), false);
});

test("subject isolation + privacy: content keys rejected; empty subject rejected", () => {
  const leak = parseMeterEvent(
    { ...FIXTURE.meters[0].meter, prompt: "secret utterance" },
    { subjectId: "anika-k" },
  );
  assert.equal(leak.outcome, "rejected");
  assert.equal(leak.failureClass, "content_leak");
  assert.doesNotMatch(JSON.stringify(leak), /secret utterance/);

  const unscoped = parseMeterEvent(FIXTURE.meters[0].meter, { subjectId: "" });
  assert.equal(unscoped.failureClass, "missing_subject");

  const busLeak = parseCatalogEvent({
    type: "harness.meter",
    at: FIXTURE.catalogEnvelope.at,
    payload: {
      ...FIXTURE.catalogEnvelope.payload,
      prompt: "nope",
    },
  });
  assert.equal(busLeak.ok, false);
});
