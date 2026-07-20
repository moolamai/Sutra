/**
 * Telemetry aggregation contract — edge-facing rollup helpers.
 *
 * Wire schema and consent attachment live in `@moolam/sync-protocol`.
 * This module re-exports the contract and provides a subject-scoped
 * convenience builder for hosts that already hold friction samples locally.
 */

export {
  AGGREGATION_CONCEPT_LIMIT,
  AGGREGATION_CONSENT_FAILURE_CLASSES,
  AGGREGATION_CONSENT_SCOPES,
  AGGREGATION_ID_LIMIT,
  AGGREGATION_LOCALITIES,
  AGGREGATION_SAMPLE_INPUT_LIMIT,
  AggregationConsentError,
  FRICTION_AGGREGATION_COMMITTED_SCHEMA_RELPATH,
  FRICTION_AGGREGATION_SCHEMA_VERSION,
  aggregationConsentRecordSchema,
  assertAggregationExportConsent,
  assertAggregationExportConsentOrThrow,
  attachAggregationConsent,
  buildFrictionAggregationRollup,
  conceptFrictionRollupSchema,
  dedupeFrictionSamplesByCapturedAt,
  enqueueAggregationWrite,
  frictionAggregationRollupSchema,
  isAggregationConsentFailure,
  parseFrictionAggregationRollup,
  raiseAggregationConsentError,
  toFrictionAggregationJsonSchema,
  type AggregationConsentFailureClass,
  type AggregationConsentRecord,
  type AggregationConsentScope,
  type AggregationFailureClass,
  type AggregationLocality,
  type AggregationWriteTelemetryEvent,
  type BuildFrictionAggregationInput,
  type BuildFrictionAggregationResult,
  type ConceptFrictionRollup,
  type FrictionAggregationRollup,
  type ParseFrictionAggregationResult,
} from "@moolam/sync-protocol";

import {
  AGGREGATION_SAMPLE_INPUT_LIMIT,
  assertAggregationExportConsent,
  buildFrictionAggregationRollup,
  type AggregationConsentRecord,
  type AggregationFailureClass,
  type AggregationLocality,
  type BuildFrictionAggregationResult,
  type FrictionAggregationRollup,
} from "@moolam/sync-protocol";
import type { StorageDriver } from "@moolam/contracts";
import type { FrictionSample, HLCTimestamp } from "@moolam/sync-protocol";

export type RollupLocalFrictionInput = {
  subjectId: string;
  deviceId: string;
  consentRecordId: string;
  locality?: AggregationLocality;
  samples: readonly FrictionSample[];
  rolledUpAt: HLCTimestamp;
  /** Optional ledger resolve — when provided, export consent is checked now. */
  resolveConsent?: (
    consentRecordId: string,
  ) => AggregationConsentRecord | null | undefined;
  /** Deterministic clock for expiresAt checks (ISO). Defaults to wall now. */
  nowIso?: string;
};

/**
 * Build a consent-attached subject/concept rollup from local friction samples.
 * Does not leave the sovereign boundary — callers still gate egress separately.
 */
export function rollupLocalFrictionSamples(
  input: RollupLocalFrictionInput,
): BuildFrictionAggregationResult {
  const built = buildFrictionAggregationRollup({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    consentRecordId: input.consentRecordId,
    locality: input.locality ?? "on-device",
    samples: input.samples,
    rolledUpAt: input.rolledUpAt,
  });
  if (!built.ok) return built;

  if (input.resolveConsent) {
    const gate = assertAggregationExportConsent(
      built.record,
      input.resolveConsent,
      input.nowIso !== undefined ? { nowIso: input.nowIso } : {},
    );
    if (!gate.ok) {
      return {
        ok: false,
        failureClass: gate.failureClass,
        subjectId: gate.subjectId,
        detail: gate.detail,
      };
    }
  }

  return built;
}

/**
 * Emit a metadata-only aggregation observability event (never raw content).
 */
export function emitAggregationObservability(event: {
  event: string;
  outcome: "ok" | "error" | "rejected";
  subjectId: string;
  deviceId?: string;
  failureClass?: string;
  sampleCount?: number;
  conceptCount?: number;
}): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Type guard helper for hosts validating rollups before batch egress. */
export function isFrictionAggregationRollup(
  value: unknown,
): value is FrictionAggregationRollup {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === "aggregation.v1"
  );
}

