/**
 * Write-ahead healing audit (C6) — durable record before remediation effect.
 *
 * Fields: policyVersion, patternId, triggerEvidence hash, action enum,
 * subjectId, timestamp. Metadata and pattern ids only — never raw learner
 * content. Mirrors tool-write audit discipline (CK-07 lineage).
 */

import { createHash } from "node:crypto";

export const HEALING_AUDIT_SCHEMA_VERSION =
  "learning.healing-audit.v1" as const;

export const HEALING_AUDIT_MUST_WRITE_AHEAD =
  "self-healing remediations MUST be recorded to the healing audit sink before effect begins (write-ahead audit)." as const;

export const HEALING_AUDIT_OBLIGATION_WRITE_AHEAD =
  "healing_audit.write_ahead" as const;

export const HEALING_AUDIT_RECORD_LIMIT = 128 as const;

/** Closed action enum — aligned with remediation policy action kinds. */
export const HEALING_AUDIT_ACTION_KINDS = Object.freeze([
  "adjust_retry_budget",
  "set_correction_loop_cap",
  "switch_degradation_mode",
  "set_routing_fallback",
] as const);

export type HealingAuditActionKind =
  (typeof HEALING_AUDIT_ACTION_KINDS)[number];

export const FORBIDDEN_HEALING_AUDIT_ACTIONS = Object.freeze([
  "widen_permissions",
  "skip_approval_gate",
  "grant_tool_permission",
] as const);

export type HealingAuditPhase = "write_ahead" | "effect" | "outcome";

export type HealingAuditOutcome =
  | "pending"
  | "ok"
  | "error"
  | "suppressed"
  | "disabled"
  | "aborted";

export type HealingAuditLocality = "on-device" | "self-hosted";

export const HEALING_AUDIT_FAILURE_CLASSES = Object.freeze([
  "correction_exhaustion",
  "degradation",
  "refusal_misfire",
  "tool_timeout",
] as const);

export type HealingAuditFailurePattern =
  (typeof HEALING_AUDIT_FAILURE_CLASSES)[number];

export type HealingAuditFailureClass =
  | "healing_audit.invalid_input"
  | "healing_audit.subject_scope"
  | "healing_audit.cross_subject_denied"
  | "healing_audit.raw_content_forbidden"
  | "healing_audit.write_ahead_required"
  | "healing_audit.ordering_violation"
  | "healing_audit.forbidden_action"
  | "healing_audit.capacity"
  | "healing_audit.idempotent_conflict"
  | "healing_audit.locality_forbidden"
  | "healing_audit.sink_required"
  | "healing_audit.timeout";

