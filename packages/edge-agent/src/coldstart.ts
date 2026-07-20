/**
 * CAST-05 cold-start gate (edge routing seam).
 *
 * Pure evaluation of advance quarantine until every task-graph root has an
 * assessed posterior seed. TaskRouter (Python) and playground route_core
 * apply the same rules: evidence = Σα+Σβ per concept; min samples = 3.
 */

import {
  CAST_05_MIN_ROOT_FRICTION_SAMPLES,
  MUST_COLD_START_ADVANCE_BLOCKED,
  type ColdStartGuidanceMode,
  type ColdStartRouteAction,
  type ColdStartRouteInput,
  type ColdStartRouteResult,
  type ColdStartRouterInterface,
} from "@moolam/contracts";

export {
  CAST_05_MIN_ROOT_FRICTION_SAMPLES,
  MUST_COLD_START_ADVANCE_BLOCKED,
};
export const CAST_05_1_OBLIGATION_ID = "CAST-05.1";

/** Max roots inspected per gate evaluation (NFR — bounded scan). */
export const COLD_START_ROOT_SCAN_LIMIT = 64;

export type ColdStartGateEvent = {
  event: "coldstart.gate";
  outcome: "block_advance" | "allow_advance" | "error";
  subjectId: string;
  deviceId?: string;
  unassessedRootCount: number;
  routeAction?: ColdStartRouteAction;
  failureClass?: string;
  obligationId?: string;
};

export type MasteryShard = {
  alpha: Readonly<Record<string, number>>;
  beta: Readonly<Record<string, number>>;
};

/**
 * Evidence units from mastery G-Counters (Σα + Σβ) — matches TaskRouter
 * ``mastery_evidence_counts`` and playground ``evidenceCount``.
 */
export function evidenceCountFromMasteryShard(m: MasteryShard | undefined): number {
  if (!m) return 0;
  const a = Object.values(m.alpha).reduce((s, v) => s + v, 0);
  const b = Object.values(m.beta).reduce((s, v) => s + v, 0);
  return a + b;
}

export function masteryEvidenceCounts(
  mastery: Readonly<Record<string, MasteryShard>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const keys = Object.keys(mastery).slice(0, COLD_START_ROOT_SCAN_LIMIT * 4);
  for (const id of keys) {
    counts[id] = evidenceCountFromMasteryShard(mastery[id]);
  }
  return counts;
}

/** Pack entry nodes (empty prerequisites), bounded. */
export function rootConceptIdsFromNodes(
  nodes:
    | ReadonlyArray<{ conceptId: string; prerequisites: readonly string[] }>
    | Map<string, { conceptId: string; prerequisites: readonly string[] }>
    | Record<string, { conceptId?: string; prerequisites: readonly string[] }>,
): string[] {
  let list: Array<{ conceptId: string; prerequisites: readonly string[] }>;
  if (Array.isArray(nodes)) {
    list = nodes;
  } else if (nodes instanceof Map) {
    list = [...nodes.values()];
  } else {
    list = Object.entries(nodes).map(([k, v]) => ({
      conceptId: v.conceptId ?? k,
      prerequisites: v.prerequisites ?? [],
    }));
  }
  const roots: string[] = [];
  for (const n of list.slice(0, COLD_START_ROOT_SCAN_LIMIT * 4)) {
    if (!n.prerequisites || n.prerequisites.length === 0) {
      roots.push(n.conceptId);
      if (roots.length >= COLD_START_ROOT_SCAN_LIMIT) break;
    }
  }
  return roots;
}

/**
 * Roots still below CAST_05_MIN_ROOT_FRICTION_SAMPLES, deterministic order.
 */
export function listUnassessedRoots(
  rootConceptIds: readonly string[],
  frictionSampleCounts: Readonly<Record<string, number>>,
  minSamples: number = CAST_05_MIN_ROOT_FRICTION_SAMPLES,
): string[] {
  const roots = rootConceptIds.slice(0, COLD_START_ROOT_SCAN_LIMIT);
  const unassessed: string[] = [];
  for (const id of roots) {
    const n = frictionSampleCounts[id] ?? 0;
    if (n < minSamples) unassessed.push(id);
  }
  return unassessed;
}

/**
 * True when cold-start still quarantines `advance` for this subject/pack.
 */
export function coldStartBlocksAdvance(
  input: Pick<
    ColdStartRouteInput,
    "rootConceptIds" | "frictionSampleCounts"
  >,
): boolean {
  return (
    listUnassessedRoots(input.rootConceptIds, input.frictionSampleCounts)
      .length > 0
  );
}

export type ColdStartRouteAdvisory = {
  blocked: boolean;
  unassessedRootConceptIds: string[];
  /** First unassessed root to probe when blocked. */
  probeConceptId: string | null;
  /** Advisory fragment for routing_rationale (metadata only). */
  rationaleAdvisory: string | null;
  mode: ColdStartGuidanceMode | null;
};

/**
 * Apply CAST-05.1 gate to a would-be route: quarantine advance, force
 * diagnostic probe + advisory when roots lack assessed posterior seeds.
 */
