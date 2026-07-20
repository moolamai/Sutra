/**
 * Failure-class feature extractor for self-healing mining.
 * Run: pnpm --filter @moolam/learning run build && node --experimental-strip-types --test packages/learning/tests/failure_patterns.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAILURE_CLASSES,
  FAILURE_MIN_SUPPORT_DEFAULT,
  FailurePatternContractError,
  computeClusterConfidence,
  createFailurePatternClusterRegistry,
  extractFailureFeatures,
  ingestExtractionIntoClusterRegistry,
} from "../dist/failure_patterns.js";
import {
  loadPatternRegistryTaxonomy,
  mineAndClusterForSubject,
  mineFailureFeaturesBySubject,
  mineFailureFeaturesForSubject,
} from "../../../training/self_healing/pattern_miner.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SUBJECT = "subj.heal.001";

test("extracts all four seeded failure classes from trajectory + P3 events", () => {
  const events = [];
  const result = extractFailureFeatures({
    subjectId: SUBJECT,
    deviceId: "dev.heal",
    trajectories: [
      {
        subjectId: SUBJECT,
        turnId: "turn.exh.1",
        deviceId: "dev.heal",
        locality: "on-device",
        correctionDepth: 8,
        correctionExhausted: true,
      },
      {
        subjectId: SUBJECT,
        turnId: "turn.ref.1",
        evidenceCode: "refusal_on_benign",
      },
      {
        subjectId: SUBJECT,
        turnId: "turn.to.1",
        opCode: "tool.search",
        executionStatusCode: "timeout",
      },
    ],
    telemetryEvents: [
      {
        event: "runtime.harness.degradation_registry",
        subjectId: SUBJECT,
        deviceId: "dev.heal",
        outcome: "advisory",
        mode: "STALE_READ",
        dependency: "model",
        operation: "generate",
        signalCode: "DEGRADE_STALE_READ",
        advisoryOutcome: "stale_served",
      },
      {
        event: "runtime.harness.correction_loop",
        subjectId: SUBJECT,
        turnId: "turn.exh.2",
        outcome: "exhausted",
        failureClass: "correction_exhausted",
        depth: 8,
        maxDepth: 8,
        repeatedFailure: true,
      },
      {
        event: "tool.result",
        subjectId: SUBJECT,
        turnId: "turn.to.2",
        status: "timeout",
        toolIdHash: "tool.abc123",
        durationMs: 1500,
      },
    ],
    onTelemetry: (event) => events.push(event),
  });

  const classes = new Set(result.features.map((feature) => feature.failureClass));
  for (const cls of FAILURE_CLASSES) {
    assert.ok(classes.has(cls), `missing class ${cls}`);
  }
  assert.ok(result.features.length >= 4);
  assert.equal(result.scannedTrajectoryCount, 3);
  assert.equal(result.scannedTelemetryEventCount, 3);
  assert.ok(
    result.support.every(
      (row) =>
        row.support < FAILURE_MIN_SUPPORT_DEFAULT
          ? row.disposition === "triage"
          : row.disposition === "eligible",
    ),
  );
  assert.ok(result.triageOnlyCount >= 1);
  assert.ok(events.some((event) => event.outcome === "advisory"));
  const wire = JSON.stringify({ result, events });
  assert.ok(!wire.includes("utterance"));
  assert.ok(!wire.includes("please help"));
});

test("sparse support stays triage; duplicates are idempotent; declines are not misfires", () => {
  const first = extractFailureFeatures({
    subjectId: SUBJECT,
    telemetryEvents: [
      {
        event: "runtime.harness.degradation_advisory",
        subjectId: SUBJECT,
        outcome: "advisory",
        mode: "HARD_STOP_WRITE",
        dependency: "tool",
        signalCode: "DEGRADE_HARD_STOP_WRITE",
        advisoryOutcome: "hard_stopped",
      },
    ],
    minSupport: 3,
  });
  assert.equal(
    first.support.find((row) => row.failureClass === "degradation")?.disposition,
    "triage",
  );

  const replay = extractFailureFeatures({
    subjectId: SUBJECT,
    telemetryEvents: [
      {
        event: "runtime.harness.degradation_advisory",
        subjectId: SUBJECT,
        outcome: "advisory",
        mode: "HARD_STOP_WRITE",
        dependency: "tool",
        signalCode: "DEGRADE_HARD_STOP_WRITE",
        advisoryOutcome: "hard_stopped",
      },
      {
        event: "runtime.harness.degradation_advisory",
        subjectId: SUBJECT,
        outcome: "advisory",
        mode: "HARD_STOP_WRITE",
        dependency: "tool",
        signalCode: "DEGRADE_HARD_STOP_WRITE",
        advisoryOutcome: "hard_stopped",
      },
    ],
  });
  assert.equal(replay.features.length, 1);
  assert.equal(replay.duplicateEvidenceCount, 1);

  const declined = extractFailureFeatures({
    subjectId: SUBJECT,
    trajectories: [
      {
        subjectId: SUBJECT,
        turnId: "turn.decline",
        status: "declined",
        // No evidenceCode — must not become refusal_misfire.
      },
    ],
  });
  assert.ok(
    !declined.features.some(
      (feature) => feature.failureClass === "refusal_misfire",
    ),
  );
});

test("cross-subject evidence and raw content keys are refused", () => {
  assert.throws(
    () =>
      extractFailureFeatures({
        subjectId: SUBJECT,
        expectedSubjectId: "subj.other",
        trajectories: [],
      }),
    (error) =>
      error instanceof FailurePatternContractError &&
      error.obligation === "failure_patterns.subject_scope",
  );

  assert.throws(
    () =>
      extractFailureFeatures({
        subjectId: SUBJECT,
        trajectories: [
          {
            subjectId: "subj.other",
            turnId: "turn.x",
            correctionExhausted: true,
            correctionDepth: 8,
          },
        ],
      }),
    (error) =>
      error instanceof FailurePatternContractError &&
      error.obligation === "failure_patterns.cross_subject_denied",
  );

  assert.throws(
    () =>
      extractFailureFeatures({
        subjectId: SUBJECT,
        telemetryEvents: [
          {
            event: "tool.result",
            subjectId: SUBJECT,
            status: "timeout",
            utterance: "secret learner text",
          },
        ],
      }),
    (error) =>
      error instanceof FailurePatternContractError &&
      error.obligation === "failure_patterns.raw_content_forbidden",
  );
});

test("pattern miner loads append-only taxonomy and mines per subject", () => {
  const registry = loadPatternRegistryTaxonomy({ repoRoot: REPO_ROOT });
  assert.equal(registry.appendOnly, true);
  assert.equal(registry.clusters.length, 0);
  assert.ok(registry.versions.length >= 2);

  const mined = mineFailureFeaturesForSubject({
    subjectId: SUBJECT,
    deviceId: "dev.heal",
    repoRoot: REPO_ROOT,
    trajectories: [
      {
        subjectId: SUBJECT,
        turnId: "turn.exh.miner",
        correctionDepth: 8,
        correctionExhausted: true,
      },
    ],
    telemetryEvents: [
      {
        event: "tool.result",
        subjectId: SUBJECT,
        status: "timeout",
        toolIdHash: "tool.miner",
      },
    ],
  });
  assert.ok(
    mined.features.some(
      (feature) => feature.failureClass === "correction_exhaustion",
    ),
  );
  assert.ok(
    mined.features.some((feature) => feature.failureClass === "tool_timeout"),
  );

  const batch = mineFailureFeaturesBySubject({
    repoRoot: REPO_ROOT,
    batches: [
      {
        subjectId: "subj.a",
        trajectories: [
          {
            subjectId: "subj.a",
            correctionExhausted: true,
            correctionDepth: 8,
            turnId: "t.a",
          },
        ],
      },
      {
        subjectId: "subj.b",
        telemetryEvents: [
          {
            event: "tool.result",
            subjectId: "subj.b",
            status: "timeout",
          },
        ],
      },
    ],
  });
  assert.equal(batch.length, 2);
  assert.equal(batch[0].result.subjectId, "subj.a");
  assert.equal(batch[1].result.subjectId, "subj.b");
});

test("cluster registry: min support + confidence gate; append-only versions; lookup API", () => {
  const events = [];
  const subjectId = "subj.cluster.001";
  const trajectories = [];
  for (let i = 0; i < 4; i += 1) {
    trajectories.push({
      subjectId,
      turnId: `turn.exh.${i}`,
      correctionDepth: 8,
      correctionExhausted: true,
    });
  }
  const extraction = extractFailureFeatures({
    subjectId,
    trajectories,
    minSupport: 3,
  });
  const registry = createFailurePatternClusterRegistry({
    subjectId,
    deviceId: "dev.cluster",
    minSupport: 3,
    confidenceThreshold: 0.8,
    onTelemetry: (event) => events.push(event),
  });
  const clusters = ingestExtractionIntoClusterRegistry({
    registry,
    extraction,
    deviceId: "dev.cluster",
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].failureClass, "correction_exhaustion");
  assert.equal(clusters[0].disposition, "auto_eligible");
  assert.ok(clusters[0].confidence >= 0.8);
  assert.equal(clusters[0].policyHint.surface, "correction_loop");

  const lookup = registry.lookupRemediationPolicy("correction_exhaustion");
  assert.equal(lookup.ok, true);
  if (lookup.ok) {
    assert.equal(lookup.policy.surface, "correction_loop");
  }

  const sparse = registry.lookupRemediationPolicy("tool_timeout");
  assert.equal(sparse.ok, false);
  assert.equal(sparse.disposition, "triage");

  // Append-only: rewriting version 1 must fail.
  assert.throws(
    () =>
      registry.appendClusterVersion({
        ...clusters[0],
        version: 1,
        support: 99,
      }),
    (error) =>
      error instanceof FailurePatternContractError &&
      error.obligation === "failure_patterns.append_only_violation",
  );

  const { version: _v1, ...clusterWithoutVersion } = clusters[0];
  const v2 = registry.appendClusterVersion({
    ...clusterWithoutVersion,
    support: 5,
    confidence: computeClusterConfidence(5, 3),
  });
  assert.equal(v2.version, 2);
  assert.equal(registry.snapshot().registryVersion >= 2, true);
  assert.ok(events.some((event) => event.event === "learning.failure_patterns.lookup"));
});

test("forbidden remediation surfaces refused; ineffective attempts disable and page", () => {
  const subjectId = "subj.cluster.forbid";
  const registry = createFailurePatternClusterRegistry({
    subjectId,
    deviceId: "dev.forbid",
  });
  assert.throws(
    () =>
      registry.appendClusterVersion({
        clusterId: "cluster.bad",
        subjectId,
        failureClass: "tool_timeout",
        support: 5,
        confidence: 0.9,
        disposition: "auto_eligible",
        policyHint: {
          surface: "permissions",
          parameter: "widen",
          delta: 1,
        },
        evidenceFingerprints: ["fp.1"],
        disabled: false,
        ineffectiveAttempts: 0,
        pageRequested: false,
      }),
    (error) =>
      error instanceof FailurePatternContractError &&
      error.obligation === "failure_patterns.forbidden_surface",
  );

  const seeded = registry.appendClusterVersion({
    clusterId: "cluster.tool_timeout.subj.cluster.forbid",
    subjectId,
    failureClass: "tool_timeout",
    support: 5,
    confidence: 0.9,
    disposition: "auto_eligible",
    policyHint: {
      surface: "retry_cap",
      parameter: "toolRetryCap",
      delta: 1,
    },
    evidenceFingerprints: ["fp.a", "fp.b", "fp.c", "fp.d", "fp.e"],
    disabled: false,
    ineffectiveAttempts: 0,
    pageRequested: false,
  });
  assert.equal(seeded.version, 1);
  registry.recordIneffectiveAttempt(seeded.clusterId);
  registry.recordIneffectiveAttempt(seeded.clusterId);
  const disabled = registry.recordIneffectiveAttempt(seeded.clusterId);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.pageRequested, true);
  const lookup = registry.lookupRemediationPolicy("tool_timeout");
  assert.equal(lookup.ok, false);
  assert.equal(lookup.disposition, "disabled");
  assert.equal(lookup.pageRequested, true);
});

test("mineAndClusterForSubject: sparse stays triage; eligible exposes typed policy", () => {
  const subjectId = "subj.cluster.mine";
  const sparse = mineAndClusterForSubject({
    subjectId,
    repoRoot: REPO_ROOT,
    trajectories: [
      {
        subjectId,
        turnId: "turn.one",
        correctionExhausted: true,
        correctionDepth: 8,
      },
    ],
  });
  assert.equal(
    sparse.policies.correction_exhaustion?.ok,
    false,
  );
  assert.equal(
    sparse.policies.correction_exhaustion?.disposition,
    "triage",
  );

  const trajectories = [];
  for (let i = 0; i < 4; i += 1) {
    trajectories.push({
      subjectId: "subj.cluster.rich",
      turnId: `turn.ok.${i}`,
      executionStatusCode: "timeout",
      opCode: "tool.search",
    });
  }
  const rich = mineAndClusterForSubject({
    subjectId: "subj.cluster.rich",
    repoRoot: REPO_ROOT,
    trajectories,
  });
  assert.equal(rich.policies.tool_timeout?.ok, true);
  if (rich.policies.tool_timeout?.ok) {
    assert.equal(rich.policies.tool_timeout.policy.surface, "retry_cap");
  }
  const taxonomy = loadPatternRegistryTaxonomy({ repoRoot: REPO_ROOT });
  assert.ok(taxonomy.versions.some((row) => row.kind === "cluster_registry"));
  assert.ok(taxonomy.versions.some((row) => row.kind === "seeded_fixtures"));
  assert.ok(taxonomy.forbiddenRemediationSurfaces.includes("permissions"));
});

test("seeded fixtures: each failure class clusters; low-support stays triage", async () => {
  const {
    loadFailureMiningFixtures,
    proveFailureMiningFixturesCi,
  } = await import("../../../training/self_healing/pattern_miner.ts");

  const fixtures = loadFailureMiningFixtures({ repoRoot: REPO_ROOT });
  assert.ok(fixtures.some((fixture) => fixture.id === "correction-exhaustion"));
  assert.ok(fixtures.some((fixture) => fixture.id === "low-support-triage"));
  assert.ok(
    !JSON.stringify(fixtures).includes("utterance"),
    "fixtures must stay metadata-only",
  );

  const events = [];
  const proved = await proveFailureMiningFixturesCi({
    repoRoot: REPO_ROOT,
    deviceId: "ci-failure-mining",
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.replayOk, true);
  assert.equal(proved.forbiddenSurfaceRejected, true);
  assert.deepEqual(
    [...proved.eligibleFixtureIds].sort(),
    [
      "correction-exhaustion",
      "degradation",
      "refusal-misfire",
      "tool-timeout",
    ].sort(),
  );
  assert.deepEqual(proved.triageFixtureIds, ["low-support-triage"]);
  assert.deepEqual(proved.refuseFixtureIds, ["cross-subject-denied"]);
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.failure_patterns.fixture" &&
        event.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("secret"));
});
