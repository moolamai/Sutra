/**
 * @module plan_stage
 *
 * Extract plan-stage entry points (compose / revise / reuse).
 * Integration suite: `tests/plan_stage_integration.test.mjs`
 * (compose → blocking revise → activePlans persistence across sequential turns).
 *
 * Given reasoning output + an optional active session plan, call
 * `PlanningInterface.compose` (first turn) or `revise` (blocking /
 * invalidating signals only). Informational / healthy reasoning reuses the
 * active plan without calling revise. Wired into `CognitiveCore.turn` in
 * This module stays a pure stage so harness.ts stays linear.
 *
 * CK-08.2: every successful revise MUST change `rationale`; silent mutation
 * is a typed contract error (never swallowed).
 */

import type {
  Goal,
  Plan,
  PlanRevisionEvent,
  PlanningInterface,
  ReasoningResult,
} from "@moolam/contracts";

/** Bounded goals passed to compose (NFR — no unbounded scans). */
export const PLAN_STAGE_GOAL_LIMIT = 32;

/** Confidence below this with an active plan forces a blocking revise. */
export const PLAN_STAGE_LOW_CONFIDENCE = 0.35;

/** Obligation id when revise leaves rationale unchanged. */
export const PLAN_STAGE_OBLIGATION_RATIONALE = "CK-08.2";

export type PlanStageOutcome = "composed" | "revised" | "reused";

/** Structured stage telemetry — never raw utterance / conclusion plaintext. */
export type PlanStageEvent = {
  event: "cognitive_core.plan_stage";
  subjectId: string;
  sessionId: string;
  outcome: PlanStageOutcome | "error";
  planId: string | null;
  stepCount: number;
  revisionSeverity: PlanRevisionEvent["severity"] | null;
  failureClass?: "validation" | "contract" | "downstream";
};

export class PlanStageError extends Error {
  readonly obligationId: string | null;
  readonly failureClass: "validation" | "contract" | "downstream";

  constructor(
    message: string,
    opts: {
      obligationId?: string | null;
      failureClass?: "validation" | "contract" | "downstream";
    } = {},
  ) {
    super(message);
    this.name = "PlanStageError";
    this.obligationId = opts.obligationId ?? null;
    this.failureClass = opts.failureClass ?? "validation";
  }
}

export type PlanStageInput = {
  subjectId: string;
  sessionId: string;
  planning: PlanningInterface;
  reasoning: ReasoningResult;
  /** Active plan for this session, if any. */
  activePlan: Plan | null;
  /** Goals for compose (ignored on revise/reuse). Bounded by PLAN_STAGE_GOAL_LIMIT. */
  goals: readonly Goal[];
  /**
   * Planner context — metadata / conclusion digest only. Hosts MUST NOT pass
   * raw learner utterance (sovereignty).
   */
  context: string;
  /**
   * Optional explicit revision signal. When omitted, derived from reasoning
   * (unresolvedConstraints → blocking; low confidence → blocking).
   * Informational never forces revise.
   */
  revisionSignal?: PlanRevisionEvent | null;
  emit?: (event: PlanStageEvent) => void;
};

export type PlanStageResult = {
  plan: Plan;
  outcome: PlanStageOutcome;
  previousRationale: string | null;
  /** True when revise looped on blocking/invalidating evidence. */
  revised: boolean;
};

/**
 * Default session goals for first-turn compose — domain + subject tokens only
 * (never utterance / learner content). Bounded to two steps.
 */
export function defaultSessionGoals(
  domainId: string,
  subjectId: string,
): Goal[] {
  const domain = domainId.trim().slice(0, 64) || "domain";
  const subject = subjectId.trim().slice(0, 64) || "subject";
  const engageId = `goal.${domain}.engage`;
  return [
    {
      goalId: engageId,
      description: `probe.plan.engage.${domain}.${subject}`,
      prerequisites: [],
      successCriterion: `${engageId}.ok`,
    },
    {
      goalId: `goal.${domain}.progress`,
      description: `probe.plan.progress.${domain}.${subject}`,
      prerequisites: [engageId],
      successCriterion: `goal.${domain}.progress.ok`,
    },
  ];
}

/**
 * Planner context digest — confidence + domain metadata only (no utterance).
 */
export function planStageContext(
  domainId: string,
  reasoning: Pick<ReasoningResult, "confidence">,
): string {
  const conf = Number.isFinite(reasoning.confidence)
    ? reasoning.confidence.toFixed(3)
    : "na";
  return `domain:${domainId.trim().slice(0, 64)};confidence:${conf}`;
}

/**
 * Derive a revision event from reasoning. Informational paths return null
 * (active plan is reused). Only blocking / invalidating route to revise.
 */
