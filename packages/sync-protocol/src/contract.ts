/**
 * @module contract
 *
 * THE CONTRACT — the framework-agnostic API boundary of the Hybrid Harness.
 *
 * Every byte that crosses the Edge/Cloud boundary is defined here and ONLY
 * here. The Edge Harness (`@moolam/edge-agent`) and the reference Cloud
 * Harness (`sutra_orchestrator`, Python) are both downstream consumers of
 * these types. A sovereign deployment may replace the entire cloud engine
 * (Go, Rust, JVM, anything) as long as it honors this contract — transported
 * over REST (`/v1/*`) or GraphQL, always as JSON.
 *
 * Design invariants:
 *  1. All timestamps are Hybrid Logical Clock (HLC) strings — never wall
 *     clocks — so merges are total-ordered even across skewed devices.
 *  2. All mutable state is expressed as CRDT-mergeable structures
 *     (see {@link crdt_harness_resolver}).
 *  3. No field is ever removed from the wire format; deprecation is
 *     additive and versioned via {@link PROTOCOL_VERSION}.
 */

import { z } from "zod";

/** Semantic version of the wire contract. Bump MINOR for additive changes only. */
export const PROTOCOL_VERSION = "1.0.0" as const;

/* ────────────────────────────────────────────────────────────────────────
 * Hybrid Logical Clock
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Hybrid Logical Clock timestamp: `"<physicalMillis>:<logicalCounter>:<deviceId>"`.
 * Lexicographic comparison of the zero-padded encoded form yields the total
 * order used by every CRDT register in the protocol.
 */
export type HLCTimestamp = string & { readonly __brand: "HLCTimestamp" };

export const hlcSchema = z
  .string()
  .regex(/^\d{15}:\d{6}:[A-Za-z0-9_-]{4,64}$/, "malformed HLC timestamp")
  .transform((s) => s as HLCTimestamp);

/** Encode an HLC triple into its canonical, lexicographically-ordered form. */
export function encodeHLC(physicalMillis: number, logical: number, deviceId: string): HLCTimestamp {
  const p = String(physicalMillis).padStart(15, "0");
  const l = String(logical).padStart(6, "0");
  return `${p}:${l}:${deviceId}` as HLCTimestamp;
}

/** Total-order comparator over HLC timestamps. Negative → a happened-before b. */
export function compareHLC(a: HLCTimestamp, b: HLCTimestamp): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ────────────────────────────────────────────────────────────────────────
 * Cognitive domain model
 * ──────────────────────────────────────────────────────────────────────── */

/** Stable identifier of a node in the prerequisite knowledge graph. */
export type ConceptId = string;

/** Guidance regime the task router is currently operating in. */
export type GuidanceMode =
  | "exploratory" // question-led discovery (abstract concepts, experienced subjects)
  | "guided" // step-by-step demonstration (procedures, novice subjects)
  | "reinforcement" // spaced recall of decayed concepts
  | "prerequisite-remediation" // cyclical loop-back triggered by the router's failure edge
  | "diagnostic"; // calibration probing when evidence is thin

/**
 * Instantaneous friction measurement for a single subject interaction.
 * Friction — not correctness — is the primary signal of the assessment
 * (CAST) subsystem.
 */
export interface FrictionSample {
  /** Concept being exercised when the sample was taken. */
  conceptId: ConceptId;
  /** ms between prompt render and first subject input. High = hesitation. */
  hesitationMs: number;
  /** Characters (or strokes) per second while the subject was responding. */
  inputVelocity: number;
  /** Count of deletions/rewrites before submission. High = uncertainty churn. */
  revisionCount: number;
  /** Whether the subject explicitly requested assistance or gave up. */
  assistanceRequested: boolean;
  /** Grading outcome, when one exists (open-ended dialog turns have none). */
  outcome: "correct" | "partial" | "incorrect" | "ungraded";
  /** HLC time the sample was captured on-device. */
  capturedAt: HLCTimestamp;
}

