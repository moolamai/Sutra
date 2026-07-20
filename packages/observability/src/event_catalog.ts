/**
 * Versioned EventBus catalog — Zod payload schemas .
 *
 * Registry keys match `@moolam/contracts` `CATALOG_EVENT_TYPES`. Payloads are
 * strict allow-lists: ids, codes, durations, hashes, folded friction
 * summaries. Never utterance / reply / advisory detail / keystroke streams.
 *
 * Worked examples: {@link CATALOG_WORKED_EXAMPLES}.
 * Validating publish wrapper: {@link createValidatingEventBus} .
 * JSON Schema export map: {@link EVENT_SCHEMA_EXPORT_MAP}
 * consumed by `@moolam/sync-protocol` `schemas:export`.
 * Implementor reference: {@link EVENT_CATALOG_DOC_RELPATH} .
 */

import { z } from "zod";
import {
  CATALOG_EVENT_TYPES,
  CATALOG_STAGE_OUTCOMES,
  CATALOG_SYNC_ADVISORY_CODES,
  CATALOG_SYNC_OUTCOMES,
  CATALOG_TOOL_STATUSES,
  CATALOG_TURN_STAGES,
  EVENT_SCHEMA_TYPE_NAMES,
  CatalogContractError,
  type CatalogEventType,
  type CatalogPayloadByType,
  type EventBusInterface,
  type EventBusValidationMode,
  type EventPublishValidator,
  type EventSchemaTypeName,
  type RuntimeEvent,
} from "@moolam/contracts";
import {
  InProcessEventBus,
  ValidatingEventBus,
} from "@moolam/runtime";

/** Semver of this catalog document — bump MINOR for additive event types. */
export const EVENT_CATALOG_VERSION = "1.3.0" as const;

/**
 * Implementor reference (triggers, payloads, privacy, worked examples).
 * Linked from `@moolam/runtime` README .
 */
export const EVENT_CATALOG_DOC_RELPATH = "docs/event-catalog.md" as const;

export {
  CATALOG_EVENT_TYPES,
  CATALOG_TURN_STAGES,
  CATALOG_SYNC_OUTCOMES,
  CATALOG_SYNC_ADVISORY_CODES,
  CATALOG_STAGE_OUTCOMES,
  CATALOG_TOOL_STATUSES,
  EVENT_SCHEMA_TYPE_NAMES,
};
export type { CatalogEventType, CatalogPayloadByType, EventSchemaTypeName };

/** ISO-8601 (with optional fractional seconds / Z or offset) or wire HLC. */
export const eventAtSchema = z.union([
  z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
      "malformed ISO-8601 timestamp",
    ),
  z
    .string()
    .regex(/^\d{15}:\d{6}:[A-Za-z0-9_-]{4,64}$/, "malformed HLC timestamp"),
]);

const idSchema = z.string().min(1).max(128);
const opCodeSchema = z.string().min(1).max(64);
const hashSchema = z.string().min(8).max(128);
const durationMsSchema = z.number().finite().nonnegative().max(3_600_000);

export const turnStageStartPayloadSchema = z
  .object({
    subjectId: idSchema,
    sessionId: idSchema,
    deviceId: idSchema.optional(),
    stage: z.enum(CATALOG_TURN_STAGES),
    opCode: opCodeSchema,
  })
  .strict();

export const turnStageEndPayloadSchema = z
  .object({
    subjectId: idSchema,
    sessionId: idSchema,
    deviceId: idSchema.optional(),
    stage: z.enum(CATALOG_TURN_STAGES),
    opCode: opCodeSchema,
    outcome: z.enum(CATALOG_STAGE_OUTCOMES),
    durationMs: durationMsSchema.optional(),
  })
  .strict();

/**
 * Folded FrictionSample summary — raw per-keystroke / utterance events are
 * intentionally absent from the catalog and must never be published.
 */
export const turnFrictionSummaryPayloadSchema = z
  .object({
    subjectId: idSchema,
    sessionId: idSchema,
    deviceId: idSchema.optional(),
    conceptId: idSchema,
    sampleCount: z.number().int().positive().max(10_000),
    hesitationMsP95: z.number().finite().nonnegative().max(3_600_000).optional(),
    assistanceRequestedCount: z.number().int().nonnegative().max(10_000).optional(),
  })
  .strict();

