/**
 * DAG validation for task-graph packs — no filesystem or AJV (browser-safe).
 */

export const SCHEMA_VERSION = "task-graph.v1" as const;

/** Defaults matching task_router.py — packs SHOULD stamp these explicitly. */
export const DEFAULT_ADVANCE_THRESHOLD = 0.85;
export const DEFAULT_REMEDIATE_THRESHOLD = 0.4;

export const OBLIGATIONS = Object.freeze({
  SCHEMA_INVALID: "domain_loader.task_graph.schema_invalid",
  DUPLICATE_CONCEPT: "domain_loader.task_graph.duplicate_concept",
  MISSING_EDGE_ENDPOINT: "domain_loader.task_graph.missing_edge_endpoint",
  SELF_LOOP: "domain_loader.task_graph.self_loop",
  CYCLE: "domain_loader.task_graph.cycle",
  THRESHOLD_ORDER: "domain_loader.task_graph.threshold_order",
  BOUNDED_SCAN: "domain_loader.task_graph.bounded_scan",
});

/** Distinct DAG failure classes for observability (never silent). */
export type GraphFailureClass =
  | "duplicate_concept"
  | "missing_edge_endpoint"
  | "self_loop"
  | "cycle"
  | "bounded_scan"
  | "schema_invalid"
  | "threshold_order";

export type AgeFloor = "child" | "adolescent" | "adult";

export type TaskGraphConceptV1 = {
  conceptId: string;
  title: string;
  ageFloor?: AgeFloor;
};

export type TaskGraphEdgeV1 = {
  fromConceptId: string;
  toConceptId: string;
  type: "prerequisite";
};

export type TaskGraphThresholdsV1 = {
  advanceThreshold: number;
  remediateThreshold: number;
};

export type TaskGraphPackV1 = {
  schemaVersion: typeof SCHEMA_VERSION;
  packId: string;
  domainId: string;
  version: string;
  title?: string;
  description?: string;
  thresholds: TaskGraphThresholdsV1;
  concepts: TaskGraphConceptV1[];
  edges: TaskGraphEdgeV1[];
};

export type GraphViolation = {
  obligation: string;
  detail: string;
  /** Ordered concept ids forming the cycle (ends by repeating the start). */
  cyclePath?: string[];
};

export type ValidateGraphTelemetry = {
  event: "domain_loader.task_graph.validate" | "domain_loader.task_graph.dag";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  phase: string;
  failureClass?: GraphFailureClass;
  violationCount?: number;
  /** Length of cyclePath when failureClass is cycle/self_loop — never titles. */
  cyclePathLength?: number;
  packId?: string;
  conceptCount?: number;
  edgeCount?: number;
};

export type ValidateGraphOptions = {
  subjectId?: string;
  deviceId?: string;
  /** When false, skip telemetry (tests that only assert structure). Default true. */
  emitEvents?: boolean;
  /** Capture structured events (never includes titles or raw learner content). */
  onTelemetry?: (event: ValidateGraphTelemetry) => void;
  /** Max concepts/edges walked during cycle detection (NFR bound). */
  scanLimit?: number;
};

export type ValidateGraphInput = {
  concepts: TaskGraphConceptV1[];
  edges: TaskGraphEdgeV1[];
};

/**
 * Result of validateGraph() — topological order on success;
 * cyclePath on DAG failure.
 */
export type ValidateGraphResult = {
  status: 0 | 1;
  violations: GraphViolation[];
  combined: string;
  events: ValidateGraphTelemetry[];
  /** Kahn topological order when status === 0. */
  topologicalOrder?: string[];
  /** Ordered cycle path when a cycle/self-loop is found. */
  cyclePath?: string[];
  failureClass?: GraphFailureClass;
};

export type ValidatePackResult = {
  status: 0 | 1;
  violations: GraphViolation[];
  pack?: TaskGraphPackV1;
  combined: string;
  events: ValidateGraphTelemetry[];
};

export const SCAN_LIMIT_DEFAULT = 4096;

