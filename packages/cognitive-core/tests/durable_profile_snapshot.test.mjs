/**
 * Durable profile snapshot helper for session rehydration.
 * Run: pnpm --filter @moolam/cognitive-core test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  REFUSAL_CONSTRAINT_SCAN_LIMIT,
  snapshotProfileForDurableSession,
} from "../dist/index.js";

test("happy path: snapshots profile fields for durable session tier", () => {
  const snap = snapshotProfileForDurableSession({
    domainId: "  mathematics-mentor  ",
    charter: "Teach patiently.",
    refusals: ["refusal:medical-advice", "refusal:legal-advice"],
    languages: ["en", "hi"],
  });
  assert.equal(snap.domainId, "mathematics-mentor");
  assert.equal(snap.charter, "Teach patiently.");
  assert.deepEqual(snap.refusals, [
    "refusal:medical-advice",
    "refusal:legal-advice",
  ]);
  assert.deepEqual(snap.languages, ["en", "hi"]);
});

test("edge: refusals bounded by scan limit", () => {
  const many = Array.from(
    { length: REFUSAL_CONSTRAINT_SCAN_LIMIT + 10 },
    (_, i) => `refusal:${i}`,
  );
  const snap = snapshotProfileForDurableSession({
    domainId: "d",
    charter: "c",
    refusals: many,
    languages: ["en"],
  });
  assert.equal(snap.refusals.length, REFUSAL_CONSTRAINT_SCAN_LIMIT);
});
