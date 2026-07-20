/**
 * Episode-terminal snapshot teardown — discard unless trajectory export consent passes.
 */

import { evaluateTrajectoryConsent } from "../consent_gate.js";
import type {
  CognitiveRolloutSnapshot,
  DiscardSnapshotInput,
  DiscardSnapshotResult,
  SnapshotBackendId,
  SnapshotExportConsent,
  SnapshotTelemetry,
  TeardownAtTerminalInput,
  TeardownAtTerminalResult,
} from "./types.js";

function emit(
  onTelemetry: ((e: SnapshotTelemetry) => void) | undefined,
  e: Omit<SnapshotTelemetry, "event">,
): void {
  onTelemetry?.({ event: "learning.snapshot_store", ...e });
}

/** True when B9/C0 export consent would allow retaining the snapshot. */
export function snapshotExportConsentPasses(
  subjectId: string,
  consent: SnapshotExportConsent | null | undefined,
  deviceId?: string,
): boolean {
  const gate = evaluateTrajectoryConsent({
    subjectId,
    consent: consent ?? null,
    ...(deviceId !== undefined ? { deviceId } : {}),
  });
  return gate.ok;
}

export type DiscardSlotFn = (input: DiscardSnapshotInput) => DiscardSnapshotResult;
export type GetSlotFn = (input: {
  subjectId: string;
  deviceId: string;
  episodeId: string;
  onTelemetry?: (e: SnapshotTelemetry) => void;
}) =>
  | { ok: true; snapshot: CognitiveRolloutSnapshot }
  | { ok: false; failureClass: string; detail: string; subjectId: string; deviceId: string };

/**
 * Shared terminal teardown: retain when consent passes, else discard (idempotent).
 */
export function runTeardownAtTerminal(input: {
  backendId: SnapshotBackendId;
  subjectId: string;
  deviceId: string;
  episodeId: string;
  consent?: SnapshotExportConsent | null;
  onTelemetry?: (e: SnapshotTelemetry) => void;
  discard: DiscardSlotFn;
  get: GetSlotFn;
  rolloutId?: string;
}): TeardownAtTerminalResult {
  const subjectId = input.subjectId.trim();
  const deviceId = input.deviceId.trim();
  const episodeId = input.episodeId.trim();

  if (!subjectId) {
    emit(input.onTelemetry, {
      op: "teardown",
      outcome: "error",
      subjectId: null,
      deviceId,
      failureClass: "missing_subject",
      detail: "subjectId required for snapshot teardown",
      backend: input.backendId,
      ...(input.rolloutId !== undefined ? { rolloutId: input.rolloutId } : {}),
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      detail: "subjectId required for snapshot teardown",
      subjectId: "",
      deviceId,
    };
  }
  if (!episodeId) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "episodeId required for snapshot teardown",
      subjectId,
      deviceId,
    };
  }

  if (snapshotExportConsentPasses(subjectId, input.consent, deviceId)) {
    const got = input.get({
      subjectId,
      deviceId,
      episodeId,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
    if (!got.ok) {
      const failureClass =
        got.failureClass === "missing_subject" ||
        got.failureClass === "cross_subject" ||
        got.failureClass === "cross_rollout" ||
        got.failureClass === "not_found" ||
        got.failureClass === "schema_violation"
          ? got.failureClass
          : "not_found";
      emit(input.onTelemetry, {
        op: "teardown",
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        failureClass,
        detail: got.detail,
        backend: input.backendId,
        ...(input.rolloutId !== undefined ? { rolloutId: input.rolloutId } : {}),
      });
      return {
        ok: false,
        failureClass,
        detail: got.detail,
        subjectId,
        deviceId,
      };
    }
    emit(input.onTelemetry, {
      op: "teardown",
      outcome: "ok",
      subjectId,
      deviceId,
      episodeId,
      backend: input.backendId,
      retained: true,
      detail: "snapshot retained — trajectory export consent passed",
      ...(input.rolloutId !== undefined ? { rolloutId: input.rolloutId } : {}),
    });
    return {
      ok: true,
      discarded: false,
      retained: true,
      snapshot: got.snapshot,
      backend: input.backendId,
    };
  }

  const dropped = input.discard({
    subjectId,
    deviceId,
    episodeId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!dropped.ok) {
    emit(input.onTelemetry, {
      op: "teardown",
      outcome: "error",
      subjectId,
      deviceId,
      episodeId,
      failureClass: dropped.failureClass,
      detail: dropped.detail,
      backend: input.backendId,
      ...(input.rolloutId !== undefined ? { rolloutId: input.rolloutId } : {}),
    });
    return dropped;
  }

  emit(input.onTelemetry, {
    op: "teardown",
    outcome: "ok",
    subjectId,
    deviceId,
    episodeId,
    backend: input.backendId,
    retained: false,
    detail: dropped.alreadyDiscarded
      ? "idempotent discard — slot already gone"
      : "snapshot discarded — export consent did not pass",
    ...(input.rolloutId !== undefined ? { rolloutId: input.rolloutId } : {}),
  });

  return {
    ok: true,
    discarded: true,
    retained: false,
    alreadyDiscarded: dropped.alreadyDiscarded,
    backend: input.backendId,
  };
}

export type { TeardownAtTerminalInput, TeardownAtTerminalResult };
