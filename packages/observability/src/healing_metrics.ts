/**
 * Healing metrics on the P3 observability spine.
 *
 * Emits attempted/succeeded/disabled counters and time-to-resolution
 * histogram samples. Attributes are a closed metadata-only allow-list.
 */

import type { Attributes, Counter, Histogram } from "@opentelemetry/api";
import {
  getObservability,
  type ObservabilityHandle,
} from "./otel_bridge.js";

export const HEALING_AUDIT_WRITE_AHEAD_EVENT =
  "observability.healing.audit_write_ahead" as const;
export const HEALING_AUDIT_OUTCOME_EVENT =
  "observability.healing.outcome" as const;

export const HEALING_REMEDIATIONS_ATTEMPTED_COUNTER =
  "sutra.healing.remediations.attempted" as const;
export const HEALING_REMEDIATIONS_SUCCEEDED_COUNTER =
  "sutra.healing.remediations.succeeded" as const;
export const HEALING_REMEDIATIONS_DISABLED_COUNTER =
  "sutra.healing.remediations.disabled" as const;
export const HEALING_TIME_TO_RESOLUTION_HISTOGRAM =
  "sutra.healing.time_to_resolution_ms" as const;

/** Bounded active/completed receipt tracking per recorder. */
export const HEALING_METRICS_RECEIPT_LIMIT = 512 as const;

/** Attributes permitted on healing instruments. */
export const HEALING_METRIC_ATTR_KEYS = Object.freeze([
  "sutra.subject_id",
  "sutra.device_id",
  "sutra.pattern_id",
  "sutra.policy_version",
  "sutra.healing_action",
  "sutra.failure_class",
  "sutra.slice_id",
  "sutra.locality",
  "sutra.outcome",
] as const);

/** Write-ahead attributes additionally retained on the structured ack event. */
export const HEALING_AUDIT_ATTR_KEYS = Object.freeze([
  ...HEALING_METRIC_ATTR_KEYS,
  "sutra.healing_audit_id",
  "sutra.trigger_evidence_hash",
  "sutra.idempotency_key",
] as const);

export const HEALING_FAILURE_CLASSES = Object.freeze([
  "correction_exhaustion",
  "degradation",
  "refusal_misfire",
  "tool_timeout",
] as const);

export type HealingFailureClass = (typeof HEALING_FAILURE_CLASSES)[number];

export const HEALING_ACTION_KINDS = Object.freeze([
  "adjust_retry_budget",
  "set_correction_loop_cap",
  "switch_degradation_mode",
  "set_routing_fallback",
] as const);

export type HealingActionKind = (typeof HEALING_ACTION_KINDS)[number];
export type HealingMetricOutcome = "succeeded" | "disabled" | "error";

export type HealingAuditRecordForSpine = {
  auditId: string;
  subjectId: string;
  deviceId: string;
  policyVersion: number;
  patternId: string;
  triggerEvidenceHash: string;
  action: string;
  idempotencyKey: string;
  locality: string;
  timestamp: string;
  sliceId?: string;
  failureClass?: string;
};

export type HealingAuditWriteAheadSpineEvent = {
  event: typeof HEALING_AUDIT_WRITE_AHEAD_EVENT;
  outcome: "ok";
  subjectId: string;
  deviceId: string;
  auditId: string;
  patternId: string;
  policyVersion: number;
  action: HealingActionKind;
  triggerEvidenceHash: string;
  idempotencyKey: string;
  locality: "on-device" | "self-hosted";
  timestamp: string;
  sliceId?: string;
  failureClass?: HealingFailureClass;
};

export type HealingAuditOutcomeSpineEvent = {
  event: typeof HEALING_AUDIT_OUTCOME_EVENT;
  outcome: HealingMetricOutcome;
  subjectId: string;
  deviceId: string;
  auditId: string;
  patternId: string;
  policyVersion: number;
  action: HealingActionKind;
  locality: "on-device" | "self-hosted";
  timestamp: string;
  resolutionMs?: number;
  sliceId?: string;
  failureClass?: HealingFailureClass;
};

export type HealingMetricsEvent =
  | HealingAuditWriteAheadSpineEvent
  | HealingAuditOutcomeSpineEvent;

export type HealingMetricsSnapshot = {
  attempted: number;
  succeeded: number;
  disabled: number;
  timeToResolutionMs: number[];
  activeAuditCount: number;
  completedAuditCount: number;
};

