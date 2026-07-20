/**
 * BudgetManager — host-facing per-subject token budget API.
 *
 * Products set a token ceiling, query remaining, and register warning /
 * exceeded callbacks so spend can be gated *before* the next model turn.
 * Cached and fresh input remain distinguishable on spend records; remaining
 * aggregates billed tokens (fresh + cached + output). Conforms to the
 * closed {@link BudgetHook} / {@link BudgetDecision} contract.
 */

import type {
  BudgetDecision,
  BudgetHook,
  BudgetMeterTick,
} from "@moolam/contracts";
import { BUDGET_DECISIONS, isBudgetDecision } from "@moolam/contracts";

/** Soft cap on tracked subject/session ledger rows (NFR bound). */
export const BUDGET_SUBJECT_LIMIT = 256;

/** Soft cap on concurrent reservations per subject. */
export const BUDGET_RESERVATION_LIMIT = 32;

/** Soft cap on spend idempotency keys retained per subject. */
export const BUDGET_IDEM_KEY_LIMIT = 64;

/**
 * Default fraction of limit at which {@link BudgetManager} fires
 * onBudgetWarning (e.g. 0.8 = 80% used).
 */
export const BUDGET_WARNING_THRESHOLD_DEFAULT = 0.8;

/** Typed advisory when remaining is zero / breached. */
export const BUDGET_ADVISORY_EXCEEDED = "budget_exceeded" as const;

/** Typed advisory when warning threshold is crossed. */
export const BUDGET_ADVISORY_WARNING = "budget_warning" as const;

/**
 * HARNESS_ERROR.code when a turn is blocked for exceeded budget.
 * Sync ADVISORY_ATTACH cannot carry budget codes (closed SYNC-06 set).
 */
export const HARNESS_ERROR_BUDGET_EXCEEDED = "BUDGET_EXCEEDED" as const;

/**
 * HARNESS_ERROR.code when throttle rejects a new turn near the limit.
 * Never silent mid-stream truncation — gate before model invoke.
 */
export const HARNESS_ERROR_BUDGET_THROTTLE = "BUDGET_THROTTLE" as const;

export type BudgetAdvisoryCode =
  | typeof BUDGET_ADVISORY_EXCEEDED
  | typeof BUDGET_ADVISORY_WARNING;

export type BudgetManagerFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "invalid_budget"
  | "not_found"
  | "subject_limit"
  | "reservation_limit"
  | "idem_limit"
  | "no_budget";

export type BudgetScope = {
  subjectId: string;
  sessionId?: string;
  deviceId?: string;
};

export type BudgetSpendChannels = {
  /** Fresh (non-cached) input tokens. */
  freshInputTokens: number;
  /** Cache-served input tokens (never folded into fresh). */
  cachedInputTokens: number;
  outputTokens: number;
};

