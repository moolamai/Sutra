/**
 * @module runtime
 *
 * Runtime contracts - the execution environment seams shared by edge and
 * cloud. An agent runs the same cognitive loop whether it is hosted in a
 * phone app, a server process, or a test harness; these contracts are what
 * the host must provide. Reference in-process implementations live in
 * `@moolam/runtime`.
 */

/** Lifecycle phases every hosted agent moves through. Transitions are one-way except suspend/resume. */
export type LifecycleState =
  | "created"
  | "initializing"
  | "ready"
  | "running"
  | "suspended"
  | "stopped"
  | "failed";

/**
 * Contract for components that participate in host lifecycle.
 *
 * Contract requirements:
 *  1. `initialize` MUST be idempotent; hosts may call it defensively.
 *  2. `dispose` MUST flush durable state before resolving; a disposed
 *     component that lost acknowledged writes is a contract violation.
 */
export interface LifecycleAware {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}

/** One unit of deferred work owned by the runtime scheduler. */
export interface ScheduledTask {
  taskId: string;
  name: string;
  /** Epoch ms at which the task becomes eligible to run. */
  runAtMs: number;
  /** Hard wall-clock budget once started; the scheduler MUST abandon on breach. */
  deadlineMs: number;
  execute(): Promise<void>;
}

/**
 * Task scheduling contract.
 *
 * Contract requirements:
 *  1. Tasks with equal `runAtMs` execute in submission order (stable).
 *  2. A failed task MUST NOT prevent later tasks from running.
 *  3. `cancel` on a running task is a no-op returning false.
 */
export interface SchedulerInterface {
  schedule(task: ScheduledTask): void;
  cancel(taskId: string): boolean;
  pendingCount(): number;
}

/**
 * Versioned EventBus catalog types .
 *
 * Zod payload schemas live in `@moolam/observability` (`event_catalog.ts`).
 * Contracts carry the registry keys + TypeScript payload shapes only — this
 * package stays dependency-free.
 *
 * Implementor reference (triggers, privacy, worked examples):
 * `packages/observability/docs/event-catalog.md`, linked from
 * `packages/runtime/README.md`.
 *
 * Privacy rule: payloads are metadata allow-lists (ids, codes, durations,
 * hashes, folded friction summaries). Raw learner/user content never appears.
 */
export const CATALOG_EVENT_TYPES = Object.freeze([
  "turn.stage.start",
  "turn.stage.end",
  "turn.friction.summary",
  "turn.completed",
  "sync.outcome",
  "sync.advisory",
  "tool.invoked",
  "tool.result",
  "harness.meter",
  "runtime.subscriber-error",
] as const);

export type CatalogEventType = (typeof CATALOG_EVENT_TYPES)[number];

/**
 * PascalCase JSON Schema titles written by the sync-protocol schema exporter
 * . Files land as `schemas/<Name>.json`.
 */
export const EVENT_SCHEMA_TYPE_NAMES = Object.freeze([
  "EventTurnStageStart",
  "EventTurnStageEnd",
  "EventTurnFrictionSummary",
  "EventTurnCompleted",
  "EventSyncOutcome",
  "EventSyncAdvisory",
  "EventToolInvoked",
  "EventToolResult",
  "EventHarnessMeter",
  "EventRuntimeSubscriberError",
] as const);

export type EventSchemaTypeName = (typeof EVENT_SCHEMA_TYPE_NAMES)[number];

/** Cognitive turn stages mirrored by `turn.stage.*` events. */
export const CATALOG_TURN_STAGES = Object.freeze([
  "perceive",
  "recall",
  "retrieve",
  "reason",
  "respond",
  "reflect",
] as const);

export type CatalogTurnStage = (typeof CATALOG_TURN_STAGES)[number];

export const CATALOG_SYNC_OUTCOMES = Object.freeze([
  "converged",
  "quarantined",
  "exhausted",
  "skipped-offline",
] as const);

export type CatalogSyncOutcome = (typeof CATALOG_SYNC_OUTCOMES)[number];

