/**
 * Learned routing re-ranker behind a feature flag (C6).
 *
 * Flag-off returns the deterministic B8 candidate order unchanged.
 * Flag-on re-ranks only within that candidate set — never invents routes.
 * Empty input falls through to an empty B8 default (no hallucinated connectors).
 *
 * Shadow comparison logs champion vs challenger rankings without serving the
 * challenger — no user-facing change until the routing gate promotes.
 */

export const ROUTING_TUNER_SCHEMA_VERSION = "learning.routing-tuner.v1" as const;
export const ROUTING_TUNER_CANDIDATE_LIMIT = 64;
export const ROUTING_TUNER_FEATURE_LIMIT = 16;
export const ROUTING_TUNER_ID_LIMIT = 128;
export const B8_ROUTING_SCORE_THRESHOLD_DEFAULT = 0.0;
/** Bound on distinct eval slices retained per subject for gate accumulation. */
export const ROUTING_SLICE_ACCUMULATOR_LIMIT = 64;
/** Bound on observations retained per slice (idempotent by observationId). */
export const ROUTING_SLICE_OBSERVATION_LIMIT = 10_000;

export type RoutingCandidateKind = "retrieval" | "guidance";

export type B8RoutingCandidate = {
  candidateId: string;
  kind: RoutingCandidateKind;
  /** Deterministic B8 score in [0, 1]. */
  score: number;
};

export type RoutingContextFeatures = {
  subjectId: string;
  deviceId?: string;
  locality: "on-device" | "self-hosted";
  /**
   * Bounded numeric features for learned re-ranking (metadata grade).
   * Never raw learner content.
   */
  features?: Readonly<Record<string, number>>;
  /** Optional MoE replay map — dense SLMs may omit. */
  routerReplayMap?: Readonly<Record<string, string>>;
};

export type RoutingTunerFailureClass =
  | "routing_tuner.invalid_input"
  | "routing_tuner.subject_scope"
  | "routing_tuner.locality_forbidden"
  | "routing_tuner.capacity"
  | "routing_tuner.invented_route"
  | "routing_tuner.idempotent_conflict";

/** Serving modes — shadow always serves champion while scoring challenger. */
export type RoutingServingMode = "champion" | "challenger" | "shadow";

export type RoutingTunerTelemetryEvent = {
  event: "learning.routing_tuner.rerank";
  outcome: "ok" | "fail" | "passthrough";
  subjectId: string;
  deviceId: string;
  enabled: boolean;
  candidateCount: number;
  admittedCount: number;
  orderChanged: boolean;
  failureClass?: RoutingTunerFailureClass;
  /** Candidate ids only — never scores as content, never utterance bodies. */
  topCandidateId?: string;
};

/**
 * Champion/challenger comparison on shadow traffic — ids and scores only,
 * never utterance bodies or raw learner content.
 */
export type RoutingComparisonTelemetryEvent = {
  event: "learning.routing_tuner.comparison";
  outcome: "shadow" | "ok" | "fail" | "passthrough";
  subjectId: string;
  deviceId: string;
  mode: RoutingServingMode;
  /** Path actually served to the user. */
  servedPath: "champion" | "challenger";
  sliceId?: string;
  observationId?: string;
  championTopId?: string;
  challengerTopId?: string;
  orderChanged: boolean;
  topMatch: boolean;
  /** Fraction of positions with matching candidate ids [0, 1]. */
  rankAgreement: number;
  candidateCount: number;
  admittedCount: number;
  idempotentReplay?: boolean;
  failureClass?: RoutingTunerFailureClass;
};

export type RoutingSliceScoreTelemetryEvent = {
  event: "learning.routing_tuner.slice_score";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  sliceId?: string;
  observationId?: string;
  sampleCount?: number;
  championScore?: number;
  challengerScore?: number;
  delta?: number;
  status?: "ahead" | "behind" | "tie";
  idempotentReplay?: boolean;
  failureClass?: RoutingTunerFailureClass;
};

