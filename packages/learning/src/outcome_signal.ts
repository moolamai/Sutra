/**
 * Human outcome signals for training trajectories (reward taxonomy).
 *
 * Set exactly once per terminal turn from the host approval / abort surface —
 * never inferred by an LLM. Typed enum only (never free string).
 *
 * DISCARDED = explicit abandonment (wired from B4 diff/abort). Silent approval
 * timeout without user action is a distinct harness event, not DISCARDED.
 *
 * End-to-end golden turns live under
 * `packages/runtime-harness/fixtures/outcome-signal/`.
 */

import { z } from "zod";
import {
  enqueueTrajectoryWrite,
  type TurnTrajectoryRecord,
} from "./trajectory_schema.js";

/** Canonical human outcome enum — reward / critic taxonomy. */
export const HUMAN_OUTCOME_SIGNALS = Object.freeze([
  "ACCEPTED",
  "REJECTED",
  "DISCARDED",
] as const);

export type HumanOutcomeSignal = (typeof HUMAN_OUTCOME_SIGNALS)[number];

/** Approval-surface decisions (B3 write/critical) — never DISCARDED. */
export const APPROVAL_OUTCOME_SIGNALS = Object.freeze([
  "ACCEPTED",
  "REJECTED",
] as const);

export type ApprovalOutcomeSignal = (typeof APPROVAL_OUTCOME_SIGNALS)[number];

/**
 * B4 abandonment kinds that map to DISCARDED.
 * Silent approval timeout is NOT a member (distinct harness event).
 */
export const ABANDONMENT_KINDS = Object.freeze([
  "user_discard",
  "abort_without_accept",
] as const);

export type AbandonmentKind = (typeof ABANDONMENT_KINDS)[number];

/**
 * Manual correction after ACCEPTED preserves the prior signal for calibration.
 * Hosts MUST call `linkCorrectionAmendment` — never overwrite the original
 * `humanOutcomeSignal`. The amendment links via `amendsTurnId`.
 */
export const MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL = Object.freeze({
  priorSignalImmutable: true,
  path: "linkCorrectionAmendment",
  note:
    "After ACCEPTED, manual correction emits a linked amendment trajectory " +
    "with amendsTurnId. The original ACCEPTED remains the calibration baseline " +
    "and is never overwritten.",
} as const);

export const humanOutcomeSignalSchema = z.enum(HUMAN_OUTCOME_SIGNALS);

/** Soft cap on frame-type tags retained for critic replay after REJECTED/DISCARDED. */
export const PRE_ABORT_FRAME_TYPE_LIMIT = 64;

export type OutcomeSignalFailureClass =
  | "schema_violation"
  | "already_set"
  | "missing_subject"
  | "subject_mismatch"
  | "not_started"
  | "already_finalized"
  | "timeout_not_discarded"
  | "discarded_not_from_approval"
  | "overwrite_forbidden"
  | "accept_blocks_discard";

export type OutcomeSignalTelemetryEvent = {
  event: "learning.trajectory.outcome_signal";
  subjectId: string | null;
  deviceId?: string;
  turnId?: string;
  outcome: "ok" | "rejected" | "queued";
  failureClass?: OutcomeSignalFailureClass;
  humanOutcomeSignal?: HumanOutcomeSignal;
  /** Distinct from DISCARDED — silent approval wait expired. */
  harnessEvent?: "approval_timeout";
  abandonmentKind?: AbandonmentKind;
};

export type FinalizedOutcomeBinding = {
  subjectId: string;
  turnId: string;
  deviceId?: string;
  humanOutcomeSignal: HumanOutcomeSignal;
  /**
   * Opaque harness frame *types* emitted before REJECTED / DISCARDED abort.
   * Never raw frame payloads / learner content.
   */
  preAbortFrameTypes?: readonly string[];
  /** When this binding is a linked correction after ACCEPTED — original turn. */
  amendsTurnId?: string;
  /** Present when signal is DISCARDED from a B4 abandonment surface. */
  abandonmentKind?: AbandonmentKind;
};

export type TurnTrajectoryWithOutcome = TurnTrajectoryRecord & {
  humanOutcomeSignal: HumanOutcomeSignal;
  preAbortFrameTypes?: readonly string[];
  amendsTurnId?: string;
  abandonmentKind?: AbandonmentKind;
};

type SlotState = {
  subjectId: string;
  turnId: string;
  deviceId?: string;
  pending: HumanOutcomeSignal | null;
  finalized: FinalizedOutcomeBinding | null;
  preAbortFrameTypes: string[];
  approvalTimedOut: boolean;
  abandonmentKind: AbandonmentKind | null;
};

