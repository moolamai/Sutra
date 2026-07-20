/**
 * B3 tool-approval + B4 abandonment surfaces → trajectory human_outcome_signal.
 *
 * Host approval allow → ACCEPTED; deny → REJECTED. Persist on TURN_COMPLETE
 * via the learning outcome ledger. Typed enum only — never free strings.
 *
 * B4: explicit user discard and abort-without-accept → DISCARDED.
 * Silent approval timeout is a distinct harness event, not DISCARDED.
 * Accept-vs-abort: already_completed must not overwrite ACCEPTED with DISCARDED.
 *
 * Golden e2e turns: `fixtures/outcome-signal/` (accept/reject/discard/abort/correction).
 */

import {
  MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL,
  OutcomeSignalLedger,
  approvalDecisionToOutcome,
  persistTrajectoryWithOutcome,
  type AbandonmentKind,
  type FinalizedOutcomeBinding,
  type HumanOutcomeSignal,
  type OutcomeSignalFailureClass,
  type TurnTrajectoryRecord,
  type TurnTrajectoryWithOutcome,
} from "@moolam/learning";

/** AbortPipeline `action` values that interact with DISCARDED mapping. */
export type AbortSurfaceAction =
  | "aborted"
  | "already_aborted"
  | "already_completed";

export type ApprovalSurfaceRiskClass = "write" | "critical";

export type ApprovalSurfaceDecision = "allow" | "deny";

/** Host-facing approval context — metadata only, never tool argument bodies. */
export type ApprovalSurfaceContext = {
  subjectId: string;
  turnId: string;
  sessionId: string;
  deviceId?: string;
  toolName: string;
  riskClass: ApprovalSurfaceRiskClass;
};

/**
 * Host callback for write/critical approval (B3 surface).
 * Resolve "allow" → ACCEPTED, "deny" → REJECTED on the turn slot.
 */
export type HostApprovalCallback = (
  ctx: ApprovalSurfaceContext,
) => Promise<ApprovalSurfaceDecision>;

export type ApprovalSurfaceTelemetryEvent = {
  event: "runtime.harness.approval_surface";
  subjectId: string | null;
  deviceId?: string;
  turnId?: string;
  outcome: "ok" | "rejected" | "queued";
  failureClass?: OutcomeSignalFailureClass | "approval_timeout" | "config";
  humanOutcomeSignal?: HumanOutcomeSignal;
  harnessEvent?: "approval_timeout";
  toolName?: string;
  riskClass?: ApprovalSurfaceRiskClass;
  abandonmentKind?: AbandonmentKind;
  abortAction?: AbortSurfaceAction;
};

export type ApprovalSurfaceOptions = {
  onApproval?: HostApprovalCallback;
  onTelemetry?: (event: ApprovalSurfaceTelemetryEvent) => void;
  /**
   * Async trajectory writer invoked on TURN_COMPLETE after outcome seal.
   * Hot path returns before I/O completes.
   */
  persistTrajectory?: (
    record: TurnTrajectoryWithOutcome,
  ) => void | Promise<void>;
};

export type ApprovalTurnBeginResult =
  | { ok: true; subjectId: string; turnId: string }
  | {
      ok: false;
      failureClass: OutcomeSignalFailureClass | "config";
      detail: string;
    };

export type ApprovalDecideResult =
  | {
      ok: true;
      allowed: boolean;
      humanOutcomeSignal: "ACCEPTED" | "REJECTED";
    }
  | {
      ok: false;
      failureClass: OutcomeSignalFailureClass | "approval_timeout" | "config";
      detail: string;
      /** true when the wait expired without a user decision. */
      timedOut?: boolean;
    };

export type ApprovalCompleteResult =
  | {
      ok: true;
      binding: FinalizedOutcomeBinding;
      persisted: boolean;
    }
  | {
      ok: false;
      failureClass: OutcomeSignalFailureClass | "config";
      detail: string;
    };

export type DiscardTurnResult =
  | {
      ok: true;
      binding: FinalizedOutcomeBinding;
      persisted: boolean;
      abandonmentKind: AbandonmentKind;
    }
  | {
      ok: false;
      failureClass: OutcomeSignalFailureClass | "config";
      detail: string;
    };

export type MapAbortToDiscardResult =
  | {
      ok: true;
      /** true when DISCARDED was sealed (or already sealed as DISCARDED). */
      discarded: boolean;
      /** true when abort was already_completed — ACCEPTED kept. */
      skipped: boolean;
      binding?: FinalizedOutcomeBinding;
      persisted: boolean;
    }
  | {
      ok: false;
      failureClass: OutcomeSignalFailureClass | "config";
      detail: string;
    };

