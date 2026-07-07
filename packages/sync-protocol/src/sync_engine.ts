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
 */

import {
  cognitiveStateSchema,
  type CognitiveState,
  type SyncRequest,
  type SyncResponse,
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
}

export type SyncOutcome =
  | { status: "converged"; state: CognitiveState; attempts: number }
  | { status: "quarantined"; reason: string; httpStatus: number }
  | { status: "exhausted"; reason: string; attempts: number };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SyncEngine {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly transport: SyncTransport,
    options: SyncEngineOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /**
   * Drive one sync attempt series to a terminal outcome. Every terminal
   * state is a plain value — this method never throws, so edge callers can
   * fire-and-forget it from a background task without crash risk.
   */
  async synchronize(request: SyncRequest): Promise<SyncOutcome> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const result = await this.transport.postSync(request);

      switch (result.kind) {
        case "ok": {
          const validated = cognitiveStateSchema.safeParse(result.response.mergedState);
          if (!validated.success) {
            // Server returned garbage: keep local truth, do not adopt.
            return {
              status: "exhausted",
              reason: `server merge response failed contract validation: ${validated.error.message}`,
              attempts: attempt,
            };
          }
          return { status: "converged", state: validated.data, attempts: attempt };
        }

        case "http-error": {
          if (result.status >= 400 && result.status < 500) {
            // Malformed by the server's judgment — retrying is futile and harmful.
            return {
              status: "quarantined",
              reason: `server rejected sync payload: ${result.body.slice(0, 512)}`,
              httpStatus: result.status,
            };
          }
          break; // 5xx → fall through to backoff
        }

        case "network-error":
          break; // offline again, or DNS flake → backoff
      }

      if (attempt < this.maxAttempts) {
        await this.sleep(this.backoffDelay(attempt));
      }
    }

    return {
      status: "exhausted",
      reason: "transient failures persisted through all attempts; will retry next connectivity window",
      attempts: this.maxAttempts,
    };
  }

  /** Exponential backoff with full jitter (AWS architecture blog canon). */
  private backoffDelay(attempt: number): number {
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(this.random() * ceiling);
  }
}
