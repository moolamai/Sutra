/**
 * Promotion registry refusal integration: fixture matrix + proven admit.
 *
 * Fixtures: missing golden, slice regression, unsigned lineage, two-surgery —
 * each refused with the correct reason; proven synthetic candidate admitted.
 *
 * Run (repo root, after @moolam/learning build):
 *   node --experimental-strip-types --test training/delivery/promotion_registry.refusal.integration.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  provePromotionRegistryRefusalIntegration,
} from "./promotion_registry.ts";

const SECRET = "RAW_LEARNER_CONTENT_MUST_NOT_LEAK";

test("integration: refusal fixtures refuse with typed reasons; proven admits", () => {
  const deliveryEvents = [];
  const registryEvents = [];

  const proved = provePromotionRegistryRefusalIntegration({
    onTelemetry: (event) => deliveryEvents.push(event),
    onRegistryTelemetry: (event) => registryEvents.push(event),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.missingGoldenRefused, true);
  assert.equal(proved.sliceRegressionRefused, true);
  assert.equal(proved.unsignedLineageRefused, true);
  assert.equal(proved.twoSurgeryRefused, true);
  assert.equal(proved.hashMismatchBeforeEval, true);
  assert.equal(proved.provenAdmitted, true);
  assert.equal(proved.subjectIsolated, true);
  assert.equal(proved.idempotentReplay, true);
  assert.equal(proved.failingSliceNamed, "teacher/en/b8");
  assert.ok(proved.metricDelta < 0);
  assert.equal(proved.revisionAfterProven, 1);

  assert.ok(
    deliveryEvents.some(
      (event) =>
        event.outcome === "fail" &&
        event.failureClass === "promotion.golden_incomplete",
    ),
  );
  assert.ok(
    deliveryEvents.some(
      (event) =>
        event.outcome === "fail" &&
        event.failureClass === "promotion.slice_regression" &&
        event.failingSlice === "teacher/en/b8" &&
        typeof event.metricDelta === "number" &&
        event.metricDelta < 0,
    ),
  );
  assert.ok(
    deliveryEvents.some(
      (event) =>
        event.outcome === "fail" &&
        event.failureClass === "promotion.lineage_unsigned",
    ),
  );
  assert.ok(
    deliveryEvents.some(
      (event) =>
        event.outcome === "fail" &&
        event.failureClass === "promotion.attribution_void",
    ),
  );
  assert.ok(
    deliveryEvents.some(
      (event) =>
        event.outcome === "fail" &&
        event.failureClass === "promotion.adapter_hash_mismatch",
    ),
  );
  assert.ok(
    deliveryEvents.some(
      (event) =>
        event.outcome === "ok" &&
        event.candidateId === "candidate.refusal.proven" &&
        event.goldenPassRate === 1,
    ),
  );
  assert.ok(
    registryEvents.some(
      (event) =>
        event.event === "learning.promotion_registry.golden_gate" &&
        event.outcome === "fail",
    ),
  );
  assert.ok(
    registryEvents.some(
      (event) =>
        event.event === "learning.promotion_registry.slice_gate" &&
        event.outcome === "fail" &&
        event.failingSlice === "teacher/en/b8",
    ),
  );

  const serialized = JSON.stringify([...deliveryEvents, ...registryEvents]);
  assert.ok(!serialized.includes(SECRET));
  assert.ok(
    [...deliveryEvents, ...registryEvents].every(
      (event) =>
        !("content" in event) &&
        !("utterance" in event) &&
        !("blob" in event) &&
        !("artifactBytes" in event),
    ),
  );
});
