/**
 * Pack-level validatePack + validate-pack CLI (reject uncited / orphan vectors).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  KNOWLEDGE_PACKAGE_ROOT,
  PACK_VECTOR_ID_MAP_RELPATH,
  runValidatePackCli,
  validatePack,
} from "../dist/index.js";

const FIXTURES = path.join(KNOWLEDGE_PACKAGE_ROOT, "fixtures", "pack-v1");
const VALID_PACK = path.join(FIXTURES, "valid");
const INVALID_UNCITED = path.join(FIXTURES, "packs", "invalid-uncited");
const INVALID_ORPHAN = path.join(FIXTURES, "packs", "invalid-orphan-vector");
const INVALID_DUP = path.join(FIXTURES, "packs", "invalid-cross-shard-dup-cite");
const FIXED_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");
const SECRET = "LEARNER_QUERY_MUST_NOT_LEAK";

test("happy path: validatePack accepts cited pack with optional vector id map", () => {
  const events = [];
  assert.ok(existsSync(path.join(VALID_PACK, PACK_VECTOR_ID_MAP_RELPATH)));
  const result = validatePack(VALID_PACK, {
    subjectId: "subj.pack.v2.valid",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.manifest.locality, "bundled-offline");
  assert.equal(result.value.passageCount, 1);
  assert.ok(result.value.vectorMap);
  assert.equal(result.value.vectorMap.entries.length, 1);
  assert.ok(result.value.vectorIndex);
  assert.equal(result.value.vectorIndex.rowCount, 1);
  assert.ok(events.some((e) => e.op === "validate_pack" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: validatePack rejects uncited sourceId (exit path for CI)", () => {
  const events = [];
  const result = validatePack(INVALID_UNCITED, {
    subjectId: "subj.pack.v2.uncited",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "citation");
  assert.ok(events.some((e) => e.failureClass === "citation"));
});

test("edge: validatePack rejects orphan vector rows", () => {
  const events = [];
  const result = validatePack(INVALID_ORPHAN, {
    subjectId: "subj.pack.v2.orphan",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "vector");
  assert.ok(result.message.includes("orphan"));
  assert.ok(events.some((e) => e.failureClass === "vector"));
});

test("edge: validatePack rejects duplicate citationId across shards", () => {
  const result = validatePack(INVALID_DUP, {
    subjectId: "subj.pack.v2.dup",
    deviceId: "dev-pack",
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "duplicate");
});

test("CLI: validate-pack exits 0 on valid pack and 1 on uncited", () => {
  const out = { chunks: [] };
  const err = { chunks: [] };
  const stdout = { write: (c) => out.chunks.push(c) };
  const stderr = { write: (c) => err.chunks.push(c) };

  const okCode = runValidatePackCli(
    ["--pack", VALID_PACK, "--subject-id", "subj.pack.cli.ok"],
    { stdout, stderr },
    { nowMs: FIXED_NOW_MS },
  );
  assert.equal(okCode, 0);
  const okLine = JSON.parse(out.chunks.join(""));
  assert.equal(okLine.outcome, "ok");
  assert.equal(okLine.subjectId, "subj.pack.cli.ok");
  assert.ok(!JSON.stringify(okLine).includes(SECRET));

  out.chunks.length = 0;
  err.chunks.length = 0;
  const badCode = runValidatePackCli(
    ["--pack", INVALID_UNCITED, "--subject-id", "subj.pack.cli.bad"],
    { stdout, stderr },
    { nowMs: FIXED_NOW_MS },
  );
  assert.equal(badCode, 1);
  const badLine = JSON.parse(err.chunks.join(""));
  assert.equal(badLine.outcome, "error");
  assert.equal(badLine.failureClass, "citation");
});

test("CLI: orphan vector pack exits 1", () => {
  const stderr = { chunks: [], write(c) { this.chunks.push(c); } };
  const stdout = { write() {} };
  const code = runValidatePackCli(
    [INVALID_ORPHAN],
    { stdout, stderr },
    { nowMs: FIXED_NOW_MS },
  );
  assert.equal(code, 1);
  const line = JSON.parse(stderr.chunks.join(""));
  assert.equal(line.failureClass, "vector");
});

test("sovereignty: validatePack telemetry is subject-scoped", () => {
  const events = [];
  validatePack(VALID_PACK, {
    subjectId: "subj.pack.v2.iso-a",
    deviceId: "dev-a",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  validatePack(VALID_PACK, {
    subjectId: "subj.pack.v2.iso-b",
    deviceId: "dev-b",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.subjectId === "subj.pack.v2.iso-a"));
  assert.ok(events.some((e) => e.subjectId === "subj.pack.v2.iso-b"));
  assert.ok(
    events
      .filter((e) => e.subjectId === "subj.pack.v2.iso-a")
      .every((e) => e.deviceId === "dev-a"),
  );
});

test("idempotency: validatePack replay yields the same outcome", () => {
  const a = validatePack(VALID_PACK, { nowMs: FIXED_NOW_MS, subjectId: "subj.idem" });
  const b = validatePack(VALID_PACK, { nowMs: FIXED_NOW_MS, subjectId: "subj.idem" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) {
    assert.equal(a.value.passageCount, b.value.passageCount);
    assert.deepEqual(a.value.manifest, b.value.manifest);
  }
});

