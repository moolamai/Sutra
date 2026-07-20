/**
 * Emergency abort pipeline — per-turn AbortController registry, effect journal
 * with rollback/compensate, and idempotency-lock release.
 *
 * Active turns register under turnId with a subject-scoped controller. abort()
 * cascades AbortSignal to model + sandbox, reverses mid-write journal entries
 * (or abandons never-committed), and releases idempotency locks in a finally
 * block. Accept vs abort: if TURN_COMPLETE recorded with committed effects,
 * abort returns already_completed.
 *
 * Successful first abort records AGENT_MANUAL_ABORT on an injected audit sink
 * (subjectId + turnId + reason; never learner content).
 */

/** Soft cap on concurrent registered turns (NFR — no unbounded growth). */
export const ABORT_REGISTRY_LIMIT = 256;

/** Soft cap on journal entries per turn. */
export const ABORT_JOURNAL_LIMIT = 64;

/** Soft cap on held idempotency locks (process-local). */
export const ABORT_LOCK_LIMIT = 512;

/** Soft cap on in-memory abort audit rows. */
export const ABORT_AUDIT_RECORD_LIMIT = 256;

/** Abort reason string for AbortSignal / AbortError consumers. */
export const ABORT_REASON_MANUAL = "AGENT_MANUAL_ABORT";

/** Audit event name written on successful first abort (CK-07). */
export const AGENT_MANUAL_ABORT_AUDIT_EVENT = "AGENT_MANUAL_ABORT" as const;

/**
 * POST /v1/agent/turn/{id}/abort `action` values (CK-07 accept-vs-abort).
 * API and in-process registry must stay byte/string identical.
 */
export const ACCEPT_VS_ABORT_ACTIONS = Object.freeze([
  "aborted",
  "already_aborted",
  "already_completed",
] as const);

export type AcceptVsAbortAction = (typeof ACCEPT_VS_ABORT_ACTIONS)[number];

export type AbortPipelineFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "not_found"
  | "duplicate_turn"
  | "registry_full"
  | "invalid_turn"
  | "journal_full"
  | "invalid_effect"
  | "lock_held"
  | "lock_table_full";

export type TurnAbortStatus = "active" | "aborted" | "completed";

export type EffectJournalStatus =
  | "pending"
  | "mid_write"
  | "committed"
  | "abandoned"
  | "rolled_back";

export type EffectJournalEntry = {
  effectId: string;
  toolName?: string;
  idempotencyKey?: string;
  status: EffectJournalStatus;
  recordedAt: number;
  /** Opaque risk hint for operators — never learner content. */
  riskClass?: "read" | "write" | "critical";
};

/**
 * Compensating action for mid-write / pre-commit effects (tool descriptor
 * supplied by host). Must be subject-scoped by the caller; never logs payloads.
 */
export type EffectCompensateFn = (
  entry: EffectJournalEntry,
  ctx: { subjectId: string; turnId: string },
) => void | Promise<void>;

export type AbortPipelineTelemetryEvent = {
  event: "runtime.harness.abort_pipeline";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  turnId?: string;
  action?:
    | "registered"
    | "aborted"
    | "already_aborted"
    | "already_completed"
    | "completed"
    | "journal_append"
    | "journal_commit"
    | "locks_released"
    | "rollback"
    | "audit_recorded";
  failureClass?: AbortPipelineFailureClass;
  /** Milliseconds from abort() call to signal cascade + rollback complete. */
  cascadeLatencyMs?: number;
  uncommittedCount?: number;
  rolledBackCount?: number;
  abandonedCount?: number;
  locksReleased?: number;
  compensateFailures?: number;
  activeTurns?: number;
};

/** Durable abort audit row — metadata only (no utterance / tool payloads). */
export type AgentManualAbortAuditRecord = {
  event: typeof AGENT_MANUAL_ABORT_AUDIT_EVENT;
  subjectId: string;
  turnId: string;
  /** Opaque abort reason code (defaults to AGENT_MANUAL_ABORT). */
  reason: string;
  deviceId?: string;
  principalId?: string;
  rolledBackCount: number;
  abandonedCount: number;
  locksReleased: number;
  recordedAt: string;
};

/**
 * Injected abort audit sink. Hosts may persist remotely; in-memory ships for
 * tests and the cloud reference orchestrator.
 */