/** End-of-turn metadata — never utterance / reply bodies. */
export const turnCompletedPayloadSchema = z
  .object({
    subjectId: idSchema,
    sessionId: idSchema.optional(),
    deviceId: idSchema.optional(),
    conceptId: idSchema,
    latencyMs: durationMsSchema,
    servedLocally: z.boolean(),
    turnIdHash: hashSchema,
  })
  .strict();

export const syncOutcomePayloadSchema = z
  .object({
    subjectId: idSchema,
    deviceId: idSchema,
    sessionId: idSchema.optional(),
    syncAttemptId: idSchema,
    outcome: z.enum(CATALOG_SYNC_OUTCOMES),
    // 0 allowed for skipped-offline / refuse-before-attempt; positive on real tries.
    attempts: z.number().int().nonnegative().max(10_000),
    durationMs: durationMsSchema.optional(),
    quarantineCode: opCodeSchema.optional(),
    exhaustedCode: opCodeSchema.optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    advisoryCodes: z
      .array(z.enum(CATALOG_SYNC_ADVISORY_CODES))
      .max(32)
      .optional(),
  })
  .strict();

export const syncAdvisoryPayloadSchema = z
  .object({
    subjectId: idSchema,
    deviceId: idSchema,
    sessionId: idSchema.optional(),
    syncAttemptId: idSchema,
    advisoryCode: z.enum(CATALOG_SYNC_ADVISORY_CODES),
    advisoryIndex: z.number().int().nonnegative().max(10_000).optional(),
    hlcTimestamp: z
      .string()
      .regex(/^\d{15}:\d{6}:[A-Za-z0-9_-]{4,64}$/)
      .optional(),
  })
  .strict();

export const toolInvokedPayloadSchema = z
  .object({
    subjectId: idSchema,
    sessionId: idSchema,
    deviceId: idSchema.optional(),
    toolIdHash: hashSchema,
    opCode: opCodeSchema,
  })
  .strict();

export const toolResultPayloadSchema = z
  .object({
    subjectId: idSchema,
    sessionId: idSchema,
    deviceId: idSchema.optional(),
    toolIdHash: hashSchema,
    opCode: opCodeSchema,
    status: z.enum(CATALOG_TOOL_STATUSES),
    durationMs: durationMsSchema.optional(),
  })
  .strict();

/**
 * Subject-scoped MeterEvent on the EventBus — token/latency/locality only.
 * Cached vs fresh input tokens stay separate; never prompt/completion text.
 */
