/**
 * Harness-side session checkpoint controller.
 *
 * The harness observes the first emitted model token and delegates the
 * checkpoint pin to an injected bindings seam. On TURN_COMPLETE /
 * HARNESS_ERROR it releases the pin and asks the binding to apply any
 * pending turn-boundary adapter swap. Dependency direction stays intact:
 * runtime-harness does not import a concrete SLM binding.
 */

export const SESSION_CHECKPOINT_SCHEMA_VERSION =
  "harness.session-checkpoint.v1" as const;

export const SESSION_CHECKPOINT_ID_LIMIT = 128;

export type SessionCheckpointFailureClass =
  | "session_checkpoint.subject_scope"
  | "session_checkpoint.session_required"
  | "session_checkpoint.binding_failure"
  | "session_checkpoint.pin_conflict"
  | "session_checkpoint.boundary_failure";

export type SessionCheckpointTerminalReason =
  | "TURN_COMPLETE"
  | "HARNESS_ERROR";

export type SessionCheckpointTelemetryEvent = {
  event:
    | "harness.session_checkpoint.pin"
    | "harness.session_checkpoint.boundary";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  sessionId?: string;
  pinnedContentHash?: string;
  oldContentHash?: string;
  newContentHash?: string;
  terminalReason?: SessionCheckpointTerminalReason;
  applied?: boolean;
  waitingOnActiveSessions?: number;
  pendingCount?: number;
  idempotentReplay?: boolean;
  failureClass?: SessionCheckpointFailureClass;
};

export class SessionCheckpointContractError extends Error {
  readonly obligation: SessionCheckpointFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly sessionId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: SessionCheckpointFailureClass;
      subjectId?: string;
      deviceId?: string;
      sessionId?: string;
    },
  ) {
    super(message);
    this.name = "SessionCheckpointContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.sessionId = meta.sessionId;
  }
}

export type SessionCheckpointBindingPin = {
  subjectId: string;
  deviceId: string;
  sessionId: string;
  pinnedContentHash: string;
  pinnedAt: string;
};

export type SessionCheckpointBoundaryResult = {
  ok: true;
  applied: boolean;
  terminalReason: SessionCheckpointTerminalReason;
  sessionId: string;
  waitingOnActiveSessions?: number;
  pendingCount?: number;
  idle?: boolean;
  oldContentHash?: string;
  newContentHash?: string;
  discardedPendingCount?: number;
  idempotentReplay?: boolean;
};

/**
 * Structural seam implemented by the SLM binding. No reverse package import.
 */
export type SessionCheckpointBinding = {
  pinAtFirstToken(input: {
    subjectId: string;
    sessionId: string;
    pinnedAt?: string;
  }): {
    ok: true;
    pin: SessionCheckpointBindingPin;
    idempotentReplay: boolean;
  };
  getPinnedCheckpoint(input: {
    subjectId: string;
    sessionId: string;
  }): SessionCheckpointBindingPin;
  onTerminalBoundary(input: {
    subjectId: string;
    sessionId: string;
    reason: SessionCheckpointTerminalReason;
  }): SessionCheckpointBoundaryResult;
};

export type HarnessSessionCheckpoint = {
  schemaVersion: typeof SESSION_CHECKPOINT_SCHEMA_VERSION;
  subjectId: string;
  deviceId: string;
  sessionId: string;
  pinnedContentHash: string;
  pinnedAt: string;
};

export type SessionCheckpointPinResult = {
  ok: true;
  checkpoint: HarnessSessionCheckpoint;
  idempotentReplay: boolean;
};

export type SessionCheckpointBoundaryHarnessResult = {
  ok: true;
  applied: boolean;
  terminalReason: SessionCheckpointTerminalReason;
  sessionId: string;
  waitingOnActiveSessions?: number;
  pendingCount?: number;
  idle?: boolean;
  oldContentHash?: string;
  newContentHash?: string;
  discardedPendingCount?: number;
  idempotentReplay?: boolean;
};

/**
 * Converts first-token / terminal harness events into checkpoint pin and
 * turn-boundary swap operations on the injected bindings seam.
 */
export class SessionCheckpointController {
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly binding: SessionCheckpointBinding;
  private readonly onTelemetry:
    | ((event: SessionCheckpointTelemetryEvent) => void)
    | undefined;

