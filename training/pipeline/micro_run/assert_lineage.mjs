/**
 * Assert micro-run committed lineage row is complete (critics, hypers, subject scope).
 *
 * Usage (library):
 *   import { assertMicroRunLineageComplete } from "./assert_lineage.mjs";
 */

import path from "node:path";
import {
  lintCheckpointLineageCompleteness,
  openCheckpointLineageRegistry,
} from "../../../packages/learning/dist/index.js";
import { MicroRunOrchestratorError } from "./orchestrate.mjs";

/**
 * Re-open the fs lineage store from a micro-run outDir and require a complete
 * GRPO lineage row for the candidate's subjectId / lineageRunId.
 *
 * @param {{
 *   outDir: string,
 *   subjectId: string,
 *   deviceId: string,
 *   lineageRunId: string,
 *   checkpointHash?: string,
 *   onTelemetry?: (e: Record<string, unknown>) => void,
 * }} input
 */
export function assertMicroRunLineageComplete(input) {
  const {
    outDir,
    subjectId,
    deviceId,
    lineageRunId,
    checkpointHash,
    onTelemetry,
  } = input;

  const lineageDir = path.join(outDir, "lineage");
  const registry = openCheckpointLineageRegistry({
    backend: "fs",
    rootDir: lineageDir,
    ...(onTelemetry !== undefined
      ? { onTelemetry: (e) => onTelemetry({ ...e, orchStage: "lineage" }) }
      : {}),
  });

  const read = registry.getByRunId({
    subjectId,
    runId: lineageRunId,
    deviceId,
    ...(onTelemetry !== undefined
      ? { onTelemetry: (e) => onTelemetry({ ...e, orchStage: "lineage" }) }
      : {}),
  });

  if (read.kind !== "found") {
    throw new MicroRunOrchestratorError(
      `lineage assertion: expected committed row for runId=${lineageRunId}, got ${read.kind}`,
      {
        stage: "lineage",
        obligation: "micro_run.lineage_assert",
        subjectId,
        deviceId,
        failingSlice: lineageRunId,
        ...(checkpointHash !== undefined ? { checkpointHash } : {}),
        diff: JSON.stringify({ kind: read.kind, lineageRunId, lineageDir }),
      },
    );
  }

  if (read.row.subjectId !== subjectId) {
    throw new MicroRunOrchestratorError(
      "lineage assertion: subjectId scope mismatch",
      {
        stage: "lineage",
        obligation: "micro_run.subject_scope",
        subjectId,
        deviceId,
        failingSlice: lineageRunId,
        ...(checkpointHash !== undefined ? { checkpointHash } : {}),
        diff: `expected=${subjectId} actual=${read.row.subjectId}`,
      },
    );
  }

  const lint = lintCheckpointLineageCompleteness(read.row, {
    subjectId,
    deviceId,
    ...(onTelemetry !== undefined
      ? { onTelemetry: (e) => onTelemetry({ ...e, orchStage: "lineage" }) }
      : {}),
  });

  if (!lint.ok || lint.complete !== true) {
    throw new MicroRunOrchestratorError(
      `lineage assertion incomplete: ${lint.ok ? "complete≠true" : lint.detail}`,
      {
        stage: "lineage",
        obligation: "micro_run.lineage_incomplete",
        subjectId,
        deviceId,
        failingSlice: lineageRunId,
        checkpointHash: read.row.checkpointHash,
        parentCheckpointHash: read.row.parentCheckpointHash,
        diff: JSON.stringify({
          failureClass: lint.ok ? "lineage.incomplete" : lint.failureClass,
          complete: lint.complete ?? false,
          criticCount: read.row.criticVersions.length,
          hyperKeys: Object.keys(read.row.hyperparameters),
        }),
      },
    );
  }

  onTelemetry?.({
    event: "training.micro_run.lineage_assert",
    outcome: "ok",
    subjectId,
    deviceId,
    stage: "lineage",
    runId: lineageRunId,
    checkpointHash: read.row.checkpointHash,
    complete: true,
  });

  return {
    ok: true,
    complete: true,
    row: read.row,
    revision: registry.revision(subjectId),
  };
}
