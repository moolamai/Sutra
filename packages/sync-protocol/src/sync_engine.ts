/**
 * @module sync_engine
 *
 * Autonomous, self-healing sync driver used by the Edge Harness to push
 * its replica to any contract-compliant cloud engine when connectivity
 * returns. Transport-agnostic: the caller supplies a `SyncTransport`
 * (fetch, gRPC-web bridge, a test double — anything).
 *
 * Error-handling doctrine (strictly autonomous — no user prompts, ever):
 *   1. Transient failures (network, 5xx, timeout) → exponential backoff
 *      with full jitter, capped attempts, same idempotency key.
 *   2. Contract failures (4xx schema rejection) → quarantine the payload
 *      locally and surface a structured report; NEVER retry a payload the
 *      server has declared malformed.
 *   3. Merge divergence (server response fails local validation) → keep
 *      the local replica authoritative, flag for the next sync window.
 *
 * 003: attempt/backoff/terminal spans, W3C traceparent
 * injection, and SYNC-06 advisory → span events via `@moolam/observability`
 * sync_audit (metadata only). Public synchronize() outcome contract unchanged.
 */

import {
  createSyncInstrumentation,
  getObservability,
  injectSyncWireHeaders,
  type SyncInstrumentation,
  type SyncTerminalRecord,
} from "@moolam/observability";
import {
  cognitiveStateSchema,
  SYNC_ADVISORY_CODES,
  type CognitiveState,
  type SyncAdvisory,
  type SyncAdvisoryCode,
  type SyncExhaustedReasonCode,
  type SyncQuarantineReasonCode,
  type SyncRequest,
  type SyncResponse,
  type SyncWireHeaders,
} from "./contract.js";

/** Minimal transport the engine needs. Implementations must not throw for HTTP-level errors. */
export interface SyncTransport {
  postSync(request: SyncRequest): Promise<
    | { kind: "ok"; response: SyncResponse }
    | { kind: "http-error"; status: number; body: string }
    | { kind: "network-error"; cause: string }
  >;
}

export interface SyncEngineOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * Optional sync span instrumentation. Defaults to
   * {@link createSyncInstrumentation}(`getObservability()`) so hosts that
   * called `initObservability()` get attempt/backoff/terminal spans automatically.
   */
  syncInstrumentation?: SyncInstrumentation;
  /**
   * Connectivity hint for span attributes. Network-error paths may override
   * to `offline`. Offline hosts with no transport typically never construct
   * SyncEngine (see edge-agent); when set to offline, spans still emit.
   */
  connectivity?: "online" | "offline";
}

export type SyncOutcome =
  | {
      status: "converged";
      state: CognitiveState;
      attempts: number;
      /** SYNC-06 codes only — never advisory detail text. */
      advisoryCodes: SyncAdvisoryCode[];
    }
  | {
      status: "quarantined";
      reason: string;
      httpStatus: number;
      reasonCode: SyncQuarantineReasonCode;
      attempts: number;
      advisoryCodes: SyncAdvisoryCode[];
    }
  | {
      status: "exhausted";
      reason: string;
      attempts: number;
      reasonCode: SyncExhaustedReasonCode;
      advisoryCodes: SyncAdvisoryCode[];
    };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Lift known SYNC-06 codes only; drop unknown; never keep detail. Bound 32. */
function advisoryCodesOnly(
  advisories: readonly SyncAdvisory[] | undefined,
): SyncAdvisoryCode[] {
  const out: SyncAdvisoryCode[] = [];
  const seen = new Set<string>();
  for (const a of advisories ?? []) {
    const code = a.code;
    if (
      !(SYNC_ADVISORY_CODES as readonly string[]).includes(code) ||
      seen.has(code)
    ) {
      continue;
    }
    seen.add(code);
    out.push(code as SyncAdvisoryCode);
    if (out.length >= 32) break;
  }
  return out;
}

function toTerminalRecord(outcome: SyncOutcome): SyncTerminalRecord {
  if (outcome.status === "converged") {
    return { outcome: "converged", attempts: outcome.attempts };
  }
  if (outcome.status === "quarantined") {
    return {
      outcome: "quarantined",
      attempts: outcome.attempts,
      quarantineCode: outcome.reasonCode,
      httpStatus: outcome.httpStatus,
    };
  }
  return {
    outcome: "exhausted",
    attempts: outcome.attempts,
    exhaustedCode: outcome.reasonCode,
  };
}

export class SyncEngine {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly instrumentation: SyncInstrumentation;
  private readonly connectivity: "online" | "offline";

