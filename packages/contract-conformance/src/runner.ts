/**
 * Isolated, deadlined obligation runner .
 *
 * Fresh factory per obligation; configurable deadline (default 5s);
 * setup/teardown attributed to the implementation; aggregate CI exit code.
 * Human/JSON reporting and the `conformance` bin live in `report.ts` / `cli.ts`.
 */

import {
  ObligationViolation,
  UnknownObligationIdError,
  createObligationContext,
  type ConformanceObligationEvent,
  type Obligation,
  type ObligationRegistry,
} from "./registry.js";
import {
  buildRunReport,
  type ConformanceRunReport,
  type FailureAttribution,
  type ObligationVerdict,
  type VerdictOutcome,
} from "./report.js";

export const DEFAULT_OBLIGATION_DEADLINE_MS = 5_000;

/**
 * Per-check wall-clock budget for the bindings-slm certification harness
 * (B0 obligations, B1 locality ops, P4 first_token probe). Matches B0 runner
 * defaults so CI never hangs on a stuck adapter.
 *
 * Reports emitted by the harness are validated against
 * `packages/bindings-slm/certification/schemas/certification.report.schema.json`
 * (`bindings-slm.certification.report.v1`) and profiles are resolved via
 * `packages/bindings-slm/certification/registry.json`.
 *
 * One-command proof (`proveOneCommandCertifyFlow`) exercises desktop + one
 * mobile profile through the same per-check deadline budget.
 */
export const CERTIFICATION_CHECK_DEADLINE_MS = DEFAULT_OBLIGATION_DEADLINE_MS;

/** Keep in sync with bindings-slm certification.report.schema.json `schemaVersion`. */
export const BINDING_CERTIFICATION_REPORT_SCHEMA_VERSION =
  "bindings-slm.certification.report.v1";

/** Raised when an obligation exceeds its wall-clock deadline. */
export class ObligationDeadlineError extends Error {
  readonly obligationId: string;
  readonly deadlineMs: number;

  constructor(obligationId: string, deadlineMs: number) {
    super(
      `obligation '${obligationId}' exceeded deadline of ${deadlineMs}ms`,
    );
    this.name = "ObligationDeadlineError";
    this.obligationId = obligationId;
    this.deadlineMs = deadlineMs;
  }
}

export interface FactoryContext {
  subjectId: string;
  obligationId: string;
  signal: AbortSignal;
}

/**
 * Produces a fresh implementation instance for one obligation.
 * Must not share mutable state across invocations.
 */
export type ImplementationFactory<T> = (
  ctx: FactoryContext,
) => Promise<T> | T;

/** Optional cleanup after a check (always attempted; errors → implementation). */
export type ImplementationTeardown<T> = (
  impl: T,
  ctx: FactoryContext,
) => Promise<void> | void;

export type ConformanceRunnerEvent = {
  event: "conformance.runner";
  obligationId: string;
  outcome: VerdictOutcome | "setup_error" | "teardown_error";
  attribution: FailureAttribution;
  subjectId: string;
  durationMs: number;
  deviceId?: string;
};

export type RunConformanceOptions<T> = {
  registry: ObligationRegistry;
  factory: ImplementationFactory<T>;
  subjectId: string;
  /** Empty / omitted → all registered obligations (sorted). */
  obligationIds?: readonly string[];
  deadlineMs?: number;
  teardown?: ImplementationTeardown<T>;
  emit?: (
    event: ConformanceObligationEvent | ConformanceRunnerEvent,
  ) => void;
} & ({ deviceId: string } | { deviceId?: undefined });

function raceDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(onTimeout());
    }, deadlineMs);
    work.then(
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

function nowMs(): number {
  return Date.now();
}

/**
 * Run selected obligations in isolation with per-check deadlines.
 * Continues after failures so the report is complete; {@link ConformanceRunReport.exitCode}
 * is `1` if any verdict is non-pass.
 */
export async function runConformance<T>(
  options: RunConformanceOptions<T>,
): Promise<ConformanceRunReport> {
  const subjectId = options.subjectId.trim();
  if (!subjectId) {
    throw new Error("runConformance requires a non-empty subjectId");
  }
  const deadlineMs = options.deadlineMs ?? DEFAULT_OBLIGATION_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error("deadlineMs must be a positive number");
  }

  const emit =
    options.emit ??
    ((_event: ConformanceObligationEvent | ConformanceRunnerEvent) => {});

  let selected: Obligation<unknown>[];
  try {
    selected = options.registry.select(options.obligationIds);
  } catch (err) {
    if (err instanceof UnknownObligationIdError) {
      // Harness validation before any factory call — fail the run as one harness verdict.
      return buildRunReport([
        {
          obligationId: err.obligationId,
          contract: "(selection)",
          mustText: "Selected obligation ids MUST exist in the registry.",
          outcome: "error",
          attribution: "harness",
          durationMs: 0,
          subjectId,
          ...(options.deviceId !== undefined
            ? { deviceId: options.deviceId }
            : {}),
          message: err.message,
        },
      ]);
    }
    throw err;
  }

  const verdicts: ObligationVerdict[] = [];

  for (const obligation of selected) {
    // Isolate subject namespace per obligation so accidental shared store can't leach.
    const isolatedSubjectId = `${subjectId}::${obligation.id}`;
    const started = nowMs();
    const controller = new AbortController();
    const factoryCtx: FactoryContext = {
      subjectId: isolatedSubjectId,
      obligationId: obligation.id,
      signal: controller.signal,
    };

    let impl: T | undefined;
    let outcome: VerdictOutcome = "pass";
    let attribution: FailureAttribution = "implementation";
    let message: string | undefined;

    try {
      try {
        impl = await raceDeadline(
          Promise.resolve(options.factory(factoryCtx)),
          deadlineMs,
          () => new ObligationDeadlineError(obligation.id, deadlineMs),
        );
      } catch (err) {
        attribution = "implementation";
        if (err instanceof ObligationDeadlineError) {
          controller.abort();
          outcome = "timeout";
          message = err.message;
          emit({
            event: "conformance.runner",
            obligationId: obligation.id,
            outcome: "timeout",
            attribution,
            subjectId: isolatedSubjectId,
            durationMs: nowMs() - started,
            ...(options.deviceId !== undefined
              ? { deviceId: options.deviceId }
              : {}),
          });
        } else {
          outcome = "error";
          message = `setup failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
          emit({
            event: "conformance.runner",
            obligationId: obligation.id,
            outcome: "setup_error",
            attribution,
            subjectId: isolatedSubjectId,
            durationMs: nowMs() - started,
            ...(options.deviceId !== undefined
              ? { deviceId: options.deviceId }
              : {}),
          });
        }
        verdicts.push({
          obligationId: obligation.id,
          contract: obligation.contract,
          mustText: obligation.mustText,
          outcome,
          attribution,
          durationMs: nowMs() - started,
          subjectId: isolatedSubjectId,
          ...(options.deviceId !== undefined
            ? { deviceId: options.deviceId }
            : {}),
          ...(message !== undefined ? { message } : {}),
        });
        continue;
      }

      const ctx = createObligationContext({
        subjectId: isolatedSubjectId,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
        deadlineMs,
        signal: controller.signal,
        emit: (event) => emit(event),
      });

      try {
        await raceDeadline(
          Promise.resolve(
            (obligation as Obligation<T>).check(impl as T, ctx),
          ),
          deadlineMs,
          () => new ObligationDeadlineError(obligation.id, deadlineMs),
        );
        outcome = "pass";
        emit({
          event: "conformance.obligation",
          obligationId: obligation.id,
          outcome: "pass",
          subjectId: isolatedSubjectId,
          ...(options.deviceId !== undefined
            ? { deviceId: options.deviceId }
            : {}),
          contract: obligation.contract,
        });
        emit({
          event: "conformance.runner",
          obligationId: obligation.id,
          outcome: "pass",
          attribution: "implementation",
          subjectId: isolatedSubjectId,
          durationMs: nowMs() - started,
          ...(options.deviceId !== undefined
            ? { deviceId: options.deviceId }
            : {}),
        });
      } catch (err) {
        controller.abort();
        attribution = "implementation";
        if (err instanceof ObligationDeadlineError) {
          outcome = "timeout";
          message = err.message;
        } else if (err instanceof ObligationViolation) {
          outcome = "fail";
          message = err.message;
        } else {
          outcome = "error";
          message = `check failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
        emit({
          event: "conformance.obligation",
          obligationId: obligation.id,
          outcome: outcome === "timeout" ? "error" : outcome === "fail" ? "fail" : "error",
          subjectId: isolatedSubjectId,
          ...(options.deviceId !== undefined
            ? { deviceId: options.deviceId }
            : {}),
          contract: obligation.contract,
        });
        emit({
          event: "conformance.runner",
          obligationId: obligation.id,
          outcome,
          attribution,
          subjectId: isolatedSubjectId,
          durationMs: nowMs() - started,
          ...(options.deviceId !== undefined
            ? { deviceId: options.deviceId }
            : {}),
        });
      }
    } finally {
      if (impl !== undefined && options.teardown) {
        try {
          await options.teardown(impl, factoryCtx);
        } catch (err) {
          // Teardown fault does not upgrade a pass silently — surface as error.
          const teardownMessage = `teardown failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
          emit({
            event: "conformance.runner",
            obligationId: obligation.id,
            outcome: "teardown_error",
            attribution: "implementation",
            subjectId: isolatedSubjectId,
            durationMs: nowMs() - started,
            ...(options.deviceId !== undefined
              ? { deviceId: options.deviceId }
              : {}),
          });
          if (outcome === "pass") {
            outcome = "error";
            attribution = "implementation";
            message = teardownMessage;
          } else {
            message = message
              ? `${message}; ${teardownMessage}`
              : teardownMessage;
          }
        }
      }
    }

    verdicts.push({
      obligationId: obligation.id,
      contract: obligation.contract,
      mustText: obligation.mustText,
      outcome,
      attribution,
      durationMs: nowMs() - started,
      subjectId: isolatedSubjectId,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  }

  return buildRunReport(verdicts);
}
