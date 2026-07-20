/**
 * Failure-class feature extractor for self-healing mining (C6).
 *
 * Classifies correction exhaustion, degradation events, refusal misfires, and
 * tool timeouts from subject-scoped C0 trajectory metadata + P3 telemetry.
 * Metadata only — never utterance bodies, tool args, or raw learner content.
 * Cross-subject aggregation is default-deny (C7 federated consent required).
 */

export const FAILURE_PATTERNS_SCHEMA_VERSION =
  "learning.failure-patterns.v1" as const;
export const FAILURE_FEATURE_LIMIT = 256;
export const FAILURE_TRAJECTORY_LIMIT = 256;
export const FAILURE_TELEMETRY_LIMIT = 1_024;
export const FAILURE_ID_LIMIT = 128;
/** Aligns with harness MAX_CORRECTION_TURNS (B4). */
export const FAILURE_MAX_CORRECTION_TURNS = 8 as const;
/** Sparse clusters below this support stay triage-only (no auto-remediation). */
export const FAILURE_MIN_SUPPORT_DEFAULT = 3 as const;
/** Confidence floor for auto-remediation eligibility. */
export const FAILURE_CONFIDENCE_THRESHOLD_DEFAULT = 0.8 as const;
/** Bound on retained cluster version rows per subject registry. */
export const FAILURE_CLUSTER_ROW_LIMIT = 128 as const;
/** Ineffective remediation attempts before self-disable + page. */
export const FAILURE_INEFFECTIVE_ATTEMPT_LIMIT = 3 as const;

/** Allowed remediation control surfaces — never permissions or approval gates. */
export const ALLOWED_REMEDIATION_SURFACES = Object.freeze([
  "degradation_registry",
  "correction_loop",
  "routing_budget",
  "retry_cap",
] as const);

export type RemediationControlSurface =
  (typeof ALLOWED_REMEDIATION_SURFACES)[number];

export const FORBIDDEN_REMEDIATION_SURFACES = Object.freeze([
  "permissions",
  "approval_gate",
  "tool_permission",
  "skip_approval",
] as const);

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export const FAILURE_CLASSES = Object.freeze([
  "correction_exhaustion",
  "degradation",
  "refusal_misfire",
  "tool_timeout",
] as const);

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type FailurePatternFailureClass =
  | "failure_patterns.invalid_input"
  | "failure_patterns.subject_scope"
  | "failure_patterns.locality_forbidden"
  | "failure_patterns.capacity"
  | "failure_patterns.cross_subject_denied"
  | "failure_patterns.raw_content_forbidden"
  | "failure_patterns.append_only_violation"
  | "failure_patterns.forbidden_surface"
  | "failure_patterns.idempotent_conflict"
  | "failure_patterns.fixture_expectation"
  | "failure_patterns.ci_fixture_failed";

export type FailureExtractorTelemetryEvent = {
  event: "learning.failure_patterns.extract";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  featureCount?: number;
  scannedTrajectoryCount?: number;
  scannedTelemetryEventCount?: number;
  duplicateEvidenceCount?: number;
  triageOnlyCount?: number;
  failureClass?: FailurePatternFailureClass;
  minedClass?: FailureClass;
};

export class FailurePatternContractError extends Error {
  readonly obligation: FailurePatternFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: FailurePatternFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "FailurePatternContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

/** Subject-scoped trajectory row used for mining (metadata grade). */
export type FailureTrajectoryInput = {
  subjectId: string;
  sessionId?: string;
  turnId?: string;
  deviceId?: string;
  locality?: "on-device" | "self-hosted";
  /** Opaque opcode / tool name — never utterance text. */
  opCode?: string;
  status?: string;
  correctionDepth?: number;
  correctionExhausted?: boolean;
  /**
   * Explicit seeded / eval marker for refusal misfire.
   * Normal declines alone never classify as misfires.
   */
  evidenceCode?: string;
  executionStatusCode?: number | string;
};

/**
 * P3 / harness telemetry events accepted by the extractor.
 * Unknown fields are ignored; known raw-content keys are rejected.
 */
export type FailureTelemetryEvent = {
  event: string;
  subjectId: string;
  deviceId?: string;
  turnId?: string;
  sessionId?: string;
  outcome?: string;
  failureClass?: string;
  depth?: number;
  maxDepth?: number;
  repeatedFailure?: boolean;
  mode?: string;
  dependency?: string;
  operation?: string;
  signalCode?: string;
  advisoryOutcome?: string;
  /** tool.result status or similar. */
  status?: string;
  toolIdHash?: string;
  opCode?: string;
  durationMs?: number;
  evidenceCode?: string;
  refusalCategoryCount?: number;
};

type FailureFeatureBase = {
  featureId: string;
  failureClass: FailureClass;
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  turnId?: string;
  source: "trajectory" | "telemetry";
  evidenceFingerprint: string;
};

export type CorrectionExhaustionFeature = FailureFeatureBase & {
  failureClass: "correction_exhaustion";
  depth: number;
  maxDepth: number;
  repeatedFailure: boolean;
};

export type DegradationFeature = FailureFeatureBase & {
  failureClass: "degradation";
  mode: string;
  dependency: string;
  operation?: string;
  signalCode?: string;
  advisoryOutcome?: string;
};

export type RefusalMisfireFeature = FailureFeatureBase & {
  failureClass: "refusal_misfire";
  evidenceCode: string;
  refusalCategoryCount?: number;
};

export type ToolTimeoutFeature = FailureFeatureBase & {
  failureClass: "tool_timeout";
  toolIdHash?: string;
  opCode?: string;
  durationMs?: number;
};

export type FailureFeature =
  | CorrectionExhaustionFeature
  | DegradationFeature
  | RefusalMisfireFeature
  | ToolTimeoutFeature;

export type FailureClassSupportRow = {
  failureClass: FailureClass;
  support: number;
  /** Below min support → triage only; never auto-remediation. */
  disposition: "triage" | "eligible";
};

export type FailureFeatureExtractionResult = {
  schemaVersion: typeof FAILURE_PATTERNS_SCHEMA_VERSION;
  subjectId: string;
  features: FailureFeature[];
  support: FailureClassSupportRow[];
  scannedTrajectoryCount: number;
  scannedTelemetryEventCount: number;
  duplicateEvidenceCount: number;
  triageOnlyCount: number;
};

const FORBIDDEN_CONTENT_KEYS = Object.freeze([
  "utterance",
  "prompt",
  "response",
  "body",
  "content",
  "message",
  "toolArgs",
  "toolResult",
  "stack",
  "raw",
]);

const REFUSAL_MISFIRE_CODES = Object.freeze([
  "refusal_on_benign",
  "over_refusal",
  "hack.refusal_on_benign",
] as const);

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new FailurePatternContractError(`${field} must be a bounded id`, {
      obligation: "failure_patterns.invalid_input",
    });
  }
  return value;
}