export const CATALOG_SYNC_ADVISORY_CODES = Object.freeze([
  "CLOCK_SKEW_CLAMPED",
  "DUPLICATE_SAMPLE_DROPPED",
  "UNKNOWN_CONCEPT_QUARANTINED",
  "STATE_VECTOR_REGRESSION",
  "DEPRECATED_FIELD_PRESENT",
] as const);

export type CatalogSyncAdvisoryCode = (typeof CATALOG_SYNC_ADVISORY_CODES)[number];

export const CATALOG_STAGE_OUTCOMES = Object.freeze(["ok", "error"] as const);
export type CatalogStageOutcome = (typeof CATALOG_STAGE_OUTCOMES)[number];

export const CATALOG_TOOL_STATUSES = Object.freeze([
  "ok",
  "error",
  "timeout",
  "denied",
] as const);
export type CatalogToolStatus = (typeof CATALOG_TOOL_STATUSES)[number];

/** Shared subject-scope fields on catalog payloads. */
export interface CatalogSubjectScope {
  subjectId: string;
  sessionId?: string;
  deviceId?: string;
}

export interface TurnStageStartPayload extends CatalogSubjectScope {
  sessionId: string;
  stage: CatalogTurnStage;
  opCode: string;
}

export interface TurnStageEndPayload extends TurnStageStartPayload {
  outcome: CatalogStageOutcome;
  durationMs?: number;
}

/**
 * Folded FrictionSample summary — high-frequency raw input events never
 * cross the bus; only this compact metadata form is cataloged.
 */
export interface TurnFrictionSummaryPayload extends CatalogSubjectScope {
  sessionId: string;
  /** Concept id (metadata) — never utterance / keystroke streams. */
  conceptId: string;
  sampleCount: number;
  hesitationMsP95?: number;
  assistanceRequestedCount?: number;
}

/**
 * End-of-turn domain event . Metadata only — never
 * utterance or reply text. `turnIdHash` is a short hash of an opaque turn id.
 */
export interface TurnCompletedPayload extends CatalogSubjectScope {
  conceptId: string;
  latencyMs: number;
  servedLocally: boolean;
  turnIdHash: string;
}

export interface SyncOutcomePayload extends CatalogSubjectScope {
  deviceId: string;
  syncAttemptId: string;
  outcome: CatalogSyncOutcome;
  attempts: number;
  durationMs?: number;
  quarantineCode?: string;
  exhaustedCode?: string;
  httpStatus?: number;
  /**
   * SYNC-06 advisory codes observed during the terminal sync (codes only —
   * never advisory detail text). Bounded list.
   */
  advisoryCodes?: CatalogSyncAdvisoryCode[];
}

export interface SyncAdvisoryPayload extends CatalogSubjectScope {
  deviceId: string;
  syncAttemptId: string;
  advisoryCode: CatalogSyncAdvisoryCode;
  advisoryIndex?: number;
  /** HLC lifted from advisory detail when present — never the detail text. */
  hlcTimestamp?: string;
}

export interface ToolInvokedPayload extends CatalogSubjectScope {
  sessionId: string;
  toolIdHash: string;
  opCode: string;
}

export interface ToolResultPayload extends ToolInvokedPayload {
  status: CatalogToolStatus;
  durationMs?: number;
}

/**
 * Per-turn metering snapshot on the EventBus spine (`harness.meter`).
 * Mirrors sync-protocol `MeterEvent` token fields; subject-scoped.
 * Metadata only — never prompt or completion text. Cached vs fresh
 * input tokens remain separate fields.
 */
export interface HarnessMeterPayload extends CatalogSubjectScope {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  latencyMs: number;
  modelId: string;
  locality: "on-device" | "self-hosted" | "external-api";
  aborted: boolean;
}

/** Bus-internal isolation event (InProcessEventBus.SUBSCRIBER_ERROR). */
export interface RuntimeSubscriberErrorPayload {
  sourceType: string;
  error: string;
}