export type BudgetSnapshot = {
  subjectId: string;
  sessionId?: string;
  deviceId?: string;
  limit: number;
  used: number;
  remaining: number;
  /** Reserved but not yet committed. */
  reserved: number;
  warningThreshold: number;
  warned: boolean;
  exceeded: boolean;
  /** Distinct channels accounted so far (metadata). */
  freshInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type BudgetAdvisory = {
  code: BudgetAdvisoryCode;
  subjectId: string;
  sessionId?: string;
  deviceId?: string;
  limit: number;
  used: number;
  remaining: number;
  warningThreshold: number;
};

export type BudgetWarningHandler = (advisory: BudgetAdvisory) => void;
export type BudgetExceededHandler = (advisory: BudgetAdvisory) => void;

export type BudgetManagerTelemetryEvent = {
  event: "runtime.harness.budget";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  sessionId?: string;
  action?:
    | "set_budget"
    | "get_remaining"
    | "check_turn"
    | "reserve"
    | "commit"
    | "release"
    | "record_spend"
    | "reset_breach"
    | "meter_tick"
    | "budget_warning"
    | "budget_exceeded"
    | "export_ledger"
    | "import_ledger";
  decision?: BudgetDecision;
  advisoryCode?: BudgetAdvisoryCode;
  remaining?: number;
  limit?: number;
  used?: number;
  /** Distinct spend channels on export/import (never learner content). */
  freshInputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  failureClass?: BudgetManagerFailureClass;
};

/**
 * Restart-survival ledger snapshot (metadata only).
 * Reservations are not persisted — in-flight turns must re-gate after restart.
 */
export type BudgetLedgerExport = {
  subjectId: string;
  sessionId?: string;
  deviceId?: string;
  limit: number;
  used: number;
  warningThreshold: number;
  warned: boolean;
  exceededFired: boolean;
  freshInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type BudgetManagerOptions = {
  /** Default warning threshold (0–1 exclusive of 0, inclusive of 1). */
  warningThreshold?: number;
  /** Soft cap on ledger entries. */
  maxSubjects?: number;
  onTelemetry?: (event: BudgetManagerTelemetryEvent) => void;
};

export type SetBudgetInput = {
  limit: number;
  /** Override warning threshold for this subject (default from manager). */
  warningThreshold?: number;
  /**
   * When true, clear used/reserved/channels and breach latches.
   * When false (default), keep used; raising the limit can clear exceeded.
   */
  resetUsed?: boolean;
};

type LedgerEntry = {
  subjectId: string;
  sessionId?: string;
  deviceId?: string;
  limit: number;
  used: number;
  reserved: number;
  warningThreshold: number;
  warned: boolean;
  /** Exceeded callback fired for current breach period. */
  exceededFired: boolean;
  freshInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reservations: Map<string, number>;
  seenIdemKeys: Set<string>;
};

function nonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function scopeKey(scope: BudgetScope): string {
  const subjectId = scope.subjectId.trim();
  const sessionId =
    typeof scope.sessionId === "string" && scope.sessionId.trim()
      ? scope.sessionId.trim()
      : "";
  return sessionId ? `${subjectId}\0${sessionId}` : subjectId;
}

function billedTokens(channels: BudgetSpendChannels): number {
  return (
    channels.freshInputTokens +
    channels.cachedInputTokens +
    channels.outputTokens
  );
}

/**
 * Per-subject budget ledger with warning / exceeded hooks.
 *
 * - {@link checkTurn} — pre-model gate (hosts call before invocation)
 * - {@link reserve} / {@link commitReservation} — concurrent-turn safety
 * - {@link onMeterTick} — {@link BudgetHook} spend apply after a meter tick
 *
 * Mutations for a given subject key are serialized through an async lock so
 * concurrent turns cannot race the counter.
 */
export class BudgetManager implements BudgetHook {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly defaultWarningThreshold: number;
  private readonly maxSubjects: number;
  private readonly onTelemetry:
    | ((event: BudgetManagerTelemetryEvent) => void)
    | undefined;
  private warningHandlers: BudgetWarningHandler[] = [];
  private exceededHandlers: BudgetExceededHandler[] = [];
  /** Per-subject serialized mutation chain. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private reservationSeq = 0;

  constructor(opts: BudgetManagerOptions = {}) {
    const threshold =
      opts.warningThreshold ?? BUDGET_WARNING_THRESHOLD_DEFAULT;
    if (
      typeof threshold !== "number" ||
      !(threshold > 0) ||
      !(threshold <= 1)
    ) {
      throw new Error(
        "BudgetManager warningThreshold must be in (0, 1]",
      );
    }
    this.defaultWarningThreshold = threshold;
    this.maxSubjects = opts.maxSubjects ?? BUDGET_SUBJECT_LIMIT;
    this.onTelemetry = opts.onTelemetry;
  }

  /** Register a handler for the warning threshold (fires once until reset). */
  onBudgetWarning(handler: BudgetWarningHandler): () => void {
    this.warningHandlers.push(handler);
    return () => {
      this.warningHandlers = this.warningHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Register a handler for budget exceeded.
   * Fires once per breach period unless {@link resetBreach} / raise+clear.
   */
  onBudgetExceeded(handler: BudgetExceededHandler): () => void {
    this.exceededHandlers.push(handler);
    return () => {
      this.exceededHandlers = this.exceededHandlers.filter((h) => h !== handler);
    };
  }

  setBudget(
    scope: BudgetScope,
    input: SetBudgetInput,
  ):
    | { ok: true; snapshot: BudgetSnapshot }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;

    if (!nonNegInt(input.limit)) {
      return this.reject(
        "invalid_budget",
        parsed.subjectId,
        "limit must be a non-negative integer",
        scope,
      );
    }

    let warningThreshold = this.defaultWarningThreshold;
    if (input.warningThreshold !== undefined) {
      if (
        typeof input.warningThreshold !== "number" ||
        !(input.warningThreshold > 0) ||
        !(input.warningThreshold <= 1)
      ) {
        return this.reject(
          "invalid_budget",
          parsed.subjectId,
          "warningThreshold must be in (0, 1]",
          scope,
        );
      }
      warningThreshold = input.warningThreshold;
    }

    const key = parsed.key;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxSubjects) {
        return this.reject(
          "subject_limit",
          parsed.subjectId,
          `budget subject budget ${this.maxSubjects} exceeded`,
          scope,
        );
      }
      entry = {
        subjectId: parsed.subjectId,
        ...(parsed.sessionId !== undefined
          ? { sessionId: parsed.sessionId }
          : {}),
        ...(parsed.deviceId !== undefined ? { deviceId: parsed.deviceId } : {}),
        limit: input.limit,
        used: 0,
        reserved: 0,
        warningThreshold,
        warned: false,
        exceededFired: false,
        freshInputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reservations: new Map(),
        seenIdemKeys: new Set(),
      };
      this.entries.set(key, entry);
    } else {
      entry.limit = input.limit;
      entry.warningThreshold = warningThreshold;
      if (parsed.deviceId !== undefined) entry.deviceId = parsed.deviceId;
      if (input.resetUsed === true) {
        entry.used = 0;
        entry.reserved = 0;
        entry.warned = false;
        entry.exceededFired = false;
        entry.freshInputTokens = 0;
        entry.cachedInputTokens = 0;
        entry.outputTokens = 0;
        entry.reservations.clear();
        entry.seenIdemKeys.clear();
      } else if (this.remainingOf(entry) > 0) {
        // Raising the limit mid-session clears the exceeded latch.
        entry.exceededFired = false;
      }
    }

    const snapshot = this.toSnapshot(entry);
    this.telemetry({
      outcome: "ok",
      action: "set_budget",
      subjectId: entry.subjectId,
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      remaining: snapshot.remaining,
      limit: snapshot.limit,
      used: snapshot.used,
    });
    return { ok: true, snapshot };
  }

  getRemaining(scope: BudgetScope):
    | { ok: true; remaining: number; snapshot: BudgetSnapshot }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;
    const entry = this.entries.get(parsed.key);
    if (!entry) {
      return this.reject(
        "not_found",
        parsed.subjectId,
        "no budget configured for subject",
        scope,
      );
    }
    const snapshot = this.toSnapshot(entry);
    this.telemetry({
      outcome: "ok",
      action: "get_remaining",
      subjectId: entry.subjectId,
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      remaining: snapshot.remaining,
      limit: snapshot.limit,
      used: snapshot.used,
    });
    return { ok: true, remaining: snapshot.remaining, snapshot };
  }

  getSnapshot(scope: BudgetScope):
    | { ok: true; snapshot: BudgetSnapshot }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const remaining = this.getRemaining(scope);
    if (!remaining.ok) return remaining;
    return { ok: true, snapshot: remaining.snapshot };
  }

  /**
   * Pre-turn gate: call before model invocation.
   * Budget exactly zero → hardStop + budget_exceeded advisory.
   */
  checkTurn(
    scope: BudgetScope,
    estimatedTokens = 0,
  ):
    | {
        ok: true;
        decision: BudgetDecision;
        snapshot: BudgetSnapshot;
        advisory?: BudgetAdvisory;
      }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;
    if (!nonNegInt(estimatedTokens)) {
      return this.reject(
        "invalid_budget",
        parsed.subjectId,
        "estimatedTokens must be a non-negative integer",
        scope,
      );
    }

    const entry = this.entries.get(parsed.key);
    if (!entry) {
      return this.reject(
        "no_budget",
        parsed.subjectId,
        "setBudget before checkTurn",
        scope,
      );
    }

    const remaining = this.remainingOf(entry);
    const snapshot = this.toSnapshot(entry);
    let decision: BudgetDecision = "allow";
    let advisory: BudgetAdvisory | undefined;

    if (remaining <= 0 || estimatedTokens > remaining) {
      decision = "hardStop";
      advisory = this.makeAdvisory(entry, BUDGET_ADVISORY_EXCEEDED);
      this.fireExceededOnce(entry, advisory);
    } else if (this.usedRatio(entry) >= entry.warningThreshold) {
      decision = "throttle";
      advisory = this.makeAdvisory(entry, BUDGET_ADVISORY_WARNING);
      this.fireWarningOnce(entry, advisory);
    }

    this.telemetry({
      outcome: "ok",
      action: "check_turn",
      subjectId: entry.subjectId,
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      decision,
      ...(advisory ? { advisoryCode: advisory.code } : {}),
      remaining,
      limit: entry.limit,
      used: entry.used,
    });

    return {
      ok: true,
      decision,
      snapshot,
      ...(advisory !== undefined ? { advisory } : {}),
    };
  }

  /**
   * Atomically reserve estimated tokens for a concurrent turn.
   * Serialized per subject via {@link withSubjectLock}.
   */
  async reserve(
    scope: BudgetScope,
    estimatedTokens: number,
  ): Promise<
    | {
        ok: true;
        reservationId: string;
        decision: BudgetDecision;
        snapshot: BudgetSnapshot;
        advisory?: BudgetAdvisory;
      }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
        decision?: BudgetDecision;
        advisory?: BudgetAdvisory;
      }
  > {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;
    return this.withSubjectLock(parsed.key, () =>
      this.reserveSync(parsed, estimatedTokens),
    );
  }

  commitReservation(
    scope: BudgetScope,
    reservationId: string,
    actual: BudgetSpendChannels,
    opts?: { idempotencyKey?: string },
  ):
    | { ok: true; snapshot: BudgetSnapshot; decision: BudgetDecision }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;
    return this.commitSync(parsed, reservationId, actual, opts);
  }

  releaseReservation(
    scope: BudgetScope,
    reservationId: string,
  ):
    | { ok: true; snapshot: BudgetSnapshot }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;
    const entry = this.entries.get(parsed.key);
    if (!entry) {
      return this.reject(
        "not_found",
        parsed.subjectId,
        "no budget configured for subject",
        scope,
      );
    }
    const held = entry.reservations.get(reservationId);
    if (held === undefined) {
      return this.reject(
        "not_found",
        parsed.subjectId,
        "unknown reservationId",
        scope,
      );
    }
    entry.reserved -= held;
    entry.reservations.delete(reservationId);
    const snapshot = this.toSnapshot(entry);
    this.telemetry({
      outcome: "ok",
      action: "release",
      subjectId: entry.subjectId,
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      remaining: snapshot.remaining,
      used: snapshot.used,
      limit: snapshot.limit,
    });
    return { ok: true, snapshot };
  }

  /**
   * Apply spend without a prior reservation (single-turn hosts).
   * Idempotent when `idempotencyKey` is supplied.
   */
  recordSpend(
    scope: BudgetScope,
    channels: BudgetSpendChannels,
    opts?: { idempotencyKey?: string },
  ):
    | {
        ok: true;
        snapshot: BudgetSnapshot;
        decision: BudgetDecision;
        advisory?: BudgetAdvisory;
        duplicate?: boolean;
      }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;
    return this.recordSpendSync(parsed, channels, opts);
  }

  /** Clear the exceeded fire-once latch for the current subject. */
  resetBreach(scope: BudgetScope):
    | { ok: true; snapshot: BudgetSnapshot }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;
    const entry = this.entries.get(parsed.key);
    if (!entry) {
      return this.reject(
        "not_found",
        parsed.subjectId,
        "no budget configured for subject",
        scope,
      );
    }
    entry.exceededFired = false;
    entry.warned = false;
    const snapshot = this.toSnapshot(entry);
    this.telemetry({
      outcome: "ok",
      action: "reset_breach",
      subjectId: entry.subjectId,
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      remaining: snapshot.remaining,
      limit: snapshot.limit,
      used: snapshot.used,
    });
    return { ok: true, snapshot };
  }

  /**
   * BudgetHook: apply metered spend, return closed decision.
   * Partial / aborted ticks still account spend.
   */
  onMeterTick(event: BudgetMeterTick): BudgetDecision {
    const scope: BudgetScope = {
      subjectId: event.subjectId,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
    };
    const result = this.recordSpend(scope, {
      freshInputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
    });
    if (!result.ok) {
      this.telemetry({
        outcome: "rejected",
        action: "meter_tick",
        subjectId: result.subjectId,
        failureClass: result.failureClass,
      });
      // No configured budget → allow (hosts gate via checkTurn); isolation rejects → hardStop.
      if (
        result.failureClass === "no_budget" ||
        result.failureClass === "not_found"
      ) {
        return "allow";
      }
      return "hardStop";
    }
    this.telemetry({
      outcome: "ok",
      action: "meter_tick",
      subjectId: event.subjectId,
      ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
      decision: result.decision,
      remaining: result.snapshot.remaining,
      used: result.snapshot.used,
      limit: result.snapshot.limit,
    });
    return result.decision;
  }

  /** Test / operator: number of tracked subject keys. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Export durable ledger fields for restart survival drills.
   * Omits active reservations (must re-run pre-turn gate after restart).
   */
  exportLedger(scope: BudgetScope):
    | { ok: true; ledger: BudgetLedgerExport }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const parsed = this.parseScope(scope);
    if (!parsed.ok) return parsed;
    const entry = this.entries.get(parsed.key);
    if (!entry) {
      return this.reject(
        "not_found",
        parsed.subjectId,
        "no budget configured for subject",
        scope,
      );
    }
    const ledger: BudgetLedgerExport = {
      subjectId: entry.subjectId,
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      limit: entry.limit,
      used: entry.used,
      warningThreshold: entry.warningThreshold,
      warned: entry.warned,
      exceededFired: entry.exceededFired,
      freshInputTokens: entry.freshInputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
    };
    this.telemetry({
      outcome: "ok",
      action: "export_ledger",
      subjectId: entry.subjectId,
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      remaining: this.remainingOf(entry),
      limit: entry.limit,
      used: entry.used,
      freshInputTokens: entry.freshInputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
    });
    return { ok: true, ledger };
  }

  /**
   * Restore a ledger after process restart. Clears reservations.
   * Cross-subject imports are rejected when `scope.subjectId` mismatches.
   */
  importLedger(
    ledger: BudgetLedgerExport,
    scope?: BudgetScope,
  ):
    | { ok: true; snapshot: BudgetSnapshot }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const subjectId =
      typeof ledger.subjectId === "string" ? ledger.subjectId.trim() : "";
    if (!subjectId) {
      return {
        ok: false,
        failureClass: "missing_subject",
        subjectId: null,
        detail: "ledger.subjectId required",
      };
    }
    if (scope) {
      const parsed = this.parseScope(scope);
      if (!parsed.ok) return parsed;
      if (parsed.subjectId !== subjectId) {
        return this.reject(
          "cross_subject",
          parsed.subjectId,
          "ledger.subjectId does not match import scope",
          scope,
        );
      }
      if (
        (parsed.sessionId ?? "") !==
        (typeof ledger.sessionId === "string" ? ledger.sessionId.trim() : "")
      ) {
        return this.reject(
          "cross_subject",
          parsed.subjectId,
          "ledger.sessionId does not match import scope",
          scope,
        );
      }
    }
    if (
      !nonNegInt(ledger.limit) ||
      !nonNegInt(ledger.used) ||
      !nonNegInt(ledger.freshInputTokens) ||
      !nonNegInt(ledger.cachedInputTokens) ||
      !nonNegInt(ledger.outputTokens)
    ) {
      return this.reject(
        "invalid_budget",
        subjectId,
        "ledger token fields must be non-negative integers",
        { subjectId },
      );
    }
    if (
      typeof ledger.warningThreshold !== "number" ||
      !(ledger.warningThreshold > 0) ||
      !(ledger.warningThreshold <= 1)
    ) {
      return this.reject(
        "invalid_budget",
        subjectId,
        "ledger.warningThreshold must be in (0, 1]",
        { subjectId },
      );
    }

    const sessionId =
      typeof ledger.sessionId === "string" && ledger.sessionId.trim()
        ? ledger.sessionId.trim()
        : undefined;
    const deviceId =
      typeof ledger.deviceId === "string" && ledger.deviceId.trim()
        ? ledger.deviceId.trim()
        : undefined;
    const key = scopeKey({
      subjectId,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });

    if (!this.entries.has(key) && this.entries.size >= this.maxSubjects) {
      return this.reject(
        "subject_limit",
        subjectId,
        `budget subject budget ${this.maxSubjects} exceeded`,
        { subjectId },
      );
    }

    const entry: LedgerEntry = {
      subjectId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      limit: ledger.limit,
      used: ledger.used,
      reserved: 0,
      warningThreshold: ledger.warningThreshold,
      warned: ledger.warned === true,
      exceededFired: ledger.exceededFired === true,
      freshInputTokens: ledger.freshInputTokens,
      cachedInputTokens: ledger.cachedInputTokens,
      outputTokens: ledger.outputTokens,
      reservations: new Map(),
      seenIdemKeys: new Set(),
    };
    this.entries.set(key, entry);
    const snapshot = this.toSnapshot(entry);
    this.telemetry({
      outcome: "ok",
      action: "import_ledger",
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      remaining: snapshot.remaining,
      limit: snapshot.limit,
      used: snapshot.used,
      freshInputTokens: entry.freshInputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
    });
    return { ok: true, snapshot };
  }

  private reserveSync(
    parsed: ParsedScope,
    estimatedTokens: number,
  ):
    | {
        ok: true;
        reservationId: string;
        decision: BudgetDecision;
        snapshot: BudgetSnapshot;
        advisory?: BudgetAdvisory;
      }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
        decision?: BudgetDecision;
        advisory?: BudgetAdvisory;
      } {
    if (!nonNegInt(estimatedTokens)) {
      return this.reject(
        "invalid_budget",
        parsed.subjectId,
        "estimatedTokens must be a non-negative integer",
        parsed.scope,
      );
    }
    const entry = this.entries.get(parsed.key);
    if (!entry) {
      return this.reject(
        "no_budget",
        parsed.subjectId,
        "setBudget before reserve",
        parsed.scope,
      );
    }
    if (entry.reservations.size >= BUDGET_RESERVATION_LIMIT) {
      return this.reject(
        "reservation_limit",
        parsed.subjectId,
        `reservation budget ${BUDGET_RESERVATION_LIMIT} exceeded`,
        parsed.scope,
      );
    }

    const remaining = this.remainingOf(entry);
    if (remaining <= 0 || estimatedTokens > remaining) {
      const advisory = this.makeAdvisory(entry, BUDGET_ADVISORY_EXCEEDED);
      this.fireExceededOnce(entry, advisory);
      this.telemetry({
        outcome: "ok",
        action: "reserve",
        subjectId: entry.subjectId,
        decision: "hardStop",
        advisoryCode: BUDGET_ADVISORY_EXCEEDED,
        remaining,
        limit: entry.limit,
        used: entry.used,
      });
      return {
        ok: false,
        failureClass: "invalid_budget",
        subjectId: entry.subjectId,
        detail: "insufficient remaining budget for reservation",
        decision: "hardStop",
        advisory,
      };
    }

    this.reservationSeq += 1;
    const reservationId = `res-${this.reservationSeq}`;
    entry.reserved += estimatedTokens;
    entry.reservations.set(reservationId, estimatedTokens);

    let decision: BudgetDecision = "allow";
    let advisory: BudgetAdvisory | undefined;
    // Throttle against committed spend only — held reservations must not
    // reject the turn that is about to consume the remaining headroom.
    const committedRatio =
      entry.limit <= 0 ? 1 : entry.used / entry.limit;
    if (committedRatio >= entry.warningThreshold) {
      decision = "throttle";
      advisory = this.makeAdvisory(entry, BUDGET_ADVISORY_WARNING);
      this.fireWarningOnce(entry, advisory);
    }

    const snapshot = this.toSnapshot(entry);
    this.telemetry({
      outcome: "ok",
      action: "reserve",
      subjectId: entry.subjectId,
      decision,
      ...(advisory ? { advisoryCode: advisory.code } : {}),
      remaining: snapshot.remaining,
      limit: snapshot.limit,
      used: snapshot.used,
    });
    return {
      ok: true,
      reservationId,
      decision,
      snapshot,
      ...(advisory !== undefined ? { advisory } : {}),
    };
  }

  private commitSync(
    parsed: ParsedScope,
    reservationId: string,
    actual: BudgetSpendChannels,
    opts?: { idempotencyKey?: string },
  ):
    | { ok: true; snapshot: BudgetSnapshot; decision: BudgetDecision }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const entry = this.entries.get(parsed.key);
    if (!entry) {
      return this.reject(
        "not_found",
        parsed.subjectId,
        "no budget configured for subject",
        parsed.scope,
      );
    }
    const held = entry.reservations.get(reservationId);
    if (held === undefined) {
      return this.reject(
        "not_found",
        parsed.subjectId,
        "unknown reservationId",
        parsed.scope,
      );
    }
    if (
      !nonNegInt(actual.freshInputTokens) ||
      !nonNegInt(actual.cachedInputTokens) ||
      !nonNegInt(actual.outputTokens)
    ) {
      return this.reject(
        "invalid_budget",
        parsed.subjectId,
        "spend channels must be non-negative integers",
        parsed.scope,
      );
    }

    entry.reserved -= held;
    entry.reservations.delete(reservationId);

    const applied = this.applyChannels(entry, actual, opts);
    if (!applied.ok) return applied;

    const decision = this.decisionAfterSpend(entry);
    if (decision === "hardStop") {
      this.fireExceededOnce(
        entry,
        this.makeAdvisory(entry, BUDGET_ADVISORY_EXCEEDED),
      );
    } else if (decision === "throttle") {
      this.fireWarningOnce(
        entry,
        this.makeAdvisory(entry, BUDGET_ADVISORY_WARNING),
      );
    }
    const snapshot = this.toSnapshot(entry);
    this.telemetry({
      outcome: "ok",
      action: "commit",
      subjectId: entry.subjectId,
      decision,
      remaining: snapshot.remaining,
      used: snapshot.used,
      limit: snapshot.limit,
    });
    return { ok: true, snapshot, decision };
  }

  private recordSpendSync(
    parsed: ParsedScope,
    channels: BudgetSpendChannels,
    opts?: { idempotencyKey?: string },
  ):
    | {
        ok: true;
        snapshot: BudgetSnapshot;
        decision: BudgetDecision;
        advisory?: BudgetAdvisory;
        duplicate?: boolean;
      }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const entry = this.entries.get(parsed.key);
    if (!entry) {
      return this.reject(
        "no_budget",
        parsed.subjectId,
        "setBudget before recordSpend",
        parsed.scope,
      );
    }
    if (
      !nonNegInt(channels.freshInputTokens) ||
      !nonNegInt(channels.cachedInputTokens) ||
      !nonNegInt(channels.outputTokens)
    ) {
      return this.reject(
        "invalid_budget",
        parsed.subjectId,
        "spend channels must be non-negative integers",
        parsed.scope,
      );
    }

    const applied = this.applyChannels(entry, channels, opts);
    if (!applied.ok) return applied;

    const decision = this.decisionAfterSpend(entry);
    let advisory: BudgetAdvisory | undefined;
    if (decision === "hardStop") {
      advisory = this.makeAdvisory(entry, BUDGET_ADVISORY_EXCEEDED);
      this.fireExceededOnce(entry, advisory);
    } else if (decision === "throttle") {
      advisory = this.makeAdvisory(entry, BUDGET_ADVISORY_WARNING);
      this.fireWarningOnce(entry, advisory);
    }

    const snapshot = this.toSnapshot(entry);
    this.telemetry({
      outcome: "ok",
      action: "record_spend",
      subjectId: entry.subjectId,
      decision,
      ...(advisory ? { advisoryCode: advisory.code } : {}),
      remaining: snapshot.remaining,
      used: snapshot.used,
      limit: snapshot.limit,
    });
    return {
      ok: true,
      snapshot,
      decision,
      ...(advisory !== undefined ? { advisory } : {}),
      ...(applied.duplicate ? { duplicate: true } : {}),
    };
  }

  private applyChannels(
    entry: LedgerEntry,
    channels: BudgetSpendChannels,
    opts?: { idempotencyKey?: string },
  ):
    | { ok: true; duplicate?: boolean }
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    if (opts?.idempotencyKey !== undefined) {
      const key =
        typeof opts.idempotencyKey === "string"
          ? opts.idempotencyKey.trim()
          : "";
      if (!key) {
        return this.reject(
          "invalid_budget",
          entry.subjectId,
          "idempotencyKey must be non-empty when provided",
          {
            subjectId: entry.subjectId,
            ...(entry.sessionId !== undefined
              ? { sessionId: entry.sessionId }
              : {}),
          },
        );
      }
      if (entry.seenIdemKeys.has(key)) {
        return { ok: true, duplicate: true };
      }
      if (entry.seenIdemKeys.size >= BUDGET_IDEM_KEY_LIMIT) {
        return this.reject(
          "idem_limit",
          entry.subjectId,
          `idempotency key budget ${BUDGET_IDEM_KEY_LIMIT} exceeded`,
          { subjectId: entry.subjectId },
        );
      }
      entry.seenIdemKeys.add(key);
    }

    const billed = billedTokens(channels);
    entry.used += billed;
    entry.freshInputTokens += channels.freshInputTokens;
    entry.cachedInputTokens += channels.cachedInputTokens;
    entry.outputTokens += channels.outputTokens;
    return { ok: true };
  }

  private decisionAfterSpend(entry: LedgerEntry): BudgetDecision {
    if (this.remainingOf(entry) <= 0) return "hardStop";
    if (this.usedRatio(entry) >= entry.warningThreshold) return "throttle";
    return "allow";
  }

  private remainingOf(entry: LedgerEntry): number {
    return Math.max(0, entry.limit - entry.used - entry.reserved);
  }

  private usedRatio(entry: LedgerEntry): number {
    if (entry.limit <= 0) return 1;
    return (entry.used + entry.reserved) / entry.limit;
  }

  private toSnapshot(entry: LedgerEntry): BudgetSnapshot {
    return {
      subjectId: entry.subjectId,
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      limit: entry.limit,
      used: entry.used,
      remaining: this.remainingOf(entry),
      reserved: entry.reserved,
      warningThreshold: entry.warningThreshold,
      warned: entry.warned,
      exceeded: entry.exceededFired || this.remainingOf(entry) <= 0,
      freshInputTokens: entry.freshInputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
    };
  }

  private makeAdvisory(
    entry: LedgerEntry,
    code: BudgetAdvisoryCode,
  ): BudgetAdvisory {
    return {
      code,
      subjectId: entry.subjectId,
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      limit: entry.limit,
      used: entry.used,
      remaining: this.remainingOf(entry),
      warningThreshold: entry.warningThreshold,
    };
  }

  private fireWarningOnce(entry: LedgerEntry, advisory: BudgetAdvisory): void {
    if (entry.warned) return;
    entry.warned = true;
    this.telemetry({
      outcome: "ok",
      action: "budget_warning",
      subjectId: entry.subjectId,
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      advisoryCode: BUDGET_ADVISORY_WARNING,
      remaining: advisory.remaining,
      limit: advisory.limit,
      used: advisory.used,
      decision: "throttle",
    });
    for (const handler of this.warningHandlers) {
      handler(advisory);
    }
  }

  private fireExceededOnce(entry: LedgerEntry, advisory: BudgetAdvisory): void {
    if (entry.exceededFired) return;
    entry.exceededFired = true;
    this.telemetry({
      outcome: "ok",
      action: "budget_exceeded",
      subjectId: entry.subjectId,
      ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      advisoryCode: BUDGET_ADVISORY_EXCEEDED,
      remaining: advisory.remaining,
      limit: advisory.limit,
      used: advisory.used,
      decision: "hardStop",
      freshInputTokens: entry.freshInputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
    });
    for (const handler of this.exceededHandlers) {
      handler(advisory);
    }
  }

  private parseScope(scope: BudgetScope):
    | ParsedScope
    | {
        ok: false;
        failureClass: BudgetManagerFailureClass;
        subjectId: string | null;
        detail: string;
      } {
    const subjectId =
      typeof scope.subjectId === "string" ? scope.subjectId.trim() : "";
    if (!subjectId) {
      return {
        ok: false,
        failureClass: "missing_subject",
        subjectId: null,
        detail: "subjectId required for budget scope",
      };
    }
    const sessionId =
      typeof scope.sessionId === "string" && scope.sessionId.trim()
        ? scope.sessionId.trim()
        : undefined;
    const deviceId =
      typeof scope.deviceId === "string" && scope.deviceId.trim()
        ? scope.deviceId.trim()
        : undefined;
    return {
      ok: true,
      key: scopeKey({
        subjectId,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }),
      subjectId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      scope: {
        subjectId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
      },
    };
  }

  private reject(
    failureClass: BudgetManagerFailureClass,
    subjectId: string | null,
    detail: string,
    scope?: BudgetScope,
  ): {
    ok: false;
    failureClass: BudgetManagerFailureClass;
    subjectId: string | null;
    detail: string;
  } {
    this.telemetry({
      outcome: "rejected",
      subjectId,
      ...(scope?.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
      ...(scope?.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
      failureClass,
    });
    return { ok: false, failureClass, subjectId, detail };
  }

  private async withSubjectLock<T>(
    key: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = prev.then(() => gate);
    this.locks.set(key, next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }

  private telemetry(
    partial: Omit<BudgetManagerTelemetryEvent, "event"> & {
      subjectId: string | null;
    },
  ): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.budget",
      ...partial,
    });
  }
}

