/**
 * Load task-graph packs from filesystem paths into router-shaped graphs.
 *
 * Packs are path-only — this module never imports the domains tree.
 * Thresholds come from the pack (or DEFAULT_* when missing); never silent zeros.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  OBLIGATIONS,
  type TaskGraphPackV1,
  type TaskGraphThresholdsV1,
  validateTaskGraphPack,
} from "./validate_graph.js";

export * from "./hydrate_pack.js";
import {
  type LoadFromObjectOptions,
  type LoadTaskGraphOptions,
  type LoadTaskGraphTelemetry,
  mapPackToLoadedGraph,
  pushLoadEvent,
  resolveThresholds,
  TaskGraphLoadError,
  type LoadedTaskGraph,
} from "./hydrate_pack.js";

export function loadTaskGraph(
  filePath: string,
  opts: LoadTaskGraphOptions = {},
): LoadedTaskGraph {
  const subjectId = opts.subjectId ?? "domain-loader-load";
  const deviceId = opts.deviceId ?? "ci";
  const events: LoadTaskGraphTelemetry[] = [];
  const abs = path.resolve(filePath);

  let rawText: string;
  let mtimeMs = 0;
  try {
    rawText = readFileSync(abs, "utf8");
    mtimeMs = statSync(abs).mtimeMs;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    pushLoadEvent(opts, events, {
      event: "domain_loader.task_graph.load",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "read",
      failureClass: "io_error",
      sourcePath: abs,
    });
    throw new TaskGraphLoadError(`failed to read task-graph pack: ${detail}`, {
      obligation: "domain_loader.task_graph.io_error",
      failureClass: "io_error",
      subjectId,
      deviceId,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    pushLoadEvent(opts, events, {
      event: "domain_loader.task_graph.load",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "parse",
      failureClass: "schema_invalid",
      sourcePath: abs,
    });
    throw new TaskGraphLoadError(`invalid JSON in task-graph pack: ${detail}`, {
      obligation: OBLIGATIONS.SCHEMA_INVALID,
      failureClass: "schema_invalid",
      subjectId,
      deviceId,
    });
  }

  return loadTaskGraphFromObject(parsed, {
    ...opts,
    subjectId,
    deviceId,
    sourcePath: abs,
    sourceMtimeMs: mtimeMs,
  });
}

/**
 * Load from an already-parsed object (Postgres row / hot-reload buffer).
 * Applies threshold fallbacks when the row omits thresholds.
 */
export function loadTaskGraphFromObject(
  raw: unknown,
  opts: LoadFromObjectOptions = {},
): LoadedTaskGraph {
  const subjectId = opts.subjectId ?? "domain-loader-load";
  const deviceId = opts.deviceId ?? "ci";
  const sourcePath = opts.sourcePath ?? "<memory>";
  const sourceMtimeMs = opts.sourceMtimeMs ?? 0;
  const events: LoadTaskGraphTelemetry[] = [];

  // Patch missing thresholds before schema validate (Postgres partial row).
  let candidate = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = { ...(raw as Record<string, unknown>) };
    const thr = obj.thresholds;
    if (thr == null || typeof thr !== "object" || Array.isArray(thr)) {
      obj.thresholds = resolveThresholds(null);
    } else {
      obj.thresholds = resolveThresholds(thr as Partial<TaskGraphThresholdsV1>);
    }
    candidate = obj;
  }

  if (opts.validate !== false) {
    const validateOpts: {
      subjectId: string;
      deviceId: string;
      emitEvents: false;
      scanLimit?: number;
    } = {
      subjectId,
      deviceId,
      emitEvents: false,
    };
    if (opts.scanLimit !== undefined) validateOpts.scanLimit = opts.scanLimit;
    const result = validateTaskGraphPack(candidate, validateOpts);
    if (result.status !== 0 || !result.pack) {
      const first = result.violations[0];
      pushLoadEvent(opts, events, {
        event: "domain_loader.task_graph.load",
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "validate",
        failureClass: first?.obligation.includes("cycle")
          ? "cycle"
          : first?.obligation.includes("self_loop")
            ? "self_loop"
            : first?.obligation.includes("missing")
              ? "missing_edge_endpoint"
              : "schema_invalid",
        sourcePath,
      });
      const errInit: {
        obligation: string;
        failureClass?: string;
        cyclePath?: string[];
        subjectId: string;
        deviceId: string;
      } = {
        obligation: first?.obligation ?? OBLIGATIONS.SCHEMA_INVALID,
        subjectId,
        deviceId,
      };
      if (first?.cyclePath) errInit.cyclePath = first.cyclePath;
      throw new TaskGraphLoadError(result.combined, errInit);
    }
    const loaded = mapPackToLoadedGraph(result.pack, sourcePath, sourceMtimeMs);
    pushLoadEvent(opts, events, {
      event: "domain_loader.task_graph.load",
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "load",
      packId: loaded.packId,
      versionStamp: loaded.versionStamp,
      conceptCount: loaded.concepts.length,
      edgeCount: result.pack.edges.length,
      sourcePath,
    });
    return loaded;
  }

  const pack = candidate as TaskGraphPackV1;
  const loaded = mapPackToLoadedGraph(pack, sourcePath, sourceMtimeMs);
  pushLoadEvent(opts, events, {
    event: "domain_loader.task_graph.load",
    outcome: "ok",
    subjectId,
    deviceId,
    phase: "load",
    packId: loaded.packId,
    versionStamp: loaded.versionStamp,
    conceptCount: loaded.concepts.length,
    sourcePath,
  });
  return loaded;
}
