/**
 * Degradation registry wire/schema contract.
 *
 * Named modes (`STALE_READ`, `HARD_STOP_WRITE`, `QUEUE_AND_WARN`) with
 * per-mode behavior specs and a read-only `lookup(surface, operation)` API.
 * Canonical interface: `@moolam/contracts` `DegradationRegistry`.
 *
 * Registry documents ship with the SDK — never mutated per tenant.
 * Metadata only: no learner content on signals or markers.
 */

import { z } from "zod";
import {
  DEGRADATION_MODES,
  DEGRADATION_OPERATIONS,
  DEGRADATION_SURFACES,
  type DegradationBehaviorSpec,
  type DegradationMode,
  type DegradationOperation,
  type DegradationSurface,
} from "@moolam/contracts";
import {
  freshnessMarkerSchema,
  type FreshnessMarker,
} from "./contract.js";

export const degradationModeSchema = z.enum(DEGRADATION_MODES);
export const degradationSurfaceSchema = z.enum(DEGRADATION_SURFACES);
export const degradationOperationSchema = z.enum(DEGRADATION_OPERATIONS);

/**
 * Marker attached to stale reads — proves data is last-known-good, not
 * fabricated. Timestamps are opaque strings (ISO or HLC); never utterance bodies.
 * Canonical type/schema: `FreshnessMarker` / `freshnessMarkerSchema` in contract.ts.
 */

export const degradationBehaviorSpecSchema = z
  .object({
    mode: degradationModeSchema,
    description: z.string().min(1).max(512),
    allowsFabrication: z.literal(false),
    allowsSilentWriteRetry: z.literal(false),
    readPolicy: z.enum(["fresh", "stale-with-marker", "unavailable"]),
    writePolicy: z.enum(["proceed", "hard-stop-rollback", "queue-and-warn"]),
    requiresFreshnessMarker: z.boolean(),
    signalCode: z.string().min(1).max(64),
  })
  .strict() satisfies z.ZodType<DegradationBehaviorSpec>;

export type DegradationBinding = {
  surface: DegradationSurface;
  operation: DegradationOperation;
  mode: DegradationMode;
};

export const degradationBindingSchema = z
  .object({
    surface: degradationSurfaceSchema,
    operation: degradationOperationSchema,
    mode: degradationModeSchema,
  })
  .strict() satisfies z.ZodType<DegradationBinding>;

/**
 * Full registry document — mode specs + surface/operation bindings.
 * Bounded entry count (hot-path / NFR).
 */
export type DegradationRegistryDocument = {
  version: string;
  modes: Record<DegradationMode, DegradationBehaviorSpec>;
  bindings: DegradationBinding[];
};

/**
 * Wire / JSON Schema export shape (ZodObject — no Effects).
 * Extra invariants (mode-key match) live on {@link degradationRegistryDocumentSchema}.
 */
export const degradationRegistrySchema = z
  .object({
    version: z.string().min(1).max(32),
    modes: z.object({
      STALE_READ: degradationBehaviorSpecSchema,
      HARD_STOP_WRITE: degradationBehaviorSpecSchema,
      QUEUE_AND_WARN: degradationBehaviorSpecSchema,
    }),
    bindings: z.array(degradationBindingSchema).min(1).max(64),
  })
  .strict() satisfies z.ZodType<DegradationRegistryDocument>;

/** Runtime validator — includes mode-key / binding integrity checks. */
export const degradationRegistryDocumentSchema =
  degradationRegistrySchema.superRefine((doc, ctx) => {
    for (const mode of DEGRADATION_MODES) {
      const spec = doc.modes[mode];
      if (spec.mode !== mode) {
        ctx.addIssue({
          code: "custom",
          path: ["modes", mode, "mode"],
          message: `mode key '${mode}' must carry matching behavior.mode`,
        });
      }
    }
    for (const [i, binding] of doc.bindings.entries()) {
      if (!(binding.mode in doc.modes)) {
        ctx.addIssue({
          code: "custom",
          path: ["bindings", i, "mode"],
          message: `binding references unknown mode '${binding.mode}'`,
        });
      }
    }
  });