export class HealingAuditContractError extends Error {
  readonly obligation: HealingAuditFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: HealingAuditFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "HealingAuditContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

/**
 * Durable healing audit row — hashes and ids only.
 */
export type HealingAuditRecord = {
  schemaVersion: typeof HEALING_AUDIT_SCHEMA_VERSION;
  auditId: string;
  subjectId: string;
  deviceId: string;
  policyVersion: number;
  /** Failure-pattern / policy pattern id (never utterance). */
  patternId: string;
  /** Hash of trigger evidence — never raw evidence bodies. */
  triggerEvidenceHash: string;
  action: HealingAuditActionKind;
  timestamp: string;
  phase: HealingAuditPhase;
  outcome: HealingAuditOutcome;
  idempotencyKey: string;
  locality: HealingAuditLocality;
  /** Stable evaluation/traffic slice tag; never learner content. */
  sliceId?: string;
  failureClass?: HealingAuditFailurePattern;
  seq: number;
};

export type HealingAuditWriteAheadInput = {
  subjectId: string;
  deviceId: string;
  policyVersion: number;
  patternId: string;
  /** Precomputed evidence hash, or raw token that will be hashed (never content). */
  triggerEvidenceHash: string;
  action: HealingAuditActionKind;
  idempotencyKey: string;
  locality?: HealingAuditLocality;
  sliceId?: string;
  failureClass?: HealingAuditFailurePattern;
  auditId?: string;
  timestamp?: string;
};

export type HealingAuditTelemetryEvent = {
  event: "learning.healing_audit";
  outcome: "ok" | "fail" | "advisory" | "idempotent_replay";
  subjectId: string;
  deviceId: string;
  auditId?: string;
  patternId?: string;
  policyVersion?: number;
  action?: HealingAuditActionKind;
  sliceId?: string;
  failureClass?: HealingAuditFailurePattern;
  phase?: HealingAuditPhase;
  auditOutcome?: HealingAuditOutcome;
  obligation?: HealingAuditFailureClass;
};

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH_RE = /^[a-fA-F0-9]{16,128}$/;

/**
 * Hash trigger evidence tokens into a stable metadata fingerprint.
 * Rejects payloads that look like raw learner content.
 */
export function hashTriggerEvidence(input: {
  tokens: readonly string[];
  subjectId?: string;
  deviceId?: string;
}): string {
  for (const token of input.tokens) {
    if (typeof token !== "string" || token.length < 1 || token.length > 256) {
      throw new HealingAuditContractError(
        "trigger evidence token must be a non-empty string ≤256",
        {
          obligation: "healing_audit.invalid_input",
          ...(input.subjectId !== undefined
            ? { subjectId: input.subjectId }
            : {}),
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        },
      );
    }
    if (/utterance|secret|password|prompt\s*:/i.test(token)) {
      throw new HealingAuditContractError(
        "raw learner content is forbidden in trigger evidence",
        {
          obligation: "healing_audit.raw_content_forbidden",
          ...(input.subjectId !== undefined
            ? { subjectId: input.subjectId }
            : {}),
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        },
      );
    }
  }
  return createHash("sha256")
    .update(input.tokens.join("|"), "utf8")
    .digest("hex")
    .slice(0, 64);
}

function assertId(
  value: unknown,
  label: string,
  meta: { subjectId?: string; deviceId?: string },
): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new HealingAuditContractError(
      `${label} must be a stable id (1..128)`,
      {
        obligation: "healing_audit.invalid_input",
        ...(meta.subjectId !== undefined ? { subjectId: meta.subjectId } : {}),
        ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
      },
    );
  }
}

function assertAction(
  action: unknown,
  meta: { subjectId?: string; deviceId?: string },
): asserts action is HealingAuditActionKind {
  if (
    typeof action !== "string" ||
    (FORBIDDEN_HEALING_AUDIT_ACTIONS as readonly string[]).includes(action)
  ) {
    throw new HealingAuditContractError(
      `healing audit action ${String(action)} is forbidden`,
      {
        obligation: "healing_audit.forbidden_action",
        ...(meta.subjectId !== undefined ? { subjectId: meta.subjectId } : {}),
        ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
      },
    );
  }
  if (!(HEALING_AUDIT_ACTION_KINDS as readonly string[]).includes(action)) {
    throw new HealingAuditContractError(
      "healing audit action must be a closed enum value",
      {
        obligation: "healing_audit.invalid_input",
        ...(meta.subjectId !== undefined ? { subjectId: meta.subjectId } : {}),
        ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
      },
    );
  }
}

