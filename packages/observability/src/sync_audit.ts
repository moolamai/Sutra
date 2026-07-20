/**
 * SyncEngine OpenTelemetry span bridge ( / 002).
 *
 * One `sutra.sync` root per `synchronize()` series; each transport try is a
 * `sutra.sync.attempt` child. Terminal outcome attributes are metadata only —
 * never HTTP bodies, CRDT state blobs, or advisory payload text.
 *
 * Parent: when a turn span is active on the context, sync is a child of it;
 * otherwise the sync root is a standalone root.
 *
 * W3C `traceparent` / `tracestate` injected into the SyncRequest
 * envelope headers; cloud extracts before CRDT merge via
 * {@link extractSyncWireContext} / {@link withContinuedSyncSpan}.
 *
 * SYNC-06 SyncAdvisory codes → `sutra.sync.advisory` span events
 * (code + attempt/subject/device IDs + optional HLC timestamp only — never detail
 * / shard content as the event name or free-text attribute).
 */

import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { ObservabilityHandle } from "./otel_bridge.js";
import { getObservability } from "./otel_bridge.js";

/** Metadata-only keys permitted on sync spans / attempt children / backoff events. */
export const ALLOWED_SYNC_ATTR_KEYS = Object.freeze([
  "sutra.subject_id",
  "sutra.device_id",
  "sutra.sync_attempt_id",
  "sutra.attempt",
  "sutra.retry_count",
  "sutra.outcome",
  "sutra.connectivity",
  "sutra.quarantine_code",
  "sutra.exhausted_code",
  "sutra.http_status",
  "sutra.backoff_ms",
  "sutra.max_attempts",
  "sutra.advisory_code",
  "sutra.advisory_index",
  "sutra.hlc_timestamp",
] as const);

/** Span event name for SYNC-06 advisories (never use advisory detail as the name). */
export const SYNC_ADVISORY_EVENT = "sutra.sync.advisory" as const;

/** Bound advisory events per synchronize() series (NFR). */
export const SYNC_ADVISORY_EVENT_LIMIT = 32;

/** Known SyncAdvisory.code values — unknown codes are dropped (not echoed as text). */
export const KNOWN_SYNC_ADVISORY_CODES = Object.freeze([
  "CLOCK_SKEW_CLAMPED",
  "DUPLICATE_SAMPLE_DROPPED",
  "UNKNOWN_CONCEPT_QUARANTINED",
  "STATE_VECTOR_REGRESSION",
  "DEPRECATED_FIELD_PRESENT",
] as const);

/** HLC on the wire — ID/timestamp only, safe to lift from advisory detail. */
const HLC_IN_DETAIL_RE = /\d{15}:\d{6}:[A-Za-z0-9_-]{4,64}/;

/** Minimal advisory shape for span mapping (detail never copied onto the span). */
export interface SyncAdvisoryForSpan {
  code: string;
  detail?: string;
}

/** W3C Trace Context field names on the SyncRequest.headers carrier. */
export const SYNC_WIRE_TRACEPARENT = "traceparent" as const;
export const SYNC_WIRE_TRACESTATE = "tracestate" as const;

const w3cPropagator = new W3CTraceContextPropagator();

const carrierSetter: TextMapSetter<Record<string, string>> = {
  set(carrier: Record<string, string>, key: string, value: string) {
    carrier[key.toLowerCase()] = value;
  },
};

const carrierGetter: TextMapGetter<Record<string, string>> = {
  keys(carrier: Record<string, string>) {
    return Object.keys(carrier);
  },
  get(carrier: Record<string, string>, key: string) {
    return carrier[key.toLowerCase()];
  },
};

/**
 * Inject W3C trace context from the active (or given) context into a
 * SyncRequest.headers carrier. Returns a new object — never mutates learner
 * payload fields. Empty when no recording span is active.
 */
export function injectSyncWireHeaders(
  existing?: Readonly<Record<string, string>>,
  ctx: Context = context.active(),
): Record<string, string> {
  const carrier: Record<string, string> = {};
  if (existing) {
    for (const [k, v] of Object.entries(existing)) {
      const key = k.toLowerCase();
      if (
        (key === SYNC_WIRE_TRACEPARENT || key === SYNC_WIRE_TRACESTATE) &&
        typeof v === "string" &&
        v.trim()
      ) {
        carrier[key] = v.trim().slice(0, 512);
      }
    }
  }
  w3cPropagator.inject(ctx, carrier, carrierSetter);
  return carrier;
}

/**
 * Normalize a mixed header map (HTTP or SyncRequest.headers) to lowercase
 * string carriers suitable for W3C extract.
 */
export function normalizeSyncWireCarrier(
  headers: Record<string, string | string[] | undefined> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    if (rawVal === undefined) continue;
    const key = rawKey.toLowerCase();
    if (key !== SYNC_WIRE_TRACEPARENT && key !== SYNC_WIRE_TRACESTATE) continue;
    const value = Array.isArray(rawVal) ? rawVal[0] : rawVal;
    if (typeof value === "string" && value.trim()) {
      out[key] = value.trim().slice(0, 512);
    }
  }
  return out;
}

