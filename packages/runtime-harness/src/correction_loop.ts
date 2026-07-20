/**
 * Correction loop — depth tracker, system-error formatter, and streaming-turn
 * host integration (inject → model resume → re-feed parser).
 *
 * On validation / policy / sandbox failures, hosts inject a system message that
 * names the violated rule (never stack traces or argument bodies), then
 * re-engage generation. Depth is capped by MAX_CORRECTION_TURNS (from config);
 * breach escalates as CORRECTION_EXHAUSTED (typed HARNESS_ERROR on the host).
 *
 * Cap-escalation regression fixture (CK-07): see
 * {@link CORRECTION_CAP_ESCALATION_FIXTURE_RELPATH}.
 */

import { SANDBOX_RESULT_SCHEMA_OBLIGATION } from "./sandbox_seam.js";
import type { StreamingTurnHost } from "./streaming_turn.js";
import type { ParseEvent, ToolCallParser } from "./tool_call_parser.js";

/**
 * Per-turn correction cap (CK-07 / AICA evaluator loop).
 * Aligns with act-stage iteration discipline in cognitive-core.
 */
export const MAX_CORRECTION_TURNS = 8;

/**
 * Dominance bound for process-reward critics (C3): |process| ≤ this value so
 * core-rubric obligation (−2.0) always keeps the net total negative.
 * MUST match `@moolam/learning` PROCESS_REWARD_ABS_CAP.
 */
export const PROCESS_REWARD_ABS_CAP = 0.5;


/** HARNESS_ERROR.code when correction depth is exhausted. */
export const CORRECTION_EXHAUSTED_CODE = "CORRECTION_EXHAUSTED";

/**
 * Package-relative fixture: seed model always returns an invalid tool call;
 * host must accept exactly maxCorrectionTurns repairs then escalate with
 * HARNESS_ERROR / CORRECTION_EXHAUSTED (CK-07).
 */
export const CORRECTION_CAP_ESCALATION_FIXTURE_RELPATH =
  "fixtures/correction-cap-escalation/always-invalid-tool-call.json" as const;

/**
 * Repo-relative process-reward correction-loop fixtures (C3).
 * Shared with `training/critics/fixtures/process-rewards`.
 */
export const PROCESS_REWARD_CORRECTION_FIXTURES_RELPATH =
  "training/critics/fixtures/process-rewards" as const;

/** Obligation / rule ids the formatter may cite. */
export const CORRECTION_RULE_ENVELOPE = "TOOL.ENVELOPE";
export const CORRECTION_RULE_RESULT_SCHEMA = SANDBOX_RESULT_SCHEMA_OBLIGATION;
export const CORRECTION_RULE_POLICY = "TOOL.POLICY";
export const CORRECTION_RULE_SANDBOX = "SANDBOX.INVOKE";

export type CorrectionFailureKind =
  | "envelope_invalid"
  | "schema_mismatch"
  | "policy_denial"
  | "sandbox_error";

export type CorrectionFailureInput = {
  kind: CorrectionFailureKind;
  /**
   * Stable rule / obligation id named to the model
   * (e.g. TOOL.ENVELOPE, SANDBOX.RESULT_SCHEMA).
   */
  rule: string;
  /** Closed error code when known (envelope code, failureClass, …). */
  code?: string;
  issuePath?: string;
  callIndex?: number;
  /** Optional tool call id for TOOL_STATUS error frame on the host. */
  toolCallId?: string;
  /**
   * Optional short hint. Stripped of stack-like content; never prefer this
   * over the named rule. Max length enforced in the formatter.
   */
  message?: string;
  /**
   * When true (default for tool-buffer / envelope failures), host must reset
   * the incremental parser to answer mode before re-generation.
   */
  requiresParserReset?: boolean;
};

export type CorrectionSystemError = {
  role: "system";
  /** JSON body for the model — structured correction payload only. */
  content: string;
  depth: number;
  rule: string;
  requiresParserReset: boolean;
};

export type CorrectionHarnessError = {
  code: typeof CORRECTION_EXHAUSTED_CODE;
  message: string;
  recoverable: false;
};

export type CorrectionRecordAccepted = {
  ok: true;
  depth: number;
  remaining: number;
  systemError: CorrectionSystemError;
  /** Same failure fingerprint as the previous cycle (still counts toward cap). */
  repeatedFailure: boolean;
};

