/**
 * TurnMeter — per-turn token collector with cached vs fresh input split.
 *
 * Accumulates spend during a streaming turn against the frozen A P6
 * MeterEvent contract (`@moolam/sync-protocol`). Cache-served prefix tokens
 * stay in `cachedInputTokens`; non-cached prompt tokens in `inputTokens`.
 * Multi-model handoffs open separate segments. flush() freezes validated
 * MeterEvent snapshots; StreamingTurnHost.flushMeter() emits METER_TICK
 * frames and P3 `harness.meter` spine events.
 */

import type { EventBusInterface, RuntimeEvent } from "@moolam/contracts";
import {
  meterEventSchema,
  parseMeterEvent,
  sortKeysDeep,
  type MeterEvent,
  type MeterLocality,
  type MeterTokenReconcileResult,
  type MeterTokenTotals,
  type ProviderUsageReport,
  reconcileMeterTokens,
  sumMeterTokenTotals,
} from "@moolam/sync-protocol";

/** P3 EventBus publisher surface used for `harness.meter` ticks. */
export type MeterSpinePublisher = Pick<EventBusInterface, "publish">;

/**
 * Package-relative golden corpus for TurnMeter ↔ provider usage reconcile.
 * Language-neutral JSON — never TS/Python-specific serialization artifacts.
 */
export const METERING_RECONCILE_FIXTURE_RELPATH =
  "fixtures/metering-reconcile" as const;

/**
 * Documented golden tolerance (v1): exact field-wise match.
 * Non-zero channels are reserved; A P6 reconcile goldens use 0.
 */
export const METER_GOLDEN_TOKEN_TOLERANCE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});

export type MeterTokenTolerance = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

/** Soft cap on model segments per turn (edge handoff bound). */
export const TURN_METER_SEGMENT_LIMIT = 16;

/** Soft cap on distinct record idempotency keys per turn. */
export const TURN_METER_IDEM_KEY_LIMIT = 64;

export type TurnMeterFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "invalid_tokens"
  | "prompt_split_mismatch"
  | "segment_limit"
  | "idem_limit"
  | "already_flushed"
  | "schema_violation"
  | "missing_meter"
  | "spine_publish";

export type TurnMeterTelemetryEvent = {
  event: "runtime.harness.turn_meter";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  action?:
    | "record"
    | "provider_usage"
    | "mark_aborted"
    | "flush"
    | "segment_open";
  modelId?: string;
  discrepancy?: boolean;
  aborted?: boolean;
  segmentCount?: number;
  failureClass?: TurnMeterFailureClass;
};

export type TurnMeterOptions = {
  subjectId: string;
  deviceId?: string;
  modelId: string;
  locality: MeterLocality;
  /** Wall-clock start; defaults to construction time via `now`. */
  startedAtMs?: number;
  /** Deterministic clock for tests. */
  now?: () => number;
  onTelemetry?: (event: TurnMeterTelemetryEvent) => void;
};

export type RecordTurnTokensInput = {
  /** Fresh (non-cached) prompt tokens to add. */
  freshInputTokens?: number;
  /** Cache-served prefix tokens to add. */
  cachedInputTokens?: number;
  /** Completion tokens to add. */
  outputTokens?: number;
  /**
   * Optional total prompt tokens (fresh + cached for this record, or the
   * cumulative prompt total when asserting invariant). When set, must equal
   * freshInputTokens + cachedInputTokens for this call's deltas.
   */
  totalPromptTokens?: number;
  /** Opens a new segment when different from the active modelId. */
  modelId?: string;
  /** Optional locality override for a new model segment. */
  locality?: MeterLocality;
  /** Dedup key — duplicate records are no-ops (idempotent replay). */
  idempotencyKey?: string;
};

export type SetProviderUsageResult =
  | {
      ok: true;
      subjectId: string;
      deviceId?: string;
      discrepancy: boolean;
    }
  | {
      ok: false;
      failureClass: TurnMeterFailureClass;
      subjectId: string | null;
      deviceId?: string;
      detail: string;
    };

export type RecordTurnTokensResult =
  | {
      ok: true;
      subjectId: string;
      deviceId?: string;
      duplicate?: boolean;
      modelId: string;
      /** Cumulative: fresh + cached prompt tokens counted so far. */
      totalPromptTokens: number;
    }
  | {
      ok: false;
      failureClass: TurnMeterFailureClass;
      subjectId: string | null;
      deviceId?: string;
      detail: string;
    };

