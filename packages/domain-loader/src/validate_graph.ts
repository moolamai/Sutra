/**
 * Validate task-graph v1 packs: JSON Schema + DAG topological check.
 *
 * Aligns with packages/cloud-orchestrator ConceptNode / TaskGraph.
 * Thresholds in the pack are the sole advance/remediate source for consumers.
 *
 * validateGraph() is the DAG gate: Kahn topological order on success;
 * on cycle, typed error includes ordered concept ids forming the cycle.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ErrorObject } from "ajv";
import * as addFormatsNS from "ajv-formats";

type AddFormatsFn = (ajv: Ajv, options?: object) => Ajv;
const addFormats = (addFormatsNS as unknown as { default: AddFormatsFn }).default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "..", "schemas", "task-graph-v1.json");

let _validateFn: ((data: unknown) => boolean) | null = null;
let _ajvErrors: ErrorObject[] | null | undefined;

function getSchemaValidator() {
  if (_validateFn) return _validateFn;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as object;
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);
  const compiled = ajv.compile(schema);
  _validateFn = (data: unknown) => {
    const ok = compiled(data) as boolean;
    _ajvErrors = compiled.errors;
    return ok;
  };
  return _validateFn;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): GraphViolation[] {
  if (!errors?.length) {
    return [
      {
        obligation: OBLIGATIONS.SCHEMA_INVALID,
        detail: "pack failed JSON Schema validation",
      },
    ];
  }
  return errors.slice(0, 32).map((err) => ({
    obligation: OBLIGATIONS.SCHEMA_INVALID,
    detail: `${err.instancePath || "/"} ${err.message ?? "invalid"}`.trim(),
  }));
}

export * from "./dag_validate.js";
import {
  OBLIGATIONS,
  pushEvent,
  validateGraph,
  type GraphFailureClass,
  type GraphViolation,
  type TaskGraphPackV1,
  type ValidateGraphOptions,
  type ValidateGraphTelemetry,
  type ValidatePackResult,
} from "./dag_validate.js";


/**
 * Validate a task-graph pack object (already parsed JSON).
 * Schema first, then validateGraph() for DAG obligations.
 */
export function validateTaskGraphPack(
  raw: unknown,
  opts: ValidateGraphOptions = {},
): ValidatePackResult {
  const subjectId = opts.subjectId ?? "domain-loader-validate";
  const deviceId = opts.deviceId ?? "ci";
  const violations: GraphViolation[] = [];
  const events: ValidateGraphTelemetry[] = [];

  const validate = getSchemaValidator();
  if (!validate(raw)) {
    violations.push(...formatAjvErrors(_ajvErrors));
    pushEvent(events, opts, {
      event: "domain_loader.task_graph.validate",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "schema",
      failureClass: "schema_invalid",
      violationCount: violations.length,
    });
    return {
      status: 1,
      violations,
      events,
      combined: violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n"),
    };
  }

  const pack = raw as TaskGraphPackV1;

  const { advanceThreshold, remediateThreshold } = pack.thresholds;
  if (!(remediateThreshold < advanceThreshold)) {
    violations.push({
      obligation: OBLIGATIONS.THRESHOLD_ORDER,
      detail: `remediateThreshold (${remediateThreshold}) must be strictly less than advanceThreshold (${advanceThreshold})`,
    });
    pushEvent(events, opts, {
      event: "domain_loader.task_graph.validate",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "thresholds",
      failureClass: "threshold_order",
      violationCount: violations.length,
    });
    return {
      status: 1,
      violations,
      events,
      combined: violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n"),
    };
  }

  // DAG check without nested telemetry — pack emits one subject-scoped event.
  const dag = validateGraph(
    { concepts: pack.concepts, edges: pack.edges },
    { ...opts, emitEvents: false },
  );

  if (dag.status !== 0) {
    const failEvent: ValidateGraphTelemetry = {
      event: "domain_loader.task_graph.validate",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "dag",
      violationCount: dag.violations.length,
      conceptCount: pack.concepts.length,
      edgeCount: pack.edges.length,
    };
    if (dag.failureClass) failEvent.failureClass = dag.failureClass;
    if (dag.cyclePath) failEvent.cyclePathLength = dag.cyclePath.length;
    pushEvent(events, opts, failEvent);
    return {
      status: 1,
      violations: dag.violations,
      events,
      combined: dag.combined,
    };
  }

  pushEvent(events, opts, {
    event: "domain_loader.task_graph.validate",
    outcome: "ok",
    subjectId,
    deviceId,
    phase: "validate",
    packId: pack.packId,
    conceptCount: pack.concepts.length,
    edgeCount: pack.edges.length,
  });

  return {
    status: 0,
    violations: [],
    events,
    pack,
    combined: `OK: task-graph pack ${pack.packId}@${pack.version} (${pack.concepts.length} concepts, ${pack.edges.length} edges)`,
  };
}

export function loadTaskGraphSchema(): object {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as object;
}

export function schemaPath(): string {
  return SCHEMA_PATH;
}

export function fixturesRoot(): string {
  return path.join(__dirname, "..", "fixtures");
}

export function goldenPacksRoot(): string {
  return path.join(fixturesRoot(), "golden-packs");
}

export type GoldenPackExpect = {
  status: 0 | 1;
  failureClass?: GraphFailureClass;
  obligation?: string;
  cyclePathCloses?: boolean;
  minConcepts?: number;
  minEdges?: number;
};

export type GoldenPackCase = {
  id: string;
  file: string;
  kind: "accept" | "reject";
  expect: GoldenPackExpect;
};

export type GoldenPackManifest = {
  schemaVersion: string;
  description?: string;
  cases: GoldenPackCase[];
};

