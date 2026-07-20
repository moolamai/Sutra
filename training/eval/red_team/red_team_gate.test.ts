/**
 * Mandatory pre-gate red-team runner tests.
 * Run: node --experimental-strip-types --test training/eval/red_team/red_team_gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CandidateSafetyContractError,
  CANDIDATE_RED_TEAM_SUITE_ID,
  attachCandidateRedTeamSafetyVerdict,
  createConstitutionalPassingEvaluator,
  resetCandidateRedTeamLoadReceipts,
  resetCandidateRedTeamPreGateReceipts,
  runCandidateRedTeamPreGate,
  type CandidateRedTeamEvaluator,
  type CandidateRedTeamTelemetryEvent,
} from "../../../packages/learning/dist/candidate_safety.js";
import {
  applyKillSwitch,
  createLearnedOnState,
  isKillSwitchBaseline,
} from "../../../packages/learning/dist/governance.js";
import { evaluatePromotionSafetyGate } from "../../../packages/learning/dist/promotion_gate.js";
import { runB1ExtendedCandidateRedTeamGate } from "./red_team_gate.ts";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SUBJECT_ID = "subject.red-team.pre-gate";
const DEVICE_ID = "device.red-team.pre-gate";
const CANDIDATE_ID = "candidate.red-team.01";

function baseEvalVerdicts() {
  return {
    pinnedSeed: "seed.1",
    golden: {
      suiteId: "golden",
      passCount: 1,
      totalCount: 1,
      passRate: 1,
    },
    slices: [
      {
        sliceId: "teacher/en/b8",
        baselineScore: 1,
        candidateScore: 1,
        tolerance: 0,
      },
    ],
  };
}

test("pre-gate: full suite green; safety verdict attaches before eval gates", async () => {
  resetCandidateRedTeamLoadReceipts();
  resetCandidateRedTeamPreGateReceipts();
  const events: CandidateRedTeamTelemetryEvent[] = [];
  const evaluator = createConstitutionalPassingEvaluator({
    candidateId: CANDIDATE_ID,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryClasses: ["learned_adapter"],
  });

  const { preGate, evalVerdicts } = await runB1ExtendedCandidateRedTeamGate({
    repoRoot: REPO_ROOT,
    operationId: "op.pre-gate.pass",
    evaluator,
    evalVerdicts: baseEvalVerdicts(),
    now: () => "2026-07-17T06:00:00.000Z",
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(preGate.verdict, "pass");
  assert.equal(preGate.failingScenarioIds.length, 0);
  assert.equal(preGate.scenarioCount, 5);
  assert.equal(preGate.suiteId, CANDIDATE_RED_TEAM_SUITE_ID);
  assert.ok(evalVerdicts?.safety);
  assert.equal(evalVerdicts?.safety.verdict, "pass");
  assert.equal(evalVerdicts?.safety.suiteId, CANDIDATE_RED_TEAM_SUITE_ID);

  const gate = evaluatePromotionSafetyGate({
    evalVerdicts: {
      ...baseEvalVerdicts(),
      safety: evalVerdicts!.safety,
    } as never,
    evaluatedAt: "2026-07-17T07:00:00.000Z",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    candidateId: CANDIDATE_ID,
  });
  assert.equal(gate.ok, true);
  assert.ok(events.some((event) => event.action === "pre_gate_run"));
  assert.ok(events.some((event) => event.action === "attach_verdict"));
});

test("pre-gate: single eroded scenario blocks with scenario id; adapter-only still full suite", async () => {
  resetCandidateRedTeamLoadReceipts();
  resetCandidateRedTeamPreGateReceipts();
  const eroded: CandidateRedTeamEvaluator = {
    candidateId: CANDIDATE_ID,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryClasses: ["learned_adapter"],
    evaluate(scenario) {
      if (scenario.family === "over_refusal") {
        return {
          scenarioId: scenario.id,
          family: scenario.family,
          observedOutcome: "refuse",
          egressObserved: false,
        };
      }
      return {
        scenarioId: scenario.id,
        family: scenario.family,
        observedOutcome: scenario.expectedOutcome,
        egressObserved: false,
      };
    },
  };

  await assert.rejects(
    runCandidateRedTeamPreGate({
      repoRoot: REPO_ROOT,
      operationId: "op.pre-gate.over-refusal",
      evaluator: eroded,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.pre_gate_failed");
      assert.ok(error.failingScenarioIds?.includes("over-refusal-benign-task-01"));
      return true;
    },
  );
});

test("pre-gate: post-gate invocation and locality egress are defects", async () => {
  resetCandidateRedTeamLoadReceipts();
  resetCandidateRedTeamPreGateReceipts();
  const evaluator = createConstitutionalPassingEvaluator({
    candidateId: CANDIDATE_ID,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryClasses: ["learned_compaction"],
  });

  await assert.rejects(
    runCandidateRedTeamPreGate({
      repoRoot: REPO_ROOT,
      operationId: "op.post-gate",
      evaluator,
      evalGatesAlreadyRun: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.post_gate_forbidden");
      return true;
    },
  );

  const leaky: CandidateRedTeamEvaluator = {
    ...evaluator,
    evaluate(scenario) {
      return {
        scenarioId: scenario.id,
        family: scenario.family,
        observedOutcome: scenario.expectedOutcome,
        egressObserved: scenario.family === "locality_proof",
      };
    },
  };
  await assert.rejects(
    runCandidateRedTeamPreGate({
      repoRoot: REPO_ROOT,
      operationId: "op.egress",
      evaluator: leaky,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.pre_gate_failed");
      assert.ok(
        error.failingScenarioIds?.includes("locality-on-device-sovereign-01"),
      );
      return true;
    },
  );
});

test("pre-gate: timeout, idempotent replay, and kill-switch baseline green", async () => {
  resetCandidateRedTeamLoadReceipts();
  resetCandidateRedTeamPreGateReceipts();

  const hanging: CandidateRedTeamEvaluator = {
    candidateId: CANDIDATE_ID,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryClasses: ["learned_routing"],
    evaluate: () => new Promise(() => {}),
  };
  await assert.rejects(
    runCandidateRedTeamPreGate({
      repoRoot: REPO_ROOT,
      operationId: "op.timeout",
      evaluator: hanging,
      timeoutMs: 20,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.downstream_timeout");
      return true;
    },
  );

  const passing = createConstitutionalPassingEvaluator({
    candidateId: CANDIDATE_ID,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryClasses: ["learned_adapter"],
  });
  const first = await runCandidateRedTeamPreGate({
    repoRoot: REPO_ROOT,
    operationId: "op.idempotent",
    evaluator: passing,
    now: () => "2026-07-17T08:00:00.000Z",
  });
  const second = await runCandidateRedTeamPreGate({
    repoRoot: REPO_ROOT,
    operationId: "op.idempotent",
    evaluator: passing,
    now: () => "2026-07-17T09:00:00.000Z",
  });
  assert.equal(first.completedAt, second.completedAt);

  let learned = createLearnedOnState();
  assert.equal(isKillSwitchBaseline(learned), false);
  const killed = applyKillSwitch(learned, {
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
  });
  assert.equal(killed.ok, true);
  assert.equal(isKillSwitchBaseline(killed.state), true);

  const afterKill = await runCandidateRedTeamPreGate({
    repoRoot: REPO_ROOT,
    operationId: "op.kill-switch-drill",
    evaluator: createConstitutionalPassingEvaluator({
      candidateId: CANDIDATE_ID,
      subjectId: SUBJECT_ID,
      deviceId: DEVICE_ID,
      locality: "on-device",
      surgeryClasses: ["learned_adapter"],
    }),
    now: () => "2026-07-17T10:00:00.000Z",
  });
  assert.equal(afterKill.verdict, "pass");

  const attached = attachCandidateRedTeamSafetyVerdict({
    evalVerdicts: baseEvalVerdicts(),
    preGate: afterKill,
  });
  assert.equal(attached.safety.verdict, "pass");
});
