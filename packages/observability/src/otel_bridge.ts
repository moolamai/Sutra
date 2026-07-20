/**
 * OpenTelemetry SDK bootstrap for Sutra .
 *
 * Exporter selection via `MOOLAM_OTEL_EXPORTER` = `otlp` | `console` | `noop`
 * (default `noop`). OTLP endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT` when set.
 *
 * Invariants:
 * - Span attributes are metadata only (subjectId / sessionId / deviceId / stage).
 * - Exporter failure drops spans and increments a counter — never blocks the turn path.
 */

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics,
  trace,
  type Meter,
  type Tracer,
  type Span,
  SpanStatusCode,
  context,
  type Context,
  type Attributes,
} from "@opentelemetry/api";
import {
  ExportResultCode,
  type ExportResult,
} from "@opentelemetry/core";
import type { EventBusInterface, RuntimeEvent } from "@moolam/contracts";
import { InProcessEventBus } from "@moolam/runtime";
import { createHash } from "node:crypto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

/** Cognitive turn stages (child spans under a single turn root). */
export const TURN_STAGE_NAMES = Object.freeze([
  "perceive",
  "recall",
  "retrieve",
  "reason",
  "respond",
  "reflect",
] as const);

export type TurnStageName = (typeof TURN_STAGE_NAMES)[number];

/** Metadata-only attribute keys permitted on turn / stage spans. */
export const ALLOWED_TURN_ATTR_KEYS = Object.freeze([
  "sutra.subject_id",
  "sutra.session_id",
  "sutra.device_id",
  "sutra.stage",
  "sutra.outcome",
  "sutra.op_code",
  "sutra.tool_id_hash",
  "sutra.status",
  "sutra.event_type",
  "sutra.duration_ms",
] as const);

/** Bus event types enriched onto active spans ( / ). */
export const TURN_BUS_EVENT_TYPES = Object.freeze([
  "turn.stage.start",
  "turn.stage.end",
  "turn.completed",
  "tool.invoked",
  "tool.result",
] as const);

/** Catalog type for end-of-turn domain events . */
export const TURN_COMPLETED = "turn.completed" as const;

/** Payload keys permitted when mapping bus events → span events (never raw content). */
export const ALLOWED_BUS_PAYLOAD_KEYS = Object.freeze([
  "subjectId",
  "sessionId",
  "deviceId",
  "stage",
  "outcome",
  "opCode",
  "toolIdHash",
  "turnIdHash",
  "conceptId",
  "status",
  "durationMs",
  "latencyMs",
  "servedLocally",
] as const);

/** Bound attrs copied from a single bus event (NFR). */
export const BUS_EVENT_ATTR_LIMIT = 16;

/**
 * Privacy probes for — distinctive fixture substrings / patterns
 * that must never appear in exported span attributes, events, or status text.
 */
export interface PrivacyProbeSet {
  forbiddenSubstrings: readonly string[];
  forbiddenPatterns?: readonly RegExp[];
}

/** One leak location found while scanning exported spans. */
export interface SpanPrivacyLeak {
  spanName: string;
  location: string;
  valuePreview: string;
  matched: string;
}

/**
 * Scan finished spans for raw learner/content probes (attributes, events, status).
 * Used by the golden privacy suite — fails CI when any match is found.
 */