export function pushEvent(
  events: ValidateGraphTelemetry[],
  opts: ValidateGraphOptions,
  event: ValidateGraphTelemetry,
): void {
  if (opts.emitEvents === false) return;
  events.push(event);
  if (opts.onTelemetry) {
    opts.onTelemetry(event);
  } else {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

function primaryFailureClass(violations: GraphViolation[]): GraphFailureClass | undefined {
  if (!violations.length) return undefined;
  const ob = violations[0]!.obligation;
  switch (ob) {
    case OBLIGATIONS.SELF_LOOP:
      return "self_loop";
    case OBLIGATIONS.CYCLE:
      return "cycle";
    case OBLIGATIONS.MISSING_EDGE_ENDPOINT:
      return "missing_edge_endpoint";
    case OBLIGATIONS.DUPLICATE_CONCEPT:
      return "duplicate_concept";
    case OBLIGATIONS.BOUNDED_SCAN:
      return "bounded_scan";
    case OBLIGATIONS.THRESHOLD_ORDER:
      return "threshold_order";
    case OBLIGATIONS.SCHEMA_INVALID:
      return "schema_invalid";
    default:
      return undefined;
  }
}

/**
 * Extract an ordered cycle path from residual nodes after a failed Kahn pass.
 * Path ends by repeating the start id (e.g. a -> b -> c -> a).
 */
export function findCyclePath(
  conceptIds: string[],
  edges: TaskGraphEdgeV1[],
  scanLimit = SCAN_LIMIT_DEFAULT,
): string[] | null {
  const idSet = new Set(conceptIds);
  const adj = new Map<string, string[]>();
  for (const id of conceptIds) adj.set(id, []);
  let scanned = 0;
  for (const e of edges) {
    scanned += 1;
    if (scanned > scanLimit) return null;
    if (!idSet.has(e.fromConceptId) || !idSet.has(e.toConceptId)) continue;
    if (e.fromConceptId === e.toConceptId) {
      return [e.fromConceptId, e.fromConceptId];
    }
    const list = adj.get(e.fromConceptId);
    if (list) list.push(e.toConceptId);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of conceptIds) color.set(id, WHITE);
  const stack: string[] = [];

  function dfs(u: string): string[] | null {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(v);
        return [...stack.slice(idx), v];
      }
      if (c === WHITE) {
        const hit = dfs(v);
        if (hit) return hit;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  }

  for (const id of conceptIds) {
    if (color.get(id) === WHITE) {
      const hit = dfs(id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Kahn topological sort (prerequisites before dependents).
 * Edge fromConceptId → toConceptId means from depends on to; to is ordered first.
 * Returns order on DAG success; otherwise residual concept ids in the cycle set.
 */
export function topologicalSort(
  conceptIds: string[],
  edges: TaskGraphEdgeV1[],
  scanLimit = SCAN_LIMIT_DEFAULT,
): { order: string[] } | { residual: string[]; scannedEdges: number; bounded: boolean } {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of conceptIds) {
    indegree.set(id, 0);
    adj.set(id, []);
  }

  let scannedEdges = 0;
  for (const e of edges) {
    scannedEdges += 1;
    if (scannedEdges > scanLimit) {
      return { residual: conceptIds, scannedEdges, bounded: true };
    }
    if (e.fromConceptId === e.toConceptId) continue;
    if (!indegree.has(e.fromConceptId) || !indegree.has(e.toConceptId)) continue;
    // Prerequisite unlocks dependent: to → from in topo adjacency.
    adj.get(e.toConceptId)!.push(e.fromConceptId);
    indegree.set(e.fromConceptId, (indegree.get(e.fromConceptId) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  let qi = 0;
  while (qi < queue.length) {
    if (order.length > scanLimit) {
      return { residual: conceptIds, scannedEdges, bounded: true };
    }
    const u = queue[qi++]!;
    order.push(u);
    for (const v of adj.get(u) ?? []) {
      const next = (indegree.get(v) ?? 0) - 1;
      indegree.set(v, next);
      if (next === 0) queue.push(v);
    }
  }

  if (order.length === conceptIds.length) {
    return { order };
  }

  const residual = conceptIds.filter((id) => (indegree.get(id) ?? 0) > 0);
  return { residual, scannedEdges, bounded: false };
}

/**
 * DAG validator: topological check; on cycle, error includes ordered node ids.
 *
 * Call this at load before any router instantiation. Does not require full pack
 * metadata — concepts + edges only.
 */
export function validateGraph(
  input: ValidateGraphInput,
  opts: ValidateGraphOptions = {},
): ValidateGraphResult {
  const subjectId = opts.subjectId ?? "domain-loader-validate";
  const deviceId = opts.deviceId ?? "ci";
  const scanLimit = opts.scanLimit ?? SCAN_LIMIT_DEFAULT;
  const violations: GraphViolation[] = [];
  const events: ValidateGraphTelemetry[] = [];
  const { concepts, edges } = input;

  if (concepts.length > scanLimit || edges.length > scanLimit) {
    violations.push({
      obligation: OBLIGATIONS.BOUNDED_SCAN,
      detail: `concepts/edges exceed scan limit ${scanLimit}`,
    });
    const failureClass = "bounded_scan" as const;
    pushEvent(events, opts, {
      event: "domain_loader.task_graph.dag",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "topo",
      failureClass,
      violationCount: violations.length,
      conceptCount: concepts.length,
      edgeCount: edges.length,
    });
    return {
      status: 1,
      violations,
      events,
      failureClass,
      combined: violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n"),
    };
  }

  const ids = new Set<string>();
  for (const c of concepts) {
    if (ids.has(c.conceptId)) {
      violations.push({
        obligation: OBLIGATIONS.DUPLICATE_CONCEPT,
        detail: `duplicate conceptId: ${c.conceptId}`,
      });
    }
    ids.add(c.conceptId);
  }

  for (const e of edges) {
    if (e.fromConceptId === e.toConceptId) {
      const cyclePath = [e.fromConceptId, e.fromConceptId];
      violations.push({
        obligation: OBLIGATIONS.SELF_LOOP,
        detail: `self-loop edge on ${e.fromConceptId} (length-1 cycle)`,
        cyclePath,
      });
      continue;
    }
    if (!ids.has(e.fromConceptId)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_EDGE_ENDPOINT,
        detail: `edge.fromConceptId unknown: ${e.fromConceptId}`,
      });
    }
    if (!ids.has(e.toConceptId)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_EDGE_ENDPOINT,
        detail: `edge.toConceptId unknown: ${e.toConceptId}`,
      });
    }
  }

  if (violations.length > 0) {
    const failureClass = primaryFailureClass(violations)!;
    const cyclePath = violations.find((v) => v.cyclePath)?.cyclePath;
    const failEvent: ValidateGraphTelemetry = {
      event: "domain_loader.task_graph.dag",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "structure",
      failureClass,
      violationCount: violations.length,
      conceptCount: concepts.length,
      edgeCount: edges.length,
    };
    if (cyclePath) failEvent.cyclePathLength = cyclePath.length;
    pushEvent(events, opts, failEvent);
    const result: ValidateGraphResult = {
      status: 1,
      violations,
      events,
      failureClass,
      combined: violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n"),
    };
    if (cyclePath) result.cyclePath = cyclePath;
    return result;
  }

  const conceptIds = [...ids];
  const topo = topologicalSort(conceptIds, edges, scanLimit);

  if ("bounded" in topo && topo.bounded) {
    violations.push({
      obligation: OBLIGATIONS.BOUNDED_SCAN,
      detail: `topological scan exceeded limit ${scanLimit}`,
    });
    pushEvent(events, opts, {
      event: "domain_loader.task_graph.dag",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "topo",
      failureClass: "bounded_scan",
      violationCount: 1,
      conceptCount: concepts.length,
      edgeCount: edges.length,
    });
    return {
      status: 1,
      violations,
      events,
      failureClass: "bounded_scan",
      combined: violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n"),
    };
  }

  if ("order" in topo) {
    pushEvent(events, opts, {
      event: "domain_loader.task_graph.dag",
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "topo",
      conceptCount: concepts.length,
      edgeCount: edges.length,
    });
    return {
      status: 0,
      violations: [],
      events,
      topologicalOrder: topo.order,
      combined: `OK: DAG (${concepts.length} concepts, ${edges.length} edges)`,
    };
  }

  // Residual after Kahn → extract ordered cycle path among residual nodes.
  const residualEdges = edges.filter(
    (e) => topo.residual.includes(e.fromConceptId) && topo.residual.includes(e.toConceptId),
  );
  const cyclePath =
    findCyclePath(topo.residual, residualEdges, scanLimit) ??
    findCyclePath(conceptIds, edges, scanLimit);

  if (!cyclePath) {
    violations.push({
      obligation: OBLIGATIONS.CYCLE,
      detail: `prerequisite cycle among: ${topo.residual.join(", ")}`,
      cyclePath: topo.residual,
    });
  } else {
    violations.push({
      obligation: OBLIGATIONS.CYCLE,
      detail: `prerequisite cycle: ${cyclePath.join(" -> ")}`,
      cyclePath,
    });
  }

  pushEvent(events, opts, {
    event: "domain_loader.task_graph.dag",
    outcome: "fail",
    subjectId,
    deviceId,
    phase: "topo",
    failureClass: "cycle",
    violationCount: 1,
    cyclePathLength: (cyclePath ?? topo.residual).length,
    conceptCount: concepts.length,
    edgeCount: edges.length,
  });

  return {
    status: 1,
    violations,
    events,
    failureClass: "cycle",
    cyclePath: cyclePath ?? topo.residual,
    combined: violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n"),
  };
}