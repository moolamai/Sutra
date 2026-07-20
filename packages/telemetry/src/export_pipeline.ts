/**
 * Training-export v1 contract.
 *
 * JSONL rows carry SFT input/output references as hashes and bounded metadata.
 * They never carry prompt, reply, keystroke, or tool bodies. This module
 * defines and validates the seam and exposes an explicit operator CLI. It
 * never uploads datasets or runs a trainer.
 */

import {
  TRAJECTORY_FORBIDDEN_CONTENT_KEYS,
  TRAJECTORY_FORMAT_VERSION,
  TRAJECTORY_HASH_LIMIT,
  TRAJECTORY_ID_LIMIT,
  TRAJECTORY_MODEL_ID_LIMIT,
  TRAJECTORY_STAGE_LIMIT,
  TRAJECTORY_TOOL_CALL_LIMIT,
  parseTurnTrajectoryV1,
  type TrajectoryFormatStageRecord,
  type TrajectoryOutcomes,
  type TrajectoryToolCallRecord,
  type TurnTrajectoryV1,
} from "@moolam/sync-protocol";

export const TRAINING_EXPORT_VERSION = "training-export.v1" as const;
export const TRAINING_EXPORT_KIND = "sft" as const;
export const TRAINING_EXPORT_CONSENT_SCOPE = "training-export" as const;
export const TRAINING_EXPORT_SCHEMA_RELPATH =
  "schemas/training-export-v1.json" as const;

const VALIDATION_NODE_LIMIT = 512;
const VALIDATION_DEPTH_LIMIT = 8;
const DATASET_URI_LIMIT = 2_048;
const ADAPTER_TYPE_LIMIT = 64;
export const TRAINING_EXPORT_DEFAULT_LIMIT = 1_024;
export const TRAINING_EXPORT_MAX_LIMIT = 4_096;
export const TRAINING_EXPORT_DEFAULT_TIMEOUT_MS = 30_000;

export type TrainingExportConsent = {
  consentRecordId: string;
  subjectId: string;
  scope: typeof TRAINING_EXPORT_CONSENT_SCOPE;
  optedIn: boolean;
  active: boolean;
};

export type TrainingExportContentRef = {
  contentHash: string;
  byteLength?: number | undefined;
};

/** One newline-delimited SFT row. Raw training content is never embedded. */
export type TrainingExportLineV1 = {
  trainingExportVersion: typeof TRAINING_EXPORT_VERSION;
  kind: typeof TRAINING_EXPORT_KIND;
  subjectId: string;
  deviceId: string;
  turnId: string;
  sessionId?: string | undefined;
  capturedAt: TurnTrajectoryV1["capturedAt"];
  locality: TurnTrajectoryV1["locality"];
  sourceConsentRecordId: string;
  exportConsentRecordId: string;
  exportConsentScope: typeof TRAINING_EXPORT_CONSENT_SCOPE;
  modelId: string;
  input: TrainingExportContentRef;
  output: TrainingExportContentRef;
  stages: TrajectoryFormatStageRecord[];
  toolCalls: TrajectoryToolCallRecord[];
  outcomes: TrajectoryOutcomes;
};

/**
 * External job handoff descriptor. Interface only: no lifecycle or trainer.
 */
export interface FinetuneJob {
  jobId: string;
  adapterType: string;
  baseModelId: string;
  datasetUri: string;
}

export type TrainingExportFailureClass =
  | "validation"
  | "limit"
  | "raw_content_forbidden"
  | "consent_missing"
  | "consent_denied"
  | "consent_scope_invalid"
  | "cross_subject"
  | "no_exportable_trajectories"
  | "read_failed"
  | "write_failed"
  | "timeout";

export type TrainingExportContractEvent = {
  event: "telemetry.training_export.contract";
  operation: "line" | "job";
  outcome: "accepted" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  failureClass?: TrainingExportFailureClass;
};

export type TrainingExportAccepted<T> = {
  ok: true;
  value: T;
  subjectId: string | null;
};

export type TrainingExportRejected = {
  ok: false;
  failureClass: TrainingExportFailureClass;
  subjectId: string | null;
  detail: string;
  issuePath?: string;
};

