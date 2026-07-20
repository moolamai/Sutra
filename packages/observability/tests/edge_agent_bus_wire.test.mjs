/**
 * WireEdgeAgentEventBus defaults + dispose.
 * Run: pnpm --filter @moolam/observability test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus } from "@moolam/runtime";
import {
  EDGE_LIFECYCLE_READY,
  wireEdgeAgentEventBus,
} from "../dist/index.js";

test("happy path: default bus is InProcessEventBus when omitted", () => {
  const { bus, dispose } = wireEdgeAgentEventBus({ attachToSpans: false });
  assert.ok(bus instanceof InProcessEventBus);
  const seen = [];
  bus.subscribe(EDGE_LIFECYCLE_READY, (e) => seen.push(e));
  bus.publish({
    type: EDGE_LIFECYCLE_READY,
    at: new Date().toISOString(),
    payload: { subjectId: "s1", deviceId: "d1", outcome: "ok" },
  });
  assert.equal(seen.length, 1);
  dispose();
});

test("edge: host-supplied bus is preserved (no replacement)", () => {
  const injected = new InProcessEventBus();
  const { bus, dispose } = wireEdgeAgentEventBus({
    eventBus: injected,
    attachToSpans: false,
  });
  assert.equal(bus, injected);
  dispose();
});

test("edge: dispose is idempotent", () => {
  const { dispose } = wireEdgeAgentEventBus({ attachToSpans: true });
  dispose();
  dispose();
});
