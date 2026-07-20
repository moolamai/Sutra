/**
 * @module tool_audit
 *
 * AuditSink contract + in-memory write-ahead recorder.
 *
 * Verbatim CK-07.2 MUST (from `@moolam/contracts` ToolInterface):
 *   "write"/"critical" invocations MUST be recorded to the audit sink
 *   before execution begins (write-ahead audit).
 *
 * `recordInvocation()` is awaited before `tools.invoke` for write/critical.
 * Read/compute skip. Sink failure / timeout aborts — never effect without
 * a durable audit when required. Act-stage acknowledgement hardening is
 * .
 */

import { createHash } from "node:crypto";
import type {
  ToolDescriptor,
  ToolInvocation,
  ToolResult,
} from "@moolam/contracts";

type ToolRiskClass = ToolDescriptor["riskClass"];

/** Verbatim MUST from packages/contracts/src/tool.ts requirement #2. */
export const TOOL_AUDIT_MUST_WRITE_AHEAD =
  '"write"/"critical" invocations MUST be recorded to the audit sink before execution begins (write-ahead audit).';

/** CK-07.2 obligation id. */
export const TOOL_AUDIT_OBLIGATION_WRITE_AHEAD = "CK-07.2";

/** Write/critical invoke with no AuditSink configured. */
export const TOOL_AUDIT_OBLIGATION_SINK_REQUIRED = "TOOL.AUDIT_SINK_REQUIRED";

/** Audit acknowledgment raced past deadline — effect must not start. */
export const TOOL_AUDIT_OBLIGATION_SINK_TIMEOUT = "TOOL.AUDIT_SINK_TIMEOUT";

/** Bounded audit timeline (NFR). */
export const TOOL_AUDIT_RECORD_LIMIT = 64;

export type ToolAuditPhase = "audit" | "effect" | "failure";

export type ToolAuditOutcome =
  | "pending"
  | "ok"
  | "error"
  | "denied"
  | "aborted";

/** Durable audit entry — argsHash only, never raw argument bodies. */
export type ToolAuditEntry = {
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  toolName: string;
  invocationId: string;
  riskClass: ToolRiskClass;
  argsHash: string;
  timestamp: string;
  phase: ToolAuditPhase;
  idempotencyKey: string;
  outcome: ToolAuditOutcome;
  seq: number;
};

export type ToolAuditRecordInvocationInput = {
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  toolName: string;
  invocationId: string;
  riskClass: ToolRiskClass;
  /** Stable hash of arguments — never plaintext learner content. */
  argsHash: string;
  /** Defaults to invocationId. */
  idempotencyKey?: string;
};

/**
 * Injected audit sink. Hosts may persist remotely; in-memory ref ships for tests.
 */
export interface AuditSink {
  /**
   * Write-ahead record. MUST complete (sync or awaited) before effect begins.
   * Duplicate idempotencyKey → audit once (no second durable row / no second effect).
   */
  recordInvocation(
    input: ToolAuditRecordInvocationInput,
  ): void | Promise<void>;

  /**
   * Append / update outcome after effect. Retains the prior audit row when
   * the tool throws mid-flight.
   */
  recordOutcome(
    invocationId: string,
    outcome: Exclude<ToolAuditOutcome, "pending">,
  ): void | Promise<void>;

  /** Bounded timeline for conformance / operators. */
  records(): readonly ToolAuditEntry[];

  /** Optional at-most-once effect cache (in-memory sink implements). */
  peekIdempotentResult?(idempotencyKey: string): ToolResult | null;
  rememberIdempotentResult?(
    idempotencyKey: string,
    result: ToolResult,
  ): void;
}

export class ToolAuditError extends Error {
  readonly obligationId: string | null;
  readonly failureClass: "validation" | "contract" | "config" | "downstream" | "cap";
  readonly errorCode: string | null;