export interface AbortAuditSink {
  recordManualAbort(
    record: AgentManualAbortAuditRecord,
  ): void | Promise<void>;
}

/**
 * Deterministic in-process audit sink. Idempotent per subjectId+turnId.
 */
export class InMemoryAbortAuditSink implements AbortAuditSink {
  private readonly records: AgentManualAbortAuditRecord[] = [];
  private readonly seen = new Set<string>();

  get size(): number {
    return this.records.length;
  }

  list(): readonly AgentManualAbortAuditRecord[] {
    return this.records.slice();
  }

  clear(): void {
    this.records.length = 0;
    this.seen.clear();
  }

  recordManualAbort(record: AgentManualAbortAuditRecord): void {
    const sid =
      typeof record.subjectId === "string" ? record.subjectId.trim() : "";
    const tid = typeof record.turnId === "string" ? record.turnId.trim() : "";
    if (!sid || !tid) return;
    if (record.event !== AGENT_MANUAL_ABORT_AUDIT_EVENT) return;
    const key = `${sid}\0${tid}`;
    if (this.seen.has(key)) return;
    if (this.records.length >= ABORT_AUDIT_RECORD_LIMIT) {
      const oldest = this.records.shift();
      if (oldest) {
        this.seen.delete(`${oldest.subjectId}\0${oldest.turnId}`);
      }
    }
    const stored: AgentManualAbortAuditRecord = {
      event: AGENT_MANUAL_ABORT_AUDIT_EVENT,
      subjectId: sid,
      turnId: tid,
      reason: (record.reason || ABORT_REASON_MANUAL).trim().slice(0, 64),
      rolledBackCount: record.rolledBackCount,
      abandonedCount: record.abandonedCount,
      locksReleased: record.locksReleased,
      recordedAt: record.recordedAt || new Date().toISOString(),
      ...(record.deviceId !== undefined
        ? { deviceId: String(record.deviceId).slice(0, 64) }
        : {}),
      ...(record.principalId !== undefined
        ? { principalId: String(record.principalId).slice(0, 128) }
        : {}),
    };
    this.seen.add(key);
    this.records.push(stored);
  }
}

export type AbortPipelineOptions = {
  maxActiveTurns?: number;
  lockTable?: IdempotencyLockTable;
  auditSink?: AbortAuditSink;
  onTelemetry?: (event: AbortPipelineTelemetryEvent) => void;
};

export type RegisterTurnOptions = {
  turnId: string;
  subjectId: string;
  deviceId?: string;
};

export type RegisterTurnAccepted = {
  ok: true;
  handle: TurnAbortHandle;
};

export type RegisterTurnRejected = {
  ok: false;
  failureClass: AbortPipelineFailureClass;
  detail: string;
  subjectId: string | null;
};

export type RegisterTurnResult = RegisterTurnAccepted | RegisterTurnRejected;

export type AbortTurnOptions = {
  subjectId: string;
  /** Optional opaque reason code for telemetry (never learner content). */
  reason?: string;
  /** Optional caller principal for the audit row (never credentials). */
  principalId?: string;
};

export type AbortTurnAccepted = {
  ok: true;
  action: "aborted" | "already_aborted" | "already_completed";
  turnId: string;
  subjectId: string;
  /** True when AbortSignal was fired on this call (first abort). */
  signalCascaded: boolean;
  cascadeLatencyMs: number;
  /** Pending/mid-write entries handled on this abort (abandoned + rolled back). */
  uncommittedCount: number;
  rolledBackCount: number;
  abandonedCount: number;
  locksReleased: number;
  compensateFailures: number;
  /** True when AGENT_MANUAL_ABORT was written on this call. */
  auditRecorded: boolean;
  status: TurnAbortStatus;
};

export type AbortTurnRejected = {
  ok: false;
  failureClass: AbortPipelineFailureClass;
  detail: string;
  subjectId: string | null;
  turnId: string | null;
};

export type AbortTurnResult = AbortTurnAccepted | AbortTurnRejected;

export type MarkTurnCompletedOptions = {
  subjectId: string;
  /**
   * When true, durable effects were committed and TURN_COMPLETE was (or will
   * be) sent — subsequent abort() returns already_completed.
   */
  effectsCommitted: boolean;
};

export type MarkTurnCompletedResult =
  | {
      ok: true;
      turnId: string;
      subjectId: string;
      status: "completed";
      effectsCommitted: boolean;
    }
  | {
      ok: false;
      failureClass: AbortPipelineFailureClass;
      detail: string;
      subjectId: string | null;
      turnId: string | null;
    };

