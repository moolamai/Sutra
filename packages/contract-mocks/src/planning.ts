/**
 * Reference PlanningInterface — cyclic revise + rationale updates (CK-08).
 * Ported from examples/_shared/mocks.mjs with obligation-grade loop-back.
 *
 * @module planning
 */

import type {
  Goal,
  Plan,
  PlanRevisionEvent,
  PlanStep,
  PlanningInterface,
} from "@moolam/contracts";

import type { ContractMockEmit } from "./events.js";

export const PLANNING_STEP_LIMIT = 64;

export type PlanningMockOptions = {
  deviceId?: string;
  subjectId?: string;
  emit?: ContractMockEmit;
};

export type PlanningMockHarness = {
  planning: PlanningInterface;
};

/**
 * Cyclic-capable planner: invalidating revise reopens foundation steps and
 * always mutates rationale.
 */
export function createPlanningMock(
  options: PlanningMockOptions = {},
): PlanningInterface {
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  let revisionSeq = 0;
  let composeSeq = 0;

  return {
    async compose(goals: Goal[], context: string): Promise<Plan> {
      try {
        composeSeq += 1;
        const bounded = goals.slice(0, PLANNING_STEP_LIMIT);
        const steps: PlanStep[] = bounded.map((g, i) => ({
          stepId: `s${i + 1}`,
          goalId: g.goalId,
          action: `Work toward: ${g.description}`,
          dependsOn: i > 0 ? [`s${i}`] : [],
          status: i === 0 ? "active" : "pending",
        }));
        const plan: Plan = {
          planId: `plan-${composeSeq}`,
          steps,
          rationale: `Ordered by prerequisites for context: ${context.slice(0, 120)}`,
        };
        emit?.({
          event: "contract_mocks.planning",
          op: "compose",
          subjectId,
          deviceId,
          outcome: "ok",
          stepCount: plan.steps.length,
        });
        return plan;
      } catch (err) {
        emit?.({
          event: "contract_mocks.planning",
          op: "compose",
          subjectId,
          deviceId,
          outcome: "error",
        });
        throw err;
      }
    },

    async revise(plan: Plan, event: PlanRevisionEvent): Promise<Plan> {
      try {
        revisionSeq += 1;
        const steps = plan.steps.slice(0, PLANNING_STEP_LIMIT).map((s) => ({
          ...s,
        }));

        // Loop-back on invalidating / blocking evidence (CK-08.1).
        if (
          (event.severity === "invalidating" || event.severity === "blocking") &&
          steps.length >= 2
        ) {
          steps[0] = { ...steps[0]!, status: "active" };
          for (let i = 1; i < steps.length; i++) {
            const s = steps[i]!;
            if (s.status === "done" || s.status === "active") {
              steps[i] = { ...s, status: "pending" };
            }
          }
          if (event.stepId) {
            const idx = steps.findIndex((s) => s.stepId === event.stepId);
            if (idx > 0) {
              steps[idx] = { ...steps[idx]!, status: "blocked" };
            }
          }
        }

        // Every revision MUST update rationale (CK-08.2).
        const rationale = `${plan.rationale} | revised#${revisionSeq}:${event.severity}:${event.observation.slice(0, 80)}`;
        const revised: Plan = {
          planId: plan.planId,
          steps,
          rationale,
        };
        emit?.({
          event: "contract_mocks.planning",
          op: "revise",
          subjectId,
          deviceId,
          outcome: "ok",
          stepCount: revised.steps.length,
        });
        return revised;
      } catch (err) {
        emit?.({
          event: "contract_mocks.planning",
          op: "revise",
          subjectId,
          deviceId,
          outcome: "error",
        });
        throw err;
      }
    },

    nextStep(plan: Plan): PlanStep | null {
      const next =
        plan.steps
          .slice(0, PLANNING_STEP_LIMIT)
          .find((s) => s.status === "active" || s.status === "pending") ?? null;
      emit?.({
        event: "contract_mocks.planning",
        op: "nextStep",
        subjectId,
        deviceId,
        outcome: "ok",
        stepCount: next ? 1 : 0,
      });
      return next;
    },
  };
}

export function createPlanningMockHarnessFactory(
  options: PlanningMockOptions = {},
): () => PlanningMockHarness {
  return () => ({
    planning: createPlanningMock(options),
  });
}

/** examples/_shared alias. */
export const makePlanning = createPlanningMock;