export type TrainingExportResult<T> =
  | TrainingExportAccepted<T>
  | TrainingExportRejected;

export type TrainingExportContractOptions = {
  onTelemetry?: (event: TrainingExportContractEvent) => void;
};

export const TRAINING_EXPORT_SCHEMA_OBLIGATION =
  "TRAINING_EXPORT.SCHEMA_V1" as const;

export class TrainingExportContractError extends Error {
  override readonly name: string = "TrainingExportContractError";
  readonly obligationId = TRAINING_EXPORT_SCHEMA_OBLIGATION;

  constructor(
    readonly failureClass: TrainingExportFailureClass,
    readonly issuePath: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export class NoExportableTrajectoriesError extends TrainingExportContractError {
  override readonly name = "NoExportableTrajectoriesError";

  constructor(subjectId: string) {
    super(
      "no_exportable_trajectories",
      undefined,
      `no consented trajectories exportable for subject '${subjectId}'`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RAW_EXPORT_KEYS = new Set<string>([
  ...TRAJECTORY_FORBIDDEN_CONTENT_KEYS,
  "content",
  "messages",
]);

function inspectRawContent(
  value: unknown,
  depth = 0,
  state: { nodes: number } = { nodes: 0 },
): { key?: string; limit?: true } {
  state.nodes += 1;
  if (state.nodes > VALIDATION_NODE_LIMIT || depth > VALIDATION_DEPTH_LIMIT) {
    return { limit: true };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = inspectRawContent(item, depth + 1, state);
      if (result.key !== undefined || result.limit) return result;
    }
    return {};
  }
  if (!isPlainObject(value)) return {};
  for (const [key, child] of Object.entries(value)) {
    if (RAW_EXPORT_KEYS.has(key)) return { key };
    const result = inspectRawContent(child, depth + 1, state);
    if (result.key !== undefined || result.limit) return result;
  }
  return {};
}

function boundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength
  );
}

function contentRef(
  value: unknown,
  path: string,
): TrainingExportResult<TrainingExportContentRef> {
  if (!isPlainObject(value)) {
    return reject("validation", null, `${path} must be an object`, path);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "contentHash" && key !== "byteLength")) {
    return reject("validation", null, `${path} contains unknown fields`, path);
  }
  if (!boundedString(value.contentHash, TRAJECTORY_HASH_LIMIT)) {
    return reject(
      "validation",
      null,
      `${path}.contentHash is required`,
      `${path}.contentHash`,
    );
  }
  if (
    value.byteLength !== undefined &&
    (!Number.isSafeInteger(value.byteLength) ||
      (value.byteLength as number) < 0)
  ) {
    return reject(
      "validation",
      null,
      `${path}.byteLength must be a non-negative integer`,
      `${path}.byteLength`,
    );
  }
  return {
    ok: true,
    subjectId: null,
    value: {
      contentHash: value.contentHash,
      ...(value.byteLength === undefined
        ? {}
        : { byteLength: value.byteLength as number }),
    },
  };
}

const LINE_KEYS = new Set([
  "trainingExportVersion",
  "kind",
  "subjectId",
  "deviceId",
  "turnId",
  "sessionId",
  "capturedAt",
  "locality",
  "sourceConsentRecordId",
  "exportConsentRecordId",
  "exportConsentScope",
  "modelId",
  "input",
  "output",
  "stages",
  "toolCalls",
  "outcomes",
]);

/**
 * Parse one untrusted JSONL value and enforce the trajectory privacy contract.
 */
export function parseTrainingExportLineV1(
  input: unknown,
  options: TrainingExportContractOptions = {},
): TrainingExportResult<TrainingExportLineV1> {
  const inspected = inspectRawContent(input);
  if (inspected.key !== undefined) {
    return emitRejected(
      reject(
        "raw_content_forbidden",
        subjectIdFrom(input),
        `raw content key '${inspected.key}' is forbidden`,
        inspected.key,
      ),
      "line",
      options,
      deviceIdFrom(input),
    );
  }
  if (inspected.limit) {
    return emitRejected(
      reject("limit", subjectIdFrom(input), "validation scan limit exceeded"),
      "line",
      options,
      deviceIdFrom(input),
    );
  }
  if (!isPlainObject(input)) {
    return emitRejected(
      reject("validation", null, "training export line must be an object"),
      "line",
      options,
    );
  }
  const subjectId = subjectIdFrom(input);
  const deviceId = deviceIdFrom(input);
  if (Object.keys(input).some((key) => !LINE_KEYS.has(key))) {
    return emitRejected(
      reject("validation", subjectId, "training export line contains unknown fields"),
      "line",
      options,
      deviceId,
    );
  }
  if (
    input.trainingExportVersion !== TRAINING_EXPORT_VERSION ||
    input.kind !== TRAINING_EXPORT_KIND
  ) {
    return emitRejected(
      reject("validation", subjectId, "training export version/kind invalid"),
      "line",
      options,
      deviceId,
    );
  }
  if (
    !boundedString(input.exportConsentRecordId, TRAJECTORY_ID_LIMIT) ||
    input.exportConsentScope !== TRAINING_EXPORT_CONSENT_SCOPE
  ) {
    return emitRejected(
      reject(
        input.exportConsentScope === undefined
          ? "consent_missing"
          : "consent_scope_invalid",
        subjectId,
        "active training-export consent reference is required",
        "exportConsentScope",
      ),
      "line",
      options,
      deviceId,
    );
  }

  const parsedInput = contentRef(input.input, "input");
  if (!parsedInput.ok) {
    return emitRejected(
      { ...parsedInput, subjectId },
      "line",
      options,
      deviceId,
    );
  }
  const parsedOutput = contentRef(input.output, "output");
  if (!parsedOutput.ok) {
    return emitRejected(
      { ...parsedOutput, subjectId },
      "line",
      options,
      deviceId,
    );
  }

  const trajectory = parseTurnTrajectoryV1({
    trajectoryFormatVersion: TRAJECTORY_FORMAT_VERSION,
    turnId: input.turnId,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    capturedAt: input.capturedAt,
    locality: input.locality,
    consentRecordId: input.sourceConsentRecordId,
    stages: input.stages,
    toolCalls: input.toolCalls,
    outcomes: input.outcomes,
    modelId: input.modelId,
    promptHash: parsedInput.value.contentHash,
    responseHash: parsedOutput.value.contentHash,
    ...(parsedInput.value.byteLength === undefined
      ? {}
      : { promptByteLength: parsedInput.value.byteLength }),
    ...(parsedOutput.value.byteLength === undefined
      ? {}
      : { responseByteLength: parsedOutput.value.byteLength }),
  });
  if (!trajectory.ok) {
    return emitRejected(
      reject(
        trajectory.failureClass === "keystroke_forbidden"
          ? "raw_content_forbidden"
          : trajectory.failureClass === "stage_limit" ||
              trajectory.failureClass === "tool_call_limit"
            ? "limit"
            : "validation",
        trajectory.subjectId,
        trajectory.detail,
        trajectory.issuePath,
      ),
      "line",
      options,
      deviceId,
    );
  }

  const value: TrainingExportLineV1 = {
    trainingExportVersion: TRAINING_EXPORT_VERSION,
    kind: TRAINING_EXPORT_KIND,
    subjectId: trajectory.record.subjectId,
    deviceId: trajectory.record.deviceId,
    turnId: trajectory.record.turnId,
    ...(trajectory.record.sessionId === undefined
      ? {}
      : { sessionId: trajectory.record.sessionId }),
    capturedAt: trajectory.record.capturedAt,
    locality: trajectory.record.locality,
    sourceConsentRecordId: trajectory.record.consentRecordId,
    exportConsentRecordId: input.exportConsentRecordId,
    exportConsentScope: TRAINING_EXPORT_CONSENT_SCOPE,
    modelId: trajectory.record.modelId,
    input: parsedInput.value,
    output: parsedOutput.value,
    stages: trajectory.record.stages,
    toolCalls: trajectory.record.toolCalls,
    outcomes: trajectory.record.outcomes,
  };
  emit(options, {
    event: "telemetry.training_export.contract",
    operation: "line",
    outcome: "accepted",
    subjectId: value.subjectId,
    deviceId: value.deviceId,
  });
  return { ok: true, value, subjectId: value.subjectId };
}

/**
 * Build a deterministic JSONL row only after active, subject-matched export
 * consent has been established. No I/O occurs.
 */
export function createTrainingExportLineV1(
  recordInput: unknown,
  consent: TrainingExportConsent | null | undefined,
  options: TrainingExportContractOptions = {},
): TrainingExportResult<TrainingExportLineV1> {
  const trajectory = parseTurnTrajectoryV1(recordInput);
  if (!trajectory.ok) {
    return emitRejected(
      reject(
        trajectory.failureClass === "keystroke_forbidden"
          ? "raw_content_forbidden"
          : trajectory.failureClass === "stage_limit" ||
              trajectory.failureClass === "tool_call_limit"
            ? "limit"
            : "validation",
        trajectory.subjectId,
        trajectory.detail,
        trajectory.issuePath,
      ),
      "line",
      options,
    );
  }
  if (!consent) {
    return emitRejected(
      reject(
        "consent_missing",
        trajectory.record.subjectId,
        "training-export consent is required",
      ),
      "line",
      options,
      trajectory.record.deviceId,
    );
  }
  if (consent.subjectId !== trajectory.record.subjectId) {
    return emitRejected(
      reject(
        "cross_subject",
        trajectory.record.subjectId,
        "export consent subject must match trajectory subject",
      ),
      "line",
      options,
      trajectory.record.deviceId,
    );
  }
  if (consent.scope !== TRAINING_EXPORT_CONSENT_SCOPE) {
    return emitRejected(
      reject(
        "consent_scope_invalid",
        trajectory.record.subjectId,
        "training-export consent scope is required",
      ),
      "line",
      options,
      trajectory.record.deviceId,
    );
  }
  if (!consent.active || !consent.optedIn) {
    return emitRejected(
      reject(
        "consent_denied",
        trajectory.record.subjectId,
        "active opted-in training-export consent is required",
      ),
      "line",
      options,
      trajectory.record.deviceId,
    );
  }
  return parseTrainingExportLineV1(
    {
      trainingExportVersion: TRAINING_EXPORT_VERSION,
      kind: TRAINING_EXPORT_KIND,
      subjectId: trajectory.record.subjectId,
      deviceId: trajectory.record.deviceId,
      turnId: trajectory.record.turnId,
      ...(trajectory.record.sessionId === undefined
        ? {}
        : { sessionId: trajectory.record.sessionId }),
      capturedAt: trajectory.record.capturedAt,
      locality: trajectory.record.locality,
      sourceConsentRecordId: trajectory.record.consentRecordId,
      exportConsentRecordId: consent.consentRecordId,
      exportConsentScope: TRAINING_EXPORT_CONSENT_SCOPE,
      modelId: trajectory.record.modelId,
      input: {
        contentHash: trajectory.record.promptHash,
        ...(trajectory.record.promptByteLength === undefined
          ? {}
          : { byteLength: trajectory.record.promptByteLength }),
      },
      output: {
        contentHash: trajectory.record.responseHash,
        ...(trajectory.record.responseByteLength === undefined
          ? {}
          : { byteLength: trajectory.record.responseByteLength }),
      },
      stages: trajectory.record.stages,
      toolCalls: trajectory.record.toolCalls,
      outcomes: trajectory.record.outcomes,
    },
    options,
  );
}

/** Validate an external handoff descriptor; does not submit a job. */
export function parseFinetuneJob(
  input: unknown,
  options: TrainingExportContractOptions = {},
): TrainingExportResult<FinetuneJob> {
  if (!isPlainObject(input)) {
    return emitRejected(
      reject("validation", null, "FinetuneJob must be an object"),
      "job",
      options,
    );
  }
  const allowed = new Set([
    "jobId",
    "adapterType",
    "baseModelId",
    "datasetUri",
  ]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    !boundedString(input.jobId, TRAJECTORY_ID_LIMIT) ||
    !boundedString(input.adapterType, ADAPTER_TYPE_LIMIT) ||
    !boundedString(input.baseModelId, TRAJECTORY_MODEL_ID_LIMIT) ||
    !boundedString(input.datasetUri, DATASET_URI_LIMIT)
  ) {
    return emitRejected(
      reject("validation", null, "FinetuneJob fields are invalid"),
      "job",
      options,
    );
  }
  const value: FinetuneJob = {
    jobId: input.jobId,
    adapterType: input.adapterType,
    baseModelId: input.baseModelId,
    datasetUri: input.datasetUri,
  };
  emit(options, {
    event: "telemetry.training_export.contract",
    operation: "job",
    outcome: "accepted",
    subjectId: null,
  });
  return { ok: true, value, subjectId: null };
}

/** Convert a rejected result to the typed contract error required by callers. */
export function trainingExportError(
  rejected: TrainingExportRejected,
): TrainingExportContractError {
  return new TrainingExportContractError(
    rejected.failureClass,
    rejected.issuePath,
    rejected.detail,
  );
}

export type ExportTrajectoriesEvent = {
  event: "telemetry.training_export";
  operation: "export_trajectories";
  outcome: "started" | "filtered" | "completed" | "rejected";
  subjectId: string;
  deviceId?: string;
  failureClass?: TrainingExportFailureClass;
  readCount?: number;
  exportedCount?: number;
  filteredCount?: number;
};

export type ExportTrajectoriesOptions = {
  subjectId: string;
  readTrajectories: (
    subjectId: string,
    limit: number,
  ) => Promise<readonly unknown[]> | readonly unknown[];
  resolveConsent: (
    trajectory: TurnTrajectoryV1,
  ) => Promise<TrainingExportConsent | null | undefined> | TrainingExportConsent | null | undefined;
  writeJsonl: (jsonl: string, signal: AbortSignal) => Promise<void> | void;
  limit?: number;
  timeoutMs?: number;
  onTelemetry?: (event: ExportTrajectoriesEvent) => void;
};

export type ExportTrajectoriesResult = {
  subjectId: string;
  readCount: number;
  exportedCount: number;
  filteredCount: number;
};

/**
 * Read one bounded, subject-scoped snapshot and atomically hand its JSONL to
 * the caller's sink. The function is invoked only by an operator; it has no
 * scheduling or upload behavior.
 */
export async function exportTrajectories(
  options: ExportTrajectoriesOptions,
): Promise<ExportTrajectoriesResult> {
  if (!boundedString(options.subjectId, TRAJECTORY_ID_LIMIT)) {
    throw new TrainingExportContractError(
      "validation",
      "subjectId",
      "subjectId is required",
    );
  }
  const limit = options.limit ?? TRAINING_EXPORT_DEFAULT_LIMIT;
  const timeoutMs = options.timeoutMs ?? TRAINING_EXPORT_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > TRAINING_EXPORT_MAX_LIMIT
  ) {
    throw new TrainingExportContractError(
      "limit",
      "limit",
      `limit must be between 1 and ${TRAINING_EXPORT_MAX_LIMIT}`,
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TrainingExportContractError(
      "validation",
      "timeoutMs",
      "timeoutMs must be a positive integer",
    );
  }

  const startedAt = Date.now();
  emitExport(options, {
    event: "telemetry.training_export",
    operation: "export_trajectories",
    outcome: "started",
    subjectId: options.subjectId,
  });

  let input: readonly unknown[];
  try {
    input = await withinDeadline(
      Promise.resolve(options.readTrajectories(options.subjectId, limit)),
      startedAt,
      timeoutMs,
    );
  } catch (error: unknown) {
    throw failExport(options, classifyIoError(error, "read_failed"), error);
  }
  if (!Array.isArray(input)) {
    throw failExport(
      options,
      "validation",
      new Error("sovereign store reader must return an array"),
    );
  }
  if (input.length > limit) {
    throw failExport(
      options,
      "limit",
      new Error(`sovereign store returned more than the requested ${limit} records`),
    );
  }

  const parsed: TurnTrajectoryV1[] = [];
  for (const raw of input) {
    const result = parseTurnTrajectoryV1(raw);
    if (!result.ok) {
      throw failExport(
        options,
        result.failureClass === "keystroke_forbidden"
          ? "raw_content_forbidden"
          : result.failureClass === "stage_limit" ||
              result.failureClass === "tool_call_limit"
            ? "limit"
            : "validation",
        new Error(result.detail),
        result.issuePath,
      );
    }
    if (result.record.subjectId !== options.subjectId) {
      throw failExport(
        options,
        "cross_subject",
        new Error("sovereign store returned a trajectory for another subject"),
      );
    }
    parsed.push(result.record);
  }
  parsed.sort(
    (left, right) =>
      left.capturedAt.localeCompare(right.capturedAt) ||
      left.turnId.localeCompare(right.turnId),
  );

  const seenTurnIds = new Set<string>();
  const lines: TrainingExportLineV1[] = [];
  let filteredCount = 0;
  for (const trajectory of parsed) {
    if (seenTurnIds.has(trajectory.turnId)) {
      filteredCount += 1;
      continue;
    }
    seenTurnIds.add(trajectory.turnId);

    let consent: TrainingExportConsent | null | undefined;
    try {
      consent = await withinDeadline(
        Promise.resolve(options.resolveConsent(trajectory)),
        startedAt,
        timeoutMs,
      );
    } catch (error: unknown) {
      throw failExport(options, classifyIoError(error, "read_failed"), error);
    }
    const failureClass = consentFailure(trajectory, consent);
    if (failureClass !== undefined) {
      filteredCount += 1;
      emitExport(options, {
        event: "telemetry.training_export",
        operation: "export_trajectories",
        outcome: "filtered",
        subjectId: options.subjectId,
        deviceId: trajectory.deviceId,
        failureClass,
      });
      continue;
    }

    const line = createTrainingExportLineV1(trajectory, consent);
    if (!line.ok) {
      throw failExport(
        options,
        line.failureClass,
        trainingExportError(line),
        line.issuePath,
      );
    }
    lines.push(line.value);
  }

  if (lines.length === 0) {
    const error = new NoExportableTrajectoriesError(options.subjectId);
    throw failExport(options, error.failureClass, error);
  }
  const jsonl = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const writeAbort = new AbortController();
  try {
    await withinDeadline(
      Promise.resolve(options.writeJsonl(jsonl, writeAbort.signal)),
      startedAt,
      timeoutMs,
      () => writeAbort.abort(),
    );
  } catch (error: unknown) {
    throw failExport(options, classifyIoError(error, "write_failed"), error);
  }

  const result: ExportTrajectoriesResult = {
    subjectId: options.subjectId,
    readCount: input.length,
    exportedCount: lines.length,
    filteredCount,
  };
  emitExport(options, {
    event: "telemetry.training_export",
    operation: "export_trajectories",
    outcome: "completed",
    ...result,
  });
  return result;
}

function consentFailure(
  trajectory: TurnTrajectoryV1,
  consent: TrainingExportConsent | null | undefined,
): TrainingExportFailureClass | undefined {
  if (!consent) return "consent_missing";
  if (consent.subjectId !== trajectory.subjectId) return "cross_subject";
  if (consent.scope !== TRAINING_EXPORT_CONSENT_SCOPE) {
    return "consent_scope_invalid";
  }
  if (!consent.active || !consent.optedIn) return "consent_denied";
  return undefined;
}

function classifyIoError(
  error: unknown,
  fallback: "read_failed" | "write_failed",
): TrainingExportFailureClass {
  return error instanceof TrainingExportContractError
    ? error.failureClass
    : fallback;
}

function failExport(
  options: ExportTrajectoriesOptions,
  failureClass: TrainingExportFailureClass,
  error: unknown,
  issuePath?: string,
): TrainingExportContractError {
  emitExport(options, {
    event: "telemetry.training_export",
    operation: "export_trajectories",
    outcome: "rejected",
    subjectId: options.subjectId,
    failureClass,
  });
  if (error instanceof TrainingExportContractError) return error;
  return new TrainingExportContractError(
    failureClass,
    issuePath,
    error instanceof Error ? error.message : "training export failed",
  );
}

function emitExport(
  options: Pick<ExportTrajectoriesOptions, "onTelemetry">,
  event: ExportTrajectoriesEvent,
): void {
  try {
    options.onTelemetry?.(event);
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "telemetry.training_export.observer",
        outcome: "rejected",
        subjectId: event.subjectId,
        failureClass:
          error instanceof Error ? error.name.slice(0, 64) : "observer_failed",
      }),
    );
  }
}