export class RoutingTunerContractError extends Error {
  readonly obligation: RoutingTunerFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: RoutingTunerFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "RoutingTunerContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

export type RoutingRerankResult = {
  schemaVersion: typeof ROUTING_TUNER_SCHEMA_VERSION;
  enabled: boolean;
  subjectId: string;
  /** Final ordered candidate ids (subset of B8-admitted set). */
  orderedCandidateIds: string[];
  candidates: B8RoutingCandidate[];
  /** True when flag-on produced a different order than B8. */
  orderChanged: boolean;
  /** Present when MoE map was supplied; omitted for dense SLMs. */
  routerReplayMap?: Record<string, string>;
};

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
/** Eval slice ids: domainPackId/language/bindingId — three bounded segments. */
const SLICE_ID_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,31}\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new RoutingTunerContractError(`${field} must be a bounded id`, {
      obligation: "routing_tuner.invalid_input",
    });
  }
  return value;
}

function requireSliceId(value: unknown): string {
  if (typeof value !== "string" || !SLICE_ID_RE.test(value)) {
    throw new RoutingTunerContractError(
      "sliceId must be domainPackId/language/bindingId",
      { obligation: "routing_tuner.invalid_input" },
    );
  }
  return value;
}

/**
 * Deterministic B8 baseline: admit scores ≥ threshold, sort by score desc,
 * break ties by candidateId ascending. Never invents candidates.
 */
export function rankB8RoutingCandidates(
  candidates: readonly B8RoutingCandidate[],
  options?: { scoreThreshold?: number },
): B8RoutingCandidate[] {
  const threshold = options?.scoreThreshold ?? B8_ROUTING_SCORE_THRESHOLD_DEFAULT;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new RoutingTunerContractError(
      "B8 scoreThreshold must be a finite number in [0, 1]",
      { obligation: "routing_tuner.invalid_input" },
    );
  }
  if (!Array.isArray(candidates)) {
    throw new RoutingTunerContractError("candidates must be an array", {
      obligation: "routing_tuner.invalid_input",
    });
  }
  if (candidates.length > ROUTING_TUNER_CANDIDATE_LIMIT) {
    throw new RoutingTunerContractError(
      `candidates exceed ${ROUTING_TUNER_CANDIDATE_LIMIT}`,
      { obligation: "routing_tuner.capacity" },
    );
  }
  if (candidates.length === 0) return [];

  const seen = new Set<string>();
  const admitted: B8RoutingCandidate[] = [];
  for (const candidate of candidates) {
    const candidateId = requireId(candidate.candidateId, "candidateId");
    if (seen.has(candidateId)) {
      throw new RoutingTunerContractError(
        `duplicate candidateId ${candidateId}`,
        { obligation: "routing_tuner.invalid_input" },
      );
    }
    seen.add(candidateId);
    if (candidate.kind !== "retrieval" && candidate.kind !== "guidance") {
      throw new RoutingTunerContractError(
        `candidate ${candidateId} kind must be retrieval|guidance`,
        { obligation: "routing_tuner.invalid_input" },
      );
    }
    if (
      typeof candidate.score !== "number" ||
      !Number.isFinite(candidate.score) ||
      candidate.score < 0 ||
      candidate.score > 1
    ) {
      throw new RoutingTunerContractError(
        `candidate ${candidateId} score must be finite in [0, 1]`,
        { obligation: "routing_tuner.invalid_input" },
      );
    }
    if (candidate.score >= threshold) {
      admitted.push({
        candidateId,
        kind: candidate.kind,
        score: candidate.score,
      });
    }
  }

  return admitted.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidateId < b.candidateId
      ? -1
      : a.candidateId > b.candidateId
        ? 1
        : 0;
  });
}

function learnedAdjustedScore(
  candidate: B8RoutingCandidate,
  features: Readonly<Record<string, number>>,
): number {
  // Deterministic, bounded adjustment — training adapters may replace weights later.
  // Named affinities (`prefer.<id>`, `boost.<kind>`) dominate generic feature mixing.
  let bias = 0;
  const prefer = features[`prefer.${candidate.candidateId}`];
  if (typeof prefer === "number") bias += prefer;
  const kindBoost = features[`boost.${candidate.kind}`];
  if (typeof kindBoost === "number") bias += kindBoost;
  const keys = Object.keys(features).sort();
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    if (key.startsWith("prefer.") || key.startsWith("boost.")) continue;
    const value = features[key]!;
    const idHash = candidate.candidateId.length + key.length + i;
    bias += value * ((idHash % 7) - 3) * 0.01;
  }
  return candidate.score + bias;
}

