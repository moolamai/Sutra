/**
 * Promotion gate for learned routing against frozen B8 guidance evals.
 *
 * The gate is metadata-only: candidates receive scenario ids, case ids,
 * thresholds, and pinned seeds, never raw learner content. Every scenario must
 * pass, every slice must avoid regression, and aggregate ties are rejected.
 */

export const ROUTING_GATE_SCHEMA_VERSION = "routing-gate.v1" as const;
export const ROUTING_PROMOTION_VERDICT_SCHEMA_VERSION =
  "routing-promotion-verdict.v1" as const;
export const B8_GUIDANCE_SUITE_ID = "b8.guidance.routing-gate.v1" as const;
export const ROUTING_GATE_SCENARIO_LIMIT = 64;
export const ROUTING_GATE_CASE_LIMIT = 64;
export const ROUTING_GATE_RUN_CACHE_LIMIT = 32;
export const ROUTING_GATE_TIMEOUT_MS_DEFAULT = 2_000;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const SLICE_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,31}\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const EPSILON = 1e-9;

export type RoutingGateFailureClass =
  | "routing_gate.invalid_suite"
  | "routing_gate.invalid_candidate"
  | "routing_gate.invalid_observation"
  | "routing_gate.subject_scope"
  | "routing_gate.locality_forbidden"
  | "routing_gate.train_on_eval_void"
  | "routing_gate.attribution_void"
  | "routing_gate.downstream_timeout"
  | "routing_gate.evaluator_failure"
  | "routing_gate.idempotent_conflict"
  | "routing_gate.ci_flag_off_parity"
  | "routing_gate.ci_promote_expected"
  | "routing_gate.ci_reject_expected"
  | "routing_gate.ci_replay_mismatch"
  | "routing_gate.ci_attribution_void";

export type RoutingGateRejectReason =
  | "champion_invalid"
  | "challenger_threshold_failed"
  | "slice_regression"
  | "tie";

export type B8GuidanceEvalCase = {
  caseId: string;
  expectedOutcome: string;
};

export type B8GuidanceEvalScenario = {
  scenarioId: string;
  sliceId: string;
  pinnedSeed: number;
  rubricAspect: string;
  threshold: number;
  cases: readonly B8GuidanceEvalCase[];
  sourceContentHash: string;
};

export type B8GuidanceEvalSuite = {
  schemaVersion: typeof ROUTING_GATE_SCHEMA_VERSION;
  suiteId: typeof B8_GUIDANCE_SUITE_ID;
  subjectId: string;
  locality: "on-device" | "self-hosted";
  frozen: true;
  heldOut: true;
  decontaminated: true;
  excludeFromTrainingCorpora: true;
  manifestContentHash: string;
  suiteContentHash: string;
  surgeryClasses: readonly ["learned_routing"];
  scenarios: readonly B8GuidanceEvalScenario[];
};

export type RoutingGateObservation = {
  scenarioId: string;
  subjectId: string;
  pinnedSeed: number;
  score: number;
  evaluatedCaseIds: string[];
};

export type RoutingGateCandidateEvaluator = {
  candidateId: string;
  subjectId: string;
  locality: "on-device" | "self-hosted";
  evaluate(
    scenario: B8GuidanceEvalScenario,
    signal: AbortSignal,
  ): RoutingGateObservation | Promise<RoutingGateObservation>;
};

export type RoutingGateScenarioVerdict = {
  scenarioId: string;
  sliceId: string;
  championScore: number;
  challengerScore: number;
  threshold: number;
  delta: number;
  championPasses: boolean;
  challengerPasses: boolean;
};

export type RoutingGateSliceVerdict = {
  sliceId: string;
  championScore: number;
  challengerScore: number;
  delta: number;
  status: "ahead" | "behind" | "tie";
  scenarioCount: number;
};

type RoutingPromotionVerdictBase = {
  schemaVersion: typeof ROUTING_PROMOTION_VERDICT_SCHEMA_VERSION;
  suiteId: typeof B8_GUIDANCE_SUITE_ID;
  suiteContentHash: string;
  subjectId: string;
  championId: string;
  challengerId: string;
  aggregateChampionScore: number;
  aggregateChallengerScore: number;
  aggregateDelta: number;
  scenarios: RoutingGateScenarioVerdict[];
  slices: RoutingGateSliceVerdict[];
  idempotentReplay: boolean;
};

export type RoutingPromotionVerdict =
  | (RoutingPromotionVerdictBase & {
      verdict: "promote";
      promoted: true;
      failingSlice: null;
      failingScenarioIds: [];
    })
  | (RoutingPromotionVerdictBase & {
      verdict: "reject";
      promoted: false;
      reason: RoutingGateRejectReason;
      failingSlice: string;
      failingScenarioIds: string[];
    });

export type RoutingPromotionTelemetryEvent = {
  event:
    | "learning.routing_gate.scenario"
    | "learning.routing_gate.slice"
    | "learning.routing_gate.verdict";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  suiteId: typeof B8_GUIDANCE_SUITE_ID;
  suiteContentHash: string;
  championId: string;
  challengerId: string;
  scenarioId?: string;
  sliceId?: string;
  championScore?: number;
  challengerScore?: number;
  delta?: number;
  verdict?: "promote" | "reject";
  failingSlice?: string;
  failureClass?: RoutingGateFailureClass | RoutingGateRejectReason;
  idempotentReplay?: boolean;
};

