/**
 * SYNC-06 advisory regression — STATE_VECTOR_REGRESSION .
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/advisories_state_vector_regression.test.mjs
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
  "../fixtures/advisories/state-vector-regression.json",
);

function emitAdvisoryEvent(event) {
  process.stdout.write(`${JSON.stringify({ event: "crdt.advisory", ...event })}\n`);
}

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

test("happy path: dominated submitted vector emits STATE_VECTOR_REGRESSION (SYNC-06)", () => {
  const fx = loadFixture();
  assert.equal(fx.specId, "SYNC-06");
  const resolver = new CrdtHarnessResolver();
  const { merged, advisories } = resolver.merge(fx.local, fx.remote);

  const hits = advisories.filter((a) => a.code === fx.expectAdvisoryCode);
  assert.equal(hits.length, 1, "exactly one regression advisory");
  for (const key of fx.expectRegressedEntries) {
    assert.match(hits[0].detail, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // Merge continues — stored wins pointwise max on session.
  assert.equal(merged.stateVector.session, fx.expectMergedSession);
  assert.equal(merged.subjectId, fx.local.subjectId);

  emitAdvisoryEvent({
    outcome: "ok",
    code: fx.expectAdvisoryCode,
    subjectId: merged.subjectId,
    deviceId: fx.remote.deviceIds[0],
    regressed: fx.expectRegressedEntries,
  });
});

test("edge: equal stateVectors emit no regression advisory", () => {
  const fx = loadFixture();
  const resolver = new CrdtHarnessResolver();
  const twin = structuredClone(fx.local);
  const { advisories } = resolver.merge(fx.local, twin);
  assert.equal(
    advisories.some((a) => a.code === "STATE_VECTOR_REGRESSION"),
    false,
  );
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "edge.equal-vectors",
    subjectId: fx.local.subjectId,
  });
});

test("edge: remote ahead on any key is not strict domination — no advisory", () => {
  const fx = loadFixture();
  const resolver = new CrdtHarnessResolver();
  const ahead = structuredClone(fx.remote);
  // Stay behind on profile/device but leap ahead on session → not dominated.
  ahead.stateVector.session = "000000009000000:000000:edge-bbbb";
  const { merged, advisories } = resolver.merge(fx.local, ahead);
  assert.equal(
    advisories.some((a) => a.code === "STATE_VECTOR_REGRESSION"),
    false,
  );
  assert.equal(merged.stateVector.session, ahead.stateVector.session);
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "edge.partial-advance",
    subjectId: fx.local.subjectId,
    deviceId: ahead.deviceIds[0],
  });
});

test("sovereignty: SUBJECT_MISMATCH still refuses cross-subject merge", () => {
  const fx = loadFixture();
  const resolver = new CrdtHarnessResolver();
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
