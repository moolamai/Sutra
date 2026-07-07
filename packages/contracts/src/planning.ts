/**
 * @module planning
 *
 * Planning contract - goal decomposition and plan revision.
 *
 * Working through a skill graph, preparing a case, working up a
 * differential diagnosis, and reviewing a design are all goal graphs
 * traversed under evidence. Implementations may bind LangGraph state
 * machines (the reference), HTN planners, or custom domain planners -
 * the core requires only the contract below.
 */

export interface Goal {
  goalId: string;
  description: string;
  /** Goals this one depends on — the prerequisite DAG, generalized. */
  prerequisites: string[];
  /** Measurable completion signal the planner can evaluate. */
  successCriterion: string;
}

export interface PlanStep {
  stepId: string;
  goalId: string;
  action: string;
  /** Steps that must complete first. */
  dependsOn: string[];
  status: "pending" | "active" | "done" | "blocked" | "abandoned";
}

export interface Plan {
  planId: string;
  steps: PlanStep[];
  /** Why the plan has this shape — the planner's audit trail. */
  rationale: string;
}

export interface PlanRevisionEvent {
  /** New evidence that may invalidate the current plan. */
  observation: string;
  /** Which step (if any) the observation arose from. */
  stepId?: string;
  severity: "informational" | "blocking" | "invalidating";
}

/**
 * Contract requirements:
 *  1. Plans MUST be cyclic-capable: `revise` may route BACK to earlier
 *     goals when evidence shows a foundation is weak (the loop-back
 *     property, valid in any domain).
 *  2. Every revision MUST update `rationale`; silent plan mutation is a
 *     contract violation.
 */
export interface PlanningInterface {
  compose(goals: Goal[], context: string): Promise<Plan>;
  revise(plan: Plan, event: PlanRevisionEvent): Promise<Plan>;
  nextStep(plan: Plan): PlanStep | null;
}
