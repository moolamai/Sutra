/**
 * Versioned event type registry + Zod payload schemas.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus } from "@moolam/runtime";
import {
  CATALOG_EVENT_TYPES,
  CATALOG_WORKED_EXAMPLES,
  EVENT_CATALOG_VERSION,
  EVENT_PAYLOAD_SCHEMAS,
  FORBIDDEN_CATALOG_PAYLOAD_KEYS,
  assertCatalogPayload,
  isCatalogEventType,
  parseCatalogEvent,
} from "../dist/index.js";

test("happy path: every catalog type has a schema and a worked example", () => {
  assert.equal(typeof EVENT_CATALOG_VERSION, "string");
  assert.match(EVENT_CATALOG_VERSION, /^\d+\.\d+\.\d+$/);
  for (const type of CATALOG_EVENT_TYPES) {
    assert.ok(EVENT_PAYLOAD_SCHEMAS[type], `schema missing for ${type}`);
    const example = CATALOG_WORKED_EXAMPLES[type];
    assert.ok(example, `example missing for ${type}`);
    const parsed = parseCatalogEvent(example);
    assert.equal(parsed.ok, true, `${type}: ${parsed.ok ? "" : parsed.error}`);
    assert.equal(parsed.event.type, type);
    assertCatalogPayload(type, example.payload);
  }
});

test("edge: unknown event types are rejected", () => {
  assert.equal(isCatalogEventType("turn.stage.start"), true);
  assert.equal(isCatalogEventType("learner.raw.utterance"), false);
  const parsed = parseCatalogEvent({
    type: "learner.raw.utterance",
    at: "2026-07-15T10:00:00.000Z",
    payload: { subjectId: "x" },
  });
  assert.equal(parsed.ok, false);
});

test("edge: strict schemas reject unknown / learner-data keys", () => {
  const base = structuredClone(CATALOG_WORKED_EXAMPLES["sync.advisory"]);
  base.payload.detail = "HLC 000001700000000:000002:edge-aaaa skew 400ms";
  const parsed = parseCatalogEvent(base);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /forbidden payload key 'detail'|unrecognized|strict/i);

  assert.throws(
    () =>
      assertCatalogPayload("tool.invoked", {
        subjectId: "anika-k",
        sessionId: "sess-1",
        toolIdHash: "a1b2c3d4e5f67890",
        opCode: "tool.invoked",
        arguments: { expression: "2+2" },
      }),
    (err) =>
      err?.name === "CatalogContractError" &&
      /forbidden|catalog\.forbidden-key/.test(String(err.message)),
  );
});

test("edge: subscriber-error isolation still surfaces as cataloged runtime event", () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe("tick", () => {
    throw new Error("boom");
  });
  bus.subscribe(InProcessEventBus.SUBSCRIBER_ERROR, (e) => seen.push(e));

  bus.publish({ type: "tick", at: "2026-07-15T10:00:00.000Z", payload: {} });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "runtime.subscriber-error");
  const parsed = parseCatalogEvent(seen[0]);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
});

test("edge: folded friction summary accepted; raw utterance event is not cataloged", () => {
  const summary = CATALOG_WORKED_EXAMPLES["turn.friction.summary"];
  assert.equal(parseCatalogEvent(summary).ok, true);
  assert.equal(isCatalogEventType("friction.raw"), false);
  assert.equal(isCatalogEventType("turn.friction.sample"), false);
});

test("sovereignty: forbidden keys never appear in worked examples", () => {
  const blob = JSON.stringify(CATALOG_WORKED_EXAMPLES);
  for (const key of FORBIDDEN_CATALOG_PAYLOAD_KEYS) {
    assert.equal(
      Object.values(CATALOG_WORKED_EXAMPLES).some((ex) =>
        Object.prototype.hasOwnProperty.call(ex.payload, key),
      ),
      false,
      `example leaked key ${key}`,
    );
    assert.ok(!blob.includes(`"${key}"`), `serialized examples mention ${key}`);
  }
  assert.ok(!blob.includes("GOLDEN_UTTERANCE"));
  assert.ok(!blob.includes("what is a ratio"));
});

test("edge: at accepts ISO-8601 and HLC; rejects garbage", () => {
  const isoOk = parseCatalogEvent({
    ...CATALOG_WORKED_EXAMPLES["sync.outcome"],
    at: "2026-07-15T10:00:00.000Z",
  });
  assert.equal(isoOk.ok, true);
  const hlcOk = parseCatalogEvent({
    ...CATALOG_WORKED_EXAMPLES["turn.friction.summary"],
    at: "000001700000000:000001:edge-aaaa",
  });
  assert.equal(hlcOk.ok, true);
  const bad = parseCatalogEvent({
    ...CATALOG_WORKED_EXAMPLES["sync.outcome"],
    at: "tomorrow",
  });
  assert.equal(bad.ok, false);
});
