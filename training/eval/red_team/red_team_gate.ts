/**
 * C7 candidate red-team pre-gate entry — loads the frozen suite and runs the
 * mandatory runner before promotion eval gates.
 *
 * Run tests:
 *   node --experimental-strip-types --test training/eval/red_team/red_team_gate.test.ts
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachCandidateRedTeamSafetyVerdict,
  createConstitutionalPassingEvaluator,
  loadCandidateRedTeamSuite,
  runCandidateRedTeamPreGate,
  type CandidateRedTeamEvaluator,
  type CandidateRedTeamPreGateVerdict,
  type CandidateRedTeamTelemetryEvent,
} from "../../../packages/learning/dist/candidate_safety.js";

export function repoRootFromHere(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * Run the committed C7 suite as a pre-gate for a candidate. On pass, returns
 * the verdict (and optional evalVerdicts with safety attached). On fail, throws
 * with failingScenarioIds.
 */
export async function runB1ExtendedCandidateRedTeamGate(input: {
  repoRoot?: string;
  operationId: string;
  evaluator: CandidateRedTeamEvaluator;
  evalGatesAlreadyRun?: boolean;
  /** Optional base evalVerdicts to receive the safety attachment on pass. */
  evalVerdicts?: {
    pinnedSeed: string;
    golden: unknown;
    slices: unknown;
    safety?: { suiteId: string; verdict: "pass" | "fail"; completedAt: string };
  };
  timeoutMs?: number;
  now?: () => string;
  onTelemetry?: (e: CandidateRedTeamTelemetryEvent) => void;
}): Promise<{
  preGate: CandidateRedTeamPreGateVerdict;
  evalVerdicts?: {
    pinnedSeed: string;
    golden: unknown;
    slices: unknown;
    safety: { suiteId: string; verdict: "pass" | "fail"; completedAt: string };
  };
}> {
  const repoRoot = input.repoRoot ?? repoRootFromHere();
  await loadCandidateRedTeamSuite({
    repoRoot,
    deviceId: input.evaluator.deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const preGate = await runCandidateRedTeamPreGate({
    repoRoot,
    operationId: input.operationId,
    evaluator: input.evaluator,
    ...(input.evalGatesAlreadyRun !== undefined
      ? { evalGatesAlreadyRun: input.evalGatesAlreadyRun }
      : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  if (input.evalVerdicts === undefined) {
    return { preGate };
  }
  return {
    preGate,
    evalVerdicts: attachCandidateRedTeamSafetyVerdict({
      evalVerdicts: input.evalVerdicts,
      preGate,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    }),
  };
}

export {
  createConstitutionalPassingEvaluator,
  runCandidateRedTeamPreGate,
  attachCandidateRedTeamSafetyVerdict,
};