/**
 * Package-relative golden fixture root for rollup correctness + consent rejection.
 * Covered by `tests/aggregation_consent_rollup.test.mjs`.
 */
export const AGGREGATION_GOLDEN_FIXTURES_RELPATH =
  "fixtures/aggregation" as const;
export const AGGREGATION_GOLDEN_MANIFEST = "manifest.json" as const;

/** Default bounded local read; one extra row detects truncation. */
export const EDGE_AGGREGATION_DEFAULT_LIMIT = 1024;
export const EDGE_AGGREGATION_DEFAULT_TIMEOUT_MS = 5_000;

export type EdgeAggregationFailureClass =
  | AggregationFailureClass
  | "storage_timeout"
  | "storage_failure"
  | "invalid_range";

export type EdgeAggregationEvent = {
  event: "telemetry.aggregation.edge";
  operation: "rollup";
  outcome: "ok" | "rejected";
  subjectId: string;
  deviceId: string;
  failureClass?: EdgeAggregationFailureClass;
  sampleCount?: number;
  conceptCount?: number;
};

export type EdgeAggregationResult =
  | { ok: true; record: FrictionAggregationRollup }
  | {
      ok: false;
      failureClass: EdgeAggregationFailureClass;
      subjectId: string;
      detail: string;
    };

export type SubjectScopedAggregationSeamOptions = {
  /** This storage instance is exclusively bound to this subject. */
  subjectId: string;
  driver: StorageDriver;
  resolveConsent: (
    subjectId: string,
    consentRecordId: string,
  ) =>
    | AggregationConsentRecord
    | null
    | undefined
    | Promise<AggregationConsentRecord | null | undefined>;
  onTelemetry?: (event: EdgeAggregationEvent) => void;
  timeoutMs?: number;
};

export type RollupStoredFrictionInput = {
  subjectId: string;
  deviceId: string;
  consentRecordId: string;
  rolledUpAt: HLCTimestamp;
  locality?: AggregationLocality;
  fromCapturedAt?: HLCTimestamp;
  throughCapturedAt?: HLCTimestamp;
  limit?: number;
};

type FrictionRow = {
  captured_at: string;
  concept_id: string;
  hesitation_ms: number;
  input_velocity: number;
  revision_count: number;
  assistance_requested: number;
  outcome: FrictionSample["outcome"];
};

/**
 * Self-hostable edge aggregation over a subject-bound friction_samples table.
 *
 * The table contains no subject column because each driver/database is a
 * sovereign subject store. The constructor binding is therefore the isolation
 * boundary; a mismatched request is rejected before any storage read.
 */
export class SubjectScopedAggregationSeam {
  private readonly timeoutMs: number;

  constructor(private readonly options: SubjectScopedAggregationSeamOptions) {
    if (!options.subjectId) {
      throw new TypeError("subjectId is required for subject-scoped aggregation");
    }
    this.timeoutMs =
      options.timeoutMs ?? EDGE_AGGREGATION_DEFAULT_TIMEOUT_MS;
  }

  async rollup(input: RollupStoredFrictionInput): Promise<EdgeAggregationResult> {
    const reject = (
      failureClass: EdgeAggregationFailureClass,
      detail: string,
    ): EdgeAggregationResult => {
      this.options.onTelemetry?.({
        event: "telemetry.aggregation.edge",
        operation: "rollup",
        outcome: "rejected",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        failureClass,
      });
      return { ok: false, failureClass, subjectId: input.subjectId, detail };
    };

    if (input.subjectId !== this.options.subjectId) {
      return reject(
        "cross_subject",
        "request subjectId does not match the subject-bound storage seam",
      );
    }
    if (
      input.fromCapturedAt !== undefined &&
      input.throughCapturedAt !== undefined &&
      input.fromCapturedAt > input.throughCapturedAt
    ) {
      return reject(
        "invalid_range",
        "fromCapturedAt must not be later than throughCapturedAt",
      );
    }

    const requestedLimit = input.limit ?? EDGE_AGGREGATION_DEFAULT_LIMIT;
    if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > AGGREGATION_SAMPLE_INPUT_LIMIT
    ) {
      return reject(
        "sample_limit",
        `limit must be an integer from 1 to ${AGGREGATION_SAMPLE_INPUT_LIMIT}`,
      );
    }

    const consentBefore = await this.resolveConsentBounded(
      input,
      reject,
    );
    if (!consentBefore.ok) return consentBefore;