export type HealingMetricsSink = {
  emitWriteAheadAck(
    event: HealingAuditWriteAheadSpineEvent,
  ): void | Promise<void>;
  emitOutcome(event: HealingAuditOutcomeSpineEvent): void | Promise<void>;
  snapshot(): HealingMetricsSnapshot;
};

export type HealingMetricsFailureClass =
  | "healing_metrics.invalid_input"
  | "healing_metrics.raw_content_forbidden"
  | "healing_metrics.cross_subject_denied"
  | "healing_metrics.missing_attempt"
  | "healing_metrics.idempotent_conflict"
  | "healing_metrics.capacity";

export class HealingMetricsContractError extends Error {
  readonly obligation: HealingMetricsFailureClass;

  constructor(message: string, obligation: HealingMetricsFailureClass) {
    super(message);
    this.name = "HealingMetricsContractError";
    this.obligation = obligation;
  }
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH_RE = /^[a-fA-F0-9]{16,128}$/;

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new HealingMetricsContractError(
      `${label} must be a stable id (1..128)`,
      "healing_metrics.invalid_input",
    );
  }
}

function assertNoRawContent(value: object): void {
  for (const key of Object.keys(value)) {
    if (/utterance|content|body|prompt|secret|password/i.test(key)) {
      throw new HealingMetricsContractError(
        `raw content key ${key} forbidden on healing metrics`,
        "healing_metrics.raw_content_forbidden",
      );
    }
  }
}

function validateAudit(
  audit: HealingAuditRecordForSpine,
): asserts audit is HealingAuditRecordForSpine & {
  action: HealingActionKind;
  locality: "on-device" | "self-hosted";
  failureClass?: HealingFailureClass;
} {
  assertNoRawContent(audit);
  assertId(audit.auditId, "auditId");
  assertId(audit.subjectId, "subjectId");
  assertId(audit.deviceId, "deviceId");
  assertId(audit.patternId, "patternId");
  assertId(audit.idempotencyKey, "idempotencyKey");
  if (audit.sliceId !== undefined) assertId(audit.sliceId, "sliceId");
  if (
    !Number.isInteger(audit.policyVersion) ||
    audit.policyVersion < 1 ||
    audit.policyVersion > 1_000_000
  ) {
    throw new HealingMetricsContractError(
      "policyVersion must be a positive integer",
      "healing_metrics.invalid_input",
    );
  }
  if (!(HEALING_ACTION_KINDS as readonly string[]).includes(audit.action)) {
    throw new HealingMetricsContractError(
      "unknown healing action",
      "healing_metrics.invalid_input",
    );
  }
  if (audit.locality !== "on-device" && audit.locality !== "self-hosted") {
    throw new HealingMetricsContractError(
      "unknown healing locality",
      "healing_metrics.invalid_input",
    );
  }
  if (
    audit.failureClass !== undefined &&
    !(HEALING_FAILURE_CLASSES as readonly string[]).includes(audit.failureClass)
  ) {
    throw new HealingMetricsContractError(
      "unknown healing failure class",
      "healing_metrics.invalid_input",
    );
  }
  if (!HASH_RE.test(audit.triggerEvidenceHash)) {
    throw new HealingMetricsContractError(
      "triggerEvidenceHash must be a metadata hash",
      "healing_metrics.invalid_input",
    );
  }
  if (!Number.isFinite(Date.parse(audit.timestamp))) {
    throw new HealingMetricsContractError(
      "timestamp must be ISO-8601",
      "healing_metrics.invalid_input",
    );
  }
}

function metricAttributes(
  event: HealingMetricsEvent,
): Attributes {
  return {
    "sutra.subject_id": event.subjectId,
    "sutra.device_id": event.deviceId,
    "sutra.pattern_id": event.patternId,
    "sutra.policy_version": event.policyVersion,
    "sutra.healing_action": event.action,
    "sutra.locality": event.locality,
    "sutra.outcome": event.outcome,
    ...(event.failureClass !== undefined
      ? { "sutra.failure_class": event.failureClass }
      : {}),
    ...(event.sliceId !== undefined
      ? { "sutra.slice_id": event.sliceId }
      : {}),
  };
}

export function assertHealingMetricAttrKeysAllowed(
  attrs: Readonly<Record<string, unknown>>,
): void {
  const allowed = new Set<string>(HEALING_METRIC_ATTR_KEYS);
  for (const key of Object.keys(attrs)) {
    if (!allowed.has(key)) {
      throw new HealingMetricsContractError(
        `healing metric attribute ${key} is forbidden`,
        "healing_metrics.raw_content_forbidden",
      );
    }
  }
}