export type GoldenPackCaseResult = {
  id: string;
  ok: boolean;
  detail: string;
  packStatus: 0 | 1;
  dagFailureClass?: GraphFailureClass;
  cyclePath?: string[];
  events: ValidateGraphTelemetry[];
};

export function loadGoldenPackManifest(
  root = goldenPacksRoot(),
): GoldenPackManifest {
  const raw = JSON.parse(
    readFileSync(path.join(root, "manifest.json"), "utf8"),
  ) as GoldenPackManifest;
  if (!Array.isArray(raw.cases) || raw.cases.length < 3) {
    throw new Error("golden-packs manifest must list at least 3 cases");
  }
  return raw;
}

export function loadGoldenPackFile(
  file: string,
  root = goldenPacksRoot(),
): unknown {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

/**
 * Run one golden pack case: pack validate + DAG expectations from manifest.
 * Telemetry is subject-scoped and never includes concept titles.
 */
export function runGoldenPackCase(
  caseDef: GoldenPackCase,
  opts: ValidateGraphOptions & { root?: string } = {},
): GoldenPackCaseResult {
  const root = opts.root ?? goldenPacksRoot();
  const subjectId = opts.subjectId ?? `golden.${caseDef.id}`;
  const deviceId = opts.deviceId ?? "ci-golden";
  const events: ValidateGraphTelemetry[] = [];
  const packRaw = loadGoldenPackFile(caseDef.file, root);

  const packOpts: ValidateGraphOptions = {
    subjectId,
    deviceId,
    onTelemetry: (e) => {
      events.push(e);
      opts.onTelemetry?.(e);
    },
  };
  if (opts.emitEvents !== undefined) packOpts.emitEvents = opts.emitEvents;
  if (opts.scanLimit !== undefined) packOpts.scanLimit = opts.scanLimit;

  const packResult = validateTaskGraphPack(packRaw, packOpts);

  const expect = caseDef.expect;
  const mismatches: string[] = [];

  if (packResult.status !== expect.status) {
    mismatches.push(
      `status want ${expect.status} got ${packResult.status}: ${packResult.combined}`,
    );
  }

  let dagFailureClass: GraphFailureClass | undefined;
  let cyclePath: string[] | undefined;

  if (expect.status === 0 && packResult.pack) {
    if (
      expect.minConcepts !== undefined &&
      packResult.pack.concepts.length < expect.minConcepts
    ) {
      mismatches.push(
        `minConcepts want >= ${expect.minConcepts} got ${packResult.pack.concepts.length}`,
      );
    }
    if (
      expect.minEdges !== undefined &&
      packResult.pack.edges.length < expect.minEdges
    ) {
      mismatches.push(
        `minEdges want >= ${expect.minEdges} got ${packResult.pack.edges.length}`,
      );
    }
    const dag = validateGraph(
      {
        concepts: packResult.pack.concepts,
        edges: packResult.pack.edges,
      },
      { subjectId, deviceId, emitEvents: false },
    );
    if (dag.status !== 0 || !dag.topologicalOrder) {
      mismatches.push(`accept case failed DAG topo: ${dag.combined}`);
    }
  } else if (expect.status === 1) {
    if (
      expect.obligation &&
      !packResult.violations.some((v) => v.obligation === expect.obligation)
    ) {
      mismatches.push(
        `missing obligation ${expect.obligation}; got ${packResult.violations
          .map((v) => v.obligation)
          .join(",")}`,
      );
    }
    const failEvt = events.find((e) => e.outcome === "fail");
    dagFailureClass = failEvt?.failureClass;
    if (expect.failureClass && failEvt?.failureClass !== expect.failureClass) {
      mismatches.push(
        `failureClass want ${expect.failureClass} got ${failEvt?.failureClass ?? "none"}`,
      );
    }
    const withPath = packResult.violations.find((v) => v.cyclePath);
    cyclePath = withPath?.cyclePath;
    if (expect.cyclePathCloses) {
      if (!cyclePath || cyclePath.length < 2) {
        mismatches.push("expected cyclePath");
      } else if (cyclePath[0] !== cyclePath[cyclePath.length - 1]) {
        mismatches.push(
          `cyclePath must close: ${cyclePath.join(" -> ")}`,
        );
      }
    }
  }

  const ok = mismatches.length === 0;
  const result: GoldenPackCaseResult = {
    id: caseDef.id,
    ok,
    detail: ok
      ? `OK golden ${caseDef.id}`
      : mismatches.join("; "),
    packStatus: packResult.status,
    events,
  };
  if (dagFailureClass) result.dagFailureClass = dagFailureClass;
  if (cyclePath) result.cyclePath = cyclePath;
  return result;
}

/**
 * Run the full golden-packs corpus. Bounded to manifest cases only (NFR).
 */
export function runGoldenPackSuite(
  opts: ValidateGraphOptions & { root?: string } = {},
): { status: 0 | 1; results: GoldenPackCaseResult[]; combined: string } {
  const root = opts.root ?? goldenPacksRoot();
  const manifest = loadGoldenPackManifest(root);
  const results = manifest.cases.map((c) =>
    runGoldenPackCase(c, { ...opts, root }),
  );
  const failed = results.filter((r) => !r.ok);
  return {
    status: failed.length === 0 ? 0 : 1,
    results,
    combined:
      failed.length === 0
        ? `OK: ${results.length} golden pack cases`
        : failed.map((f) => `[${f.id}] ${f.detail}`).join("\n"),
  };
}

/** Map pack edges → ConceptNode.prerequisites tuples (router shape). */
export function prerequisitesByConcept(
  pack: TaskGraphPackV1,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of pack.concepts) map.set(c.conceptId, []);
  for (const e of pack.edges) {
    const list = map.get(e.fromConceptId);
    if (list) list.push(e.toConceptId);
  }
  return map;
}