async function withinDeadline<T>(
  operation: Promise<T>,
  startedAt: number,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new TrainingExportContractError(
      "timeout",
      undefined,
      "training export deadline exceeded",
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, rejectPromise) => {
        timer = setTimeout(
          () => {
            rejectPromise(
              new TrainingExportContractError(
                "timeout",
                undefined,
                "training export deadline exceeded",
              ),
            );
            onTimeout?.();
          },
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reject(
  failureClass: TrainingExportFailureClass,
  subjectId: string | null,
  detail: string,
  issuePath?: string,
): TrainingExportRejected {
  return {
    ok: false,
    failureClass,
    subjectId,
    detail,
    ...(issuePath === undefined ? {} : { issuePath }),
  };
}

function subjectIdFrom(value: unknown): string | null {
  return isPlainObject(value) && typeof value.subjectId === "string"
    ? value.subjectId.slice(0, TRAJECTORY_ID_LIMIT)
    : null;
}

function deviceIdFrom(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.deviceId === "string"
    ? value.deviceId.slice(0, TRAJECTORY_ID_LIMIT)
    : undefined;
}

function emitRejected(
  rejected: TrainingExportRejected,
  operation: TrainingExportContractEvent["operation"],
  options: TrainingExportContractOptions,
  deviceId?: string,
): TrainingExportRejected {
  emit(options, {
    event: "telemetry.training_export.contract",
    operation,
    outcome: "rejected",
    subjectId: rejected.subjectId,
    ...(deviceId === undefined ? {} : { deviceId }),
    failureClass: rejected.failureClass,
  });
  return rejected;
}

function emit(
  options: TrainingExportContractOptions,
  event: TrainingExportContractEvent,
): void {
  try {
    options.onTelemetry?.(event);
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "telemetry.training_export.contract.observer",
        outcome: "rejected",
        subjectId: event.subjectId,
        ...(event.deviceId === undefined ? {} : { deviceId: event.deviceId }),
        failureClass:
          error instanceof Error ? error.name.slice(0, 64) : "observer_failed",
      }),
    );
  }
}