export class RoutingGateContractError extends Error {
  readonly obligation: RoutingGateFailureClass;
  readonly subjectId: string;
  readonly deviceId: string;
  readonly failingSlice: string | undefined;
  readonly failingScenario: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: RoutingGateFailureClass;
      subjectId: string;
      deviceId: string;
      failingSlice?: string;
      failingScenario?: string;
    },
  ) {
    super(message);
    this.name = "RoutingGateContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
    this.failingScenario = meta.failingScenario;
  }
}

function canonicalSuite(suite: B8GuidanceEvalSuite): string {
  return JSON.stringify({
    schemaVersion: suite.schemaVersion,
    suiteId: suite.suiteId,
    subjectId: suite.subjectId,
    locality: suite.locality,
    frozen: suite.frozen,
    heldOut: suite.heldOut,
    decontaminated: suite.decontaminated,
    excludeFromTrainingCorpora: suite.excludeFromTrainingCorpora,
    manifestContentHash: suite.manifestContentHash,
    surgeryClasses: suite.surgeryClasses,
    scenarios: suite.scenarios,
  });
}

/** Deterministic non-cryptographic digest used only for in-memory consistency. */
export function computeRoutingSuiteFingerprint(
  suite: B8GuidanceEvalSuite,
): string {
  const text = canonicalSuite(suite);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function assembleB8GuidanceEvalSuite(input: {
  subjectId: string;
  locality: "on-device" | "self-hosted";
  manifestContentHash: string;
  scenarios: readonly B8GuidanceEvalScenario[];
  trainingCorpusContentHashes: readonly string[];
  surgeryClasses: readonly string[];
}): B8GuidanceEvalSuite {
  if (!ID_RE.test(input.subjectId)) {
    throw new RoutingGateContractError(
      "subjectId must be a bounded identifier",
      {
        obligation: "routing_gate.invalid_suite",
        subjectId: "unknown",
        deviceId: "assemble",
      },
    );
  }
  const subjectId = input.subjectId;
  if (
    input.locality !== "on-device" &&
    input.locality !== "self-hosted"
  ) {
    throw new RoutingGateContractError(
      "routing gate locality must remain on-device or self-hosted",
      {
        obligation: "routing_gate.locality_forbidden",
        subjectId,
        deviceId: "assemble",
      },
    );
  }
  if (
    !HASH_RE.test(input.manifestContentHash) ||
    input.scenarios.length < 1 ||
    input.scenarios.length > ROUTING_GATE_SCENARIO_LIMIT
  ) {
    throw new RoutingGateContractError(
      "routing gate requires a bounded frozen B8 guidance suite",
      {
        obligation: "routing_gate.invalid_suite",
        subjectId,
        deviceId: "assemble",
      },
    );
  }
  if (
    input.surgeryClasses.length !== 1 ||
    input.surgeryClasses[0] !== "learned_routing"
  ) {
    throw new RoutingGateContractError(
      "routing promotion requires exactly one learned-routing surgery",
      {
        obligation: "routing_gate.attribution_void",
        subjectId,
        deviceId: "assemble",
      },
    );
  }

  const trainingHashes = new Set(input.trainingCorpusContentHashes);
  const scenarioIds = new Set<string>();
  const validated = input.scenarios.map((scenario) => {
    if (
      !ID_RE.test(scenario.scenarioId) ||
      scenarioIds.has(scenario.scenarioId) ||
      !SLICE_RE.test(scenario.sliceId) ||
      !Number.isInteger(scenario.pinnedSeed) ||
      scenario.pinnedSeed < 0 ||
      !ID_RE.test(scenario.rubricAspect) ||
      !Number.isFinite(scenario.threshold) ||
      scenario.threshold < 0 ||
      scenario.threshold > 1 ||
      !HASH_RE.test(scenario.sourceContentHash) ||
      scenario.cases.length < 1 ||
      scenario.cases.length > ROUTING_GATE_CASE_LIMIT
    ) {
      throw new RoutingGateContractError(
        `invalid B8 guidance scenario ${scenario.scenarioId}`,
        {
          obligation: "routing_gate.invalid_suite",
          subjectId,
          deviceId: "assemble",
          failingSlice: scenario.sliceId,
          failingScenario: scenario.scenarioId,
        },
      );
    }
    scenarioIds.add(scenario.scenarioId);
    if (
      trainingHashes.has(input.manifestContentHash) ||
      trainingHashes.has(scenario.sourceContentHash)
    ) {
      throw new RoutingGateContractError(
        `training corpus collides with eval scenario ${scenario.scenarioId}`,
        {
          obligation: "routing_gate.train_on_eval_void",
          subjectId,
          deviceId: "assemble",
          failingSlice: scenario.sliceId,
          failingScenario: scenario.scenarioId,
        },
      );
    }
    const caseIds = new Set<string>();
    for (const evalCase of scenario.cases) {
      if (
        !ID_RE.test(evalCase.caseId) ||
        caseIds.has(evalCase.caseId) ||
        !ID_RE.test(evalCase.expectedOutcome)
      ) {
        throw new RoutingGateContractError(
          `invalid case in scenario ${scenario.scenarioId}`,
          {
            obligation: "routing_gate.invalid_suite",
            subjectId,
            deviceId: "assemble",
            failingSlice: scenario.sliceId,
            failingScenario: scenario.scenarioId,
          },
        );
      }
      caseIds.add(evalCase.caseId);
    }
    return Object.freeze({
      ...scenario,
      cases: Object.freeze(scenario.cases.map((entry) => Object.freeze({ ...entry }))),
    });
  });

  const draft = {
    schemaVersion: ROUTING_GATE_SCHEMA_VERSION,
    suiteId: B8_GUIDANCE_SUITE_ID,
    subjectId,
    locality: input.locality,
    frozen: true,
    heldOut: true,
    decontaminated: true,
    excludeFromTrainingCorpora: true,
    manifestContentHash: input.manifestContentHash,
    suiteContentHash: "",
    surgeryClasses: Object.freeze(["learned_routing"] as const),
    scenarios: Object.freeze(validated),
  } satisfies B8GuidanceEvalSuite;
  return Object.freeze({
    ...draft,
    suiteContentHash: computeRoutingSuiteFingerprint(draft),
  });
}

const OBSERVATION_KEYS = new Set([
  "scenarioId",
  "subjectId",
  "pinnedSeed",
  "score",
  "evaluatedCaseIds",
]);

function validateObservation(input: {
  observation: unknown;
  scenario: B8GuidanceEvalScenario;
  subjectId: string;
  deviceId: string;
}): RoutingGateObservation {
  const value = input.observation as Record<string, unknown> | null;
  const expectedCaseIds = input.scenario.cases
    .map((entry) => entry.caseId)
    .sort();
  const observedCaseIds = Array.isArray(value?.evaluatedCaseIds)
    ? [...value.evaluatedCaseIds].sort()
    : [];
  const valid =
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).every((key) => OBSERVATION_KEYS.has(key)) &&
    value.scenarioId === input.scenario.scenarioId &&
    value.pinnedSeed === input.scenario.pinnedSeed &&
    typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= 1 &&
    observedCaseIds.length === expectedCaseIds.length &&
    observedCaseIds.every((id, index) => id === expectedCaseIds[index]);
  if (!valid || value?.subjectId !== input.subjectId) {
    const obligation =
      value?.subjectId !== undefined && value.subjectId !== input.subjectId
        ? "routing_gate.subject_scope"
        : "routing_gate.invalid_observation";
    throw new RoutingGateContractError(
      `invalid routing observation for ${input.scenario.scenarioId}`,
      {
        obligation,
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        failingSlice: input.scenario.sliceId,
        failingScenario: input.scenario.scenarioId,
      },
    );
  }
  return {
    scenarioId: value.scenarioId as string,
    subjectId: value.subjectId as string,
    pinnedSeed: value.pinnedSeed as number,
    score: value.score as number,
    evaluatedCaseIds: observedCaseIds as string[],
  };
}