/**
 * Per-turn approval → outcome bridge. Subject-scoped; set-once signal until
 * TURN_COMPLETE finalizes and (optionally) enqueues trajectory persist.
 */
export class ApprovalSurface {
  private readonly ledger: OutcomeSignalLedger;
  private readonly onApproval: HostApprovalCallback | undefined;
  private readonly onTelemetry:
    | ((e: ApprovalSurfaceTelemetryEvent) => void)
    | undefined;
  private readonly persistTrajectory:
    | ((record: TurnTrajectoryWithOutcome) => void | Promise<void>)
    | undefined;
  /** Pending trajectory stubs keyed by subjectId\0turnId. */
  private readonly pendingRecords = new Map<string, TurnTrajectoryRecord>();

  constructor(options: ApprovalSurfaceOptions = {}) {
    this.onApproval = options.onApproval;
    this.onTelemetry = options.onTelemetry;
    this.persistTrajectory = options.persistTrajectory;
    this.ledger = new OutcomeSignalLedger({
      onTelemetry: (e) => {
        this.onTelemetry?.({
          event: "runtime.harness.approval_surface",
          subjectId: e.subjectId,
          ...(e.deviceId !== undefined ? { deviceId: e.deviceId } : {}),
          ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
          outcome: e.outcome === "queued" ? "queued" : e.outcome,
          ...(e.failureClass !== undefined
            ? { failureClass: e.failureClass }
            : {}),
          ...(e.humanOutcomeSignal !== undefined
            ? { humanOutcomeSignal: e.humanOutcomeSignal }
            : {}),
          ...(e.harnessEvent !== undefined
            ? { harnessEvent: e.harnessEvent }
            : {}),
        });
      },
    });
  }

  private key(subjectId: string, turnId: string): string {
    return `${subjectId}\0${turnId}`;
  }

  private emit(event: ApprovalSurfaceTelemetryEvent): void {
    this.onTelemetry?.(event);
  }