function assertNoRawContent(
  record: Record<string, unknown>,
  subjectId: string,
  deviceId: string,
): void {
  for (const key of Object.keys(record)) {
    const lower = key.toLowerCase();
    if (
      FORBIDDEN_CONTENT_KEYS.some(
        (forbidden) => lower === forbidden || lower.includes(forbidden),
      )
    ) {
      throw new FailurePatternContractError(
        `raw content key ${key} is forbidden in failure mining`,
        {
          obligation: "failure_patterns.raw_content_forbidden",
          subjectId,
          deviceId,
        },
      );
    }
  }
}

function fingerprint(parts: readonly string[]): string {
  return parts.join("|");
}

function featureId(className: FailureClass, fp: string): string {
  // Bounded, deterministic id — never content.
  const compact = fp.replace(/[^a-zA-Z0-9._:-]/g, ".").slice(0, 96);
  return `${className}.${compact}`;
}

function countSupport(
  features: readonly FailureFeature[],
  minSupport: number,
): FailureClassSupportRow[] {
  const counts = new Map<FailureClass, number>();
  for (const cls of FAILURE_CLASSES) counts.set(cls, 0);
  for (const feature of features) {
    counts.set(feature.failureClass, (counts.get(feature.failureClass) ?? 0) + 1);
  }
  return FAILURE_CLASSES.map((failureClass) => {
    const support = counts.get(failureClass) ?? 0;
    return {
      failureClass,
      support,
      disposition: support >= minSupport ? ("eligible" as const) : ("triage" as const),
    };
  });
}

function pushUnique(
  features: FailureFeature[],
  seen: Set<string>,
  feature: FailureFeature,
): "added" | "duplicate" {
  if (seen.has(feature.evidenceFingerprint)) return "duplicate";
  if (features.length >= FAILURE_FEATURE_LIMIT) {
    throw new FailurePatternContractError(
      `failure features exceed ${FAILURE_FEATURE_LIMIT}`,
      {
        obligation: "failure_patterns.capacity",
        subjectId: feature.subjectId,
        ...(feature.deviceId !== undefined
          ? { deviceId: feature.deviceId }
          : {}),
      },
    );
  }
  seen.add(feature.evidenceFingerprint);
  features.push(feature);
  return "added";
}

function extractFromTrajectory(
  row: FailureTrajectoryInput,
  subjectId: string,
  maxCorrectionTurns: number,
  features: FailureFeature[],
  seen: Set<string>,
): number {
  let duplicates = 0;
  const deviceId = row.deviceId ?? "unknown";
  if (row.subjectId !== subjectId) {
    throw new FailurePatternContractError(
      "cross-subject trajectory mining denied",
      {
        obligation: "failure_patterns.cross_subject_denied",
        subjectId,
        deviceId,
      },
    );
  }
  if (
    row.locality !== undefined &&
    row.locality !== "on-device" &&
    row.locality !== "self-hosted"
  ) {
    throw new FailurePatternContractError(
      "failure mining locality must be on-device or self-hosted",
      {
        obligation: "failure_patterns.locality_forbidden",
        subjectId,
        deviceId,
      },
    );
  }
  assertNoRawContent(row as unknown as Record<string, unknown>, subjectId, deviceId);

  const depth = row.correctionDepth;
  const exhausted =
    row.correctionExhausted === true ||
    (typeof depth === "number" && depth >= maxCorrectionTurns);
  if (exhausted) {
    if (
      typeof depth === "number" &&
      (!Number.isFinite(depth) || depth < 0 || depth > 1_000)
    ) {
      throw new FailurePatternContractError("correctionDepth must be bounded", {
        obligation: "failure_patterns.invalid_input",
        subjectId,
        deviceId,
      });
    }
    const effectiveDepth =
      typeof depth === "number" ? Math.min(depth, maxCorrectionTurns) : maxCorrectionTurns;
    const fp = fingerprint([
      "trajectory",
      "correction_exhaustion",
      subjectId,
      row.turnId ?? "",
      String(effectiveDepth),
    ]);
    const result = pushUnique(features, seen, {
      featureId: featureId("correction_exhaustion", fp),
      failureClass: "correction_exhaustion",
      subjectId,
      ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}),
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
      source: "trajectory",
      evidenceFingerprint: fp,
      depth: effectiveDepth,
      maxDepth: maxCorrectionTurns,
      repeatedFailure: false,
    });
    if (result === "duplicate") duplicates += 1;
  }

  if (
    row.evidenceCode !== undefined &&
    REFUSAL_MISFIRE_CODES.includes(
      row.evidenceCode as (typeof REFUSAL_MISFIRE_CODES)[number],
    )
  ) {
    const evidenceCode = requireId(row.evidenceCode, "evidenceCode");
    const fp = fingerprint([
      "trajectory",
      "refusal_misfire",
      subjectId,
      row.turnId ?? "",
      evidenceCode,
    ]);
    const result = pushUnique(features, seen, {
      featureId: featureId("refusal_misfire", fp),
      failureClass: "refusal_misfire",
      subjectId,
      ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}),
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
      source: "trajectory",
      evidenceFingerprint: fp,
      evidenceCode,
    });
    if (result === "duplicate") duplicates += 1;
  }

  const status = row.executionStatusCode;
  if (
    status === "timeout" ||
    status === "TIMEOUT" ||
    status === 408 ||
    (typeof status === "string" && status.toLowerCase().includes("timeout"))
  ) {
    const fp = fingerprint([
      "trajectory",
      "tool_timeout",
      subjectId,
      row.turnId ?? "",
      row.opCode ?? "",
      String(status),
    ]);
    const result = pushUnique(features, seen, {
      featureId: featureId("tool_timeout", fp),
      failureClass: "tool_timeout",
      subjectId,
      ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}),
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
      source: "trajectory",
      evidenceFingerprint: fp,
      ...(row.opCode !== undefined
        ? { opCode: requireId(row.opCode, "opCode") }
        : {}),
    });
    if (result === "duplicate") duplicates += 1;
  }

  return duplicates;
}