export function toHealingAuditWriteAheadSpineEvent(
  audit: HealingAuditRecordForSpine,
): HealingAuditWriteAheadSpineEvent {
  validateAudit(audit);
  return {
    event: HEALING_AUDIT_WRITE_AHEAD_EVENT,
    outcome: "ok",
    subjectId: audit.subjectId,
    deviceId: audit.deviceId,
    auditId: audit.auditId,
    patternId: audit.patternId,
    policyVersion: audit.policyVersion,
    action: audit.action,
    triggerEvidenceHash: audit.triggerEvidenceHash,
    idempotencyKey: audit.idempotencyKey,
    locality: audit.locality,
    timestamp: audit.timestamp,
    ...(audit.sliceId !== undefined ? { sliceId: audit.sliceId } : {}),
    ...(audit.failureClass !== undefined
      ? { failureClass: audit.failureClass }
      : {}),
  };
}

function toOutcomeEvent(input: {
  audit: HealingAuditRecordForSpine;
  outcome: HealingMetricOutcome;
  timestamp?: string;
}): HealingAuditOutcomeSpineEvent {
  validateAudit(input.audit);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const startedMs = Date.parse(input.audit.timestamp);
  const endedMs = Date.parse(timestamp);
  if (!Number.isFinite(endedMs) || endedMs < startedMs) {
    throw new HealingMetricsContractError(
      "outcome timestamp must not precede write-ahead",
      "healing_metrics.invalid_input",
    );
  }
  const terminal = input.outcome === "succeeded" || input.outcome === "disabled";
  return {
    event: HEALING_AUDIT_OUTCOME_EVENT,
    outcome: input.outcome,
    subjectId: input.audit.subjectId,
    deviceId: input.audit.deviceId,
    auditId: input.audit.auditId,
    patternId: input.audit.patternId,
    policyVersion: input.audit.policyVersion,
    action: input.audit.action,
    locality: input.audit.locality,
    timestamp,
    ...(terminal ? { resolutionMs: endedMs - startedMs } : {}),
    ...(input.audit.sliceId !== undefined
      ? { sliceId: input.audit.sliceId }
      : {}),
    ...(input.audit.failureClass !== undefined
      ? { failureClass: input.audit.failureClass }
      : {}),
  };
}

/**
 * P3 metrics sink. It records each audit attempt/outcome at most once and
 * bounds receipt state to prevent unbounded high-cardinality retention.
 */
