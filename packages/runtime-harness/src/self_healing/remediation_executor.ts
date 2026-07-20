/**
 * Bounded auto-remediation executor (C6).
 *
 * Matches a failure class to the winning policy, applies the action through
 * typed control-surface ports only, tracks ineffective attempts, and disables
 * + pages at the schema threshold. Never widens permissions or skips approval.
 */

import {
  FORBIDDEN_REMEDIATION_SURFACES,
  RemediationPolicyContractError,
  parseRemediationAction,
  type RemediationAction,
  type RemediationActionKind,
  type RemediationControlSurface,
  type RemediationDegradationBehavior,
  type RemediationDegradationDependency,
  type RemediationFailureClass,
  type RemediationPolicyCatalog,
  type RemediationPolicyDocument,
  type RemediationPolicyFailureClass,
  type RemediationPolicyTelemetryEvent,
  type RemediationRoutingFallback,
} from "./remediation_policy.js";

export const REMEDIATION_EXECUTOR_SCHEMA_VERSION =
  "runtime.harness.remediation-executor.v1" as const;

export const REMEDIATION_EXECUTOR_FLAG =
  "runtime.harness.self_healing.remediation_executor" as const;

/** Soft cap on retained execution receipts per subject (NFR). */
export const REMEDIATION_EXECUTION_RECEIPT_LIMIT = 256 as const;

export type RemediationExecutorFailureClass =
  | RemediationPolicyFailureClass
  | "remediation_executor.timeout"
  | "remediation_executor.surface_failed"
  | "remediation_executor.partial_apply"
  | "remediation_executor.forbidden_action";