function extractFromTelemetry(
  event: FailureTelemetryEvent,
  subjectId: string,
  maxCorrectionTurns: number,
  features: FailureFeature[],
  seen: Set<string>,
): number {
  let duplicates = 0;
  const deviceId = event.deviceId ?? "unknown";
  if (event.subjectId !== subjectId) {
    throw new FailurePatternContractError(
      "cross-subject telemetry mining denied",
      {
        obligation: "failure_patterns.cross_subject_denied",
        subjectId,
        deviceId,
      },
    );
  }
  assertNoRawContent(
    event as unknown as Record<string, unknown>,
    subjectId,
    deviceId,
  );

  if (
    event.event === "runtime.harness.correction_loop" &&
    (event.outcome === "exhausted" ||
      event.failureClass === "correction_exhausted")
  ) {
    const depth =
      typeof event.depth === "number" && Number.isFinite(event.depth)
        ? Math.min(Math.max(0, event.depth), maxCorrectionTurns)
        : maxCorrectionTurns;
    const maxDepth =
      typeof event.maxDepth === "number" && Number.isFinite(event.maxDepth)
        ? event.maxDepth
        : maxCorrectionTurns;
    const fp = fingerprint([
      "telemetry",
      "correction_exhaustion",
      subjectId,
      event.turnId ?? "",
      String(depth),
      String(maxDepth),
    ]);
    const result = pushUnique(features, seen, {
      featureId: featureId("correction_exhaustion", fp),
      failureClass: "correction_exhaustion",
      subjectId,
      ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      source: "telemetry",
      evidenceFingerprint: fp,
      depth,
      maxDepth,
      repeatedFailure: event.repeatedFailure === true,
    });
    if (result === "duplicate") duplicates += 1;
  }

  if (
    (event.event === "runtime.harness.degradation_registry" ||
      event.event === "runtime.harness.degradation_advisory") &&
    (event.outcome === "advisory" ||
      event.advisoryOutcome !== undefined ||
      event.mode !== undefined)
  ) {
    if (typeof event.mode !== "string" || !ID_RE.test(event.mode)) {
      throw new FailurePatternContractError(
        "degradation event requires a bounded mode",
        {
          obligation: "failure_patterns.invalid_input",
          subjectId,
          deviceId,
        },
      );
    }
    if (
      typeof event.dependency !== "string" ||
      !ID_RE.test(event.dependency)
    ) {
      throw new FailurePatternContractError(
        "degradation event requires a bounded dependency",
        {
          obligation: "failure_patterns.invalid_input",
          subjectId,
          deviceId,
        },
      );
    }
    const fp = fingerprint([
      "telemetry",
      "degradation",
      subjectId,
      event.turnId ?? "",
      event.mode,
      event.dependency,
      event.signalCode ?? "",
      event.advisoryOutcome ?? "",
    ]);
    const result = pushUnique(features, seen, {
      featureId: featureId("degradation", fp),
      failureClass: "degradation",
      subjectId,
      ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      source: "telemetry",
      evidenceFingerprint: fp,
      mode: event.mode,
      dependency: event.dependency,
      ...(event.operation !== undefined && ID_RE.test(event.operation)
        ? { operation: event.operation }
        : {}),
      ...(event.signalCode !== undefined && ID_RE.test(event.signalCode)
        ? { signalCode: event.signalCode }
        : {}),
      ...(event.advisoryOutcome !== undefined &&
      ID_RE.test(event.advisoryOutcome)
        ? { advisoryOutcome: event.advisoryOutcome }
        : {}),
    });
    if (result === "duplicate") duplicates += 1;
  }

  if (
    event.evidenceCode !== undefined &&
    REFUSAL_MISFIRE_CODES.includes(
      event.evidenceCode as (typeof REFUSAL_MISFIRE_CODES)[number],
    )
  ) {
    const evidenceCode = requireId(event.evidenceCode, "evidenceCode");
    const fp = fingerprint([
      "telemetry",
      "refusal_misfire",
      subjectId,
      event.turnId ?? "",
      evidenceCode,
    ]);
    const result = pushUnique(features, seen, {
      featureId: featureId("refusal_misfire", fp),
      failureClass: "refusal_misfire",
      subjectId,
      ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      source: "telemetry",
      evidenceFingerprint: fp,
      evidenceCode,
      ...(typeof event.refusalCategoryCount === "number" &&
      Number.isFinite(event.refusalCategoryCount)
        ? { refusalCategoryCount: event.refusalCategoryCount }
        : {}),
    });
    if (result === "duplicate") duplicates += 1;
  }

  if (
    (event.event === "tool.result" || event.event.endsWith(".tool.result")) &&
    (event.status === "timeout" || event.outcome === "timeout")
  ) {
    const fp = fingerprint([
      "telemetry",
      "tool_timeout",
      subjectId,
      event.turnId ?? "",
      event.toolIdHash ?? "",
      event.opCode ?? "",
      String(event.durationMs ?? ""),
    ]);
    const result = pushUnique(features, seen, {
      featureId: featureId("tool_timeout", fp),
      failureClass: "tool_timeout",
      subjectId,
      ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      source: "telemetry",
      evidenceFingerprint: fp,
      ...(event.toolIdHash !== undefined && ID_RE.test(event.toolIdHash)
        ? { toolIdHash: event.toolIdHash }
        : {}),
      ...(event.opCode !== undefined && ID_RE.test(event.opCode)
        ? { opCode: event.opCode }
        : {}),
      ...(typeof event.durationMs === "number" &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0 &&
      event.durationMs <= 3_600_000
        ? { durationMs: event.durationMs }
        : {}),
    });
    if (result === "duplicate") duplicates += 1;
  }

  return duplicates;
}