export const harnessMeterPayloadSchema = z
  .object({
    subjectId: idSchema,
    sessionId: idSchema.optional(),
    deviceId: idSchema.optional(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    modelId: idSchema,
    locality: z.enum(["on-device", "self-hosted", "external-api"]),
    aborted: z.boolean(),
  })
  .strict();

export const runtimeSubscriberErrorPayloadSchema = z
  .object({
    sourceType: z.string().min(1).max(128),
    error: z.string().min(1).max(512),
  })
  .strict();

/** Per-type strict Zod schemas — no `z.record(z.unknown())` learner escapes. */
export const EVENT_PAYLOAD_SCHEMAS = Object.freeze({
  "turn.stage.start": turnStageStartPayloadSchema,
  "turn.stage.end": turnStageEndPayloadSchema,
  "turn.friction.summary": turnFrictionSummaryPayloadSchema,
  "turn.completed": turnCompletedPayloadSchema,
  "sync.outcome": syncOutcomePayloadSchema,
  "sync.advisory": syncAdvisoryPayloadSchema,
  "tool.invoked": toolInvokedPayloadSchema,
  "tool.result": toolResultPayloadSchema,
  "harness.meter": harnessMeterPayloadSchema,
  "runtime.subscriber-error": runtimeSubscriberErrorPayloadSchema,
} as const satisfies Record<CatalogEventType, z.ZodTypeAny>);

function catalogEventSchema<T extends CatalogEventType>(
  type: T,
  payloadSchema: z.ZodTypeAny,
) {
  return z
    .object({
      type: z.literal(type),
      at: eventAtSchema,
      payload: payloadSchema,
    })
    .strict();
}

/** Full RuntimeEvent envelopes (type + at + allow-listed payload) for JSON Schema. */
export const eventTurnStageStartSchema = catalogEventSchema(
  "turn.stage.start",
  turnStageStartPayloadSchema,
);
export const eventTurnStageEndSchema = catalogEventSchema(
  "turn.stage.end",
  turnStageEndPayloadSchema,
);
export const eventTurnFrictionSummarySchema = catalogEventSchema(
  "turn.friction.summary",
  turnFrictionSummaryPayloadSchema,
);
export const eventTurnCompletedSchema = catalogEventSchema(
  "turn.completed",
  turnCompletedPayloadSchema,
);
export const eventSyncOutcomeSchema = catalogEventSchema(
  "sync.outcome",
  syncOutcomePayloadSchema,
);
export const eventSyncAdvisorySchema = catalogEventSchema(
  "sync.advisory",
  syncAdvisoryPayloadSchema,
);
export const eventToolInvokedSchema = catalogEventSchema(
  "tool.invoked",
  toolInvokedPayloadSchema,
);
export const eventToolResultSchema = catalogEventSchema(
  "tool.result",
  toolResultPayloadSchema,
);
export const eventHarnessMeterSchema = catalogEventSchema(
  "harness.meter",
  harnessMeterPayloadSchema,
);
export const eventRuntimeSubscriberErrorSchema = catalogEventSchema(
  "runtime.subscriber-error",
  runtimeSubscriberErrorPayloadSchema,
);

/**
 * Barrel export names for `sync-protocol` `schemas:export` .
 * File title → `@moolam/observability` export.
 */
export const EVENT_SCHEMA_EXPORT_MAP = Object.freeze({
  EventTurnStageStart: "eventTurnStageStartSchema",
  EventTurnStageEnd: "eventTurnStageEndSchema",
  EventTurnFrictionSummary: "eventTurnFrictionSummarySchema",
  EventTurnCompleted: "eventTurnCompletedSchema",
  EventSyncOutcome: "eventSyncOutcomeSchema",
  EventSyncAdvisory: "eventSyncAdvisorySchema",
  EventToolInvoked: "eventToolInvokedSchema",
  EventToolResult: "eventToolResultSchema",
  EventHarnessMeter: "eventHarnessMeterSchema",
  EventRuntimeSubscriberError: "eventRuntimeSubscriberErrorSchema",
} as const satisfies Record<EventSchemaTypeName, string>);

/** Dot-namespaced type keyed by JSON Schema title (for metadata on export). */
export const EVENT_SCHEMA_DOT_TYPE = Object.freeze({
  EventTurnStageStart: "turn.stage.start",
  EventTurnStageEnd: "turn.stage.end",
  EventTurnFrictionSummary: "turn.friction.summary",
  EventTurnCompleted: "turn.completed",
  EventSyncOutcome: "sync.outcome",
  EventSyncAdvisory: "sync.advisory",
  EventToolInvoked: "tool.invoked",
  EventToolResult: "tool.result",
  EventHarnessMeter: "harness.meter",
  EventRuntimeSubscriberError: "runtime.subscriber-error",
} as const satisfies Record<EventSchemaTypeName, CatalogEventType>);

/**
 * Loose envelope used only for type gating in parseCatalogEvent — not exported
 * as JSON Schema (payload is intentionally not an allow-list here).
 */
export const catalogEventEnvelopeSchema = z.object({
  type: z.enum(CATALOG_EVENT_TYPES),
  at: eventAtSchema,
  payload: z.record(z.string(), z.unknown()),
});

/** Concrete worked examples — used by tests; safe to copy in host wiring. */
export const CATALOG_WORKED_EXAMPLES = Object.freeze({
  "turn.stage.start": {
    type: "turn.stage.start",
    at: "2026-07-15T10:00:00.000Z",
    payload: {
      subjectId: "anika-k",
      sessionId: "sess-1",
      deviceId: "edge-aaaa",
      stage: "reason",
      opCode: "stage.reason",
    },
  },
  "turn.stage.end": {
    type: "turn.stage.end",
    at: "2026-07-15T10:00:00.042Z",
    payload: {
      subjectId: "anika-k",
      sessionId: "sess-1",
      deviceId: "edge-aaaa",
      stage: "reason",
      opCode: "stage.reason",
      outcome: "ok",
      durationMs: 12.5,
    },
  },
  "turn.friction.summary": {
    type: "turn.friction.summary",
    at: "000001700000000:000001:edge-aaaa",
    payload: {
      subjectId: "anika-k",
      sessionId: "sess-1",
      conceptId: "math.ratios",
      sampleCount: 3,
      hesitationMsP95: 820,
      assistanceRequestedCount: 0,
    },
  },
  "turn.completed": {
    type: "turn.completed",
    at: "2026-07-15T10:00:01.200Z",
    payload: {
      subjectId: "anika-k",
      sessionId: "sess-1",
      deviceId: "edge-aaaa",
      conceptId: "math.ratios",
      latencyMs: 42,
      servedLocally: true,
      turnIdHash: "f1e2d3c4b5a69788",
    },
  },
  "sync.outcome": {
    type: "sync.outcome",
    at: "2026-07-15T10:01:00.000Z",
    payload: {
      subjectId: "anika-k",
      deviceId: "edge-aaaa",
      syncAttemptId: "11111111-1111-4111-8111-111111111111",
      outcome: "converged",
      attempts: 1,
      durationMs: 18,
      advisoryCodes: ["CLOCK_SKEW_CLAMPED"],
    },
  },
  "sync.advisory": {
    type: "sync.advisory",
    at: "2026-07-15T10:01:00.010Z",
    payload: {
      subjectId: "anika-k",
      deviceId: "edge-aaaa",
      syncAttemptId: "11111111-1111-4111-8111-111111111111",
      advisoryCode: "CLOCK_SKEW_CLAMPED",
      advisoryIndex: 0,
      hlcTimestamp: "000001700000000:000002:edge-aaaa",
    },
  },
  "tool.invoked": {
    type: "tool.invoked",
    at: "2026-07-15T10:02:00.000Z",
    payload: {
      subjectId: "anika-k",
      sessionId: "sess-1",
      toolIdHash: "a1b2c3d4e5f67890",
      opCode: "tool.invoked",
    },
  },
  "tool.result": {
    type: "tool.result",
    at: "2026-07-15T10:02:00.030Z",
    payload: {
      subjectId: "anika-k",
      sessionId: "sess-1",
      toolIdHash: "a1b2c3d4e5f67890",
      opCode: "tool.result",
      status: "ok",
      durationMs: 28,
    },
  },
  "harness.meter": {
    type: "harness.meter",
    at: "2026-07-15T10:02:00.040Z",
    payload: {
      subjectId: "anika-k",
      sessionId: "sess-1",
      deviceId: "edge-aaaa",
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: 2,
      latencyMs: 35,
      modelId: "slm-local",
      locality: "on-device",
      aborted: false,
    },
  },
  "runtime.subscriber-error": {
    type: "runtime.subscriber-error",
    at: "2026-07-15T10:03:00.000Z",
    payload: {
      sourceType: "turn.stage.end",
      error: "Error: subscriber boom",
    },
  },
} as const satisfies {
  [K in CatalogEventType]: {
    type: K;
    at: string;
    payload: CatalogPayloadByType[K];
  };
});

/** Keys that must never appear on any catalog payload (sovereignty probes). */
export const FORBIDDEN_CATALOG_PAYLOAD_KEYS = Object.freeze([
  "utterance",
  "reply",
  "detail",
  "text",
  "content",
  "prompt",
  "arguments",
  "frictionLog",
  "mastery",
] as const);

export function isCatalogEventType(type: string): type is CatalogEventType {
  return (CATALOG_EVENT_TYPES as readonly string[]).includes(type);
}

export function getPayloadSchema(
  type: CatalogEventType,
): z.ZodTypeAny {
  return EVENT_PAYLOAD_SCHEMAS[type];
}

/**
 * Validate a catalog envelope + strict payload.
 * Returns `{ ok: true, event }` or `{ ok: false, error }` — never throws.
 */
export function parseCatalogEvent(
  event: unknown,
):
  | { ok: true; event: RuntimeEvent & { type: CatalogEventType } }
  | { ok: false; error: string } {
  const envelope = catalogEventEnvelopeSchema.safeParse(event);
  if (!envelope.success) {
    return { ok: false, error: envelope.error.message };
  }
  const { type, at, payload } = envelope.data;
  for (const key of FORBIDDEN_CATALOG_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return {
        ok: false,
        error: `forbidden payload key '${key}' (metadata-only catalog)`,
      };
    }
  }
  const parsed = EVENT_PAYLOAD_SCHEMAS[type].safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return {
    ok: true,
    event: {
      type,
      at,
      payload: parsed.data as Record<string, unknown>,
    },
  };
}

