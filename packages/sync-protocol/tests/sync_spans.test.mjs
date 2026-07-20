/**
 * SyncEngine attempt / backoff / terminal span instrumentation.
 * Run: pnpm --filter @moolam/sync-protocol test  (after build)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  ALLOWED_SYNC_ATTR_KEYS,
  assertSpanExportPrivacy,
  createSyncInstrumentation,
  createTurnInstrumentation,
  initObservability,
  shutdownObservability,
} from "@moolam/observability";
import {
  PROTOCOL_VERSION,
  SyncEngine,
  encodeHLC,
} from "../dist/index.js";

const SECRET_FRICTION = "GOLDEN_FRICTION_NEVER_IN_SPAN_ATTRS";
const SECRET_BODY = "REJECTED_PAYLOAD_BLOB_MUST_NOT_LEAK";

function makeState(subjectId = "subj-sync-a") {
  const device = "edge-device-aaaa";
  const t = encodeHLC(1_700_000_000_000, 0, device);
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId,
    deviceIds: [device],
    activeConceptId: "math.ratios",
    mode: "exploratory",
    mastery: {
      "math.ratios": {
        conceptId: "math.ratios",
        alpha: { [device]: 1 },
        beta: { [device]: 1 },
        lastExercisedAt: t,
      },
    },
    frictionLog: [
      {
        conceptId: "math.ratios",
        hesitationMs: 100,
        inputVelocity: 1,
        revisionCount: 0,
        assistanceRequested: false,
        outcome: "correct",
        capturedAt: t,
      },
    ],
    profile: {
      ageBand: "child",
      track: SECRET_FRICTION,
      language: "en-IN",
      updatedAt: t,
    },
    stateVector: { session: t },
  };
}

function makeRequest(overrides = {}) {
  const state = makeState(overrides.subjectId);
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "edge-device-aaaa",
    edgeState: state,
    lastKnownCloudVector: {},
    syncAttemptId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
    edgeState: overrides.edgeState ?? state,
  };
}

function assertAllowedKeys(spans) {
  for (const span of spans) {
    for (const key of Object.keys(span.attributes ?? {})) {
      assert.ok(
        ALLOWED_SYNC_ATTR_KEYS.includes(key) || key.startsWith("sutra."),
        `unexpected attr ${key}`,
      );
      assert.ok(
        ALLOWED_SYNC_ATTR_KEYS.includes(key),
        `attr not in sync allow-list: ${key}`,
      );
    }
    for (const ev of span.events ?? []) {
      for (const key of Object.keys(ev.attributes ?? {})) {
        assert.ok(
          ALLOWED_SYNC_ATTR_KEYS.includes(key),
          `event attr not allow-listed: ${key}`,
        );
      }
    }
  }
}

test("happy path: converge emits sutra.sync root + attempt with outcome converged", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
    serviceName: "sync-spans",
  });
  const state = makeState();
  const engine = new SyncEngine(
    {
      postSync: async () => ({
        kind: "ok",
        response: {
          protocolVersion: PROTOCOL_VERSION,
          mergedState: state,
          compactedSampleTimestamps: [],
          advisories: [],
        },
      }),
    },
    {
      syncInstrumentation: createSyncInstrumentation(obs),
      sleep: async () => {},
      random: () => 0,
    },
  );

  const outcome = await engine.synchronize(makeRequest());
  assert.equal(outcome.status, "converged");

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();
  await shutdownObservability();

  const root = spans.find((s) => s.name === "sutra.sync");
  assert.ok(root);
  assert.equal(root.attributes["sutra.outcome"], "converged");
  assert.equal(root.attributes["sutra.attempt"], 1);
  assert.equal(root.attributes["sutra.retry_count"], 0);
  assert.equal(root.status.code, 1); // OK
  const attempt = spans.find((s) => s.name === "sutra.sync.attempt");
  assert.ok(attempt);
  assert.equal(attempt.parentSpanContext?.spanId, root.spanContext().spanId);
  assertAllowedKeys(spans.filter((s) => s.name.startsWith("sutra.sync")));
  assertSpanExportPrivacy(spans, {
    forbiddenSubstrings: [SECRET_FRICTION, SECRET_BODY],
  });
});

test("edge: exhausted after retries is OK status with outcome exhausted + backoff events", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const delays = [];
  const engine = new SyncEngine(
    {
      postSync: async () => ({
        kind: "http-error",
        status: 503,
        body: SECRET_BODY,
      }),
    },
    {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      syncInstrumentation: createSyncInstrumentation(obs),
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    },
  );

  const outcome = await engine.synchronize(makeRequest());
  assert.equal(outcome.status, "exhausted");
  assert.equal(outcome.reasonCode, "TRANSIENT_ATTEMPTS_EXHAUSTED");
  assert.equal(outcome.attempts, 3);

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();

  const root = spans.find((s) => s.name === "sutra.sync");
  assert.ok(root);
  assert.equal(root.attributes["sutra.outcome"], "exhausted");
  assert.equal(root.attributes["sutra.exhausted_code"], "TRANSIENT_ATTEMPTS_EXHAUSTED");
  assert.equal(root.status.code, 1); // OK — not ERROR
  assert.notEqual(root.status.code, 2);
  const attempts = spans.filter((s) => s.name === "sutra.sync.attempt");
  assert.equal(attempts.length, 3);
  const backoff = (root.events ?? []).filter((e) => e.name === "sutra.sync.backoff");
  assert.equal(backoff.length, 2);
  assert.equal(delays.length, 2);
  assert.doesNotMatch(JSON.stringify(root.attributes), /SECRET_BODY|REJECTED/);
});

test("edge: quarantined 4xx records reason code without rejected body", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const engine = new SyncEngine(
    {
      postSync: async () => ({
        kind: "http-error",
        status: 422,
        body: SECRET_BODY,
      }),
    },
    {
      syncInstrumentation: createSyncInstrumentation(obs),
      sleep: async () => {},
    },
  );

  const outcome = await engine.synchronize(makeRequest());
  assert.equal(outcome.status, "quarantined");
  assert.equal(outcome.reasonCode, "HTTP_CLIENT_REJECTED");
  assert.match(outcome.reason, /REJECTED_PAYLOAD_BLOB_MUST_NOT_LEAK/); // local reason may cite body

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();

  const root = spans.find((s) => s.name === "sutra.sync");
  assert.ok(root);
  assert.equal(root.attributes["sutra.outcome"], "quarantined");
  assert.equal(root.attributes["sutra.quarantine_code"], "HTTP_CLIENT_REJECTED");
  assert.equal(root.attributes["sutra.http_status"], 422);
  assert.equal(root.status.code, 1);
  assertSpanExportPrivacy(spans, {
    forbiddenSubstrings: [SECRET_BODY, SECRET_FRICTION],
  });
});

test("edge: network-error sets connectivity offline on sync span", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const engine = new SyncEngine(
    {
      postSync: async () => ({
        kind: "network-error",
        cause: "ENOTFOUND",
      }),
    },
    {
      maxAttempts: 2,
      syncInstrumentation: createSyncInstrumentation(obs),
      connectivity: "online",
      sleep: async () => {},
      random: () => 0,
    },
  );

  const outcome = await engine.synchronize(makeRequest());
  assert.equal(outcome.status, "exhausted");

  await obs.forceFlush();
  const root = capture
    .getFinishedSpans()
    .find((s) => s.name === "sutra.sync");
  await obs.shutdown();

  assert.ok(root);
  assert.equal(root.attributes["sutra.connectivity"], "offline");
});

test("sovereignty: concurrent subjects do not share sync trace ids", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createSyncInstrumentation(obs);
  const makeEngine = () =>
    new SyncEngine(
      {
        postSync: async (req) => ({
          kind: "ok",
          response: {
            protocolVersion: PROTOCOL_VERSION,
            mergedState: req.edgeState,
            compactedSampleTimestamps: [],
            advisories: [],
          },
        }),
      },
      { syncInstrumentation: instr, sleep: async () => {} },
    );

  await Promise.all([
    makeEngine().synchronize(makeRequest({ subjectId: "subj-x" })),
    makeEngine().synchronize(
      makeRequest({
        subjectId: "subj-y",
        syncAttemptId: "22222222-2222-4222-8222-222222222222",
      }),
    ),
  ]);

  await obs.forceFlush();
  const roots = capture
    .getFinishedSpans()
    .filter((s) => s.name === "sutra.sync");
  await obs.shutdown();

  assert.equal(roots.length, 2);
  assert.notEqual(
    roots[0].spanContext().traceId,
    roots[1].spanContext().traceId,
  );
  const subjects = new Set(roots.map((r) => r.attributes["sutra.subject_id"]));
  assert.deepEqual([...subjects].sort(), ["subj-x", "subj-y"]);
});

test("happy path: sync during active turn is a child of the turn root", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const turnInstr = createTurnInstrumentation(obs);
  const engine = new SyncEngine(
    {
      postSync: async (req) => ({
        kind: "ok",
        response: {
          protocolVersion: PROTOCOL_VERSION,
          mergedState: req.edgeState,
          compactedSampleTimestamps: [],
          advisories: [],
        },
      }),
    },
    {
      syncInstrumentation: createSyncInstrumentation(obs),
      sleep: async () => {},
    },
  );

  await turnInstr.withTurn(
    { subjectId: "subj-turn-sync", sessionId: "sess-1" },
    async () => {
      await engine.synchronize(
        makeRequest({ subjectId: "subj-turn-sync" }),
      );
    },
  );

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  turnInstr.dispose();
  await obs.shutdown();

  const turn = spans.find((s) => s.name === "sutra.turn");
  const sync = spans.find((s) => s.name === "sutra.sync");
  assert.ok(turn);
  assert.ok(sync);
  assert.equal(sync.parentSpanContext?.spanId, turn.spanContext().spanId);
  assert.equal(sync.spanContext().traceId, turn.spanContext().traceId);
});