export type CorrectionRecordRejected = {
  ok: false;
  failureClass:
    | "correction_exhausted"
    | "missing_subject"
    | "cross_subject"
    | "invalid_failure";
  depth: number;
  /** Present when failureClass is correction_exhausted. */
  harnessError?: CorrectionHarnessError;
  systemError?: CorrectionSystemError;
};

export type CorrectionRecordResult =
  | CorrectionRecordAccepted
  | CorrectionRecordRejected;

export type CorrectionLoopTelemetryEvent = {
  event: "runtime.harness.correction_loop";
  outcome: "corrected" | "exhausted" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  turnId?: string;
  depth?: number;
  maxDepth?: number;
  rule?: string;
  failureClass?: CorrectionRecordRejected["failureClass"];
  repeatedFailure?: boolean;
};

export type CorrectionDepthTrackerOptions = {
  subjectId: string;
  turnId: string;
  deviceId?: string;
  maxCorrectionTurns?: number;
  onTelemetry?: (event: CorrectionLoopTelemetryEvent) => void;
};

function sanitizeHint(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  // Strip stack-trace shaped content — never forward to the model.
  s = s.replace(/\r?\n\s*at\s+[^\n]+/g, "");
  s = s.replace(/\bError:\s*/g, "");
  s = s.replace(/\bstack\b/gi, "");
  s = s.slice(0, 160).trim();
  return s.length > 0 ? s : undefined;
}

function fingerprint(failure: CorrectionFailureInput): string {
  return [
    failure.kind,
    failure.rule.trim(),
    failure.code?.trim() ?? "",
    failure.issuePath?.trim() ?? "",
    failure.callIndex ?? "",
  ].join("|");
}

/**
 * Format a structured system-error message for model re-engagement.
 * Pure — does not mutate depth. Names the violated rule; no stacks.
 */
export function formatCorrectionSystemError(
  failure: CorrectionFailureInput,
  depth: number,
  maxDepth: number = MAX_CORRECTION_TURNS,
): CorrectionSystemError {
  const rule =
    typeof failure.rule === "string" && failure.rule.trim()
      ? failure.rule.trim().slice(0, 64)
      : "UNKNOWN.RULE";
  const hint = sanitizeHint(failure.message);
  const requiresParserReset = failure.requiresParserReset !== false;

  const payload = {
    kind: "correction" as const,
    depth,
    maxDepth,
    rule,
    ...(failure.code ? { code: String(failure.code).slice(0, 64) } : {}),
    ...(failure.issuePath
      ? { issuePath: String(failure.issuePath).slice(0, 128) }
      : {}),
    ...(typeof failure.callIndex === "number"
      ? { callIndex: failure.callIndex }
      : {}),
    message:
      hint ??
      `Violated rule ${rule}. Repair the tool call and continue. Do not emit stack traces.`,
    requiresParserReset,
  };

  return {
    role: "system",
    content: JSON.stringify(payload),
    depth,
    rule,
    requiresParserReset,
  };
}

/**
 * Per-turn correction depth tracker. Subject-scoped; one tracker per turn.
 */
export class CorrectionDepthTracker {
  readonly subjectId: string;
  readonly turnId: string;
  readonly deviceId: string | undefined;
  readonly maxCorrectionTurns: number;

  private depth = 0;
  private lastFingerprint: string | null = null;
  private readonly onTelemetry:
    | ((event: CorrectionLoopTelemetryEvent) => void)
    | undefined;

  constructor(opts: CorrectionDepthTrackerOptions) {
    const subjectId =
      typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
    if (!subjectId) {
      throw new Error("CorrectionDepthTracker requires non-empty subjectId");
    }
    const turnId = typeof opts.turnId === "string" ? opts.turnId.trim() : "";
    if (!turnId) {
      throw new Error("CorrectionDepthTracker requires non-empty turnId");
    }
    const max =
      opts.maxCorrectionTurns !== undefined
        ? opts.maxCorrectionTurns
        : MAX_CORRECTION_TURNS;
    if (!Number.isInteger(max) || max < 1 || max > 64) {
      throw new Error("maxCorrectionTurns must be an integer in 1..64");
    }
    this.subjectId = subjectId;
    this.turnId = turnId;
    this.deviceId = opts.deviceId?.trim() || undefined;
    this.maxCorrectionTurns = max;
    this.onTelemetry = opts.onTelemetry;
  }