/**
 * Per-concept mastery estimate. `alpha`/`beta` are Beta-distribution
 * pseudo-counts (Bayesian Knowledge Tracing posterior); mastery mean is
 * `alpha / (alpha + beta)`. Both counters are grow-only so the pair merges
 * as a G-Counter under the CRDT rules.
 */
export interface ConceptMastery {
  conceptId: ConceptId;
  /** Grow-only evidence-of-mastery pseudo-count, per device (G-Counter shards). */
  alpha: Record<string, number>;
  /** Grow-only evidence-of-struggle pseudo-count, per device (G-Counter shards). */
  beta: Record<string, number>;
  /** LWW register: HLC of the most recent exercising interaction (decay anchor). */
  lastExercisedAt: HLCTimestamp;
}

/**
 * THE canonical subject state document. This exact shape lives in edge
 * SQLite, in cloud Postgres, and on the wire — there is one truth.
 *
 * CRDT typing per field group:
 *  - `mastery`        → map of G-Counter pairs (commutative, convergent)
 *  - `frictionLog`    → grow-only set keyed by `capturedAt` (append-only)
 *  - `activeConceptId`, `mode`, `profile` → LWW registers under HLC order
 */
export interface CognitiveState {
  protocolVersion: typeof PROTOCOL_VERSION;
  subjectId: string;
  /** Devices that have contributed to this document (grow-only set). */
  deviceIds: string[];
  /** LWW: the concept the agent is currently working on. */
  activeConceptId: ConceptId | null;
  /** LWW: current guidance regime chosen by the task router. */
  mode: GuidanceMode;
  /** G-Counter-pair mastery posteriors, keyed by concept. */
  mastery: Record<ConceptId, ConceptMastery>;
  /** G-Set of friction samples not yet compacted into `mastery`. */
  frictionLog: FrictionSample[];
  /** LWW: coarse subject profile used to seat the router's initial policy. */
  profile: {
    ageBand: "child" | "adolescent" | "adult";
    /** Domain track id, e.g. "cbse-class-7-maths", "legal-research-in", "system-design-l5". */
    track: string;
    language: string; // BCP-47, e.g. "hi-IN", "en-IN", "ta-IN"
    updatedAt: HLCTimestamp;
  };
  /** HLC high-water mark of every field in this document. */
  stateVector: Record<string, HLCTimestamp>;
}

/* ────────────────────────────────────────────────────────────────────────
 * Wire schemas (runtime-validated at the boundary)
 * ──────────────────────────────────────────────────────────────────────── */

export const frictionSampleSchema = z.object({
  conceptId: z.string().min(1),
  hesitationMs: z.number().int().nonnegative(),
  inputVelocity: z.number().nonnegative(),
  revisionCount: z.number().int().nonnegative(),
  assistanceRequested: z.boolean(),
  outcome: z.enum(["correct", "partial", "incorrect", "ungraded"]),
  capturedAt: hlcSchema,
}) satisfies z.ZodType<FrictionSample>;

export const conceptMasterySchema = z.object({
  conceptId: z.string().min(1),
  alpha: z.record(z.string(), z.number().nonnegative()),
  beta: z.record(z.string(), z.number().nonnegative()),
  lastExercisedAt: hlcSchema,
}) satisfies z.ZodType<ConceptMastery>;

export const cognitiveStateSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  subjectId: z.string().min(1),
  deviceIds: z.array(z.string().min(1)),
  activeConceptId: z.string().min(1).nullable(),
  mode: z.enum([
    "exploratory",
    "guided",
    "reinforcement",
    "prerequisite-remediation",
    "diagnostic",
  ]),
  mastery: z.record(z.string(), conceptMasterySchema),
  frictionLog: z.array(frictionSampleSchema),
  profile: z.object({
    ageBand: z.enum(["child", "adolescent", "adult"]),
    track: z.string().min(1),
    language: z.string().min(2),
    updatedAt: hlcSchema,
  }),
  stateVector: z.record(z.string(), hlcSchema),
}) satisfies z.ZodType<CognitiveState>;