/**
 * Re-rank within an already-admitted B8 set. Never adds or drops ids.
 */
export function reRankWithinB8Set(
  admitted: readonly B8RoutingCandidate[],
  features: Readonly<Record<string, number>>,
): B8RoutingCandidate[] {
  if (admitted.length === 0) return [];
  return [...admitted].sort((a, b) => {
    const sa = learnedAdjustedScore(a, features);
    const sb = learnedAdjustedScore(b, features);
    if (sb !== sa) return sb - sa;
    return a.candidateId < b.candidateId
      ? -1
      : a.candidateId > b.candidateId
        ? 1
        : 0;
  });
}

function assertSameCandidateSet(
  baseline: readonly B8RoutingCandidate[],
  reranked: readonly B8RoutingCandidate[],
  subjectId: string,
  deviceId: string,
): void {
  if (baseline.length !== reranked.length) {
    throw new RoutingTunerContractError(
      "learned tuner must not invent or drop routes",
      {
        obligation: "routing_tuner.invented_route",
        subjectId,
        deviceId,
      },
    );
  }
  const baseIds = new Set(baseline.map((c) => c.candidateId));
  for (const candidate of reranked) {
    if (!baseIds.has(candidate.candidateId)) {
      throw new RoutingTunerContractError(
        `learned tuner invented route ${candidate.candidateId}`,
        {
          obligation: "routing_tuner.invented_route",
          subjectId,
          deviceId,
        },
      );
    }
  }
}

/**
 * Feature-flagged routing re-ranker.
 * `enabled: false` (default) ⇒ byte-stable B8 order.
 */
