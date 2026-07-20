/**
 * Sync.outcome after SyncEngine terminal / offline skip.
 * Run: pnpm --filter @moolam/edge-agent test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus } from "@moolam/runtime";
import { PROTOCOL_VERSION } from "@moolam/sync-protocol";
import { parseCatalogEvent, SYNC_OUTCOME } from "@moolam/observability";
import { EdgeAgent } from "../dist/index.js";

function memoryDriver() {
  return {
    async execute() {},
    async query() {
      return [];
    },
  };
}

function mockRuntime() {
  return {
    descriptor: {
      modelId: "mock-phi",
      quantization: "q4",
      contextWindow: 4096,
      languages: ["en-IN"],
    },
    load: async () => {},
    generate: async () => ({
      text: "unused",
      tokensPerSecond: 40,
      finishReason: "stop",
    }),
    embed: async () => Float32Array.from([0.1, 0.2, 0.3]),
  };
}

function baseConfig(overrides = {}) {
  return {
    subjectId: "subj-sync-a",
    deviceId: "edge-device-aaaa",
    runtime: mockRuntime(),
    storage: memoryDriver(),
    profile: { ageBand: "adult", track: "math-l1", language: "en-IN" },
    attachEventBusSpans: false,
    ...overrides,
  };
}

test("edge: permanently offline syncNow emits skipped-offline sync.outcome", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(SYNC_OUTCOME, (e) => seen.push(e));

  const agent = new EdgeAgent(baseConfig({ eventBus: bus }));
  await agent.initialize();
  const result = await agent.syncNow();

  assert.equal(result.status, "offline-mode");
  assert.equal(seen.length, 1);
  const parsed = parseCatalogEvent(seen[0]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.payload.outcome, "skipped-offline");
  assert.equal(parsed.event.payload.attempts, 0);
  assert.equal(parsed.event.payload.subjectId, "subj-sync-a");
  assert.doesNotMatch(JSON.stringify(seen[0]), /mastery|frictionLog|stateVector/i);
  agent.dispose();
});

test("happy path: converged transport publishes sync.outcome with advisory codes", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(SYNC_OUTCOME, (e) => seen.push(e));

  const agent = new EdgeAgent(
    baseConfig({
      eventBus: bus,
      transport: {
        postSync: async (req) => ({
          kind: "ok",
          response: {
            protocolVersion: PROTOCOL_VERSION,
            mergedState: req.edgeState,
            compactedSampleTimestamps: [],
            advisories: [
              {
                code: "CLOCK_SKEW_CLAMPED",
                detail: "SECRET_ADVISORY_DETAIL must never reach the bus",
              },
              {
                code: "DUPLICATE_SAMPLE_DROPPED",
                detail: "another secret",
              },
            ],
          },
        }),
      },
    }),
  );
  await agent.initialize();
  const outcome = await agent.syncNow();

  assert.equal(outcome.status, "converged");
  assert.equal(seen.length, 1);
  const parsed = parseCatalogEvent(seen[0]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.payload.outcome, "converged");
  assert.equal(parsed.event.payload.attempts, 1);
  assert.deepEqual(parsed.event.payload.advisoryCodes, [
    "CLOCK_SKEW_CLAMPED",
    "DUPLICATE_SAMPLE_DROPPED",
  ]);
  const blob = JSON.stringify(seen[0]);
  assert.doesNotMatch(blob, /SECRET_ADVISORY_DETAIL|another secret|mastery/i);
  agent.dispose();
});

test("edge: quarantined terminal publishes quarantineCode without rejected body", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(SYNC_OUTCOME, (e) => seen.push(e));

  const agent = new EdgeAgent(
    baseConfig({
      eventBus: bus,
      transport: {
        postSync: async () => ({
          kind: "http-error",
          status: 422,
          body: "REJECTED_PAYLOAD_BLOB_MUST_NOT_LEAK",
        }),
      },
    }),
  );
  await agent.initialize();
  const outcome = await agent.syncNow();

  assert.equal(outcome.status, "quarantined");
  assert.equal(seen[0].payload.outcome, "quarantined");
  assert.equal(seen[0].payload.quarantineCode, "HTTP_CLIENT_REJECTED");
  assert.equal(seen[0].payload.httpStatus, 422);
  assert.equal(parseCatalogEvent(seen[0]).ok, true);
  assert.doesNotMatch(
    JSON.stringify(seen[0]),
    /REJECTED_PAYLOAD_BLOB_MUST_NOT_LEAK/,
  );
  agent.dispose();
});

test("sovereignty: subject A sync.outcome never carries subject B", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(SYNC_OUTCOME, (e) => seen.push(e));

  const a = new EdgeAgent(
    baseConfig({ subjectId: "subj-sa", deviceId: "dev-sa", eventBus: bus }),
  );
  const b = new EdgeAgent(
    baseConfig({ subjectId: "subj-sb", deviceId: "dev-sb", eventBus: bus }),
  );
  await a.initialize();
  await b.initialize();
  await a.syncNow();
  await b.syncNow();

  assert.equal(seen.length, 2);
  const onlyA = seen.find((e) => e.payload.subjectId === "subj-sa");
  assert.ok(onlyA);
  assert.doesNotMatch(JSON.stringify(onlyA), /subj-sb/);
  a.dispose();
  b.dispose();
});