/**
 * Extract subject-scoped failure-class features from trajectories + P3 events.
 * Sparse classes remain triage-only until min support is met.
 */
export function extractFailureFeatures(input: {
  subjectId: string;
  deviceId?: string;
  trajectories?: readonly FailureTrajectoryInput[];
  telemetryEvents?: readonly FailureTelemetryEvent[];
  maxCorrectionTurns?: number;
  minSupport?: number;
  expectedSubjectId?: string;
  onTelemetry?: (event: FailureExtractorTelemetryEvent) => void;
}): FailureFeatureExtractionResult {
  const subjectId = requireId(input.subjectId, "subjectId");
  const deviceId =
    input.deviceId === undefined
      ? "unknown"
      : requireId(input.deviceId, "deviceId");

  if (
    input.expectedSubjectId !== undefined &&
    input.expectedSubjectId !== subjectId
  ) {
    input.onTelemetry?.({
      event: "learning.failure_patterns.extract",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "failure_patterns.subject_scope",
    });
    throw new FailurePatternContractError(
      "cross-subject failure feature extraction denied",
      {
        obligation: "failure_patterns.subject_scope",
        subjectId,
        deviceId,
      },
    );
  }

  const trajectories = input.trajectories ?? [];
  const telemetryEvents = input.telemetryEvents ?? [];
  if (
    !Array.isArray(trajectories) ||
    !Array.isArray(telemetryEvents) ||
    trajectories.length > FAILURE_TRAJECTORY_LIMIT ||
    telemetryEvents.length > FAILURE_TELEMETRY_LIMIT
  ) {
    input.onTelemetry?.({
      event: "learning.failure_patterns.extract",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "failure_patterns.capacity",
    });
    throw new FailurePatternContractError(
      `failure mining inputs exceed trajectory ${FAILURE_TRAJECTORY_LIMIT} / telemetry ${FAILURE_TELEMETRY_LIMIT}`,
      { obligation: "failure_patterns.capacity", subjectId, deviceId },
    );
  }

  const maxCorrectionTurns =
    input.maxCorrectionTurns ?? FAILURE_MAX_CORRECTION_TURNS;
  if (
    !Number.isInteger(maxCorrectionTurns) ||
    maxCorrectionTurns < 1 ||
    maxCorrectionTurns > 64
  ) {
    throw new FailurePatternContractError(
      "maxCorrectionTurns must be an integer in 1..64",
      { obligation: "failure_patterns.invalid_input", subjectId, deviceId },
    );
  }
  const minSupport = input.minSupport ?? FAILURE_MIN_SUPPORT_DEFAULT;
  if (!Number.isInteger(minSupport) || minSupport < 1 || minSupport > 1_000) {
    throw new FailurePatternContractError(
      "minSupport must be an integer in 1..1000",
      { obligation: "failure_patterns.invalid_input", subjectId, deviceId },
    );
  }

  const features: FailureFeature[] = [];
  const seen = new Set<string>();
  let duplicateEvidenceCount = 0;

  try {
    for (const row of trajectories) {
      duplicateEvidenceCount += extractFromTrajectory(
        row,
        subjectId,
        maxCorrectionTurns,
        features,
        seen,
      );
    }
    for (const event of telemetryEvents) {
      duplicateEvidenceCount += extractFromTelemetry(
        event,
        subjectId,
        maxCorrectionTurns,
        features,
        seen,
      );
    }
  } catch (error) {
    if (error instanceof FailurePatternContractError) {
      input.onTelemetry?.({
        event: "learning.failure_patterns.extract",
        outcome: "fail",
        subjectId,
        deviceId,
        failureClass: error.obligation,
      });
    }
    throw error;
  }

  const support = countSupport(features, minSupport);
  const triageOnlyCount = support.filter(
    (row) => row.disposition === "triage" && row.support > 0,
  ).length;

  features.sort((left, right) =>
    left.featureId < right.featureId
      ? -1
      : left.featureId > right.featureId
        ? 1
        : 0,
  );

  input.onTelemetry?.({
    event: "learning.failure_patterns.extract",
    outcome: triageOnlyCount > 0 ? "advisory" : "ok",
    subjectId,
    deviceId,
    featureCount: features.length,
    scannedTrajectoryCount: trajectories.length,
    scannedTelemetryEventCount: telemetryEvents.length,
    duplicateEvidenceCount,
    triageOnlyCount,
  });

  return {
    schemaVersion: FAILURE_PATTERNS_SCHEMA_VERSION,
    subjectId,
    features,
    support,
    scannedTrajectoryCount: trajectories.length,
    scannedTelemetryEventCount: telemetryEvents.length,
    duplicateEvidenceCount,
    triageOnlyCount,
  };
}

