/**
 * Distribution-channel integration: interrupted download → resume → verify.
 *
 * Covers: partial invisible to loader, network partition mid-resume, corrupt
 * checksum fixture restart, unsigned refuse, subject isolation, idempotent hit.
 *
 * Run (repo root, after bindings-slm build):
 *   node --experimental-strip-types --test training/delivery/distribution_interrupted.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  proveInterruptedDownloadIntegration,
} from "./fetch_adapter.ts";
import { ResumableDurableAdapterCache } from "../../packages/bindings-slm/dist/adapter_cache.js";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("integration: interrupted download resume verifies; corrupt/unsigned/subject edges", async () => {
  const events = [];
  const cacheRoot = mkdtempSync(
    path.join(tmpdir(), "adapter-dist-interrupt-"),
  );

  const proved = await proveInterruptedDownloadIntegration({
    cacheRoot,
    createCache: ({ cacheRoot: root }) =>
      new ResumableDurableAdapterCache({
        subjectId: "subj.adapter.interrupt.int",
        deviceId: "dev.adapter.interrupt.int",
        cacheRoot: root,
      }),
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.loaderNeverSawPartial, true);
  assert.equal(proved.partitionRefused, true);
  assert.equal(proved.resumedOk, true);
  assert.equal(proved.corruptRestarted, true);
  assert.equal(proved.unsignedBlocked, true);
  assert.equal(proved.subjectIsolated, true);
  assert.equal(proved.idempotentHit, true);
  assert.match(proved.contentHash, /^sha256:[a-f0-9]{64}$/);

  assert.ok(
    events.some(
      (e) =>
        e.event === "training.adapter.fetch_resume" && e.outcome === "ok",
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "training.adapter.fetch_complete" && e.outcome === "ok",
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "training.adapter.fetch_complete" &&
        e.outcome === "fail" &&
        e.failureClass === "adapter.fetch.network",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(
    events.every((e) => !("content" in e) && !("utterance" in e) && !("blob" in e)),
  );
});