/**
 * Extract remote context from SyncRequest.headers (or HTTP aliases).
 * Malformed / absent traceparent → returns `parent` unchanged (never throws).
 */
export function extractSyncWireContext(
  headers: Record<string, string | string[] | undefined> | null | undefined,
  parent: Context = context.active(),
): Context {
  const carrier = normalizeSyncWireCarrier(headers);
  if (!carrier[SYNC_WIRE_TRACEPARENT]) return parent;
  try {
    return w3cPropagator.extract(parent, carrier, carrierGetter);
  } catch {
    return parent;
  }
}

export type SyncTerminalOutcome =
  | "converged"
  | "quarantined"
  | "exhausted";

export type SyncConnectivity = "online" | "offline";

export interface SyncSpanAttributes {
  subjectId: string;
  deviceId: string;
  /** Idempotency key for the series (UUID) — metadata, not learner content. */
  syncAttemptId: string;
  /** Host hint; network-error paths may override to offline. */
  connectivity?: SyncConnectivity;
  maxAttempts?: number;
}

/** Terminal metadata recorded when the synchronize() series closes. */
export interface SyncTerminalRecord {
  outcome: SyncTerminalOutcome;
  attempts: number;
  /** Quarantine reason code only — never the rejected body. */
  quarantineCode?: string;
  httpStatus?: number;
  /** Exhausted reason code — never validation error text with payload. */
  exhaustedCode?: string;
}

export interface SyncSpanSeries {
  /** Run one transport try under a child attempt span. */
  runAttempt: <T>(attempt: number, fn: () => Promise<T>) => Promise<T>;
  /** Record backoff between attempts (root event; delay only, no payload). */
  recordBackoff: (delayMs: number, afterAttempt: number) => void;
  setConnectivity: (value: SyncConnectivity) => void;
  /**
   * Emit one `sutra.sync.advisory` event per SyncAdvisory .
   * Codes + attempt/subject/device IDs only — never advisory detail / shard text.
   */
  recordAdvisories: (advisories: readonly SyncAdvisoryForSpan[]) => void;
  /**
   * Apply terminal outcome attributes before returning from `withSync`.
   * Exhausted / quarantined use OK status (not ERROR) per SyncEngine semantics.
   */
  complete: (terminal: SyncTerminalRecord) => void;
}

/**
 * Map SYNC-06 advisories onto a span as events. Drops unknown codes and never
 * attaches `detail` free text. Optionally lifts the first HLC string from detail
 * into `sutra.hlc_timestamp` (timestamp ID only).
 */
export function recordSyncAdvisoryEvents(
  span: Span,
  attrs: Pick<
    SyncSpanAttributes,
    "subjectId" | "deviceId" | "syncAttemptId"
  >,
  advisories: readonly SyncAdvisoryForSpan[],
): number {
  if (!span.isRecording()) return 0;
  const known = new Set<string>(KNOWN_SYNC_ADVISORY_CODES);
  let emitted = 0;
  const list = Array.isArray(advisories) ? advisories : [];
  for (let i = 0; i < list.length && emitted < SYNC_ADVISORY_EVENT_LIMIT; i += 1) {
    const item = list[i];
    if (!item || typeof item.code !== "string") continue;
    const code = item.code.trim();
    if (!known.has(code)) continue;

    const eventAttrs: Attributes = {
      "sutra.advisory_code": code,
      "sutra.advisory_index": emitted,
      "sutra.sync_attempt_id": attrs.syncAttemptId,
      "sutra.subject_id": attrs.subjectId,
      "sutra.device_id": attrs.deviceId,
    };
    if (typeof item.detail === "string" && item.detail.length > 0) {
      const hlc = item.detail.match(HLC_IN_DETAIL_RE);
      if (hlc?.[0]) {
        eventAttrs["sutra.hlc_timestamp"] = hlc[0];
      }
    }
    span.addEvent(SYNC_ADVISORY_EVENT, eventAttrs);
    emitted += 1;
  }
  return emitted;
}

/**
 * Wraps SyncEngine.synchronize. Pass-through when ObservabilityHandle is absent.
 */
export interface SyncInstrumentation {
  withSync: <T>(
    attrs: SyncSpanAttributes,
    fn: (series: SyncSpanSeries) => Promise<T>,
  ) => Promise<T>;
}

function metadataAttrs(attrs: SyncSpanAttributes): Attributes {
  const out: Attributes = {
    "sutra.subject_id": attrs.subjectId,
    "sutra.device_id": attrs.deviceId,
    "sutra.sync_attempt_id": attrs.syncAttemptId,
  };
  if (attrs.connectivity !== undefined) {
    out["sutra.connectivity"] = attrs.connectivity;
  }
  if (attrs.maxAttempts !== undefined) {
    out["sutra.max_attempts"] = attrs.maxAttempts;
  }
  return out;
}