export function findRawContentLeaks(
  spans: readonly ReadableSpan[],
  probes: PrivacyProbeSet,
): SpanPrivacyLeak[] {
  const leaks: SpanPrivacyLeak[] = [];
  const substrings = probes.forbiddenSubstrings.filter((s) => s.length > 0);
  const patterns = probes.forbiddenPatterns ?? [];

  const check = (
    spanName: string,
    location: string,
    value: unknown,
  ): void => {
    if (typeof value !== "string" || value.length === 0) return;
    for (const needle of substrings) {
      if (value.includes(needle)) {
        leaks.push({
          spanName,
          location,
          valuePreview: value.slice(0, 96),
          matched: needle,
        });
      }
    }
    for (const re of patterns) {
      if (re.test(value)) {
        leaks.push({
          spanName,
          location,
          valuePreview: value.slice(0, 96),
          matched: String(re),
        });
      }
    }
  };

  for (const span of spans) {
    const name = span.name;
    for (const [key, val] of Object.entries(span.attributes ?? {})) {
      check(name, `attributes.${key}`, val);
    }
    for (let i = 0; i < (span.events?.length ?? 0); i += 1) {
      const ev = span.events[i]!;
      check(name, `events[${i}].name`, ev.name);
      for (const [key, val] of Object.entries(ev.attributes ?? {})) {
        check(name, `events[${i}].attributes.${key}`, val);
      }
    }
    if (span.status?.message) {
      check(name, "status.message", span.status.message);
    }
  }
  return leaks;
}

/** Assert span export is metadata-only for the given content probes. */
export function assertSpanExportPrivacy(
  spans: readonly ReadableSpan[],
  probes: PrivacyProbeSet,
): void {
  const leaks = findRawContentLeaks(spans, probes);
  if (leaks.length === 0) return;
  const detail = leaks
    .slice(0, 8)
    .map((l) => `${l.spanName}@${l.location}~${l.matched}`)
    .join("; ");
  throw new Error(
    `span privacy violation: ${leaks.length} leak(s) — ${detail}`,
  );
}

/**
 * Assert every attribute / event attribute key is in the turn allow-list
 * (or has the `sutra.` metadata prefix for future bus keys already listed).
 */
export function assertTurnAttrKeysAllowed(
  spans: readonly ReadableSpan[],
  allowed: readonly string[] = ALLOWED_TURN_ATTR_KEYS,
): void {
  const allow = new Set(allowed);
  for (const span of spans) {
    for (const key of Object.keys(span.attributes ?? {})) {
      if (!allow.has(key)) {
        throw new Error(`unexpected span attribute key: ${span.name}.${key}`);
      }
    }
    for (const ev of span.events ?? []) {
      for (const key of Object.keys(ev.attributes ?? {})) {
        if (!allow.has(key)) {
          throw new Error(
            `unexpected event attribute key: ${span.name}/${ev.name}.${key}`,
          );
        }
      }
    }
  }
}

export type ExporterKind = "otlp" | "console" | "noop";

export interface TurnSpanAttributes {
  subjectId: string;
  sessionId: string;
  deviceId?: string;
}

export interface InitObservabilityOptions {
  serviceName?: string;
  serviceVersion?: string;
  /** Override env-resolved exporter. */
  exporter?: ExporterKind;
  otlpEndpoint?: string;
  /** Injected env for tests (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Test hook: capture ReadableSpans without a network exporter.
   * When set, uses SimpleSpanProcessor (still non-blocking for the turn path).
   */
  captureExporter?: SpanExporter;
  /** Enable OTel diag console (tests/debug). Default off. */
  diagDebug?: boolean;
}

export interface ObservabilityHandle {
  tracer: Tracer;
  meter: Meter;
  exporterKind: ExporterKind;
  /** Spans dropped because the underlying exporter failed. */
  getDroppedSpanCount: () => number;
  /**
   * Start a turn root span keyed by subjectId + sessionId (metadata only).
   * Returns the span and an active context with the span set as current.
   */
  startTurnRoot: (
    attrs: TurnSpanAttributes,
  ) => { span: Span; ctx: Context };
  /** Start a named stage child under `parentCtx` (usually the turn root ctx). */
  startStageSpan: (
    stage: TurnStageName,
    attrs: TurnSpanAttributes,
    parentCtx: Context,
  ) => Span;
  /**
   * Record a full perceive→reflect scaffold tree for one turn (tests / hosts).
   * Omits stages listed in `omitStages` (optional bindings — no no-op placeholders).
   */
  recordScaffoldTurnTree: (
    attrs: TurnSpanAttributes,
    options?: { omitStages?: readonly TurnStageName[]; failAt?: TurnStageName },
  ) => void;
  /** Flush pending spans without shutdown (tests / orderly drain). */
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

const INSTRUMENTATION_NAME = "@moolam/observability";
const DROP_COUNTER_NAME = "sutra.otel.spans_dropped";
const EXPORT_BATCH_LIMIT = 512;

let active: ObservabilityHandle | null = null;

export class ObservabilityConfigError extends Error {
  readonly code = "OBSERVABILITY_CONFIG_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "ObservabilityConfigError";
  }
}