  constructor(
    private readonly transport: SyncTransport,
    options: SyncEngineOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.instrumentation =
      options.syncInstrumentation ??
      createSyncInstrumentation(getObservability());
    this.connectivity = options.connectivity ?? "online";
  }

  /**
   * Drive one sync attempt series to a terminal outcome. Every terminal
   * state is a plain value — this method never throws, so edge callers can
   * fire-and-forget it from a background task without crash risk.
   */
  async synchronize(request: SyncRequest): Promise<SyncOutcome> {
    const subjectId = request.edgeState.subjectId.trim();
    if (!subjectId) {
      // Subject isolation: refuse to sync an unscoped replica.
      const exhausted: SyncOutcome = {
        status: "exhausted",
        reason: "edgeState.subjectId is required (subject isolation)",
        attempts: 0,
        reasonCode: "TRANSIENT_ATTEMPTS_EXHAUSTED",
        advisoryCodes: [],
      };
      return exhausted;
    }

    return this.instrumentation.withSync(
      {
        subjectId,
        deviceId: request.deviceId,
        syncAttemptId: request.syncAttemptId,
        connectivity: this.connectivity,
        maxAttempts: this.maxAttempts,
      },
      async (series) => {
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
          const result = await series.runAttempt(attempt, () => {
            // Inject W3C traceparent from the active attempt span .
            const wired = withInjectedTraceHeaders(request);
            return this.transport.postSync(wired);
          });

          switch (result.kind) {
            case "ok": {
              const validated = cognitiveStateSchema.safeParse(
                result.response.mergedState,
              );
              if (!validated.success) {
                const outcome: SyncOutcome = {
                  status: "exhausted",
                  reason: `server merge response failed contract validation: ${validated.error.message}`,
                  attempts: attempt,
                  reasonCode: "MERGE_RESPONSE_INVALID",
                  advisoryCodes: [],
                };
                series.complete(toTerminalRecord(outcome));
                return outcome;
              }
              const advisoryCodes = advisoryCodesOnly(
                result.response.advisories,
              );
              const outcome: SyncOutcome = {
                status: "converged",
                state: validated.data,
                attempts: attempt,
                advisoryCodes,
              };
              // Advisory codes → span events (never detail text).
              series.recordAdvisories(result.response.advisories ?? []);
              series.complete(toTerminalRecord(outcome));
              return outcome;
            }

            case "http-error": {
              if (result.status >= 400 && result.status < 500) {
                // Malformed by the server's judgment — retrying is futile.
                // Span records reasonCode only; `reason` stays local (may cite body).
                const outcome: SyncOutcome = {
                  status: "quarantined",
                  reason: `server rejected sync payload: ${result.body.slice(0, 512)}`,
                  httpStatus: result.status,
                  reasonCode: "HTTP_CLIENT_REJECTED",
                  attempts: attempt,
                  advisoryCodes: [],
                };
                series.complete(toTerminalRecord(outcome));
                return outcome;
              }
              break; // 5xx → fall through to backoff
            }

            case "network-error":
              series.setConnectivity("offline");
              break; // offline again, or DNS flake → backoff
          }

          if (attempt < this.maxAttempts) {
            const delay = this.backoffDelay(attempt);
            series.recordBackoff(delay, attempt);
            await this.sleep(delay);
          }
        }

        const outcome: SyncOutcome = {
          status: "exhausted",
          reason:
            "transient failures persisted through all attempts; will retry next connectivity window",
          attempts: this.maxAttempts,
          reasonCode: "TRANSIENT_ATTEMPTS_EXHAUSTED",
          advisoryCodes: [],
        };
        series.complete(toTerminalRecord(outcome));
        return outcome;
      },
    );
  }

  /** Exponential backoff with full jitter (AWS architecture blog canon). */
  private backoffDelay(attempt: number): number {
    const ceiling = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** (attempt - 1),
    );
    return Math.floor(this.random() * ceiling);
  }
}

/**
 * Attach W3C Trace Context headers for the active span without cloning
 * learner payload fields deeply. Existing allow-listed headers are preserved
 * only for tracestate when the injector does not overwrite them.
 */
export function withInjectedTraceHeaders(request: SyncRequest): SyncRequest {
  const existing: Record<string, string> = {};
  const prior = request.headers;
  if (prior?.traceparent) existing.traceparent = prior.traceparent;
  if (prior?.tracestate) existing.tracestate = prior.tracestate;
  const injected = injectSyncWireHeaders(existing);
  const headers: SyncWireHeaders = {};
  if (injected.traceparent) headers.traceparent = injected.traceparent;
  if (injected.tracestate) headers.tracestate = injected.tracestate;
  if (!headers.traceparent && !headers.tracestate) {
    return request;
  }
  return { ...request, headers };
}