export class RemediationExecutorContractError extends Error {
  readonly obligation: RemediationExecutorFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: RemediationExecutorFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "RemediationExecutorContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

/**
 * Typed control-surface ports — hosts wire these to degradation registry,
 * correction-loop config, routing mode, and retry caps. The executor never
 * invents freeform surfaces.
 */
export type RemediationControlSurfacePorts = {
  setRetryCap(input: {
    subjectId: string;
    deviceId: string;
    maxRetries: number;
    policyId: string;
    policyVersion: number;
  }): void | Promise<void>;
  setCorrectionLoopCap(input: {
    subjectId: string;
    deviceId: string;
    maxCorrectionTurns: number;
    policyId: string;
    policyVersion: number;
  }): void | Promise<void>;
  switchDegradationMode(input: {
    subjectId: string;
    deviceId: string;
    dependency: RemediationDegradationDependency;
    behavior: RemediationDegradationBehavior;
    policyId: string;
    policyVersion: number;
  }): void | Promise<void>;
  setRoutingFallback(input: {
    subjectId: string;
    deviceId: string;
    fallback: RemediationRoutingFallback;
    policyId: string;
    policyVersion: number;
  }): void | Promise<void>;
};

export type RemediationExecutorTelemetryEvent = {
  event: "runtime.harness.remediation_executor";
  outcome:
    | "ok"
    | "fail"
    | "advisory"
    | "suppressed"
    | "disabled"
    | "idempotent_replay";
  subjectId: string;
  deviceId: string;
  policyId?: string;
  policyVersion?: number;
  failureClass?: RemediationFailureClass;
  actionKind?: RemediationActionKind;
  surface?: RemediationControlSurface | string;
  evidenceFingerprint?: string;
  executionKey?: string;
  attemptCount?: number;
  pageRequested?: boolean;
  disabled?: boolean;
  obligation?: RemediationExecutorFailureClass;
};

export type InMemoryRemediationSurfaceState = {
  retryCap: number | undefined;
  maxCorrectionTurns: number | undefined;
  degradation: {
    dependency: RemediationDegradationDependency;
    behavior: RemediationDegradationBehavior;
  } | undefined;
  routingFallback: RemediationRoutingFallback | undefined;
  applyCount: number;
};

/** Test/host stub that records applied control-surface mutations. */
export function createInMemoryRemediationSurfaces(options?: {
  onApply?: (action: RemediationAction) => void;
  failOnSurface?: RemediationControlSurface;
}): {
  ports: RemediationControlSurfacePorts;
  state: InMemoryRemediationSurfaceState;
} {
  const state: InMemoryRemediationSurfaceState = {
    retryCap: undefined,
    maxCorrectionTurns: undefined,
    degradation: undefined,
    routingFallback: undefined,
    applyCount: 0,
  };
  const maybeFail = (surface: RemediationControlSurface): void => {
    if (options?.failOnSurface === surface) {
      throw new RemediationExecutorContractError(
        `control surface ${surface} apply failed`,
        { obligation: "remediation_executor.surface_failed" },
      );
    }
  };
  const ports: RemediationControlSurfacePorts = {
    setRetryCap(input) {
      maybeFail("retry_cap");
      state.retryCap = input.maxRetries;
      state.applyCount += 1;
      options?.onApply?.({
        kind: "adjust_retry_budget",
        surface: "retry_cap",
        maxRetries: input.maxRetries,
      });
    },
    setCorrectionLoopCap(input) {
      maybeFail("correction_loop");
      state.maxCorrectionTurns = input.maxCorrectionTurns;
      state.applyCount += 1;
      options?.onApply?.({
        kind: "set_correction_loop_cap",
        surface: "correction_loop",
        maxCorrectionTurns: input.maxCorrectionTurns,
      });
    },
    switchDegradationMode(input) {
      maybeFail("degradation_registry");
      state.degradation = {
        dependency: input.dependency,
        behavior: input.behavior,
      };
      state.applyCount += 1;
      options?.onApply?.({
        kind: "switch_degradation_mode",
        surface: "degradation_registry",
        dependency: input.dependency,
        behavior: input.behavior,
      });
    },
    setRoutingFallback(input) {
      maybeFail("routing_budget");
      state.routingFallback = input.fallback;
      state.applyCount += 1;
      options?.onApply?.({
        kind: "set_routing_fallback",
        surface: "routing_budget",
        fallback: input.fallback,
      });
    },
  };
  return { ports, state };
}

export type ExecuteRemediationInput = {
  subjectId: string;
  failureClass: RemediationFailureClass;
  /** Metadata-only evidence id — never utterance bodies. */
  evidenceFingerprint: string;
  /** Idempotency key for this remediation fire (replay-safe). */
  executionKey: string;
  deviceId?: string;
  /** Optional deadline; on exceed throws typed timeout. */
  timeoutMs?: number;
};

export type RemediationExecuteResult =
  | {
      ok: true;
      applied: true;
      policy: RemediationPolicyDocument;
      action: RemediationAction;
      executionKey: string;
      attemptCount: number;
      idempotentReplay: boolean;
    }
  | {
      ok: false;
      applied: false;
      reason:
        | "missing_policy"
        | "triage_suppressed"
        | "below_confidence"
        | "disabled_ineffective"
        | "cross_subject_denied";
      policy?: RemediationPolicyDocument;
      executionKey: string;
      pageRequested?: boolean;
    };

export type ReportRemediationOutcomeInput = {
  executionKey: string;
  /** True when the failure class resolved after remediation. */
  resolved: boolean;
  subjectId?: string;
};

export type RemediationExecutor = {
  readonly subjectId: string;
  readonly deviceId: string;
  execute(input: ExecuteRemediationInput): Promise<RemediationExecuteResult>;
  reportOutcome(input: ReportRemediationOutcomeInput): RemediationPolicyDocument | undefined;
  /** Snapshot of applied execution keys (bounded). */
  listExecutionKeys(): string[];
};

type ExecutionReceipt = {
  executionKey: string;
  subjectId: string;
  failureClass: RemediationFailureClass;
  policyId: string;
  policyVersion: number;
  action: RemediationAction;
  surfaceApplied: boolean;
  outcomeReported: boolean;
  resolved: boolean | undefined;
  attemptCount: number;
};

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function emit(
  onTelemetry:
    | ((event: RemediationExecutorTelemetryEvent) => void)
    | undefined,
  event: RemediationExecutorTelemetryEvent,
): void {
  onTelemetry?.(event);
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  meta: { subjectId: string; deviceId: string },
): Promise<T> {
  if (timeoutMs === undefined) return work;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RemediationExecutorContractError(
      "timeoutMs must be an integer in 1..60000",
      {
        obligation: "remediation_policy.invalid_input",
        subjectId: meta.subjectId,
        deviceId: meta.deviceId,
      },
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RemediationExecutorContractError(
              "remediation surface apply timed out",
              {
                obligation: "remediation_executor.timeout",
                subjectId: meta.subjectId,
                deviceId: meta.deviceId,
              },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function applyAction(
  ports: RemediationControlSurfacePorts,
  policy: RemediationPolicyDocument,
  deviceId: string,
): Promise<void> {
  const action = parseRemediationAction(policy.action, {
    subjectId: policy.subjectId,
    deviceId,
  });
  const base = {
    subjectId: policy.subjectId,
    deviceId,
    policyId: policy.policyId,
    policyVersion: policy.version,
  };
  switch (action.kind) {
    case "adjust_retry_budget":
      await ports.setRetryCap({ ...base, maxRetries: action.maxRetries });
      return;
    case "set_correction_loop_cap":
      await ports.setCorrectionLoopCap({
        ...base,
        maxCorrectionTurns: action.maxCorrectionTurns,
      });
      return;
    case "switch_degradation_mode":
      await ports.switchDegradationMode({
        ...base,
        dependency: action.dependency,
        behavior: action.behavior,
      });
      return;
    case "set_routing_fallback":
      await ports.setRoutingFallback({
        ...base,
        fallback: action.fallback,
      });
      return;
  }
}

/**
 * Create a subject-scoped auto-remediation executor.
 * Concurrent execute/report calls for the same subject serialize via a queue.
 */
export function createRemediationExecutor(options: {
  subjectId: string;
  deviceId: string;
  catalog: RemediationPolicyCatalog;
  surfaces: RemediationControlSurfacePorts;
  confidenceThreshold?: number;
  onTelemetry?: (
    event: RemediationExecutorTelemetryEvent | RemediationPolicyTelemetryEvent,
  ) => void;
}): RemediationExecutor {
  const subjectId = options.subjectId;
  const deviceId = options.deviceId;
  const receipts = new Map<string, ExecutionReceipt>();
  let chain: Promise<unknown> = Promise.resolve();

  const assertSubject = (candidate: string): void => {
    if (candidate !== subjectId) {
      throw new RemediationExecutorContractError(
        "cross-subject remediation execution denied",
        {
          obligation: "remediation_policy.cross_subject_denied",
          subjectId,
          deviceId,
        },
      );
    }
  };

  const runSerialized = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const refuseForbiddenPayload = (raw: Record<string, unknown>): void => {
    for (const key of Object.keys(raw)) {
      if (/permission|approval|utterance|secret|content|body/i.test(key)) {
        throw new RemediationExecutorContractError(
          `forbidden or raw field ${key} refused on remediation execute`,
          {
            obligation: "remediation_executor.forbidden_action",
            subjectId,
            deviceId,
          },
        );
      }
    }
    const surface = raw.surface;
    if (
      typeof surface === "string" &&
      (FORBIDDEN_REMEDIATION_SURFACES as readonly string[]).includes(surface)
    ) {
      throw new RemediationExecutorContractError(
        `forbidden remediation surface ${surface}`,
        {
          obligation: "remediation_policy.forbidden_surface",
          subjectId,
          deviceId,
        },
      );
    }
  };

  return {
    subjectId,
    deviceId,

    async execute(input) {
      return runSerialized(async () => {
        assertSubject(input.subjectId);
        refuseForbiddenPayload(input as unknown as Record<string, unknown>);
        if (!ID_RE.test(input.executionKey)) {
          throw new RemediationExecutorContractError(
            "executionKey must be a stable id",
            {
              obligation: "remediation_policy.invalid_input",
              subjectId,
              deviceId,
            },
          );
        }
        if (!ID_RE.test(input.evidenceFingerprint)) {
          throw new RemediationExecutorContractError(
            "evidenceFingerprint must be a stable id",
            {
              obligation: "remediation_policy.invalid_input",
              subjectId,
              deviceId,
            },
          );
        }

        const existing = receipts.get(input.executionKey);
        if (existing !== undefined) {
          if (
            existing.failureClass !== input.failureClass ||
            existing.subjectId !== input.subjectId
          ) {
            throw new RemediationExecutorContractError(
              "executionKey conflict for remediation",
              {
                obligation: "remediation_policy.idempotent_conflict",
                subjectId,
                deviceId,
              },
            );
          }
          emit(options.onTelemetry, {
            event: "runtime.harness.remediation_executor",
            outcome: "idempotent_replay",
            subjectId,
            deviceId,
            policyId: existing.policyId,
            policyVersion: existing.policyVersion,
            failureClass: existing.failureClass,
            actionKind: existing.action.kind,
            surface: existing.action.surface,
            evidenceFingerprint: input.evidenceFingerprint,
            executionKey: input.executionKey,
            attemptCount: existing.attemptCount,
          });
          const policies = options.catalog.listPolicies();
          const policy = policies
            .filter((row) => row.policyId === existing.policyId)
            .sort((a, b) => b.version - a.version)[0];
          if (policy === undefined || !existing.surfaceApplied) {
            return {
              ok: false as const,
              applied: false as const,
              reason: "missing_policy" as const,
              executionKey: input.executionKey,
            };
          }
          return {
            ok: true as const,
            applied: true as const,
            policy,
            action: existing.action,
            executionKey: input.executionKey,
            attemptCount: existing.attemptCount,
            idempotentReplay: true,
          };
        }

        if (receipts.size >= REMEDIATION_EXECUTION_RECEIPT_LIMIT) {
          throw new RemediationExecutorContractError(
            "remediation execution receipt capacity exceeded",
            {
              obligation: "remediation_policy.capacity",
              subjectId,
              deviceId,
            },
          );
        }

        const resolved = options.catalog.resolveForFailureClass(
          input.failureClass,
          options.confidenceThreshold !== undefined
            ? { confidenceThreshold: options.confidenceThreshold }
            : undefined,
        );

        if (!resolved.ok) {
          const obligation =
            resolved.reason === "triage_suppressed"
              ? ("remediation_policy.triage_suppressed" as const)
              : resolved.reason === "disabled_ineffective"
                ? ("remediation_policy.disabled_ineffective" as const)
                : resolved.reason === "below_confidence"
                  ? ("remediation_policy.below_confidence" as const)
                  : resolved.reason === "cross_subject_denied"
                    ? ("remediation_policy.cross_subject_denied" as const)
                    : undefined;
          emit(options.onTelemetry, {
            event: "runtime.harness.remediation_executor",
            outcome:
              resolved.reason === "triage_suppressed"
                ? "suppressed"
                : resolved.reason === "disabled_ineffective"
                  ? "disabled"
                  : "advisory",
            subjectId,
            deviceId,
            failureClass: input.failureClass,
            evidenceFingerprint: input.evidenceFingerprint,
            executionKey: input.executionKey,
            ...(resolved.policy?.policyId !== undefined
              ? { policyId: resolved.policy.policyId }
              : {}),
            ...(resolved.policy?.version !== undefined
              ? { policyVersion: resolved.policy.version }
              : {}),
            ...(resolved.policy?.pageRequested !== undefined
              ? { pageRequested: resolved.policy.pageRequested }
              : {}),
            ...(resolved.policy?.disabled !== undefined
              ? { disabled: resolved.policy.disabled }
              : {}),
            ...(obligation !== undefined ? { obligation } : {}),
          });
          return {
            ok: false as const,
            applied: false as const,
            reason: resolved.reason,
            ...(resolved.policy !== undefined ? { policy: resolved.policy } : {}),
            executionKey: input.executionKey,
            ...(resolved.policy?.pageRequested === true
              ? { pageRequested: true }
              : {}),
          };
        }

        const policy = resolved.policy;
        const action = policy.action;
        let surfaceApplied = false;
        try {
          await withTimeout(
            Promise.resolve(applyAction(options.surfaces, policy, deviceId)),
            input.timeoutMs,
            { subjectId, deviceId },
          );
          surfaceApplied = true;
        } catch (error) {
          if (
            error instanceof RemediationExecutorContractError ||
            error instanceof RemediationPolicyContractError
          ) {
            emit(options.onTelemetry, {
              event: "runtime.harness.remediation_executor",
              outcome: "fail",
              subjectId,
              deviceId,
              policyId: policy.policyId,
              policyVersion: policy.version,
              failureClass: input.failureClass,
              actionKind: action.kind,
              surface: action.surface,
              executionKey: input.executionKey,
              obligation:
                error instanceof RemediationExecutorContractError
                  ? error.obligation
                  : error.obligation,
            });
            throw error instanceof RemediationExecutorContractError
              ? error
              : new RemediationExecutorContractError(error.message, {
                  obligation: error.obligation,
                  subjectId,
                  deviceId,
                });
          }
          emit(options.onTelemetry, {
            event: "runtime.harness.remediation_executor",
            outcome: "fail",
            subjectId,
            deviceId,
            policyId: policy.policyId,
            policyVersion: policy.version,
            failureClass: input.failureClass,
            actionKind: action.kind,
            surface: action.surface,
            executionKey: input.executionKey,
            obligation: "remediation_executor.surface_failed",
          });
          throw new RemediationExecutorContractError(
            "control surface apply failed",
            {
              obligation: "remediation_executor.surface_failed",
              subjectId,
              deviceId,
            },
          );
        }

        // Durable receipt after successful surface apply (partial-failure safe).
        const receipt: ExecutionReceipt = {
          executionKey: input.executionKey,
          subjectId,
          failureClass: input.failureClass,
          policyId: policy.policyId,
          policyVersion: policy.version,
          action,
          surfaceApplied,
          outcomeReported: false,
          resolved: undefined,
          attemptCount: policy.ineffectiveAttempts,
        };
        receipts.set(input.executionKey, receipt);

        emit(options.onTelemetry, {
          event: "runtime.harness.remediation_executor",
          outcome: "ok",
          subjectId,
          deviceId,
          policyId: policy.policyId,
          policyVersion: policy.version,
          failureClass: input.failureClass,
          actionKind: action.kind,
          surface: action.surface,
          evidenceFingerprint: input.evidenceFingerprint,
          executionKey: input.executionKey,
          attemptCount: receipt.attemptCount,
        });

        return {
          ok: true as const,
          applied: true as const,
          policy,
          action,
          executionKey: input.executionKey,
          attemptCount: receipt.attemptCount,
          idempotentReplay: false,
        };
      });
    },

    reportOutcome(input) {
      assertSubject(input.subjectId ?? subjectId);
      const receipt = receipts.get(input.executionKey);
      if (receipt === undefined) {
        throw new RemediationExecutorContractError(
          "unknown remediation executionKey",
          {
            obligation: "remediation_policy.invalid_input",
            subjectId,
            deviceId,
          },
        );
      }
      if (receipt.outcomeReported) {
        // Idempotent outcome report.
        const latest = options.catalog
          .listPolicies()
          .filter((row) => row.policyId === receipt.policyId)
          .sort((a, b) => b.version - a.version)[0];
        return latest;
      }

      receipt.outcomeReported = true;
      receipt.resolved = input.resolved;

      if (input.resolved) {
        emit(options.onTelemetry, {
          event: "runtime.harness.remediation_executor",
          outcome: "ok",
          subjectId,
          deviceId,
          policyId: receipt.policyId,
          policyVersion: receipt.policyVersion,
          failureClass: receipt.failureClass,
          actionKind: receipt.action.kind,
          surface: receipt.action.surface,
          executionKey: input.executionKey,
          attemptCount: receipt.attemptCount,
        });
        return options.catalog
          .listPolicies()
          .filter((row) => row.policyId === receipt.policyId)
          .sort((a, b) => b.version - a.version)[0];
      }

      const updated = options.catalog.recordIneffectiveAttempt(receipt.policyId);
      if (updated === undefined) {
        throw new RemediationExecutorContractError(
          "policy missing when recording ineffective attempt",
          {
            obligation: "remediation_policy.invalid_input",
            subjectId,
            deviceId,
          },
        );
      }
      receipt.attemptCount = updated.ineffectiveAttempts;

      emit(options.onTelemetry, {
        event: "runtime.harness.remediation_executor",
        outcome: updated.disabled ? "disabled" : "advisory",
        subjectId,
        deviceId,
        policyId: updated.policyId,
        policyVersion: updated.version,
        failureClass: receipt.failureClass,
        actionKind: receipt.action.kind,
        surface: receipt.action.surface,
        executionKey: input.executionKey,
        attemptCount: updated.ineffectiveAttempts,
        disabled: updated.disabled,
        pageRequested: updated.pageRequested,
        ...(updated.disabled
          ? { obligation: "remediation_policy.disabled_ineffective" as const }
          : {}),
      });
      return updated;
    },

    listExecutionKeys() {
      return [...receipts.keys()].sort();
    },
  };
}