export function rerankRoutingCandidates(input: {
  candidates: readonly B8RoutingCandidate[];
  context: RoutingContextFeatures;
  enabled?: boolean;
  scoreThreshold?: number;
  expectedSubjectId?: string;
  onTelemetry?: (event: RoutingTunerTelemetryEvent) => void;
}): RoutingRerankResult {
  const enabled = input.enabled === true;
  const subjectId = requireId(input.context.subjectId, "subjectId");
  const deviceId =
    input.context.deviceId === undefined
      ? "unknown"
      : requireId(input.context.deviceId, "deviceId");

  if (
    input.context.locality !== "on-device" &&
    input.context.locality !== "self-hosted"
  ) {
    input.onTelemetry?.({
      event: "learning.routing_tuner.rerank",
      outcome: "fail",
      subjectId,
      deviceId,
      enabled,
      candidateCount: Array.isArray(input.candidates) ? input.candidates.length : 0,
      admittedCount: 0,
      orderChanged: false,
      failureClass: "routing_tuner.locality_forbidden",
    });
    throw new RoutingTunerContractError(
      "routing locality must be on-device or self-hosted",
      {
        obligation: "routing_tuner.locality_forbidden",
        subjectId,
        deviceId,
      },
    );
  }

  if (
    input.expectedSubjectId !== undefined &&
    input.expectedSubjectId !== subjectId
  ) {
    input.onTelemetry?.({
      event: "learning.routing_tuner.rerank",
      outcome: "fail",
      subjectId,
      deviceId,
      enabled,
      candidateCount: Array.isArray(input.candidates) ? input.candidates.length : 0,
      admittedCount: 0,
      orderChanged: false,
      failureClass: "routing_tuner.subject_scope",
    });
    throw new RoutingTunerContractError(
      "cross-subject routing re-rank denied",
      {
        obligation: "routing_tuner.subject_scope",
        subjectId,
        deviceId,
      },
    );
  }

  const features = input.context.features ?? {};
  const featureKeys = Object.keys(features);
  if (featureKeys.length > ROUTING_TUNER_FEATURE_LIMIT) {
    throw new RoutingTunerContractError(
      `context features exceed ${ROUTING_TUNER_FEATURE_LIMIT}`,
      { obligation: "routing_tuner.capacity", subjectId, deviceId },
    );
  }
  for (const key of featureKeys) {
    if (key.length === 0 || key.length > ROUTING_TUNER_ID_LIMIT) {
      throw new RoutingTunerContractError("feature key must be bounded", {
        obligation: "routing_tuner.invalid_input",
        subjectId,
        deviceId,
      });
    }
    const value = features[key];
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e6) {
      throw new RoutingTunerContractError(
        `feature ${key} must be a bounded finite number`,
        { obligation: "routing_tuner.invalid_input", subjectId, deviceId },
      );
    }
  }

  let routerReplayMap: Record<string, string> | undefined;
  if (input.context.routerReplayMap !== undefined) {
    const entries = Object.entries(input.context.routerReplayMap);
    if (entries.length > ROUTING_TUNER_FEATURE_LIMIT) {
      throw new RoutingTunerContractError("routerReplayMap exceeds bound", {
        obligation: "routing_tuner.capacity",
        subjectId,
        deviceId,
      });
    }
    routerReplayMap = {};
    for (const [key, value] of entries) {
      requireId(key, "routerReplayMap.key");
      requireId(value, "routerReplayMap.value");
      routerReplayMap[key] = value;
    }
  }

  const baseline = rankB8RoutingCandidates(input.candidates, {
    ...(input.scoreThreshold !== undefined
      ? { scoreThreshold: input.scoreThreshold }
      : {}),
  });

  if (baseline.length === 0) {
    input.onTelemetry?.({
      event: "learning.routing_tuner.rerank",
      outcome: "passthrough",
      subjectId,
      deviceId,
      enabled,
      candidateCount: input.candidates.length,
      admittedCount: 0,
      orderChanged: false,
    });
    return {
      schemaVersion: ROUTING_TUNER_SCHEMA_VERSION,
      enabled,
      subjectId,
      orderedCandidateIds: [],
      candidates: [],
      orderChanged: false,
      ...(routerReplayMap !== undefined ? { routerReplayMap } : {}),
    };
  }

  let ordered = baseline;
  if (enabled) {
    ordered = reRankWithinB8Set(baseline, features);
    assertSameCandidateSet(baseline, ordered, subjectId, deviceId);
  }

  const orderChanged =
    enabled &&
    ordered.some(
      (candidate, index) =>
        candidate.candidateId !== baseline[index]?.candidateId,
    );

  input.onTelemetry?.({
    event: "learning.routing_tuner.rerank",
    outcome: enabled ? "ok" : "passthrough",
    subjectId,
    deviceId,
    enabled,
    candidateCount: input.candidates.length,
    admittedCount: ordered.length,
    orderChanged,
    ...(ordered[0] !== undefined
      ? { topCandidateId: ordered[0].candidateId }
      : {}),
  });

  return {
    schemaVersion: ROUTING_TUNER_SCHEMA_VERSION,
    enabled,
    subjectId,
    orderedCandidateIds: ordered.map((c) => c.candidateId),
    candidates: ordered,
    orderChanged,
    ...(routerReplayMap !== undefined ? { routerReplayMap } : {}),
  };
}

function rankAgreement(
  championIds: readonly string[],
  challengerIds: readonly string[],
): number {
  if (championIds.length === 0) return 1;
  let matches = 0;
  for (let i = 0; i < championIds.length; i += 1) {
    if (championIds[i] === challengerIds[i]) matches += 1;
  }
  return matches / championIds.length;
}

export type RoutingShadowCompareResult = {
  schemaVersion: typeof ROUTING_TUNER_SCHEMA_VERSION;
  mode: "shadow";
  subjectId: string;
  /** Invariant: always champion — challenger is observation-only until promotion. */
  servedPath: "champion";
  /** User-facing ranking — byte-stable B8 order. */
  served: RoutingRerankResult;
  championOrderedIds: string[];
  challengerOrderedIds: string[];
  orderChanged: boolean;
  topMatch: boolean;
  rankAgreement: number;
  sliceId?: string;
  observationId?: string;
  idempotentReplay: boolean;
};