export type FailureClusterDisposition = "triage" | "auto_eligible";

export type RemediationPolicyHint = {
  surface: RemediationControlSurface;
  /** Opaque parameter name on the typed surface (never raw content). */
  parameter: string;
  /** Bounded signed adjustment (retries/depth/budget). */
  delta: number;
};

export type FailureClusterRow = {
  clusterId: string;
  version: number;
  subjectId: string;
  failureClass: FailureClass;
  support: number;
  confidence: number;
  disposition: FailureClusterDisposition;
  policyHint: RemediationPolicyHint;
  evidenceFingerprints: string[];
  disabled: boolean;
  ineffectiveAttempts: number;
  pageRequested: boolean;
};

export type FailureClusterSnapshot = {
  schemaVersion: typeof FAILURE_PATTERNS_SCHEMA_VERSION;
  subjectId: string;
  minSupport: number;
  confidenceThreshold: number;
  clusters: FailureClusterRow[];
  registryVersion: number;
};

export type RemediationPolicyLookup =
  | {
      ok: true;
      disposition: "auto_eligible";
      cluster: FailureClusterRow;
      policy: RemediationPolicyHint;
    }
  | {
      ok: false;
      disposition: "triage" | "disabled";
      reason:
        | "below_support"
        | "below_confidence"
        | "disabled_ineffective"
        | "missing_cluster";
      failingClass: FailureClass;
      cluster?: FailureClusterRow;
      pageRequested?: boolean;
    };

export type FailureClusterTelemetryEvent = {
  event:
    | "learning.failure_patterns.cluster"
    | "learning.failure_patterns.lookup"
    | "learning.failure_patterns.append";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  failureClass?: FailureClass;
  clusterId?: string;
  version?: number;
  support?: number;
  confidence?: number;
  disposition?: FailureClusterDisposition | "disabled";
  pageRequested?: boolean;
  failureClassCode?: FailurePatternFailureClass;
};

function defaultPolicyHint(failureClass: FailureClass): RemediationPolicyHint {
  switch (failureClass) {
    case "correction_exhaustion":
      return {
        surface: "correction_loop",
        parameter: "maxCorrectionTurns",
        delta: -1,
      };
    case "degradation":
      return {
        surface: "degradation_registry",
        parameter: "retryBudget",
        delta: 1,
      };
    case "refusal_misfire":
      return {
        surface: "routing_budget",
        parameter: "guidanceWeight",
        delta: 1,
      };
    case "tool_timeout":
      return {
        surface: "retry_cap",
        parameter: "toolRetryCap",
        delta: 1,
      };
  }
}

/**
 * Confidence in [0,1]: grows with support, reaches threshold at minSupport
 * only when support is strictly above the floor (ties stay triage-friendly).
 */
export function computeClusterConfidence(
  support: number,
  minSupport: number,
): number {
  if (support <= 0) return 0;
  if (minSupport <= 0) return 1;
  // Asymptotic toward 1; at minSupport equals 0.75 so threshold 0.8 needs more.
  return Math.min(1, support / (support + minSupport * 0.25));
}

export function clusterDisposition(input: {
  support: number;
  confidence: number;
  minSupport: number;
  confidenceThreshold: number;
}): FailureClusterDisposition {
  if (
    input.support >= input.minSupport &&
    input.confidence + 1e-12 >= input.confidenceThreshold
  ) {
    return "auto_eligible";
  }
  return "triage";
}

function assertAllowedSurface(
  surface: string,
  subjectId: string,
  deviceId: string,
): asserts surface is RemediationControlSurface {
  if (
    (FORBIDDEN_REMEDIATION_SURFACES as readonly string[]).includes(surface) ||
    !(ALLOWED_REMEDIATION_SURFACES as readonly string[]).includes(surface)
  ) {
    throw new FailurePatternContractError(
      `remediation surface ${surface} is forbidden or unknown`,
      {
        obligation: "failure_patterns.forbidden_surface",
        subjectId,
        deviceId,
      },
    );
  }
}

/**
 * Build subject-scoped clusters from an extraction result.
 * Does not mutate the append-only registry — callers append explicitly.
 */
