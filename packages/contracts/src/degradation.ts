/**
 * Degradation registry — named behaviors when dependencies fail.
 *
 * Adapters consult the registry read API instead of inventing per-surface
 * improvisation. Reads may serve last-known-good with a freshness marker;
 * writes hard-stop with rollback. Silent write retry is forbidden.
 * Registry definitions ship with the SDK — not mutated per tenant at runtime.
 */

/**
 * Closed set of degradation modes.
 * Additive evolution only — new modes are new members, never renames.
 */
export const DEGRADATION_MODES = Object.freeze([
  "STALE_READ",
  "HARD_STOP_WRITE",
  "QUEUE_AND_WARN",
] as const);

export type DegradationMode = (typeof DEGRADATION_MODES)[number];

/** Surfaces adapters may bind to degradation modes. */
export const DEGRADATION_SURFACES = Object.freeze([
  "sync",
  "storage",
  "model",
] as const);

export type DegradationSurface = (typeof DEGRADATION_SURFACES)[number];

/** Operation class within a surface. */
export const DEGRADATION_OPERATIONS = Object.freeze(["read", "write"] as const);

export type DegradationOperation = (typeof DEGRADATION_OPERATIONS)[number];

/**
 * Normative behavior for one DegradationMode.
 * `allowsFabrication` and `allowsSilentWriteRetry` are always false —
 * fabrications and silent write retries are contract violations.
 */
export type DegradationBehaviorSpec = {
  mode: DegradationMode;
  /** Short stable description — never learner content. */
  description: string;
  allowsFabrication: false;
  allowsSilentWriteRetry: false;
  readPolicy: "fresh" | "stale-with-marker" | "unavailable";
  writePolicy: "proceed" | "hard-stop-rollback" | "queue-and-warn";
  requiresFreshnessMarker: boolean;
  /** Structured signal code for host telemetry (metadata only). */
  signalCode: string;
};

/**
 * Read-only registry API. Implementations MUST NOT mutate mode bindings
 * per tenant or per subject at runtime.
 */
export interface DegradationRegistry {
  lookup(
    surface: DegradationSurface,
    operation: DegradationOperation,
  ): DegradationBehaviorSpec | undefined;
}

export function isDegradationMode(value: unknown): value is DegradationMode {
  return (
    typeof value === "string" &&
    (DEGRADATION_MODES as readonly string[]).includes(value)
  );
}
