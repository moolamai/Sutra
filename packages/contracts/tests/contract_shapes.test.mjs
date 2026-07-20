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

test("catalog event registry keys are exported", () => {
  assert.ok(Array.isArray(contracts.CATALOG_EVENT_TYPES));
  assert.ok(contracts.CATALOG_EVENT_TYPES.includes("turn.stage.start"));
  assert.ok(contracts.CATALOG_EVENT_TYPES.includes("turn.completed"));
  assert.ok(contracts.CATALOG_EVENT_TYPES.includes("sync.outcome"));
  assert.ok(contracts.CATALOG_EVENT_TYPES.includes("sync.advisory"));
  assert.ok(contracts.CATALOG_EVENT_TYPES.includes("tool.invoked"));
  assert.ok(contracts.CATALOG_EVENT_TYPES.includes("tool.result"));
  assert.ok(contracts.CATALOG_EVENT_TYPES.includes("harness.meter"));
  assert.ok(contracts.CATALOG_EVENT_TYPES.includes("runtime.subscriber-error"));
  assert.ok(contracts.EVENT_SCHEMA_TYPE_NAMES.includes("EventHarnessMeter"));
  assert.ok(contracts.CATALOG_TURN_STAGES.includes("reason"));
  assert.ok(contracts.CATALOG_SYNC_ADVISORY_CODES.includes("CLOCK_SKEW_CLAMPED"));
});

test("DegradationMode enum and registry interface are exported", () => {
  assert.deepEqual([...contracts.DEGRADATION_MODES], [
    "STALE_READ",
    "HARD_STOP_WRITE",
    "QUEUE_AND_WARN",
  ]);
  assert.equal(contracts.isDegradationMode("STALE_READ"), true);
  assert.equal(contracts.isDegradationMode("SILENT_RETRY"), false);

  /** @type {import("../dist/index.js").DegradationRegistry} */
  const registry = {
    lookup(surface, operation) {
      if (surface === "storage" && operation === "read") {
        return {
          mode: "STALE_READ",
          description: "stale-with-marker",
          allowsFabrication: false,
          allowsSilentWriteRetry: false,
          readPolicy: "stale-with-marker",
          writePolicy: "hard-stop-rollback",
          requiresFreshnessMarker: true,
          signalCode: "DEGRADE_STALE_READ",
        };
      }
      return undefined;
    },
  };
  const behavior = registry.lookup("storage", "read");
  assert.equal(behavior?.mode, "STALE_READ");
  assert.equal(behavior?.allowsSilentWriteRetry, false);
});

test("BudgetHook decision enum is closed and documented", () => {
  assert.deepEqual([...contracts.BUDGET_DECISIONS], [
    "allow",
    "throttle",
    "hardStop",
  ]);
  assert.equal(contracts.isBudgetDecision("allow"), true);
  assert.equal(contracts.isBudgetDecision("throttle"), true);
  assert.equal(contracts.isBudgetDecision("hardStop"), true);
  assert.equal(contracts.isBudgetDecision("slow-down"), false);

  /** @type {import("../dist/index.js").BudgetHook} */
  const hook = {
    onMeterTick(event) {
      assert.ok(event.subjectId);
      return "allow";
    },
  };
  const decision = hook.onMeterTick({
    subjectId: "anika-k",
    inputTokens: 12,
    outputTokens: 4,
    cachedInputTokens: 2,
    latencyMs: 35,
    modelId: "slm-local",
    locality: "on-device",
    aborted: false,
  });
  assert.equal(decision, "allow");
});

test("CatalogContractError names the violated obligation", () => {
  const err = new contracts.CatalogContractError(
    "catalog.unknown-type",
    "learner.raw",
    "not in registry",
  );
  assert.equal(err.name, "CatalogContractError");
  assert.equal(err.obligation, "catalog.unknown-type");
  assert.equal(err.eventType, "learner.raw");
  assert.match(err.message, /catalog\.unknown-type/);
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