  constructor(
    message: string,
    opts: {
      obligationId?: string | null;
      failureClass?: "validation" | "contract" | "config" | "downstream" | "cap";
      errorCode?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "ToolAuditError";
    this.obligationId = opts.obligationId ?? null;
    this.failureClass = opts.failureClass ?? "config";
    this.errorCode = opts.errorCode ?? null;
  }
}

export type ToolAuditEvent = {
  event: "cognitive_core.tool_audit";
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  outcome: "recorded" | "skipped_read" | "idempotent" | "timeout" | "error";
  riskClass: ToolRiskClass;
  toolName: string;
  invocationId: string;
  phase?: ToolAuditPhase;
  failureClass?: "validation" | "contract" | "config" | "downstream" | "cap";
  errorCode?: string;
};

export function requiresWriteAheadAudit(riskClass: ToolRiskClass): boolean {
  return riskClass === "write" || riskClass === "critical";
}

/**
 * Conformance check (CK-07.2): for write/critical, any effect/failure marker
 * must be preceded by an audit row for the same invocationId.
 */
export function assertAuditBeforeEffect(
  records: readonly ToolAuditEntry[],
  invocationId: string,
  riskClass: ToolRiskClass,
): void {
  if (!requiresWriteAheadAudit(riskClass)) return;
  const id = invocationId.trim();
  if (!id) {
    throw new ToolAuditError("assertAuditBeforeEffect requires invocationId", {
      failureClass: "validation",
      errorCode: "INVOCATION_REQUIRED",
    });
  }
  const relevant = records
    .filter((r) => r.invocationId === id)
    .slice(0, TOOL_AUDIT_RECORD_LIMIT);
  let auditSeq: number | null = null;
  let postSeq: number | null = null;
  for (const r of relevant) {
    if (r.phase === "audit" && auditSeq === null) auditSeq = r.seq;
    if (
      (r.phase === "effect" || r.phase === "failure") &&
      postSeq === null
    ) {
      postSeq = r.seq;
    }
  }
  if (postSeq === null && auditSeq === null) {
    // Policy deny / short-circuit before write-ahead — nothing to order.
    return;
  }
  if (auditSeq === null) {
    throw new ToolAuditError(
      `write-ahead audit missing before effect (${TOOL_AUDIT_MUST_WRITE_AHEAD})`,
      {
        obligationId: TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
        failureClass: "contract",
        errorCode: "AUDIT_MISSING",
      },
    );
  }
  if (postSeq !== null && postSeq < auditSeq) {
    throw new ToolAuditError(
      `audit-after-effect ordering violation (${TOOL_AUDIT_MUST_WRITE_AHEAD})`,
      {
        obligationId: TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
        failureClass: "contract",
        errorCode: "AUDIT_AFTER_EFFECT",
      },
    );
  }
}

/**
 * Stable args hash for audit rows — never embeds raw argument values.
 */
export function hashToolArguments(args: Record<string, unknown>): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(args));
  } catch {
    serialized = `"unserializable:${Object.keys(args).length}"`;
  }
  return createHash("sha256").update(serialized).digest("hex").slice(0, 32);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = canonicalize(obj[k]);
    return out;
  }
  return value;
}

function raceDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const budget = Math.max(1, Math.min(deadlineMs, 60_000));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: false }), budget);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

type KeyState = {
  audited: boolean;
  effectDone: boolean;
  result: ToolResult | null;
};

/**
 * In-memory reference AuditSink — ordered, bounded, subject-scoped rows.
 */
export function createInMemoryAuditSink(
  limit: number = TOOL_AUDIT_RECORD_LIMIT,
): AuditSink {
  const log: ToolAuditEntry[] = [];
  const byKey = new Map<string, KeyState>();
  const results = new Map<string, ToolResult>();
  let seq = 0;

  return {
    async recordInvocation(input) {
      const subjectId = input.subjectId.trim();
      const sessionId = input.sessionId.trim();
      if (!subjectId) {
        throw new ToolAuditError("audit requires subjectId (subject isolation)", {
          failureClass: "validation",
          errorCode: "SUBJECT_REQUIRED",
        });
      }
      if (!sessionId) {
        throw new ToolAuditError("audit requires sessionId", {
          failureClass: "validation",
          errorCode: "SESSION_REQUIRED",
        });
      }
      const key = (input.idempotencyKey ?? input.invocationId).trim();
      if (!key) {
        throw new ToolAuditError("audit requires idempotencyKey", {
          failureClass: "validation",
          errorCode: "IDEMPOTENCY_REQUIRED",
        });
      }
      const existing = byKey.get(key);
      if (existing?.audited) {
        return;
      }
      if (log.length >= limit) {
        throw new ToolAuditError("audit sink at capacity", {
          obligationId: TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
          failureClass: "cap",
          errorCode: "AUDIT_CAPACITY",
        });
      }
      seq += 1;
      log.push({
        subjectId,
        sessionId,
        ...(input.deviceId !== undefined
          ? { deviceId: input.deviceId.trim().slice(0, 64) }
          : {}),
        toolName: input.toolName.trim().slice(0, 64),
        invocationId: input.invocationId.trim().slice(0, 128),
        riskClass: input.riskClass,
        argsHash: input.argsHash.slice(0, 64),
        timestamp: new Date().toISOString(),
        phase: "audit",
        idempotencyKey: key.slice(0, 128),
        outcome: "pending",
        seq,
      });
      byKey.set(key, {
        audited: true,
        effectDone: existing?.effectDone ?? false,
        result: existing?.result ?? null,
      });
    },

    async recordOutcome(invocationId, outcome) {
      const id = invocationId.trim();
      for (let i = log.length - 1; i >= 0; i--) {
        const row = log[i]!;
        if (row.invocationId !== id) continue;
        if (outcome === "aborted" || outcome === "error") {
          if (log.length < limit) {
            seq += 1;
            log.push({
              ...row,
              phase: "failure",
              outcome,
              seq,
              timestamp: new Date().toISOString(),
            });
          }
          row.outcome = outcome;
        } else {
          if (log.length < limit) {
            seq += 1;
            log.push({
              ...row,
              phase: "effect",
              outcome,
              seq,
              timestamp: new Date().toISOString(),
            });
          }
          row.outcome = outcome;
        }
        const st = byKey.get(row.idempotencyKey);
        if (st) {
          st.effectDone = true;
        }
        return;
      }
    },

    records: () => log,

    peekIdempotentResult(idempotencyKey) {
      return results.get(idempotencyKey.trim()) ?? null;
    },

    rememberIdempotentResult(idempotencyKey, result) {
      const key = idempotencyKey.trim();
      if (!key || results.size >= limit) return;
      results.set(key, result);
      const st = byKey.get(key);
      if (st) {
        st.effectDone = true;
        st.result = result;
      }
    },
  };
}