function normalizeWriteAheadInput(
  input: HealingAuditWriteAheadInput,
): HealingAuditWriteAheadInput {
  const subjectId = input.subjectId.trim();
  const deviceId = input.deviceId.trim();
  assertId(subjectId, "subjectId", { deviceId });
  assertId(deviceId, "deviceId", { subjectId });
  assertId(input.patternId, "patternId", { subjectId, deviceId });
  assertId(input.idempotencyKey, "idempotencyKey", { subjectId, deviceId });
  assertAction(input.action, { subjectId, deviceId });
  if (input.sliceId !== undefined) {
    assertId(input.sliceId, "sliceId", { subjectId, deviceId });
  }
  if (
    input.failureClass !== undefined &&
    !(HEALING_AUDIT_FAILURE_CLASSES as readonly string[]).includes(
      input.failureClass,
    )
  ) {
    throw new HealingAuditContractError("unknown healing failure class", {
      obligation: "healing_audit.invalid_input",
      subjectId,
      deviceId,
    });
  }

  if (
    typeof input.policyVersion !== "number" ||
    !Number.isInteger(input.policyVersion) ||
    input.policyVersion < 1 ||
    input.policyVersion > 1_000_000
  ) {
    throw new HealingAuditContractError(
      "policyVersion must be a positive integer",
      {
        obligation: "healing_audit.invalid_input",
        subjectId,
        deviceId,
      },
    );
  }

  let hash = input.triggerEvidenceHash.trim();
  if (!HASH_RE.test(hash)) {
    // Accept opaque fingerprints by hashing them once into a fixed digest.
    hash = hashTriggerEvidence({
      tokens: [hash],
      subjectId,
      deviceId,
    });
  }

  const locality = input.locality ?? "on-device";
  if (locality !== "on-device" && locality !== "self-hosted") {
    throw new HealingAuditContractError(
      "locality must be on-device or self-hosted",
      {
        obligation: "healing_audit.locality_forbidden",
        subjectId,
        deviceId,
      },
    );
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (
      /utterance|content|body|prompt|secret/i.test(key) ||
      (typeof value === "string" &&
        /utterance|secret learner/i.test(value) &&
        key !== "triggerEvidenceHash")
    ) {
      throw new HealingAuditContractError(
        `raw content field ${key} is forbidden on healing audit`,
        {
          obligation: "healing_audit.raw_content_forbidden",
          subjectId,
          deviceId,
        },
      );
    }
  }

  return {
    subjectId,
    deviceId,
    policyVersion: input.policyVersion,
    patternId: input.patternId,
    triggerEvidenceHash: hash.slice(0, 128),
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    locality,
    ...(input.sliceId !== undefined ? { sliceId: input.sliceId } : {}),
    ...(input.failureClass !== undefined
      ? { failureClass: input.failureClass }
      : {}),
    ...(input.auditId !== undefined ? { auditId: input.auditId } : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  };
}

export type HealingAuditSink = {
  /**
   * Write-ahead record. MUST complete before remediation effect begins.
   * Duplicate idempotencyKey → return prior row (no second durable write).
   */
  recordWriteAhead(
    input: HealingAuditWriteAheadInput,
  ): HealingAuditRecord | Promise<HealingAuditRecord>;

  /** Append outcome after effect (or abort). */
  recordOutcome(input: {
    auditId: string;
    subjectId: string;
    outcome: Exclude<HealingAuditOutcome, "pending">;
    phase?: Exclude<HealingAuditPhase, "write_ahead">;
  }): HealingAuditRecord | Promise<HealingAuditRecord>;

  /** Bounded timeline for operators / conformance. */
  records(subjectId?: string): readonly HealingAuditRecord[];

  /** True when write-ahead exists for this idempotency key. */
  hasWriteAhead(idempotencyKey: string): boolean;
};

type KeyState = {
  audited: boolean;
  effectDone: boolean;
  auditId: string;
  subjectId: string;
};

/**
 * In-memory subject-scoped healing audit sink (write-ahead).
 */
export function createInMemoryHealingAuditSink(options?: {
  limit?: number;
  expectedSubjectId?: string;
  onTelemetry?: (event: HealingAuditTelemetryEvent) => void;
}): HealingAuditSink {
  const limit = options?.limit ?? HEALING_AUDIT_RECORD_LIMIT;
  const log: HealingAuditRecord[] = [];
  const byKey = new Map<string, KeyState>();
  let seq = 0;

  const emit = (event: HealingAuditTelemetryEvent): void => {
    options?.onTelemetry?.(event);
  };

  return {
    async recordWriteAhead(raw) {
      const input = normalizeWriteAheadInput(raw);
      if (
        options?.expectedSubjectId !== undefined &&
        input.subjectId !== options.expectedSubjectId
      ) {
        emit({
          event: "learning.healing_audit",
          outcome: "fail",
          subjectId: options.expectedSubjectId,
          deviceId: input.deviceId,
          obligation: "healing_audit.cross_subject_denied",
        });
        throw new HealingAuditContractError(
          "cross-subject healing audit write denied",
          {
            obligation: "healing_audit.cross_subject_denied",
            subjectId: options.expectedSubjectId,
            deviceId: input.deviceId,
          },
        );
      }

      const existing = byKey.get(input.idempotencyKey);
      if (existing?.audited) {
        const prior = [...log]
          .reverse()
          .find((row) => row.auditId === existing.auditId);
        if (prior === undefined) {
          throw new HealingAuditContractError(
            "idempotent healing audit row missing",
            {
              obligation: "healing_audit.idempotent_conflict",
              subjectId: input.subjectId,
              deviceId: input.deviceId,
            },
          );
        }
        if (
          prior.patternId !== input.patternId ||
          prior.policyVersion !== input.policyVersion ||
          prior.action !== input.action ||
          prior.sliceId !== input.sliceId ||
          prior.failureClass !== input.failureClass
        ) {
          throw new HealingAuditContractError(
            "idempotency key conflict for healing audit",
            {
              obligation: "healing_audit.idempotent_conflict",
              subjectId: input.subjectId,
              deviceId: input.deviceId,
            },
          );
        }
        emit({
          event: "learning.healing_audit",
          outcome: "idempotent_replay",
          subjectId: prior.subjectId,
          deviceId: prior.deviceId,
          auditId: prior.auditId,
          patternId: prior.patternId,
          policyVersion: prior.policyVersion,
          action: prior.action,
          ...(prior.sliceId !== undefined ? { sliceId: prior.sliceId } : {}),
          ...(prior.failureClass !== undefined
            ? { failureClass: prior.failureClass }
            : {}),
          phase: "write_ahead",
          auditOutcome: prior.outcome,
        });
        return prior;
      }

      if (log.length >= limit) {
        throw new HealingAuditContractError("healing audit sink at capacity", {
          obligation: "healing_audit.capacity",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        });
      }

      seq += 1;
      const auditId = input.auditId ?? `heal.audit.${seq}`;
      assertId(auditId, "auditId", {
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      });
      const record: HealingAuditRecord = {
        schemaVersion: HEALING_AUDIT_SCHEMA_VERSION,
        auditId,
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        policyVersion: input.policyVersion,
        patternId: input.patternId,
        triggerEvidenceHash: input.triggerEvidenceHash,
        action: input.action,
        timestamp: input.timestamp ?? new Date().toISOString(),
        phase: "write_ahead",
        outcome: "pending",
        idempotencyKey: input.idempotencyKey,
        locality: input.locality ?? "on-device",
        ...(input.sliceId !== undefined ? { sliceId: input.sliceId } : {}),
        ...(input.failureClass !== undefined
          ? { failureClass: input.failureClass }
          : {}),
        seq,
      };
      log.push(record);
      byKey.set(input.idempotencyKey, {
        audited: true,
        effectDone: false,
        auditId,
        subjectId: input.subjectId,
      });
      emit({
        event: "learning.healing_audit",
        outcome: "ok",
        subjectId: record.subjectId,
        deviceId: record.deviceId,
        auditId: record.auditId,
        patternId: record.patternId,
        policyVersion: record.policyVersion,
        action: record.action,
        ...(record.sliceId !== undefined ? { sliceId: record.sliceId } : {}),
        ...(record.failureClass !== undefined
          ? { failureClass: record.failureClass }
          : {}),
        phase: "write_ahead",
        auditOutcome: "pending",
      });
      return record;
    },

    async recordOutcome(input) {
      assertId(input.auditId, "auditId", { subjectId: input.subjectId });
      assertId(input.subjectId, "subjectId", {});
      const prior = [...log]
        .reverse()
        .find((row) => row.auditId === input.auditId);
      if (prior === undefined) {
        throw new HealingAuditContractError(
          "healing audit outcome requires prior write-ahead",
          {
            obligation: "healing_audit.write_ahead_required",
            subjectId: input.subjectId,
          },
        );
      }
      if (prior.subjectId !== input.subjectId) {
        throw new HealingAuditContractError(
          "cross-subject healing audit outcome denied",
          {
            obligation: "healing_audit.cross_subject_denied",
            subjectId: input.subjectId,
            deviceId: prior.deviceId,
          },
        );
      }
      if (log.length >= limit) {
        throw new HealingAuditContractError("healing audit sink at capacity", {
          obligation: "healing_audit.capacity",
          subjectId: input.subjectId,
          deviceId: prior.deviceId,
        });
      }
      seq += 1;
      const phase = input.phase ?? "outcome";
      const row: HealingAuditRecord = {
        ...prior,
        phase,
        outcome: input.outcome,
        timestamp: new Date().toISOString(),
        seq,
      };
      log.push(row);
      const keyState = byKey.get(prior.idempotencyKey);
      if (keyState !== undefined) {
        byKey.set(prior.idempotencyKey, {
          ...keyState,
          effectDone: true,
        });
      }
      emit({
        event: "learning.healing_audit",
        outcome: input.outcome === "ok" ? "ok" : "advisory",
        subjectId: row.subjectId,
        deviceId: row.deviceId,
        auditId: row.auditId,
        patternId: row.patternId,
        policyVersion: row.policyVersion,
        action: row.action,
        ...(row.sliceId !== undefined ? { sliceId: row.sliceId } : {}),
        ...(row.failureClass !== undefined
          ? { failureClass: row.failureClass }
          : {}),
        phase,
        auditOutcome: input.outcome,
      });
      return row;
    },

    records(subjectId) {
      if (subjectId === undefined) return log.slice();
      return log.filter((row) => row.subjectId === subjectId);
    },

    hasWriteAhead(idempotencyKey) {
      return byKey.get(idempotencyKey)?.audited === true;
    },
  };
}

/**
 * Assert write-ahead exists before allowing remediation effect.
 */
export function assertHealingWriteAhead(input: {
  sink: HealingAuditSink;
  idempotencyKey: string;
  subjectId: string;
  deviceId?: string;
}): void {
  if (!input.sink.hasWriteAhead(input.idempotencyKey)) {
    throw new HealingAuditContractError(
      `write-ahead audit missing before effect (${HEALING_AUDIT_MUST_WRITE_AHEAD})`,
      {
        obligation: "healing_audit.write_ahead_required",
        subjectId: input.subjectId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      },
    );
  }
}

/**
 * Run remediation effect only after a durable write-ahead audit row exists.
 * Partial failure after write-ahead leaves the pending row for replay.
 */
export async function runWithHealingWriteAhead<T>(input: {
  sink: HealingAuditSink | null | undefined;
  writeAhead: HealingAuditWriteAheadInput;
  effect: (audit: HealingAuditRecord) => T | Promise<T>;
  onTelemetry?: (event: HealingAuditTelemetryEvent) => void;
  /** Optional P3 spine hook after durable write-ahead. */
  onWriteAheadDurable?: (audit: HealingAuditRecord) => void | Promise<void>;
  /** Optional P3 spine hook after the terminal outcome is durable. */
  onOutcomeDurable?: (audit: HealingAuditRecord) => void | Promise<void>;
}): Promise<{ audit: HealingAuditRecord; result: T }> {
  if (input.sink == null) {
    throw new HealingAuditContractError(
      "healing audit sink required before remediation",
      {
        obligation: "healing_audit.sink_required",
        subjectId: input.writeAhead.subjectId,
        deviceId: input.writeAhead.deviceId,
      },
    );
  }
  const audit = await input.sink.recordWriteAhead(input.writeAhead);
  assertHealingWriteAhead({
    sink: input.sink,
    idempotencyKey: audit.idempotencyKey,
    subjectId: audit.subjectId,
    deviceId: audit.deviceId,
  });
  if (input.onWriteAheadDurable !== undefined) {
    await input.onWriteAheadDurable(audit);
  }
  try {
    const result = await input.effect(audit);
    const outcomeAudit = await input.sink.recordOutcome({
      auditId: audit.auditId,
      subjectId: audit.subjectId,
      outcome: "ok",
      phase: "effect",
    });
    if (input.onOutcomeDurable !== undefined) {
      await input.onOutcomeDurable(outcomeAudit);
    }
    return { audit, result };
  } catch (error) {
    const outcomeAudit = await input.sink.recordOutcome({
      auditId: audit.auditId,
      subjectId: audit.subjectId,
      outcome: "error",
      phase: "outcome",
    });
    if (input.onOutcomeDurable !== undefined) {
      await input.onOutcomeDurable(outcomeAudit);
    }
    input.onTelemetry?.({
      event: "learning.healing_audit",
      outcome: "fail",
      subjectId: audit.subjectId,
      deviceId: audit.deviceId,
      auditId: audit.auditId,
      obligation: "healing_audit.ordering_violation",
    });
    throw error;
  }
}
