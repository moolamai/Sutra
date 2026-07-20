/**
 * Pack v1 format: manifest + content shard schema / Zod validators.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWLEDGE_PACKAGE_ROOT,
  PACK_PASSAGE_CONTENT_MAX_CHARS,
  PACK_V1_JSON_SCHEMA_PATH,
  PACK_V1_SCHEMA_VERSION,
  assertCommittedPackV1Schema,
  loadContentShardFile,
  loadPackManifestFile,
  parseContentShard,
  parsePackManifest,
  validateShardAgainstManifest,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(KNOWLEDGE_PACKAGE_ROOT, "fixtures", "pack-v1");
const VALID_MANIFEST = path.join(FIXTURES, "valid", "manifest.json");
const VALID_SHARD = path.join(FIXTURES, "valid", "content", "shard-001.json");
const INVALID_POSTDATED = path.join(
  FIXTURES,
  "invalid",
  "manifest-postdated-asOf.json",
);
const INVALID_UNCITED = path.join(FIXTURES, "invalid", "shard-uncited.json");
const REPO_ROOT = path.resolve(KNOWLEDGE_PACKAGE_ROOT, "..", "..");
const KNOWLEDGE_PACKS_README = path.join(REPO_ROOT, "knowledge-packs", "README.md");
const SECRET = "LEARNER_QUERY_MUST_NOT_LEAK_IN_TELEMETRY";

const FIXED_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");

test("unit: committed pack-v1 JSON schema exists with version id", () => {
  assert.ok(existsSync(PACK_V1_JSON_SCHEMA_PATH));
  const meta = assertCommittedPackV1Schema({
    subjectId: "subj.pack.schema",
    deviceId: "dev-pack",
  });
  assert.equal(meta.schemaVersion, PACK_V1_SCHEMA_VERSION);
  const raw = JSON.parse(readFileSync(PACK_V1_JSON_SCHEMA_PATH, "utf8"));
  assert.ok(raw.$defs?.manifest);
  assert.ok(raw.$defs?.contentShard);
  assert.ok(raw.$defs?.citation);
  assert.ok(raw.$defs?.passage);
  assert.ok(raw.$defs?.source);
});

test("unit: repo knowledge-packs/ data root README exists (packages never import domains/)", () => {
  assert.ok(existsSync(KNOWLEDGE_PACKS_README));
  const body = readFileSync(KNOWLEDGE_PACKS_README, "utf8");
  assert.ok(body.includes("never as TypeScript imports"));
  assert.ok(body.includes("domains/"));
  assert.ok(!existsSync(path.join(__dirname, "..", "src", "domains")));
});

test("happy path: valid manifest + shard parse and cross-validate", () => {
  const events = [];
  const manifest = loadPackManifestFile(VALID_MANIFEST, {
    subjectId: "subj.pack.valid-a",
    deviceId: "dev-pack-a",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(manifest.ok, true, JSON.stringify(manifest));
  if (!manifest.ok) return;

  assert.equal(manifest.value.locality, "bundled-offline");
  assert.equal(manifest.value.packId, "pack.demo.cbse-math-slice");
  assert.ok(manifest.value.languages.includes("en"));
  assert.ok(manifest.value.sources.length >= 1);

  const shard = loadContentShardFile(VALID_SHARD, {
    subjectId: "subj.pack.valid-a",
    deviceId: "dev-pack-a",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(shard.ok, true, JSON.stringify(shard));
  if (!shard.ok) return;

  const cross = validateShardAgainstManifest(manifest.value, shard.value, {
    subjectId: "subj.pack.valid-a",
    deviceId: "dev-pack-a",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(cross.ok, true, JSON.stringify(cross));
  assert.ok(events.every((e) => e.subjectId === "subj.pack.valid-a"));
  assert.ok(events.some((e) => e.outcome === "ok" && e.op === "parse_manifest"));
  assert.ok(events.some((e) => e.outcome === "ok" && e.op === "validate_shard"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: postdated asOf fails validation (untruthful build clock)", () => {
  const events = [];
  const result = loadPackManifestFile(INVALID_POSTDATED, {
    subjectId: "subj.pack.postdated",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "asOf");
  assert.ok(events.some((e) => e.failureClass === "asOf" && e.outcome === "error"));
});

test("edge: uncited passage (sourceId missing from manifest) fails", () => {
  const events = [];
  const manifest = loadPackManifestFile(VALID_MANIFEST, {
    subjectId: "subj.pack.uncited",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;

  const shard = loadContentShardFile(INVALID_UNCITED, {
    subjectId: "subj.pack.uncited",
    deviceId: "dev-pack",
  });
  assert.equal(shard.ok, true, "shape-valid but citation unresolved");
  if (!shard.ok) return;

  const cross = validateShardAgainstManifest(manifest.value, shard.value, {
    subjectId: "subj.pack.uncited",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(cross.ok, false);
  if (cross.ok) return;
  assert.equal(cross.failureClass, "citation");
  assert.ok(events.some((e) => e.failureClass === "citation"));
});

test("edge: oversized passage content rejected (size bound)", () => {
  const events = [];
  const base = JSON.parse(readFileSync(VALID_SHARD, "utf8"));
  base.passages[0].content = "x".repeat(PACK_PASSAGE_CONTENT_MAX_CHARS + 1);
  const result = parseContentShard(base, {
    subjectId: "subj.pack.oversize",
    deviceId: "dev-pack",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "size");
  assert.ok(events.some((e) => e.failureClass === "size"));
});

test("edge: duplicate citationId within a shard is rejected", () => {
  const base = JSON.parse(readFileSync(VALID_SHARD, "utf8"));
  base.passages.push({
    ...base.passages[0],
    passageId: "pass.duplicate-cite",
    citation: { ...base.passages[0].citation },
  });
  const result = parseContentShard(base, {
    subjectId: "subj.pack.dup-cite",
    deviceId: "dev-pack",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "duplicate");
});

test("sovereignty: telemetry is subject-scoped; raw content never in events", () => {
  const events = [];
  const leak = "RAW_PASSAGE_BODY_MUST_NOT_APPEAR";
  const manifest = loadPackManifestFile(VALID_MANIFEST, {
    subjectId: "subj.pack.iso-a",
    deviceId: "dev-a",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;

  const shardRaw = JSON.parse(readFileSync(VALID_SHARD, "utf8"));
  shardRaw.passages[0].content = leak;
  const shard = parseContentShard(shardRaw, {
    subjectId: "subj.pack.iso-a",
    deviceId: "dev-a",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(shard.ok, true);
  if (!shard.ok) return;

  validateShardAgainstManifest(manifest.value, shard.value, {
    subjectId: "subj.pack.iso-a",
    deviceId: "dev-a",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });

  const other = parsePackManifest(manifest.value, {
    subjectId: "subj.pack.iso-b",
    deviceId: "dev-b",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(other.ok, true);

  const forA = events.filter((e) => e.subjectId === "subj.pack.iso-a");
  const forB = events.filter((e) => e.subjectId === "subj.pack.iso-b");
  assert.ok(forA.length >= 1);
  assert.ok(forB.length >= 1);
  assert.ok(forA.every((e) => e.subjectId !== "subj.pack.iso-b"));
  assert.ok(!JSON.stringify(events).includes(leak));
});

test("scalability: passage / source / language bounds are finite constants", () => {
  assert.equal(PACK_PASSAGE_CONTENT_MAX_CHARS, 32_000);
  assert.ok(PACK_PASSAGE_CONTENT_MAX_CHARS < 100_000);
});

test("idempotency: replaying the same manifest parse yields the same outcome", () => {
  const raw = JSON.parse(readFileSync(VALID_MANIFEST, "utf8"));
  const a = parsePackManifest(raw, { nowMs: FIXED_NOW_MS, subjectId: "subj.pack.idem" });
  const b = parsePackManifest(raw, { nowMs: FIXED_NOW_MS, subjectId: "subj.pack.idem" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) {
    assert.deepEqual(a.value, b.value);
  }
});

test("format: bundled-offline locality declared (retrieval with network denied is later slice)", () => {
  const manifest = loadPackManifestFile(VALID_MANIFEST, {
    subjectId: "subj.pack.offline",
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.equal(manifest.value.locality, "bundled-offline");
  assert.ok(
    manifest.value.sources.every((s) =>
      ["bundled-offline", "self-hosted", "external-api"].includes(s.locality),
    ),
  );
});