  get currentDepth(): number {
    return this.depth;
  }

  get remaining(): number {
    return Math.max(0, this.maxCorrectionTurns - this.depth);
  }

  get exhausted(): boolean {
    return this.depth >= this.maxCorrectionTurns;
  }

  /**
   * Record a structured failure: increment depth, format system error, or
   * escalate when the cap is reached. Identical failures still count.
   *
   * Pass `scope.subjectId` to assert the caller's subject matches the tracker
   * (cross-subject writes are rejected).
   */
  recordFailure(
    failure: CorrectionFailureInput,
    scope?: { subjectId: string },
  ): CorrectionRecordResult {
    if (scope !== undefined) {
      const sid =
        typeof scope.subjectId === "string" ? scope.subjectId.trim() : "";
      if (!sid) {
        this.emitTel({
          outcome: "rejected",
          subjectId: this.subjectId,
          failureClass: "missing_subject",
          depth: this.depth,
        });
        return {
          ok: false,
          failureClass: "missing_subject",
          depth: this.depth,
        };
      }
      if (sid !== this.subjectId) {
        this.emitTel({
          outcome: "rejected",
          subjectId: this.subjectId,
          failureClass: "cross_subject",
          depth: this.depth,
        });
        return {
          ok: false,
          failureClass: "cross_subject",
          depth: this.depth,
        };
      }
    }

    if (!failure || typeof failure.rule !== "string" || !failure.rule.trim()) {
      this.emitTel({
        outcome: "rejected",
        subjectId: this.subjectId,
        failureClass: "invalid_failure",
        depth: this.depth,
      });
      return {
        ok: false,
        failureClass: "invalid_failure",
        depth: this.depth,
      };
    }

    const fp = fingerprint(failure);
    const repeatedFailure = this.lastFingerprint === fp;
    this.lastFingerprint = fp;

    if (this.depth >= this.maxCorrectionTurns) {
      const harnessError: CorrectionHarnessError = {
        code: CORRECTION_EXHAUSTED_CODE,
        message: `correction depth exhausted at ${this.depth}/${this.maxCorrectionTurns}`,
        recoverable: false,
      };
      this.emitTel({
        outcome: "exhausted",
        subjectId: this.subjectId,
        depth: this.depth,
        maxDepth: this.maxCorrectionTurns,
        rule: failure.rule.trim().slice(0, 64),
        failureClass: "correction_exhausted",
        repeatedFailure,
      });
      return {
        ok: false,
        failureClass: "correction_exhausted",
        depth: this.depth,
        harnessError,
      };
    }

    this.depth += 1;
    const systemError = formatCorrectionSystemError(
      failure,
      this.depth,
      this.maxCorrectionTurns,
    );

    this.emitTel({
      outcome: "corrected",
      subjectId: this.subjectId,
      depth: this.depth,
      maxDepth: this.maxCorrectionTurns,
      rule: systemError.rule,
      repeatedFailure,
    });

    return {
      ok: true,
      depth: this.depth,
      remaining: this.remaining,
      systemError,
      repeatedFailure,
    };
  }

  /**
   * Attempt a correction; if this would exceed the cap, return exhausted
   * without incrementing past max (idempotent with recordFailure pre-check).
   */
  tryCorrect(
    failure: CorrectionFailureInput,
    scope?: { subjectId: string },
  ): CorrectionRecordResult {
    return this.recordFailure(failure, scope);
  }

  private emitTel(
    partial: Omit<CorrectionLoopTelemetryEvent, "event" | "turnId"> & {
      turnId?: string;
    },
  ): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.correction_loop",
      turnId: this.turnId,
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
      ...partial,
      subjectId: partial.subjectId,
      outcome: partial.outcome,
    });
  }
}

/**
 * Correction-cycle features for process-reward critics (C3).
 * Pure snapshot — no learner content; subject-scoped identifiers only.
 */