export type WriteAheadInvokeInput = {
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  invocation: ToolInvocation;
  riskClass: ToolRiskClass;
  deadlineMs: number;
  auditSink: AuditSink | null | undefined;
  emit?: (event: ToolAuditEvent) => void;
  invoke: () => Promise<ToolResult>;
};

/**
 * For write/critical: `recordInvocation` then `await invoke`.
 * Read/compute: skip audit. Missing sink / timeout → ToolAuditError (no effect).
 */
export async function recordThenInvoke(
  input: WriteAheadInvokeInput,
): Promise<ToolResult> {
  const subjectId = input.subjectId.trim();
  const sessionId = input.sessionId.trim();
  const toolName = input.invocation.toolName.trim().slice(0, 64);
  const invocationId = input.invocation.invocationId.trim().slice(0, 128);
  const baseEvent = {
    event: "cognitive_core.tool_audit" as const,
    subjectId,
    sessionId,
    ...(input.deviceId !== undefined
      ? { deviceId: input.deviceId.trim().slice(0, 64) }
      : {}),
    riskClass: input.riskClass,
    toolName,
    invocationId,
  };

  if (!requiresWriteAheadAudit(input.riskClass)) {
    input.emit?.({ ...baseEvent, outcome: "skipped_read" });
    return input.invoke();
  }

  const sink = input.auditSink;
  if (!sink) {
    const err = new ToolAuditError(
      `write-ahead audit required for ${input.riskClass} (${TOOL_AUDIT_MUST_WRITE_AHEAD})`,
      {
        obligationId: TOOL_AUDIT_OBLIGATION_SINK_REQUIRED,
        failureClass: "config",
        errorCode: "AUDIT_SINK_REQUIRED",
      },
    );
    input.emit?.({
      ...baseEvent,
      outcome: "error",
      failureClass: "config",
      errorCode: "AUDIT_SINK_REQUIRED",
    });
    throw err;
  }

  const idempotencyKey = invocationId;
  const cached = sink.peekIdempotentResult?.(idempotencyKey) ?? null;
  if (cached) {
    input.emit?.({ ...baseEvent, outcome: "idempotent", phase: "audit" });
    return cached;
  }

  const argsHash = hashToolArguments(
    input.invocation.arguments && typeof input.invocation.arguments === "object"
      ? input.invocation.arguments
      : {},
  );

  const recordPromise = Promise.resolve(
    sink.recordInvocation({
      subjectId,
      sessionId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      toolName,
      invocationId,
      riskClass: input.riskClass,
      argsHash,
      idempotencyKey,
    }),
  );

  let raced: { ok: true; value: void } | { ok: false };
  try {
    raced = await raceDeadline(recordPromise, input.deadlineMs);
  } catch (err) {
    input.emit?.({
      ...baseEvent,
      outcome: "error",
      failureClass: "downstream",
      errorCode: "AUDIT_SINK_FAILED",
    });
    if (err instanceof ToolAuditError) throw err;
    throw new ToolAuditError("audit sink failed before effect", {
      obligationId: TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
      failureClass: "downstream",
      errorCode: "AUDIT_SINK_FAILED",
    });
  }

  if (!raced.ok) {
    const err = new ToolAuditError("audit sink timed out before effect", {
      obligationId: TOOL_AUDIT_OBLIGATION_SINK_TIMEOUT,
      failureClass: "cap",
      errorCode: "AUDIT_SINK_TIMEOUT",
    });
    input.emit?.({
      ...baseEvent,
      outcome: "timeout",
      failureClass: "cap",
      errorCode: "AUDIT_SINK_TIMEOUT",
    });
    throw err;
  }

  input.emit?.({ ...baseEvent, outcome: "recorded", phase: "audit" });

  try {
    const result = await input.invoke();
    await Promise.resolve(
      sink.recordOutcome(
        invocationId,
        result.status === "ok" ? "ok" : "error",
      ),
    );
    sink.rememberIdempotentResult?.(idempotencyKey, result);
    return result;
  } catch (err) {
    try {
      await Promise.resolve(sink.recordOutcome(invocationId, "aborted"));
    } catch {
      // Retain best-effort; still surface the original effect failure.
    }
    throw err;
  }
}