export type AppendEffectInput = {
  effectId: string;
  toolName?: string;
  idempotencyKey?: string;
  riskClass?: "read" | "write" | "critical";
  /**
   * Durable side effect may have started — abort must compensate
   * (rollback) rather than only abandon.
   */
  midWrite?: boolean;
  /** Compensator invoked once on first abort for mid-write / pending reverse. */
  compensate?: EffectCompensateFn;
};

/**
 * Process-local idempotency lock table. Keys released on abort (finally) so
 * retries can re-acquire safely.
 */
export class IdempotencyLockTable {
  private readonly locks = new Map<
    string,
    { subjectId: string; turnId: string }
  >();
  private readonly maxLocks: number;

  constructor(maxLocks: number = ABORT_LOCK_LIMIT) {
    if (!Number.isInteger(maxLocks) || maxLocks < 1 || maxLocks > 8192) {
      throw new Error("maxLocks must be an integer in 1..8192");
    }
    this.maxLocks = maxLocks;
  }

  get size(): number {
    return this.locks.size;
  }

  isHeld(key: string): boolean {
    const k = typeof key === "string" ? key.trim() : "";
    return k.length > 0 && this.locks.has(k);
  }

  acquire(
    key: string,
    scope: { subjectId: string; turnId: string },
  ):
    | { ok: true; key: string }
    | { ok: false; failureClass: AbortPipelineFailureClass; detail: string } {
    const k = typeof key === "string" ? key.trim() : "";
    const subjectId =
      typeof scope.subjectId === "string" ? scope.subjectId.trim() : "";
    const turnId = typeof scope.turnId === "string" ? scope.turnId.trim() : "";
    if (!k || !subjectId || !turnId) {
      return {
        ok: false,
        failureClass: "invalid_effect",
        detail: "lock key and scope required",
      };
    }
    const held = this.locks.get(k);
    if (held) {
      if (held.subjectId === subjectId && held.turnId === turnId) {
        return { ok: true, key: k };
      }
      return {
        ok: false,
        failureClass: "lock_held",
        detail: "idempotency key held by another turn",
      };
    }
    if (this.locks.size >= this.maxLocks) {
      return {
        ok: false,
        failureClass: "lock_table_full",
        detail: `lock table limit ${this.maxLocks}`,
      };
    }
    this.locks.set(k, { subjectId, turnId });
    return { ok: true, key: k };
  }

  release(
    key: string,
    scope: { subjectId: string; turnId: string },
  ): boolean {
    const k = typeof key === "string" ? key.trim() : "";
    const held = this.locks.get(k);
    if (!held) return false;
    if (held.subjectId !== scope.subjectId || held.turnId !== scope.turnId) {
      return false;
    }
    this.locks.delete(k);
    return true;
  }

  /** Release every lock held by turn (subject-scoped). Returns released keys. */
  releaseAllForTurn(turnId: string, subjectId: string): string[] {
    const released: string[] = [];
    for (const [key, held] of this.locks) {
      if (held.turnId === turnId && held.subjectId === subjectId) {
        this.locks.delete(key);
        released.push(key);
      }
    }
    return released;
  }
}

/**
 * Effect journal for one turn. Pending → abandon; mid_write → compensate →
 * rolled_back. Committed entries are never reversed by abort.
 */
export class EffectJournal {
  private readonly entries: EffectJournalEntry[] = [];
  private readonly byId = new Map<string, EffectJournalEntry>();
  private readonly compensators = new Map<string, EffectCompensateFn>();

  get size(): number {
    return this.entries.length;
  }

  list(): readonly EffectJournalEntry[] {
    return this.entries.slice();
  }

  listUncommitted(): EffectJournalEntry[] {
    return this.entries.filter(
      (e) =>
        e.status === "pending" ||
        e.status === "mid_write" ||
        e.status === "abandoned" ||
        e.status === "rolled_back",
    );
  }

  listRollbackCandidates(): EffectJournalEntry[] {
    return this.entries.filter(
      (e) => e.status === "pending" || e.status === "mid_write",
    );
  }

