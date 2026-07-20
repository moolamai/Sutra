/**
 * Unit edges for sync_audit helpers (no SyncEngine).
 * Run: pnpm --filter @moolam/observability test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  ALLOWED_SYNC_ATTR_KEYS,
  createSyncInstrumentation,
  initObservability,
  shutdownObservability,
} from "../dist/index.js";

test("pass-through when observability is not initialized", async () => {
  const instr = createSyncInstrumentation(null);
  const terminal = await instr.withSync(
    {
      subjectId: "s1",
      deviceId: "d1",
      syncAttemptId: "11111111-1111-4111-8111-111111111111",
    },
    async (series) => {
      await series.runAttempt(1, async () => "ok");
      series.recordAdvisories([{ code: "CLOCK_SKEW_CLAMPED" }]);
      series.complete({ outcome: "converged", attempts: 1 });
      return "done";
    },
  );
  assert.equal(terminal, "done");
});

test("standalone sync root when no active turn context", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createSyncInstrumentation(obs);

  await instr.withSync(
    {
      subjectId: "subj-a",
      deviceId: "dev-a",
      syncAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      connectivity: "offline",
      maxAttempts: 1,
    },
    async (series) => {
      await series.runAttempt(1, async () => null);
      series.complete({ outcome: "exhausted", attempts: 1, exhaustedCode: "TRANSIENT_ATTEMPTS_EXHAUSTED" });
    },
  );

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();
  await shutdownObservability();

  const root = spans.find((s) => s.name === "sutra.sync");
  assert.ok(root);
  assert.equal(root.attributes["sutra.connectivity"], "offline");
  assert.equal(root.attributes["sutra.outcome"], "exhausted");
  assert.equal(root.status.code, 1);
  for (const key of Object.keys(root.attributes ?? {})) {
    assert.ok(ALLOWED_SYNC_ATTR_KEYS.includes(key), key);
  }
});
