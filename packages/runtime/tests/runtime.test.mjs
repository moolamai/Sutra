// Unit tests for the reference runtime. Run: node --test tests/ (after build)
import test from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus, InProcessScheduler, RuntimeHost } from "../dist/index.js";

test("event bus isolates subscriber errors and reports them", () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe("tick", () => {
    throw new Error("boom");
  });
  bus.subscribe("tick", (e) => seen.push(e.type));
  bus.subscribe(InProcessEventBus.SUBSCRIBER_ERROR, (e) => seen.push(e.type));

  bus.publish({ type: "tick", at: "1", payload: {} });
  assert.ok(seen.includes("tick"), "healthy subscriber still runs");
  assert.ok(seen.includes(InProcessEventBus.SUBSCRIBER_ERROR), "error surfaced as event");
});

test("ValidatingEventBus throw mode rejects via CatalogContractError (EVENCATA-002)", async () => {
  const { ValidatingEventBus, CatalogContractError } = await import("../dist/index.js");
  const bus = new ValidatingEventBus(
    new InProcessEventBus(),
    () => ({ ok: false, obligation: "catalog.unknown-type", detail: "nope" }),
    "throw",
  );
  assert.throws(
    () => bus.publish({ type: "x", at: "1", payload: {} }),
    (err) => err instanceof CatalogContractError && err.obligation === "catalog.unknown-type",
  );
});

test("ValidatingEventBus drop mode increments counter without throw (EVENCATA-002)", async () => {
  const { ValidatingEventBus } = await import("../dist/index.js");
  const seen = [];
  const inner = new InProcessEventBus();
  inner.subscribe("*", (e) => seen.push(e.type));
  const bus = new ValidatingEventBus(
    inner,
    (event) =>
      event.type === "ok"
        ? { ok: true, event }
        : { ok: false, obligation: "catalog.unknown-type", detail: "drop" },
    "drop",
  );
  bus.publish({ type: "bad", at: "1", payload: {} });
  bus.publish({ type: "ok", at: "1", payload: {} });
  assert.equal(bus.droppedInvalidCount, 1);
  assert.deepEqual(seen, ["ok"]);
});

test("scheduler runs tasks in order and a failure never blocks the queue", async () => {
  const events = [];
  const scheduler = new InProcessScheduler({ onEvent: (e) => events.push(e) });
  const order = [];

  scheduler.schedule({ taskId: "a", name: "a", runAtMs: 0, deadlineMs: 1000, execute: async () => order.push("a") });
  scheduler.schedule({
    taskId: "b",
    name: "b",
    runAtMs: 0,
    deadlineMs: 1000,
    execute: async () => {
      throw new Error("task bug");
    },
  });
  scheduler.schedule({ taskId: "c", name: "c", runAtMs: 0, deadlineMs: 1000, execute: async () => order.push("c") });

  await scheduler.idle();
  assert.deepEqual(order, ["a", "c"]);
  assert.ok(events.some((e) => e.type === "runtime.task-failed" && e.payload.taskId === "b"));
  assert.equal(scheduler.pendingCount(), 0);
});

test("scheduler enforces per-task deadlines", async () => {
  const events = [];
  const scheduler = new InProcessScheduler({ onEvent: (e) => events.push(e) });
  scheduler.schedule({
    taskId: "slow",
    name: "slow",
    runAtMs: 0,
    deadlineMs: 20,
    execute: () => new Promise((resolve) => setTimeout(resolve, 500)),
  });
  await scheduler.idle();
  const failed = events.find((e) => e.type === "runtime.task-failed");
  assert.ok(failed && String(failed.payload.error).includes("deadline"));
});

test("runtime host starts in order, stops in reverse, rolls back on failure", async () => {
  const log = [];
  const component = (name, failInit = false) => ({
    initialize: async () => {
      if (failInit) throw new Error(`${name} init failed`);
      log.push(`init:${name}`);
    },
    dispose: async () => log.push(`dispose:${name}`),
  });

  const host = new RuntimeHost();
  host.register("storage", component("storage")).register("sync", component("sync"));
  await host.start();
  assert.equal(host.state, "running");
  await host.stop();
  assert.deepEqual(log, ["init:storage", "init:sync", "dispose:sync", "dispose:storage"]);

  const failing = new RuntimeHost();
  const rollback = [];
  failing.register("ok", {
    initialize: async () => rollback.push("init:ok"),
    dispose: async () => rollback.push("dispose:ok"),
  });
  failing.register("bad", component("bad", true));
  await assert.rejects(() => failing.start());
  assert.equal(failing.state, "failed");
  assert.deepEqual(rollback, ["init:ok", "dispose:ok"], "started components are disposed on rollback");
});
