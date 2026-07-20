/**
 * Teacher CBSE slice pack wired into CognitiveCore (no domains/ import).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  TEACHER_CBSE_SLICE_PACK_ID,
  assertPackIsDataNotDomainImport,
  loadTeacherCbseSliceConnector,
  proveTeacherPackCognitiveCore,
  resolveTeacherCbseSlicePackRoot,
  validatePack,
} from "../dist/index.js";

const FIXED_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");
const SECRET = "LEARNER_RATIO_QUESTION_MUST_NOT_LEAK";

test("unit: teacher-cbse-slice pack exists under knowledge-packs/ (not domains/)", () => {
  const packRoot = resolveTeacherCbseSlicePackRoot();
  assert.ok(existsSync(path.join(packRoot, "manifest.json")));
  assert.ok(assertPackIsDataNotDomainImport(packRoot));
  assert.ok(!packRoot.replace(/\\/g, "/").includes("/domains/"));
  const validated = validatePack(packRoot, { nowMs: FIXED_NOW_MS });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  if (validated.ok) {
    assert.equal(validated.value.manifest.packId, TEACHER_CBSE_SLICE_PACK_ID);
    assert.equal(validated.value.manifest.locality, "bundled-offline");
  }
});

test("happy path: CognitiveCore turn grounded by teacher pack (network denied)", async () => {
  const events = [];
  const proof = await proveTeacherPackCognitiveCore({
    subjectId: "subj.teacher.wire.ok",
    deviceId: "dev-teacher-wire",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proof.ok, true, JSON.stringify(proof.failures));
  assert.equal(proof.domainsImportFree, true);
  assert.equal(proof.localityOk, true);
  assert.equal(proof.egressAttemptCount, 0);
  assert.equal(proof.locality, "bundled-offline");
  assert.ok(proof.citationCount >= 1);
  assert.ok(proof.packRoot.includes("teacher-cbse-slice"));
  assert.ok(events.some((e) => e.outcome === "pass"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: loadTeacherCbseSliceConnector retrieve returns cited ratio hits", async () => {
  const connector = loadTeacherCbseSliceConnector({
    subjectId: "subj.teacher.wire.retrieve",
    deviceId: "dev-teacher",
    nowMs: FIXED_NOW_MS,
  });
  const desc = connector.describe();
  const hits = await connector.retrieve({
    query: "same ratio 3:4 and 6:8",
    limit: 4,
  });
  assert.ok(hits.length >= 1);
  assert.ok(
    hits.every((h) =>
      desc.sources.some((s) => s.sourceId === h.sourceId && h.citation.trim()),
    ),
  );
});

test("sovereignty: wiring telemetry is subject-scoped", async () => {
  const events = [];
  await proveTeacherPackCognitiveCore({
    subjectId: "subj.teacher.wire.iso-a",
    deviceId: "dev-a",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  await proveTeacherPackCognitiveCore({
    subjectId: "subj.teacher.wire.iso-b",
    deviceId: "dev-b",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.subjectId === "subj.teacher.wire.iso-a"));
  assert.ok(events.some((e) => e.subjectId === "subj.teacher.wire.iso-b"));
});

test("unit: teacher-basic example does not import domains/ as a module", () => {
  const examplePath = path.resolve(
    resolveTeacherCbseSlicePackRoot(),
    "..",
    "..",
    "examples",
    "teacher-basic",
    "main.mjs",
  );
  assert.ok(existsSync(examplePath));
  const src = readFileSync(examplePath, "utf8");
  assert.ok(!/from\s+["'].*domains\//.test(src));
  assert.ok(!/import\s+["'].*domains\//.test(src));
  assert.ok(src.includes("sutra-bindings-knowledge"));
  assert.ok(src.includes("loadTeacherCbseSliceConnector"));
});

