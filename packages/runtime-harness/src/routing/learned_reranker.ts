/**
 * Runtime harness surface for learned routing re-rank behind a feature flag.
 *
 * Flag-off forces the deterministic B8 champion order (byte-stable).
 * Flag-on may apply the learned challenger re-rank within the B8 set only.
 * Shadow mode scores champion vs challenger while always serving champion —
 * no user-facing change until the routing gate promotes.
 */

import {
  RoutingTunerContractError,
  compareRoutingChampionChallenger,
  rerankRoutingCandidates,
  type B8RoutingCandidate,
  type RoutingContextFeatures,
  type RoutingRerankResult,
  type RoutingServingMode,
  type RoutingSliceScoreAccumulator,
  type RoutingShadowCompareResult,
} from "@moolam/learning";

export const LEARNED_ROUTING_FLAG =
  "runtime.harness.learned_routing" as const;
export const LEARNED_ROUTING_SCHEMA_VERSION =
  "runtime.harness.learned-routing.v1" as const;

export type LearnedRoutingPath = "champion" | "challenger";
export type LearnedRoutingServingMode = RoutingServingMode;

export type LearnedRoutingTelemetryEvent = {
  event: "runtime.harness.learned_routing";
  outcome: "ok" | "passthrough" | "fail" | "shadow";
  subjectId: string;
  deviceId: string;
  enabled: boolean;
  mode: LearnedRoutingServingMode;
  path: LearnedRoutingPath;
  /** Challenger observation path when shadowing (never served). */
  challengerPath?: LearnedRoutingPath;
  candidateCount: number;
  admittedCount: number;
  orderChanged: boolean;
  topMatch?: boolean;
  rankAgreement?: number;
  sliceId?: string;
  observationId?: string;
  championTopId?: string;
  challengerTopId?: string;
  failureClass?: string;
  topCandidateId?: string;
  idempotentReplay?: boolean;
};

export type LearnedRoutingRequest = {
  candidates: readonly B8RoutingCandidate[];
  context: RoutingContextFeatures;
  scoreThreshold?: number;
  expectedSubjectId?: string;
  sliceId?: string;
  observationId?: string;
  championHit?: boolean;
  challengerHit?: boolean;
};

export type LearnedRoutingResult = RoutingRerankResult & {
  path: LearnedRoutingPath;
  mode: LearnedRoutingServingMode;
  flag: typeof LEARNED_ROUTING_FLAG;
  /** Present in shadow mode — challenger observation only. */
  shadow?: Omit<RoutingShadowCompareResult, "served">;
};

export type CreateLearnedRoutingRerankerOptions = {
  /**
   * Feature flag. When false (default), mode is forced to champion.
   * When true without explicit mode, defaults to challenger serve.
   */
  enabled?: boolean;
  /** Explicit serving mode; overrides enabled default mapping. */
  mode?: LearnedRoutingServingMode;
  /** Optional per-slice accumulator for gate score feeds (shadow). */
  accumulator?: RoutingSliceScoreAccumulator;
  onTelemetry?: (event: LearnedRoutingTelemetryEvent) => void;
};

function resolveMode(
  options: CreateLearnedRoutingRerankerOptions,
): LearnedRoutingServingMode {
  if (options.mode !== undefined) return options.mode;
  return options.enabled === true ? "challenger" : "champion";
}

/**
 * Feature-flagged routing re-ranker for the harness.
 * Deterministic B8 baseline remains permanently available behind the flag.
 * Shadow serves champion while logging challenger comparison telemetry.
 */