export function buildFailureClusters(input: {
  extraction: FailureFeatureExtractionResult;
  minSupport?: number;
  confidenceThreshold?: number;
  deviceId?: string;
  onTelemetry?: (event: FailureClusterTelemetryEvent) => void;
}): FailureClusterRow[] {
  const subjectId = input.extraction.subjectId;
  const deviceId = input.deviceId ?? "unknown";
  const minSupport = input.minSupport ?? FAILURE_MIN_SUPPORT_DEFAULT;
  const confidenceThreshold =
    input.confidenceThreshold ?? FAILURE_CONFIDENCE_THRESHOLD_DEFAULT;
  const byClass = new Map<FailureClass, FailureFeature[]>();
  for (const cls of FAILURE_CLASSES) byClass.set(cls, []);
  for (const feature of input.extraction.features) {
    byClass.get(feature.failureClass)!.push(feature);
  }

  const clusters: FailureClusterRow[] = [];
  for (const failureClass of FAILURE_CLASSES) {
    const group = byClass.get(failureClass)!;
    if (group.length === 0) continue;
    const support = group.length;
    const confidence = computeClusterConfidence(support, minSupport);
    const disposition = clusterDisposition({
      support,
      confidence,
      minSupport,
      confidenceThreshold,
    });
    const fingerprints = group
      .map((feature) => feature.evidenceFingerprint)
      .sort()
      .slice(0, FAILURE_FEATURE_LIMIT);
    const clusterId = `cluster.${failureClass}.${subjectId}`;
    const row: FailureClusterRow = {
      clusterId,
      version: 1,
      subjectId,
      failureClass,
      support,
      confidence,
      disposition,
      policyHint: defaultPolicyHint(failureClass),
      evidenceFingerprints: fingerprints,
      disabled: false,
      ineffectiveAttempts: 0,
      pageRequested: false,
    };
    clusters.push(row);
    input.onTelemetry?.({
      event: "learning.failure_patterns.cluster",
      outcome: disposition === "triage" ? "advisory" : "ok",
      subjectId,
      deviceId,
      failureClass,
      clusterId,
      version: 1,
      support,
      confidence,
      disposition,
    });
  }
  return clusters;
}

export type FailurePatternClusterRegistry = {
  readonly subjectId: string;
  readonly minSupport: number;
  readonly confidenceThreshold: number;
  /** Append a new version row — never edits an existing version. */
  appendClusterVersion(
    row: Omit<FailureClusterRow, "version"> & { version?: number },
  ): FailureClusterRow;
  /** Record an ineffective remediation; may disable + page. */
  recordIneffectiveAttempt(clusterId: string): FailureClusterRow;
  lookupRemediationPolicy(failureClass: FailureClass): RemediationPolicyLookup;
  snapshot(): FailureClusterSnapshot;
};

type RegistryState = {
  rows: FailureClusterRow[];
  /** clusterId → max version */
  latestVersion: Map<string, number>;
  registryVersion: number;
};

/**
 * In-memory, subject-scoped, append-only failure-pattern cluster registry.
 * Cross-subject writes are refused. Policy lookup never returns forbidden surfaces.
 */
