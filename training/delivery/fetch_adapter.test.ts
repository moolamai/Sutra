/**
 * A-P5 adapter fetch + provenance (C5 distribution channel).
 * Run: node --experimental-strip-types --test training/delivery/fetch_adapter.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdapterFetchContractError,
  createMemoryAp5Transport,
  fetchAdapterFromAp5Pipeline,
  proveAdapterAp5FetchMicroRun,
  proveAdapterResumableCacheMicroRun,
  resolveAdapterArtifactUrl,
  resolveAdapterFetchProvenancePolicy,
  signAdapterProvenance,
  verifyAdapterProvenanceSignature,
} from "./fetch_adapter.ts";
import {
  AdapterCacheContractError,
  ResumableDurableAdapterCache,
  VerifiedAdapterCache,
} from "../../packages/bindings-slm/dist/adapter_cache.js";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";
const SIGNING_KEY = "ap5-test-signing-key-01";

test("unit: dry-run policy still requires adapter provenance signature", () => {
  const policy = resolveAdapterFetchProvenancePolicy({
    dryRun: true,
    artifactBaseUrl: "https://artifacts.moolam.ai",
  });
  assert.equal(policy.dryRun, true);
  assert.equal(policy.requireSignature, true);
  assert.equal(policy.reason, "dry-run");
});

test("happy path: resolve URL, fetch, verify provenance, cache put", async () => {
  const events = [];
  const subjectId = "subj.adapter.fetch.ok";
  const deviceId = "dev.adapter.fetch.ok";
  const blob = new TextEncoder().encode("fetch-ok-delta");
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
  const cache = new VerifiedAdapterCache({
    subjectId,
    deviceId,
    onTelemetry: (e) => events.push(e),
  });
  const store = {
    blobs: new Map([[contentHash, blob]]),
    signingKey: SIGNING_KEY,
  };

  const resolved = resolveAdapterArtifactUrl({
    contentHash,
    artifactBaseUrl: "https://artifacts.moolam.ai",
  });
  assert.match(resolved.artifactUrl, /\/v1\/adapters\/[a-f0-9]{64}\/artifact\.bin$/);

  const result = await fetchAdapterFromAp5Pipeline({
    subjectId,
    deviceId,
    contentHash,
    artifactBaseUrl: "https://artifacts.moolam.ai",
    signingKey: SIGNING_KEY,
    transport: createMemoryAp5Transport(store),
    cache,
    dryRun: true,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(result.ok, true);
  assert.equal(result.contentHash, contentHash);
  assert.equal(result.policy.dryRun, true);
  const entry = cache.get(contentHash);
  assert.equal(entry.contentHash, contentHash);
  assert.ok(entry.provenanceSignature.length >= 8);
  assert.ok(
    events.some(
      (e) =>
        e.event === "training.adapter.fetch_complete" && e.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: unsigned / bad signature / partial staging invisible / subject isolation", async () => {
  const subjectId = "subj.adapter.fetch.edge";
  const deviceId = "dev.adapter.fetch.edge";
  const cache = new VerifiedAdapterCache({ subjectId, deviceId });
  const blob = new TextEncoder().encode("edge-delta");
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;

  assert.throws(
    () =>
      cache.putVerified({
        contentHash,
        blob,
        provenanceSignature: "",
      }),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.unsigned",
  );

  cache.stagePartial({ contentHash, bytesReceived: 12 });
  assert.throws(
    () => cache.get(contentHash),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.partial_invisible",
  );

  assert.throws(
    () =>
      verifyAdapterProvenanceSignature({
        contentHash,
        signature: "deadbeefdeadbeef",
        signingKey: SIGNING_KEY,
      }),
    (err) =>
      err instanceof AdapterFetchContractError &&
      err.obligation === "adapter.fetch.provenance_mismatch",
  );

  const sig = signAdapterProvenance(contentHash, SIGNING_KEY);
  const env = verifyAdapterProvenanceSignature({
    contentHash,
    signature: sig,
    signingKey: SIGNING_KEY,
  });
  assert.equal(env.pipeline, "a-p5");

  cache.putVerified({
    contentHash,
    blob,
    provenanceSignature: sig,
  });
  assert.throws(
    () => cache.get(contentHash, "subj.other"),
    (err) =>
      err instanceof AdapterCacheContractError &&
      err.obligation === "adapter.cache.subject_scope",
  );

  const proved = await proveAdapterAp5FetchMicroRun();
  assert.equal(proved.ok, true);
  assert.equal(proved.cacheHadVerified, true);
  assert.ok(proved.refused.includes("adapter.fetch.provenance_mismatch"));
  assert.ok(proved.refused.includes("adapter.fetch.checksum"));
  assert.ok(proved.refused.includes("adapter.fetch.invalid_hash"));
});

test("happy path: resumable durable cache mid-download then atomic verify", async () => {
  const events = [];
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "adapter-fetch-resume-"));
  const proved = await proveAdapterResumableCacheMicroRun({
    cacheRoot,
    createCache: ({ cacheRoot: root }) =>
      new ResumableDurableAdapterCache({
        subjectId: "subj.adapter.resume.prove",
        deviceId: "dev.adapter.resume.prove",
        cacheRoot: root,
        onTelemetry: () => {},
      }),
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.firstPartialInvisible, true);
  assert.ok(proved.resumed.resumedFrom > 0);
  assert.equal(proved.afterCorruptRestart.restartedFromCorrupt, true);
  assert.ok(
    events.some(
      (e) => e.event === "training.adapter.fetch_resume" && e.outcome === "ok",
    ),
  );
});