export function createLearnedRoutingReranker(
  options: CreateLearnedRoutingRerankerOptions = {},
): {
  readonly enabled: boolean;
  readonly mode: LearnedRoutingServingMode;
  rerank(request: LearnedRoutingRequest): LearnedRoutingResult;
} {
  const mode = resolveMode(options);
  const enabled = mode !== "champion";
  return {
    get enabled() {
      return enabled;
    },
    get mode() {
      return mode;
    },
    rerank(request: LearnedRoutingRequest): LearnedRoutingResult {
      const deviceId = request.context.deviceId ?? "unknown";
      try {
        if (mode === "shadow") {
          const compared = compareRoutingChampionChallenger({
            candidates: request.candidates,
            context: request.context,
            ...(request.scoreThreshold !== undefined
              ? { scoreThreshold: request.scoreThreshold }
              : {}),
            ...(request.expectedSubjectId !== undefined
              ? { expectedSubjectId: request.expectedSubjectId }
              : {}),
            ...(request.sliceId !== undefined
              ? { sliceId: request.sliceId }
              : {}),
            ...(request.observationId !== undefined
              ? { observationId: request.observationId }
              : {}),
            ...(request.championHit !== undefined
              ? { championHit: request.championHit }
              : {}),
            ...(request.challengerHit !== undefined
              ? { challengerHit: request.challengerHit }
              : {}),
            ...(options.accumulator !== undefined
              ? { accumulator: options.accumulator }
              : {}),
          });
          options.onTelemetry?.({
            event: "runtime.harness.learned_routing",
            outcome:
              compared.championOrderedIds.length === 0
                ? "passthrough"
                : "shadow",
            subjectId: compared.subjectId,
            deviceId,
            enabled: true,
            mode,
            path: "champion",
            challengerPath: compared.orderChanged
              ? "challenger"
              : "champion",
            candidateCount: request.candidates.length,
            admittedCount: compared.championOrderedIds.length,
            orderChanged: compared.orderChanged,
            topMatch: compared.topMatch,
            rankAgreement: compared.rankAgreement,
            ...(compared.sliceId !== undefined
              ? { sliceId: compared.sliceId }
              : {}),
            ...(compared.observationId !== undefined
              ? { observationId: compared.observationId }
              : {}),
            ...(compared.championOrderedIds[0] !== undefined
              ? {
                  championTopId: compared.championOrderedIds[0],
                  topCandidateId: compared.championOrderedIds[0],
                }
              : {}),
            ...(compared.challengerOrderedIds[0] !== undefined
              ? { challengerTopId: compared.challengerOrderedIds[0] }
              : {}),
            ...(compared.idempotentReplay
              ? { idempotentReplay: true }
              : {}),
          });
          const { served, ...shadow } = compared;
          return {
            ...served,
            path: "champion",
            mode,
            flag: LEARNED_ROUTING_FLAG,
            shadow,
          };
        }

        const tuned = rerankRoutingCandidates({
          candidates: request.candidates,
          context: request.context,
          enabled: mode === "challenger",
          ...(request.scoreThreshold !== undefined
            ? { scoreThreshold: request.scoreThreshold }
            : {}),
          ...(request.expectedSubjectId !== undefined
            ? { expectedSubjectId: request.expectedSubjectId }
            : {}),
        });
        const path: LearnedRoutingPath =
          mode === "challenger" && tuned.orderChanged
            ? "challenger"
            : "champion";
        options.onTelemetry?.({
          event: "runtime.harness.learned_routing",
          outcome:
            tuned.candidates.length === 0
              ? "passthrough"
              : mode === "challenger"
                ? "ok"
                : "passthrough",
          subjectId: tuned.subjectId,
          deviceId,
          enabled: mode === "challenger",
          mode,
          path,
          candidateCount: request.candidates.length,
          admittedCount: tuned.candidates.length,
          orderChanged: tuned.orderChanged,
          ...(tuned.orderedCandidateIds[0] !== undefined
            ? { topCandidateId: tuned.orderedCandidateIds[0] }
            : {}),
        });
        return {
          ...tuned,
          path,
          mode,
          flag: LEARNED_ROUTING_FLAG,
        };
      } catch (error) {
        const failureClass =
          error instanceof RoutingTunerContractError
            ? error.obligation
            : "routing_tuner.invalid_input";
        options.onTelemetry?.({
          event: "runtime.harness.learned_routing",
          outcome: "fail",
          subjectId: request.context.subjectId,
          deviceId,
          enabled,
          mode,
          path: "champion",
          candidateCount: request.candidates.length,
          admittedCount: 0,
          orderChanged: false,
          failureClass,
        });
        throw error;
      }
    },
  };
}

/**
 * Convenience one-shot entry used by hosts and tests.
 */
export function rerankRoutingWithFeatureFlag(
  request: LearnedRoutingRequest & {
    enabled?: boolean;
    mode?: LearnedRoutingServingMode;
    accumulator?: RoutingSliceScoreAccumulator;
    onTelemetry?: (event: LearnedRoutingTelemetryEvent) => void;
  },
): LearnedRoutingResult {
  const reranker = createLearnedRoutingReranker({
    enabled: request.enabled === true,
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
    ...(request.accumulator !== undefined
      ? { accumulator: request.accumulator }
      : {}),
    ...(request.onTelemetry !== undefined
      ? { onTelemetry: request.onTelemetry }
      : {}),
  });
  return reranker.rerank(request);
}