/**
 * Per-subject/per-turn outcome slots. Set-once semantics until TURN_COMPLETE
 * finalizes; corrections after ACCEPTED become linked amendments.
 */
export class OutcomeSignalLedger {
  private readonly slots = new Map<string, SlotState>();
  private readonly onTelemetry:
    | ((e: OutcomeSignalTelemetryEvent) => void)
    | undefined;

  constructor(options: {
    onTelemetry?: (e: OutcomeSignalTelemetryEvent) => void;
  } = {}) {
    this.onTelemetry = options.onTelemetry;
  }

  private key(subjectId: string, turnId: string): string {
    return `${subjectId}\0${turnId}`;
  }

  private emit(event: OutcomeSignalTelemetryEvent): void {
    this.onTelemetry?.(event);
  }

  beginTurn(input: {
    subjectId: string;
    turnId: string;
    deviceId?: string;
  }):
    | { ok: true; subjectId: string; turnId: string }
    | {
        ok: false;
        failureClass: OutcomeSignalFailureClass;
        detail: string;
      } {
    const subjectId = input.subjectId?.trim() ?? "";
    const turnId = input.turnId?.trim() ?? "";
    if (!subjectId) {
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subjectId required",
      };
    }
    if (!turnId) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "turnId required",
      };
    }
    const k = this.key(subjectId, turnId);
    const existing = this.slots.get(k);
    if (existing?.finalized) {
      return {
        ok: false,
        failureClass: "already_finalized",
        detail: "turn already finalized",
      };
    }
    this.slots.set(k, {
      subjectId,
      turnId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      pending: null,
      finalized: null,
      preAbortFrameTypes: [],
      approvalTimedOut: false,
      abandonmentKind: null,
    });
    this.emit({
      event: "learning.trajectory.outcome_signal",
      outcome: "ok",
      subjectId,
      turnId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return { ok: true, subjectId, turnId };
  }

  /**
   * Record opaque frame type tags for critic replay (REJECTED / partial stream).
   * Never stores payload bodies.
   */
  recordFrameType(
    input: { subjectId: string; turnId: string; frameType: string },
  ):
    | { ok: true }
    | { ok: false; failureClass: OutcomeSignalFailureClass; detail: string } {
    const slot = this.slots.get(this.key(input.subjectId, input.turnId));
    if (!slot) {
      return {
        ok: false,
        failureClass: "not_started",
        detail: "beginTurn required",
      };
    }
    if (slot.subjectId !== input.subjectId) {
      return {
        ok: false,
        failureClass: "subject_mismatch",
        detail: "subjectId mismatch",
      };
    }
    if (slot.finalized) {
      return {
        ok: false,
        failureClass: "already_finalized",
        detail: "cannot append frames after finalize",
      };
    }
    const frameType = input.frameType.trim().slice(0, 64);
    if (!frameType) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "frameType required",
      };
    }
    if (slot.preAbortFrameTypes.length >= PRE_ABORT_FRAME_TYPE_LIMIT) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `preAbortFrameTypes exceed ${PRE_ABORT_FRAME_TYPE_LIMIT}`,
      };
    }
    slot.preAbortFrameTypes.push(frameType);
    return { ok: true };
  }

  /**
   * Set ACCEPTED / REJECTED from the B3 approval surface (exactly once pending).
   * DISCARDED is refused here — wired from abandonment surfaces only.
   */
  recordApprovalOutcome(input: {
    subjectId: string;
    turnId: string;
    signal: unknown;
  }):
    | { ok: true; humanOutcomeSignal: ApprovalOutcomeSignal }
    | {
        ok: false;
        failureClass: OutcomeSignalFailureClass;
        detail: string;
      } {
    const parsed = humanOutcomeSignalSchema.safeParse(input.signal);
    if (!parsed.success) {
      this.emit({
        event: "learning.trajectory.outcome_signal",
        outcome: "rejected",
        failureClass: "schema_violation",
        subjectId: input.subjectId,
        turnId: input.turnId,
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "human_outcome_signal must be a typed enum member",
      };
    }
    if (parsed.data === "DISCARDED") {
      this.emit({
        event: "learning.trajectory.outcome_signal",
        outcome: "rejected",
        failureClass: "discarded_not_from_approval",
        subjectId: input.subjectId,
        turnId: input.turnId,
        humanOutcomeSignal: "DISCARDED",
      });
      return {
        ok: false,
        failureClass: "discarded_not_from_approval",
        detail:
          "DISCARDED is not set from the approval surface — use abandonment/abort wiring",
      };
    }

    const slot = this.slots.get(this.key(input.subjectId, input.turnId));
    if (!slot) {
      return {
        ok: false,
        failureClass: "not_started",
        detail: "beginTurn required",
      };
    }
    if (slot.subjectId !== input.subjectId) {
      return {
        ok: false,
        failureClass: "subject_mismatch",
        detail: "subjectId mismatch",
      };
    }
    if (slot.finalized) {
      return {
        ok: false,
        failureClass: "already_finalized",
        detail: "outcome already finalized on TURN_COMPLETE",
      };
    }
    if (slot.pending !== null) {
      if (slot.pending === parsed.data) {
        return { ok: true, humanOutcomeSignal: parsed.data };
      }
      this.emit({
        event: "learning.trajectory.outcome_signal",
        outcome: "rejected",
        failureClass: "already_set",
        subjectId: slot.subjectId,
        turnId: slot.turnId,
        humanOutcomeSignal: slot.pending,
      });
      return {
        ok: false,
        failureClass: "already_set",
        detail: `human_outcome_signal already pending as ${slot.pending}`,
      };
    }

    slot.pending = parsed.data;
    this.emit({
      event: "learning.trajectory.outcome_signal",
      outcome: "ok",
      subjectId: slot.subjectId,
      turnId: slot.turnId,
      ...(slot.deviceId !== undefined ? { deviceId: slot.deviceId } : {}),
      humanOutcomeSignal: parsed.data,
    });
    return { ok: true, humanOutcomeSignal: parsed.data };
  }

  /**
   * Silent approval wait expired — harness event only, never DISCARDED.
   */
  recordApprovalTimeout(input: {
    subjectId: string;
    turnId: string;
  }):
    | { ok: true; harnessEvent: "approval_timeout" }
    | {
        ok: false;
        failureClass: OutcomeSignalFailureClass;
        detail: string;
      } {
    const slot = this.slots.get(this.key(input.subjectId, input.turnId));
    if (!slot) {
      return {
        ok: false,
        failureClass: "not_started",
        detail: "beginTurn required",
      };
    }
    if (slot.pending !== null || slot.finalized) {
      return {
        ok: false,
        failureClass: "timeout_not_discarded",
        detail: "cannot mark timeout after an outcome is already set",
      };
    }
    slot.approvalTimedOut = true;
    this.emit({
      event: "learning.trajectory.outcome_signal",
      outcome: "ok",
      subjectId: slot.subjectId,
      turnId: slot.turnId,
      ...(slot.deviceId !== undefined ? { deviceId: slot.deviceId } : {}),
      harnessEvent: "approval_timeout",
    });
    return { ok: true, harnessEvent: "approval_timeout" };
  }

  /**
   * Set DISCARDED from a B4 abandonment surface (user discard or abort without
   * accept). Refuses to overwrite ACCEPTED/REJECTED. Never treats approval
   * timeout as DISCARDED.
   */
  recordAbandonmentOutcome(input: {
    subjectId: string;
    turnId: string;
    kind: AbandonmentKind;
  }):
    | { ok: true; humanOutcomeSignal: "DISCARDED"; abandonmentKind: AbandonmentKind }
    | {
        ok: false;
        failureClass: OutcomeSignalFailureClass;
        detail: string;
      } {
    if (
      input.kind !== "user_discard" &&
      input.kind !== "abort_without_accept"
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "abandonment kind must be user_discard | abort_without_accept",
      };
    }

    const slot = this.slots.get(this.key(input.subjectId, input.turnId));
    if (!slot) {
      return {
        ok: false,
        failureClass: "not_started",
        detail: "beginTurn required",
      };
    }
    if (slot.subjectId !== input.subjectId) {
      return {
        ok: false,
        failureClass: "subject_mismatch",
        detail: "subjectId mismatch",
      };
    }
    // approvalTimedOut alone never becomes DISCARDED; only an explicit
    // recordAbandonmentOutcome call below stamps the signal.
    if (slot.finalized) {
      if (slot.finalized.humanOutcomeSignal === "DISCARDED") {
        return {
          ok: true,
          humanOutcomeSignal: "DISCARDED",
          abandonmentKind:
            slot.finalized.abandonmentKind ?? input.kind,
        };
      }
      return {
        ok: false,
        failureClass: "already_finalized",
        detail: `cannot discard after finalized ${slot.finalized.humanOutcomeSignal}`,
      };
    }
    if (slot.pending !== null) {
      if (slot.pending === "DISCARDED") {
        slot.abandonmentKind = slot.abandonmentKind ?? input.kind;
        return {
          ok: true,
          humanOutcomeSignal: "DISCARDED",
          abandonmentKind: slot.abandonmentKind,
        };
      }
      if (slot.pending === "ACCEPTED") {
        return {
          ok: false,
          failureClass: "accept_blocks_discard",
          detail:
            "ACCEPTED blocks DISCARDED — use linkCorrectionAmendment for manual correction",
        };
      }
      return {
        ok: false,
        failureClass: "already_set",
        detail: `human_outcome_signal already pending as ${slot.pending}`,
      };
    }

    slot.pending = "DISCARDED";
    slot.abandonmentKind = input.kind;
    this.emit({
      event: "learning.trajectory.outcome_signal",
      outcome: "ok",
      subjectId: slot.subjectId,
      turnId: slot.turnId,
      ...(slot.deviceId !== undefined ? { deviceId: slot.deviceId } : {}),
      humanOutcomeSignal: "DISCARDED",
      abandonmentKind: input.kind,
    });
    return {
      ok: true,
      humanOutcomeSignal: "DISCARDED",
      abandonmentKind: input.kind,
    };
  }

  /**
   * Seal the pending signal on TURN_COMPLETE (or abandonment terminal) — exactly once.
   */
  finalizeOnTurnComplete(input: {
    subjectId: string;
    turnId: string;
  }):
    | { ok: true; binding: FinalizedOutcomeBinding }
    | {
        ok: false;
        failureClass: OutcomeSignalFailureClass;
        detail: string;
      } {
    const slot = this.slots.get(this.key(input.subjectId, input.turnId));
    if (!slot) {
      return {
        ok: false,
        failureClass: "not_started",
        detail: "beginTurn required",
      };
    }
    if (slot.subjectId !== input.subjectId) {
      return {
        ok: false,
        failureClass: "subject_mismatch",
        detail: "subjectId mismatch",
      };
    }
    if (slot.finalized) {
      // Idempotent seal — return prior binding.
      return { ok: true, binding: slot.finalized };
    }
    if (slot.pending === null) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "human_outcome_signal unset at TURN_COMPLETE",
      };
    }

    const keepFrames =
      (slot.pending === "REJECTED" || slot.pending === "DISCARDED") &&
      slot.preAbortFrameTypes.length > 0;

    const binding: FinalizedOutcomeBinding = {
      subjectId: slot.subjectId,
      turnId: slot.turnId,
      humanOutcomeSignal: slot.pending,
      ...(slot.deviceId !== undefined ? { deviceId: slot.deviceId } : {}),
      ...(keepFrames
        ? { preAbortFrameTypes: [...slot.preAbortFrameTypes] }
        : {}),
      ...(slot.pending === "DISCARDED" && slot.abandonmentKind
        ? { abandonmentKind: slot.abandonmentKind }
        : {}),
    };
    slot.finalized = binding;
    this.emit({
      event: "learning.trajectory.outcome_signal",
      outcome: "ok",
      subjectId: binding.subjectId,
      turnId: binding.turnId,
      ...(binding.deviceId !== undefined ? { deviceId: binding.deviceId } : {}),
      humanOutcomeSignal: binding.humanOutcomeSignal,
      ...(binding.abandonmentKind !== undefined
        ? { abandonmentKind: binding.abandonmentKind }
        : {}),
    });
    return { ok: true, binding };
  }

  /**
   * Manual correction after ACCEPTED → linked amendment; never overwrite.
   */
  linkCorrectionAmendment(input: {
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
    const original = this.slots.get(
      this.key(input.subjectId, input.originalTurnId),
    );
    if (!original?.finalized) {
      return {
        ok: false,
        failureClass: "not_started",
        detail: "original turn must be finalized with ACCEPTED",
      };
    }
    if (original.finalized.humanOutcomeSignal !== "ACCEPTED") {
      return {
        ok: false,
        failureClass: "overwrite_forbidden",
        detail: "correction amendments only link from ACCEPTED turns",
      };
    }

    const began = this.beginTurn({
      subjectId: input.subjectId,
      turnId: input.amendmentTurnId,
      ...(input.deviceId !== undefined
        ? { deviceId: input.deviceId }
        : original.deviceId !== undefined
          ? { deviceId: original.deviceId }
          : {}),
    });
    if (!began.ok) {
      return {
        ok: false,
        failureClass: began.failureClass,
        detail: began.detail,
      };
    }
    const set = this.recordApprovalOutcome({
      subjectId: input.subjectId,
      turnId: input.amendmentTurnId,
      signal: "ACCEPTED",
    });
    if (!set.ok) {
      return {
        ok: false,
        failureClass: set.failureClass,
        detail: set.detail,
      };
    }
    const finalized = this.finalizeOnTurnComplete({
      subjectId: input.subjectId,
      turnId: input.amendmentTurnId,
    });
    if (!finalized.ok) {
      return {
        ok: false,
        failureClass: finalized.failureClass,
        detail: finalized.detail,
      };
    }
    const binding: FinalizedOutcomeBinding = {
      ...finalized.binding,
      amendsTurnId: input.originalTurnId,
    };
    const amendmentSlot = this.slots.get(
      this.key(input.subjectId, input.amendmentTurnId),
    );
    if (amendmentSlot) amendmentSlot.finalized = binding;

    // Prove original untouched.
    const still = this.slots.get(
      this.key(input.subjectId, input.originalTurnId),
    )?.finalized;
    if (!still || still.humanOutcomeSignal !== "ACCEPTED") {
      return {
        ok: false,
        failureClass: "overwrite_forbidden",
        detail: "original ACCEPTED signal must remain immutable",
      };
    }

    this.emit({
      event: "learning.trajectory.outcome_signal",
      outcome: "ok",
      subjectId: binding.subjectId,
      turnId: binding.turnId,
      ...(binding.deviceId !== undefined ? { deviceId: binding.deviceId } : {}),
      humanOutcomeSignal: "ACCEPTED",
    });
    return { ok: true, binding };
  }

  peek(subjectId: string, turnId: string): SlotState | undefined {
    return this.slots.get(this.key(subjectId, turnId));
  }
}

