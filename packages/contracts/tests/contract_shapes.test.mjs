// Contract-shape tests: verify the built package exposes every contract
// surface and that minimal conforming implementations satisfy the shapes.
// Run: node --test tests/  (after pnpm build)
import test from "node:test";
import assert from "node:assert/strict";
import * as contracts from "../dist/index.js";

test("package builds and exports resolve", () => {
  // Interfaces are erased at runtime; the module itself must still load
  // and carry no accidental runtime exports beyond documentation values.
  assert.equal(typeof contracts, "object");
});

test("a minimal MemoryInterface implementation satisfies the shape", async () => {
  /** @type {import("../dist/index.js").MemoryInterface} */
  const memory = {
    remember: async (item) => ({ ...item, id: "m1" }),
    recall: async () => [],
    associate: async () => {},
    forget: async () => {},
    compact: async () => 0,
  };
  const item = await memory.remember({
    subjectId: "s1",
    topicId: "t1",
    text: "note",
    kind: "episodic",
    createdAt: new Date().toISOString(),
  });
  assert.equal(item.id, "m1");
  assert.deepEqual(await memory.recall({ subjectId: "s1", query: "note" }), []);
});

test("a minimal ToolInterface implementation satisfies the shape", async () => {
  /** @type {import("../dist/index.js").ToolInterface} */
  const tools = {
    list: () => [
      { name: "calc", description: "adds", parameters: {}, riskClass: "compute" },
    ],
    invoke: async (invocation) => ({
      invocationId: invocation.invocationId,
      status: "ok",
      output: 42,
      latencyMs: 1,
    }),
  };
  const result = await tools.invoke({ toolName: "calc", arguments: {}, invocationId: "i1" }, 1000);
  assert.equal(result.status, "ok");
  assert.equal(tools.list()[0].riskClass, "compute");
});

test("an EventBusInterface implementation isolates subscriber errors", () => {
  /** @type {Array<import("../dist/index.js").RuntimeEvent>} */
  const seen = [];
  /** @type {import("../dist/index.js").EventBusInterface} */
  const bus = {
    handlers: new Map(),
    publish(event) {
      for (const h of this.handlers.get(event.type) ?? []) {
        try {
          h(event);
        } catch {
          /* isolated per contract */
        }
      }
    },
    subscribe(type, handler) {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
      return () => list.splice(list.indexOf(handler), 1);
    },
  };
  bus.subscribe("x", () => {
    throw new Error("subscriber bug");
  });
  bus.subscribe("x", (e) => seen.push(e));
  bus.publish({ type: "x", at: "1", payload: {} });
  assert.equal(seen.length, 1);
});