  constructor(options: {
    subjectId: string;
    deviceId: string;
    binding: SessionCheckpointBinding;
    onTelemetry?: (event: SessionCheckpointTelemetryEvent) => void;
  }) {
    this.subjectId = requireId(options.subjectId, "subjectId");
    this.deviceId = requireId(options.deviceId, "deviceId");
    this.binding = options.binding;
    this.onTelemetry = options.onTelemetry;
  }

  /**
   * Call exactly when the first model token is accepted for the session.
   * Duplicate first-token delivery is idempotent and returns the original pin.
   */
  onFirstToken(input: {
    subjectId: string;
    sessionId: string;
    observedAt?: string;
  }): SessionCheckpointPinResult {
    this.assertSubject(input.subjectId);
    const sessionId = requireId(input.sessionId, "sessionId");

    try {
      const result = this.binding.pinAtFirstToken({
        subjectId: this.subjectId,
        sessionId,
        ...(input.observedAt !== undefined
          ? { pinnedAt: input.observedAt }
          : {}),
      });
      const pin = result.pin;
      if (
        pin.subjectId !== this.subjectId ||
        pin.deviceId !== this.deviceId ||
        pin.sessionId !== sessionId
      ) {
        throw new SessionCheckpointContractError(
          "binding returned a checkpoint outside the requested scope",
          {
            obligation: "session_checkpoint.pin_conflict",
            subjectId: this.subjectId,
            deviceId: this.deviceId,
            sessionId,
          },
        );
      }

      const checkpoint: HarnessSessionCheckpoint = Object.freeze({
        schemaVersion: SESSION_CHECKPOINT_SCHEMA_VERSION,
        subjectId: pin.subjectId,
        deviceId: pin.deviceId,
        sessionId: pin.sessionId,
        pinnedContentHash: pin.pinnedContentHash,
        pinnedAt: pin.pinnedAt,
      });
      this.onTelemetry?.({
        event: "harness.session_checkpoint.pin",
        outcome: "ok",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        sessionId,
        pinnedContentHash: checkpoint.pinnedContentHash,
        idempotentReplay: result.idempotentReplay,
      });
      return {
        ok: true,
        checkpoint,
        idempotentReplay: result.idempotentReplay,
      };
    } catch (error) {
      if (error instanceof SessionCheckpointContractError) {
        this.emitFailure("harness.session_checkpoint.pin", error.obligation, sessionId);
        throw error;
      }
      this.emitFailure(
        "harness.session_checkpoint.pin",
        "session_checkpoint.binding_failure",
        sessionId,
      );
      throw new SessionCheckpointContractError(
        error instanceof Error
          ? `session checkpoint binding failed: ${error.message}`
          : "session checkpoint binding failed",
        {
          obligation: "session_checkpoint.binding_failure",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          sessionId,
        },
      );
    }
  }

  getCheckpoint(input: {
    subjectId: string;
    sessionId: string;
  }): HarnessSessionCheckpoint {
    this.assertSubject(input.subjectId);
    const sessionId = requireId(input.sessionId, "sessionId");
    const pin = this.binding.getPinnedCheckpoint({
      subjectId: this.subjectId,
      sessionId,
    });
    return Object.freeze({
      schemaVersion: SESSION_CHECKPOINT_SCHEMA_VERSION,
      subjectId: pin.subjectId,
      deviceId: pin.deviceId,
      sessionId: pin.sessionId,
      pinnedContentHash: pin.pinnedContentHash,
      pinnedAt: pin.pinnedAt,
    });
  }

  /**
   * TURN_COMPLETE boundary — release pin and apply the latest pending swap
   * once every active session on the subject has completed.
   */
  onTurnComplete(input: {
    subjectId: string;
    sessionId: string;
  }): SessionCheckpointBoundaryHarnessResult {
    return this.onTerminal(input, "TURN_COMPLETE");
  }

  /**
   * HARNESS_ERROR is terminal for the turn the same way TURN_COMPLETE is —
   * pending swaps still wait for every other active session on the subject.
   */
  onHarnessError(input: {
    subjectId: string;
    sessionId: string;
  }): SessionCheckpointBoundaryHarnessResult {
    return this.onTerminal(input, "HARNESS_ERROR");
  }