/** Published draft-07 schema for one JSONL line plus FinetuneJob definition. */
export function toTrainingExportV1JsonSchema(): Record<string, unknown> {
  const contentRef = {
    type: "object",
    additionalProperties: false,
    properties: {
      contentHash: {
        type: "string",
        minLength: 1,
        maxLength: TRAJECTORY_HASH_LIMIT,
      },
      byteLength: { type: "integer", minimum: 0 },
    },
    required: ["contentHash"],
  };
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "TrainingExportLineV1",
    type: "object",
    additionalProperties: false,
    "x-training-export-version": TRAINING_EXPORT_VERSION,
    "x-content-policy": "hashes-only",
    properties: {
      trainingExportVersion: { type: "string", const: TRAINING_EXPORT_VERSION },
      kind: { type: "string", const: TRAINING_EXPORT_KIND },
      subjectId: { type: "string", minLength: 1, maxLength: TRAJECTORY_ID_LIMIT },
      deviceId: { type: "string", minLength: 1, maxLength: TRAJECTORY_ID_LIMIT },
      turnId: { type: "string", minLength: 1, maxLength: TRAJECTORY_ID_LIMIT },
      sessionId: { type: "string", minLength: 1, maxLength: TRAJECTORY_ID_LIMIT },
      capturedAt: {
        type: "string",
        pattern: "^\\d{15}:\\d{6}:[A-Za-z0-9_-]{4,64}$",
      },
      locality: { type: "string", enum: ["on-device", "self-hosted"] },
      sourceConsentRecordId: {
        type: "string",
        minLength: 1,
        maxLength: TRAJECTORY_ID_LIMIT,
      },
      exportConsentRecordId: {
        type: "string",
        minLength: 1,
        maxLength: TRAJECTORY_ID_LIMIT,
      },
      exportConsentScope: {
        type: "string",
        const: TRAINING_EXPORT_CONSENT_SCOPE,
      },
      modelId: {
        type: "string",
        minLength: 1,
        maxLength: TRAJECTORY_MODEL_ID_LIMIT,
      },
      input: contentRef,
      output: contentRef,
      stages: {
        type: "array",
        maxItems: TRAJECTORY_STAGE_LIMIT,
        items: { $ref: "#/definitions/TrajectoryStage" },
      },
      toolCalls: {
        type: "array",
        maxItems: TRAJECTORY_TOOL_CALL_LIMIT,
        items: { $ref: "#/definitions/TrajectoryToolCall" },
      },
      outcomes: { $ref: "#/definitions/TrajectoryOutcomes" },
    },
    required: [
      "trainingExportVersion",
      "kind",
      "subjectId",
      "deviceId",
      "turnId",
      "capturedAt",
      "locality",
      "sourceConsentRecordId",
      "exportConsentRecordId",
      "exportConsentScope",
      "modelId",
      "input",
      "output",
      "stages",
      "toolCalls",
      "outcomes",
    ],
    definitions: {
      TrajectoryStage: {
        type: "object",
        additionalProperties: false,
        properties: {
          stage: { type: "string", enum: ["perceive", "reason", "act"] },
          status: {
            type: "string",
            enum: ["ok", "aborted", "error", "skipped"],
          },
          chunkIndex: {
            type: "integer",
            minimum: 0,
            maximum: TRAJECTORY_STAGE_LIMIT,
          },
          opCode: { type: "string", minLength: 1, maxLength: 64 },
          startedAt: {
            type: "string",
            pattern: "^\\d{15}:\\d{6}:[A-Za-z0-9_-]{4,64}$",
          },
          endedAt: {
            type: "string",
            pattern: "^\\d{15}:\\d{6}:[A-Za-z0-9_-]{4,64}$",
          },
        },
        required: ["stage", "status"],
      },
      TrajectoryToolCall: {
        type: "object",
        additionalProperties: false,
        properties: {
          callId: {
            type: "string",
            minLength: 1,
            maxLength: TRAJECTORY_ID_LIMIT,
          },
          toolName: {
            type: "string",
            minLength: 1,
            maxLength: TRAJECTORY_ID_LIMIT,
          },
          argsHash: {
            type: "string",
            minLength: 1,
            maxLength: TRAJECTORY_HASH_LIMIT,
          },
          argsByteLength: { type: "integer", minimum: 0 },
          status: {
            type: "string",
            enum: ["ok", "error", "aborted", "denied"],
          },
          resultHash: {
            type: "string",
            minLength: 1,
            maxLength: TRAJECTORY_HASH_LIMIT,
          },
          resultByteLength: { type: "integer", minimum: 0 },
        },
        required: ["callId", "toolName", "argsHash", "status"],
      },
      TrajectoryOutcomes: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["completed", "aborted", "error", "partial"],
          },
          terminalStage: {
            type: "string",
            enum: ["perceive", "reason", "act"],
          },
        },
        required: ["status"],
      },
      FinetuneJob: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: {
            type: "string",
            minLength: 1,
            maxLength: TRAJECTORY_ID_LIMIT,
          },
          adapterType: {
            type: "string",
            minLength: 1,
            maxLength: ADAPTER_TYPE_LIMIT,
          },
          baseModelId: {
            type: "string",
            minLength: 1,
            maxLength: TRAJECTORY_MODEL_ID_LIMIT,
          },
          datasetUri: {
            type: "string",
            minLength: 1,
            maxLength: DATASET_URI_LIMIT,
          },
        },
        required: ["jobId", "adapterType", "baseModelId", "datasetUri"],
      },
    },
  };
}