/**
 * Shadow traffic: compute deterministic vs learned rankings, serve champion only.
 * Optional slice observation feeds the gate accumulator — never promotes here.
 */
export function compareRoutingChampionChallenger(input: {
  candidates: readonly B8RoutingCandidate[];
  context: RoutingContextFeatures;
  scoreThreshold?: number;
  expectedSubjectId?: string;
  sliceId?: string;
  observationId?: string;
  /**
   * Guidance-eval hit signals for gate accumulation (optional).
   * When omitted, accumulator records ranking agreement only (hits stay 0).
   */
  championHit?: boolean;
  challengerHit?: boolean;
  accumulator?: RoutingSliceScoreAccumulator;
  onTelemetry?: (event: RoutingComparisonTelemetryEvent) => void;
}): RoutingShadowCompareResult {
  const champion = rerankRoutingCandidates({
    candidates: input.candidates,
    context: input.context,
    enabled: false,
    ...(input.scoreThreshold !== undefined
      ? { scoreThreshold: input.scoreThreshold }
      : {}),
    ...(input.expectedSubjectId !== undefined
      ? { expectedSubjectId: input.expectedSubjectId }
      : {}),
  });
  const challenger = rerankRoutingCandidates({
    candidates: input.candidates,
    context: input.context,
    enabled: true,
    ...(input.scoreThreshold !== undefined
      ? { scoreThreshold: input.scoreThreshold }
      : {}),
    ...(input.expectedSubjectId !== undefined
      ? { expectedSubjectId: input.expectedSubjectId }
      : {}),
  });

  const championOrderedIds = champion.orderedCandidateIds;
  const challengerOrderedIds = challenger.orderedCandidateIds;
  assertSameCandidateSet(
    champion.candidates,
    challenger.candidates,
    champion.subjectId,
    input.context.deviceId ?? "unknown",
  );

  const orderChanged = championOrderedIds.some(
    (id, index) => id !== challengerOrderedIds[index],
  );
  const topMatch =
    championOrderedIds[0] === challengerOrderedIds[0] ||
    championOrderedIds.length === 0;
  const agreement = rankAgreement(championOrderedIds, challengerOrderedIds);
  const deviceId = input.context.deviceId ?? "unknown";
  const sliceId =
    input.sliceId === undefined ? undefined : requireSliceId(input.sliceId);
  const observationId =
    input.observationId === undefined
      ? undefined
      : requireId(input.observationId, "observationId");

  let idempotentReplay = false;
  if (input.accumulator !== undefined && sliceId !== undefined) {
    const recorded = input.accumulator.record({
      subjectId: champion.subjectId,
      deviceId,
      sliceId,
      ...(observationId !== undefined ? { observationId } : {}),
      orderChanged,
      topMatch,
      ...(input.championHit !== undefined
        ? { championHit: input.championHit }
        : {}),
      ...(input.challengerHit !== undefined
        ? { challengerHit: input.challengerHit }
        : {}),
    });
    idempotentReplay = recorded.idempotentReplay;
  }

  const outcome: RoutingComparisonTelemetryEvent["outcome"] =
    championOrderedIds.length === 0 ? "passthrough" : "shadow";

  input.onTelemetry?.({
    event: "learning.routing_tuner.comparison",
    outcome,
    subjectId: champion.subjectId,
    deviceId,
    mode: "shadow",
    servedPath: "champion",
    ...(sliceId !== undefined ? { sliceId } : {}),
    ...(observationId !== undefined ? { observationId } : {}),
    ...(championOrderedIds[0] !== undefined
      ? { championTopId: championOrderedIds[0] }
      : {}),
    ...(challengerOrderedIds[0] !== undefined
      ? { challengerTopId: challengerOrderedIds[0] }
      : {}),
    orderChanged,
    topMatch,
    rankAgreement: agreement,
    candidateCount: input.candidates.length,
    admittedCount: championOrderedIds.length,
    ...(idempotentReplay ? { idempotentReplay: true } : {}),
  });

  return {
    schemaVersion: ROUTING_TUNER_SCHEMA_VERSION,
    mode: "shadow",
    subjectId: champion.subjectId,
    servedPath: "champion",
    served: champion,
    championOrderedIds: [...championOrderedIds],
    challengerOrderedIds: [...challengerOrderedIds],
    orderChanged,
    topMatch,
    rankAgreement: agreement,
    ...(sliceId !== undefined ? { sliceId } : {}),
    ...(observationId !== undefined ? { observationId } : {}),
    idempotentReplay,
  };
}

