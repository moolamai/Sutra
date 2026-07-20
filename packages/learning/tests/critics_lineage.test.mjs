/**
 * Critic registry versioning + training lineage hooks.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CriticContractError,
  CriticRegistry,
  canonicalizeCriticIdentity,
  computeCriticContentHash,
  createContractSmokeCritic,
  isBreakingRubricBump,
} from "../dist/index.js";

test("happy path: register pins contentHash; lineage records critic hash", () => {
  const events = [];
  const registry = new CriticRegistry({
    onTelemetry: (e) => events.push(e),
  });
  const critic = createContractSmokeCritic({ rubricVersion: "1.0.0" });
  const expectedHash = computeCriticContentHash(
    canonicalizeCriticIdentity({
      rubricId: critic.rubricId,
      rubricVersion: critic.rubricVersion,
      oracleKind: "contract-smoke",
    }),
  );

  registry.register(critic, {
    oracleKind: "contract-smoke",
    calibrated: true,
  });

  const version = registry.getVersion(critic.rubricId, critic.rubricVersion);
  assert.ok(version);
  assert.equal(version.contentHash, expectedHash);
  assert.equal(version.calibrated, true);
  assert.equal(registry.listHooks()[0].contentHash, expectedHash);

  const lineage = registry.recordTrainingLineage({
    runId: "run.critic.lineage.1",
    subjectId: "subj.lineage.a",
    deviceId: "dev-lineage-01",
    locality: "on-device",
    pins: [{ rubricId: critic.rubricId, rubricVersion: critic.rubricVersion }],
    recordedAt: "2026-07-16T12:00:00.000Z",
  });

  assert.equal(lineage.schemaVersion, "critic.lineage.v1");
  assert.equal(lineage.critics.length, 1);
  assert.equal(lineage.critics[0].contentHash, expectedHash);
  assert.ok(events.some((e) => e.event === "learning.critic.lineage"));
  assert.equal(/utterance|keystroke|rawContent/i.test(JSON.stringify(events)), false);

  // Idempotent replay
  const again = registry.recordTrainingLineage({
    runId: "run.critic.lineage.1",
    subjectId: "subj.lineage.a",
    deviceId: "dev-lineage-01",
    locality: "on-device",
    pins: [{ rubricId: critic.rubricId, rubricVersion: critic.rubricVersion }],
  });
  assert.equal(again.recordedAt, lineage.recordedAt);
});

test("edge: breaking rubric bump requires recalibration before lineage", () => {
  const registry = new CriticRegistry();
  const v1 = createContractSmokeCritic({ rubricVersion: "1.0.0" });
  registry.register(v1, { calibrated: true, oracleKind: "contract-smoke" });

  assert.equal(isBreakingRubricBump("1.0.0", "2.0.0"), true);
  assert.equal(isBreakingRubricBump("1.0.0", "1.1.0"), false);

  const v2 = createContractSmokeCritic({ rubricVersion: "2.0.0" });
  registry.register(v2, {
    calibrated: true, // ignored for breaking bump
    oracleKind: "contract-smoke",
  });

  const ver = registry.getVersion(v2.rubricId, "2.0.0");
  assert.equal(ver?.breakingBump, true);
  assert.equal(ver?.calibrated, false);

  assert.throws(
    () =>
      registry.recordTrainingLineage({
        runId: "run.break.1",
        subjectId: "subj.lineage.b",
        deviceId: "dev-lineage-02",
        locality: "self-hosted",
        pins: [{ rubricId: v2.rubricId, rubricVersion: "2.0.0" }],
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.recalibration_required",
  );

  registry.attestRecalibration(v2.rubricId, "2.0.0", {
    subjectId: "subj.lineage.b",
    deviceId: "dev-lineage-02",
    labelCount: 40,
    agreementRate: 0.92,
    threshold: 0.85,
  });

  const lineage = registry.recordTrainingLineage({
    runId: "run.break.1",
    subjectId: "subj.lineage.b",
    deviceId: "dev-lineage-02",
    locality: "self-hosted",
    pins: [{ rubricId: v2.rubricId, rubricVersion: "2.0.0" }],
  });
  assert.equal(lineage.critics[0].rubricVersion, "2.0.0");
  assert.ok(lineage.critics[0].contentHash.startsWith("sha256:"));
});

test("edge: contentHash mismatch refuses silent rewrite; cross-subject lineage blocked", () => {
  const registry = new CriticRegistry();
  const critic = createContractSmokeCritic({ rubricVersion: "1.0.0" });
  registry.register(critic, { calibrated: true });

  assert.throws(
    () =>
      registry.register(critic, {
        calibrated: true,
        contentHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.hash_mismatch",
  );

  registry.recordTrainingLineage({
    runId: "run.subj.lock",
    subjectId: "subj.owner",
    deviceId: "dev-a",
    locality: "on-device",
    pins: [{ rubricId: critic.rubricId, rubricVersion: "1.0.0" }],
  });

  assert.throws(
    () =>
      registry.recordTrainingLineage({
        runId: "run.subj.lock",
        subjectId: "subj.intruder",
        deviceId: "dev-b",
        locality: "on-device",
        pins: [{ rubricId: critic.rubricId, rubricVersion: "1.0.0" }],
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.subject_scope",
  );

  assert.throws(
    () =>
      registry.attestRecalibration(critic.rubricId, "1.0.0", {
        subjectId: "",
        deviceId: "dev-a",
        labelCount: 10,
        agreementRate: 1,
        threshold: 0.8,
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.subject_scope",
  );
});

test("edge: agreement below threshold fails recalibration", () => {
  const events = [];
  const registry = new CriticRegistry({
    onTelemetry: (e) => events.push(e),
  });
  const critic = createContractSmokeCritic({ rubricVersion: "1.0.0" });
  registry.register(critic);

  assert.throws(
    () =>
      registry.attestRecalibration(critic.rubricId, "1.0.0", {
        subjectId: "subj.cal",
        deviceId: "dev-cal",
        labelCount: 20,
        agreementRate: 0.5,
        threshold: 0.85,
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.recalibration_required",
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "learning.critic.recalibrate" && e.outcome === "fail",
    ),
  );
});