    const params: unknown[] = [];
    const predicates: string[] = [];
    if (input.fromCapturedAt !== undefined) {
      predicates.push("captured_at >= ?");
      params.push(input.fromCapturedAt);
    }
    if (input.throughCapturedAt !== undefined) {
      predicates.push("captured_at <= ?");
      params.push(input.throughCapturedAt);
    }
    const where =
      predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "";
    const readLimit = requestedLimit + 1;

    let rows: FrictionRow[];
    try {
      rows = await this.withTimeout(
        this.options.driver.query<FrictionRow>(
          `SELECT captured_at, concept_id, hesitation_ms, input_velocity,
                  revision_count, assistance_requested, outcome
             FROM friction_samples${where}
            ORDER BY captured_at ASC
            LIMIT ${readLimit}`,
          params,
        ),
      );
    } catch (error: unknown) {
      if (error instanceof EdgeAggregationStorageError) {
        return reject(error.failureClass, error.message);
      }
      return reject(
        "storage_failure",
        error instanceof Error
          ? `friction read failed: ${error.name}`
          : "friction read failed",
      );
    }

    if (rows.length > requestedLimit) {
      return reject(
        "sample_limit",
        `bounded result exceeds requested limit (${requestedLimit})`,
      );
    }

    const samples: FrictionSample[] = rows.map((row) => ({
      conceptId: row.concept_id,
      hesitationMs: row.hesitation_ms,
      inputVelocity: row.input_velocity,
      revisionCount: row.revision_count,
      assistanceRequested: row.assistance_requested === 1,
      outcome: row.outcome,
      capturedAt: row.captured_at as HLCTimestamp,
    }));

    const built = buildFrictionAggregationRollup({
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      consentRecordId: input.consentRecordId,
      locality: input.locality ?? "on-device",
      samples,
      rolledUpAt: input.rolledUpAt,
    });
    if (!built.ok) return reject(built.failureClass, built.detail);

    // Re-resolve after the read/build window so a mid-batch revocation denies.
    const consentAfter = await this.resolveConsentBounded(input, reject);
    if (!consentAfter.ok) return consentAfter;

    const gate = assertAggregationExportConsent(
      built.record,
      () => consentAfter.consent,
    );
    if (!gate.ok) return reject(gate.failureClass, gate.detail);

    this.options.onTelemetry?.({
      event: "telemetry.aggregation.edge",
      operation: "rollup",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      sampleCount: built.record.sampleCount,
      conceptCount: built.record.concepts.length,
    });
    return built;
  }

  private async resolveConsentBounded(
    input: RollupStoredFrictionInput,
    reject: (
      failureClass: EdgeAggregationFailureClass,
      detail: string,
    ) => EdgeAggregationResult,
  ): Promise<
    | { ok: true; consent: AggregationConsentRecord }
    | Extract<EdgeAggregationResult, { ok: false }>
  > {
    let consent: AggregationConsentRecord | null | undefined;
    try {
      consent = await this.withTimeout(
        Promise.resolve(
          this.options.resolveConsent(
            input.subjectId,
            input.consentRecordId,
          ),
        ),
      );
    } catch (error: unknown) {
      if (error instanceof EdgeAggregationStorageError) {
        return reject(error.failureClass, error.message) as Extract<
          EdgeAggregationResult,
          { ok: false }
        >;
      }
      return reject(
        "storage_failure",
        error instanceof Error
          ? `consent resolve failed: ${error.name}`
          : "consent resolve failed",
      ) as Extract<EdgeAggregationResult, { ok: false }>;
    }

    const probe: FrictionAggregationRollup = {
      schemaVersion: "aggregation.v1",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      consentRecordId: input.consentRecordId,
      locality: input.locality ?? "on-device",
      rolledUpAt: input.rolledUpAt,
      sampleCount: 0,
      concepts: [],
    };
    const gate = assertAggregationExportConsent(probe, () => consent);
    if (!gate.ok) {
      return reject(gate.failureClass, gate.detail) as Extract<
        EdgeAggregationResult,
        { ok: false }
      >;
    }
    return { ok: true, consent: consent as AggregationConsentRecord };
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new EdgeAggregationStorageError(
              "storage_timeout",
              `aggregation dependency timed out after ${this.timeoutMs}ms`,
            ),
          ),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

class EdgeAggregationStorageError extends Error {
  constructor(
    readonly failureClass: "storage_timeout",
    message: string,
  ) {
    super(message);
    this.name = "EdgeAggregationStorageError";
  }
}