async function evaluateWithTimeout(input: {
  evaluator: RoutingGateCandidateEvaluator;
  scenario: B8GuidanceEvalScenario;
  timeoutMs: number;
  deviceId: string;
}): Promise<RoutingGateObservation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new RoutingGateContractError(
          `routing scenario ${input.scenario.scenarioId} timed out`,
          {
            obligation: "routing_gate.downstream_timeout",
            subjectId: input.evaluator.subjectId,
            deviceId: input.deviceId,
            failingSlice: input.scenario.sliceId,
            failingScenario: input.scenario.scenarioId,
          },
        ),
      );
    }, input.timeoutMs);
  });
  try {
    const observation = await Promise.race([
      Promise.resolve(
        input.evaluator.evaluate(input.scenario, controller.signal),
      ),
      timeout,
    ]);
    return validateObservation({
      observation,
      scenario: input.scenario,
      subjectId: input.evaluator.subjectId,
      deviceId: input.deviceId,
    });
  } catch (error) {
    if (error instanceof RoutingGateContractError) throw error;
    throw new RoutingGateContractError(
      `routing evaluator ${input.evaluator.candidateId} failed`,
      {
        obligation: "routing_gate.evaluator_failure",
        subjectId: input.evaluator.subjectId,
        deviceId: input.deviceId,
        failingSlice: input.scenario.sliceId,
        failingScenario: input.scenario.scenarioId,
      },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function buildSliceVerdicts(
  scenarios: readonly RoutingGateScenarioVerdict[],
): RoutingGateSliceVerdict[] {
  const buckets = new Map<
    string,
    { champion: number; challenger: number; count: number }
  >();
  for (const scenario of scenarios) {
    const bucket = buckets.get(scenario.sliceId) ?? {
      champion: 0,
      challenger: 0,
      count: 0,
    };
    bucket.champion += scenario.championScore;
    bucket.challenger += scenario.challengerScore;
    bucket.count += 1;
    buckets.set(scenario.sliceId, bucket);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sliceId, bucket]) => {
      const championScore = bucket.champion / bucket.count;
      const challengerScore = bucket.challenger / bucket.count;
      const delta = challengerScore - championScore;
      return {
        sliceId,
        championScore,
        challengerScore,
        delta,
        status:
          delta > EPSILON
            ? ("ahead" as const)
            : delta < -EPSILON
              ? ("behind" as const)
              : ("tie" as const),
        scenarioCount: bucket.count,
      };
    });
}

