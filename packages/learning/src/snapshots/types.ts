/**
 * Cognitive rollout snapshot — memory / mastery / knowledge cloned per episode.
 * Structural types (language-neutral JSON); never alias live production state.
 */

/** Soft caps (NFR). */
export const SNAPSHOT_FRICTION_LIMIT = 512;
export const SNAPSHOT_MASTERY_CONCEPT_LIMIT = 256;
export const SNAPSHOT_KNOWLEDGE_ID_LIMIT = 64;
export const SNAPSHOT_STATE_VECTOR_KEY_LIMIT = 64;

export const SNAPSHOT_BACKENDS = Object.freeze(["memory", "postgres"] as const);
export type SnapshotBackendId = (typeof SNAPSHOT_BACKENDS)[number];

export type SnapshotFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "cross_rollout"
  | "concurrent_subject"
  | "not_found"
  | "empty"
  | "stale_state_vector"
  | "section_limit"
  | "schema_violation"
  | "config"
  | "backend_unavailable"
  | "fleet_limit"
  | "consent_denied";

export type SnapshotTelemetry = {
  event: "learning.snapshot_store";
  op:
    | "clone"
    | "get"
    | "put"
    | "discard"
    | "teardown"
    | "backend_select"
    | "allocate"
    | "release";
  outcome: "ok" | "error";
  subjectId: string | null;
  deviceId: string;
  episodeId?: string;
  rolloutId?: string;
  backend?: SnapshotBackendId;
  failureClass?: SnapshotFailureClass;
  detail?: string;
  /** True when teardown retained the slot for consented export. */
  retained?: boolean;
};

/** Memory slice: friction log + session LWW registers (no utterance bodies). */
export type SnapshotMemoryState = {
  frictionLog: unknown[];
  activeConceptId: string | null;
  mode: string;
  profile: {
    ageBand: "child" | "adolescent" | "adult";
    track: string;
    language: string;
    updatedAt: string;
  };
};

/** Mastery slice: Beta posteriors keyed by conceptId. */
export type SnapshotMasteryState = Record<
  string,
  {
    conceptId: string;
    alpha: Record<string, number>;
    beta: Record<string, number>;
    lastExercisedAt: string;
  }
>;

/**
 * Knowledge slice — connector / order ids only (never passage content).
 */
export type SnapshotKnowledgeState = {
  connectorIds: string[];
  orderedIds: string[];
};

/** Deep-cloned cognitive state for one rollout episode. */
export type CognitiveRolloutSnapshot = {
  subjectId: string;
  deviceIds: string[];
  episodeId: string;
  protocolVersion: string;
  memory: SnapshotMemoryState;
  mastery: SnapshotMasteryState;
  knowledge: SnapshotKnowledgeState;
  /** Optimistic concurrency vector — stale put rejected. */
  stateVector: Record<string, string>;
};

export type CloneAtResetInput = {
  subjectId: string;
  deviceId: string;
  episodeId: string;
  /** Optional template to deep-clone; omit → empty genesis for subject. */
  template?: CognitiveRolloutSnapshot | null;
  onTelemetry?: (e: SnapshotTelemetry) => void;
};

export type CloneAtResetResult =
  | { ok: true; snapshot: CognitiveRolloutSnapshot; backend: SnapshotBackendId }
  | {
      ok: false;
      failureClass: SnapshotFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    };

export type GetSnapshotInput = {
  subjectId: string;
  deviceId: string;
  episodeId: string;
  onTelemetry?: (e: SnapshotTelemetry) => void;
};

/**
 * Empty vs not-found are distinct:
 * - empty: episode slot exists with genesis/empty content
 * - not_found: no episode slot for this subject/episode
 */
export type GetSnapshotResult =
  | {
      ok: true;
      empty: false;
      snapshot: CognitiveRolloutSnapshot;
      backend: SnapshotBackendId;
    }
  | {
      ok: true;
      empty: true;
      snapshot: CognitiveRolloutSnapshot;
      backend: SnapshotBackendId;
    }
  | {
      ok: false;
      failureClass: SnapshotFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    };

export type PutSnapshotInput = {
  subjectId: string;
  deviceId: string;
  episodeId: string;
  snapshot: CognitiveRolloutSnapshot;
  /** Must match stored vector or put is rejected (no last-write-wins). */
  expectedStateVector: Record<string, string>;
  onTelemetry?: (e: SnapshotTelemetry) => void;
};

export type PutSnapshotResult =
  | { ok: true; snapshot: CognitiveRolloutSnapshot; backend: SnapshotBackendId }
  | {
      ok: false;
      failureClass: SnapshotFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    };

/**
 * Trajectory consent needed to retain a snapshot past episode terminal.
 * Aligns with B9 / C0 export gate (`optedIn === true`).
 */
export type SnapshotExportConsent = {
  optedIn: boolean;
  consentClass: string;
  recordedAt: string;
};

export type DiscardSnapshotInput = {
  subjectId: string;
  deviceId: string;
  episodeId: string;
  onTelemetry?: (e: SnapshotTelemetry) => void;
};

/**
 * Discard removes the episode slot. Idempotent: missing slot is success
 * (`alreadyDiscarded`), never double-applied side effects.
 */
export type DiscardSnapshotResult =
  | {
      ok: true;
      discarded: true;
      alreadyDiscarded: boolean;
      backend: SnapshotBackendId;
    }
  | {
      ok: false;
      failureClass: SnapshotFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    };

export type TeardownAtTerminalInput = {
  subjectId: string;
  deviceId: string;
  episodeId: string;
  /**
   * When consent passes (`optedIn`), snapshot is retained for export.
   * Missing / declined consent → discard.
   */
  consent?: SnapshotExportConsent | null;
  onTelemetry?: (e: SnapshotTelemetry) => void;
};

export type TeardownAtTerminalResult =
  | {
      ok: true;
      discarded: true;
      retained: false;
      alreadyDiscarded: boolean;
      backend: SnapshotBackendId;
    }
  | {
      ok: true;
      discarded: false;
      retained: true;
      snapshot: CognitiveRolloutSnapshot;
      backend: SnapshotBackendId;
    }
  | {
      ok: false;
      failureClass: SnapshotFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    };

/**
 * Repository pattern — in-memory for tests; postgres selected via env later.
 * Fleet-allocated stores expose a unique {@link rolloutId} per episode.
 */
export interface SnapshotStoreRepository {
  readonly backendId: SnapshotBackendId;
  /** Unique per-rollout instance id when allocated by the fleet. */
  readonly rolloutId?: string;
  cloneAtReset(input: CloneAtResetInput): CloneAtResetResult;
  get(input: GetSnapshotInput): GetSnapshotResult;
  put(input: PutSnapshotInput): PutSnapshotResult;
  /** Drop episode slot (used by terminal teardown when consent does not pass). */
  discard(input: DiscardSnapshotInput): DiscardSnapshotResult;
  /**
   * Episode-terminal teardown: discard unless export consent passes;
   * retain snapshot for consented export path.
   */
  teardownAtTerminal(input: TeardownAtTerminalInput): TeardownAtTerminalResult;
}