export function createHealingMetricsSink(options?: {
  limit?: number;
  expectedSubjectId?: string;
  observability?: Pick<ObservabilityHandle, "meter"> | null;
  onEvent?: (event: HealingMetricsEvent) => void;
}): HealingMetricsSink {
  const limit = options?.limit ?? HEALING_METRICS_RECEIPT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new HealingMetricsContractError(
      "healing metrics limit must be an integer in 1..10000",
      "healing_metrics.invalid_input",
    );
  }

  const observability =
    options?.observability === undefined
      ? getObservability()
      : options.observability;
  let attemptedCounter: Counter | undefined;
  let succeededCounter: Counter | undefined;
  let disabledCounter: Counter | undefined;
  let resolutionHistogram: Histogram | undefined;
  if (observability !== null) {
    attemptedCounter = observability.meter.createCounter(
      HEALING_REMEDIATIONS_ATTEMPTED_COUNTER,
      { description: "Write-ahead-audited remediation attempts" },
    );
    succeededCounter = observability.meter.createCounter(
      HEALING_REMEDIATIONS_SUCCEEDED_COUNTER,
      { description: "Remediations that resolved their failure class" },
    );
    disabledCounter = observability.meter.createCounter(
      HEALING_REMEDIATIONS_DISABLED_COUNTER,
      { description: "Remediation policies disabled after ineffectiveness" },
    );
    resolutionHistogram = observability.meter.createHistogram(
      HEALING_TIME_TO_RESOLUTION_HISTOGRAM,
      { description: "Healing time from write-ahead to terminal outcome", unit: "ms" },
    );
  }

  const attempted = new Map<string, HealingAuditWriteAheadSpineEvent>();
  const completed = new Map<string, HealingMetricOutcome>();
  const samples: number[] = [];
  let attemptedCount = 0;
  let succeededCount = 0;
  let disabledCount = 0;

  const assertSubject = (subjectId: string): void => {
    if (
      options?.expectedSubjectId !== undefined &&
      subjectId !== options.expectedSubjectId
    ) {
      throw new HealingMetricsContractError(
        "cross-subject healing metric denied",
        "healing_metrics.cross_subject_denied",
      );
    }
  };

  return {
    emitWriteAheadAck(event) {
      assertNoRawContent(event);
      assertSubject(event.subjectId);
      const existing = attempted.get(event.auditId);
      if (existing !== undefined) {
        if (
          existing.subjectId !== event.subjectId ||
          existing.patternId !== event.patternId ||
          existing.policyVersion !== event.policyVersion ||
          existing.action !== event.action
        ) {
          throw new HealingMetricsContractError(
            "healing attempt idempotency conflict",
            "healing_metrics.idempotent_conflict",
          );
        }
        return;
      }
      if (attempted.size >= limit) {
        throw new HealingMetricsContractError(
          "healing metrics receipt capacity exceeded",
          "healing_metrics.capacity",
        );
      }
      attempted.set(event.auditId, { ...event });
      attemptedCount += 1;
      const attrs = metricAttributes(event);
      assertHealingMetricAttrKeysAllowed(attrs);
      attemptedCounter?.add(1, attrs);
      options?.onEvent?.(event);
    },

    emitOutcome(event) {
      assertNoRawContent(event);
      assertSubject(event.subjectId);
      const attempt = attempted.get(event.auditId);
      if (attempt === undefined) {
        throw new HealingMetricsContractError(
          "healing outcome requires prior attempted metric",
          "healing_metrics.missing_attempt",
        );
      }
      if (attempt.subjectId !== event.subjectId) {
        throw new HealingMetricsContractError(
          "cross-subject healing outcome denied",
          "healing_metrics.cross_subject_denied",
        );
      }
      const prior = completed.get(event.auditId);
      if (prior !== undefined) {
        if (prior !== event.outcome) {
          throw new HealingMetricsContractError(
            "healing outcome idempotency conflict",
            "healing_metrics.idempotent_conflict",
          );
        }
        return;
      }
      if (completed.size >= limit) {
        throw new HealingMetricsContractError(
          "healing metrics completion capacity exceeded",
          "healing_metrics.capacity",
        );
      }
      completed.set(event.auditId, event.outcome);
      const attrs = metricAttributes(event);
      assertHealingMetricAttrKeysAllowed(attrs);
      if (event.outcome === "succeeded") {
        succeededCount += 1;
        succeededCounter?.add(1, attrs);
      } else if (event.outcome === "disabled") {
        disabledCount += 1;
        disabledCounter?.add(1, attrs);
      }
      if (event.resolutionMs !== undefined) {
        samples.push(event.resolutionMs);
        resolutionHistogram?.record(event.resolutionMs, attrs);
      }
      options?.onEvent?.(event);
    },

    snapshot() {
      return {
        attempted: attemptedCount,
        succeeded: succeededCount,
        disabled: disabledCount,
        timeToResolutionMs: samples.slice(),
        activeAuditCount: attempted.size - completed.size,
        completedAuditCount: completed.size,
      };
    },
  };
}

export function createInMemoryHealingMetricsSink(options?: {
  limit?: number;
  expectedSubjectId?: string;
}): {
  sink: HealingMetricsSink;
  events: HealingMetricsEvent[];
} {
  const events: HealingMetricsEvent[] = [];
  const sink = createHealingMetricsSink({
    observability: null,
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    ...(options?.expectedSubjectId !== undefined
      ? { expectedSubjectId: options.expectedSubjectId }
      : {}),
    onEvent: (event) => events.push(event),
  });
  return { sink, events };
}

export async function emitHealingAuditWriteAheadAck(input: {
  audit: HealingAuditRecordForSpine;
  metrics: HealingMetricsSink;
}): Promise<HealingAuditWriteAheadSpineEvent> {
  const event = toHealingAuditWriteAheadSpineEvent(input.audit);
  await input.metrics.emitWriteAheadAck(event);
  return event;
}

export async function emitHealingAuditOutcome(input: {
  audit: HealingAuditRecordForSpine;
  outcome: HealingMetricOutcome;
  metrics: HealingMetricsSink;
  timestamp?: string;
}): Promise<HealingAuditOutcomeSpineEvent> {
  const event = toOutcomeEvent({
    audit: input.audit,
    outcome: input.outcome,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  });
  await input.metrics.emitOutcome(event);
  return event;
}