  /**
   * Open the outcome slot for a turn. Optionally stash a trajectory draft
   * for async persist on TURN_COMPLETE.
   */
  beginTurn(input: {
    subjectId: string;
    turnId: string;
    deviceId?: string;
    trajectoryDraft?: TurnTrajectoryRecord;
  }): ApprovalTurnBeginResult {
    if (
      input.trajectoryDraft &&
      input.trajectoryDraft.subjectId !== input.subjectId
    ) {
      this.emit({
        event: "runtime.harness.approval_surface",
        outcome: "rejected",
        failureClass: "subject_mismatch",
        subjectId: input.subjectId,
        turnId: input.turnId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "subject_mismatch",
        detail: "trajectoryDraft.subjectId must match turn subjectId",
      };
    }
    const began = this.ledger.beginTurn({
      subjectId: input.subjectId,
      turnId: input.turnId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    if (!began.ok) {
      this.emit({
        event: "runtime.harness.approval_surface",
        outcome: "rejected",
        failureClass: began.failureClass,
        subjectId: input.subjectId,
        turnId: input.turnId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return began;
    }
    if (input.trajectoryDraft) {
      this.pendingRecords.set(
        this.key(input.subjectId, input.turnId),
        input.trajectoryDraft,
      );
    }
    this.emit({
      event: "runtime.harness.approval_surface",
      outcome: "ok",
      subjectId: input.subjectId,
      turnId: input.turnId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return began;
  }

  /** Record emitted harness frame *types* for REJECTED critic replay. */
  noteFrameType(input: {
    subjectId: string;
    turnId: string;
    frameType: string;
  }):
    | { ok: true }
    | {
        ok: false;
        failureClass: OutcomeSignalFailureClass;
        detail: string;
      } {
    return this.ledger.recordFrameType(input);
  }

  /**
   * Invoke the host approval callback and stamp ACCEPTED / REJECTED.
   * Returns `allowed` for B3 ToolPolicyHooks (`true` / `false`).
   */
  async decide(input: {
    subjectId: string;
    turnId: string;
    sessionId: string;
    deviceId?: string;
    toolName: string;
    riskClass: ApprovalSurfaceRiskClass;
    /** When set, skip host callback and apply this decision (tests / adapters). */
    decision?: ApprovalSurfaceDecision;
    /** Deadline for host callback; timeout ≠ DISCARDED. */
    deadlineMs?: number;
  }): Promise<ApprovalDecideResult> {
    if (!this.onApproval && input.decision === undefined) {
      return {
        ok: false,
        failureClass: "config",
        detail: "HostApprovalCallback or explicit decision required",
      };
    }

    let decision: ApprovalSurfaceDecision;
    if (input.decision !== undefined) {
      decision = input.decision;
    } else {
      const deadlineMs = input.deadlineMs ?? 5_000;
      const ctx: ApprovalSurfaceContext = {
        subjectId: input.subjectId,
        turnId: input.turnId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        riskClass: input.riskClass,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      };
      try {
        decision = await raceDeadline(this.onApproval!(ctx), deadlineMs);
      } catch (err) {
        if (err instanceof ApprovalTimeoutError) {
          const timeout = this.ledger.recordApprovalTimeout({
            subjectId: input.subjectId,
            turnId: input.turnId,
          });
          this.emit({
            event: "runtime.harness.approval_surface",
            outcome: "rejected",
            failureClass: "approval_timeout",
            harnessEvent: "approval_timeout",
            subjectId: input.subjectId,
            turnId: input.turnId,
            ...(input.deviceId !== undefined
              ? { deviceId: input.deviceId }
              : {}),
            toolName: input.toolName,
            riskClass: input.riskClass,
          });
          return {
            ok: false,
            failureClass: "approval_timeout",
            detail: "approval wait expired without user action — not DISCARDED",
            timedOut: true,
            ...(timeout.ok ? {} : {}),
          };
        }
        throw err;
      }
    }

    const signal = approvalDecisionToOutcome(decision === "allow");
    const recorded = this.ledger.recordApprovalOutcome({
      subjectId: input.subjectId,
      turnId: input.turnId,
      signal,
    });
    if (!recorded.ok) {
      this.emit({
        event: "runtime.harness.approval_surface",
        outcome: "rejected",
        failureClass: recorded.failureClass,
        subjectId: input.subjectId,
        turnId: input.turnId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        toolName: input.toolName,
        riskClass: input.riskClass,
      });
      return {
        ok: false,
        failureClass: recorded.failureClass,
        detail: recorded.detail,
      };
    }

    this.emit({
      event: "runtime.harness.approval_surface",
      outcome: "ok",
      subjectId: input.subjectId,
      turnId: input.turnId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      humanOutcomeSignal: recorded.humanOutcomeSignal,
      toolName: input.toolName,
      riskClass: input.riskClass,
    });

    return {
      ok: true,
      allowed: decision === "allow",
      humanOutcomeSignal: recorded.humanOutcomeSignal,
    };
  }

  /**
   * B3 adapter: write-class hook → boolean allow (for ToolPolicyHooks).
   */
  createWriteApprovalHook(base: {
    turnId: string;
    sessionId: string;
  }): (ctx: {
    subjectId: string;
    deviceId?: string;
    invocation: { name: string };
  }) => Promise<boolean> {
    return async (ctx) => {
      const result = await this.decide({
        subjectId: ctx.subjectId,
        turnId: base.turnId,
        sessionId: base.sessionId,
        ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
        toolName: ctx.invocation.name,
        riskClass: "write",
      });
      if (!result.ok) {
        if (result.timedOut) {
          throw new ApprovalTimeoutError(result.detail);
        }
        return false;
      }
      return result.allowed;
    };
  }

  /**
   * B3 adapter: critical-class hook → boolean allow.
   */
  createCriticalConfirmHook(base: {
    turnId: string;
    sessionId: string;
  }): (ctx: {
    subjectId: string;
    deviceId?: string;
    invocation: { name: string };
  }) => Promise<boolean> {
    return async (ctx) => {
      const result = await this.decide({
        subjectId: ctx.subjectId,
        turnId: base.turnId,
        sessionId: base.sessionId,
        ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
        toolName: ctx.invocation.name,
        riskClass: "critical",
      });
      if (!result.ok) {
        if (result.timedOut) {
          throw new ApprovalTimeoutError(result.detail);
        }
        return false;
      }
      return result.allowed;
    };
  }

  /**
   * Seal human_outcome_signal on TURN_COMPLETE and enqueue async persist.
   */
  completeTurn(input: {
    subjectId: string;
    turnId: string;
    /** Override draft if beginTurn did not stash one. */
    trajectoryDraft?: TurnTrajectoryRecord;
  }): ApprovalCompleteResult {
    const sealed = this.ledger.finalizeOnTurnComplete({
      subjectId: input.subjectId,
      turnId: input.turnId,
    });
    if (!sealed.ok) {
      this.emit({
        event: "runtime.harness.approval_surface",
        outcome: "rejected",
        failureClass: sealed.failureClass,
        subjectId: input.subjectId,
        turnId: input.turnId,
      });
      return {
        ok: false,
        failureClass: sealed.failureClass,
        detail: sealed.detail,
      };
    }

    const draft =
      input.trajectoryDraft ??
      this.pendingRecords.get(this.key(input.subjectId, input.turnId));

    let persisted = false;
    if (draft && this.persistTrajectory) {
      persistTrajectoryWithOutcome(draft, sealed.binding, this.persistTrajectory, {
        onTelemetry: (e) => {
          this.emit({
            event: "runtime.harness.approval_surface",
            outcome: e.outcome === "rejected" ? "rejected" : e.outcome,
            subjectId: e.subjectId,
            ...(e.deviceId !== undefined ? { deviceId: e.deviceId } : {}),
            turnId: input.turnId,
            ...(e.humanOutcomeSignal !== undefined
              ? { humanOutcomeSignal: e.humanOutcomeSignal }
              : {}),
            ...(e.failureClass !== undefined
              ? { failureClass: "config" }
              : {}),
          });
        },
      });
      persisted = true;
    }

    this.pendingRecords.delete(this.key(input.subjectId, input.turnId));

    this.emit({
      event: "runtime.harness.approval_surface",
      outcome: persisted ? "queued" : "ok",
      subjectId: sealed.binding.subjectId,
      turnId: sealed.binding.turnId,
      ...(sealed.binding.deviceId !== undefined
        ? { deviceId: sealed.binding.deviceId }
        : {}),
      humanOutcomeSignal: sealed.binding.humanOutcomeSignal,
    });

    return { ok: true, binding: sealed.binding, persisted };
  }

  /**
   * Explicit user discard (B4 diff UI) → DISCARDED + seal + optional persist.
   * Does not require TURN_COMPLETE (abandonment is terminal on its own).
   */
  discardTurn(input: {
    subjectId: string;
    turnId: string;
    kind?: "user_discard";
    trajectoryDraft?: TurnTrajectoryRecord;
  }): DiscardTurnResult {
    return this.sealAbandonment({
      subjectId: input.subjectId,
      turnId: input.turnId,
      kind: input.kind ?? "user_discard",
      ...(input.trajectoryDraft !== undefined
        ? { trajectoryDraft: input.trajectoryDraft }
        : {}),
    });
  }

  /**
   * Map AbortPipeline abort result → DISCARDED when abort-without-accept.
   *
   * - `aborted` / `already_aborted` → DISCARDED (idempotent)
   * - `already_completed` → skip (never overwrite ACCEPTED / sealed signal)
   */
  mapAbortToDiscard(input: {
    subjectId: string;
    turnId: string;
    abortAction: AbortSurfaceAction;
    trajectoryDraft?: TurnTrajectoryRecord;
  }): MapAbortToDiscardResult {
    if (input.abortAction === "already_completed") {
      this.emit({
        event: "runtime.harness.approval_surface",
        outcome: "ok",
        subjectId: input.subjectId,
        turnId: input.turnId,
        abortAction: "already_completed",
      });
      return {
        ok: true,
        discarded: false,
        skipped: true,
        persisted: false,
      };
    }

    if (
      input.abortAction !== "aborted" &&
      input.abortAction !== "already_aborted"
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "abortAction must be aborted | already_aborted | already_completed",
      };
    }

    const sealed = this.sealAbandonment({
      subjectId: input.subjectId,
      turnId: input.turnId,
      kind: "abort_without_accept",
      ...(input.trajectoryDraft !== undefined
        ? { trajectoryDraft: input.trajectoryDraft }
        : {}),
    });
    if (!sealed.ok) {
      // ACCEPTED pending/finalized blocks discard — treat as accept-vs-abort.
      if (
        sealed.failureClass === "accept_blocks_discard" ||
        sealed.failureClass === "already_finalized"
      ) {
        this.emit({
          event: "runtime.harness.approval_surface",
          outcome: "ok",
          subjectId: input.subjectId,
          turnId: input.turnId,
          abortAction: input.abortAction,
          failureClass: sealed.failureClass,
        });
        return {
          ok: true,
          discarded: false,
          skipped: true,
          persisted: false,
        };
      }
      return {
        ok: false,
        failureClass: sealed.failureClass,
        detail: sealed.detail,
      };
    }

    this.emit({
      event: "runtime.harness.approval_surface",
      outcome: sealed.persisted ? "queued" : "ok",
      subjectId: input.subjectId,
      turnId: input.turnId,
      humanOutcomeSignal: "DISCARDED",
      abandonmentKind: "abort_without_accept",
      abortAction: input.abortAction,
    });

    return {
      ok: true,
      discarded: true,
      skipped: false,
      binding: sealed.binding,
      persisted: sealed.persisted,
    };
  }

  /**
   * Linked correction after ACCEPTED — never overwrites the original signal.
   * See `MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL` for calibration policy.
   */
  linkCorrectionAfterAccepted(input: {
    subjectId: string;
    originalTurnId: string;
    amendmentTurnId: string;
    deviceId?: string;
  }):
    | { ok: true; binding: FinalizedOutcomeBinding }
    | {
        ok: false;
        failureClass: OutcomeSignalFailureClass;
        detail: string;
      } {
    void MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL;
    return this.ledger.linkCorrectionAmendment(input);
  }

  /** Test / host introspection. */
  getLedger(): OutcomeSignalLedger {
    return this.ledger;
  }

  private sealAbandonment(input: {
    subjectId: string;
    turnId: string;
    kind: AbandonmentKind;
    trajectoryDraft?: TurnTrajectoryRecord;
  }): DiscardTurnResult {
    const recorded = this.ledger.recordAbandonmentOutcome({
      subjectId: input.subjectId,
      turnId: input.turnId,
      kind: input.kind,
    });
    if (!recorded.ok) {
      this.emit({
        event: "runtime.harness.approval_surface",
        outcome: "rejected",
        failureClass: recorded.failureClass,
        subjectId: input.subjectId,
        turnId: input.turnId,
        abandonmentKind: input.kind,
      });
      return {
        ok: false,
        failureClass: recorded.failureClass,
        detail: recorded.detail,
      };
    }

    const sealed = this.ledger.finalizeOnTurnComplete({
      subjectId: input.subjectId,
      turnId: input.turnId,
    });
    if (!sealed.ok) {
      this.emit({
        event: "runtime.harness.approval_surface",
        outcome: "rejected",
        failureClass: sealed.failureClass,
        subjectId: input.subjectId,
        turnId: input.turnId,
        abandonmentKind: input.kind,
      });
      return {
        ok: false,
        failureClass: sealed.failureClass,
        detail: sealed.detail,
      };
    }

    if (input.trajectoryDraft) {
      if (input.trajectoryDraft.subjectId !== input.subjectId) {
        return {
          ok: false,
          failureClass: "subject_mismatch",
          detail: "trajectoryDraft.subjectId must match turn subjectId",
        };
      }
      this.pendingRecords.set(
        this.key(input.subjectId, input.turnId),
        input.trajectoryDraft,
      );
    }

    const draft =
      input.trajectoryDraft ??
      this.pendingRecords.get(this.key(input.subjectId, input.turnId));

    let persisted = false;
    if (draft && this.persistTrajectory) {
      persistTrajectoryWithOutcome(
        draft,
        sealed.binding,
        this.persistTrajectory,
        {
          onTelemetry: (e) => {
            this.emit({
              event: "runtime.harness.approval_surface",
              outcome: e.outcome === "rejected" ? "rejected" : e.outcome,
              subjectId: e.subjectId,
              ...(e.deviceId !== undefined ? { deviceId: e.deviceId } : {}),
              turnId: input.turnId,
              humanOutcomeSignal: "DISCARDED",
              abandonmentKind: input.kind,
            });
          },
        },
      );
      persisted = true;
    }

    this.pendingRecords.delete(this.key(input.subjectId, input.turnId));

    this.emit({
      event: "runtime.harness.approval_surface",
      outcome: persisted ? "queued" : "ok",
      subjectId: sealed.binding.subjectId,
      turnId: sealed.binding.turnId,
      ...(sealed.binding.deviceId !== undefined
        ? { deviceId: sealed.binding.deviceId }
        : {}),
      humanOutcomeSignal: "DISCARDED",
      abandonmentKind: input.kind,
    });

    return {
      ok: true,
      binding: sealed.binding,
      persisted,
      abandonmentKind: input.kind,
    };
  }
}

export class ApprovalTimeoutError extends Error {
  readonly failureClass = "approval_timeout" as const;

  constructor(message: string) {
    super(message);
    this.name = "ApprovalTimeoutError";
  }
}

function raceDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ApprovalTimeoutError("approval deadline exceeded"));
    }, deadlineMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
