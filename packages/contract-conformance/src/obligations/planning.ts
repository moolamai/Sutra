/**
 * PlanningInterface obligations ( / CK-08).
 *
 * CK-08.1 — Plans MUST be cyclic-capable: `revise` may route BACK to earlier
 *           goals when evidence shows a foundation is weak.
 * CK-08.2 — Every revision MUST update `rationale`; silent plan mutation is
 *           a contract violation.
 *
 * Runtime contracts land in — out of scope here.
 */

import type {
  Goal,
  Plan,
  PlanRevisionEvent,
  PlanStep,
  PlanningInterface,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

/**
 * Verbatim MUST sentences from `packages/contracts/src/planning.ts`.
 */
export const MUST_CYCLIC_REVISE =
  "Plans MUST be cyclic-capable: `revise` may route BACK to earlier goals when evidence shows a foundation is weak (the loop-back property, valid in any domain).";

export const MUST_REVISION_UPDATES_RATIONALE =
  "Every revision MUST update `rationale`; silent plan mutation is a contract violation.";

export const PLANNING_OBLIGATION_IDS = {
  cyclicRevise: "CK-08.1",
  revisionUpdatesRationale: "CK-08.2",
} as const;

/** Max steps / goals inspected per probe (NFR / scalability). */
export const PLANNING_STEP_SCAN_LIMIT = 64;

/**
 * Conformance surface for planners.
 * Probe only through `compose` / `revise` / `nextStep`.
 */
export interface PlanningConformanceHarness {
  planning: PlanningInterface;
}

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

/** Subject-scoped goals — metadata tokens only, never learner content. */
export function buildPlanningProbeGoals(ctx: ObligationContext): Goal[] {
  const tok = subjectToken(ctx.subjectId);
  return [
    {
      goalId: `probe.ck08.goal.foundation.${tok}`,
      description: `probe.ck08.foundation.${tok}`,
      prerequisites: [],
      successCriterion: `probe.ck08.foundation.ok.${tok}`,
    },
    {
      goalId: `probe.ck08.goal.later.${tok}`,
      description: `probe.ck08.later.${tok}`,
      prerequisites: [`probe.ck08.goal.foundation.${tok}`],
      successCriterion: `probe.ck08.later.ok.${tok}`,
    },
  ];
}

export function buildPlanningProbeContext(ctx: ObligationContext): string {
  return `probe.ck08.context.${subjectToken(ctx.subjectId)}`;
}

/**
 * True when `revised` routes execution back toward an earlier step than
 * `before` — e.g. a previously done/active later step is no longer ahead of
 * an earlier foundation that was reset, or nextStep moves earlier in the graph.
 */
export function detectsLoopBack(
  before: Plan,
  revised: Plan,
  nextBefore: PlanStep | null,
  nextAfter: PlanStep | null,
): boolean {
  const beforeSteps = before.steps.slice(0, PLANNING_STEP_SCAN_LIMIT);
  const afterSteps = revised.steps.slice(0, PLANNING_STEP_SCAN_LIMIT);
  if (beforeSteps.length === 0 || afterSteps.length === 0) return false;

  // Index order in the original plan approximates earlier → later.
  const indexById = new Map(
    beforeSteps.map((s, i) => [s.stepId, i] as const),
  );

  // A done/active later step becomes blocked/pending/abandoned while an
  // earlier step returns to pending/active.
  for (const after of afterSteps) {
    const prior = beforeSteps.find((s) => s.stepId === after.stepId);
    if (!prior) continue;
    const idx = indexById.get(after.stepId) ?? -1;
    if (idx <= 0) continue;
    const earlierBefore = beforeSteps[0]!;
    const earlierAfter = afterSteps.find((s) => s.stepId === earlierBefore.stepId);
    if (!earlierAfter) continue;
    const laterRegressed =
      (prior.status === "done" || prior.status === "active") &&
      (after.status === "pending" ||
        after.status === "blocked" ||
        after.status === "abandoned");
    const earlierReopened =
      (earlierBefore.status === "done" || earlierBefore.status === "active") &&
      (earlierAfter.status === "pending" || earlierAfter.status === "active");
    if (laterRegressed && earlierReopened) return true;
  }

  // nextStep moved to an earlier indexed step than before the revise.
  if (nextBefore && nextAfter) {
    const iBefore = indexById.get(nextBefore.stepId);
    const iAfter = indexById.get(nextAfter.stepId);
    if (
      iBefore !== undefined &&
      iAfter !== undefined &&
      iAfter < iBefore
    ) {
      return true;
    }
  }

  // Explicit: foundation step id appears again as next after advance past it.
  if (nextAfter && beforeSteps[0] && nextAfter.stepId === beforeSteps[0].stepId) {
    if (nextBefore && nextBefore.stepId !== nextAfter.stepId) return true;
    if (
      beforeSteps[0].status === "done" &&
      (nextAfter.status === "pending" || nextAfter.status === "active")
    ) {
      return true;
    }
  }

  return false;
}

async function composeAdvancedPlan(
  planning: PlanningInterface,
  ctx: ObligationContext,
): Promise<{
  plan: Plan;
  foundation: PlanStep;
  later: PlanStep;
}> {
  const goals = buildPlanningProbeGoals(ctx);
  const plan = await planning.compose(goals, buildPlanningProbeContext(ctx));
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 2) {
    throw new ObligationViolation({
      obligationId: PLANNING_OBLIGATION_IDS.cyclicRevise,
      mustText: MUST_CYCLIC_REVISE,
      contract: "PlanningInterface",
      message: "compose() must return a plan with at least two steps for the probe",
    });
  }
  const foundation = plan.steps[0]!;
  const later = plan.steps[1]!;
  // Advance: mark foundation done and later active so revise has somewhere to loop back from.
  const advanced: Plan = {
    ...plan,
    steps: plan.steps.slice(0, PLANNING_STEP_SCAN_LIMIT).map((s, i) => {
      if (i === 0) return { ...s, status: "done" as const };
      if (i === 1) return { ...s, status: "active" as const };
      return { ...s };
    }),
    rationale: plan.rationale,
  };
  return {
    plan: advanced,
    foundation: { ...foundation, status: "done" },
    later: { ...later, status: "active" },
  };
}