export function applyColdStartGate(input: {
  subjectId: string;
  rootConceptIds: readonly string[];
  frictionSampleCounts: Readonly<Record<string, number>>;
  /** Current guidance mode — remediation is not overridden. */
  mode: string;
  wouldAdvance: boolean;
  deviceId?: string;
  emit?: (e: ColdStartGateEvent) => void;
}): ColdStartRouteAdvisory {
  if (!input.subjectId || typeof input.subjectId !== "string") {
    input.emit?.({
      event: "coldstart.gate",
      outcome: "error",
      subjectId: String(input.subjectId ?? ""),
      unassessedRootCount: 0,
      failureClass: "coldstart.subject_missing",
      obligationId: CAST_05_1_OBLIGATION_ID,
    });
    throw new Error("coldstart.subject_missing: subjectId required");
  }

  const unassessedRootConceptIds = listUnassessedRoots(
    input.rootConceptIds,
    input.frictionSampleCounts,
  );
  const blocked = unassessedRootConceptIds.length > 0;

  if (input.mode === "prerequisite-remediation") {
    input.emit?.({
      event: "coldstart.gate",
      outcome: blocked ? "block_advance" : "allow_advance",
      subjectId: input.subjectId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      unassessedRootCount: unassessedRootConceptIds.length,
      obligationId: CAST_05_1_OBLIGATION_ID,
    });
    return {
      blocked: false,
      unassessedRootConceptIds,
      probeConceptId: null,
      rationaleAdvisory: null,
      mode: null,
    };
  }

  if (!blocked) {
    input.emit?.({
      event: "coldstart.gate",
      outcome: "allow_advance",
      subjectId: input.subjectId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      unassessedRootCount: 0,
      obligationId: CAST_05_1_OBLIGATION_ID,
    });
    return {
      blocked: false,
      unassessedRootConceptIds: [],
      probeConceptId: null,
      rationaleAdvisory: null,
      mode: null,
    };
  }

  const probe = unassessedRootConceptIds[0]!;
  const rationaleAdvisory =
    `${CAST_05_1_OBLIGATION_ID} cold-start: unassessed_roots=` +
    `${unassessedRootConceptIds.join(",")}; advance quarantined; ` +
    `diagnostic probe '${probe}'`;

  input.emit?.({
    event: "coldstart.gate",
    outcome: "block_advance",
    subjectId: input.subjectId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    unassessedRootCount: unassessedRootConceptIds.length,
    routeAction: input.wouldAdvance ? "diagnostic-probe" : "diagnostic-probe",
    obligationId: CAST_05_1_OBLIGATION_ID,
  });

  return {
    blocked: true,
    unassessedRootConceptIds,
    probeConceptId: probe,
    rationaleAdvisory,
    mode: "diagnostic",
  };
}

/**
 * CAST-05-compliant route decision — never advances while roots are unassessed.
 * High mastery on the active concept does not override the quarantine.
 */
export function evaluateColdStartRoute(
  input: ColdStartRouteInput,
  emit?: (e: ColdStartGateEvent) => void,
): ColdStartRouteResult {
  if (!input.subjectId || typeof input.subjectId !== "string") {
    emit?.({
      event: "coldstart.gate",
      outcome: "error",
      subjectId: String(input.subjectId ?? ""),
      unassessedRootCount: 0,
      failureClass: "coldstart.subject_missing",
      obligationId: CAST_05_1_OBLIGATION_ID,
    });
    throw new Error("coldstart.subject_missing: subjectId required");
  }

  const unassessedRootConceptIds = listUnassessedRoots(
    input.rootConceptIds,
    input.frictionSampleCounts,
  );
  const blocked = unassessedRootConceptIds.length > 0;

  let routeAction: ColdStartRouteAction;
  let mode: ColdStartGuidanceMode;
  if (blocked) {
    routeAction = "diagnostic-probe";
    mode = "diagnostic";
  } else {
    const mean = input.masteryMeanByConcept?.[input.activeConceptId] ?? 0.5;
    if (mean >= 0.85) {
      routeAction = "advance";
      mode = "exploratory";
    } else {
      routeAction = "hold";
      mode = "exploratory";
    }
  }

  emit?.({
    event: "coldstart.gate",
    outcome: blocked ? "block_advance" : "allow_advance",
    subjectId: input.subjectId,
    unassessedRootCount: unassessedRootConceptIds.length,
    routeAction,
    obligationId: CAST_05_1_OBLIGATION_ID,
  });

  return {
    subjectId: input.subjectId,
    routeAction,
    mode,
    unassessedRootConceptIds,
  };
}

/** Edge-facing ColdStartRouterInterface backed by evaluateColdStartRoute. */
export function createEdgeColdStartRouter(
  emit?: (e: ColdStartGateEvent) => void,
): ColdStartRouterInterface {
  return {
    route(input) {
      return evaluateColdStartRoute(input, emit);
    },
  };
}

/**
 * Edge parity harness: evaluate CAST-05.1 gate for a shared golden case
 * (same pack roots + mastery evidence as cloud TaskRouter).
 */
export function evaluateColdStartParityGate(input: {
  subjectId: string;
  deviceId?: string;
  mode: string;
  wouldAdvance: boolean;
  rootConceptIds: readonly string[];
  mastery: Readonly<Record<string, MasteryShard>>;
  emit?: (e: ColdStartGateEvent) => void;
}): ColdStartRouteAdvisory {
  const frictionSampleCounts = masteryEvidenceCounts(input.mastery);
  return applyColdStartGate({
    subjectId: input.subjectId,
    rootConceptIds: input.rootConceptIds,
    frictionSampleCounts,
    mode: input.mode,
    wouldAdvance: input.wouldAdvance,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.emit !== undefined ? { emit: input.emit } : {}),
  });
}