  private onTerminal(
    input: { subjectId: string; sessionId: string },
    reason: SessionCheckpointTerminalReason,
  ): SessionCheckpointBoundaryHarnessResult {
    this.assertSubject(input.subjectId);
    const sessionId = requireId(input.sessionId, "sessionId");

    try {
      const result = this.binding.onTerminalBoundary({
        subjectId: this.subjectId,
        sessionId,
        reason,
      });
      if (result.sessionId !== sessionId || result.terminalReason !== reason) {
        throw new SessionCheckpointContractError(
          "binding returned a boundary result outside the requested scope",
          {
            obligation: "session_checkpoint.pin_conflict",
            subjectId: this.subjectId,
            deviceId: this.deviceId,
            sessionId,
          },
        );
      }

      const waiting = result.waitingOnActiveSessions ?? 0;
      this.onTelemetry?.({
        event: "harness.session_checkpoint.boundary",
        outcome: result.applied
          ? "ok"
          : waiting > 0
            ? "advisory"
            : "ok",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        sessionId,
        terminalReason: reason,
        applied: result.applied,
        ...(result.waitingOnActiveSessions !== undefined
          ? { waitingOnActiveSessions: result.waitingOnActiveSessions }
          : {}),
        ...(result.pendingCount !== undefined
          ? { pendingCount: result.pendingCount }
          : {}),
        ...(result.oldContentHash !== undefined
          ? { oldContentHash: result.oldContentHash }
          : {}),
        ...(result.newContentHash !== undefined
          ? { newContentHash: result.newContentHash }
          : {}),
        ...(result.idempotentReplay !== undefined
          ? { idempotentReplay: result.idempotentReplay }
          : {}),
      });

      return {
        ok: true,
        applied: result.applied,
        terminalReason: reason,
        sessionId,
        ...(result.waitingOnActiveSessions !== undefined
          ? { waitingOnActiveSessions: result.waitingOnActiveSessions }
          : {}),
        ...(result.pendingCount !== undefined
          ? { pendingCount: result.pendingCount }
          : {}),
        ...(result.idle !== undefined ? { idle: result.idle } : {}),
        ...(result.oldContentHash !== undefined
          ? { oldContentHash: result.oldContentHash }
          : {}),
        ...(result.newContentHash !== undefined
          ? { newContentHash: result.newContentHash }
          : {}),
        ...(result.discardedPendingCount !== undefined
          ? { discardedPendingCount: result.discardedPendingCount }
          : {}),
        ...(result.idempotentReplay !== undefined
          ? { idempotentReplay: result.idempotentReplay }
          : {}),
      };
    } catch (error) {
      if (error instanceof SessionCheckpointContractError) {
        this.emitFailure(
          "harness.session_checkpoint.boundary",
          error.obligation,
          sessionId,
          reason,
        );
        throw error;
      }
      this.emitFailure(
        "harness.session_checkpoint.boundary",
        "session_checkpoint.boundary_failure",
        sessionId,
        reason,
      );
      throw new SessionCheckpointContractError(
        error instanceof Error
          ? `session checkpoint boundary failed: ${error.message}`
          : "session checkpoint boundary failed",
        {
          obligation: "session_checkpoint.boundary_failure",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          sessionId,
        },
      );
    }
  }

  private assertSubject(subjectId: string): void {
    if (requireId(subjectId, "subjectId") !== this.subjectId) {
      this.emitFailure(
        "harness.session_checkpoint.pin",
        "session_checkpoint.subject_scope",
      );
      throw new SessionCheckpointContractError(
        "cross-subject session checkpoint access denied",
        {
          obligation: "session_checkpoint.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
  }

  private emitFailure(
    event: SessionCheckpointTelemetryEvent["event"],
    failureClass: SessionCheckpointFailureClass,
    sessionId?: string,
    terminalReason?: SessionCheckpointTerminalReason,
  ): void {
    this.onTelemetry?.({
      event,
      outcome: "fail",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(terminalReason !== undefined ? { terminalReason } : {}),
      failureClass,
    });
  }
}

function requireId(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > SESSION_CHECKPOINT_ID_LIMIT) {
    throw new SessionCheckpointContractError(`${field} required`, {
      obligation:
        field === "sessionId"
          ? "session_checkpoint.session_required"
          : "session_checkpoint.subject_scope",
    });
  }
  return trimmed;
}
