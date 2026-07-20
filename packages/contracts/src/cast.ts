/**
 * @module cast
 *
 * CAST-05 diagnostic cold-start — adaptive task-router obligations for
 * subjects without assessed prerequisite-root evidence.
 *
 * Spec row: docs/PRD_MATRIX.md CAST-05.
 */

/** Minimum friction samples before a root concept counts as assessed. */
export const CAST_05_MIN_ROOT_FRICTION_SAMPLES = 3;

/**
 * Route actions probed by CAST-05 cold-start conformance.
 * `advance` is quarantined until every pack root is assessed.
 */
export type ColdStartRouteAction =
  | "advance"
  | "remediate"
  | "hold"
  | "diagnostic-probe";

export type ColdStartGuidanceMode =
  | "diagnostic"
  | "exploratory"
  | "guided"
  | "reinforcement"
  | "prerequisite-remediation";

/**
 * Bounded cold-start probe input — metadata tokens only (no learner prose).
 * All reads are scoped by `subjectId`.
 */
export interface ColdStartRouteInput {
  subjectId: string;
  /** Active concept for this turn (may be a non-root). */
  activeConceptId: string;
  /**
   * Task-graph entry nodes (concepts with empty prerequisites).
   * Bounded — implementations MUST NOT scan unbounded concept tables here.
   */
  rootConceptIds: readonly string[];
  /**
   * Per-concept friction sample counts for this subject.
   * A root is assessed iff count >= CAST_05_MIN_ROOT_FRICTION_SAMPLES.
   */
  frictionSampleCounts: Readonly<Record<string, number>>;
  /** Optional mastery means — high confidence MUST NOT force advance under cold-start. */
  masteryMeanByConcept?: Readonly<Record<string, number>>;
}

export interface ColdStartRouteResult {
  subjectId: string;
  routeAction: ColdStartRouteAction;
  mode: ColdStartGuidanceMode;
  /** Roots still below the assessed-sample threshold (deterministic order). */
  unassessedRootConceptIds: readonly string[];
}

/**
 * Contract requirements (CAST-05):
 *  1. While any task-graph root concept lacks an assessed posterior seed
 *     (≥3 friction samples), the router MUST NOT emit routeAction `advance`;
 *     new subjects MUST remain in `diagnostic` mode until every root concept
 *     has been assessed.
 */
export interface ColdStartRouterInterface {
  route(
    input: ColdStartRouteInput,
  ): ColdStartRouteResult | Promise<ColdStartRouteResult>;
}

/** Verbatim MUST sentence for CAST-05.1 (obligation catalog). */
export const MUST_COLD_START_ADVANCE_BLOCKED =
  "While any task-graph root concept lacks an assessed posterior seed (≥3 friction samples), the router MUST NOT emit routeAction `advance`; new subjects MUST remain in `diagnostic` mode until every root concept has been assessed.";