/** SDK-shipped default bindings — not tenant-mutable. */
export const DEFAULT_DEGRADATION_REGISTRY: DegradationRegistryDocument = {
  version: "1.0.0",
  modes: {
    STALE_READ: {
      mode: "STALE_READ",
      description:
        "Serve last-known-good read with freshnessMarker; never fabricate data",
      allowsFabrication: false,
      allowsSilentWriteRetry: false,
      readPolicy: "stale-with-marker",
      writePolicy: "hard-stop-rollback",
      requiresFreshnessMarker: true,
      signalCode: "DEGRADE_STALE_READ",
    },
    HARD_STOP_WRITE: {
      mode: "HARD_STOP_WRITE",
      description:
        "Hard-stop writes with rollback; silent write retry is forbidden",
      allowsFabrication: false,
      allowsSilentWriteRetry: false,
      readPolicy: "unavailable",
      writePolicy: "hard-stop-rollback",
      requiresFreshnessMarker: false,
      signalCode: "DEGRADE_HARD_STOP_WRITE",
    },
    QUEUE_AND_WARN: {
      mode: "QUEUE_AND_WARN",
      description:
        "Queue the request and emit a warning signal; never silent catch-and-continue",
      allowsFabrication: false,
      allowsSilentWriteRetry: false,
      readPolicy: "unavailable",
      writePolicy: "queue-and-warn",
      requiresFreshnessMarker: false,
      signalCode: "DEGRADE_QUEUE_AND_WARN",
    },
  },
  bindings: [
    { surface: "storage", operation: "read", mode: "STALE_READ" },
    { surface: "storage", operation: "write", mode: "HARD_STOP_WRITE" },
    { surface: "sync", operation: "read", mode: "STALE_READ" },
    { surface: "sync", operation: "write", mode: "HARD_STOP_WRITE" },
    { surface: "model", operation: "read", mode: "QUEUE_AND_WARN" },
    { surface: "model", operation: "write", mode: "HARD_STOP_WRITE" },
  ],
};

export type DegradationLookupAccepted = {
  outcome: "accepted";
  subjectId: string;
  deviceId?: string;
  surface: DegradationSurface;
  operation: DegradationOperation;
  behavior: DegradationBehaviorSpec;
};

export type DegradationLookupRejected = {
  outcome: "rejected";
  subjectId: string | null;
  deviceId?: string;
  failureClass: "missing_subject" | "unknown_binding" | "schema_violation";
  issuePath: string;
  surface?: DegradationSurface;
  operation?: DegradationOperation;
};

export type DegradationLookupResult =
  | DegradationLookupAccepted
  | DegradationLookupRejected;

export type DegradationRegistryHandle = {
  /** Read-only document — freeze semantics for callers. */
  readonly document: DegradationRegistryDocument;
  lookup(
    surface: DegradationSurface,
    operation: DegradationOperation,
    opts: { subjectId: string; deviceId?: string },
  ): DegradationLookupResult;
};

/**
 * Build a read-only registry handle from a validated document.
 * `lookup` requires subjectId for telemetry scoping; the registry itself
 * is not per-tenant (bindings are SDK-global).
 */
