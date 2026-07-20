/**
 * Unit tests for inject/extract helpers (no SyncEngine).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { context, trace } from "@opentelemetry/api";
import {
  createSyncInstrumentation,
  extractSyncWireContext,
  initObservability,
  injectSyncWireHeaders,
  normalizeSyncWireCarrier,
  shutdownObservability,
  withContinuedSyncSpan,
} from "../dist/index.js";

test("injectSyncWireHeaders drops smuggled content keys", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createSyncInstrumentation(obs);
  let carrier = {};
  await instr.withSync(
    {
      subjectId: "s1",
      deviceId: "d1",
      syncAttemptId: "11111111-1111-4111-8111-111111111111",
    },
    async (series) => {
      await series.runAttempt(1, async () => {
        carrier = injectSyncWireHeaders({
          utterance: "SECRET",
          content: "MEMORY",
          traceparent: "stale",
        });
      });
      series.complete({ outcome: "converged", attempts: 1 });
    },
  );
  await obs.shutdown();
  await shutdownObservability();
  assert.equal(carrier.utterance, undefined);
  assert.equal(carrier.content, undefined);
  assert.match(carrier.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/i);
});

test("normalizeSyncWireCarrier only keeps W3C keys", () => {
  const n = normalizeSyncWireCarrier({
    Traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    "X-Utterance": "nope",
    tracestate: "vendor=1",
  });
  assert.deepEqual(Object.keys(n).sort(), ["traceparent", "tracestate"]);
});

test("extract malformed returns parent context unchanged", () => {
  const parent = context.active();
  const out = extractSyncWireContext({ traceparent: "bad" }, parent);
  assert.equal(out, parent);
});