export type CatalogPayloadByType = {
  "turn.stage.start": TurnStageStartPayload;
  "turn.stage.end": TurnStageEndPayload;
  "turn.friction.summary": TurnFrictionSummaryPayload;
  "turn.completed": TurnCompletedPayload;
  "sync.outcome": SyncOutcomePayload;
  "sync.advisory": SyncAdvisoryPayload;
  "tool.invoked": ToolInvokedPayload;
  "tool.result": ToolResultPayload;
  "harness.meter": HarnessMeterPayload;
  "runtime.subscriber-error": RuntimeSubscriberErrorPayload;
};

/** A typed runtime event. `type` is a dot-namespaced key, e.g. "sync.outcome". */
export interface RuntimeEvent {
  type: string;
  /** ISO-8601 or HLC string; must be totally ordered per emitter. */
  at: string;
  /**
   * Metadata bag. Cataloged types MUST conform to {@link CatalogPayloadByType};
   * Zod enforcement is in `@moolam/observability` / .
   */
  payload: Record<string, unknown>;
}

/**
 * Publish validation policy .
 *
 * - `throw` — tests / strict hosts: invalid publish raises {@link CatalogContractError}
 * - `drop` — production: invalid publish is dropped and counted (never throws)
 */
export type EventBusValidationMode = "throw" | "drop";

/** Outcome of a catalog publish check before delivery. */
export type EventPublishValidation =
  | { ok: true; event: RuntimeEvent }
  | { ok: false; obligation: string; detail: string };

/**
 * Pure validator injected into {@link EventBusInterface} wrappers.
 * Implementations live beside Zod schemas (`@moolam/observability`).
 */
export type EventPublishValidator = (
  event: RuntimeEvent,
) => EventPublishValidation;

/**
 * Typed contract failure when a publish violates the event catalog.
 * Obligation names the violated rule (e.g. `catalog.unknown-type`).
 */
export class CatalogContractError extends Error {
  override readonly name = "CatalogContractError";
  readonly obligation: string;
  readonly eventType: string;

  constructor(obligation: string, eventType: string, detail?: string) {
    super(
      detail
        ? `CatalogContractError: ${obligation} type=${eventType} — ${detail}`
        : `CatalogContractError: ${obligation} type=${eventType}`,
    );
    this.obligation = obligation;
    this.eventType = eventType;
  }
}

/**
 * Event handling contract - how runtime components observe each other
 * without direct coupling (telemetry observes sync, hosts observe both).
 *
 * Contract requirements:
 *  1. `publish` MUST NOT throw because a subscriber threw; subscriber
 *     errors are isolated and reported through the bus's own error event
 *     (`runtime.subscriber-error`).
 *  2. Delivery is at-least-once, in-process, synchronous by default.
 * 3. Catalog-validating wrappers MAY reject unknown types
 *     invalid payloads before delivery; rejection MUST NOT break isolation
 *     rule (1) for already-accepted events.
 */
export interface EventBusInterface {
  publish(event: RuntimeEvent): void;
  /** Subscribe to an event type (or "*" for all). Returns an unsubscribe function. */
  subscribe(type: string, handler: (event: RuntimeEvent) => void): () => void;
}

/**
 * Optional metrics surface on validating buses (drop mode).
 * Implementations expose a bounded counter — never a payload dump.
 */
export interface ValidatingEventBusInterface extends EventBusInterface {
  readonly validationMode: EventBusValidationMode;
  /** Invalid publishes dropped when `validationMode === "drop"`. */
  readonly droppedInvalidCount: number;
}

/**
 * Narrow durable-storage seam shared by edge components (vector memory,
 * telemetry log). Adapters bind SQLite flavors per platform: expo-sqlite
 * (mobile), better-sqlite3 (desktop/CI), wa-sqlite/OPFS (web).
 *
 * Contract requirements:
 *  1. `execute` MUST be durable before resolving (write-ahead discipline).
 *  2. Drivers MUST be safe for interleaved async calls from one process.
 */
export interface StorageDriver {
  execute(sql: string, params?: unknown[]): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