export type CorrectionCycleFeatures = {
  subjectId: string;
  turnId: string;
  deviceId?: string;
  /** Observed repair depth (0 = no corrections). */
  correctionDepth: number;
  maxCorrectionTurns: number;
  /** min(correctionDepth, maxCorrectionTurns) — never exceeds the cap. */
  effectiveDepth: number;
  /** True when depth reached MAX_CORRECTION_TURNS (exhausted / farming floor). */
  cappedAtMax: boolean;
  /** First actionable tool call succeeded with zero prior repairs. */
  firstPassValidToolCall: boolean;
  /**
   * First-pass process bonus eligibility. False when any repair occurred,
   * the cap was hit, or the host started a synthetic retry after exhaustion.
   */
  firstPassBonusEligible: boolean;
  /** Host escalated CORRECTION_EXHAUSTED then opened a synthetic retry turn. */
  syntheticRetryAfterExhaustion: boolean;
};

/**
 * Build correction-cycle features from depth + first-pass validity.
 * Caps depth at maxCorrectionTurns; synthetic post-exhaustion retries never
 * regain first-pass bonus eligibility.
 */
export function buildCorrectionCycleFeatures(input: {
  subjectId: string;
  turnId: string;
  deviceId?: string;
  correctionDepth: number;
  maxCorrectionTurns?: number;
  firstPassValidToolCall: boolean;
  syntheticRetryAfterExhaustion?: boolean;
}): CorrectionCycleFeatures {
  const subjectId =
    typeof input.subjectId === "string" ? input.subjectId.trim() : "";
  if (!subjectId) {
    throw new Error("buildCorrectionCycleFeatures requires subjectId");
  }
  const turnId = typeof input.turnId === "string" ? input.turnId.trim() : "";
  if (!turnId) {
    throw new Error("buildCorrectionCycleFeatures requires turnId");
  }
  const max =
    input.maxCorrectionTurns !== undefined
      ? input.maxCorrectionTurns
      : MAX_CORRECTION_TURNS;
  if (!Number.isInteger(max) || max < 1 || max > 64) {
    throw new Error("maxCorrectionTurns must be an integer in 1..64");
  }
  const rawDepth =
    typeof input.correctionDepth === "number" &&
    Number.isFinite(input.correctionDepth)
      ? Math.max(0, Math.floor(input.correctionDepth))
      : 0;
  const cappedAtMax = rawDepth >= max;
  const effectiveDepth = Math.min(rawDepth, max);
  const synthetic = input.syntheticRetryAfterExhaustion === true;
  const firstPassValid =
    input.firstPassValidToolCall === true &&
    effectiveDepth === 0 &&
    !synthetic &&
    !cappedAtMax;
  const firstPassBonusEligible = firstPassValid;

  const features: CorrectionCycleFeatures = {
    subjectId,
    turnId,
    correctionDepth: rawDepth,
    maxCorrectionTurns: max,
    effectiveDepth,
    cappedAtMax,
    firstPassValidToolCall: firstPassValid,
    firstPassBonusEligible,
    syntheticRetryAfterExhaustion: synthetic,
  };
  if (input.deviceId !== undefined && input.deviceId.trim()) {
    features.deviceId = input.deviceId.trim();
  }
  return features;
}

/**
 * Snapshot features from a live CorrectionDepthTracker (harness telemetry path).
 */
export function snapshotCorrectionCycleFeatures(
  tracker: CorrectionDepthTracker,
  opts: {
    firstPassValidToolCall: boolean;
    syntheticRetryAfterExhaustion?: boolean;
  },
): CorrectionCycleFeatures {
  return buildCorrectionCycleFeatures({
    subjectId: tracker.subjectId,
    turnId: tracker.turnId,
    ...(tracker.deviceId !== undefined ? { deviceId: tracker.deviceId } : {}),
    correctionDepth: tracker.currentDepth,
    maxCorrectionTurns: tracker.maxCorrectionTurns,
    firstPassValidToolCall: opts.firstPassValidToolCall,
    ...(opts.syntheticRetryAfterExhaustion !== undefined
      ? {
          syntheticRetryAfterExhaustion: opts.syntheticRetryAfterExhaustion,
        }
      : {}),
  });
}

/** Host/runtime config surface for the correction-loop cap. */
export type CorrectionLoopConfig = {
  /** Per-turn correction cap; defaults to MAX_CORRECTION_TURNS. */
  maxCorrectionTurns?: number;
};

/**
 * Resolve MAX_CORRECTION_TURNS from config (integer 1..64).
 */
