/**
 * Golden join corpus consumer .
 * Loads identical fixtures as the Python suite and asserts byte-identical
 * canonical joins from CrdtHarnessResolver.
 *
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/golden_joins.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CrdtHarnessResolver, IrreconcilableStateError } from "../dist/crdt_harness_resolver.js";
import {
  canonicalizeState,
  applyCompactionHandshake,
} from "./merge_canon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "../fixtures/golden-joins");

function emitGoldenEvent(event) {
  process.stdout.write(`${JSON.stringify({ event: "crdt.golden", ...event })}\n`);
}

function loadManifest() {
  const manifestPath = path.join(FIXTURE_DIR, "manifest.json");
  assert.equal(existsSync(manifestPath), true, "golden-joins manifest missing");
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function loadCase(file) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
}

/** Loud mismatch for CI — case id + bounded got/expected snippets (never silent). */
function assertCanonicalJoin(caseId, got, expected) {
  if (got === expected) return;
  const excerpt = (s) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);
  emitGoldenEvent({
    outcome: "error",
    code: "GOLDEN_JOIN_MISMATCH",
    id: caseId,
    gotLen: got.length,
    expectedLen: expected.length,
  });
  assert.fail(
    [
      `GOLDEN_JOIN_MISMATCH:${caseId}`,
      `--- expected`,
      excerpt(expected),
      `+++ got`,
      excerpt(got),
    ].join("\n"),
  );
}

test("happy path: corpus has ~20 language-neutral cases with canonical keys", () => {
  const manifest = loadManifest();
  assert.ok(manifest.cases.length >= 20, "expected at least 20 golden triples");
  assert.equal(manifest.protocolVersion, "1.0.0");
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json");
  assert.equal(files.length, manifest.cases.length);
  emitGoldenEvent({
    outcome: "ok",
    kind: "corpus.size",
    count: manifest.cases.length,
  });
});

test("happy path: TS merge matches expectedJoin bytes for every join case", () => {
  const resolver = new CrdtHarnessResolver();
  const manifest = loadManifest();
  let joins = 0;
  for (const entry of manifest.cases) {
    const c = loadCase(entry.file);
    assert.equal(typeof c.id, "string");
    assert.equal(c.stateA.protocolVersion, "1.0.0");
    assert.equal(c.stateB.protocolVersion, "1.0.0");
    // Fixture objects use sorted keys from the generator (language-neutral).
    assert.ok(!("undefined" in c));

    if (c.expectError) {
      assert.throws(
        () => resolver.merge(c.stateA, c.stateB),
        (err) =>
          err instanceof IrreconcilableStateError && err.code === c.expectError,
      );
      emitGoldenEvent({
        outcome: "ok",
        kind: "subjectIsolation",
        id: c.id,
        code: c.expectError,
        subjectId: c.stateA.subjectId,
        deviceId: c.stateA.deviceIds[0] ?? null,
      });
      continue;
    }

    assert.equal(c.stateA.subjectId, c.stateB.subjectId, `cross-subject in ${c.id}`);
    const { merged } = resolver.merge(c.stateA, c.stateB);
    const got = canonicalizeState(merged);
    const expected = canonicalizeState(c.expectedJoin);
    assertCanonicalJoin(c.id, got, expected);
    joins += 1;

    if (c.kind === "compaction") {
      assert.ok(Array.isArray(c.compactedSampleTimestamps));
      assert.ok(c.compactedSampleTimestamps.length > 0);
      const pruned = applyCompactionHandshake(c.stateA, c.compactedSampleTimestamps);
      for (const s of pruned.frictionLog) {
        assert.equal(c.compactedSampleTimestamps.includes(s.capturedAt), false);
      }
      const again = resolver.merge(merged, pruned).merged;
      assertCanonicalJoin(
        `${c.id}/compaction-remerge`,
        canonicalizeState(again),
        canonicalizeState(c.expectedAfterPruneRemerge),
      );
    }

    emitGoldenEvent({
      outcome: "ok",
      kind: c.kind,
      id: c.id,
      subjectId: c.subjectId,
      deviceId: c.stateA.deviceIds[0] ?? null,
    });
  }
  assert.ok(joins >= 19);
  emitGoldenEvent({ outcome: "ok", kind: "ts.joins", count: joins });
});

test("edge: golden JSON has no NaN/Infinity artifacts", () => {
  const manifest = loadManifest();
  for (const entry of manifest.cases) {
    const raw = readFileSync(path.join(FIXTURE_DIR, entry.file), "utf8");
    assert.equal(raw.includes("NaN"), false, entry.file);
    assert.equal(raw.includes("Infinity"), false, entry.file);
    assert.equal(raw.includes("undefined"), false, entry.file);
  }
  emitGoldenEvent({ outcome: "ok", kind: "edge.languageNeutral" });
});

test("edge: README documents human-review regeneration path", () => {
  const readme = readFileSync(path.join(FIXTURE_DIR, "README.md"), "utf8");
  assert.match(readme, /human review/i);
  assert.match(readme, /never auto-commit/i);
  assert.match(readme, /generate-golden-joins/);
  emitGoldenEvent({ outcome: "ok", kind: "edge.regenPolicy" });
});
