/**
 * Consent-gated aggregation and trajectory locality obligations.
 *
 * Run after build: `node --test dist/locality/learning_paths.test.js`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEARNING_PATH_REGULATED_CLASSES,
  LEARNING_PATH_LOCALITY_OBLIGATION_IDS,
  MUST_LOCALITY_GATE_PER_DATA_CLASS,
  createAggregationWithoutConsentViolationFactory,
  createCompliantLearningPathLocalityFactory,
  createLearningPathLocalityObligationsRegistry,
  createRegulatedLearningPathRedTeamFactory,
  createTrajectoryWithoutConsentViolationFactory,
  type LearningPathProbe,
  type LearningPathProbeEvent,
} from "./harness.js";
import { runConformance } from "../runner.js";

test("learning locality registry publishes stable IDs and verbatim locality MUST", () => {
  const catalog = createLearningPathLocalityObligationsRegistry().toCatalog();
  assert.deepEqual(
    catalog.obligations.map((entry) => entry.id),
    [
      LEARNING_PATH_LOCALITY_OBLIGATION_IDS.aggregationConsentBeforeEgress,
      LEARNING_PATH_LOCALITY_OBLIGATION_IDS.trajectoryConsentBeforeExport,
    ],
  );
  assert.ok(
    catalog.obligations.every(
      (entry) =>
        entry.mustText === MUST_LOCALITY_GATE_PER_DATA_CLASS &&
        entry.violationClass === entry.id,
    ),
  );
});

test("reference learning-path harness blocks both paths before egress", async () => {
  const events: unknown[] = [];
  const report = await runConformance({
    registry: createLearningPathLocalityObligationsRegistry(),
    factory: createCompliantLearningPathLocalityFactory(),
    subjectId: "learner-a",
    deviceId: "edge-a",
    emit: (event) => events.push(event),
  });

  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts.length, 2);
  assert.ok(report.verdicts.every((verdict) => verdict.outcome === "pass"));
  assert.match(JSON.stringify(events), /learner-a|edge-a/);
  assert.doesNotMatch(
    JSON.stringify(events),
    /prompt|reply|keystroke|toolBody/i,
  );
});

test("aggregation egress without consent fails only its obligation ID", async () => {
  const report = await runConformance({
    registry: createLearningPathLocalityObligationsRegistry(),
    factory: createAggregationWithoutConsentViolationFactory(),
    subjectId: "learner-aggregation",
    deviceId: "edge-aggregation",
  });

  assert.equal(report.exitCode, 1);
  const aggregation = report.verdicts.find(
    (verdict) =>
      verdict.obligationId ===
      LEARNING_PATH_LOCALITY_OBLIGATION_IDS.aggregationConsentBeforeEgress,
  );
  const trajectory = report.verdicts.find(
    (verdict) =>
      verdict.obligationId ===
      LEARNING_PATH_LOCALITY_OBLIGATION_IDS.trajectoryConsentBeforeExport,
  );
  assert.equal(aggregation?.outcome, "fail");
  assert.match(aggregation?.message ?? "", /aggregation|consent|vendor/i);
  assert.equal(trajectory?.outcome, "pass");
});

test("regulated trajectory hash egress without export consent fails only its obligation ID", async () => {
  const report = await runConformance({
    registry: createLearningPathLocalityObligationsRegistry(),
    factory: createTrajectoryWithoutConsentViolationFactory(),
    subjectId: "learner-trajectory",
    deviceId: "edge-trajectory",
  });

  assert.equal(report.exitCode, 1);
  const aggregation = report.verdicts.find(
    (verdict) =>
      verdict.obligationId ===
      LEARNING_PATH_LOCALITY_OBLIGATION_IDS.aggregationConsentBeforeEgress,
  );
  const trajectory = report.verdicts.find(
    (verdict) =>
      verdict.obligationId ===
      LEARNING_PATH_LOCALITY_OBLIGATION_IDS.trajectoryConsentBeforeExport,
  );
  assert.equal(aggregation?.outcome, "pass");
  assert.equal(trajectory?.outcome, "fail");
  assert.match(trajectory?.message ?? "", /trajectory|regulated|consent/i);
});

test("concurrent subjects and replayed runs remain isolated and deterministic", async () => {
  const run = (subjectId: string, deviceId: string) =>
    runConformance({
      registry: createLearningPathLocalityObligationsRegistry(),
      factory: createCompliantLearningPathLocalityFactory(),
      subjectId,
      deviceId,
    });
  const [first, second] = await Promise.all([
    run("learner-a", "edge-a"),
    run("learner-b", "edge-b"),
  ]);
  const replay = await run("learner-a", "edge-a");

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(
    replay.verdicts.map((verdict) => [
      verdict.obligationId,
      verdict.outcome,
      verdict.subjectId,
    ]),
    first.verdicts.map((verdict) => [
      verdict.obligationId,
      verdict.outcome,
      verdict.subjectId,
    ]),
  );
  assert.ok(
    first.verdicts.every((verdict) =>
      verdict.subjectId.startsWith("learner-a::"),
    ),
  );
  assert.ok(
    second.verdicts.every((verdict) =>
      verdict.subjectId.startsWith("learner-b::"),
    ),
  );
});

test("red-team matrix: every regulated class traverses rollup and capture locally with zero egress", async () => {
  for (const regulatedClass of LEARNING_PATH_REGULATED_CLASSES) {
    const events: LearningPathProbeEvent[] = [];
    const report = await runConformance({
      registry: createLearningPathLocalityObligationsRegistry(),
      factory: createRegulatedLearningPathRedTeamFactory({
        regulatedClass,
        emit: (event) => events.push(event),
      }),
      subjectId: `learner-${regulatedClass}`,
      deviceId: `edge-${regulatedClass}`,
    });

    assert.equal(report.exitCode, 0);
    assert.ok(report.verdicts.every((verdict) => verdict.outcome === "pass"));
    assert.deepEqual(
      events.map((event) => [event.path, event.outcome, event.payloadClass]),
      [
        ["aggregation", "local_probe", "regulated"],
        ["trajectory", "local_probe", "regulated"],
      ],
    );
    assert.ok(events.every((event) => event.regulatedClass === regulatedClass));
    assert.doesNotMatch(
      JSON.stringify(events),
      /prompt|reply|keystroke|utterance|toolBody|contentHash/i,
    );
  }
});

test("red-team violations: every marker/path pair is caught by its exact consent obligation", async () => {
  const paths: readonly LearningPathProbe[] = ["aggregation", "trajectory"];
  for (const regulatedClass of LEARNING_PATH_REGULATED_CLASSES) {
    for (const path of paths) {
      const events: LearningPathProbeEvent[] = [];
      const obligationId =
        path === "aggregation"
          ? LEARNING_PATH_LOCALITY_OBLIGATION_IDS.aggregationConsentBeforeEgress
          : LEARNING_PATH_LOCALITY_OBLIGATION_IDS.trajectoryConsentBeforeExport;
      const report = await runConformance({
        registry: createLearningPathLocalityObligationsRegistry(),
        factory: createRegulatedLearningPathRedTeamFactory({
          regulatedClass,
          violatePath: path,
          emit: (event) => events.push(event),
        }),
        subjectId: `learner-${regulatedClass}-${path}`,
        deviceId: `edge-${path}`,
        obligationIds: [obligationId],
      });

      assert.equal(report.exitCode, 1);
      assert.equal(report.verdicts.length, 1);
      assert.equal(report.verdicts[0]?.obligationId, obligationId);
      assert.equal(report.verdicts[0]?.outcome, "fail");
      assert.match(
        report.verdicts[0]?.message ?? "",
        new RegExp(`${path}|consent|vendor`, "i"),
      );
      assert.deepEqual(
        events.map((event) => event.outcome),
        ["local_probe", "egress_attempt"],
        "local processing followed by forbidden egress must still fail",
      );
      assert.ok(
        events.every(
          (event) =>
            event.payloadClass === "regulated" &&
            event.regulatedClass === regulatedClass,
        ),
      );
      if (process.env.CI === "true") {
        console.error(
          JSON.stringify({
            event: "locality.learning_path.ci",
            obligationId,
            outcome: "seeded_violation_caught",
            subjectId: events[0]?.subjectId,
            deviceId: events[0]?.deviceId,
            egressAttempts: events
              .filter((event) => event.outcome === "egress_attempt")
              .map((event) => ({
                path: event.path,
                regulatedClass: event.regulatedClass,
                payloadClass: event.payloadClass,
              })),
          }),
        );
      }
    }
  }
});

test("red-team concurrency: same-subject probes isolate devices and emit metadata only", async () => {
  const aEvents: LearningPathProbeEvent[] = [];
  const bEvents: LearningPathProbeEvent[] = [];
  const run = (
    deviceId: string,
    regulatedClass: (typeof LEARNING_PATH_REGULATED_CLASSES)[number],
    events: LearningPathProbeEvent[],
  ) =>
    runConformance({
      registry: createLearningPathLocalityObligationsRegistry(),
      factory: createRegulatedLearningPathRedTeamFactory({
        regulatedClass,
        emit: (event) => events.push(event),
      }),
      subjectId: "shared-learner",
      deviceId,
    });

  const [a, b] = await Promise.all([
    run("edge-a", "health", aEvents),
    run("edge-b", "minor-learner", bEvents),
  ]);

  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);
  assert.ok(aEvents.every((event) => event.deviceId === "edge-a"));
  assert.ok(bEvents.every((event) => event.deviceId === "edge-b"));
  assert.ok(
    [...aEvents, ...bEvents].every(
      (event) =>
        event.subjectId.startsWith("shared-learner::") &&
        event.outcome === "local_probe",
    ),
  );
});

test("CI wiring runs the bounded learning-locality suite and retains its attempt log", () => {
  const workflow = readFileSync(
    new URL("../../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^\s{2}protocol-conformance:\s*$/m);
  assert.match(
    workflow,
    /node --test packages\/contract-conformance\/dist\/locality\/learning_paths\.test\.js/,
  );
  assert.match(workflow, /set -euo pipefail/);
  assert.match(workflow, /tee artifacts\/learning-locality\/gate\.log/);
  assert.match(workflow, /name: learning-locality-log-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /if: always\(\)/);
});