/** Attach a finalized binding onto a trajectory record (additive field). */
export function attachOutcomeSignal(
  record: TurnTrajectoryRecord,
  binding: FinalizedOutcomeBinding,
): TurnTrajectoryWithOutcome {
  if (record.subjectId !== binding.subjectId) {
    throw new Error("attachOutcomeSignal subjectId mismatch");
  }
  return {
    ...record,
    humanOutcomeSignal: binding.humanOutcomeSignal,
    ...(binding.preAbortFrameTypes !== undefined
      ? { preAbortFrameTypes: binding.preAbortFrameTypes }
      : {}),
    ...(binding.amendsTurnId !== undefined
      ? { amendsTurnId: binding.amendsTurnId }
      : {}),
    ...(binding.abandonmentKind !== undefined
      ? { abandonmentKind: binding.abandonmentKind }
      : {}),
  };
}

/**
 * Persist trajectory + outcome on TURN_COMPLETE via the async write path
 * (never blocks the turn hot path).
 */
export function persistTrajectoryWithOutcome(
  record: TurnTrajectoryRecord,
  binding: FinalizedOutcomeBinding,
  writer: (record: TurnTrajectoryWithOutcome) => void | Promise<void>,
  options: {
    onTelemetry?: (event: {
      event: "learning.trajectory.write";
      outcome: "queued" | "ok" | "rejected";
      subjectId: string;
      deviceId?: string;
      failureClass?: string;
      humanOutcomeSignal?: HumanOutcomeSignal;
    }) => void;
  } = {},
): { queued: true; subjectId: string; humanOutcomeSignal: HumanOutcomeSignal } {
  const withOutcome = attachOutcomeSignal(record, binding);
  const queued = enqueueTrajectoryWrite(
    withOutcome,
    (r) => writer(r as TurnTrajectoryWithOutcome),
    {
      onTelemetry: (e) =>
        options.onTelemetry?.({
          ...e,
          humanOutcomeSignal: binding.humanOutcomeSignal,
        }),
    },
  );
  return {
    queued: true,
    subjectId: queued.subjectId,
    humanOutcomeSignal: binding.humanOutcomeSignal,
  };
}

/** Parse a free input into a typed enum — rejects arbitrary strings. */
export function parseHumanOutcomeSignal(input: unknown):
  | { ok: true; signal: HumanOutcomeSignal }
  | { ok: false; failureClass: "schema_violation"; detail: string } {
  const parsed = humanOutcomeSignalSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "human_outcome_signal must be ACCEPTED | REJECTED | DISCARDED",
    };
  }
  return { ok: true, signal: parsed.data };
}

/** Map B3 approval boolean → ACCEPTED / REJECTED (never free string). */
export function approvalDecisionToOutcome(
  allowed: boolean,
): ApprovalOutcomeSignal {
  return allowed ? "ACCEPTED" : "REJECTED";
}