export function derivePlanRevisionSignal(
  reasoning: ReasoningResult,
  explicit?: PlanRevisionEvent | null,
): PlanRevisionEvent | null {
  if (explicit) {
    if (explicit.severity === "informational") return null;
    return explicit;
  }
  const unresolved = reasoning.unresolvedConstraints.slice(0, 8);
  if (unresolved.length > 0) {
    return {
      observation: `unresolved_count=${unresolved.length}`,
      severity: "blocking",
    };
  }
  if (
    Number.isFinite(reasoning.confidence) &&
    reasoning.confidence < PLAN_STAGE_LOW_CONFIDENCE
  ) {
    return {
      observation: `low_confidence`,
      severity: "blocking",
    };
  }
  return null;
}

/**
 * Run the plan stage after reasoning completes.
 *
 * - No active plan → `compose`
 * - Active plan + blocking/invalidating signal → `revise` (rationale MUST change)
 * - Active plan otherwise → reuse (no planning call)
 */
export async function runPlanStage(
  input: PlanStageInput,
): Promise<PlanStageResult> {
  const subjectId = input.subjectId.trim();
  const sessionId = input.sessionId.trim();
  if (!subjectId) {
    throw new PlanStageError("plan stage requires subjectId (subject isolation)", {
      failureClass: "validation",
    });
  }
  if (!sessionId) {
    throw new PlanStageError("plan stage requires sessionId", {
      failureClass: "validation",
    });
  }

  const emit = input.emit;
  const signal = derivePlanRevisionSignal(
    input.reasoning,
    input.revisionSignal,
  );

  try {
    if (!input.activePlan) {
      const goals = input.goals.slice(0, PLAN_STAGE_GOAL_LIMIT);
      if (goals.length === 0) {
        throw new PlanStageError("compose requires at least one goal", {
          failureClass: "validation",
        });
      }
      const context = input.context.slice(0, 512);
      const plan = await input.planning.compose([...goals], context);
      const result: PlanStageResult = {
        plan,
        outcome: "composed",
        previousRationale: null,
        revised: false,
      };
      emit?.({
        event: "cognitive_core.plan_stage",
        subjectId,
        sessionId,
        outcome: "composed",
        planId: plan.planId,
        stepCount: plan.steps.length,
        revisionSeverity: null,
      });
      return result;
    }

    if (!signal) {
      const plan = input.activePlan;
      emit?.({
        event: "cognitive_core.plan_stage",
        subjectId,
        sessionId,
        outcome: "reused",
        planId: plan.planId,
        stepCount: plan.steps.length,
        revisionSeverity: null,
      });
      return {
        plan,
        outcome: "reused",
        previousRationale: plan.rationale,
        revised: false,
      };
    }

    const previousRationale = input.activePlan.rationale;
    const revised = await input.planning.revise(input.activePlan, signal);
    if (revised.rationale === previousRationale) {
      throw new PlanStageError(
        "Every revision MUST update `rationale`; silent plan mutation is a contract violation.",
        {
          obligationId: PLAN_STAGE_OBLIGATION_RATIONALE,
          failureClass: "contract",
        },
      );
    }
    const result: PlanStageResult = {
      plan: revised,
      outcome: "revised",
      previousRationale,
      revised: true,
    };
    emit?.({
      event: "cognitive_core.plan_stage",
      subjectId,
      sessionId,
      outcome: "revised",
      planId: revised.planId,
      stepCount: revised.steps.length,
      revisionSeverity: signal.severity,
    });
    return result;
  } catch (err) {
    if (err instanceof PlanStageError) {
      emit?.({
        event: "cognitive_core.plan_stage",
        subjectId,
        sessionId,
        outcome: "error",
        planId: input.activePlan?.planId ?? null,
        stepCount: input.activePlan?.steps.length ?? 0,
        revisionSeverity: signal?.severity ?? null,
        failureClass: err.failureClass,
      });
      throw err;
    }
    emit?.({
      event: "cognitive_core.plan_stage",
      subjectId,
      sessionId,
      outcome: "error",
      planId: input.activePlan?.planId ?? null,
      stepCount: input.activePlan?.steps.length ?? 0,
      revisionSeverity: signal?.severity ?? null,
      failureClass: "downstream",
    });
    throw err;
  }
}

/**
 * Per-session serialization for plan Map mutations (overlapping turns).
 * Independent instances share no mutable state (obligation independence).
 */
export class SessionPlanGate {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` exclusively for `sessionId`. Concurrent callers for the same
   * session queue; different sessions remain concurrent.
   */
  async runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const key = sessionId.trim();
    if (!key) {
      throw new PlanStageError("sessionId required for SessionPlanGate", {
        failureClass: "validation",
      });
    }
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail.catch(() => undefined));
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