export type RoutingSliceObservation = {
  subjectId: string;
  deviceId?: string;
  sliceId: string;
  observationId?: string;
  orderChanged: boolean;
  topMatch: boolean;
  /** Guidance success if champion top were used. */
  championHit?: boolean;
  /** Guidance success if challenger top were used. */
  challengerHit?: boolean;
};

export type RoutingSliceScoreRow = {
  sliceId: string;
  sampleCount: number;
  orderChangedCount: number;
  topMatchCount: number;
  championHits: number;
  challengerHits: number;
  /** Hit rate [0, 1] for gate consumption. */
  championScore: number;
  challengerScore: number;
  /** challengerScore - championScore; ties do not promote. */
  delta: number;
  status: "ahead" | "behind" | "tie";
};

export type RoutingSliceScoreAccumulator = {
  record(observation: RoutingSliceObservation): { idempotentReplay: boolean };
  snapshot(subjectId: string): RoutingSliceScoreRow[];
  /** Maps for the routing promotion gate — this API never promotes. */
  scoresForGate(subjectId: string): {
    championScores: Record<string, number>;
    challengerScores: Record<string, number>;
  };
};

type SliceBucket = {
  observationIds: Set<string>;
  sampleCount: number;
  orderChangedCount: number;
  topMatchCount: number;
  championHits: number;
  challengerHits: number;
  hitSamples: number;
};

function rowFromBucket(sliceId: string, bucket: SliceBucket): RoutingSliceScoreRow {
  const championScore =
    bucket.hitSamples === 0 ? 0 : bucket.championHits / bucket.hitSamples;
  const challengerScore =
    bucket.hitSamples === 0 ? 0 : bucket.challengerHits / bucket.hitSamples;
  const delta = challengerScore - championScore;
  const status: RoutingSliceScoreRow["status"] =
    delta > 0 ? "ahead" : delta < 0 ? "behind" : "tie";
  return {
    sliceId,
    sampleCount: bucket.sampleCount,
    orderChangedCount: bucket.orderChangedCount,
    topMatchCount: bucket.topMatchCount,
    championHits: bucket.championHits,
    challengerHits: bucket.challengerHits,
    championScore,
    challengerScore,
    delta,
    status,
  };
}

/**
 * Subject-scoped per-slice score accumulator for the routing gate.
 * Shadow traffic feeds this; promotion remains a separate gate decision.
 */
