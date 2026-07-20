/**
 * Validating publish wrapper on EventBusInterface.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus } from "@moolam/runtime";
import {
  CATALOG_WORKED_EXAMPLES,
  CatalogContractError,
  createValidatingEventBus,
  resolvePublishValidationMode,
} from "../dist/index.js";

test("happy path: catalog events publish and subscribers receive them", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  const seen = [];
  bus.subscribe("turn.stage.end", (e) => seen.push(e));
  bus.publish(structuredClone(CATALOG_WORKED_EXAMPLES["turn.stage.end"]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "turn.stage.end");
  assert.equal(seen[0].payload.outcome, "ok");
  assert.equal(bus.droppedInvalidCount, 0);
});

test("edge: throw mode raises CatalogContractError naming the obligation", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  assert.throws(
    () =>
      bus.publish({
        type: "learner.raw.utterance",
        at: "2026-07-15T10:00:00.000Z",
        payload: { subjectId: "anika-k", utterance: "secret" },
      }),
    (err) =>
      err instanceof CatalogContractError &&
      err.obligation === "catalog.unknown-type" &&
      err.eventType === "learner.raw.utterance",
  );

  assert.throws(
    () =>
      bus.publish({
        type: "sync.advisory",
        at: "2026-07-15T10:00:00.000Z",
        payload: {
          ...CATALOG_WORKED_EXAMPLES["sync.advisory"].payload,
          detail: "must never cross the bus",
        },
      }),
    (err) =>
      err instanceof CatalogContractError &&
      err.obligation === "catalog.forbidden-key",
  );
});

test("edge: drop mode counts invalid publishes and never throws", () => {
  const bus = createValidatingEventBus({ mode: "drop" });
  const seen = [];
  bus.subscribe("*", (e) => seen.push(e.type));
  bus.publish({
    type: "friction.raw",
    at: "2026-07-15T10:00:00.000Z",
    payload: { utterance: "GOLDEN_UTTERANCE_MUST_NOT_APPEAR" },
  });
  assert.equal(bus.droppedInvalidCount, 1);
  assert.deepEqual(seen, []);
  bus.publish(structuredClone(CATALOG_WORKED_EXAMPLES["sync.outcome"]));
  assert.ok(seen.includes("sync.outcome"));
  assert.equal(bus.droppedInvalidCount, 1);
});

test("edge: subscriber throw still isolates via runtime.subscriber-error", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  const seen = [];
  bus.subscribe("tool.result", () => {
    throw new Error("observer boom");
  });
  bus.subscribe("tool.result", (e) => seen.push(e.type));
  bus.subscribe(InProcessEventBus.SUBSCRIBER_ERROR, (e) => seen.push(e.type));

  bus.publish(structuredClone(CATALOG_WORKED_EXAMPLES["tool.result"]));
  assert.ok(seen.includes("tool.result"), "healthy subscriber still runs");
  assert.ok(
    seen.includes("runtime.subscriber-error"),
    "isolation event delivered",
  );
});

test("edge: idempotent replay of valid event does not throw or drop", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  const event = structuredClone(CATALOG_WORKED_EXAMPLES["sync.outcome"]);
  bus.publish(event);
  bus.publish(event);
  assert.equal(bus.droppedInvalidCount, 0);
});

test("sovereignty: dropped invalid payload never reaches subscribers", () => {
  const bus = createValidatingEventBus({ mode: "drop" });
  const seen = [];
  bus.subscribe("*", (e) => seen.push(e));
  const secret = "GOLDEN_UTTERANCE_MUST_NOT_APPEAR";
  bus.publish({
    type: "tool.invoked",
    at: "2026-07-15T10:00:00.000Z",
    payload: {
      subjectId: "anika-k",
      sessionId: "sess-1",
      toolIdHash: "a1b2c3d4e5f67890",
      opCode: "tool.invoked",
      arguments: { q: secret },
    },
  });
  assert.equal(bus.droppedInvalidCount, 1);
  assert.equal(seen.length, 0);
  assert.ok(!JSON.stringify(seen).includes(secret));
});

test("unit: resolvePublishValidationMode env + production default", () => {
  assert.equal(
    resolvePublishValidationMode({ MOOLAM_EVENT_BUS_VALIDATE: "drop" }),
    "drop",
  );
  assert.equal(
    resolvePublishValidationMode({ MOOLAM_EVENT_BUS_VALIDATE: "throw" }),
    "throw",
  );
  assert.equal(
    resolvePublishValidationMode({ NODE_ENV: "production" }),
    "drop",
  );
  assert.equal(resolvePublishValidationMode({ NODE_ENV: "test" }), "throw");
});