type CachedRun = {
  fingerprint: string;
  promise: Promise<RoutingPromotionVerdict>;
};
const runCache = new Map<string, CachedRun>();

function cacheKey(subjectId: string, runId: string): string {
  return `${subjectId}\u0000${runId}`;
}

function cacheFingerprint(input: {
  suite: B8GuidanceEvalSuite;
  champion: RoutingGateCandidateEvaluator;
  challenger: RoutingGateCandidateEvaluator;
}): string {
  return [
    input.suite.suiteContentHash,
    input.champion.candidateId,
    input.challenger.candidateId,
  ].join("|");
}

async function executeRoutingPromotionGate(input: {
  suite: B8GuidanceEvalSuite;
  champion: RoutingGateCandidateEvaluator;
  challenger: RoutingGateCandidateEvaluator;
  deviceId: string;
  timeoutMs: number;
  onTelemetry?: (event: RoutingPromotionTelemetryEvent) => void;
}): Promise<RoutingPromotionVerdict> {
  const { suite } = input;
  const common = {
    subjectId: suite.subjectId,
    deviceId: input.deviceId,
    suiteId: B8_GUIDANCE_SUITE_ID,
    suiteContentHash: suite.suiteContentHash,
    championId: input.champion.candidateId,
    challengerId: input.challenger.candidateId,
  };
  const fail = (
    obligation: RoutingGateFailureClass,
    message: string,
    failingSlice?: string,
    failingScenario?: string,
  ): never => {
    input.onTelemetry?.({
      event: "learning.routing_gate.verdict",
      outcome: "fail",
      ...common,
      verdict: "reject",
      failureClass: obligation,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
      ...(failingScenario !== undefined
        ? { scenarioId: failingScenario }
        : {}),
    });
    throw new RoutingGateContractError(message, {
      obligation,
      subjectId: suite.subjectId,
      deviceId: input.deviceId,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
      ...(failingScenario !== undefined ? { failingScenario } : {}),
    });
  };

  if (
    suite.schemaVersion !== ROUTING_GATE_SCHEMA_VERSION ||
    suite.suiteId !== B8_GUIDANCE_SUITE_ID ||
    suite.suiteContentHash !== computeRoutingSuiteFingerprint(suite) ||
    !suite.frozen ||
    !suite.heldOut ||
    !suite.decontaminated ||
    !suite.excludeFromTrainingCorpora ||
    suite.scenarios.length < 1 ||
    suite.scenarios.length > ROUTING_GATE_SCENARIO_LIMIT
  ) {
    fail(
      "routing_gate.invalid_suite",
      "routing promotion requires a complete frozen held-out suite",
    );
  }
  if (
    !ID_RE.test(input.deviceId) ||
    !ID_RE.test(input.champion.candidateId) ||
    !ID_RE.test(input.challenger.candidateId) ||
    input.champion.candidateId === input.challenger.candidateId
  ) {
    fail(
      "routing_gate.invalid_candidate",
      "routing candidates must have distinct bounded ids",
    );
  }
  for (const evaluator of [input.champion, input.challenger]) {
    if (evaluator.subjectId !== suite.subjectId) {
      fail(
        "routing_gate.subject_scope",
        `candidate ${evaluator.candidateId} crosses subject scope`,
      );
    }
    if (evaluator.locality !== suite.locality) {
      fail(
        "routing_gate.locality_forbidden",
        `candidate ${evaluator.candidateId} crosses locality boundary`,
      );
    }
  }

  // Sequential execution avoids same-subject evaluator state races.
  const scenarioVerdicts: RoutingGateScenarioVerdict[] = [];
  for (const scenario of suite.scenarios) {
    let champion: RoutingGateObservation;
    let challenger: RoutingGateObservation;
    try {
      champion = await evaluateWithTimeout({
        evaluator: input.champion,
        scenario,
        timeoutMs: input.timeoutMs,
        deviceId: input.deviceId,
      });
      challenger = await evaluateWithTimeout({
        evaluator: input.challenger,
        scenario,
        timeoutMs: input.timeoutMs,
        deviceId: input.deviceId,
      });
    } catch (error) {
      const typed =
        error instanceof RoutingGateContractError
          ? error
          : new RoutingGateContractError("routing evaluator failed", {
              obligation: "routing_gate.evaluator_failure",
              subjectId: suite.subjectId,
              deviceId: input.deviceId,
              failingSlice: scenario.sliceId,
              failingScenario: scenario.scenarioId,
            });
      input.onTelemetry?.({
        event: "learning.routing_gate.scenario",
        outcome: "fail",
        ...common,
        scenarioId: scenario.scenarioId,
        sliceId: scenario.sliceId,
        failureClass: typed.obligation,
      });
      throw typed;
    }
    const championPasses = champion.score + EPSILON >= scenario.threshold;
    const challengerPasses =
      challenger.score + EPSILON >= scenario.threshold;
    const delta = challenger.score - champion.score;
    scenarioVerdicts.push({
      scenarioId: scenario.scenarioId,
      sliceId: scenario.sliceId,
      championScore: champion.score,
      challengerScore: challenger.score,
      threshold: scenario.threshold,
      delta,
      championPasses,
      challengerPasses,
    });
    input.onTelemetry?.({
      event: "learning.routing_gate.scenario",
      outcome:
        championPasses && challengerPasses && delta >= -EPSILON
          ? "ok"
          : "fail",
      ...common,
      scenarioId: scenario.scenarioId,
      sliceId: scenario.sliceId,
      championScore: champion.score,
      challengerScore: challenger.score,
      delta,
    });
  }

  const slices = buildSliceVerdicts(scenarioVerdicts);
  for (const slice of slices) {
    input.onTelemetry?.({
      event: "learning.routing_gate.slice",
      outcome: slice.status === "behind" ? "fail" : "ok",
      ...common,
      sliceId: slice.sliceId,
      championScore: slice.championScore,
      challengerScore: slice.challengerScore,
      delta: slice.delta,
      ...(slice.status === "behind"
        ? { failureClass: "slice_regression" }
        : {}),
    });
  }

  const championFailures = scenarioVerdicts.filter(
    (scenario) => !scenario.championPasses,
  );
  const thresholdFailures = scenarioVerdicts.filter(
    (scenario) => !scenario.challengerPasses,
  );
  const regressedSlice = slices.find((slice) => slice.status === "behind");
  const aggregateChampionScore =
    scenarioVerdicts.reduce(
      (total, scenario) => total + scenario.championScore,
      0,
    ) / scenarioVerdicts.length;
  const aggregateChallengerScore =
    scenarioVerdicts.reduce(
      (total, scenario) => total + scenario.challengerScore,
      0,
    ) / scenarioVerdicts.length;
  const aggregateDelta =
    aggregateChallengerScore - aggregateChampionScore;

  let reason: RoutingGateRejectReason | undefined;
  let failingSlice: string | undefined;
  let failingScenarioIds: string[] = [];
  if (championFailures.length > 0) {
    reason = "champion_invalid";
    failingSlice = championFailures[0]!.sliceId;
    failingScenarioIds = championFailures.map(
      (scenario) => scenario.scenarioId,
    );
  } else if (thresholdFailures.length > 0) {
    reason = "challenger_threshold_failed";
    failingSlice = thresholdFailures[0]!.sliceId;
    failingScenarioIds = thresholdFailures.map(
      (scenario) => scenario.scenarioId,
    );
  } else if (regressedSlice !== undefined) {
    reason = "slice_regression";
    failingSlice = regressedSlice.sliceId;
    failingScenarioIds = scenarioVerdicts
      .filter((scenario) => scenario.sliceId === regressedSlice.sliceId)
      .map((scenario) => scenario.scenarioId);
  } else if (aggregateDelta <= EPSILON) {
    reason = "tie";
    failingSlice = slices[0]!.sliceId;
    failingScenarioIds = scenarioVerdicts.map(
      (scenario) => scenario.scenarioId,
    );
  }

  if (reason !== undefined) {
    const verdict: RoutingPromotionVerdict = {
      schemaVersion: ROUTING_PROMOTION_VERDICT_SCHEMA_VERSION,
      verdict: "reject",
      promoted: false,
      reason,
      suiteId: B8_GUIDANCE_SUITE_ID,
      suiteContentHash: suite.suiteContentHash,
      subjectId: suite.subjectId,
      championId: input.champion.candidateId,
      challengerId: input.challenger.candidateId,
      aggregateChampionScore,
      aggregateChallengerScore,
      aggregateDelta,
      failingSlice: failingSlice!,
      failingScenarioIds,
      scenarios: scenarioVerdicts,
      slices,
      idempotentReplay: false,
    };
    input.onTelemetry?.({
      event: "learning.routing_gate.verdict",
      outcome: "fail",
      ...common,
      verdict: "reject",
      failureClass: reason,
      failingSlice: failingSlice!,
      championScore: aggregateChampionScore,
      challengerScore: aggregateChallengerScore,
      delta: aggregateDelta,
    });
    return verdict;
  }

  const verdict: RoutingPromotionVerdict = {
    schemaVersion: ROUTING_PROMOTION_VERDICT_SCHEMA_VERSION,
    verdict: "promote",
    promoted: true,
    suiteId: B8_GUIDANCE_SUITE_ID,
    suiteContentHash: suite.suiteContentHash,
    subjectId: suite.subjectId,
    championId: input.champion.candidateId,
    challengerId: input.challenger.candidateId,
    aggregateChampionScore,
    aggregateChallengerScore,
    aggregateDelta,
    failingSlice: null,
    failingScenarioIds: [],
    scenarios: scenarioVerdicts,
    slices,
    idempotentReplay: false,
  };
  input.onTelemetry?.({
    event: "learning.routing_gate.verdict",
    outcome: "ok",
    ...common,
    verdict: "promote",
    championScore: aggregateChampionScore,
    challengerScore: aggregateChallengerScore,
    delta: aggregateDelta,
  });
  return verdict;
}

