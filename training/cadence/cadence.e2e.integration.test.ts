/**
 * End-to-end synthetic cadence cycle integration.
 *
 * Synthetic trajectories through collect → score → train → shadow → canary →
 * gate; promoted candidate lands in the test registry; two-surgery fixture is
 * rejected in the same proof session.
 *
 * Run: node --experimental-strip-types --test training/cadence/cadence.e2e.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  proveSyntheticCadenceCycleIntegration,
  type CadenceTelemetryEvent,
  type CadenceTestRegistryTelemetryEvent,
} from "./scheduler.ts";
import type { CadenceVerdictBundleTelemetryEvent } from "./verdict_bundle.ts";

test("e2e: synthetic cadence promotes to test registry; two-surgery rejected", async () => {
  const schedulerEvents: CadenceTelemetryEvent[] = [];
  const registryEvents: CadenceTestRegistryTelemetryEvent[] = [];
  const bundleEvents: CadenceVerdictBundleTelemetryEvent[] = [];

  const proved = await proveSyntheticCadenceCycleIntegration({
    onTelemetry: (event) => schedulerEvents.push(event),
    onRegistryTelemetry: (event) => registryEvents.push(event),
    onVerdictBundleTelemetry: (event) => bundleEvents.push(event),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.promotedInRegistry, true);
  assert.equal(proved.candidateId, "candidate.cadence.synth.promote");
  assert.equal(proved.rejectedFailingSlice, "teacher/hi/b8");
  assert.equal(proved.twoSurgeryRejected, true);
  assert.equal(proved.skipEmitted, true);
  assert.equal(proved.expiredWithoutPromote, true);
  assert.equal(proved.trainOnEvalVoid, true);
  assert.equal(proved.subjectIsolated, true);
  assert.equal(proved.humanCannotOverrideReject, true);
  assert.equal(proved.idempotentReplay, true);
  assert.equal(proved.registryRevision, 1);
  assert.deepEqual(
    [...proved.stagesCompleted],
    ["collect", "score", "train", "shadow", "canary", "gate"],
  );

  assert.ok(
    schedulerEvents.some(
      (event) =>
        event.action === "cycle_complete" &&
        event.verdict === "promote" &&
        event.subjectId === "subject.cadence.synth",
    ),
  );
  assert.ok(
    schedulerEvents.some(
      (event) =>
        event.outcome === "rejected" &&
        event.failingSlice === "teacher/hi/b8",
    ),
  );
  assert.ok(
    registryEvents.some(
      (event) =>
        event.outcome === "ok" &&
        event.candidateId === "candidate.cadence.synth.promote",
    ),
  );
  assert.ok(
    registryEvents.some((event) => event.outcome === "idempotent_replay"),
  );
  assert.ok(
    registryEvents.some(
      (event) =>
        event.outcome === "rejected" &&
        event.failureClass === "cadence.cross_subject_denied",
    ),
  );
  assert.ok(
    bundleEvents.some(
      (event) =>
        event.outcome === "promote" &&
        event.reason === "all_gates_passed",
    ),
  );
  assert.ok(
    !JSON.stringify({ schedulerEvents, registryEvents, bundleEvents }).includes(
      "utterance",
    ),
  );
  assert.ok(
    !JSON.stringify({ schedulerEvents, registryEvents, bundleEvents }).includes(
      "RAW_LEARNER",
    ),
  );
});