/* ────────────────────────────────────────────────────────────────────────
 * REST boundary — request/response envelopes
 *
 * The reference cloud engine mounts these as:
 *   POST /v1/sync                → SyncRequest  → SyncResponse
 *   POST /v1/agent/turn          → AgentTurnRequest → AgentTurnResponse
 *   GET  /v1/subjects/{id}/state → CognitiveState
 * ──────────────────────────────────────────────────────────────────────── */

/** Edge → Cloud reconciliation push, sent when connectivity is restored. */
export interface SyncRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  deviceId: string;
  /** Full edge replica; the protocol is state-based (CvRDT), not op-based. */
  edgeState: CognitiveState;
  /** State vector the edge last saw from the cloud, for delta computation. */
  lastKnownCloudVector: Record<string, HLCTimestamp>;
  /** Idempotency key — retried requests MUST reuse the same key. */
  syncAttemptId: string;
  /**
   * Optional W3C Trace Context wire headers .
   * Additive — absent on older clients; never carries learner content.
   */
  headers?: SyncWireHeaders | undefined;
}

/**
 * Trace-context carrier on the SyncRequest envelope (metadata only).
 * Keys match W3C Trace Context HTTP field names (lowercase).
 */
export interface SyncWireHeaders {
  /** W3C `traceparent` — version-traceid-parentid-flags. */
  traceparent?: string | undefined;
  /** Optional W3C `tracestate` vendor list. */
  tracestate?: string | undefined;
}

/** Canonical header names for sync wire trace propagation. */
export const SYNC_WIRE_TRACEPARENT = "traceparent" as const;
export const SYNC_WIRE_TRACESTATE = "tracestate" as const;

export interface SyncResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  /** Converged master state after CRDT merge. Edge MUST adopt this verbatim. */
  mergedState: CognitiveState;
  /** Samples the cloud compacted into mastery; edge may prune its local log. */
  compactedSampleTimestamps: HLCTimestamp[];
  /** Non-fatal anomalies detected during merge (clock skew, dup shards, …). */
  advisories: SyncAdvisory[];
}

export interface SyncAdvisory {
  code:
    | "CLOCK_SKEW_CLAMPED"
    | "DUPLICATE_SAMPLE_DROPPED"
    | "UNKNOWN_CONCEPT_QUARANTINED"
    | "STATE_VECTOR_REGRESSION"
    | "DEPRECATED_FIELD_PRESENT";
  detail: string;
}

/** Canonical SyncAdvisory.code values (SYNC-06 / deprecation). */
export const SYNC_ADVISORY_CODES = Object.freeze([
  "CLOCK_SKEW_CLAMPED",
  "DUPLICATE_SAMPLE_DROPPED",
  "UNKNOWN_CONCEPT_QUARANTINED",
  "STATE_VECTOR_REGRESSION",
  "DEPRECATED_FIELD_PRESENT",
] as const);

export type SyncAdvisoryCode = (typeof SYNC_ADVISORY_CODES)[number];

/** One subject utterance sent to whichever brain (edge SLM or cloud LLM) is active. */
export interface AgentTurnRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  subjectId: string;
  sessionId: string;
  utterance: string;
  /** Friction measured while the subject composed this utterance. */
  friction: FrictionSample;
}

/** Stale / degraded read marker — last-known-good, never fabricated. */
export type FreshnessMarker = {
  capturedAt: string;
  source: "last-known-good" | "local-cache";
};

export const freshnessMarkerSchema = z
  .object({
    capturedAt: z.string().min(1).max(128),
    source: z.enum(["last-known-good", "local-cache"]),
  })
  .strict() satisfies z.ZodType<FreshnessMarker>;