export function resolveMaxCorrectionTurns(
  config?: CorrectionLoopConfig | null,
): number {
  const raw = config?.maxCorrectionTurns;
  if (raw === undefined || raw === null) return MAX_CORRECTION_TURNS;
  if (!Number.isInteger(raw) || raw < 1 || raw > 64) {
    throw new Error("maxCorrectionTurns must be an integer in 1..64");
  }
  return raw;
}

export type CorrectionModelResumeResult = {
  /** Model generation chunks after system-error injection. */
  chunks:
    | AsyncIterable<string>
    | Iterable<string>
    | readonly string[]
    | string;
};

/**
 * Inject structured system error into model context and resume generation.
 * Implementations must not log raw learner content from `systemError.content`.
 */
export type CorrectionModelResumeFn = (args: {
  subjectId: string;
  turnId: string;
  systemError: CorrectionSystemError;
  depth: number;
}) => Promise<CorrectionModelResumeResult> | CorrectionModelResumeResult;

export type StreamingTurnCorrectionLoopOptions = {
  host: StreamingTurnHost;
  parser: ToolCallParser;
  turnId: string;
  /** Cap source — `maxCorrectionTurns` overrides the package default. */
  config?: CorrectionLoopConfig;
  deviceId?: string;
  resumeModel: CorrectionModelResumeFn;
  onTelemetry?: (event: CorrectionLoopTelemetryEvent) => void;
  /**
   * Optional hook when resume stream closes a tool fence (validation /
   * sandbox is the caller's next step — this loop does not auto-invoke).
   */
  onToolBuffer?: (body: string) => void;
};

export type CorrectionCycleAccepted = {
  ok: true;
  action: "corrected";
  depth: number;
  remaining: number;
  systemError: CorrectionSystemError;
  parserReset: boolean;
  chunksFed: number;
  framesEmitted: number;
  repeatedFailure: boolean;
};

export type CorrectionCycleExhausted = {
  ok: false;
  action: "exhausted";
  failureClass: "correction_exhausted";
  depth: number;
  harnessError: CorrectionHarnessError;
  /** True when the host accepted a terminal HARNESS_ERROR frame. */
  terminated: boolean;
};

export type CorrectionCycleRejected = {
  ok: false;
  action: "rejected";
  failureClass:
    | "missing_subject"
    | "cross_subject"
    | "invalid_failure"
    | "model_resume_failed"
    | "host_emit_failed"
    | "stream_already_terminated";
  depth: number;
  detail?: string;
};

export type CorrectionCycleResult =
  | CorrectionCycleAccepted
  | CorrectionCycleExhausted
  | CorrectionCycleRejected;

/**
 * Per-turn bridge: validation failure → system-error inject → model resume →
 * parser re-feed → host delta frames. Subject-scoped to the host.
 */
export class StreamingTurnCorrectionLoop {
  readonly subjectId: string;
  readonly turnId: string;
  readonly maxCorrectionTurns: number;

  private readonly host: StreamingTurnHost;
  private readonly parser: ToolCallParser;
  private readonly tracker: CorrectionDepthTracker;
  private readonly resumeModel: CorrectionModelResumeFn;
  private readonly onToolBuffer:
    | ((body: string) => void)
    | undefined;
  private readonly deviceId: string | undefined;

  private lastIdempotencyKey: string | null = null;
  private lastCycleResult: CorrectionCycleResult | null = null;
  private inFlight = false;

  constructor(opts: StreamingTurnCorrectionLoopOptions) {
    const turnId = typeof opts.turnId === "string" ? opts.turnId.trim() : "";
    if (!turnId) {
      throw new Error("StreamingTurnCorrectionLoop requires non-empty turnId");
    }
    if (opts.parser.subjectId !== opts.host.subjectId) {
      throw new Error(
        "parser.subjectId must match StreamingTurnHost subjectId",
      );
    }
    this.host = opts.host;
    this.parser = opts.parser;
    this.subjectId = opts.host.subjectId;
    this.turnId = turnId;
    this.deviceId = opts.deviceId?.trim() || opts.host.deviceId;
    this.maxCorrectionTurns = resolveMaxCorrectionTurns(opts.config);
    this.resumeModel = opts.resumeModel;
    this.onToolBuffer = opts.onToolBuffer;
    this.tracker = new CorrectionDepthTracker({
      subjectId: this.subjectId,
      turnId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      maxCorrectionTurns: this.maxCorrectionTurns,
      ...(opts.onTelemetry !== undefined
        ? { onTelemetry: opts.onTelemetry }
        : {}),
    });
  }