/**
 * Run the full B8 guidance gate. A runId makes concurrent/replayed requests
 * single-flight and idempotent; divergent reuse is a typed conflict.
 */
export async function runRoutingPromotionGate(input: {
  suite: B8GuidanceEvalSuite;
  champion: RoutingGateCandidateEvaluator;
  challenger: RoutingGateCandidateEvaluator;
  deviceId: string;
  runId?: string;
  timeoutMs?: number;
  onTelemetry?: (event: RoutingPromotionTelemetryEvent) => void;
}): Promise<RoutingPromotionVerdict> {
  const timeoutMs = input.timeoutMs ?? ROUTING_GATE_TIMEOUT_MS_DEFAULT;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new RoutingGateContractError(
      "routing gate timeout must be 1..60000ms",
      {
        obligation: "routing_gate.invalid_candidate",
        subjectId: input.suite.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  if (input.runId === undefined) {
    return executeRoutingPromotionGate({ ...input, timeoutMs });
  }

  if (!ID_RE.test(input.runId)) {
    throw new RoutingGateContractError(
      "runId must be a bounded identifier",
      {
        obligation: "routing_gate.invalid_candidate",
        subjectId: input.suite.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  const runId = input.runId;
  const key = cacheKey(input.suite.subjectId, runId);
  const fingerprint = cacheFingerprint(input);
  const prior = runCache.get(key);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) {
      throw new RoutingGateContractError(
        "runId replay conflicts with prior routing gate input",
        {
          obligation: "routing_gate.idempotent_conflict",
          subjectId: input.suite.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    const verdict = await prior.promise;
    input.onTelemetry?.({
      event: "learning.routing_gate.verdict",
      outcome: verdict.verdict === "promote" ? "ok" : "fail",
      subjectId: input.suite.subjectId,
      deviceId: input.deviceId,
      suiteId: B8_GUIDANCE_SUITE_ID,
      suiteContentHash: input.suite.suiteContentHash,
      championId: input.champion.candidateId,
      challengerId: input.challenger.candidateId,
      verdict: verdict.verdict,
      ...(verdict.failingSlice !== null
        ? { failingSlice: verdict.failingSlice }
        : {}),
      idempotentReplay: true,
    });
    return { ...verdict, idempotentReplay: true };
  }
  if (runCache.size >= ROUTING_GATE_RUN_CACHE_LIMIT) {
    const oldest = runCache.keys().next().value;
    if (oldest !== undefined) runCache.delete(oldest);
  }
  const promise = executeRoutingPromotionGate({ ...input, timeoutMs });
  runCache.set(key, { fingerprint, promise });
  try {
    return await promise;
  } catch (error) {
    runCache.delete(key);
    throw error;
  }
}

export type RoutingCiGateTelemetryEvent = {
  event: "learning.routing_gate.ci";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  suiteId: typeof B8_GUIDANCE_SUITE_ID;
  suiteContentHash: string;
  failureClass?: RoutingGateFailureClass | RoutingGateRejectReason;
  fixture?:
    | "flag_off_parity"
    | "seeded_promote"
    | "tie_reject"
    | "slice_regression"
    | "subject_scope";
  verdict?: "promote" | "reject";
  failingSlice?: string;
  failingScenarioCount?: number;
  scenarioId?: string;
};

/**
 * Deterministic seeded evaluator for CI fixtures.
 * Score defaults to the scenario threshold (pass-floor); uplift raises it.
 */
export function createSeededRoutingEvaluator(input: {
  candidateId: string;
  subjectId: string;
  locality: "on-device" | "self-hosted";
  /** Added to the scenario threshold then clamped to [0, 1]. */
  uplift?: number;
  overrideScenarioId?: string;
  overrideScore?: number;
}): RoutingGateCandidateEvaluator {
  const uplift = input.uplift ?? 0;
  return {
    candidateId: input.candidateId,
    subjectId: input.subjectId,
    locality: input.locality,
    evaluate(scenario) {
      let score = Math.min(1, Math.max(0, scenario.threshold + uplift));
      if (
        input.overrideScenarioId !== undefined &&
        scenario.scenarioId === input.overrideScenarioId &&
        input.overrideScore !== undefined
      ) {
        score = input.overrideScore;
      }
      return {
        scenarioId: scenario.scenarioId,
        subjectId: input.subjectId,
        pinnedSeed: scenario.pinnedSeed,
        score,
        evaluatedCaseIds: scenario.cases.map((entry) => entry.caseId),
      };
    },
  };
}

function assertRejectVerdict(
  verdict: RoutingPromotionVerdict,
  expectedReason: RoutingGateRejectReason,
  meta: {
    subjectId: string;
    deviceId: string;
    fixture: NonNullable<RoutingCiGateTelemetryEvent["fixture"]>;
    suite: B8GuidanceEvalSuite;
    onTelemetry?: (event: RoutingCiGateTelemetryEvent) => void;
  },
): Extract<RoutingPromotionVerdict, { verdict: "reject" }> {
  if (verdict.verdict !== "reject" || verdict.reason !== expectedReason) {
    meta.onTelemetry?.({
      event: "learning.routing_gate.ci",
      outcome: "fail",
      subjectId: meta.subjectId,
      deviceId: meta.deviceId,
      suiteId: B8_GUIDANCE_SUITE_ID,
      suiteContentHash: meta.suite.suiteContentHash,
      failureClass: "routing_gate.ci_reject_expected",
      fixture: meta.fixture,
      verdict: verdict.verdict,
      failingScenarioCount:
        verdict.verdict === "reject" ? verdict.failingScenarioIds.length : 0,
      ...(verdict.failingSlice !== null
        ? { failingSlice: verdict.failingSlice }
        : {}),
    });
    throw new RoutingGateContractError(
      `CI fixture ${meta.fixture} expected reject(${expectedReason})`,
      {
        obligation: "routing_gate.ci_reject_expected",
        subjectId: meta.subjectId,
        deviceId: meta.deviceId,
        ...(verdict.verdict === "reject"
          ? {
              failingSlice: verdict.failingSlice,
              ...(verdict.failingScenarioIds[0] !== undefined
                ? { failingScenario: verdict.failingScenarioIds[0] }
                : {}),
            }
          : {}),
      },
    );
  }
  return verdict;
}

/**
 * CI prove harness: equal-score (flag-off) tie reject; seeded strict promote;
 * equal-score tie reject fixture; slice regression names failing slice;
 * idempotent replay; cross-subject challenger refused.
 */
export async function proveRoutingPromotionGateCi(input: {
  suite: B8GuidanceEvalSuite;
  deviceId?: string;
  onTelemetry?: (
    event: RoutingPromotionTelemetryEvent | RoutingCiGateTelemetryEvent,
  ) => void;
}): Promise<{
  ok: true;
  flagOffParity: Extract<RoutingPromotionVerdict, { verdict: "reject" }>;
  seededPromote: Extract<RoutingPromotionVerdict, { verdict: "promote" }>;
  tieReject: Extract<RoutingPromotionVerdict, { verdict: "reject" }>;
  sliceRegression: Extract<RoutingPromotionVerdict, { verdict: "reject" }>;
  replayOk: true;
}> {
  const deviceId = input.deviceId ?? "ci-routing-gate";
  const subjectId = input.suite.subjectId;
  const suite = input.suite;
  const telemetryBase = {
    subjectId,
    deviceId,
    suiteId: B8_GUIDANCE_SUITE_ID,
    suiteContentHash: suite.suiteContentHash,
  };

  if (
    suite.surgeryClasses.length !== 1 ||
    suite.surgeryClasses[0] !== "learned_routing"
  ) {
    input.onTelemetry?.({
      event: "learning.routing_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "routing_gate.ci_attribution_void",
    });
    throw new RoutingGateContractError(
      "CI routing gate requires exactly one learned_routing surgery class",
      {
        obligation: "routing_gate.ci_attribution_void",
        subjectId,
        deviceId,
      },
    );
  }

  const champion = createSeededRoutingEvaluator({
    candidateId: "ci.champion.b8",
    subjectId,
    locality: suite.locality,
  });

  // Equal-score challenger ≡ flag-off parity → tie (never promotes).
  const flagOffParity = assertRejectVerdict(
    await runRoutingPromotionGate({
      suite,
      champion,
      challenger: createSeededRoutingEvaluator({
        candidateId: "ci.challenger.flag-off",
        subjectId,
        locality: suite.locality,
      }),
      deviceId,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    }),
    "tie",
    {
      subjectId,
      deviceId,
      fixture: "flag_off_parity",
      suite,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  );
  if (Math.abs(flagOffParity.aggregateDelta) > EPSILON) {
    input.onTelemetry?.({
      event: "learning.routing_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "routing_gate.ci_flag_off_parity",
      fixture: "flag_off_parity",
      verdict: "reject",
    });
    throw new RoutingGateContractError(
      "flag-off parity challenger must score identically to champion",
      {
        obligation: "routing_gate.ci_flag_off_parity",
        subjectId,
        deviceId,
      },
    );
  }

  const seededChallenger = createSeededRoutingEvaluator({
    candidateId: "ci.challenger.seeded-promote",
    subjectId,
    locality: suite.locality,
    uplift: 0.2,
  });
  const seededPromote = await runRoutingPromotionGate({
    suite,
    champion,
    challenger: seededChallenger,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (
    seededPromote.verdict !== "promote" ||
    !seededPromote.promoted ||
    seededPromote.aggregateDelta <= EPSILON
  ) {
    input.onTelemetry?.({
      event: "learning.routing_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "routing_gate.ci_promote_expected",
      fixture: "seeded_promote",
      verdict: seededPromote.verdict,
      failingScenarioCount:
        seededPromote.verdict === "reject"
          ? seededPromote.failingScenarioIds.length
          : 0,
      ...(seededPromote.failingSlice !== null
        ? { failingSlice: seededPromote.failingSlice }
        : {}),
    });
    throw new RoutingGateContractError(
      "seeded challenger beating baseline must promote",
      {
        obligation: "routing_gate.ci_promote_expected",
        subjectId,
        deviceId,
        ...(seededPromote.verdict === "reject"
          ? {
              failingSlice: seededPromote.failingSlice,
              ...(seededPromote.failingScenarioIds[0] !== undefined
                ? { failingScenario: seededPromote.failingScenarioIds[0] }
                : {}),
            }
          : {}),
      },
    );
  }

  const replayPromote = await runRoutingPromotionGate({
    suite,
    champion,
    challenger: seededChallenger,
    deviceId,
  });
  if (JSON.stringify(replayPromote) !== JSON.stringify(seededPromote)) {
    input.onTelemetry?.({
      event: "learning.routing_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "routing_gate.ci_replay_mismatch",
      fixture: "seeded_promote",
    });
    throw new RoutingGateContractError(
      "routing promotion CI gate replay is not idempotent",
      {
        obligation: "routing_gate.ci_replay_mismatch",
        subjectId,
        deviceId,
      },
    );
  }

  const tieReject = assertRejectVerdict(
    await runRoutingPromotionGate({
      suite,
      champion,
      challenger: createSeededRoutingEvaluator({
        candidateId: "ci.challenger.tie",
        subjectId,
        locality: suite.locality,
      }),
      deviceId,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    }),
    "tie",
    {
      subjectId,
      deviceId,
      fixture: "tie_reject",
      suite,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  );

  // Slice regression: still above threshold on the weakened slice, but below
  // champion there — aggregate may still improve or worsen; failingSlice named.
  const regressionTarget =
    suite.scenarios.find(
      (scenario) => scenario.scenarioId === "teacher-guidance-tone",
    ) ?? suite.scenarios[0]!;
  const regressionScore = Math.max(
    regressionTarget.threshold,
    Math.min(1, regressionTarget.threshold + 0.01),
  );
  // Champion at threshold+0.05 on all; challenger uplift 0.2 except target
  // held just above threshold (behind champion on that slice).
  const sliceChampion = createSeededRoutingEvaluator({
    candidateId: "ci.champion.slice",
    subjectId,
    locality: suite.locality,
    uplift: 0.05,
  });
  const sliceRegression = assertRejectVerdict(
    await runRoutingPromotionGate({
      suite,
      champion: sliceChampion,
      challenger: createSeededRoutingEvaluator({
        candidateId: "ci.challenger.slice-regression",
        subjectId,
        locality: suite.locality,
        uplift: 0.2,
        overrideScenarioId: regressionTarget.scenarioId,
        overrideScore: regressionScore,
      }),
      deviceId,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    }),
    "slice_regression",
    {
      subjectId,
      deviceId,
      fixture: "slice_regression",
      suite,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  );
  if (sliceRegression.failingSlice !== regressionTarget.sliceId) {
    input.onTelemetry?.({
      event: "learning.routing_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "routing_gate.ci_reject_expected",
      fixture: "slice_regression",
      failingSlice: sliceRegression.failingSlice,
    });
    throw new RoutingGateContractError(
      `slice regression must name failing slice ${regressionTarget.sliceId}`,
      {
        obligation: "routing_gate.ci_reject_expected",
        subjectId,
        deviceId,
        failingSlice: regressionTarget.sliceId,
        failingScenario: regressionTarget.scenarioId,
      },
    );
  }

  let subjectBlocked = false;
  try {
    await runRoutingPromotionGate({
      suite,
      champion,
      challenger: createSeededRoutingEvaluator({
        candidateId: "ci.challenger.cross-subject",
        subjectId: `${subjectId}.other`,
        locality: suite.locality,
        uplift: 0.2,
      }),
      deviceId,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
  } catch (error) {
    if (
      error instanceof RoutingGateContractError &&
      error.obligation === "routing_gate.subject_scope"
    ) {
      subjectBlocked = true;
    } else {
      throw error;
    }
  }
  if (!subjectBlocked) {
    input.onTelemetry?.({
      event: "learning.routing_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "routing_gate.subject_scope",
      fixture: "subject_scope",
    });
    throw new RoutingGateContractError(
      "cross-subject challenger must be refused by the CI gate",
      {
        obligation: "routing_gate.subject_scope",
        subjectId,
        deviceId,
      },
    );
  }

  input.onTelemetry?.({
    event: "learning.routing_gate.ci",
    outcome: "ok",
    ...telemetryBase,
    fixture: "seeded_promote",
    verdict: "promote",
    failingScenarioCount: 0,
  });

  return {
    ok: true,
    flagOffParity,
    seededPromote,
    tieReject,
    sliceRegression,
    replayOk: true,
  };
}