/** The agent's reply plus the router's next decision, fully explainable. */
export interface AgentTurnResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  reply: string;
  /** Concept the task router routed to for the NEXT turn (may loop backwards). */
  nextConceptId: ConceptId;
  mode: GuidanceMode;
  /** Router explanation — surfaced in the Playground, never hidden. */
  routingRationale: string;
  /** Updated mastery posterior mean for the exercised concept, [0,1]. */
  masteryEstimate: number;
  /** True when reply is ATR-05 directive-only degraded (model timeout). */
  degraded?: boolean | undefined;
  /** Present with degraded replies — last-known-good directive, not fabricated. */
  freshnessMarker?: FreshnessMarker | undefined;
}

export const syncWireHeadersSchema = z
  .object({
    traceparent: z.string().min(1).max(128).optional(),
    tracestate: z.string().max(512).optional(),
  })
  .strict();

export const syncRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  deviceId: z.string().min(4),
  edgeState: cognitiveStateSchema,
  lastKnownCloudVector: z.record(z.string(), hlcSchema),
  syncAttemptId: z.string().uuid(),
  headers: syncWireHeadersSchema.optional(),
}) satisfies z.ZodType<SyncRequest>;

export const syncAdvisorySchema = z.object({
  code: z.enum([
    "CLOCK_SKEW_CLAMPED",
    "DUPLICATE_SAMPLE_DROPPED",
    "UNKNOWN_CONCEPT_QUARANTINED",
    "STATE_VECTOR_REGRESSION",
    "DEPRECATED_FIELD_PRESENT",
  ]),
  detail: z.string(),
}) satisfies z.ZodType<SyncAdvisory>;

export const syncResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  mergedState: cognitiveStateSchema,
  compactedSampleTimestamps: z.array(hlcSchema),
  advisories: z.array(syncAdvisorySchema),
}) satisfies z.ZodType<SyncResponse>;

export const agentTurnRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  subjectId: z.string().min(1),
  sessionId: z.string().min(1),
  utterance: z.string(),
  friction: frictionSampleSchema,
}) satisfies z.ZodType<AgentTurnRequest>;

export const agentTurnResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  reply: z.string(),
  nextConceptId: z.string().min(1),
  mode: z.enum([
    "exploratory",
    "guided",
    "reinforcement",
    "prerequisite-remediation",
    "diagnostic",
  ]),
  routingRationale: z.string(),
  masteryEstimate: z.number().min(0).max(1),
  degraded: z.boolean().optional(),
  freshnessMarker: freshnessMarkerSchema.optional(),
}) satisfies z.ZodType<AgentTurnResponse>;

/* ────────────────────────────────────────────────────────────────────────
 * Turn trajectory (B9 metadata + C0 training extensions)
 * Canonical Zod parse lives in `@moolam/learning` (`turnTrajectoryRecordSchema`).
 * Types here mirror that contract for sync / harness consumers.
 * ──────────────────────────────────────────────────────────────────────── */

/** Trajectory schema id — bump MINOR for additive field additions only. */
export const TRAJECTORY_SCHEMA_VERSION = "trajectory.v1" as const;

/**
 * Repo-relative committed JSON Schema (Zod export via `@moolam/learning`).
 * Canonical Zod: `turnTrajectoryRecordSchema` in `@moolam/learning`.
 */
export const TRAJECTORY_COMMITTED_SCHEMA_RELPATH =
  "schemas/trajectory/v1.json" as const;

/**
 * Golden B9 + C0 trajectory fixtures live under `@moolam/learning`
 * (`fixtures/trajectory`). Round-trip: parse → canonical JSON → parse.
 */
export const TRAJECTORY_GOLDEN_FIXTURES_RELPATH =
  "packages/learning/fixtures/trajectory" as const;

/** C0 optional training field classes (violation coverage one-per-class). */
export const TRAJECTORY_TRAINING_FIELD_CLASSES = Object.freeze([
  "policyCheckpointHash",
  "precisionFormat",
  "executionState",
  "routerReplayMap",
] as const);