/**
 * Resolve exporter from env: MOOLAM_OTEL_EXPORTER ∈ {otlp, console, noop}.
 * Default noop so self-hosters never inherit a network exporter by accident.
 */
export function resolveExporterKind(
  env: NodeJS.ProcessEnv = process.env,
): ExporterKind {
  const raw = (env.MOOLAM_OTEL_EXPORTER ?? "noop").trim().toLowerCase();
  if (raw === "otlp" || raw === "console" || raw === "noop") return raw;
  throw new ObservabilityConfigError(
    `OBSERVABILITY_CONFIG_INVALID: MOOLAM_OTEL_EXPORTER must be otlp|console|noop, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Span exporter that never rejects the processor queue on failure: drops with a
 * callback instead so turn latency is never blocked waiting for export.
 */
export class DropOnFailureSpanExporter implements SpanExporter {
  private dropped = 0;

  constructor(
    private readonly inner: SpanExporter,
    private readonly onDrop?: (delta: number, total: number) => void,
  ) {}

  getDroppedCount(): number {
    return this.dropped;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const bounded = spans.slice(0, EXPORT_BATCH_LIMIT);
    try {
      this.inner.export(bounded, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          this.dropped += bounded.length;
          this.onDrop?.(bounded.length, this.dropped);
          // Acknowledge success so the processor does not retry / back up.
          resultCallback({ code: ExportResultCode.SUCCESS });
          return;
        }
        resultCallback(result);
      });
    } catch {
      this.dropped += bounded.length;
      this.onDrop?.(bounded.length, this.dropped);
      resultCallback({ code: ExportResultCode.SUCCESS });
    }
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown?.();
  }

  async forceFlush(): Promise<void> {
    await this.inner.forceFlush?.();
  }
}

/** No-op exporter — spans are discarded locally with SUCCESS. */
class NoopSpanExporter implements SpanExporter {
  export(
    _spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    resultCallback({ code: ExportResultCode.SUCCESS });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function metadataAttrs(
  attrs: TurnSpanAttributes,
  stage?: TurnStageName,
): Record<string, string> {
  const out: Record<string, string> = {
    "sutra.subject_id": attrs.subjectId,
    "sutra.session_id": attrs.sessionId,
  };
  if (attrs.deviceId !== undefined) {
    out["sutra.device_id"] = attrs.deviceId;
  }
  if (stage !== undefined) {
    out["sutra.stage"] = stage;
  }
  return out;
}

function buildTraceExporter(
  kind: ExporterKind,
  otlpEndpoint: string | undefined,
  capture: SpanExporter | undefined,
): SpanExporter {
  if (capture) return capture;
  if (kind === "console") return new ConsoleSpanExporter();
  if (kind === "otlp") {
    return new OTLPTraceExporter(
      otlpEndpoint ? { url: otlpEndpoint } : undefined,
    );
  }
  return new NoopSpanExporter();
}

/**
 * Bootstrap trace + meter providers. Safe to call once per process; a second
 * call awaits shutdown of the previous handle (idempotent host restart / tests).
 */
export async function initObservability(
  options: InitObservabilityOptions = {},
): Promise<ObservabilityHandle> {
  const env = options.env ?? process.env;
  const exporterKind = options.exporter ?? resolveExporterKind(env);
  const serviceName = options.serviceName ?? env.OTEL_SERVICE_NAME ?? "sutra";
  const serviceVersion = options.serviceVersion ?? "0.1.0";
  const otlpEndpoint =
    options.otlpEndpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? undefined;

  if (options.diagDebug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  if (active) {
    await active.shutdown();
    active = null;
  }

  // Allow hosts/tests to re-init after shutdown — otherwise the global
  // TracerProvider stays the shut-down instance and new spans become no-ops.
  trace.disable();
  metrics.disable();


  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });

  const innerExporter = buildTraceExporter(
    exporterKind,
    otlpEndpoint,
    options.captureExporter,
  );

  let dropCounterAdd: (delta: number) => void = () => {};
  const dropExporter = new DropOnFailureSpanExporter(
    innerExporter,
    (delta, _total) => {
      dropCounterAdd(delta);
    },
  );

  const useSimple =
    Boolean(options.captureExporter) || exporterKind === "console";
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      useSimple
        ? new SimpleSpanProcessor(dropExporter)
        : new BatchSpanProcessor(dropExporter, {
            maxExportBatchSize: EXPORT_BATCH_LIMIT,
            scheduledDelayMillis: 500,
          }),
    ],
  });
  provider.register();

  const meterReaders = [];
  if (exporterKind === "otlp") {
    const metricsUrl = otlpEndpoint
      ? otlpEndpoint.replace(/\/v1\/traces\/?$/, "/v1/metrics")
      : undefined;
    meterReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(
          metricsUrl ? { url: metricsUrl } : undefined,
        ),
        exportIntervalMillis: 60_000,
      }),
    );
  }

  const meterProvider = new MeterProvider({
    resource,
    readers: meterReaders,
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const tracer = provider.getTracer(INSTRUMENTATION_NAME, serviceVersion);
  const meter = meterProvider.getMeter(INSTRUMENTATION_NAME, serviceVersion);
  const dropCounter = meter.createCounter(DROP_COUNTER_NAME, {
    description:
      "Spans dropped because the configured exporter failed (never blocks turn path)",
  });
  dropCounterAdd = (delta) => {
    dropCounter.add(delta, { exporter: exporterKind });
  };

  const handle: ObservabilityHandle = {
    tracer,
    meter,
    exporterKind,
    getDroppedSpanCount: () => dropExporter.getDroppedCount(),
    startTurnRoot(attrs) {
      if (!attrs.subjectId || !attrs.sessionId) {
        throw new ObservabilityConfigError(
          "OBSERVABILITY_CONFIG_INVALID: subjectId and sessionId are required (metadata only)",
        );
      }
      const span = tracer.startSpan("sutra.turn", {
        attributes: metadataAttrs(attrs),
      });
      const ctx = trace.setSpan(context.active(), span);
      return { span, ctx };
    },
    startStageSpan(stage, attrs, parentCtx) {
      return tracer.startSpan(
        `sutra.turn.${stage}`,
        { attributes: metadataAttrs(attrs, stage) },
        parentCtx,
      );
    },
    recordScaffoldTurnTree(attrs, opts = {}) {
      const omit = new Set(opts.omitStages ?? []);
      const { span: root, ctx } = handle.startTurnRoot(attrs);
      let failed = false;
      try {
        for (const stage of TURN_STAGE_NAMES) {
          if (omit.has(stage)) continue;
          const child = handle.startStageSpan(stage, attrs, ctx);
          if (opts.failAt === stage) {
            child.setStatus({
              code: SpanStatusCode.ERROR,
              message: `stage_failed:${stage}`,
            });
            child.end();
            root.setStatus({
              code: SpanStatusCode.ERROR,
              message: `stage_failed:${stage}`,
            });
            failed = true;
            break;
          }
          child.setAttribute("sutra.outcome", "ok");
          child.end();
        }
      } finally {
        if (!failed) {
          root.setAttribute("sutra.outcome", "ok");
        }
        root.end();
      }
    },
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
      await meterProvider.shutdown();
      if (active === handle) active = null;
    },
  };

  active = handle;
  return handle;
}

export function getObservability(): ObservabilityHandle | null {
  return active;
}

export async function shutdownObservability(): Promise<void> {
  if (!active) return;
  await active.shutdown();
}

/** Histogram name for per-stage latency (milliseconds). */
export const STAGE_DURATION_HISTOGRAM = "sutra.turn.stage.duration_ms";

export interface TurnStageRunner {
  /**
   * Run `fn` under a child span named for `stage`. Omitting a stage is simply
   * not calling `run` for it (no no-op placeholder spans).
   */
  run: <T>(stage: TurnStageName, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Wraps one CognitiveCore.turn in a root span and optional stage children.
 * Pass-through when no ObservabilityHandle is available (zero hot-path cost).
 */
export interface TurnInstrumentation {
  withTurn: <T>(
    attrs: TurnSpanAttributes,
    fn: (stages: TurnStageRunner) => Promise<T>,
  ) => Promise<T>;
  /** Detach any EventBus subscription installed by this instrumentation. */
  dispose: () => void;
}

export interface CreateTurnInstrumentationOptions {
  /** When set, stage start/end (and bus→span enrichment) are wired. */
  eventBus?: EventBusInterface;
}

function failureMessage(stage: TurnStageName | "turn", err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : err instanceof Error
        ? err.name
        : "Error";
  // Metadata only — never raw learner content from err.message.
  return `stage_failed:${stage}:${code}`.slice(0, 128);
}

/** Stable short hash for operation / tool identifiers (never payloads). */
export function hashOpCode(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function turnKey(subjectId: string, sessionId: string): string {
  return `${subjectId}\0${sessionId}`;
}

function stageKey(subjectId: string, sessionId: string, stage: string): string {
  return `${subjectId}\0${sessionId}\0${stage}`;
}

/** Active spans for bus enrichment — scoped by subjectId + sessionId. */
const activeTurnRoots = new Map<string, Span>();
const activeStageSpans = new Map<string, Span>();

function registerTurnRoot(attrs: TurnSpanAttributes, span: Span): void {
  activeTurnRoots.set(turnKey(attrs.subjectId, attrs.sessionId), span);
}

function unregisterTurnRoot(attrs: TurnSpanAttributes): void {
  activeTurnRoots.delete(turnKey(attrs.subjectId, attrs.sessionId));
}

function registerStageSpan(
  attrs: TurnSpanAttributes,
  stage: TurnStageName,
  span: Span,
): void {
  activeStageSpans.set(stageKey(attrs.subjectId, attrs.sessionId, stage), span);
}

function unregisterStageSpan(
  attrs: TurnSpanAttributes,
  stage: TurnStageName,
): void {
  activeStageSpans.delete(stageKey(attrs.subjectId, attrs.sessionId, stage));
}

/**
 * Strip bus payload to allow-listed metadata. Foreign keys (utterance, args,
 * content, …) are dropped — operation codes and hashes only.
 */
export function sanitizeBusPayload(
  payload: Record<string, unknown>,
): Attributes {
  const out: Attributes = {};
  let count = 0;
  for (const key of ALLOWED_BUS_PAYLOAD_KEYS) {
    if (count >= BUS_EVENT_ATTR_LIMIT) break;
    if (!(key in payload)) continue;
    const raw = payload[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string") {
      // Refuse long strings that could smuggle content through opCode etc.
      if (raw.length > 64) continue;
      out[`sutra.${camelToSnake(key)}`] = raw;
      count += 1;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      out[`sutra.${camelToSnake(key)}`] = raw;
      count += 1;
    } else if (typeof raw === "boolean") {
      out[`sutra.${camelToSnake(key)}`] = raw;
      count += 1;
    }
  }
  return out;
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isTurnBusEventType(type: string): boolean {
  return (TURN_BUS_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Map runtime bus events onto the active turn/stage span for the same
 * subjectId + sessionId. Subscriber errors must not throw out of the bus.
 */
export function subscribeEventBusToSpans(
  bus: EventBusInterface,
): () => void {
  const unsubs = TURN_BUS_EVENT_TYPES.map((type) =>
    bus.subscribe(type, (event) => {
      try {
        enrichActiveSpanFromBusEvent(event);
      } catch {
        // Isolation: never break the emitter. Distinct silent-drop is forbidden
        // for opaque failures — surface via diag if configured.
        diag.warn(
          `sutra.otel.bus_enrich_failed type=${event.type} (metadata only)`,
        );
      }
    }),
  );
  return () => {
    for (const u of unsubs) u();
  };
}

/**
 * Lifecycle event published by {@link EdgeAgent} after durable initialize
 * . Metadata only — never utterance / reply bodies.
 * Not yet a Zod catalog type; hosts inject {@link createValidatingEventBus}
 * when they want catalog-strict publishes for turn/sync events (002+).
 */
export const EDGE_LIFECYCLE_READY = "edge.lifecycle.ready" as const;

export interface WireEdgeAgentEventBusOptions {
  /** Host-supplied bus; when omitted, a fresh {@link InProcessEventBus}. */
  eventBus?: EventBusInterface;
  /**
   * Subscribe turn/tool bus events onto active OTel spans (default true).
   * Safe when no span is active — enrich is a no-op.
   */
  attachToSpans?: boolean;
}

export interface WiredEdgeAgentEventBus {
  bus: EventBusInterface;
  /** Detach span subscription (idempotent). */
  dispose: () => void;
}

/**
 * Resolve the EventBus for EdgeAgent construction.
 * Defaults to an in-process bus and optionally wires span enrichment.
 */
export function wireEdgeAgentEventBus(
  options: WireEdgeAgentEventBusOptions = {},
): WiredEdgeAgentEventBus {
  const bus = options.eventBus ?? new InProcessEventBus();
  const dispose =
    options.attachToSpans === false
      ? () => {}
      : subscribeEventBusToSpans(bus);
  return { bus, dispose };
}

export function enrichActiveSpanFromBusEvent(event: RuntimeEvent): void {
  if (!isTurnBusEventType(event.type)) return;
  const payload = event.payload ?? {};
  const subjectId =
    typeof payload.subjectId === "string" ? payload.subjectId.trim() : "";
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!subjectId || !sessionId) return;

  const stage =
    typeof payload.stage === "string" ? payload.stage : undefined;
  let span =
    stage !== undefined
      ? activeStageSpans.get(stageKey(subjectId, sessionId, stage))
      : undefined;
  if (!span) {
    const prefix = `${turnKey(subjectId, sessionId)}\0`;
    for (const [key, candidate] of activeStageSpans) {
      if (key.startsWith(prefix)) {
        span = candidate;
        break;
      }
    }
  }
  span = span ?? activeTurnRoots.get(turnKey(subjectId, sessionId));
  if (!span || !span.isRecording()) return;

  const attrs = sanitizeBusPayload(payload);
  attrs["sutra.event_type"] = event.type;
  span.addEvent(event.type, attrs);
}

/**
 * Build stage wrap/run helpers for CognitiveCore construction.
 * When `obs` is null/undefined, stages execute with no spans (hosts that skip init).
 */
export function createTurnInstrumentation(
  obs?: ObservabilityHandle | null,
  options: CreateTurnInstrumentationOptions = {},
): TurnInstrumentation {
  const bus = options.eventBus;
  const unsubscribe = bus ? subscribeEventBusToSpans(bus) : () => {};

  if (!obs) {
    return {
      async withTurn(attrs, fn) {
        return fn({
          async run(stage, stageFn) {
            publishStageBusEvent(bus, "turn.stage.start", attrs, stage);
            try {
              const out = await stageFn();
              publishStageBusEvent(bus, "turn.stage.end", attrs, stage, "ok");
              return out;
            } catch (err) {
              publishStageBusEvent(bus, "turn.stage.end", attrs, stage, "error");
              throw err;
            }
          },
        });
      },
      dispose: unsubscribe,
    };
  }

  const durationMs = obs.meter.createHistogram(STAGE_DURATION_HISTOGRAM, {
    description:
      "CognitiveCore turn stage latency in milliseconds (metadata labels only)",
    unit: "ms",
  });

  return {
    async withTurn(attrs, fn) {
      const { span: root, ctx } = obs.startTurnRoot(attrs);
      registerTurnRoot(attrs, root);
      let failed = false;
      try {
        // Activate turn root so nested work (e.g. SyncEngine) parents under it.
        const result = await context.with(ctx, () =>
          fn({
            async run(stage, stageFn) {
              const child = obs.startStageSpan(stage, attrs, ctx);
              registerStageSpan(attrs, stage, child);
              publishStageBusEvent(bus, "turn.stage.start", attrs, stage);
              const t0 = performance.now();
              try {
                const out = await context.with(
                  trace.setSpan(ctx, child),
                  stageFn,
                );
                child.setAttribute("sutra.outcome", "ok");
                publishStageBusEvent(bus, "turn.stage.end", attrs, stage, "ok");
                return out;
              } catch (err) {
                failed = true;
                child.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: failureMessage(stage, err),
                });
                root.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: failureMessage(stage, err),
                });
                publishStageBusEvent(bus, "turn.stage.end", attrs, stage, "error");
                throw err;
              } finally {
                const elapsed = performance.now() - t0;
                durationMs.record(elapsed, {
                  "sutra.stage": stage,
                  "sutra.subject_id": attrs.subjectId,
                  "sutra.session_id": attrs.sessionId,
                });
                unregisterStageSpan(attrs, stage);
                child.end();
              }
            },
          }),
        );
        if (!failed) {
          root.setAttribute("sutra.outcome", "ok");
        }
        return result;
      } catch (err) {
        if (!failed) {
          root.setStatus({
            code: SpanStatusCode.ERROR,
            message: failureMessage("turn", err),
          });
        }
        throw err;
      } finally {
        unregisterTurnRoot(attrs);
        root.end();
      }
    },
    dispose: unsubscribe,
  };
}

function publishStageBusEvent(
  bus: EventBusInterface | undefined,
  type: "turn.stage.start" | "turn.stage.end",
  attrs: TurnSpanAttributes,
  stage: TurnStageName,
  outcome?: string,
): void {
  if (!bus) return;
  const payload: Record<string, unknown> = {
    subjectId: attrs.subjectId,
    sessionId: attrs.sessionId,
    stage,
    opCode: `stage.${stage}`,
  };
  if (attrs.deviceId !== undefined) payload.deviceId = attrs.deviceId;
  if (outcome !== undefined) payload.outcome = outcome;
  bus.publish({
    type,
    at: new Date().toISOString(),
    payload,
  });
}

/**
 * Publish a metadata-only tool outcome onto the bus (hosts / act-stage).
 * Tool names are hashed — argument bodies are never accepted.
 */
export function publishToolBusEvent(
  bus: EventBusInterface,
  type: "tool.invoked" | "tool.result",
  args: TurnSpanAttributes & {
    toolId: string;
    status?: string;
    durationMs?: number;
  },
): void {
  const payload: Record<string, unknown> = {
    subjectId: args.subjectId,
    sessionId: args.sessionId,
    toolIdHash: hashOpCode(args.toolId),
    opCode: type,
  };
  if (args.deviceId !== undefined) payload.deviceId = args.deviceId;
  if (args.status !== undefined) {
    payload.status = String(args.status).slice(0, 32);
  }
  if (args.durationMs !== undefined && Number.isFinite(args.durationMs)) {
    payload.durationMs = args.durationMs;
  }
  bus.publish({ type, at: new Date().toISOString(), payload });
}

export interface PublishTurnCompletedArgs {
  subjectId: string;
  conceptId: string;
  latencyMs: number;
  servedLocally: boolean;
  /**
   * Opaque turn correlator. Hashed before publish — never put utterance /
   * reply text here.
   */
  turnId: string;
  sessionId?: string;
  deviceId?: string;
}

/**
 * Publish catalog-valid `turn.completed` after a durable
 * on-device reply. Never includes utterance or reply bodies.
 */
export function publishTurnCompleted(
  bus: EventBusInterface,
  args: PublishTurnCompletedArgs,
): void {
  const latencyMs = Number.isFinite(args.latencyMs)
    ? Math.max(0, Math.min(args.latencyMs, 3_600_000))
    : 0;
  const payload: Record<string, unknown> = {
    subjectId: args.subjectId.trim().slice(0, 128),
    conceptId: args.conceptId.trim().slice(0, 128),
    latencyMs,
    servedLocally: Boolean(args.servedLocally),
    turnIdHash: hashOpCode(args.turnId),
  };
  if (args.sessionId !== undefined) {
    payload.sessionId = args.sessionId.trim().slice(0, 128);
  }
  if (args.deviceId !== undefined) {
    payload.deviceId = args.deviceId.trim().slice(0, 128);
  }
  bus.publish({
    type: TURN_COMPLETED,
    at: new Date().toISOString(),
    payload,
  });
}

/** Catalog type for SyncEngine terminal outcomes . */
export const SYNC_OUTCOME = "sync.outcome" as const;

export interface PublishSyncOutcomeArgs {
  subjectId: string;
  deviceId: string;
  syncAttemptId: string;
  outcome:
    | "converged"
    | "quarantined"
    | "exhausted"
    | "skipped-offline";
  attempts: number;
  durationMs?: number;
  quarantineCode?: string;
  exhaustedCode?: string;
  httpStatus?: number;
  sessionId?: string;
  /**
   * SYNC-06 codes only — never advisory detail / CognitiveState.
   * Deduped and bounded inside the publisher.
   */
  advisoryCodes?: readonly string[];
}

const KNOWN_SYNC_OUTCOME_ADVISORY = new Set([
  "CLOCK_SKEW_CLAMPED",
  "DUPLICATE_SAMPLE_DROPPED",
  "UNKNOWN_CONCEPT_QUARANTINED",
  "STATE_VECTOR_REGRESSION",
  "DEPRECATED_FIELD_PRESENT",
]);

/**
 * Publish catalog-valid `sync.outcome` after a SyncEngine
 * terminal state (or permanent offline skip). Never includes merged state.
 */
export function publishSyncOutcome(
  bus: EventBusInterface,
  args: PublishSyncOutcomeArgs,
): void {
  const attempts = Number.isFinite(args.attempts)
    ? Math.max(0, Math.min(Math.trunc(args.attempts), 10_000))
    : 0;
  const advisoryCodes: string[] = [];
  const seen = new Set<string>();
  for (const raw of args.advisoryCodes ?? []) {
    const code = String(raw);
    if (!KNOWN_SYNC_OUTCOME_ADVISORY.has(code) || seen.has(code)) continue;
    seen.add(code);
    advisoryCodes.push(code);
    if (advisoryCodes.length >= 32) break;
  }

  const payload: Record<string, unknown> = {
    subjectId: args.subjectId.trim().slice(0, 128),
    deviceId: args.deviceId.trim().slice(0, 128),
    syncAttemptId: args.syncAttemptId.trim().slice(0, 128),
    outcome: args.outcome,
    attempts,
  };
  if (args.sessionId !== undefined) {
    payload.sessionId = args.sessionId.trim().slice(0, 128);
  }
  if (args.durationMs !== undefined && Number.isFinite(args.durationMs)) {
    payload.durationMs = Math.max(0, Math.min(args.durationMs, 3_600_000));
  }
  if (args.quarantineCode !== undefined) {
    payload.quarantineCode = String(args.quarantineCode).slice(0, 64);
  }
  if (args.exhaustedCode !== undefined) {
    payload.exhaustedCode = String(args.exhaustedCode).slice(0, 64);
  }
  if (
    args.httpStatus !== undefined &&
    Number.isFinite(args.httpStatus)
  ) {
    payload.httpStatus = Math.trunc(args.httpStatus);
  }
  if (advisoryCodes.length > 0) {
    payload.advisoryCodes = advisoryCodes;
  }

  bus.publish({
    type: SYNC_OUTCOME,
    at: new Date().toISOString(),
    payload,
  });
}