/**
 * Assert payload conforms for a known type (throws {@link CatalogContractError}).
 */
export function assertCatalogPayload<T extends CatalogEventType>(
  type: T,
  payload: unknown,
): CatalogPayloadByType[T] {
  for (const key of FORBIDDEN_CATALOG_PAYLOAD_KEYS) {
    if (
      payload !== null &&
      typeof payload === "object" &&
      Object.prototype.hasOwnProperty.call(payload, key)
    ) {
      throw new CatalogContractError(
        "catalog.forbidden-key",
        type,
        `forbidden payload key '${key}' (metadata-only catalog)`,
      );
    }
  }
  const result = EVENT_PAYLOAD_SCHEMAS[type].safeParse(payload);
  if (!result.success) {
    throw new CatalogContractError(
      "catalog.payload-schema",
      type,
      result.error.message,
    );
  }
  return result.data as CatalogPayloadByType[T];
}

/**
 * Resolve validation mode: explicit env wins; else production→drop, else throw.
 *
 * - `MOOLAM_EVENT_BUS_VALIDATE=throw|drop`
 * - else `NODE_ENV===production` → `drop`
 * - else `throw` (tests / local hosts)
 */
export function resolvePublishValidationMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): EventBusValidationMode {
  const raw = (env.MOOLAM_EVENT_BUS_VALIDATE ?? "").trim().toLowerCase();
  if (raw === "throw" || raw === "drop") return raw;
  if ((env.NODE_ENV ?? "").toLowerCase() === "production") return "drop";
  return "throw";
}