/** Quantization / precision tag for SLM adapters at rollout. */
export type PrecisionFormat =
  | "fp32"
  | "fp16"
  | "bf16"
  | "int8"
  | "int4"
  | "nf4";

export type TrajectoryConsentClass =
  | "research"
  | "product-improve"
  | "personal";

export type TrajectoryLocality = "on-device" | "self-hosted";

/**
 * Per-turn execution state. On stream abort, record last attempted command
 * and terminal status — never omit silently when training fields apply.
 */
export interface TrajectoryExecutionState {
  /** Opaque opcode / tool name — never keystroke streams. */
  commandExecuted: string;
  statusCode: number | string;
}

/**
 * Forward-compat router replay map.
 * Dense on-device SLMs MAY omit `routerReplayMap` entirely; absence is valid.
 * Sparse hosts MAY include it for offline replay. Parsers must accept both.
 */
export type RouterReplayMap = Readonly<Record<string, string>>;

export interface TrajectoryConsent {
  optedIn: boolean;
  consentClass: TrajectoryConsentClass;
  recordedAt: string;
}

export interface TrajectoryStageRecord {
  stage: string;
  opCode?: string;
  status?: "ok" | "aborted" | "error" | "skipped";
}

/**
 * Consent-gated turn trajectory record.
 * B9 base fields are required; C0 training fields are optional (additive).
 * Never carries raw keystrokes or utterance bodies.
 */
export interface TurnTrajectoryRecord {
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  subjectId: string;
  sessionId: string;
  turnId: string;
  deviceId?: string;
  capturedAt: string;
  locality: TrajectoryLocality;
  consent: TrajectoryConsent;
  stages: TrajectoryStageRecord[];
  toolCallIds?: string[];
  /**
   * Exact adapter/base checkpoint hash used during rollout — never "latest".
   */
  policyCheckpointHash?: string;
  precisionFormat?: PrecisionFormat;
  executionState?: TrajectoryExecutionState;
  /**
   * Optional. Dense SLMs omit; parsers must not require this key (forward-compat).
   */
  routerReplayMap?: RouterReplayMap;
}

/**
 * Named wire-boundary schemas reachable from the package barrel.
 * The JSON Schema exporter (and any stranger implementor) must import
 * from this set — never reach into private module paths.
 */
export const WIRE_BOUNDARY_SCHEMAS = {
  frictionSampleSchema,
  conceptMasterySchema,
  cognitiveStateSchema,
  syncRequestSchema,
  syncResponseSchema,
  syncAdvisorySchema,
  agentTurnRequestSchema,
  agentTurnResponseSchema,
} as const;

/* ────────────────────────────────────────────────────────────────────────
 * SyncEngine terminal metadata — codes safe for telemetry
 * ──────────────────────────────────────────────────────────────────────── */

/** Terminal statuses produced by SyncEngine.synchronize (never throws). */
export const SYNC_TERMINAL_STATUSES = Object.freeze([
  "converged",
  "quarantined",
  "exhausted",
] as const);

export type SyncTerminalStatus = (typeof SYNC_TERMINAL_STATUSES)[number];

/**
 * Quarantine reason codes for spans / operators — never HTTP body text or
 * the rejected CognitiveState blob.
 */
export const SYNC_QUARANTINE_REASON_CODES = Object.freeze([
  "HTTP_CLIENT_REJECTED",
] as const);

export type SyncQuarantineReasonCode =
  (typeof SYNC_QUARANTINE_REASON_CODES)[number];

/** Exhausted-series reason codes (metadata only). */
export const SYNC_EXHAUSTED_REASON_CODES = Object.freeze([
  "MERGE_RESPONSE_INVALID",
  "TRANSIENT_ATTEMPTS_EXHAUSTED",
] as const);

export type SyncExhaustedReasonCode =
  (typeof SYNC_EXHAUSTED_REASON_CODES)[number];