  get currentDepth(): number {
    return this.tracker.currentDepth;
  }

  get remaining(): number {
    return this.tracker.remaining;
  }

  get exhausted(): boolean {
    return this.tracker.exhausted;
  }

  /**
   * On structured validation failure: inject system error, resume the model,
   * reset the parser when needed, and re-feed resumed chunks into the parser
   * (emitting thought/answer deltas on the host). Cap breach terminates the
   * stream with HARNESS_ERROR / CORRECTION_EXHAUSTED.
   */
  async handleValidationFailure(
    failure: CorrectionFailureInput,
    opts?: { subjectId?: string; idempotencyKey?: string },
  ): Promise<CorrectionCycleResult> {
    const key =
      typeof opts?.idempotencyKey === "string" && opts.idempotencyKey.trim()
        ? opts.idempotencyKey.trim().slice(0, 128)
        : null;
    if (
      key !== null &&
      key === this.lastIdempotencyKey &&
      this.lastCycleResult !== null
    ) {
      return this.lastCycleResult;
    }

    if (this.inFlight) {
      return {
        ok: false,
        action: "rejected",
        failureClass: "host_emit_failed",
        depth: this.tracker.currentDepth,
        detail: "correction cycle already in flight for this turn",
      };
    }

    if (this.host.isTerminated) {
      return {
        ok: false,
        action: "rejected",
        failureClass: "stream_already_terminated",
        depth: this.tracker.currentDepth,
        detail: "stream already terminated",
      };
    }

    const scopeSubject =
      opts?.subjectId !== undefined
        ? opts.subjectId
        : this.subjectId;

    this.inFlight = true;
    try {
      const recorded = this.tracker.recordFailure(failure, {
        subjectId: scopeSubject,
      });

      if (!recorded.ok) {
        if (recorded.failureClass === "correction_exhausted") {
          const harnessError = recorded.harnessError ?? {
            code: CORRECTION_EXHAUSTED_CODE,
            message: `correction depth exhausted at ${recorded.depth}/${this.maxCorrectionTurns}`,
            recoverable: false as const,
          };
          const term = this.host.terminateWithError({
            code: harnessError.code,
            message: harnessError.message,
            recoverable: false,
          });
          const result: CorrectionCycleExhausted = {
            ok: false,
            action: "exhausted",
            failureClass: "correction_exhausted",
            depth: recorded.depth,
            harnessError,
            terminated: term.ok,
          };
          this.remember(key, result);
          return result;
        }
        const result: CorrectionCycleRejected = {
          ok: false,
          action: "rejected",
          failureClass: recorded.failureClass,
          depth: recorded.depth,
        };
        this.remember(key, result);
        return result;
      }

      const { systemError } = recorded;
      const parserWasOpen =
        this.parser.currentMode === "tool_buffer" ||
        this.parser.currentMode === "thought" ||
        this.parser.currentMode === "violation";
      const parserReset =
        systemError.requiresParserReset || parserWasOpen;
      if (parserReset) {
        this.parser.resetToSafeMode();
      }

      if (
        typeof failure.toolCallId === "string" &&
        failure.toolCallId.trim()
      ) {
        const status = this.host.emitToolStatus({
          toolCallId: failure.toolCallId.trim().slice(0, 128),
          status: "error",
          detail: systemError.rule,
        });
        if (!status.ok) {
          const result: CorrectionCycleRejected = {
            ok: false,
            action: "rejected",
            failureClass:
              status.failureClass === "stream_already_terminated"
                ? "stream_already_terminated"
                : "host_emit_failed",
            depth: recorded.depth,
            detail: status.detail,
          };
          this.remember(key, result);
          return result;
        }
      }

      let resume: CorrectionModelResumeResult;
      try {
        resume = await this.resumeModel({
          subjectId: this.subjectId,
          turnId: this.turnId,
          systemError,
          depth: recorded.depth,
        });
      } catch (err) {
        if (!this.host.isTerminated) {
          this.host.terminateWithError({
            code: "MODEL_RESUME_FAILED",
            message:
              err instanceof Error
                ? err.message.slice(0, 256)
                : "model resume failed",
            recoverable: true,
          });
        }
        const result: CorrectionCycleRejected = {
          ok: false,
          action: "rejected",
          failureClass: "model_resume_failed",
          depth: recorded.depth,
          detail: "resumeModel threw",
        };
        this.remember(key, result);
        return result;
      }

      let chunksFed = 0;
      let framesEmitted = 0;
      try {
        for await (const chunk of iterateChunks(resume.chunks)) {
          if (typeof chunk !== "string" || chunk.length === 0) continue;
          chunksFed += 1;
          const events = this.parser.feed(chunk);
          const applied = this.applyParseEvents(events);
          if (!applied.ok) {
            const result: CorrectionCycleRejected = {
              ok: false,
              action: "rejected",
              failureClass: applied.failureClass,
              depth: recorded.depth,
              detail: applied.detail,
            };
            this.remember(key, result);
            return result;
          }
          framesEmitted += applied.framesEmitted;
        }
        // Answer/thought text is held across chunks for purity — flush the
        // resume segment so the host surfaces deltas before the next tool call.
        const flushed = this.applyParseEvents(this.parser.flushPendingDeltas());
        if (!flushed.ok) {
          const result: CorrectionCycleRejected = {
            ok: false,
            action: "rejected",
            failureClass: flushed.failureClass,
            depth: recorded.depth,
            detail: flushed.detail,
          };
          this.remember(key, result);
          return result;
        }
        framesEmitted += flushed.framesEmitted;
      } catch (err) {
        if (!this.host.isTerminated) {
          this.host.terminateWithError({
            code: "MODEL_RESUME_FAILED",
            message:
              err instanceof Error
                ? err.message.slice(0, 256)
                : "model resume stream failed",
            recoverable: true,
          });
        }
        const result: CorrectionCycleRejected = {
          ok: false,
          action: "rejected",
          failureClass: "model_resume_failed",
          depth: recorded.depth,
          detail: "resume chunk stream failed",
        };
        this.remember(key, result);
        return result;
      }

      const result: CorrectionCycleAccepted = {
        ok: true,
        action: "corrected",
        depth: recorded.depth,
        remaining: recorded.remaining,
        systemError,
        parserReset,
        chunksFed,
        framesEmitted,
        repeatedFailure: recorded.repeatedFailure,
      };
      this.remember(key, result);
      return result;
    } finally {
      this.inFlight = false;
    }
  }