export function createDegradationRegistry(
  input: unknown = DEFAULT_DEGRADATION_REGISTRY,
): DegradationRegistryHandle {
  const parsed = degradationRegistryDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError(
      `DegradationRegistry schema_violation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const document = Object.freeze({
    version: parsed.data.version,
    modes: Object.freeze({ ...parsed.data.modes }),
    bindings: Object.freeze(parsed.data.bindings.map((b) => Object.freeze({ ...b }))),
  }) as DegradationRegistryDocument;

  const index = new Map<string, DegradationMode>();
  for (const b of document.bindings) {
    index.set(`${b.surface}:${b.operation}`, b.mode);
  }

  return {
    document,
    lookup(surface, operation, opts) {
      const subjectId = opts.subjectId;
      const deviceId = opts.deviceId;
      if (typeof subjectId !== "string" || subjectId.length === 0) {
        return {
          outcome: "rejected",
          subjectId: null,
          ...(deviceId !== undefined ? { deviceId } : {}),
          failureClass: "missing_subject",
          issuePath: "subjectId",
          surface,
          operation,
        };
      }

      const mode = index.get(`${surface}:${operation}`);
      if (!mode) {
        return {
          outcome: "rejected",
          subjectId,
          ...(deviceId !== undefined ? { deviceId } : {}),
          failureClass: "unknown_binding",
          issuePath: "bindings",
          surface,
          operation,
        };
      }

      const behavior = document.modes[mode];
      return {
        outcome: "accepted",
        subjectId,
        ...(deviceId !== undefined ? { deviceId } : {}),
        surface,
        operation,
        behavior,
      };
    },
  };
}

/**
 * Assert a stale-read payload carries a freshness marker and no fabrication flags.
 * Used by adapters/tests when the looked-up mode is STALE_READ.
 */
export function assertStaleReadPayload(
  value: unknown,
  opts: { subjectId: string },
):
  | { ok: true; marker: FreshnessMarker; subjectId: string }
  | { ok: false; failureClass: string; subjectId: string } {
  if (typeof opts.subjectId !== "string" || opts.subjectId.length === 0) {
    return { ok: false, failureClass: "missing_subject", subjectId: "" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      failureClass: "schema_violation",
      subjectId: opts.subjectId,
    };
  }
  const record = value as Record<string, unknown>;
  if (record.fabricated === true) {
    return {
      ok: false,
      failureClass: "fabrication_forbidden",
      subjectId: opts.subjectId,
    };
  }
  const marker = freshnessMarkerSchema.safeParse(record.freshnessMarker);
  if (!marker.success) {
    return {
      ok: false,
      failureClass: "missing_freshness_marker",
      subjectId: opts.subjectId,
    };
  }
  return { ok: true, marker: marker.data, subjectId: opts.subjectId };
}

/* ────────────────────────────────────────────────────────────────────────
 * Stubbed-down dependency test vectors (B4 integration harness)
 * ──────────────────────────────────────────────────────────────────────── */

/** Closed set of forced-failure kinds for stubbed-down dependency tests. */
export const DEGRADATION_FORCED_FAILURE_KINDS = Object.freeze([
  "dependency_unavailable",
  "timeout",
  "corrupt_response",
  "partial_failure",
] as const);

export type DegradationForcedFailureKind =
  (typeof DEGRADATION_FORCED_FAILURE_KINDS)[number];

export type DegradationForcedFailure = {
  kind: DegradationForcedFailureKind;
  /** Opaque dependency id — never a prompt or utterance. */
  dependency: string;
  /** Optional metadata note — never learner content. */
  detail?: string | undefined;
};

export const degradationForcedFailureSchema = z
  .object({
    kind: z.enum(DEGRADATION_FORCED_FAILURE_KINDS),
    dependency: z.string().min(1).max(128),
    detail: z.string().min(1).max(256).optional(),
  })
  .strict() satisfies z.ZodType<DegradationForcedFailure>;

/**
 * One stubbed-down vector: surface + forced failure → expected mode/signal.
 * Bounded for B4 suites — never carries prompt/completion bodies.
 */
export type DegradationStubVector = {
  id: string;
  subjectId: string;
  deviceId?: string | undefined;
  surface: DegradationSurface;
  operation: DegradationOperation;
  forcedFailure: DegradationForcedFailure;
  expectedMode: DegradationMode;
  expectedSignalCode: string;
  expectedReadPolicy: DegradationBehaviorSpec["readPolicy"];
  expectedWritePolicy: DegradationBehaviorSpec["writePolicy"];
  allowsSilentWriteRetry: false;
  allowsFabrication: false;
  requiresRollback?: boolean | undefined;
  idempotencyKey: string;
};

export const degradationStubVectorSchema = z
  .object({
    id: z.string().min(1).max(128),
    subjectId: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(128).optional(),
    surface: degradationSurfaceSchema,
    operation: degradationOperationSchema,
    forcedFailure: degradationForcedFailureSchema,
    expectedMode: degradationModeSchema,
    expectedSignalCode: z.string().min(1).max(64),
    expectedReadPolicy: z.enum([
      "fresh",
      "stale-with-marker",
      "unavailable",
    ]),
    expectedWritePolicy: z.enum([
      "proceed",
      "hard-stop-rollback",
      "queue-and-warn",
    ]),
    allowsSilentWriteRetry: z.literal(false),
    allowsFabrication: z.literal(false),
    requiresRollback: z.boolean().optional(),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict() satisfies z.ZodType<DegradationStubVector>;

export type DegradationStubVectorCatalog = {
  version: string;
  description: string;
  vectors: DegradationStubVector[];
  violations?: unknown[] | undefined;
};

export const degradationStubVectorCatalogSchema = z
  .object({
    version: z.string().min(1).max(32),
    description: z.string().min(1).max(512),
    vectors: z.array(degradationStubVectorSchema).min(1).max(64),
    violations: z.array(z.unknown()).max(32).optional(),
  })
  .strict() satisfies z.ZodType<DegradationStubVectorCatalog>;

export type StubVectorEvaluateAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
  vectorId: string;
  surface: DegradationSurface;
  operation: DegradationOperation;
  mode: DegradationMode;
  signalCode: string;
  forcedFailureKind: DegradationForcedFailureKind;
  outcome: "degraded";
};

export type StubVectorEvaluateRejected = {
  ok: false;
  subjectId: string | null;
  deviceId?: string;
  vectorId: string;
  failureClass:
    | "missing_subject"
    | "mode_mismatch"
    | "signal_mismatch"
    | "policy_mismatch"
    | "silent_retry_forbidden"
    | "unknown_binding"
    | "schema_violation";
  issuePath: string;
};

export type StubVectorEvaluateResult =
  | StubVectorEvaluateAccepted
  | StubVectorEvaluateRejected;

/**
 * Evaluate a stubbed-down vector against the (read-only) registry.
 * Confirms forced failure maps to the documented mode + signal code.
 */
export function evaluateDegradationStubVector(
  input: unknown,
  registry: DegradationRegistryHandle = createDegradationRegistry(),
): StubVectorEvaluateResult {
  const parsed = degradationStubVectorSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const issuePath = first
      ? first.path.map(String).join(".") || "(root)"
      : "(root)";
    const subjectGuess =
      input &&
      typeof input === "object" &&
      typeof (input as { subjectId?: unknown }).subjectId === "string"
        ? (input as { subjectId: string }).subjectId
        : null;
    return {
      ok: false,
      subjectId: subjectGuess && subjectGuess.length > 0 ? subjectGuess : null,
      vectorId:
        input &&
        typeof input === "object" &&
        typeof (input as { id?: unknown }).id === "string"
          ? (input as { id: string }).id
          : "(unknown)",
      failureClass:
        first?.path[0] === "subjectId" ? "missing_subject" : "schema_violation",
      issuePath,
    };
  }

  const vector = parsed.data;
  const looked = registry.lookup(vector.surface, vector.operation, {
    subjectId: vector.subjectId,
    ...(vector.deviceId !== undefined ? { deviceId: vector.deviceId } : {}),
  });

  if (looked.outcome === "rejected") {
    return {
      ok: false,
      subjectId: looked.subjectId,
      ...(looked.deviceId !== undefined ? { deviceId: looked.deviceId } : {}),
      vectorId: vector.id,
      failureClass:
        looked.failureClass === "missing_subject"
          ? "missing_subject"
          : "unknown_binding",
      issuePath: looked.issuePath,
    };
  }

  if (looked.behavior.mode !== vector.expectedMode) {
    return {
      ok: false,
      subjectId: vector.subjectId,
      ...(vector.deviceId !== undefined ? { deviceId: vector.deviceId } : {}),
      vectorId: vector.id,
      failureClass: "mode_mismatch",
      issuePath: "expectedMode",
    };
  }
  if (looked.behavior.signalCode !== vector.expectedSignalCode) {
    return {
      ok: false,
      subjectId: vector.subjectId,
      ...(vector.deviceId !== undefined ? { deviceId: vector.deviceId } : {}),
      vectorId: vector.id,
      failureClass: "signal_mismatch",
      issuePath: "expectedSignalCode",
    };
  }
  if (
    looked.behavior.readPolicy !== vector.expectedReadPolicy ||
    looked.behavior.writePolicy !== vector.expectedWritePolicy
  ) {
    return {
      ok: false,
      subjectId: vector.subjectId,
      ...(vector.deviceId !== undefined ? { deviceId: vector.deviceId } : {}),
      vectorId: vector.id,
      failureClass: "policy_mismatch",
      issuePath: "expectedReadPolicy",
    };
  }
  if (
    vector.allowsSilentWriteRetry !== false ||
    looked.behavior.allowsSilentWriteRetry !== false
  ) {
    return {
      ok: false,
      subjectId: vector.subjectId,
      ...(vector.deviceId !== undefined ? { deviceId: vector.deviceId } : {}),
      vectorId: vector.id,
      failureClass: "silent_retry_forbidden",
      issuePath: "allowsSilentWriteRetry",
    };
  }

  return {
    ok: true,
    subjectId: vector.subjectId,
    ...(vector.deviceId !== undefined ? { deviceId: vector.deviceId } : {}),
    vectorId: vector.id,
    surface: vector.surface,
    operation: vector.operation,
    mode: looked.behavior.mode,
    signalCode: looked.behavior.signalCode,
    forcedFailureKind: vector.forcedFailure.kind,
    outcome: "degraded",
  };
}

/**
 * Apply idempotency: replay of the same key must not double-count host effects.
 * Returns whether this application is the first observation of the key.
 */
export function claimStubVectorIdempotencyKey(
  seen: Set<string>,
  idempotencyKey: string,
): { first: boolean; key: string } {
  if (seen.has(idempotencyKey)) {
    return { first: false, key: idempotencyKey };
  }
  seen.add(idempotencyKey);
  return { first: true, key: idempotencyKey };
}
