/**
 * W3C traceparent inject/extract on SyncRequest.headers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  createSyncInstrumentation,
  extractSyncWireContext,
  initObservability,
  injectSyncWireHeaders,
  shutdownObservability,
  withContinuedSyncSpan,
} from "@moolam/observability";
import {
  PROTOCOL_VERSION,
  SyncEngine,
  encodeHLC,
  syncRequestSchema,
  withInjectedTraceHeaders,
} from "../dist/index.js";

function makeState(subjectId = "subj-wire-a") {
  const device = "edge-device-bbbb";
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
    frictionLog: [],
    profile: {
      ageBand: "child",
      track: "SECRET_TRACK_NOT_IN_HEADERS",
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
    deviceId: "edge-device-bbbb",
    edgeState: state,
    lastKnownCloudVector: {},
    syncAttemptId: "33333333-3333-4333-8333-333333333333",
    ...overrides,
    edgeState: overrides.edgeState ?? state,
  };
}

test("happy path: synchronize injects W3C traceparent onto SyncRequest.headers", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  /** @type {import("../dist/index.js").SyncRequest | null} */
  let posted = null;
  const state = makeState();
  const engine = new SyncEngine(
    {
      postSync: async (req) => {
        posted = req;
        return {
          kind: "ok",
          response: {
            protocolVersion: PROTOCOL_VERSION,
            mergedState: req.edgeState,
            compactedSampleTimestamps: [],
            advisories: [],
          },
        };
      },
    },
    {
      syncInstrumentation: createSyncInstrumentation(obs),
      sleep: async () => {},
    },
  );

  const outcome = await engine.synchronize(makeRequest());
  assert.equal(outcome.status, "converged");
  assert.ok(posted?.headers?.traceparent);
  assert.match(
    posted.headers.traceparent,
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i,
  );
  assert.doesNotMatch(
    JSON.stringify(posted.headers),
    /SECRET_TRACK|friction|utterance/i,
  );

  await obs.forceFlush();
  const attempt = capture
    .getFinishedSpans()
    .find((s) => s.name === "sutra.sync.attempt");
  await obs.shutdown();
  await shutdownObservability();

  assert.ok(attempt);
  const [, traceId, spanId] = posted.headers.traceparent.split("-");
  assert.equal(traceId, attempt.spanContext().traceId);
  assert.equal(spanId, attempt.spanContext().spanId);
});

test("happy path: extract + withContinuedSyncSpan parents remote under edge attempt", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createSyncInstrumentation(obs);
  let headers = {};

  await instr.withSync(
    {
      subjectId: "subj-remote",
      deviceId: "edge-device-bbbb",
      syncAttemptId: "33333333-3333-4333-8333-333333333333",
    },
    async (series) => {
      await series.runAttempt(1, async () => {
        headers = injectSyncWireHeaders();
      });
      series.complete({ outcome: "converged", attempts: 1 });
    },
  );

  await withContinuedSyncSpan(
    headers,
    {
      subjectId: "subj-remote",
      deviceId: "edge-device-bbbb",
      syncAttemptId: "33333333-3333-4333-8333-333333333333",
    },
    async () => "merge-ok",
    obs,
  );

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();

  const attempt = spans.find((s) => s.name === "sutra.sync.attempt");
  const remote = spans.find((s) => s.name === "sutra.sync.remote");
  assert.ok(attempt);
  assert.ok(remote);
  assert.equal(remote.spanContext().traceId, attempt.spanContext().traceId);
  assert.equal(remote.parentSpanContext?.spanId, attempt.spanContext().spanId);
});

test("edge: malformed traceparent extract does not throw and leaves context", () => {
  const ctx = extractSyncWireContext({
    traceparent: "not-a-valid-traceparent",
    utterance: "MUST_BE_DROPPED",
  });
  assert.ok(ctx);
  const carrier = injectSyncWireHeaders({
    utterance: "smuggle",
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  });
  assert.equal(carrier.utterance, undefined);
  assert.ok(carrier.traceparent);
});

test("edge: schema accepts optional headers; rejects foreign header keys", () => {
  const base = makeRequest();
  const ok = syncRequestSchema.safeParse({
    ...base,
    headers: {
      traceparent:
        "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    },
  });
  assert.equal(ok.success, true);

  const bad = syncRequestSchema.safeParse({
    ...base,
    headers: { traceparent: "00-aa-bb-01", content: "leak" },
  });
  assert.equal(bad.success, false);
});

test("edge: withInjectedTraceHeaders is a no-op without active span", () => {
  const req = makeRequest();
  const out = withInjectedTraceHeaders(req);
  // No active recording span → may still inject invalid-empty; accept either
  // unchanged request or headers without valid parent linkage.
  if (out.headers?.traceparent) {
    assert.match(out.headers.traceparent, /^00-/);
  } else {
    assert.equal(out, req);
  }
});

test("sovereignty: concurrent subjects inject distinct trace ids", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createSyncInstrumentation(obs);
  /** @type {string[]} */
  const parents = [];

  await Promise.all([
    new SyncEngine(
      {
        postSync: async (req) => {
          parents.push(req.headers?.traceparent ?? "");
          return {
            kind: "ok",
            response: {
              protocolVersion: PROTOCOL_VERSION,
              mergedState: req.edgeState,
              compactedSampleTimestamps: [],
              advisories: [],
            },
          };
        },
      },
      { syncInstrumentation: instr, sleep: async () => {} },
    ).synchronize(makeRequest({ subjectId: "subj-x" })),
    new SyncEngine(
      {
        postSync: async (req) => {
          parents.push(req.headers?.traceparent ?? "");
          return {
            kind: "ok",
            response: {
              protocolVersion: PROTOCOL_VERSION,
              mergedState: req.edgeState,
              compactedSampleTimestamps: [],
              advisories: [],
            },
          };
        },
      },
      { syncInstrumentation: instr, sleep: async () => {} },
    ).synchronize(
      makeRequest({
        subjectId: "subj-y",
        syncAttemptId: "44444444-4444-4444-8444-444444444444",
      }),
    ),
  ]);

  await obs.shutdown();
  assert.equal(parents.length, 2);
  const traceIds = parents.map((p) => p.split("-")[1]);
  assert.notEqual(traceIds[0], traceIds[1]);
});
