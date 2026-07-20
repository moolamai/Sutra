/**
 * SYNC-06 advisory regression — UNKNOWN_CONCEPT_QUARANTINED .
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/advisories_unknown_concept.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CrdtHarnessResolver } from "../dist/crdt_harness_resolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  __dirname,
  "../fixtures/advisories/unknown-concept-quarantined.json",
);

function emitAdvisoryEvent(event) {
  process.stdout.write(`${JSON.stringify({ event: "crdt.advisory", ...event })}\n`);
}

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

test("happy path: unknown mastery concepts emit UNKNOWN_CONCEPT_QUARANTINED (SYNC-06)", () => {
  const fx = loadFixture();
  assert.equal(fx.specId, "SYNC-06");
  const resolver = new CrdtHarnessResolver({
    knownConceptIds: fx.knownConceptIds,
  });
  const { merged, advisories } = resolver.merge(fx.local, fx.remote);

  const hits = advisories.filter((a) => a.code === fx.expectAdvisoryCode);
  assert.equal(hits.length, 1, "exactly one quarantine advisory");
  for (const id of fx.expectQuarantinedIds) {
    assert.match(hits[0].detail, new RegExp(id.replace(/\./g, "\\.")));
  }
  // Evidence preserved for later adoption — shards are not dropped.
  assert.deepEqual(
    Object.keys(merged.mastery).sort(),
    [...fx.expectMasteryKeysPreserved].sort(),
  );
  assert.equal(merged.mastery["rogue.unknown.concept"].alpha["edge-bbbb"], 1);
  assert.equal(merged.subjectId, fx.local.subjectId);

  emitAdvisoryEvent({
    outcome: "ok",
    code: fx.expectAdvisoryCode,
    subjectId: merged.subjectId,
    deviceId: fx.remote.deviceIds[0],
    quarantined: fx.expectQuarantinedIds,
  });
});

test("edge: without knownConceptIds, no quarantine advisory (compat)", () => {
  const fx = loadFixture();
  const resolver = new CrdtHarnessResolver();
  const { merged, advisories } = resolver.merge(fx.local, fx.remote);
  assert.equal(
    advisories.some((a) => a.code === "UNKNOWN_CONCEPT_QUARANTINED"),
    false,
  );
  assert.ok(merged.mastery["rogue.unknown.concept"]);
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "edge.compat-no-graph",
    subjectId: fx.local.subjectId,
  });
});

test("edge: all mastery keys known → merge proceeds with zero quarantine advisories", () => {
  const fx = loadFixture();
  const known = new Set([
    ...fx.knownConceptIds,
    "rogue.unknown.concept",
    "also.unknown.z",
  ]);
  const resolver = new CrdtHarnessResolver({ knownConceptIds: known });
  const { advisories } = resolver.merge(fx.local, fx.remote);
  assert.equal(
    advisories.some((a) => a.code === "UNKNOWN_CONCEPT_QUARANTINED"),
    false,
  );
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "edge.all-known",
    subjectId: fx.local.subjectId,
  });
});

test("sovereignty: SUBJECT_MISMATCH still refuses cross-subject merge under graph check", () => {
  const fx = loadFixture();
  const resolver = new CrdtHarnessResolver({
    knownConceptIds: fx.knownConceptIds,
  });
  const foreign = { ...fx.remote, subjectId: "other-subject" };
  assert.throws(
    () => resolver.merge(fx.local, foreign),
    (err) => err && err.code === "SUBJECT_MISMATCH",
  );
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "subjectIsolation",
    code: "SUBJECT_MISMATCH",
  });
});