/**
 * Catalog publish validator for {@link ValidatingEventBus}.
 * Names the violated obligation (`catalog.unknown-type`, `catalog.payload-schema`, …).
 */
export function createCatalogPublishValidator(): EventPublishValidator {
  return (event: RuntimeEvent) => {
    if (!event || typeof event !== "object") {
      return {
        ok: false,
        obligation: "catalog.envelope",
        detail: "event must be an object with type/at/payload",
      };
    }
    if (!isCatalogEventType(event.type)) {
      return {
        ok: false,
        obligation: "catalog.unknown-type",
        detail: `unknown type '${event.type}' — not in CATALOG_EVENT_TYPES`,
      };
    }
    const parsed = parseCatalogEvent(event);
    if (!parsed.ok) {
      const obligation = parsed.error.includes("forbidden payload key")
        ? "catalog.forbidden-key"
        : parsed.error.includes("malformed")
          ? "catalog.at-timestamp"
          : "catalog.payload-schema";
      return { ok: false, obligation, detail: parsed.error };
    }
    return { ok: true, event: parsed.event };
  };
}

export interface CreateValidatingEventBusOptions {
  /** Defaults to a fresh {@link InProcessEventBus}. */
  inner?: EventBusInterface;
  /** Defaults to {@link resolvePublishValidationMode}. */
  mode?: EventBusValidationMode;
  /** Override validator (tests). Defaults to {@link createCatalogPublishValidator}. */
  validate?: EventPublishValidator;
}

/**
 * Wrap an EventBus with catalog schema validation on every external publish.
 *
 * - `throw` mode: invalid → {@link CatalogContractError} (tests / strict hosts)
 * - `drop` mode: invalid → increment `droppedInvalidCount`, never throw (prod)
 */
export function createValidatingEventBus(
  options: CreateValidatingEventBusOptions = {},
): ValidatingEventBus {
  return new ValidatingEventBus(
    options.inner ?? new InProcessEventBus(),
    options.validate ?? createCatalogPublishValidator(),
    options.mode ?? resolvePublishValidationMode(),
  );
}

export { CatalogContractError, ValidatingEventBus };