  append(input: AppendEffectInput):
    | { ok: true; entry: EffectJournalEntry }
    | { ok: false; failureClass: AbortPipelineFailureClass; detail: string } {
    const effectId =
      typeof input.effectId === "string" ? input.effectId.trim() : "";
    if (!effectId) {
      return {
        ok: false,
        failureClass: "invalid_effect",
        detail: "effectId required",
      };
    }
    if (this.byId.has(effectId)) {
      return {
        ok: false,
        failureClass: "invalid_effect",
        detail: "duplicate effectId",
      };
    }
    if (this.entries.length >= ABORT_JOURNAL_LIMIT) {
      return {
        ok: false,
        failureClass: "journal_full",
        detail: `journal limit ${ABORT_JOURNAL_LIMIT}`,
      };
    }
    const entry: EffectJournalEntry = {
      effectId,
      status: input.midWrite === true ? "mid_write" : "pending",
      recordedAt: Date.now(),
      ...(input.toolName !== undefined
        ? { toolName: String(input.toolName).slice(0, 64) }
        : {}),
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: String(input.idempotencyKey).slice(0, 128) }
        : {}),
      ...(input.riskClass !== undefined ? { riskClass: input.riskClass } : {}),
    };
    this.entries.push(entry);
    this.byId.set(effectId, entry);
    if (typeof input.compensate === "function") {
      this.compensators.set(effectId, input.compensate);
    }
    return { ok: true, entry };
  }

  markCommitted(effectId: string): boolean {
    const entry = this.byId.get(effectId.trim());
    if (
      !entry ||
      (entry.status !== "pending" && entry.status !== "mid_write")
    ) {
      return false;
    }
    entry.status = "committed";
    this.compensators.delete(effectId.trim());
    return true;
  }

  /** Escalate pending → mid_write when a tool begins a durable write. */
  markMidWrite(effectId: string): boolean {
    const entry = this.byId.get(effectId.trim());
    if (!entry || entry.status !== "pending") return false;
    entry.status = "mid_write";
    return true;
  }

  getCompensator(effectId: string): EffectCompensateFn | undefined {
    return this.compensators.get(effectId.trim());
  }

  clearCompensator(effectId: string): void {
    this.compensators.delete(effectId.trim());
  }
}

type TurnRecord = {
  turnId: string;
  subjectId: string;
  deviceId: string | undefined;
  controller: AbortController;
  modelController: AbortController;
  sandboxController: AbortController;
  journal: EffectJournal;
  status: TurnAbortStatus;
  effectsCommitted: boolean;
  abortCount: number;
  /** Guarantees compensators run at most once. */
  rollbackDone: boolean;
  /** Guarantees lock release runs at most once. */
  locksReleasedDone: boolean;
  /** Guarantees AGENT_MANUAL_ABORT audit at most once. */
  auditDone: boolean;
};

/**
 * Deterministic in-process durable effect sink for rollback tests.
 * The model never sees this map — only host/seam tests.
 */
export class InProcessFakeDurableEffects {
  private readonly applied = new Map<string, unknown>();

  get size(): number {
    return this.applied.size;
  }

  apply(effectId: string, value: unknown = true): void {
    const id = effectId.trim();
    if (!id) return;
    this.applied.set(id, value);
  }

  has(effectId: string): boolean {
    return this.applied.has(effectId.trim());
  }

  compensate(effectId: string): boolean {
    return this.applied.delete(effectId.trim());
  }

  keys(): string[] {
    return [...this.applied.keys()];
  }
}

/**
 * Per-turn handle: share modelSignal / sandboxSignal with providers and seam.
 */
export class TurnAbortHandle {
  readonly turnId: string;
  readonly subjectId: string;
  readonly deviceId: string | undefined;
  readonly journal: EffectJournal;

  private readonly record: TurnRecord;
  private readonly pipeline: AbortPipeline;

  constructor(record: TurnRecord, pipeline: AbortPipeline) {
    this.record = record;
    this.pipeline = pipeline;
    this.turnId = record.turnId;
    this.subjectId = record.subjectId;
    this.deviceId = record.deviceId;
    this.journal = record.journal;
  }

  get status(): TurnAbortStatus {
    return this.record.status;
  }

  get signal(): AbortSignal {
    return this.record.controller.signal;
  }

  get modelSignal(): AbortSignal {
    return this.record.modelController.signal;
  }

  get sandboxSignal(): AbortSignal {
    return this.record.sandboxController.signal;
  }

  get aborted(): boolean {
    return this.record.status === "aborted" || this.signal.aborted;
  }