  private remember(
    key: string | null,
    result: CorrectionCycleResult,
  ): void {
    if (key === null) return;
    this.lastIdempotencyKey = key;
    this.lastCycleResult = result;
  }

  private applyParseEvents(events: readonly ParseEvent[]): {
    ok: true;
    framesEmitted: number;
  } | {
    ok: false;
    failureClass: CorrectionCycleRejected["failureClass"];
    detail: string;
  } {
    let framesEmitted = 0;
    for (const event of events) {
      if (event.type === "thought_delta") {
        const r = this.host.emitThoughtDelta(event.delta);
        if (!r.ok) {
          return {
            ok: false,
            failureClass:
              r.failureClass === "stream_already_terminated"
                ? "stream_already_terminated"
                : "host_emit_failed",
            detail: r.detail,
          };
        }
        framesEmitted += 1;
      } else if (event.type === "answer_delta") {
        const r = this.host.emitAnswerDelta(event.delta);
        if (!r.ok) {
          return {
            ok: false,
            failureClass:
              r.failureClass === "stream_already_terminated"
                ? "stream_already_terminated"
                : "host_emit_failed",
            detail: r.detail,
          };
        }
        framesEmitted += 1;
      } else if (event.type === "tool_buffer") {
        this.onToolBuffer?.(event.body);
      }
      // mode_change / tool_buffer_delta / violation: metadata only — no frames
    }
    return { ok: true, framesEmitted };
  }
}

async function* iterateChunks(
  source:
    | AsyncIterable<string>
    | Iterable<string>
    | readonly string[]
    | string,
): AsyncGenerator<string> {
  if (typeof source === "string") {
    yield source;
    return;
  }
  const maybeAsync = source as AsyncIterable<string>;
  if (
    maybeAsync &&
    typeof (maybeAsync as AsyncIterable<string>)[Symbol.asyncIterator] ===
      "function"
  ) {
    for await (const chunk of maybeAsync) {
      yield chunk;
    }
    return;
  }
  for (const chunk of source as Iterable<string>) {
    yield chunk;
  }
}