type ParsedScope = {
  ok: true;
  key: string;
  subjectId: string;
  sessionId?: string;
  deviceId?: string;
  scope: BudgetScope;
};

export type BudgetHarnessErrorSpec = {
  code: typeof HARNESS_ERROR_BUDGET_EXCEEDED | typeof HARNESS_ERROR_BUDGET_THROTTLE;
  message: string;
  recoverable: boolean;
};

export type BudgetPreTurnGateProceed = {
  ok: true;
  proceed: true;
  decision: "allow";
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  snapshot: BudgetSnapshot;
  reservationId: string;
  advisory?: undefined;
};

export type BudgetPreTurnGateBlocked = {
  ok: true;
  proceed: false;
  decision: "throttle" | "hardStop";
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  snapshot: BudgetSnapshot;
  advisory: BudgetAdvisory;
  harnessError: BudgetHarnessErrorSpec;
};

export type BudgetPreTurnGateFailed = {
  ok: false;
  proceed: false;
  failureClass: BudgetManagerFailureClass;
  subjectId: string | null;
  deviceId?: string;
  sessionId?: string;
  detail: string;
};

export type BudgetPreTurnGateResult =
  | BudgetPreTurnGateProceed
  | BudgetPreTurnGateBlocked
  | BudgetPreTurnGateFailed;

