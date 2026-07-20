/**
 * Unit tests for @moolam/observability OTel bootstrap .
 * Run: pnpm --filter @moolam/observability test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import {
  ALLOWED_TURN_ATTR_KEYS,
  TURN_STAGE_NAMES,
  DropOnFailureSpanExporter,
  initObservability,
  resolveExporterKind,
  shutdownObservability,
  ObservabilityConfigError,
} from "../dist/index.js";

/** @param {import("@opentelemetry/sdk-trace-base").ReadableSpan[]} spans */
function allAttrKeys(spans) {
  const keys = new Set();
  for (const s of spans) {
    for (const k of Object.keys(s.attributes ?? {})) keys.add(k);
  }
  return [...keys];
}

test("resolveExporterKind defaults to noop and accepts otlp/console", () => {
  assert.equal(resolveExporterKind({}), "noop");
  assert.equal(resolveExporterKind({ MOOLAM_OTEL_EXPORTER: "otlp" }), "otlp");
  assert.equal(
    resolveExporterKind({ MOOLAM_OTEL_EXPORTER: "console" }),
    "console",
  );
  assert.throws(
    () => resolveExporterKind({ MOOLAM_OTEL_EXPORTER: "datadog" }),
    (err) =>
      err instanceof ObservabilityConfigError &&
      err.code === "OBSERVABILITY_CONFIG_INVALID",
  );
});

test("happy path: scaffold turn span tree is metadata-only and parent/child linked", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
    serviceName: "sutra-test",
  });

  obs.recordScaffoldTurnTree({
    subjectId: "subj-a",
    sessionId: "sess-1",
    deviceId: "dev-1",
  });
  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();

  assert.ok(spans.length >= 1 + TURN_STAGE_NAMES.length);

  const root = spans.find((s) => s.name === "sutra.turn");
  assert.ok(root);
  assert.equal(root.attributes["sutra.subject_id"], "subj-a");
  assert.equal(root.attributes["sutra.session_id"], "sess-1");
  assert.equal(root.attributes["sutra.device_id"], "dev-1");

  const stages = spans.filter((s) => s.name.startsWith("sutra.turn."));
  assert.equal(stages.length, TURN_STAGE_NAMES.length);
  for (const stage of TURN_STAGE_NAMES) {
    const child = stages.find((s) => s.name === `sutra.turn.${stage}`);
    assert.ok(child, `missing stage span ${stage}`);
    assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(child.attributes["sutra.stage"], stage);
  }

  for (const key of allAttrKeys(spans)) {
    assert.ok(
      ALLOWED_TURN_ATTR_KEYS.includes(/** @type {any} */ (key)),
      `unexpected attr key ${key}`,
    );
  }
  const blob = JSON.stringify(spans.map((s) => s.attributes));
  assert.doesNotMatch(blob, /utterance|memory passage|tool.args/i);
  assert.doesNotMatch(blob, /"help me with homework"/i);
});

test("edge: omitted stages leave no no-op placeholder spans", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  obs.recordScaffoldTurnTree(
    { subjectId: "subj-b", sessionId: "sess-2" },
    { omitStages: ["perceive", "reflect"] },
  );
  await obs.forceFlush();
  const names = capture.getFinishedSpans().map((s) => s.name);
  await obs.shutdown();
  assert.ok(!names.includes("sutra.turn.perceive"));
  assert.ok(!names.includes("sutra.turn.reflect"));
  assert.ok(names.includes("sutra.turn.reason"));
});

test("edge: mid-turn failure records error on root and still closes children", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  obs.recordScaffoldTurnTree(
    { subjectId: "subj-c", sessionId: "sess-3" },
    { failAt: "reason" },
  );
  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();
  const root = spans.find((s) => s.name === "sutra.turn");
  assert.ok(root);
  assert.equal(root.status.code, 2); // SpanStatusCode.ERROR
  const reason = spans.find((s) => s.name === "sutra.turn.reason");
  assert.ok(reason);
  assert.equal(reason.status.code, 2);
  assert.ok(!spans.some((s) => s.name === "sutra.turn.respond"));
});

test("sovereignty: concurrent subjects do not share trace ids", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  obs.recordScaffoldTurnTree({ subjectId: "subj-x", sessionId: "s1" });
  obs.recordScaffoldTurnTree({ subjectId: "subj-y", sessionId: "s2" });
  await obs.forceFlush();
  const roots = capture
    .getFinishedSpans()
    .filter((s) => s.name === "sutra.turn");
  await obs.shutdown();
  assert.equal(roots.length, 2);
  assert.notEqual(
    roots[0].spanContext().traceId,
    roots[1].spanContext().traceId,
  );
  assert.equal(roots[0].attributes["sutra.subject_id"], "subj-x");
  assert.equal(roots[1].attributes["sutra.subject_id"], "subj-y");
});

test("edge: exporter failure drops spans with counter and never throws", async () => {
  const captureFail = {
    export(_spans, cb) {
      cb({ code: ExportResultCode.FAILED });
    },
    async shutdown() {},
    async forceFlush() {},
  };
  const wrapped = new DropOnFailureSpanExporter(captureFail);
  await new Promise((resolve) => {
    wrapped.export(
      /** @type {any} */ ([{ name: "x" }]),
      (result) => {
        assert.equal(result.code, ExportResultCode.SUCCESS);
        resolve(undefined);
      },
    );
  });
  assert.equal(wrapped.getDroppedCount(), 1);

  const obs = await initObservability({
    exporter: "noop",
    captureExporter: captureFail,
  });
  assert.doesNotThrow(() =>
    obs.recordScaffoldTurnTree({ subjectId: "subj-d", sessionId: "sess-4" }),
  );
  await obs.forceFlush();
  assert.ok(obs.getDroppedSpanCount() >= 1);
  await obs.shutdown();
  await shutdownObservability();
});