function applyTerminal(root: Span, terminal: SyncTerminalRecord): void {
  root.setAttribute("sutra.outcome", terminal.outcome);
  root.setAttribute("sutra.retry_count", Math.max(0, terminal.attempts - 1));
  root.setAttribute("sutra.attempt", terminal.attempts);

  if (terminal.quarantineCode !== undefined) {
    root.setAttribute(
      "sutra.quarantine_code",
      terminal.quarantineCode.slice(0, 64),
    );
  }
  if (
    terminal.httpStatus !== undefined &&
    Number.isFinite(terminal.httpStatus)
  ) {
    root.setAttribute("sutra.http_status", terminal.httpStatus);
  }
  if (terminal.exhaustedCode !== undefined) {
    root.setAttribute(
      "sutra.exhausted_code",
      terminal.exhaustedCode.slice(0, 64),
    );
  }

  root.setStatus({ code: SpanStatusCode.OK });
}

function createPassThroughSyncInstrumentation(): SyncInstrumentation {
  return {
    async withSync(_attrs, fn) {
      return fn({
        async runAttempt(_attempt, stageFn) {
          return stageFn();
        },
        recordBackoff() {},
        setConnectivity() {},
        recordAdvisories() {},
        complete() {},
      });
    },
  };
}

/**
 * Build sync series instrumentation. When `obs` is null/undefined, no spans.
 */
export function createSyncInstrumentation(
  obs?: ObservabilityHandle | null,
): SyncInstrumentation {
  if (!obs) return createPassThroughSyncInstrumentation();

  const tracer = obs.tracer;

  return {
    async withSync(attrs, fn) {
      if (!attrs.subjectId?.trim() || !attrs.deviceId?.trim()) {
        return fn({
          async runAttempt(_a, stageFn) {
            return stageFn();
          },
          recordBackoff() {},
          setConnectivity() {},
          recordAdvisories() {},
          complete() {},
        });
      }

      const parentCtx = context.active();
      const root = tracer.startSpan(
        "sutra.sync",
        { attributes: metadataAttrs(attrs) },
        parentCtx,
      );
      const rootCtx = trace.setSpan(parentCtx, root);
      let connectivity: SyncConnectivity | undefined = attrs.connectivity;
      let completed = false;

      try {
        return await context.with(rootCtx, () =>
          fn({
            async runAttempt(attempt, stageFn) {
              const childAttrs: Attributes = {
                ...metadataAttrs(attrs),
                "sutra.attempt": attempt,
              };
              if (connectivity !== undefined) {
                childAttrs["sutra.connectivity"] = connectivity;
              }
              const child = tracer.startSpan(
                "sutra.sync.attempt",
                { attributes: childAttrs },
                rootCtx,
              );
              try {
                return await context.with(
                  trace.setSpan(rootCtx, child),
                  stageFn,
                );
              } catch (err) {
                child.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: "sync_attempt_failed",
                });
                throw err;
              } finally {
                child.end();
              }
            },
            recordBackoff(delayMs, afterAttempt) {
              const bounded = Math.max(
                0,
                Math.min(Math.floor(delayMs), 600_000),
              );
              root.addEvent("sutra.sync.backoff", {
                "sutra.backoff_ms": bounded,
                "sutra.attempt": afterAttempt,
                "sutra.subject_id": attrs.subjectId,
                "sutra.device_id": attrs.deviceId,
              });
            },
            setConnectivity(value) {
              connectivity = value;
              root.setAttribute("sutra.connectivity", value);
            },
            recordAdvisories(advisories) {
              recordSyncAdvisoryEvents(root, attrs, advisories);
            },
            complete(terminal) {
              applyTerminal(root, terminal);
              if (connectivity !== undefined) {
                root.setAttribute("sutra.connectivity", connectivity);
              }
              completed = true;
            },
          }),
        );
      } catch (err) {
        if (!completed) {
          root.setStatus({
            code: SpanStatusCode.ERROR,
            message: "sync_series_failed",
          });
        }
        throw err;
      } finally {
        root.end();
      }
    },
  };
}

/**
 * Cloud / server: continue the remote sync trace extracted from wire headers,
 * run `fn` under `sutra.sync.remote` child (before CRDT merge). Pass-through
 * when observability is absent. Never throws on malformed headers.
 */
export async function withContinuedSyncSpan<T>(
  headers: Record<string, string | string[] | undefined> | null | undefined,
  attrs: SyncSpanAttributes,
  fn: () => Promise<T>,
  obs?: ObservabilityHandle | null,
): Promise<T> {
  const handle = obs === undefined ? getObservability() : obs;
  if (!handle || !attrs.subjectId?.trim()) {
    return fn();
  }
  const remoteCtx = extractSyncWireContext(headers, context.active());
  const span = handle.tracer.startSpan(
    "sutra.sync.remote",
    { attributes: metadataAttrs(attrs) },
    remoteCtx,
  );
  try {
    return await context.with(trace.setSpan(remoteCtx, span), fn);
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: "sync_remote_failed",
    });
    throw err;
  } finally {
    span.setAttribute("sutra.outcome", "ok");
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }
}

/**
 * Default instrumentation: uses the process-wide ObservabilityHandle when
 * hosts called `initObservability()`; otherwise pass-through (zero cost).
 */
export function getDefaultSyncInstrumentation(): SyncInstrumentation {
  return createSyncInstrumentation(getObservability());
}