export function createRoutingSliceScoreAccumulator(options?: {
  expectedSubjectId?: string;
  onTelemetry?: (event: RoutingSliceScoreTelemetryEvent) => void;
}): RoutingSliceScoreAccumulator {
  /** subjectId → sliceId → bucket */
  const bySubject = new Map<string, Map<string, SliceBucket>>();

  return {
    record(observation: RoutingSliceObservation): { idempotentReplay: boolean } {
      const subjectId = requireId(observation.subjectId, "subjectId");
      const deviceId =
        observation.deviceId === undefined
          ? "unknown"
          : requireId(observation.deviceId, "deviceId");
      const sliceId = requireSliceId(observation.sliceId);

      if (
        options?.expectedSubjectId !== undefined &&
        options.expectedSubjectId !== subjectId
      ) {
        options.onTelemetry?.({
          event: "learning.routing_tuner.slice_score",
          outcome: "fail",
          subjectId,
          deviceId,
          sliceId,
          failureClass: "routing_tuner.subject_scope",
        });
        throw new RoutingTunerContractError(
          "cross-subject routing slice score denied",
          {
            obligation: "routing_tuner.subject_scope",
            subjectId,
            deviceId,
          },
        );
      }

      let slices = bySubject.get(subjectId);
      if (slices === undefined) {
        slices = new Map();
        bySubject.set(subjectId, slices);
      }

      let bucket = slices.get(sliceId);
      if (bucket === undefined) {
        if (slices.size >= ROUTING_SLICE_ACCUMULATOR_LIMIT) {
          options?.onTelemetry?.({
            event: "learning.routing_tuner.slice_score",
            outcome: "fail",
            subjectId,
            deviceId,
            sliceId,
            failureClass: "routing_tuner.capacity",
          });
          throw new RoutingTunerContractError(
            `routing slice accumulator exceeds ${ROUTING_SLICE_ACCUMULATOR_LIMIT}`,
            { obligation: "routing_tuner.capacity", subjectId, deviceId },
          );
        }
        bucket = {
          observationIds: new Set(),
          sampleCount: 0,
          orderChangedCount: 0,
          topMatchCount: 0,
          championHits: 0,
          challengerHits: 0,
          hitSamples: 0,
        };
        slices.set(sliceId, bucket);
      }

      if (observation.observationId !== undefined) {
        const observationId = requireId(
          observation.observationId,
          "observationId",
        );
        if (bucket.observationIds.has(observationId)) {
          const row = rowFromBucket(sliceId, bucket);
          options?.onTelemetry?.({
            event: "learning.routing_tuner.slice_score",
            outcome: "advisory",
            subjectId,
            deviceId,
            sliceId,
            observationId,
            sampleCount: row.sampleCount,
            championScore: row.championScore,
            challengerScore: row.challengerScore,
            delta: row.delta,
            status: row.status,
            idempotentReplay: true,
          });
          return { idempotentReplay: true };
        }
        if (bucket.observationIds.size >= ROUTING_SLICE_OBSERVATION_LIMIT) {
          options?.onTelemetry?.({
            event: "learning.routing_tuner.slice_score",
            outcome: "fail",
            subjectId,
            deviceId,
            sliceId,
            observationId,
            failureClass: "routing_tuner.capacity",
          });
          throw new RoutingTunerContractError(
            `routing slice observations exceed ${ROUTING_SLICE_OBSERVATION_LIMIT}`,
            { obligation: "routing_tuner.capacity", subjectId, deviceId },
          );
        }
        bucket.observationIds.add(observationId);
      }

      bucket.sampleCount += 1;
      if (observation.orderChanged) bucket.orderChangedCount += 1;
      if (observation.topMatch) bucket.topMatchCount += 1;
      if (
        observation.championHit !== undefined ||
        observation.challengerHit !== undefined
      ) {
        bucket.hitSamples += 1;
        if (observation.championHit === true) bucket.championHits += 1;
        if (observation.challengerHit === true) bucket.challengerHits += 1;
      }

      const row = rowFromBucket(sliceId, bucket);
      options?.onTelemetry?.({
        event: "learning.routing_tuner.slice_score",
        outcome: "ok",
        subjectId,
        deviceId,
        sliceId,
        ...(observation.observationId !== undefined
          ? { observationId: observation.observationId }
          : {}),
        sampleCount: row.sampleCount,
        championScore: row.championScore,
        challengerScore: row.challengerScore,
        delta: row.delta,
        status: row.status,
      });
      return { idempotentReplay: false };
    },

    snapshot(subjectId: string): RoutingSliceScoreRow[] {
      const id = requireId(subjectId, "subjectId");
      const slices = bySubject.get(id);
      if (slices === undefined) return [];
      return [...slices.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([sliceId, bucket]) => rowFromBucket(sliceId, bucket));
    },

    scoresForGate(subjectId: string): {
      championScores: Record<string, number>;
      challengerScores: Record<string, number>;
    } {
      const rows = this.snapshot(subjectId);
      const championScores: Record<string, number> = {};
      const challengerScores: Record<string, number> = {};
      for (const row of rows) {
        championScores[row.sliceId] = row.championScore;
        challengerScores[row.sliceId] = row.challengerScore;
      }
      return { championScores, challengerScores };
    },
  };
}
