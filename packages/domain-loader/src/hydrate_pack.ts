/**
 * Browser-safe task-graph pack hydrate (no filesystem).
 */

import {
  DEFAULT_ADVANCE_THRESHOLD,
  DEFAULT_REMEDIATE_THRESHOLD,
  OBLIGATIONS,
  SCHEMA_VERSION,
  validateGraph,
  type AgeFloor,
  type TaskGraphPackV1,
  type TaskGraphThresholdsV1,
} from "./dag_validate.js";

export type LoadedConceptNode = {
  conceptId: string;
  title: string;
  prerequisites: string[];
  ageFloor: AgeFloor;
};

export type LoadedTaskGraph = {
  packId: string;
  domainId: string;
  version: string;
  /** Operator-facing stamp for hot-reload / UI debugging (`packId@version`). */
  versionStamp: string;
  schemaVersion: string;
  thresholds: TaskGraphThresholdsV1;
  /** conceptId → node (TaskGraph.nodes shape). */
  nodes: Record<string, LoadedConceptNode>;
  /** Stable ordered concept list. */
  concepts: LoadedConceptNode[];
  sourcePath: string;
  /** File mtime ms when loaded from disk (0 for in-memory). */
  sourceMtimeMs: number;
};

export type GraphSemanticsFingerprint = {
  packId: string;
  version: string;
  versionStamp: string;
  advanceThreshold: number;
  remediateThreshold: number;
  nodes: Array<{
    conceptId: string;
    title: string;
    prerequisites: string[];
    ageFloor: AgeFloor;
  }>;
};

export type LoadTaskGraphOptions = {
  subjectId?: string;
  deviceId?: string;
  emitEvents?: boolean;
  onTelemetry?: (event: LoadTaskGraphTelemetry) => void;
  scanLimit?: number;
  /** When true (default), validate schema + DAG before mapping. */
  validate?: boolean;
};

export class TaskGraphLoadError extends Error {
  readonly obligation: string;
  readonly failureClass?: string;
  readonly cyclePath?: string[];
  readonly subjectId: string;
  readonly deviceId: string;

  constructor(
    message: string,
    init: {
      obligation: string;
      failureClass?: string;
      cyclePath?: string[];
      subjectId: string;
      deviceId: string;
    },
  ) {
    super(message);
    this.name = "TaskGraphLoadError";
    this.obligation = init.obligation;
    this.subjectId = init.subjectId;
    this.deviceId = init.deviceId;
    if (init.failureClass) this.failureClass = init.failureClass;
    if (init.cyclePath) this.cyclePath = init.cyclePath;
  }
}

export type LoadTaskGraphTelemetry = {
  event: "domain_loader.task_graph.load";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  phase: string;
  failureClass?: string;
  packId?: string;
  versionStamp?: string;
  conceptCount?: number;
  edgeCount?: number;
  sourcePath?: string;
};