/**
 * Pre-model budget gate with per-subject reservation.
 *
 * - `hardStop` / insufficient remaining → block with {@link BUDGET_ADVISORY_EXCEEDED}
 * - `throttle` (at/above warning threshold) → release reservation and reject the
 *   new turn with {@link BUDGET_ADVISORY_WARNING} (never silent truncation)
 * - `allow` → hold reservation until commit/release
 *
 * Call before model invocation — not after.
 */
export async function runBudgetPreTurnGate(
  manager: BudgetManager,
  scope: BudgetScope,
  estimatedTokens = 0,
): Promise<BudgetPreTurnGateResult> {
  const subjectId =
    typeof scope.subjectId === "string" ? scope.subjectId.trim() : "";
  if (!subjectId) {
    return {
      ok: false,
      proceed: false,
      failureClass: "missing_subject",
      subjectId: null,
      detail: "subjectId required for pre-turn budget gate",
    };
  }

  const reserved = await manager.reserve(scope, estimatedTokens);
  if (!reserved.ok) {
    if (
      reserved.failureClass === "no_budget" ||
      reserved.failureClass === "not_found"
    ) {
      return {
        ok: false,
        proceed: false,
        failureClass: reserved.failureClass,
        subjectId: reserved.subjectId,
        ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
        ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
        detail: reserved.detail,
      };
    }

    const snap = manager.getSnapshot(scope);
    const snapshot =
      snap.ok
        ? snap.snapshot
        : {
            subjectId,
            ...(scope.sessionId !== undefined
              ? { sessionId: scope.sessionId }
              : {}),
            ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
            limit: 0,
            used: 0,
            remaining: 0,
            reserved: 0,
            warningThreshold: BUDGET_WARNING_THRESHOLD_DEFAULT,
            warned: false,
            exceeded: true,
            freshInputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
          };

    const advisory =
      reserved.advisory ??
      ({
        code: BUDGET_ADVISORY_EXCEEDED,
        subjectId,
        ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
        ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
        limit: snapshot.limit,
        used: snapshot.used,
        remaining: snapshot.remaining,
        warningThreshold: snapshot.warningThreshold,
      } satisfies BudgetAdvisory);

    return {
      ok: true,
      proceed: false,
      decision: "hardStop",
      subjectId,
      ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
      ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
      snapshot,
      advisory,
      harnessError: {
        code: HARNESS_ERROR_BUDGET_EXCEEDED,
        message:
          "budget_exceeded: remaining token budget insufficient for turn",
        recoverable: false,
      },
    };
  }

  if (reserved.decision === "throttle") {
    manager.releaseReservation(scope, reserved.reservationId);
    const advisory =
      reserved.advisory ??
      ({
        code: BUDGET_ADVISORY_WARNING,
        subjectId,
        ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
        ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
        limit: reserved.snapshot.limit,
        used: reserved.snapshot.used,
        remaining: reserved.snapshot.remaining,
        warningThreshold: reserved.snapshot.warningThreshold,
      } satisfies BudgetAdvisory);

    return {
      ok: true,
      proceed: false,
      decision: "throttle",
      subjectId,
      ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
      ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
      snapshot: reserved.snapshot,
      advisory,
      harnessError: {
        code: HARNESS_ERROR_BUDGET_THROTTLE,
        message:
          "budget_warning: new turn rejected under throttle near budget limit",
        recoverable: true,
      },
    };
  }

  return {
    ok: true,
    proceed: true,
    decision: "allow",
    subjectId,
    ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
    ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
    snapshot: reserved.snapshot,
    reservationId: reserved.reservationId,
  };
}

export { BUDGET_DECISIONS, isBudgetDecision };
export type { BudgetDecision, BudgetHook, BudgetMeterTick };
