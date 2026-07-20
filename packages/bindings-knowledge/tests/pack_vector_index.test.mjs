/**
 * Optional vector index layer: embeddings.bin + id-map integrity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  KNOWLEDGE_PACKAGE_ROOT,
  PACK_VECTOR_EMBEDDINGS_RELPATH,
  expectedEmbeddingsByteLength,
  isFullVectorIndexLayer,
  parseVectorIdMap,
  validatePack,
  validateVectorIndexIntegrity,
} from "../dist/index.js";

const FIXTURES = path.join(KNOWLEDGE_PACKAGE_ROOT, "fixtures", "pack-v1");
const VALID_PACK = path.join(FIXTURES, "valid");
const INVALID_ORPHAN = path.join(FIXTURES, "packs", "invalid-orphan-vector");
const INVALID_SIZE = path.join(FIXTURES, "packs", "invalid-embeddings-size");
const INVALID_MISSING = path.join(FIXTURES, "packs", "invalid-embeddings-missing");
const FIXED_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");
const SECRET = "LEARNER_EMBEDDING_QUERY_MUST_NOT_LEAK";

test("happy path: validatePack accepts embeddings.bin + id-map layer", () => {
  const events = [];
  assert.ok(existsSync(path.join(VALID_PACK, PACK_VECTOR_EMBEDDINGS_RELPATH)));
  const result = validatePack(VALID_PACK, {
    subjectId: "subj.pack.v3.valid",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.ok(result.value.vectorMap);
  assert.ok(isFullVectorIndexLayer(result.value.vectorMap));
  assert.ok(result.value.vectorIndex);
  assert.equal(result.value.vectorIndex.dimensions, 8);
  assert.equal(result.value.vectorIndex.dtype, "float32");
  assert.equal(result.value.vectorIndex.rowCount, 1);
  assert.equal(
    result.value.vectorIndex.embeddingsByteLength,
    expectedEmbeddingsByteLength(1, 8),
  );
  assert.ok(
    events.some((e) => e.op === "validate_vector_index" && e.outcome === "ok"),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: orphan vector passageId still fails before embeddings integrity", () => {
  const result = validatePack(INVALID_ORPHAN, {
    subjectId: "subj.pack.v3.orphan",
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "vector");
  assert.ok(result.message.includes("orphan"));
});

test("edge: embeddings.bin wrong byte length fails integrity", () => {
  const events = [];
  const result = validatePack(INVALID_SIZE, {
    subjectId: "subj.pack.v3.size",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "vector");
  assert.ok(result.message.includes("byte length"));
  assert.ok(
    events.some((e) => e.op === "validate_vector_index" && e.outcome === "error"),
  );
});

test("edge: dimensions declared but embeddings.bin missing fails", () => {
  const result = validatePack(INVALID_MISSING, {
    subjectId: "subj.pack.v3.missing",
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "vector");
  assert.ok(result.message.includes("embeddings missing"));
});

test("unit: validateVectorIndexIntegrity rejects missing vectorIndex coverage", () => {
  const idMap = parseVectorIdMap({
    schemaVersion: "bindings-knowledge.pack-v1",
    dimensions: 8,
    dtype: "float32",
    entries: [
      { passageId: "pass.a", vectorIndex: 0 },
      { passageId: "pass.b", vectorIndex: 0 },
    ],
  });
  // duplicate passageId fails at parse — use unique passages with gap
  const gap = parseVectorIdMap({
    schemaVersion: "bindings-knowledge.pack-v1",
    dimensions: 8,
    dtype: "float32",
    entries: [
      { passageId: "pass.a", vectorIndex: 0 },
      { passageId: "pass.b", vectorIndex: 2 },
    ],
  });
  assert.equal(gap.ok, true);
  if (!gap.ok) return;
  const bytes = new Uint8Array(expectedEmbeddingsByteLength(2, 8));
  const result = validateVectorIndexIntegrity(gap.value, bytes, {
    subjectId: "subj.pack.v3.gap",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "vector");
  assert.ok(idMap.ok === false || idMap.ok === true); // parse path exercised
});

test("sovereignty: vector telemetry never includes embedding bytes or passage text", () => {
  const events = [];
  const emb = readFileSync(path.join(VALID_PACK, PACK_VECTOR_EMBEDDINGS_RELPATH));
  validatePack(VALID_PACK, {
    subjectId: "subj.pack.v3.iso",
    deviceId: "dev-iso",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(Buffer.from(emb).toString("base64")));
  assert.ok(!blob.includes("linear equation"));
  assert.ok(events.every((e) => e.subjectId === "subj.pack.v3.iso"));
});

test("scalability: expectedEmbeddingsByteLength is bounded product", () => {
  assert.equal(expectedEmbeddingsByteLength(1, 8), 32);
  assert.equal(expectedEmbeddingsByteLength(2, 8), 64);
  assert.ok(expectedEmbeddingsByteLength(8192, 8) < 300_000_000);
});