  /**
   * Journal a pre-commit operation. When `idempotencyKey` is set, acquires a
   * process lock (released on abort finally).
   */
  appendEffect(input: AppendEffectInput):
    | { ok: true; entry: EffectJournalEntry }
    | { ok: false; failureClass: AbortPipelineFailureClass; detail: string } {
    if (this.record.status !== "active") {
      return {
        ok: false,
        failureClass: "invalid_turn",
        detail: `cannot journal on ${this.record.status} turn`,
      };
    }

    if (
      typeof input.idempotencyKey === "string" &&
      input.idempotencyKey.trim()
    ) {
      const acquired = this.pipeline.locks.acquire(input.idempotencyKey, {
        subjectId: this.subjectId,
        turnId: this.turnId,
      });
      if (!acquired.ok) {
        return acquired;
      }
    }

    const appended = this.journal.append(input);
    if (!appended.ok) {
      // Roll back lock if journal append failed after acquire.
      if (
        typeof input.idempotencyKey === "string" &&
        input.idempotencyKey.trim()
      ) {
        this.pipeline.locks.release(input.idempotencyKey, {
          subjectId: this.subjectId,
          turnId: this.turnId,
        });
      }
      return appended;
    }
    return appended;
  }

  markEffectCommitted(effectId: string): boolean {
    // Locks stay held until turn completes/aborts; finally clears turn keys.
    return this.journal.markCommitted(effectId);
  }

  markEffectMidWrite(effectId: string): boolean {
    return this.journal.markMidWrite(effectId);
  }
}

/**
 * Process-local registry: turnId → AbortController + effect journal + locks.
 */
export class AbortPipeline {
  private readonly turns = new Map<string, TurnRecord>();
  private readonly maxActiveTurns: number;
  readonly locks: IdempotencyLockTable;
  private readonly auditSink: AbortAuditSink | undefined;
  private readonly onTelemetry:
    | ((event: AbortPipelineTelemetryEvent) => void)
    | undefined;

  constructor(opts: AbortPipelineOptions = {}) {
    const max =
      opts.maxActiveTurns !== undefined
        ? opts.maxActiveTurns
        : ABORT_REGISTRY_LIMIT;
    if (!Number.isInteger(max) || max < 1 || max > 4096) {
      throw new Error("maxActiveTurns must be an integer in 1..4096");
    }
    this.maxActiveTurns = max;
    this.locks = opts.lockTable ?? new IdempotencyLockTable();
    this.auditSink = opts.auditSink;
    this.onTelemetry = opts.onTelemetry;
  }

  get activeCount(): number {
    let n = 0;
    for (const t of this.turns.values()) {
      if (t.status === "active") n += 1;
    }
    return n;
  }

  get size(): number {
    return this.turns.size;
  }

  registerTurn(opts: RegisterTurnOptions): RegisterTurnResult {
    const subjectId =
      typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
    if (!subjectId) {
      this.emitTel({
        outcome: "rejected",
        subjectId: null,
        failureClass: "missing_subject",
      });
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subjectId required",
        subjectId: null,
      };
    }
    const turnId = typeof opts.turnId === "string" ? opts.turnId.trim() : "";
    if (!turnId) {
      this.emitTel({
        outcome: "rejected",
        subjectId,
        failureClass: "invalid_turn",
      });
      return {
        ok: false,
        failureClass: "invalid_turn",
        detail: "turnId required",
        subjectId,
      };
    }

    const existing = this.turns.get(turnId);
    if (existing) {
      if (existing.subjectId !== subjectId) {
        this.emitTel({
          outcome: "rejected",
          subjectId,
          turnId,
          failureClass: "cross_subject",
        });
        return {
          ok: false,
          failureClass: "cross_subject",
          detail: "turnId owned by another subject",
          subjectId,
        };
      }
      this.emitTel({
        outcome: "rejected",
        subjectId,
        turnId,
        failureClass: "duplicate_turn",
      });
      return {
        ok: false,
        failureClass: "duplicate_turn",
        detail: "turnId already registered",
        subjectId,
      };
    }

    if (this.activeCount >= this.maxActiveTurns) {
      this.emitTel({
        outcome: "rejected",
        subjectId,
        turnId,
        failureClass: "registry_full",
        activeTurns: this.activeCount,
      });
      return {
        ok: false,
        failureClass: "registry_full",
        detail: `active turn limit ${this.maxActiveTurns}`,
        subjectId,
      };
    }