export function pushLoadEvent(
  opts: LoadTaskGraphOptions,
  events: LoadTaskGraphTelemetry[],
  event: LoadTaskGraphTelemetry,
): void {
  if (opts.emitEvents === false) return;
  events.push(event);
  if (opts.onTelemetry) {
    opts.onTelemetry(event);
  } else {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

/**
 * Resolve thresholds — pack values when present and positive; else defaults.
 * Never silently uses 0/0 (Postgres-row-missing / partial-row case).
 */
export function resolveThresholds(
  raw: Partial<TaskGraphThresholdsV1> | null | undefined,
): TaskGraphThresholdsV1 {
  const advance =
    typeof raw?.advanceThreshold === "number" &&
    Number.isFinite(raw.advanceThreshold) &&
    raw.advanceThreshold > 0
      ? raw.advanceThreshold
      : DEFAULT_ADVANCE_THRESHOLD;
  const remediate =
    typeof raw?.remediateThreshold === "number" &&
    Number.isFinite(raw.remediateThreshold) &&
    raw.remediateThreshold > 0
      ? raw.remediateThreshold
      : DEFAULT_REMEDIATE_THRESHOLD;
  return { advanceThreshold: advance, remediateThreshold: remediate };
}

/**
 * Map a validated (or trusted) pack object into router-shaped LoadedTaskGraph.
 */
export function mapPackToLoadedGraph(
  pack: TaskGraphPackV1,
  sourcePath: string,
  sourceMtimeMs = 0,
): LoadedTaskGraph {
  const thresholds = resolveThresholds(pack.thresholds);
  const prereqMap = new Map<string, string[]>();
  for (const c of pack.concepts) prereqMap.set(c.conceptId, []);
  for (const e of pack.edges) {
    const list = prereqMap.get(e.fromConceptId);
    if (list) list.push(e.toConceptId);
  }

  const concepts: LoadedConceptNode[] = pack.concepts.map((c) => ({
    conceptId: c.conceptId,
    title: c.title,
    prerequisites: [...(prereqMap.get(c.conceptId) ?? [])].sort(),
    ageFloor: c.ageFloor ?? "child",
  }));

  const nodes: Record<string, LoadedConceptNode> = {};
  for (const n of concepts) nodes[n.conceptId] = n;

  const versionStamp = `${pack.packId}@${pack.version}`;
  return {
    packId: pack.packId,
    domainId: pack.domainId,
    version: pack.version,
    versionStamp,
    schemaVersion: pack.schemaVersion ?? SCHEMA_VERSION,
    thresholds,
    nodes,
    concepts,
    sourcePath,
    sourceMtimeMs,
  };
}

/** Canonical fingerprint for TS↔Python parity on the same pack bytes. */
export function graphSemanticsFingerprint(
  loaded: LoadedTaskGraph,
): GraphSemanticsFingerprint {
  const nodes = [...loaded.concepts]
    .map((n) => ({
      conceptId: n.conceptId,
      title: n.title,
      prerequisites: [...n.prerequisites].sort(),
      ageFloor: n.ageFloor,
    }))
    .sort((a, b) => a.conceptId.localeCompare(b.conceptId));
  return {
    packId: loaded.packId,
    version: loaded.version,
    versionStamp: loaded.versionStamp,
    advanceThreshold: loaded.thresholds.advanceThreshold,
    remediateThreshold: loaded.thresholds.remediateThreshold,
    nodes,
  };
}


export type LoadFromObjectOptions = LoadTaskGraphOptions & {
  sourcePath?: string;
  sourceMtimeMs?: number;
};

/**
 * Browser-safe hydrate: threshold fallback + DAG validateGraph (no fs / AJV).
 * Use for playground static JSON imports and hot-reload buffers.
 */
export function hydrateTaskGraphFromPackObject(
  raw: unknown,
  opts: LoadFromObjectOptions = {},
): LoadedTaskGraph {
  const subjectId = opts.subjectId ?? "domain-loader-hydrate";
  const deviceId = opts.deviceId ?? "ci";
  const sourcePath = opts.sourcePath ?? "<bundled>";
  const sourceMtimeMs = opts.sourceMtimeMs ?? 0;
  const events: LoadTaskGraphTelemetry[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphLoadError("pack root must be an object", {
      obligation: OBLIGATIONS.SCHEMA_INVALID,
      failureClass: "schema_invalid",
      subjectId,
      deviceId,
    });
  }

  const obj = { ...(raw as Record<string, unknown>) };
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    throw new TaskGraphLoadError(
      `schemaVersion must be ${SCHEMA_VERSION}`,
      {
        obligation: OBLIGATIONS.SCHEMA_INVALID,
        failureClass: "schema_invalid",
        subjectId,
        deviceId,
      },
    );
  }

  const thr = obj.thresholds;
  if (thr == null || typeof thr !== "object" || Array.isArray(thr)) {
    obj.thresholds = resolveThresholds(null);
  } else {
    obj.thresholds = resolveThresholds(thr as Partial<TaskGraphThresholdsV1>);
  }

  const concepts = obj.concepts;
  const edges = obj.edges;
  if (!Array.isArray(concepts) || !Array.isArray(edges)) {
    throw new TaskGraphLoadError("pack requires concepts[] and edges[]", {
      obligation: OBLIGATIONS.SCHEMA_INVALID,
      failureClass: "schema_invalid",
      subjectId,
      deviceId,
    });
  }

  if (opts.validate !== false) {
    const dagOpts: {
      subjectId: string;
      deviceId: string;
      emitEvents: false;
      scanLimit?: number;
    } = {
      subjectId,
      deviceId,
      emitEvents: false,
    };
    if (opts.scanLimit !== undefined) dagOpts.scanLimit = opts.scanLimit;
    const dag = validateGraph(
      {
        concepts: concepts as TaskGraphPackV1["concepts"],
        edges: edges as TaskGraphPackV1["edges"],
      },
      dagOpts,
    );
    if (dag.status !== 0) {
      const first = dag.violations[0];
      const failEvent: LoadTaskGraphTelemetry = {
        event: "domain_loader.task_graph.load",
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "dag",
        sourcePath,
      };
      if (dag.failureClass) failEvent.failureClass = dag.failureClass;
      pushLoadEvent(opts, events, failEvent);
      const errInit: {
        obligation: string;
        failureClass?: string;
        cyclePath?: string[];
        subjectId: string;
        deviceId: string;
      } = {
        obligation: first?.obligation ?? OBLIGATIONS.CYCLE,
        subjectId,
        deviceId,
      };
      if (dag.failureClass) errInit.failureClass = dag.failureClass;
      if (dag.cyclePath) errInit.cyclePath = dag.cyclePath;
      throw new TaskGraphLoadError(dag.combined, errInit);
    }
  }

  const pack = obj as TaskGraphPackV1;
  const loaded = mapPackToLoadedGraph(pack, sourcePath, sourceMtimeMs);
  pushLoadEvent(opts, events, {
    event: "domain_loader.task_graph.load",
    outcome: "ok",
    subjectId,
    deviceId,
    phase: "hydrate",
    packId: loaded.packId,
    versionStamp: loaded.versionStamp,
    conceptCount: loaded.concepts.length,
    edgeCount: edges.length,
    sourcePath,
  });
  return loaded;
}