export function createFailurePatternClusterRegistry(options: {
  subjectId: string;
  deviceId?: string;
  minSupport?: number;
  confidenceThreshold?: number;
  seedClusters?: readonly FailureClusterRow[];
  onTelemetry?: (event: FailureClusterTelemetryEvent) => void;
}): FailurePatternClusterRegistry {
  const subjectId = requireId(options.subjectId, "subjectId");
  const deviceId =
    options.deviceId === undefined
      ? "unknown"
      : requireId(options.deviceId, "deviceId");
  const minSupport = options.minSupport ?? FAILURE_MIN_SUPPORT_DEFAULT;
  const confidenceThreshold =
    options.confidenceThreshold ?? FAILURE_CONFIDENCE_THRESHOLD_DEFAULT;
  const state: RegistryState = {
    rows: [],
    latestVersion: new Map(),
    registryVersion: 0,
  };

  const emit = (
    event: Omit<FailureClusterTelemetryEvent, "subjectId" | "deviceId">,
  ): void => {
    options.onTelemetry?.({ ...event, subjectId, deviceId });
  };

  const appendInternal = (row: FailureClusterRow): FailureClusterRow => {
    if (row.subjectId !== subjectId) {
      emit({
        event: "learning.failure_patterns.append",
        outcome: "fail",
        failureClassCode: "failure_patterns.cross_subject_denied",
        clusterId: row.clusterId,
      });
      throw new FailurePatternContractError(
        "cross-subject cluster registry write denied",
        {
          obligation: "failure_patterns.cross_subject_denied",
          subjectId,
          deviceId,
        },
      );
    }
    assertAllowedSurface(row.policyHint.surface, subjectId, deviceId);
    if (
      !Number.isInteger(row.policyHint.delta) ||
      Math.abs(row.policyHint.delta) > 8 ||
      !ID_RE.test(row.policyHint.parameter)
    ) {
      throw new FailurePatternContractError(
        "policy hint parameter/delta must be bounded",
        {
          obligation: "failure_patterns.invalid_input",
          subjectId,
          deviceId,
        },
      );
    }
    if (state.rows.length >= FAILURE_CLUSTER_ROW_LIMIT) {
      throw new FailurePatternContractError(
        `cluster registry exceeds ${FAILURE_CLUSTER_ROW_LIMIT} rows`,
        { obligation: "failure_patterns.capacity", subjectId, deviceId },
      );
    }
    const priorMax = state.latestVersion.get(row.clusterId) ?? 0;
    if (row.version <= priorMax) {
      const existing = state.rows.find(
        (entry) =>
          entry.clusterId === row.clusterId && entry.version === row.version,
      );
      if (
        existing !== undefined &&
        JSON.stringify(existing) === JSON.stringify(row)
      ) {
        emit({
          event: "learning.failure_patterns.append",
          outcome: "advisory",
          clusterId: row.clusterId,
          version: row.version,
          failureClass: row.failureClass,
          disposition: row.disposition,
        });
        return existing;
      }
      emit({
        event: "learning.failure_patterns.append",
        outcome: "fail",
        failureClassCode: "failure_patterns.append_only_violation",
        clusterId: row.clusterId,
        version: row.version,
      });
      throw new FailurePatternContractError(
        `append-only violation for ${row.clusterId} version ${row.version}`,
        {
          obligation: "failure_patterns.append_only_violation",
          subjectId,
          deviceId,
        },
      );
    }
    if (row.version !== priorMax + 1) {
      throw new FailurePatternContractError(
        `cluster versions must be contiguous; expected ${priorMax + 1}`,
        {
          obligation: "failure_patterns.append_only_violation",
          subjectId,
          deviceId,
        },
      );
    }
    const frozen: FailureClusterRow = {
      ...row,
      evidenceFingerprints: [...row.evidenceFingerprints],
      policyHint: { ...row.policyHint },
    };
    state.rows.push(frozen);
    state.latestVersion.set(row.clusterId, row.version);
    state.registryVersion += 1;
    emit({
      event: "learning.failure_patterns.append",
      outcome: "ok",
      clusterId: row.clusterId,
      version: row.version,
      failureClass: row.failureClass,
      support: row.support,
      confidence: row.confidence,
      disposition: row.disposition,
    });
    return frozen;
  };

  if (options.seedClusters !== undefined) {
    for (const seed of options.seedClusters) {
      appendInternal({ ...seed, version: seed.version });
    }
  }

  return {
    get subjectId() {
      return subjectId;
    },
    get minSupport() {
      return minSupport;
    },
    get confidenceThreshold() {
      return confidenceThreshold;
    },

    appendClusterVersion(row) {
      const version =
        row.version ?? (state.latestVersion.get(row.clusterId) ?? 0) + 1;
      return appendInternal({ ...row, version });
    },

    recordIneffectiveAttempt(clusterId) {
      const id = requireId(clusterId, "clusterId");
      const latestVersion = state.latestVersion.get(id);
      if (latestVersion === undefined) {
        throw new FailurePatternContractError("unknown clusterId", {
          obligation: "failure_patterns.invalid_input",
          subjectId,
          deviceId,
        });
      }
      const latest = state.rows.find(
        (entry) => entry.clusterId === id && entry.version === latestVersion,
      )!;
      const ineffectiveAttempts = latest.ineffectiveAttempts + 1;
      const disabled =
        latest.disabled ||
        ineffectiveAttempts >= FAILURE_INEFFECTIVE_ATTEMPT_LIMIT;
      return appendInternal({
        ...latest,
        version: latestVersion + 1,
        ineffectiveAttempts,
        disabled,
        pageRequested: disabled,
      });
    },

    lookupRemediationPolicy(failureClass) {
      if (!(FAILURE_CLASSES as readonly string[]).includes(failureClass)) {
        throw new FailurePatternContractError("unknown failure class", {
          obligation: "failure_patterns.invalid_input",
          subjectId,
          deviceId,
        });
      }
      const candidates = state.rows
        .filter((row) => row.failureClass === failureClass)
        .sort((a, b) => b.version - a.version);
      const cluster = candidates[0];
      if (cluster === undefined) {
        emit({
          event: "learning.failure_patterns.lookup",
          outcome: "advisory",
          failureClass,
          disposition: "triage",
        });
        return {
          ok: false,
          disposition: "triage",
          reason: "missing_cluster",
          failingClass: failureClass,
        };
      }
      if (cluster.disabled) {
        emit({
          event: "learning.failure_patterns.lookup",
          outcome: "advisory",
          failureClass,
          clusterId: cluster.clusterId,
          version: cluster.version,
          disposition: "disabled",
          pageRequested: true,
        });
        return {
          ok: false,
          disposition: "disabled",
          reason: "disabled_ineffective",
          failingClass: failureClass,
          cluster,
          pageRequested: true,
        };
      }
      if (cluster.support < minSupport) {
        emit({
          event: "learning.failure_patterns.lookup",
          outcome: "advisory",
          failureClass,
          clusterId: cluster.clusterId,
          support: cluster.support,
          disposition: "triage",
        });
        return {
          ok: false,
          disposition: "triage",
          reason: "below_support",
          failingClass: failureClass,
          cluster,
        };
      }
      if (cluster.confidence + 1e-12 < confidenceThreshold) {
        emit({
          event: "learning.failure_patterns.lookup",
          outcome: "advisory",
          failureClass,
          clusterId: cluster.clusterId,
          confidence: cluster.confidence,
          disposition: "triage",
        });
        return {
          ok: false,
          disposition: "triage",
          reason: "below_confidence",
          failingClass: failureClass,
          cluster,
        };
      }
      if (cluster.disposition !== "auto_eligible") {
        emit({
          event: "learning.failure_patterns.lookup",
          outcome: "advisory",
          failureClass,
          clusterId: cluster.clusterId,
          disposition: "triage",
        });
        return {
          ok: false,
          disposition: "triage",
          reason: "below_confidence",
          failingClass: failureClass,
          cluster,
        };
      }
      assertAllowedSurface(cluster.policyHint.surface, subjectId, deviceId);
      emit({
        event: "learning.failure_patterns.lookup",
        outcome: "ok",
        failureClass,
        clusterId: cluster.clusterId,
        version: cluster.version,
        confidence: cluster.confidence,
        disposition: "auto_eligible",
      });
      return {
        ok: true,
        disposition: "auto_eligible",
        cluster,
        policy: cluster.policyHint,
      };
    },

    snapshot() {
      return {
        schemaVersion: FAILURE_PATTERNS_SCHEMA_VERSION,
        subjectId,
        minSupport,
        confidenceThreshold,
        clusters: state.rows.map((row) => ({
          ...row,
          evidenceFingerprints: [...row.evidenceFingerprints],
          policyHint: { ...row.policyHint },
        })),
        registryVersion: state.registryVersion,
      };
    },
  };
}

/**
 * Cluster an extraction and append each class as version 1 (or next) into a
 * subject registry. Sparse / low-confidence rows stay triage-only.
 */