    const controller = new AbortController();
    const modelController = new AbortController();
    const sandboxController = new AbortController();
    const onParentAbort = () => {
      if (!modelController.signal.aborted) {
        modelController.abort(ABORT_REASON_MANUAL);
      }
      if (!sandboxController.signal.aborted) {
        sandboxController.abort(ABORT_REASON_MANUAL);
      }
    };
    if (controller.signal.aborted) {
      onParentAbort();
    } else {
      controller.signal.addEventListener("abort", onParentAbort, {
        once: true,
      });
    }

    const deviceId = opts.deviceId?.trim() || undefined;
    const record: TurnRecord = {
      turnId,
      subjectId,
      deviceId,
      controller,
      modelController,
      sandboxController,
      journal: new EffectJournal(),
      status: "active",
      effectsCommitted: false,
      abortCount: 0,
      rollbackDone: false,
      locksReleasedDone: false,
      auditDone: false,
    };
    this.turns.set(turnId, record);

    this.emitTel({
      outcome: "ok",
      subjectId,
      turnId,
      action: "registered",
      ...(deviceId !== undefined ? { deviceId } : {}),
      activeTurns: this.activeCount,
    });

    return { ok: true, handle: new TurnAbortHandle(record, this) };
  }

  /**
   * Abort an active turn: cascade signals, rollback/abandon uncommitted
   * journal entries, release idempotency locks in finally. Idempotent.
   */
  async abort(
    turnId: string,
    opts: AbortTurnOptions,
  ): Promise<AbortTurnResult> {
    const started = Date.now();
    const subjectId =
      typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
    if (!subjectId) {
      this.emitTel({
        outcome: "rejected",
        subjectId: null,
        failureClass: "missing_subject",
      });
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subjectId required",
        subjectId: null,
        turnId: null,
      };
    }
    const id = typeof turnId === "string" ? turnId.trim() : "";
    if (!id) {
      this.emitTel({
        outcome: "rejected",
        subjectId,
        failureClass: "invalid_turn",
      });
      return {
        ok: false,
        failureClass: "invalid_turn",
        detail: "turnId required",
        subjectId,
        turnId: null,
      };
    }

    const record = this.turns.get(id);
    if (!record) {
      this.emitTel({
        outcome: "rejected",
        subjectId,
        turnId: id,
        failureClass: "not_found",
      });
      return {
        ok: false,
        failureClass: "not_found",
        detail: "no in-flight turn for turnId",
        subjectId,
        turnId: id,
      };
    }
    if (record.subjectId !== subjectId) {
      this.emitTel({
        outcome: "rejected",
        subjectId,
        turnId: id,
        failureClass: "cross_subject",
      });
      return {
        ok: false,
        failureClass: "cross_subject",
        detail: "turn subjectId does not match",
        subjectId,
        turnId: id,
      };
    }

    if (record.status === "completed" && record.effectsCommitted) {
      const cascadeLatencyMs = Math.max(0, Date.now() - started);
      this.emitTel({
        outcome: "ok",
        subjectId,
        turnId: id,
        action: "already_completed",
        cascadeLatencyMs,
        ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
        uncommittedCount: 0,
        rolledBackCount: 0,
        abandonedCount: 0,
        locksReleased: 0,
      });
      return {
        ok: true,
        action: "already_completed",
        turnId: id,
        subjectId,
        signalCascaded: false,
        cascadeLatencyMs,
        uncommittedCount: 0,
        rolledBackCount: 0,
        abandonedCount: 0,
        locksReleased: 0,
        compensateFailures: 0,
        auditRecorded: false,
        status: "completed",
      };
    }

    if (record.status === "aborted") {
      const cascadeLatencyMs = Math.max(0, Date.now() - started);
      const uncommittedCount = record.journal.listUncommitted().length;
      this.emitTel({
        outcome: "ok",
        subjectId,
        turnId: id,
        action: "already_aborted",
        cascadeLatencyMs,
        uncommittedCount,
        rolledBackCount: 0,
        abandonedCount: 0,
        locksReleased: 0,
        ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      });
      return {
        ok: true,
        action: "already_aborted",
        turnId: id,
        subjectId,
        signalCascaded: false,
        cascadeLatencyMs,
        uncommittedCount,
        rolledBackCount: 0,
        abandonedCount: 0,
        locksReleased: 0,
        compensateFailures: 0,
        auditRecorded: false,
        status: "aborted",
      };
    }

    let rolledBackCount = 0;
    let abandonedCount = 0;
    let compensateFailures = 0;
    let locksReleased = 0;

    try {
      record.abortCount += 1;
      if (!record.controller.signal.aborted) {
        record.controller.abort(
          typeof opts.reason === "string" && opts.reason.trim()
            ? opts.reason.trim().slice(0, 64)
            : ABORT_REASON_MANUAL,
        );
      }
      if (!record.modelController.signal.aborted) {
        record.modelController.abort(ABORT_REASON_MANUAL);
      }
      if (!record.sandboxController.signal.aborted) {
        record.sandboxController.abort(ABORT_REASON_MANUAL);
      }

      if (!record.rollbackDone) {
        const rb = await this.rollbackJournal(record);
        rolledBackCount = rb.rolledBackCount;
        abandonedCount = rb.abandonedCount;
        compensateFailures = rb.compensateFailures;
        record.rollbackDone = true;
        this.emitTel({
          outcome: "ok",
          subjectId,
          turnId: id,
          action: "rollback",
          rolledBackCount,
          abandonedCount,
          compensateFailures,
          ...(record.deviceId !== undefined
            ? { deviceId: record.deviceId }
            : {}),
        });
      }

      record.status = "aborted";
      record.effectsCommitted = false;
    } finally {
      // Always release locks once — safe retry / no double-apply of holds.
      if (!record.locksReleasedDone) {
        const keys = this.locks.releaseAllForTurn(id, subjectId);
        locksReleased = keys.length;
        record.locksReleasedDone = true;
        this.emitTel({
          outcome: "ok",
          subjectId,
          turnId: id,
          action: "locks_released",
          locksReleased,
          ...(record.deviceId !== undefined
            ? { deviceId: record.deviceId }
            : {}),
        });
      }
    }

    const uncommittedCount = rolledBackCount + abandonedCount;
    const cascadeLatencyMs = Math.max(0, Date.now() - started);
    const reason =
      typeof opts.reason === "string" && opts.reason.trim()
        ? opts.reason.trim().slice(0, 64)
        : ABORT_REASON_MANUAL;
    const principalId =
      typeof opts.principalId === "string" && opts.principalId.trim()
        ? opts.principalId.trim().slice(0, 128)
        : undefined;

    let auditRecorded = false;
    if (!record.auditDone && this.auditSink) {
      await this.auditSink.recordManualAbort({
        event: AGENT_MANUAL_ABORT_AUDIT_EVENT,
        subjectId,
        turnId: id,
        reason,
        rolledBackCount,
        abandonedCount,
        locksReleased,
        recordedAt: new Date().toISOString(),
        ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
        ...(principalId !== undefined ? { principalId } : {}),
      });
      record.auditDone = true;
      auditRecorded = true;
      this.emitTel({
        outcome: "ok",
        subjectId,
        turnId: id,
        action: "audit_recorded",
        ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      });
    } else if (record.auditDone) {
      auditRecorded = false;
    }

    this.emitTel({
      outcome: "ok",
      subjectId,
      turnId: id,
      action: "aborted",
      cascadeLatencyMs,
      uncommittedCount,
      rolledBackCount,
      abandonedCount,
      locksReleased,
      compensateFailures,
      ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      activeTurns: this.activeCount,
    });

    return {
      ok: true,
      action: "aborted",
      turnId: id,
      subjectId,
      signalCascaded: true,
      cascadeLatencyMs,
      uncommittedCount,
      rolledBackCount,
      abandonedCount,
      locksReleased,
      compensateFailures,
      auditRecorded,
      status: "aborted",
    };
  }

  private async rollbackJournal(record: TurnRecord): Promise<{
    rolledBackCount: number;
    abandonedCount: number;
    compensateFailures: number;
  }> {
    let rolledBackCount = 0;
    let abandonedCount = 0;
    let compensateFailures = 0;
    const candidates = record.journal.listRollbackCandidates();

    for (const entry of candidates) {
      const compensate = record.journal.getCompensator(entry.effectId);
      const needsCompensate =
        entry.status === "mid_write" ||
        (entry.status === "pending" && typeof compensate === "function");

      if (needsCompensate && compensate) {
        try {
          await compensate(entry, {
            subjectId: record.subjectId,
            turnId: record.turnId,
          });
          entry.status = "rolled_back";
          record.journal.clearCompensator(entry.effectId);
          rolledBackCount += 1;
        } catch {
          // Best-effort: still abandon/roll marking so we never leave pending
          // as "active durable" — host must treat as abandoned after failure.
          entry.status = "abandoned";
          record.journal.clearCompensator(entry.effectId);
          abandonedCount += 1;
          compensateFailures += 1;
        }
      } else if (entry.status === "mid_write" && !compensate) {
        // Mid-write without compensator → abandon (never leave as mid_write).
        entry.status = "abandoned";
        abandonedCount += 1;
      } else {
        entry.status = "abandoned";
        abandonedCount += 1;
      }
    }

    return { rolledBackCount, abandonedCount, compensateFailures };
  }

  markTurnCompleted(
    turnId: string,
    opts: MarkTurnCompletedOptions,
  ): MarkTurnCompletedResult {
    const subjectId =
      typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
    if (!subjectId) {
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subjectId required",
        subjectId: null,
        turnId: null,
      };
    }
    const id = typeof turnId === "string" ? turnId.trim() : "";
    if (!id) {
      return {
        ok: false,
        failureClass: "invalid_turn",
        detail: "turnId required",
        subjectId,
        turnId: null,
      };
    }
    const record = this.turns.get(id);
    if (!record) {
      return {
        ok: false,
        failureClass: "not_found",
        detail: "no turn for turnId",
        subjectId,
        turnId: id,
      };
    }
    if (record.subjectId !== subjectId) {
      return {
        ok: false,
        failureClass: "cross_subject",
        detail: "turn subjectId does not match",
        subjectId,
        turnId: id,
      };
    }
    if (record.status === "aborted") {
      return {
        ok: false,
        failureClass: "invalid_turn",
        detail: "turn already aborted",
        subjectId,
        turnId: id,
      };
    }

    record.status = "completed";
    record.effectsCommitted = opts.effectsCommitted === true;
    // Completed turns release locks so completed keys can be reused safely.
    if (!record.locksReleasedDone) {
      const keys = this.locks.releaseAllForTurn(id, subjectId);
      record.locksReleasedDone = true;
      this.emitTel({
        outcome: "ok",
        subjectId,
        turnId: id,
        action: "locks_released",
        locksReleased: keys.length,
        ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      });
    }
    this.emitTel({
      outcome: "ok",
      subjectId,
      turnId: id,
      action: "completed",
      ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      uncommittedCount: record.journal.listUncommitted().length,
    });
    return {
      ok: true,
      turnId: id,
      subjectId,
      status: "completed",
      effectsCommitted: record.effectsCommitted,
    };
  }

  getHandle(
    turnId: string,
    subjectId: string,
  ):
    | { ok: true; handle: TurnAbortHandle }
    | { ok: false; failureClass: AbortPipelineFailureClass } {
    const sid = typeof subjectId === "string" ? subjectId.trim() : "";
    const id = typeof turnId === "string" ? turnId.trim() : "";
    if (!sid) return { ok: false, failureClass: "missing_subject" };
    if (!id) return { ok: false, failureClass: "invalid_turn" };
    const record = this.turns.get(id);
    if (!record) return { ok: false, failureClass: "not_found" };
    if (record.subjectId !== sid) {
      return { ok: false, failureClass: "cross_subject" };
    }
    return { ok: true, handle: new TurnAbortHandle(record, this) };
  }

  release(turnId: string, subjectId: string): boolean {
    const sid = typeof subjectId === "string" ? subjectId.trim() : "";
    const id = typeof turnId === "string" ? turnId.trim() : "";
    const record = this.turns.get(id);
    if (!record || record.subjectId !== sid) return false;
    if (record.status === "active") return false;
    if (!record.locksReleasedDone) {
      this.locks.releaseAllForTurn(id, sid);
      record.locksReleasedDone = true;
    }
    this.turns.delete(id);
    return true;
  }

  private emitTel(
    partial: Omit<AbortPipelineTelemetryEvent, "event">,
  ): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.abort_pipeline",
      ...partial,
    });
  }
}

/**
 * Deterministic fake: resolves when AbortSignal fires (tests cascade latency).
 */
export function waitForAbortSignal(
  signal: AbortSignal,
  timeoutMs = 1_000,
): Promise<"aborted" | "timeout"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("timeout");
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
