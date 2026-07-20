/**
 * Telemetry trajectory format facade — edge-facing parse / consent / async write.
 *
 * Wire schema lives in `@moolam/sync-protocol`. This module re-exports the
 * contract and adds metadata-only observability helpers for hosts.
 */

export {
  TRAJECTORY_FORBIDDEN_CONTENT_KEYS,
  TRAJECTORY_FORMAT_VERSION,
  TRAJECTORY_HASH_LIMIT,
  TRAJECTORY_ID_LIMIT,
  TRAJECTORY_LOCALITIES,
  TRAJECTORY_MODEL_ID_LIMIT,
  TRAJECTORY_OUTCOME_STATUSES,
  TRAJECTORY_STAGE_LIMIT,
  TRAJECTORY_STAGE_NAMES,
  TRAJECTORY_STAGE_STATUSES,
  TRAJECTORY_TOOL_CALL_LIMIT,
  TRAJECTORY_TOOL_CALL_STATUSES,
  TURN_TRAJECTORY_V1_COMMITTED_SCHEMA_RELPATH,
  TURN_TRAJECTORY_V1_GOLDEN_FIXTURES_RELPATH,
  TURN_TRAJECTORY_V1_GOLDEN_MANIFEST,
  assertTrajectorySchemaPrivacy,
  assertTurnTrajectoryExportConsent,
  enqueueTurnTrajectoryWrite,
  parseTurnTrajectoryV1,
  toTurnTrajectoryJsonSchema,
  trajectoryOutcomesSchema,
  trajectoryStageRecordSchema,
  trajectoryToolCallRecordSchema,
  turnTrajectoryV1Schema,
  type ParseTurnTrajectoryV1Result,
  type TrajectoryFailureClass,
  type TrajectoryFormatStageRecord,
  type TrajectoryOutcomes,
  type TrajectoryStageName,
  type TrajectoryStageStatus,
  type TrajectoryToolCallRecord,
  type TrajectoryToolCallStatus,
  type TrajectoryWriteTelemetryEvent,
  type TurnTrajectoryV1,
} from "@moolam/sync-protocol";

import {
  PROTOCOL_VERSION,
  TURN_TRAJECTORY_V1_GOLDEN_FIXTURES_RELPATH,
  TURN_TRAJECTORY_V1_GOLDEN_MANIFEST,
  assertTrajectorySchemaPrivacy,
  toTurnTrajectoryJsonSchema,
  type TurnTrajectoryV1,
} from "@moolam/sync-protocol";

/**
 * Emit a metadata-only trajectory observability event (never raw content).
 */
export function emitTrajectoryObservability(event: {
  event: string;
  outcome: "ok" | "error" | "rejected";
  subjectId: string;
  deviceId?: string;
  failureClass?: string;
  stageCount?: number;
  toolCallCount?: number;
}): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Build the JSON Schema and run the privacy key assertion in one step.
 * Fails closed if a forbidden content key appears in the schema properties.
 */
export function trajectoryFormatJsonSchemaWithPrivacyGate(): {
  schema: Record<string, unknown>;
  privacy: ReturnType<typeof assertTrajectorySchemaPrivacy>;
} {
  const schema = toTurnTrajectoryJsonSchema(PROTOCOL_VERSION);
  return { schema, privacy: assertTrajectorySchemaPrivacy(schema) };
}

/** Type guard for hosts validating trajectories before export. */
export function isTurnTrajectoryV1(value: unknown): value is TurnTrajectoryV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { trajectoryFormatVersion?: unknown }).trajectoryFormatVersion ===
      "trajectory.v1"
  );
}

/**
 * Package-relative golden fixture root for capture-format round-trips.
 * Covered by `tests/trajectory_format_fixtures.test.mjs`.
 */
export const TRAJECTORY_FORMAT_GOLDEN_FIXTURES_RELPATH =
  TURN_TRAJECTORY_V1_GOLDEN_FIXTURES_RELPATH;
export const TRAJECTORY_FORMAT_GOLDEN_MANIFEST =
  TURN_TRAJECTORY_V1_GOLDEN_MANIFEST;