export function ingestExtractionIntoClusterRegistry(input: {
  registry: FailurePatternClusterRegistry;
  extraction: FailureFeatureExtractionResult;
  deviceId?: string;
  onTelemetry?: (event: FailureClusterTelemetryEvent) => void;
}): FailureClusterRow[] {
  if (input.extraction.subjectId !== input.registry.subjectId) {
    throw new FailurePatternContractError(
      "extraction subject does not match cluster registry",
      {
        obligation: "failure_patterns.subject_scope",
        subjectId: input.registry.subjectId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      },
    );
  }
  const built = buildFailureClusters({
    extraction: input.extraction,
    minSupport: input.registry.minSupport,
    confidenceThreshold: input.registry.confidenceThreshold,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  return built.map((row) => {
    const { version: _ignored, ...withoutVersion } = row;
    return input.registry.appendClusterVersion(withoutVersion);
  });
}

/** Repo-relative seeded fixture root for failure-mining validation. */
export const FAILURE_MINING_FIXTURES_RELPATH =
  "training/self_healing/fixtures" as const;

export type FailureMiningFixtureKind =
  | "cluster_eligible"
  | "triage_only"
  | "refuse";

export type FailureMiningFixtureExpectation = {
  primaryClass?: FailureClass;
  disposition?: FailureClusterDisposition;
  lookupOk?: boolean;
  lookupReason?: "below_support" | "below_confidence" | "missing_cluster";
  policySurface?: RemediationControlSurface;
  minSupport?: number;
  obligation?: FailurePatternFailureClass;
};

export type FailureMiningFixtureDocument = {
  id: string;
  kind: FailureMiningFixtureKind;
  subjectId: string;
  deviceId?: string;
  locality?: "on-device" | "self-hosted";
  expect: FailureMiningFixtureExpectation;
  trajectories: FailureTrajectoryInput[];
  telemetryEvents: FailureTelemetryEvent[];
};

export type FailureMiningFixtureTelemetryEvent = {
  event: "learning.failure_patterns.fixture";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  fixtureId?: string;
  failureClass?: FailureClass;
  disposition?: FailureClusterDisposition | "disabled" | "refuse";
  failureClassCode?: FailurePatternFailureClass;
};

/**
 * Validate a mined cluster result against a seeded fixture expectation.
 * Pure — does not load files.
 */
export function assertFailureMiningFixtureResult(input: {
  fixture: FailureMiningFixtureDocument;
  mined: {
    clusters: readonly FailureClusterRow[];
    policies: Partial<Record<FailureClass, RemediationPolicyLookup>>;
  };
  deviceId?: string;
  onTelemetry?: (event: FailureMiningFixtureTelemetryEvent) => void;
}): { ok: true; fixtureId: string } {
  const deviceId = input.deviceId ?? input.fixture.deviceId ?? "ci";
  const subjectId = input.fixture.subjectId;
  const expect = input.fixture.expect;
  const fail = (message: string): never => {
    input.onTelemetry?.({
      event: "learning.failure_patterns.fixture",
      outcome: "fail",
      subjectId,
      deviceId,
      fixtureId: input.fixture.id,
      failureClassCode: "failure_patterns.fixture_expectation",
      ...(expect.primaryClass !== undefined
        ? { failureClass: expect.primaryClass }
        : {}),
    });
    throw new FailurePatternContractError(message, {
      obligation: "failure_patterns.fixture_expectation",
      subjectId,
      deviceId,
    });
  };

  if (input.fixture.kind === "refuse") {
    return fail(
      `fixture ${input.fixture.id} kind=refuse must be asserted via refuse path`,
    );
  }
  if (expect.primaryClass === undefined || expect.disposition === undefined) {
    return fail(`fixture ${input.fixture.id} missing primaryClass/disposition`);
  }
  const cluster = input.mined.clusters.find(
    (row) => row.failureClass === expect.primaryClass,
  );
  if (cluster === undefined) {
    return fail(
      `fixture ${input.fixture.id} missing cluster for ${expect.primaryClass}`,
    );
  }
  if (cluster.disposition !== expect.disposition) {
    return fail(
      `fixture ${input.fixture.id} expected disposition ${expect.disposition} got ${cluster.disposition}`,
    );
  }
  if (
    expect.minSupport !== undefined &&
    cluster.support < expect.minSupport &&
    expect.disposition === "auto_eligible"
  ) {
    return fail(
      `fixture ${input.fixture.id} support ${cluster.support} below expected ${expect.minSupport}`,
    );
  }
  const lookup = input.mined.policies[expect.primaryClass];
  if (lookup === undefined) {
    return fail(`fixture ${input.fixture.id} missing policy lookup`);
  }
  if (expect.lookupOk === true) {
    if (!lookup.ok) {
      return fail(
        `fixture ${input.fixture.id} expected auto-eligible lookup`,
      );
    }
    if (
      expect.policySurface !== undefined &&
      lookup.policy.surface !== expect.policySurface
    ) {
      return fail(
        `fixture ${input.fixture.id} expected surface ${expect.policySurface}`,
      );
    }
  } else if (expect.lookupOk === false) {
    if (lookup.ok) {
      return fail(`fixture ${input.fixture.id} must stay triage-only`);
    }
    if (
      expect.lookupReason !== undefined &&
      lookup.reason !== expect.lookupReason
    ) {
      return fail(
        `fixture ${input.fixture.id} expected reason ${expect.lookupReason} got ${lookup.reason}`,
      );
    }
  }

  input.onTelemetry?.({
    event: "learning.failure_patterns.fixture",
    outcome: expect.disposition === "triage" ? "advisory" : "ok",
    subjectId,
    deviceId,
    fixtureId: input.fixture.id,
    failureClass: expect.primaryClass,
    disposition: expect.disposition,
  });
  return { ok: true, fixtureId: input.fixture.id };
}
