/**
 * Verified adapter cache (C5 distribution).
 * Run via: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdapterCacheContractError,
  ResumableDurableAdapterCache,
  VerifiedAdapterCache,
} from "../dist/adapter_cache.js";

test("happy path: putVerified then get returns same bytes", () => {
  const events = [];
  const subjectId = "subj.adapter.cache.ok";
  const deviceId = "dev.adapter.cache.ok";
  const blob = Buffer.from("verified-cache-delta");
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
  const cache = new VerifiedAdapterCache({
    subjectId,
    deviceId,
    onTelemetry: (e) => events.push(e),
  });

  const entry = cache.putVerified({
    contentHash,
    blob,
    provenanceSignature: "a".repeat(64),
  });
  assert.equal(entry.contentHash, contentHash);
  assert.deepEqual(cache.get(contentHash).blob, blob);
  assert.ok(
    events.some(
      (e) => e.event === "bindings.adapter.cache_put" && e.verified === true,
    ),
  );
});

test("edge: unsigned blocked; partial invisible; cross-subject denied", () => {
  const subjectId = "subj.adapter.cache.edge";
  const deviceId = "dev.adapter.cache.edge";
  const blob = Buffer.from("cache-edge-delta");
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
  const cache = new VerifiedAdapterCache({ subjectId, deviceId });

  assert.throws(
    () =>
      cache.putVerified({
        contentHash,
        blob,
        provenanceSignature: "short",
      }),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.unsigned",
  );

  cache.stagePartial({ contentHash, bytesReceived: 4 });
  assert.equal(cache.stagingCount, 1);
  assert.throws(
    () => cache.get(contentHash),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.partial_invisible",
  );

  cache.putVerified({
    contentHash,
    blob,
    provenanceSignature: "b".repeat(64),
  });
  assert.equal(cache.stagingCount, 0);
  assert.throws(
    () => cache.get(contentHash, "subj.other"),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.subject_scope",
  );

  const wrongHash = `sha256:${"c".repeat(64)}`;
  assert.throws(
    () =>
      cache.putVerified({
        contentHash: wrongHash,
        blob,
        provenanceSignature: "d".repeat(64),
      }),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.hash_mismatch",
  );
});

test("happy path: durable resume append → atomic commit; loader never sees partial", () => {
  const events = [];
  const root = mkdtempSync(path.join(tmpdir(), "adapter-cache-"));
  const subjectId = "subj.adapter.durable.ok";
  const deviceId = "dev.adapter.durable.ok";
  const blob = Buffer.from("durable-resumable-delta-bytes");
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
  const cache = new ResumableDurableAdapterCache({
    subjectId,
    deviceId,
    cacheRoot: root,
    onTelemetry: (e) => events.push(e),
  });

  const mid = Math.floor(blob.length / 2);
  cache.appendPartial({ contentHash, chunk: blob.subarray(0, mid) });
  assert.equal(cache.resumeOffset(contentHash), mid);
  assert.equal(cache.stagingCount, 1);
  assert.throws(
    () => cache.get(contentHash),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.partial_invisible",
  );

  cache.appendPartial({ contentHash, chunk: blob.subarray(mid) });
  const entry = cache.commitPartialAtomic({
    contentHash,
    provenanceSignature: "e".repeat(64),
  });
  assert.equal(entry.contentHash, contentHash);
  assert.equal(cache.stagingCount, 0);
  assert.deepEqual(cache.get(contentHash).blob, blob);
  assert.ok(existsSync(path.join(root, "subj.adapter.durable.ok", "verified")));
  assert.ok(
    events.some(
      (e) => e.event === "bindings.adapter.cache_commit" && e.outcome === "ok",
    ),
  );
});

test("edge: corrupt partial discarded and unsigned commit refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-cache-bad-"));
  const subjectId = "subj.adapter.durable.bad";
  const deviceId = "dev.adapter.durable.bad";
  const blob = Buffer.from("good-durable-bytes");
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
  const cache = new ResumableDurableAdapterCache({
    subjectId,
    deviceId,
    cacheRoot: root,
  });

  cache.appendPartial({
    contentHash,
    chunk: Buffer.from("not-the-real-bytes"),
  });
  assert.throws(
    () =>
      cache.commitPartialAtomic({
        contentHash,
        provenanceSignature: "f".repeat(64),
      }),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.resume_corrupt",
  );
  assert.equal(cache.resumeOffset(contentHash), 0);

  cache.appendPartial({ contentHash, chunk: blob });
  assert.throws(
    () =>
      cache.commitPartialAtomic({
        contentHash,
        provenanceSignature: "",
      }),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.unsigned",
  );
});