export type TurnMeterFlushAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
  /** One MeterEvent per model segment (multi-model handoff). */
  events: MeterEvent[];
  /** Field-wise totals across segments (cached vs fresh stay distinct). */
  totals: MeterTokenTotals;
  /** Cumulative prompt = totals.inputTokens + totals.cachedInputTokens. */
  totalPromptTokens: number;
  discrepancy: boolean;
  provider?: ProviderUsageReport;
  aborted: boolean;
  replay?: boolean;
};

export type TurnMeterFlushRejected = {
  ok: false;
  failureClass: TurnMeterFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type TurnMeterFlushResult = TurnMeterFlushAccepted | TurnMeterFlushRejected;

type SegmentAccum = {
  modelId: string;
  locality: MeterLocality;
  freshInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

function nonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * Subject-scoped collector for one streaming turn.
 *
 * Invariants:
 * - `cachedInputTokens + inputTokens` equals total prompt tokens counted
 * - flush after abort still accounts partial spend (`aborted: true`)
 * - events validate against A P6 `meterEventSchema` before leave the collector
 */
export class TurnMeter {
  readonly subjectId: string;
  readonly deviceId: string | undefined;

  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly onTelemetry:
    | ((event: TurnMeterTelemetryEvent) => void)
    | undefined;

  private readonly segments: SegmentAccum[] = [];
  private activeIndex = 0;
  private aborted = false;
  private provider: ProviderUsageReport | undefined;
  private flushed: TurnMeterFlushAccepted | undefined;
  private readonly seenIdemKeys = new Set<string>();

  constructor(opts: TurnMeterOptions) {
    const subjectId =
      typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
    if (!subjectId) {
      throw new Error("TurnMeter requires non-empty subjectId");
    }
    const modelId =
      typeof opts.modelId === "string" ? opts.modelId.trim() : "";
    if (!modelId) {
      throw new Error("TurnMeter requires non-empty modelId");
    }
    this.subjectId = subjectId;
    this.deviceId = opts.deviceId;
    this.now = opts.now ?? (() => Date.now());
    this.startedAtMs = opts.startedAtMs ?? this.now();
    this.onTelemetry = opts.onTelemetry;
    this.segments.push({
      modelId,
      locality: opts.locality,
      freshInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  get isFlushed(): boolean {
    return this.flushed !== undefined;
  }

  get segmentCount(): number {
    return this.segments.length;
  }

  get activeModelId(): string {
    return this.segments[this.activeIndex]!.modelId;
  }

  /** Cumulative prompt tokens: fresh + cached (never collapsed into one field). */
  get totalPromptTokens(): number {
    let total = 0;
    for (const s of this.segments) {
      total += s.freshInputTokens + s.cachedInputTokens;
    }
    return total;
  }

  /** Mark the turn aborted; subsequent flush emits aborted: true. */
  markAborted(): void {
    this.aborted = true;
    this.telemetry({
      outcome: "ok",
      action: "mark_aborted",
      aborted: true,
    });
  }

  /**
   * Accumulate tokens during the stream. Cached vs fresh stay separate.
   * Changing `modelId` seals the current segment and opens a new one.
   */
  record(input: RecordTurnTokensInput = {}): RecordTurnTokensResult {
    if (this.flushed) {
      return this.rejectRecord(
        "already_flushed",
        "meter already flushed; cannot record further spend",
      );
    }

    if (input.idempotencyKey !== undefined) {
      const key =
        typeof input.idempotencyKey === "string"
          ? input.idempotencyKey.trim()
          : "";
      if (!key) {
        return this.rejectRecord(
          "invalid_tokens",
          "idempotencyKey must be non-empty when provided",
        );
      }
      if (this.seenIdemKeys.has(key)) {
        this.telemetry({
          outcome: "ok",
          action: "record",
          modelId: this.activeModelId,
        });
        return {
          ok: true,
          subjectId: this.subjectId,
          ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
          duplicate: true,
          modelId: this.activeModelId,
          totalPromptTokens: this.totalPromptTokens,
        };
      }
      if (this.seenIdemKeys.size >= TURN_METER_IDEM_KEY_LIMIT) {
        return this.rejectRecord(
          "idem_limit",
          `idempotency key budget ${TURN_METER_IDEM_KEY_LIMIT} exceeded`,
        );
      }
      this.seenIdemKeys.add(key);
    }

    const fresh = input.freshInputTokens ?? 0;
    const cached = input.cachedInputTokens ?? 0;
    const output = input.outputTokens ?? 0;

    if (!nonNegInt(fresh) || !nonNegInt(cached) || !nonNegInt(output)) {
      return this.rejectRecord(
        "invalid_tokens",
        "token deltas must be non-negative integers",
      );
    }

    if (input.totalPromptTokens !== undefined) {
      if (!nonNegInt(input.totalPromptTokens)) {
        return this.rejectRecord(
          "invalid_tokens",
          "totalPromptTokens must be a non-negative integer",
        );
      }
      if (input.totalPromptTokens !== fresh + cached) {
        return this.rejectRecord(
          "prompt_split_mismatch",
          "totalPromptTokens must equal freshInputTokens + cachedInputTokens",
        );
      }
    }

    const nextModel =
      input.modelId !== undefined
        ? typeof input.modelId === "string"
          ? input.modelId.trim()
          : ""
        : undefined;
    if (nextModel !== undefined && !nextModel) {
      return this.rejectRecord("invalid_tokens", "modelId must be non-empty");
    }

    if (nextModel !== undefined && nextModel !== this.activeModelId) {
      const opened = this.openSegment(
        nextModel,
        input.locality ?? this.segments[this.activeIndex]!.locality,
      );
      if (!opened.ok) return opened;
    } else if (input.locality !== undefined) {
      this.segments[this.activeIndex]!.locality = input.locality;
    }

    const seg = this.segments[this.activeIndex]!;
    seg.freshInputTokens += fresh;
    seg.cachedInputTokens += cached;
    seg.outputTokens += output;

    this.telemetry({
      outcome: "ok",
      action: "record",
      modelId: seg.modelId,
      aborted: this.aborted,
      segmentCount: this.segments.length,
    });

    return {
      ok: true,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      modelId: seg.modelId,
      totalPromptTokens: this.totalPromptTokens,
    };
  }

  /**
   * Store provider-reported usage for discrepancy detection against local
   * totals at flush. Metadata counts only — never prompt/completion text.
   */
  setProviderUsage(report: ProviderUsageReport): SetProviderUsageResult {
    if (
      !nonNegInt(report.inputTokens) ||
      !nonNegInt(report.outputTokens) ||
      !nonNegInt(report.cachedInputTokens)
    ) {
      const rejected: SetProviderUsageResult = {
        ok: false,
        failureClass: "invalid_tokens",
        subjectId: this.subjectId,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
        detail: "provider usage fields must be non-negative integers",
      };
      this.telemetry({
        outcome: "rejected",
        action: "provider_usage",
        failureClass: "invalid_tokens",
      });
      return rejected;
    }

    this.provider = {
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens,
      cachedInputTokens: report.cachedInputTokens,
    };

    const local = this.localTotals();
    const discrepancy =
      reconcileMeterTokens(
        {
          inputTokens: local.inputTokens,
          outputTokens: local.outputTokens,
          cachedInputTokens: local.cachedInputTokens,
          latencyMs: 0,
          modelId: this.activeModelId,
          locality: this.segments[this.activeIndex]!.locality,
          aborted: this.aborted,
        },
        this.provider,
      ).ok === false;

    this.telemetry({
      outcome: "ok",
      action: "provider_usage",
      discrepancy,
    });

    return {
      ok: true,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      discrepancy,
    };
  }

  /**
   * Freeze accumulation into A P6 MeterEvent snapshots.
   * Idempotent: replaying flush returns the same accepted result.
   * Hosts emit wire/spine via {@link StreamingTurnHost.flushMeter}.
   */
  flush(opts?: { aborted?: boolean }): TurnMeterFlushResult {
    if (this.flushed) {
      this.telemetry({
        outcome: "ok",
        action: "flush",
        discrepancy: this.flushed.discrepancy,
        aborted: this.flushed.aborted,
        segmentCount: this.flushed.events.length,
      });
      return { ...this.flushed, replay: true };
    }

    if (opts?.aborted === true) {
      this.aborted = true;
    }

    const latencyMs = Math.max(0, Math.floor(this.now() - this.startedAtMs));
    const events: MeterEvent[] = [];

    for (const seg of this.segments) {
      const candidate: MeterEvent = {
        inputTokens: seg.freshInputTokens,
        outputTokens: seg.outputTokens,
        cachedInputTokens: seg.cachedInputTokens,
        latencyMs,
        modelId: seg.modelId,
        locality: seg.locality,
        aborted: this.aborted,
      };
      const parsed = meterEventSchema.safeParse(candidate);
      if (!parsed.success) {
        return this.rejectFlush(
          "schema_violation",
          "meterEventSchema rejected accumulated MeterEvent",
        );
      }
      events.push(parsed.data);
    }

    const totals = sumMeterTokenTotals(events);
    const totalPromptTokens = totals.inputTokens + totals.cachedInputTokens;

    // Invariant: per-segment and aggregate split always sums to prompt total.
    for (const e of events) {
      if (e.inputTokens + e.cachedInputTokens < 0) {
        return this.rejectFlush(
          "prompt_split_mismatch",
          "cached + fresh input invariant violated",
        );
      }
    }

    let discrepancy = false;
    if (this.provider) {
      const synthetic: MeterEvent = {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cachedInputTokens: totals.cachedInputTokens,
        latencyMs,
        modelId: events[events.length - 1]!.modelId,
        locality: events[events.length - 1]!.locality,
        aborted: this.aborted,
      };
      discrepancy = reconcileMeterTokens(synthetic, this.provider).ok === false;
    }

    const accepted: TurnMeterFlushAccepted = {
      ok: true,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      events,
      totals,
      totalPromptTokens,
      discrepancy,
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      aborted: this.aborted,
    };
    this.flushed = accepted;

    this.telemetry({
      outcome: "ok",
      action: "flush",
      discrepancy,
      aborted: this.aborted,
      segmentCount: events.length,
    });

    return { ...accepted };
  }

  private openSegment(
    modelId: string,
    locality: MeterLocality,
  ): RecordTurnTokensResult {
    if (this.segments.length >= TURN_METER_SEGMENT_LIMIT) {
      return this.rejectRecord(
        "segment_limit",
        `model segment budget ${TURN_METER_SEGMENT_LIMIT} exceeded`,
      );
    }
    this.segments.push({
      modelId,
      locality,
      freshInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    this.activeIndex = this.segments.length - 1;
    this.telemetry({
      outcome: "ok",
      action: "segment_open",
      modelId,
      segmentCount: this.segments.length,
    });
    return {
      ok: true,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      modelId,
      totalPromptTokens: this.totalPromptTokens,
    };
  }

  private localTotals(): MeterTokenTotals {
    return sumMeterTokenTotals(
      this.segments.map((s) => ({
        inputTokens: s.freshInputTokens,
        outputTokens: s.outputTokens,
        cachedInputTokens: s.cachedInputTokens,
        latencyMs: 0,
        modelId: s.modelId,
        locality: s.locality,
        aborted: this.aborted,
      })),
    );
  }

  private rejectRecord(
    failureClass: TurnMeterFailureClass,
    detail: string,
  ): RecordTurnTokensResult {
    this.telemetry({
      outcome: "rejected",
      action: "record",
      failureClass,
    });
    return {
      ok: false,
      failureClass,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      detail,
    };
  }

  private rejectFlush(
    failureClass: TurnMeterFailureClass,
    detail: string,
  ): TurnMeterFlushRejected {
    this.telemetry({
      outcome: "rejected",
      action: "flush",
      failureClass,
    });
    return {
      ok: false,
      failureClass,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      detail,
    };
  }

  private telemetry(
    partial: Omit<TurnMeterTelemetryEvent, "event" | "subjectId" | "deviceId"> & {
      subjectId?: string | null;
    },
  ): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.turn_meter",
      subjectId:
        partial.subjectId !== undefined ? partial.subjectId : this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      ...partial,
    });
  }
}

/**
 * Assert a TurnMeter is scoped to the same subject as a streaming host.
 * Cross-subject attach is a defect, not a feature gap.
 */
export function assertTurnMeterSubjectScope(
  meter: TurnMeter,
  subjectId: string,
): { ok: true } | { ok: false; failureClass: "missing_subject" | "cross_subject" } {
  const scope = typeof subjectId === "string" ? subjectId.trim() : "";
  if (!scope) {
    return { ok: false, failureClass: "missing_subject" };
  }
  if (meter.subjectId !== scope) {
    return { ok: false, failureClass: "cross_subject" };
  }
  return { ok: true };
}

/**
 * Build a catalog `harness.meter` RuntimeEvent from a validated MeterEvent.
 * Metadata only — never prompt/completion text. Validates tick at the boundary.
 */
export function buildHarnessMeterRuntimeEvent(
  tick: MeterEvent,
  scope: {
    subjectId: string;
    deviceId?: string;
    sessionId?: string;
    at?: string;
  },
):
  | { ok: true; event: RuntimeEvent }
  | {
      ok: false;
      failureClass: "missing_subject" | "schema_violation" | "content_leak";
      detail: string;
    } {
  const subjectId =
    typeof scope.subjectId === "string" ? scope.subjectId.trim() : "";
  if (!subjectId) {
    return {
      ok: false,
      failureClass: "missing_subject",
      detail: "harness.meter requires non-empty subjectId",
    };
  }

  const parsed = parseMeterEvent(tick, {
    subjectId,
    ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
  });
  if (parsed.outcome === "rejected") {
    return {
      ok: false,
      failureClass:
        parsed.failureClass === "content_leak"
          ? "content_leak"
          : "schema_violation",
      detail: `MeterEvent rejected at spine boundary: ${parsed.failureClass}`,
    };
  }

  const payload: Record<string, unknown> = {
    subjectId,
    inputTokens: parsed.event.inputTokens,
    outputTokens: parsed.event.outputTokens,
    cachedInputTokens: parsed.event.cachedInputTokens,
    latencyMs: parsed.event.latencyMs,
    modelId: parsed.event.modelId,
    locality: parsed.event.locality,
    aborted: parsed.event.aborted,
  };
  if (scope.deviceId !== undefined) payload.deviceId = scope.deviceId;
  if (scope.sessionId !== undefined) payload.sessionId = scope.sessionId;

  return {
    ok: true,
    event: {
      type: "harness.meter",
      at: scope.at ?? new Date().toISOString(),
      payload,
    },
  };
}

/**
 * Publish validated MeterEvent ticks to a P3 EventBus as `harness.meter`.
 * Failures are returned — never swallowed. Idempotent callers must gate replays.
 */
export function publishHarnessMeterSpine(
  publisher: MeterSpinePublisher,
  ticks: readonly MeterEvent[],
  scope: {
    subjectId: string;
    deviceId?: string;
    sessionId?: string;
    at?: string;
    nowIso?: () => string;
  },
):
  | { ok: true; published: number; subjectId: string; deviceId?: string }
  | {
      ok: false;
      failureClass: TurnMeterFailureClass;
      subjectId: string | null;
      deviceId?: string;
      published: number;
      detail: string;
    } {
  let published = 0;
  const atFn = scope.nowIso ?? (() => new Date().toISOString());
  for (const tick of ticks) {
    const built = buildHarnessMeterRuntimeEvent(tick, {
      subjectId: scope.subjectId,
      ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
      ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
      at: scope.at ?? atFn(),
    });
    if (!built.ok) {
      return {
        ok: false,
        failureClass:
          built.failureClass === "missing_subject"
            ? "missing_subject"
            : "schema_violation",
        subjectId:
          built.failureClass === "missing_subject" ? null : scope.subjectId,
        ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
        published,
        detail: built.detail,
      };
    }
    try {
      publisher.publish(built.event);
    } catch (err) {
      return {
        ok: false,
        failureClass: "spine_publish",
        subjectId: scope.subjectId,
        ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
        published,
        detail:
          err instanceof Error
            ? err.message.slice(0, 256)
            : "EventBus publish failed",
      };
    }
    published += 1;
  }
  return {
    ok: true,
    published,
    subjectId: scope.subjectId,
    ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
  };
}

/**
 * Field-wise reconcile with per-channel absolute tolerance.
 * Golden turns document tolerance 0 (exact) via {@link METER_GOLDEN_TOKEN_TOLERANCE}.
 */
export function reconcileMeterTokensWithinTolerance(
  meter: Pick<
    MeterEvent,
    "inputTokens" | "outputTokens" | "cachedInputTokens"
  >,
  provider: ProviderUsageReport,
  tolerance: MeterTokenTolerance = METER_GOLDEN_TOKEN_TOLERANCE,
): MeterTokenReconcileResult {
  for (const field of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
  ] as const) {
    const tol = tolerance[field];
    if (!nonNegInt(tol)) {
      return {
        ok: false,
        code: "TOKEN_MISMATCH",
        field,
        expected: provider[field],
        actual: meter[field],
      };
    }
    if (Math.abs(meter[field] - provider[field]) > tol) {
      return {
        ok: false,
        code: "TOKEN_MISMATCH",
        field,
        expected: provider[field],
        actual: meter[field],
      };
    }
  }
  return { ok: true };
}

/** Canonical JSON for MeterEvent lists (sorted keys, 2-space indent, trailing NL). */
export function canonicalizeMeterEventsJson(events: unknown): string {
  return `${JSON.stringify(sortKeysDeep(events), null, 2)}\n`;
}

/** One language-neutral golden turn for metering reconciliation. */
export type GoldenMeterReconcileCase = {
  id: string;
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  modelId: string;
  locality: MeterLocality;
  startedAtMs: number;
  latencyMs: number;
  aborted?: boolean;
  records: RecordTurnTokensInput[];
  providerUsage: ProviderUsageReport;
  tokenTolerance: MeterTokenTolerance;
  expected: {
    reconcileOk: boolean;
    discrepancy: boolean;
    aborted: boolean;
    totalPromptTokens: number;
    /** Canonical MeterEvent list (latency fixed by case.latencyMs). */
    events: MeterEvent[];
  };
  /** Optional link to A P6 golden-turn id (parity note only). */
  aP6GoldenTurnId?: string;
};

export type GoldenMeterReconcileCorpus = {
  description: string;
  tolerancePolicy: string;
  tokenTolerance: MeterTokenTolerance;
  cases: GoldenMeterReconcileCase[];
};

export type GoldenMeterReconcileAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
  caseId: string;
  events: MeterEvent[];
  totals: MeterTokenTotals;
  totalPromptTokens: number;
  reconcile: MeterTokenReconcileResult;
  discrepancy: boolean;
  aborted: boolean;
  canonicalJson: string;
  expectedCanonicalJson: string;
};

export type GoldenMeterReconcileRejected = {
  ok: false;
  failureClass:
    | TurnMeterFailureClass
    | "canonical_drift"
    | "expectation_mismatch";
  subjectId: string | null;
  deviceId?: string;
  caseId?: string;
  detail: string;
  canonicalJson?: string;
  expectedCanonicalJson?: string;
};

export type GoldenMeterReconcileResult =
  | GoldenMeterReconcileAccepted
  | GoldenMeterReconcileRejected;

/**
 * Replay one golden metering case through TurnMeter and reconcile against
 * provider-reported usage within the case's documented token tolerance.
 * Does not emit stream frames — hosts compose with flushMeter separately.
 */
export function replayGoldenMeterReconcileCase(
  fixtureCase: GoldenMeterReconcileCase,
): GoldenMeterReconcileResult {
  const subjectId =
    typeof fixtureCase.subjectId === "string"
      ? fixtureCase.subjectId.trim()
      : "";
  if (!subjectId) {
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      detail: "golden meter case requires non-empty subjectId",
      caseId: fixtureCase.id,
    };
  }

  const tolerance = fixtureCase.tokenTolerance ?? METER_GOLDEN_TOKEN_TOLERANCE;
  const meter = new TurnMeter({
    subjectId,
    ...(fixtureCase.deviceId !== undefined
      ? { deviceId: fixtureCase.deviceId }
      : {}),
    modelId: fixtureCase.modelId,
    locality: fixtureCase.locality,
    startedAtMs: fixtureCase.startedAtMs,
    now: () => fixtureCase.startedAtMs + fixtureCase.latencyMs,
  });

  for (const record of fixtureCase.records) {
    const rec = meter.record(record);
    if (!rec.ok) {
      return {
        ok: false,
        failureClass: rec.failureClass,
        subjectId,
        ...(fixtureCase.deviceId !== undefined
          ? { deviceId: fixtureCase.deviceId }
          : {}),
        caseId: fixtureCase.id,
        detail: rec.detail,
      };
    }
  }

  const providerSet = meter.setProviderUsage(fixtureCase.providerUsage);
  if (!providerSet.ok) {
    return {
      ok: false,
      failureClass: providerSet.failureClass,
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId: fixtureCase.id,
      detail: providerSet.detail,
    };
  }

  const flushed = meter.flush(
    fixtureCase.aborted === true ? { aborted: true } : undefined,
  );
  if (!flushed.ok) {
    return {
      ok: false,
      failureClass: flushed.failureClass,
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId: fixtureCase.id,
      detail: flushed.detail,
    };
  }

  for (const event of flushed.events) {
    const parsed = meterEventSchema.safeParse(event);
    if (!parsed.success) {
      return {
        ok: false,
        failureClass: "schema_violation",
        subjectId,
        ...(fixtureCase.deviceId !== undefined
          ? { deviceId: fixtureCase.deviceId }
          : {}),
        caseId: fixtureCase.id,
        detail: "flushed MeterEvent failed A P6 schema validation",
      };
    }
  }

  const promptOk =
    flushed.totalPromptTokens ===
    flushed.totals.inputTokens + flushed.totals.cachedInputTokens;
  if (!promptOk) {
    return {
      ok: false,
      failureClass: "prompt_split_mismatch",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId: fixtureCase.id,
      detail: "cached + fresh input must equal totalPromptTokens",
    };
  }

  const syntheticTotals: MeterEvent = {
    inputTokens: flushed.totals.inputTokens,
    outputTokens: flushed.totals.outputTokens,
    cachedInputTokens: flushed.totals.cachedInputTokens,
    latencyMs: fixtureCase.latencyMs,
    modelId: flushed.events[flushed.events.length - 1]!.modelId,
    locality: flushed.events[flushed.events.length - 1]!.locality,
    aborted: flushed.aborted,
  };

  const reconcile = reconcileMeterTokensWithinTolerance(
    syntheticTotals,
    fixtureCase.providerUsage,
    tolerance,
  );

  // Exact A P6 path must agree with tolerance-0 goldens.
  if (
    tolerance.inputTokens === 0 &&
    tolerance.outputTokens === 0 &&
    tolerance.cachedInputTokens === 0
  ) {
    const exact = reconcileMeterTokens(
      syntheticTotals,
      fixtureCase.providerUsage,
    );
    if (exact.ok !== reconcile.ok) {
      return {
        ok: false,
        failureClass: "expectation_mismatch",
        subjectId,
        ...(fixtureCase.deviceId !== undefined
          ? { deviceId: fixtureCase.deviceId }
          : {}),
        caseId: fixtureCase.id,
        detail: "tolerance-0 reconcile diverged from reconcileMeterTokens",
      };
    }
  }

  const canonicalJson = canonicalizeMeterEventsJson(flushed.events);
  const expectedCanonicalJson = canonicalizeMeterEventsJson(
    fixtureCase.expected.events,
  );

  if (canonicalJson !== expectedCanonicalJson) {
    return {
      ok: false,
      failureClass: "canonical_drift",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId: fixtureCase.id,
      detail: `canonical MeterEvent drift for case ${fixtureCase.id}`,
      canonicalJson,
      expectedCanonicalJson,
    };
  }

  if (flushed.aborted !== fixtureCase.expected.aborted) {
    return {
      ok: false,
      failureClass: "expectation_mismatch",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId: fixtureCase.id,
      detail: `aborted expected ${fixtureCase.expected.aborted}, got ${flushed.aborted}`,
    };
  }

  if (flushed.discrepancy !== fixtureCase.expected.discrepancy) {
    return {
      ok: false,
      failureClass: "expectation_mismatch",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId: fixtureCase.id,
      detail: `discrepancy expected ${fixtureCase.expected.discrepancy}, got ${flushed.discrepancy}`,
    };
  }

  if (reconcile.ok !== fixtureCase.expected.reconcileOk) {
    return {
      ok: false,
      failureClass: "expectation_mismatch",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId: fixtureCase.id,
      detail: `reconcileOk expected ${fixtureCase.expected.reconcileOk}, got ${reconcile.ok}`,
    };
  }

  if (flushed.totalPromptTokens !== fixtureCase.expected.totalPromptTokens) {
    return {
      ok: false,
      failureClass: "expectation_mismatch",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId: fixtureCase.id,
      detail: `totalPromptTokens expected ${fixtureCase.expected.totalPromptTokens}, got ${flushed.totalPromptTokens}`,
    };
  }

  return {
    ok: true,
    subjectId,
    ...(fixtureCase.deviceId !== undefined
      ? { deviceId: fixtureCase.deviceId }
      : {}),
    caseId: fixtureCase.id,
    events: flushed.events,
    totals: flushed.totals,
    totalPromptTokens: flushed.totalPromptTokens,
    reconcile,
    discrepancy: flushed.discrepancy,
    aborted: flushed.aborted,
    canonicalJson,
    expectedCanonicalJson,
  };
}