export function defineCyclicReviseObligation(): Obligation<PlanningConformanceHarness> {
  return defineObligation({
    id: PLANNING_OBLIGATION_IDS.cyclicRevise,
    contract: "PlanningInterface",
    mustText: MUST_CYCLIC_REVISE,
    specIds: ["CK-08"],
    async check(impl, ctx) {
      let advanced: Plan;
      let later: PlanStep;
      try {
        const built = await composeAdvancedPlan(impl.planning, ctx);
        advanced = built.plan;
        later = built.later;
      } catch (err) {
        if (err instanceof ObligationViolation) throw err;
        throw new ObligationViolation({
          obligationId: PLANNING_OBLIGATION_IDS.cyclicRevise,
          mustText: MUST_CYCLIC_REVISE,
          contract: "PlanningInterface",
          message: `compose() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      const nextBefore = impl.planning.nextStep(advanced);
      const event: PlanRevisionEvent = {
        observation: `probe.ck08.failure.${subjectToken(ctx.subjectId)}`,
        stepId: later.stepId,
        severity: "invalidating",
      };

      let revised: Plan;
      try {
        revised = await impl.planning.revise(advanced, event);
      } catch (err) {
        throw new ObligationViolation({
          obligationId: PLANNING_OBLIGATION_IDS.cyclicRevise,
          mustText: MUST_CYCLIC_REVISE,
          contract: "PlanningInterface",
          message: `revise() threw on failure signal: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      const nextAfter = impl.planning.nextStep(revised);
      if (!detectsLoopBack(advanced, revised, nextBefore, nextAfter)) {
        throw new ObligationViolation({
          obligationId: PLANNING_OBLIGATION_IDS.cyclicRevise,
          mustText: MUST_CYCLIC_REVISE,
          contract: "PlanningInterface",
          message:
            "revise() did not route back to an earlier node after an invalidating failure signal",
        });
      }
    },
  });
}

export function defineRevisionUpdatesRationaleObligation(): Obligation<PlanningConformanceHarness> {
  return defineObligation({
    id: PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
    contract: "PlanningInterface",
    mustText: MUST_REVISION_UPDATES_RATIONALE,
    specIds: ["CK-08"],
    async check(impl, ctx) {
      let plan: Plan;
      try {
        const goals = buildPlanningProbeGoals(ctx);
        plan = await impl.planning.compose(
          goals,
          buildPlanningProbeContext(ctx),
        );
      } catch (err) {
        throw new ObligationViolation({
          obligationId: PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
          mustText: MUST_REVISION_UPDATES_RATIONALE,
          contract: "PlanningInterface",
          message: `compose() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (typeof plan.rationale !== "string" || plan.rationale.length === 0) {
        throw new ObligationViolation({
          obligationId: PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
          mustText: MUST_REVISION_UPDATES_RATIONALE,
          contract: "PlanningInterface",
          message: "compose() must supply a non-empty rationale",
        });
      }

      const priorRationale = plan.rationale;
      const event: PlanRevisionEvent = {
        observation: `probe.ck08.rationale.${subjectToken(ctx.subjectId)}`,
        severity: "blocking",
        ...(plan.steps[0]?.stepId !== undefined
          ? { stepId: plan.steps[0].stepId }
          : {}),
      };

      let revised: Plan;
      try {
        revised = await impl.planning.revise(plan, event);
      } catch (err) {
        throw new ObligationViolation({
          obligationId: PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
          mustText: MUST_REVISION_UPDATES_RATIONALE,
          contract: "PlanningInterface",
          message: `revise() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      if (typeof revised.rationale !== "string" || revised.rationale.length === 0) {
        throw new ObligationViolation({
          obligationId: PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
          mustText: MUST_REVISION_UPDATES_RATIONALE,
          contract: "PlanningInterface",
          message: "revise() returned empty rationale",
        });
      }
      if (revised.rationale === priorRationale) {
        throw new ObligationViolation({
          obligationId: PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
          mustText: MUST_REVISION_UPDATES_RATIONALE,
          contract: "PlanningInterface",
          message:
            "revise() left rationale unchanged (silent plan mutation)",
        });
      }
    },
  });
}

export function registerCyclicReviseObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineCyclicReviseObligation());
  return registry;
}

export function registerRevisionUpdatesRationaleObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineRevisionUpdatesRationaleObligation());
  return registry;
}

export function registerPlanningObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerCyclicReviseObligation(registry);
  registerRevisionUpdatesRationaleObligation(registry);
  return registry;
}

export function createCyclicReviseObligationRegistry(): ObligationRegistry {
  return registerCyclicReviseObligation(new ObligationRegistry());
}

export function createRevisionUpdatesRationaleObligationRegistry(): ObligationRegistry {
  return registerRevisionUpdatesRationaleObligation(new ObligationRegistry());
}

export function createPlanningObligationsRegistry(): ObligationRegistry {
  return registerPlanningObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories ── */

type PlanningFactoryOptions = {
  /** revise does not loop back (violate CK-08.1). */
  noLoopBack: boolean;
  /** revise keeps the same rationale (violate CK-08.2). */
  silentRationale: boolean;
};

function createPlanningFactory(
  options: PlanningFactoryOptions,
): () => PlanningConformanceHarness {
  return () => {
    let revisionSeq = 0;
    const planning: PlanningInterface = {
      async compose(goals, context) {
        const steps: PlanStep[] = goals
          .slice(0, PLANNING_STEP_SCAN_LIMIT)
          .map((g, i) => ({
            stepId: `probe.ck08.step.${i}.${g.goalId}`,
            goalId: g.goalId,
            action: `probe.ck08.action.${g.goalId}`,
            dependsOn:
              i === 0
                ? []
                : [`probe.ck08.step.${i - 1}.${goals[i - 1]!.goalId}`],
            status: i === 0 ? "active" : "pending",
          }));
        return {
          planId: `probe.ck08.plan.${context.slice(0, 48)}`,
          steps,
          rationale: `probe.ck08.rationale.initial.${context.slice(0, 32)}`,
        };
      },
      async revise(plan, event) {
        revisionSeq += 1;
        const steps = plan.steps.slice(0, PLANNING_STEP_SCAN_LIMIT).map((s) => ({
          ...s,
        }));

        if (!options.noLoopBack && steps.length >= 2) {
          // Route back: reopen foundation; demote later active/done steps.
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

        const rationale = options.silentRationale
          ? plan.rationale
          : `probe.ck08.rationale.rev.${revisionSeq}.${event.severity}.${event.observation.slice(0, 48)}`;

        return {
          planId: plan.planId,
          steps,
          rationale,
        };
      },
      nextStep(plan) {
        const pending = plan.steps
          .slice(0, PLANNING_STEP_SCAN_LIMIT)
          .find((s) => s.status === "active" || s.status === "pending");
        return pending ?? null;
      },
    };
    return { planning };
  };
}

/**
 * Known-good reference: invalidating revise loops back; rationale always changes.
 */
export function createCyclicPlanningHarnessFactory(): () => PlanningConformanceHarness {
  return createPlanningFactory({
    noLoopBack: false,
    silentRationale: false,
  });
}

/** Violation for CK-08.1: revise ignores failure loop-back. */
export function createNoLoopBackPlanningHarnessFactory(): () => PlanningConformanceHarness {
  return createPlanningFactory({
    noLoopBack: true,
    silentRationale: false,
  });
}

/** Violation for CK-08.2: revise leaves rationale unchanged. */
export function createSilentRationalePlanningHarnessFactory(): () => PlanningConformanceHarness {
  return createPlanningFactory({
    noLoopBack: false,
    silentRationale: true,
  });
}

/** One deliberately-broken planner that fails exactly one CK-08.* MUST. */
export interface PlanningViolationFixture {
  fixtureId: string;
  targetObligationId: (typeof PLANNING_OBLIGATION_IDS)[keyof typeof PLANNING_OBLIGATION_IDS];
  mustText: string;
  summary: string;
  createFactory: () => () => PlanningConformanceHarness;
}

/**
 * Named planning fixtures — each fails its target and passes the other.
 */
export const PLANNING_VIOLATION_FIXTURES = {
  noLoopBack: {
    fixtureId: "planning.violation.no-loop-back",
    targetObligationId: PLANNING_OBLIGATION_IDS.cyclicRevise,
    mustText: MUST_CYCLIC_REVISE,
    summary: "revise() ignores invalidating failure and does not route back",
    createFactory: createNoLoopBackPlanningHarnessFactory,
  },
  staticRationale: {
    fixtureId: "planning.violation.static-rationale",
    targetObligationId: PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
    mustText: MUST_REVISION_UPDATES_RATIONALE,
    summary: "revise() mutates the plan but leaves rationale unchanged",
    createFactory: createSilentRationalePlanningHarnessFactory,
  },
} as const satisfies Record<string, PlanningViolationFixture>;

export function listPlanningViolationFixtures(): readonly PlanningViolationFixture[] {
  return [
    PLANNING_VIOLATION_FIXTURES.noLoopBack,
    PLANNING_VIOLATION_FIXTURES.staticRationale,
  ];
}
