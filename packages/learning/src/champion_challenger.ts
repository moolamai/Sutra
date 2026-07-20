/**
 * Champion/challenger shadow scoring protocol (C5 staged rollout).
 *
 * Live traffic samples are duplicated to the challenger for scoring only.
 * User-facing output is always the champion. Ties and incomplete/timeout
 * runs hold the champion — shadow never promotes on its own.
 */

import { createHash } from "node:crypto";

export const SHADOW_SCORING_SCHEMA_VERSION =
  "learning.shadow-scoring.v1" as const;

/** Bound on samples scored in one shadow run (NFR). */
export const SHADOW_SAMPLE_LIMIT = 64;

/** Bound on retained shadow run reports per subject. */
export const SHADOW_RUN_CACHE_LIMIT = 32;

/** Default shadow scoring deadline. */
export const SHADOW_DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Minimum distinct domain packs in the shadow sample set before a
 * challenger-ahead signal is eligible — blocks single-pack skew evidence.
 */
export const SHADOW_MIN_DOMAIN_PACK_COVERAGE = 2;

export type ShadowScoringFailureClass =
  | "shadow.subject_scope"
  | "shadow.sample_limit"
  | "shadow.sample_invalid"
  | "shadow.slice_invalid"
  | "shadow.score_invalid"
  | "shadow.coverage_skew"
  | "shadow.timeout"
  | "shadow.incomplete"
  | "shadow.attribution_void"
  | "shadow.idempotent_conflict"
  | "shadow.challenger_serve_forbidden";

export type ShadowScoringTelemetryEvent = {
  event:
    | "learning.shadow_scoring.run"
    | "learning.shadow_scoring.sample"
    | "learning.shadow_scoring.timeout"
    | "learning.shadow_scoring.serve";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  runId?: string;
  sampleId?: string;
  sliceId?: string;
  failingSlice?: string;
  verdict?: ShadowComparisonVerdict;
  servedSource?: "champion";
  sampleCount?: number;
  domainPackCount?: number;
  idempotentReplay?: boolean;
  failureClass?: ShadowScoringFailureClass;
};

export class ShadowScoringError extends Error {
  readonly obligation: ShadowScoringFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: ShadowScoringFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "ShadowScoringError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

/**
 * Live-traffic sample for shadow duplication.
 * Carries hashes and critic scores — never raw learner utterances.
 */
export type ShadowTrafficSample = {
  sampleId: string;
  subjectId: string;
  /** Eval slice id: domainPackId/language/bindingId */
  sliceId: string;
  /** Content hash of the duplicated input (opaque). */
  inputHash: string;
  /** C3 critic score of the champion reply on this input [0,1]. */
  championCriticScore: number;
  /** Hash of the champion output that was / will be served to the user. */
  championOutputHash: string;
};

export type ShadowChallengerScore = {
  /** C3 critic score of the shadow challenger reply [0,1]. */
  criticScore: number;
  /**
   * Hash of challenger output — audit/compare only.
   * Must never appear in user-facing serve fields.
   */
  outputHash: string;
};

export type ShadowComparisonVerdict =
  | "hold_champion"
  | "challenger_ahead"
  | "challenger_behind"
  | "reject";

export type ShadowSliceScoreRow = {
  sliceId: string;
  domainPackId: string;
  championScore: number;
  challengerScore: number;
  delta: number;
  status: "ahead" | "behind" | "tie";
};

export type ShadowUserFacingServe = {
  /** Invariant: always champion — challenger is scoring-only. */
  source: "champion";
  sampleId: string;
  outputHash: string;
};

export type ShadowComparisonReport = {
  schemaVersion: typeof SHADOW_SCORING_SCHEMA_VERSION;
  runId: string;
  subjectId: string;
  deviceId: string;
  verdict: ShadowComparisonVerdict;
  /** True when timeout/incomplete forced champion hold with advisory. */
  advisory?: "shadow_timeout" | "shadow_incomplete" | "coverage_skew" | "tie";
  failingSlice?: string;
  failureClass?: ShadowScoringFailureClass;
  sampleCount: number;
  domainPackCount: number;
  slices: ReadonlyArray<ShadowSliceScoreRow>;
  /** Every user-facing serve in this run — champion only. */
  userFacing: ReadonlyArray<ShadowUserFacingServe>;
  /** Challenger output hashes retained for audit — never served. */
  challengerAuditHashes: ReadonlyArray<{
    sampleId: string;
    outputHash: string;
  }>;
  championMean: number;
  challengerMean: number;
  completed: boolean;
  timedOut: boolean;
  idempotentReplay: boolean;
};

export type ShadowChallengerScorer = (
  sample: ShadowTrafficSample,
) => Promise<ShadowChallengerScore> | ShadowChallengerScore;

const byRunId = new Map<string, ShadowComparisonReport>();

/**
 * Duplicate live inputs to the challenger in shadow, score with critic
 * signals + per-slice baselines, emit a comparison report. User-facing
 * serves are champion-only — zero challenger output leakage.
 */
export async function runShadowScoringAgainstChampion(input: {
  subjectId: string;
  deviceId: string;
  runId: string;
  samples: ReadonlyArray<ShadowTrafficSample>;
  scoreChallenger: ShadowChallengerScorer;
  /** Defaults to {@link SHADOW_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Surgery component classes touched by the candidate.
   * More than one → attribution void (one surgery per stage).
   */
  surgeryClasses?: ReadonlyArray<string>;
  onTelemetry?: (event: ShadowScoringTelemetryEvent) => void;
}): Promise<ShadowComparisonReport> {
  const subjectId = requireId(input.subjectId, "subjectId");
  const deviceId = requireId(input.deviceId, "deviceId");
  const runId = requireId(input.runId, "runId");
  const timeoutMs = input.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS;

  const prior = byRunId.get(runId);
  if (prior) {
    if (prior.subjectId !== subjectId) {
      throw new ShadowScoringError(
        "runId replay with divergent subjectId",
        {
          obligation: "shadow.idempotent_conflict",
          subjectId,
          deviceId,
        },
      );
    }
    input.onTelemetry?.({
      event: "learning.shadow_scoring.run",
      outcome: "ok",
      subjectId,
      deviceId,
      runId,
      verdict: prior.verdict,
      idempotentReplay: true,
      sampleCount: prior.sampleCount,
    });
    return { ...prior, idempotentReplay: true };
  }

  if (input.samples.length === 0 || input.samples.length > SHADOW_SAMPLE_LIMIT) {
    throw new ShadowScoringError(
      `shadow samples must be 1..${SHADOW_SAMPLE_LIMIT}`,
      {
        obligation: "shadow.sample_limit",
        subjectId,
        deviceId,
      },
    );
  }

  if (input.surgeryClasses !== undefined && input.surgeryClasses.length > 1) {
    const failingSlice = input.surgeryClasses.join("+");
    const report = freezeReport({
      schemaVersion: SHADOW_SCORING_SCHEMA_VERSION,
      runId,
      subjectId,
      deviceId,
      verdict: "reject",
      failingSlice,
      failureClass: "shadow.attribution_void",
      sampleCount: 0,
      domainPackCount: 0,
      slices: [],
      userFacing: [],
      challengerAuditHashes: [],
      championMean: 0,
      challengerMean: 0,
      completed: false,
      timedOut: false,
      idempotentReplay: false,
    });
    rememberRun(report);
    input.onTelemetry?.({
      event: "learning.shadow_scoring.run",
      outcome: "fail",
      subjectId,
      deviceId,
      runId,
      verdict: "reject",
      failingSlice,
      failureClass: "shadow.attribution_void",
    });
    return report;
  }

  for (const sample of input.samples) {
    if (sample.subjectId !== subjectId) {
      throw new ShadowScoringError(
        "cross-subject shadow sample rejected",
        {
          obligation: "shadow.subject_scope",
          subjectId,
          deviceId,
          failingSlice: sample.sliceId,
        },
      );
    }
    assertSampleShape(sample, subjectId, deviceId);
  }

  const userFacing: ShadowUserFacingServe[] = input.samples.map((sample) => {
    const serve: ShadowUserFacingServe = {
      source: "champion",
      sampleId: sample.sampleId,
      outputHash: sample.championOutputHash,
    };
    input.onTelemetry?.({
      event: "learning.shadow_scoring.serve",
      outcome: "ok",
      subjectId,
      deviceId,
      runId,
      sampleId: sample.sampleId,
      servedSource: "champion",
    });
    return serve;
  });

  const scoreWork = scoreAllChallengerSamples({
    samples: input.samples,
    scoreChallenger: input.scoreChallenger,
    subjectId,
    deviceId,
    runId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  let timedOut = false;
  let challengerScores: ShadowChallengerScore[];
  try {
    challengerScores = await raceWithTimeout(scoreWork, timeoutMs);
  } catch (error) {
    if (error instanceof ShadowTimeoutError) {
      timedOut = true;
      input.onTelemetry?.({
        event: "learning.shadow_scoring.timeout",
        outcome: "advisory",
        subjectId,
        deviceId,
        runId,
        verdict: "hold_champion",
        failureClass: "shadow.timeout",
        sampleCount: input.samples.length,
      });
      const report = freezeReport({
        schemaVersion: SHADOW_SCORING_SCHEMA_VERSION,
        runId,
        subjectId,
        deviceId,
        verdict: "hold_champion",
        advisory: "shadow_timeout",
        failureClass: "shadow.timeout",
        sampleCount: input.samples.length,
        domainPackCount: countDomainPacks(input.samples),
        slices: [],
        userFacing,
        challengerAuditHashes: [],
        championMean: mean(input.samples.map((s) => s.championCriticScore)),
        challengerMean: 0,
        completed: false,
        timedOut: true,
        idempotentReplay: false,
      });
      rememberRun(report);
      input.onTelemetry?.({
        event: "learning.shadow_scoring.run",
        outcome: "advisory",
        subjectId,
        deviceId,
        runId,
        verdict: "hold_champion",
        failureClass: "shadow.timeout",
        sampleCount: input.samples.length,
      });
      return report;
    }
    throw error;
  }

  // Guard: challenger hashes must never equal a served champion hash path as source.
  for (const serve of userFacing) {
    if (serve.source !== "champion") {
      throw new ShadowScoringError(
        "challenger output must never be user-facing",
        {
          obligation: "shadow.challenger_serve_forbidden",
          subjectId,
          deviceId,
        },
      );
    }
  }

  const bySlice = aggregateSliceScores(input.samples, challengerScores);
  const domainPackCount = countDomainPacks(input.samples);
  const sliceRows = [...bySlice.values()];

  let failingSlice: string | undefined;
  let behind = false;
  let ahead = false;
  for (const row of sliceRows) {
    if (row.status === "behind") {
      behind = true;
      if (failingSlice === undefined) failingSlice = row.sliceId;
    } else if (row.status === "ahead") {
      ahead = true;
    }
  }

  let verdict: ShadowComparisonVerdict = "hold_champion";
  let advisory: ShadowComparisonReport["advisory"];
  let failureClass: ShadowScoringFailureClass | undefined;

  if (behind) {
    verdict = "challenger_behind";
    failureClass = "shadow.incomplete";
  } else if (ahead) {
    if (domainPackCount < SHADOW_MIN_DOMAIN_PACK_COVERAGE) {
      verdict = "hold_champion";
      advisory = "coverage_skew";
      failureClass = "shadow.coverage_skew";
    } else {
      // Shadow may signal challenger_ahead for canary consideration —
      // it still does not serve challenger outputs (ties/incomplete never promote).
      verdict = "challenger_ahead";
    }
  } else {
    verdict = "hold_champion";
    advisory = "tie";
  }

  const report = freezeReport({
    schemaVersion: SHADOW_SCORING_SCHEMA_VERSION,
    runId,
    subjectId,
    deviceId,
    verdict,
    ...(advisory !== undefined ? { advisory } : {}),
    ...(failingSlice !== undefined ? { failingSlice } : {}),
    ...(failureClass !== undefined ? { failureClass } : {}),
    sampleCount: input.samples.length,
    domainPackCount,
    slices: sliceRows,
    userFacing,
    challengerAuditHashes: input.samples.map((sample, i) => ({
      sampleId: sample.sampleId,
      outputHash: challengerScores[i]!.outputHash,
    })),
    championMean: mean(input.samples.map((s) => s.championCriticScore)),
    challengerMean: mean(challengerScores.map((s) => s.criticScore)),
    completed: true,
    timedOut,
    idempotentReplay: false,
  });
  rememberRun(report);
  input.onTelemetry?.({
    event: "learning.shadow_scoring.run",
    outcome:
      verdict === "challenger_behind"
        ? "fail"
        : advisory !== undefined
          ? "advisory"
          : "ok",
    subjectId,
    deviceId,
    runId,
    verdict,
    sampleCount: report.sampleCount,
    domainPackCount,
    ...(failingSlice !== undefined ? { failingSlice } : {}),
    ...(failureClass !== undefined ? { failureClass } : {}),
  });
  return report;
}

/** Test/CI helper: reset idempotent run cache. */
export function resetShadowScoringRunCache(): void {
  byRunId.clear();
}

/**
 * Prove micro-run: known-good challenger ahead (multi-pack), known-regressed
 * names failing slice, timeout holds champion, skew blocked, subject isolation.
 */
export async function proveShadowScoringMicroRun(opts?: {
  onTelemetry?: (event: ShadowScoringTelemetryEvent) => void;
}): Promise<{
  ok: true;
  good: ShadowComparisonReport;
  regressed: ShadowComparisonReport;
  timedOut: ShadowComparisonReport;
  skewed: ShadowComparisonReport;
  refusedSubjectScope: true;
}> {
  resetShadowScoringRunCache();
  const deviceId = "dev.shadow.prove";
  const subjectId = "subj.shadow.prove";

  const goodSamples: ShadowTrafficSample[] = [
    sampleFixture({
      sampleId: "s.good.1",
      subjectId,
      sliceId: "teacher/en/b8",
      champion: 0.7,
      championOut: "champ-out-1",
    }),
    sampleFixture({
      sampleId: "s.good.2",
      subjectId,
      sliceId: "doctor/en/b8",
      champion: 0.65,
      championOut: "champ-out-2",
    }),
  ];
  const good = await runShadowScoringAgainstChampion({
    subjectId,
    deviceId,
    runId: "run.shadow.good",
    samples: goodSamples,
    scoreChallenger: (sample) => ({
      criticScore: sample.championCriticScore + 0.1,
      outputHash: hashOpaque(`challenger:${sample.sampleId}`),
    }),
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (good.verdict !== "challenger_ahead" || good.userFacing.some((u) => u.source !== "champion")) {
    throw new Error("known-good shadow run must signal challenger_ahead with champion serves only");
  }

  const regressedSamples: ShadowTrafficSample[] = [
    sampleFixture({
      sampleId: "s.bad.1",
      subjectId,
      sliceId: "teacher/en/b8",
      champion: 0.8,
      championOut: "champ-out-b1",
    }),
    sampleFixture({
      sampleId: "s.bad.2",
      subjectId,
      sliceId: "doctor/en/b8",
      champion: 0.75,
      championOut: "champ-out-b2",
    }),
  ];
  const regressed = await runShadowScoringAgainstChampion({
    subjectId,
    deviceId,
    runId: "run.shadow.regressed",
    samples: regressedSamples,
    scoreChallenger: (sample) => ({
      criticScore:
        sample.sliceId === "teacher/en/b8"
          ? sample.championCriticScore - 0.2
          : sample.championCriticScore + 0.05,
      outputHash: hashOpaque(`challenger:${sample.sampleId}`),
    }),
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (
    regressed.verdict !== "challenger_behind" ||
    regressed.failingSlice !== "teacher/en/b8"
  ) {
    throw new Error("known-regressed shadow run must name failingSlice teacher/en/b8");
  }

  const timedOut = await runShadowScoringAgainstChampion({
    subjectId,
    deviceId,
    runId: "run.shadow.timeout",
    samples: goodSamples,
    timeoutMs: 20,
    scoreChallenger: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { criticScore: 0.99, outputHash: hashOpaque("late") };
    },
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (
    timedOut.verdict !== "hold_champion" ||
    timedOut.advisory !== "shadow_timeout" ||
    timedOut.timedOut !== true
  ) {
    throw new Error("timeout must hold champion with shadow_timeout advisory");
  }

  const skewedSamples: ShadowTrafficSample[] = [
    sampleFixture({
      sampleId: "s.skew.1",
      subjectId,
      sliceId: "teacher/en/b8",
      champion: 0.5,
      championOut: "champ-skew-1",
    }),
    sampleFixture({
      sampleId: "s.skew.2",
      subjectId,
      sliceId: "teacher/hi/b8",
      champion: 0.55,
      championOut: "champ-skew-2",
    }),
  ];
  const skewed = await runShadowScoringAgainstChampion({
    subjectId,
    deviceId,
    runId: "run.shadow.skew",
    samples: skewedSamples,
    scoreChallenger: (sample) => ({
      criticScore: sample.championCriticScore + 0.15,
      outputHash: hashOpaque(`challenger:${sample.sampleId}`),
    }),
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (skewed.verdict !== "hold_champion" || skewed.advisory !== "coverage_skew") {
    throw new Error("single domain-pack skew must hold champion with coverage_skew");
  }

  try {
    await runShadowScoringAgainstChampion({
      subjectId,
      deviceId,
      runId: "run.shadow.cross",
      samples: [
        sampleFixture({
          sampleId: "s.cross",
          subjectId: "subj.other",
          sliceId: "teacher/en/b8",
          champion: 0.5,
          championOut: "x",
        }),
      ],
      scoreChallenger: () => ({
        criticScore: 0.5,
        outputHash: hashOpaque("x"),
      }),
    });
    throw new Error("expected subject isolation refusal");
  } catch (error) {
    if (
      !(
        error instanceof ShadowScoringError &&
        error.obligation === "shadow.subject_scope"
      )
    ) {
      throw error;
    }
  }

  return {
    ok: true,
    good,
    regressed,
    timedOut,
    skewed,
    refusedSubjectScope: true,
  };
}

export const CANARY_DRIFT_SCHEMA_VERSION =
  "learning.canary-drift.v1" as const;

/** Bounded subjects retained per canary controller. */
export const CANARY_SUBJECT_LIMIT = 1_024;

/** Bounded observations retained through aggregate counters per slice. */
export const CANARY_SLICE_LIMIT = 64;

export type CanaryFailureClass =
  | "canary.subject_scope"
  | "canary.boundary_required"
  | "canary.config_invalid"
  | "canary.baseline_unfrozen"
  | "canary.baseline_contaminated"
  | "canary.slice_unknown"
  | "canary.score_invalid"
  | "canary.subject_limit"
  | "canary.slice_limit"
  | "canary.observation_conflict";

export type CanaryTelemetryEvent = {
  event:
    | "learning.canary.route"
    | "learning.canary.drift"
    | "learning.canary.halt";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  cohortId: string;
  operationId?: string;
  sessionId?: string;
  sliceId?: string;
  route?: "champion" | "challenger";
  status?: CanaryWatchStatus;
  failingSlice?: string;
  baselineRegistryHash?: string;
  idempotentReplay?: boolean;
  failureClass?: CanaryFailureClass;
};

export class CanaryContractError extends Error {
  readonly obligation: CanaryFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CanaryFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "CanaryContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

export type CanarySliceBaseline = {
  sliceId: string;
  /** Frozen C0 champion score in [0,1]. */
  score: number;
  /** Maximum allowed regression from the frozen score. */
  tolerance: number;
};

export type CanaryCohortConfig = {
  cohortId: string;
  /** Declared fraction of subjects routed to challenger, in [0,1]. */
  subjectFraction: number;
  /** Pinned deterministic cohort assignment seed. */
  assignmentSeed: string;
  /** Content hash of the C0 baseline registry used by this watch. */
  baselineRegistryHash: string;
  baselineFrozen: true;
  baselineDecontaminated: true;
  /** One surgery class for attributable canary evidence. */
  surgeryClass: string;
  slices: ReadonlyArray<CanarySliceBaseline>;
  /** Minimum distinct domain packs before the watch can be healthy. */
  minDomainPackCoverage?: number;
};

export type CanaryRouteDecision = {
  schemaVersion: typeof CANARY_DRIFT_SCHEMA_VERSION;
  operationId: string;
  cohortId: string;
  subjectId: string;
  deviceId: string;
  sessionId: string;
  boundaryEvent: "TURN_COMPLETE";
  route: "champion" | "challenger";
  assignmentBucket: number;
  subjectFraction: number;
  status: CanaryWatchStatus;
  idempotentReplay: boolean;
};

export type CanarySliceDriftMetric = {
  sliceId: string;
  baselineScore: number;
  tolerance: number;
  floor: number;
  observationCount: number;
  latestScore: number;
  meanScore: number;
  drift: number;
  breached: boolean;
};

export type CanaryWatchStatus =
  | "collecting"
  | "healthy"
  | "halted";

export type CanaryDriftReport = {
  schemaVersion: typeof CANARY_DRIFT_SCHEMA_VERSION;
  cohortId: string;
  baselineRegistryHash: string;
  status: CanaryWatchStatus;
  failingSlice?: string;
  routeAfterWatch: "champion" | "challenger";
  observedSliceCount: number;
  domainPackCount: number;
  requiredSliceCount: number;
  metrics: ReadonlyArray<CanarySliceDriftMetric>;
  operationId: string;
  idempotentReplay: boolean;
};

type MutableCanaryMetric = {
  baselineScore: number;
  tolerance: number;
  count: number;
  sum: number;
  latest: number;
  breached: boolean;
};

/**
 * Subject-scoped canary routing and drift watch.
 *
 * Assignment is deterministic by subject and only changes at TURN_COMPLETE.
 * Any per-slice breach atomically halts the cohort; all subsequent routes use
 * champion. This controller does not promote to fleet.
 */
export class CanaryCohortController {
  private readonly config: Required<
    Pick<CanaryCohortConfig, "minDomainPackCoverage">
  > &
    CanaryCohortConfig;
  private readonly deviceId: string;
  private readonly onTelemetry:
    | ((event: CanaryTelemetryEvent) => void)
    | undefined;
  private readonly baselines = new Map<string, CanarySliceBaseline>();
  private readonly routesBySubject = new Map<string, CanaryRouteDecision>();
  private readonly routeByOperation = new Map<string, CanaryRouteDecision>();
  private readonly metrics = new Map<string, MutableCanaryMetric>();
  private readonly driftByOperation = new Map<string, CanaryDriftReport>();
  private readonly driftSignatures = new Map<string, string>();
  private haltedSlice: string | undefined;

  constructor(options: {
    config: CanaryCohortConfig;
    deviceId: string;
    onTelemetry?: (event: CanaryTelemetryEvent) => void;
  }) {
    this.deviceId = requireId(options.deviceId, "deviceId");
    this.config = validateCanaryConfig(options.config);
    this.onTelemetry = options.onTelemetry;
    for (const slice of this.config.slices) {
      this.baselines.set(slice.sliceId, Object.freeze({ ...slice }));
    }
  }

  get status(): CanaryWatchStatus {
    if (this.haltedSlice !== undefined) return "halted";
    return this.coverageComplete() ? "healthy" : "collecting";
  }

  get failingSlice(): string | undefined {
    return this.haltedSlice;
  }

  /**
   * Decide the adapter for the next turn at a terminal boundary.
   * Replays are idempotent; a halted cohort always routes champion.
   */
  routeAtTurnBoundary(input: {
    operationId: string;
    subjectId: string;
    deviceId: string;
    sessionId: string;
    boundaryEvent: "TURN_COMPLETE";
  }): CanaryRouteDecision {
    const subjectId = requireId(input.subjectId, "subjectId");
    const operationId = requireId(input.operationId, "operationId");
    const deviceId = requireId(input.deviceId, "deviceId");
    const sessionId = requireId(input.sessionId, "sessionId");
    if (deviceId !== this.deviceId) {
      this.fail(
        "canary.subject_scope",
        "cross-device canary route denied",
        subjectId,
      );
    }
    if (input.boundaryEvent !== "TURN_COMPLETE") {
      this.fail(
        "canary.boundary_required",
        "canary assignment changes only at TURN_COMPLETE",
        subjectId,
      );
    }

    const replay = this.routeByOperation.get(operationId);
    if (replay) {
      if (
        replay.subjectId !== subjectId ||
        replay.sessionId !== sessionId
      ) {
        this.fail(
          "canary.observation_conflict",
          "operationId replay has divergent route scope",
          subjectId,
        );
      }
      this.onTelemetry?.({
        event: "learning.canary.route",
        outcome: "ok",
        subjectId,
        deviceId,
        cohortId: this.config.cohortId,
        operationId,
        sessionId,
        route: replay.route,
        status: this.status,
        idempotentReplay: true,
      });
      return { ...replay, status: this.status, idempotentReplay: true };
    }

    if (
      !this.routesBySubject.has(subjectId) &&
      this.routesBySubject.size >= CANARY_SUBJECT_LIMIT
    ) {
      this.fail(
        "canary.subject_limit",
        `canary subject limit ${CANARY_SUBJECT_LIMIT} exceeded`,
        subjectId,
      );
    }

    const assignmentBucket = deterministicBucket(
      this.config.cohortId,
      this.config.assignmentSeed,
      subjectId,
    );
    const route =
      this.status !== "halted" &&
      assignmentBucket < this.config.subjectFraction
        ? "challenger"
        : "champion";
    const decision: CanaryRouteDecision = Object.freeze({
      schemaVersion: CANARY_DRIFT_SCHEMA_VERSION,
      operationId,
      cohortId: this.config.cohortId,
      subjectId,
      deviceId,
      sessionId,
      boundaryEvent: "TURN_COMPLETE",
      route,
      assignmentBucket,
      subjectFraction: this.config.subjectFraction,
      status: this.status,
      idempotentReplay: false,
    });
    this.routesBySubject.set(subjectId, decision);
    this.routeByOperation.set(operationId, decision);
    this.onTelemetry?.({
      event: "learning.canary.route",
      outcome: "ok",
      subjectId,
      deviceId,
      cohortId: this.config.cohortId,
      operationId,
      sessionId,
      route,
      status: this.status,
      idempotentReplay: false,
    });
    return decision;
  }

  /**
   * Record one C3-scored canary outcome against its frozen C0 slice baseline.
   * The first threshold breach atomically halts the whole cohort.
   */
  observeDrift(input: {
    operationId: string;
    subjectId: string;
    deviceId: string;
    sliceId: string;
    score: number;
  }): CanaryDriftReport {
    const subjectId = requireId(input.subjectId, "subjectId");
    const operationId = requireId(input.operationId, "operationId");
    const deviceId = requireId(input.deviceId, "deviceId");
    const sliceId = requireId(input.sliceId, "sliceId");
    if (deviceId !== this.deviceId) {
      this.fail(
        "canary.subject_scope",
        "cross-device drift observation denied",
        subjectId,
        sliceId,
      );
    }
    const assigned = this.routesBySubject.get(subjectId);
    if (!assigned || assigned.route !== "challenger") {
      this.fail(
        "canary.subject_scope",
        "drift observation requires challenger assignment for subject",
        subjectId,
        sliceId,
      );
    }

    const replay = this.driftByOperation.get(operationId);
    if (replay) {
      const signature = `${subjectId}\0${sliceId}\0${input.score}`;
      if (this.driftSignatures.get(operationId) !== signature) {
        this.fail(
          "canary.observation_conflict",
          "operationId replay has divergent drift observation",
          subjectId,
          sliceId,
        );
      }
      this.onTelemetry?.({
        event: "learning.canary.drift",
        outcome: replay.status === "halted" ? "fail" : "ok",
        subjectId,
        deviceId,
        cohortId: this.config.cohortId,
        operationId,
        sliceId,
        status: replay.status,
        ...(replay.failingSlice !== undefined
          ? { failingSlice: replay.failingSlice }
          : {}),
        idempotentReplay: true,
      });
      return { ...replay, idempotentReplay: true };
    }

    if (
      typeof input.score !== "number" ||
      !Number.isFinite(input.score) ||
      input.score < 0 ||
      input.score > 1
    ) {
      this.fail(
        "canary.score_invalid",
        "canary score must be finite in [0,1]",
        subjectId,
        sliceId,
      );
    }
    const baseline = this.baselines.get(sliceId);
    if (!baseline) {
      this.fail(
        "canary.slice_unknown",
        "canary slice missing from frozen C0 baseline set",
        subjectId,
        sliceId,
      );
    }

    let metric = this.metrics.get(sliceId);
    if (!metric) {
      if (this.metrics.size >= CANARY_SLICE_LIMIT) {
        this.fail(
          "canary.slice_limit",
          `canary slice limit ${CANARY_SLICE_LIMIT} exceeded`,
          subjectId,
          sliceId,
        );
      }
      metric = {
        baselineScore: baseline.score,
        tolerance: baseline.tolerance,
        count: 0,
        sum: 0,
        latest: input.score,
        breached: false,
      };
      this.metrics.set(sliceId, metric);
    }
    metric.count += 1;
    metric.sum += input.score;
    metric.latest = input.score;
    const meanScore = metric.sum / metric.count;
    const floor = metric.baselineScore - metric.tolerance;
    // Both latest and aggregate must stay above the declared floor.
    metric.breached =
      input.score + Number.EPSILON < floor ||
      meanScore + Number.EPSILON < floor;
    if (metric.breached && this.haltedSlice === undefined) {
      this.haltedSlice = sliceId;
      this.onTelemetry?.({
        event: "learning.canary.halt",
        outcome: "fail",
        subjectId,
        deviceId,
        cohortId: this.config.cohortId,
        operationId,
        sliceId,
        failingSlice: sliceId,
        status: "halted",
        baselineRegistryHash: this.config.baselineRegistryHash,
      });
    }

    const report = this.buildReport(operationId, false);
    this.driftByOperation.set(operationId, report);
    this.driftSignatures.set(
      operationId,
      `${subjectId}\0${sliceId}\0${input.score}`,
    );
    this.onTelemetry?.({
      event: "learning.canary.drift",
      outcome: report.status === "halted" ? "fail" : "ok",
      subjectId,
      deviceId,
      cohortId: this.config.cohortId,
      operationId,
      sliceId,
      status: report.status,
      baselineRegistryHash: this.config.baselineRegistryHash,
      ...(report.failingSlice !== undefined
        ? { failingSlice: report.failingSlice }
        : {}),
      idempotentReplay: false,
    });
    return report;
  }

  snapshot(operationId: string): CanaryDriftReport {
    return this.buildReport(requireId(operationId, "operationId"), false);
  }

  private coverageComplete(): boolean {
    if (this.metrics.size !== this.baselines.size) return false;
    const packs = new Set<string>();
    for (const sliceId of this.metrics.keys()) {
      packs.add(parseDomainPack(sliceId));
    }
    return packs.size >= this.config.minDomainPackCoverage;
  }

  private buildReport(
    operationId: string,
    idempotentReplay: boolean,
  ): CanaryDriftReport {
    const metrics: CanarySliceDriftMetric[] = [];
    const packs = new Set<string>();
    for (const [sliceId, metric] of this.metrics) {
      const meanScore = metric.sum / metric.count;
      const floor = metric.baselineScore - metric.tolerance;
      packs.add(parseDomainPack(sliceId));
      metrics.push(
        Object.freeze({
          sliceId,
          baselineScore: metric.baselineScore,
          tolerance: metric.tolerance,
          floor,
          observationCount: metric.count,
          latestScore: metric.latest,
          meanScore,
          drift: meanScore - metric.baselineScore,
          breached: metric.breached,
        }),
      );
    }
    return Object.freeze({
      schemaVersion: CANARY_DRIFT_SCHEMA_VERSION,
      cohortId: this.config.cohortId,
      baselineRegistryHash: this.config.baselineRegistryHash,
      status: this.status,
      ...(this.haltedSlice !== undefined
        ? { failingSlice: this.haltedSlice }
        : {}),
      routeAfterWatch:
        this.status === "halted" ? "champion" : "challenger",
      observedSliceCount: this.metrics.size,
      domainPackCount: packs.size,
      requiredSliceCount: this.baselines.size,
      metrics: Object.freeze(metrics),
      operationId,
      idempotentReplay,
    });
  }

  private fail(
    obligation: CanaryFailureClass,
    message: string,
    subjectId: string,
    failingSlice?: string,
  ): never {
    this.onTelemetry?.({
      event: "learning.canary.drift",
      outcome: "fail",
      subjectId,
      deviceId: this.deviceId,
      cohortId: this.config.cohortId,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
      failureClass: obligation,
    });
    throw new CanaryContractError(message, {
      obligation,
      subjectId,
      deviceId: this.deviceId,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
    });
  }
}

export const FLEET_ORCH_SCHEMA_VERSION =
  "learning.fleet-orchestrator.v1" as const;

export const FLEET_ORCH_CACHE_LIMIT = 32;

export type FleetStage = "shadow" | "canary" | "fleet" | "rejected";

export type FleetOrchFailureClass =
  | "fleet.subject_scope"
  | "fleet.stage_illegal"
  | "fleet.shadow_incomplete"
  | "fleet.shadow_timeout"
  | "fleet.shadow_tie"
  | "fleet.shadow_behind"
  | "fleet.coverage_skew"
  | "fleet.canary_unhealthy"
  | "fleet.canary_halted"
  | "fleet.golden_incomplete"
  | "fleet.tie_no_promote"
  | "fleet.attribution_void"
  | "fleet.baseline_invalid"
  | "fleet.idempotent_conflict";

export type FleetOrchTelemetryEvent = {
  event: "learning.fleet_orchestrator.transition";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  candidateId: string;
  operationId?: string;
  fromStage?: FleetStage;
  toStage?: FleetStage;
  failingSlice?: string;
  goldenPassRate?: number;
  idempotentReplay?: boolean;
  failureClass?: FleetOrchFailureClass;
};

export class FleetOrchestratorError extends Error {
  readonly obligation: FleetOrchFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: FleetOrchFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "FleetOrchestratorError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

export type FleetGoldenSuiteGate = {
  suiteId: string;
  /** Must be exactly 1 — partial golden pass never promotes. */
  passRate: number;
  passed: number;
  total: number;
};

export type FleetBaselineGate = {
  baselineRegistryHash: string;
  baselineFrozen: true;
  baselineDecontaminated: true;
};

export type FleetTransitionResult = {
  schemaVersion: typeof FLEET_ORCH_SCHEMA_VERSION;
  operationId: string;
  candidateId: string;
  subjectId: string;
  deviceId: string;
  fromStage: FleetStage;
  toStage: FleetStage;
  promoted: boolean;
  failingSlice?: string;
  failureClass?: FleetOrchFailureClass;
  goldenPassRate?: number;
  idempotentReplay: boolean;
};

/**
 * Shadow → canary → fleet state machine. Each transition is gated; ties and
 * incomplete evidence never promote. Does not serve challenger outputs.
 */
export class FleetPromotionOrchestrator {
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly candidateId: string;
  private readonly surgeryClass: string;
  private readonly minDomainPackCoverage: number;
  private readonly onTelemetry:
    | ((event: FleetOrchTelemetryEvent) => void)
    | undefined;
  private stage: FleetStage = "shadow";
  private shadowReport: ShadowComparisonReport | undefined;
  private canaryReport: CanaryDriftReport | undefined;
  private readonly byOperation = new Map<string, FleetTransitionResult>();

  constructor(options: {
    subjectId: string;
    deviceId: string;
    candidateId: string;
    /** Exactly one surgery class — multi-class candidates are attribution-void. */
    surgeryClass: string;
    minDomainPackCoverage?: number;
    onTelemetry?: (event: FleetOrchTelemetryEvent) => void;
  }) {
    this.subjectId = requireFleetId(options.subjectId, "subjectId");
    this.deviceId = requireFleetId(options.deviceId, "deviceId");
    this.candidateId = requireFleetId(options.candidateId, "candidateId");
    this.surgeryClass = requireFleetId(options.surgeryClass, "surgeryClass");
    this.minDomainPackCoverage =
      options.minDomainPackCoverage ?? SHADOW_MIN_DOMAIN_PACK_COVERAGE;
    this.onTelemetry = options.onTelemetry;
  }

  get currentStage(): FleetStage {
    return this.stage;
  }

  /**
   * Gate shadow → canary. Requires challenger_ahead on a complete multi-pack
   * shadow run. Timeouts, ties, and regressions reject without advancing.
   */
  advanceFromShadow(input: {
    operationId: string;
    subjectId: string;
    deviceId: string;
    shadow: ShadowComparisonReport;
  }): FleetTransitionResult {
    const operationId = requireFleetId(input.operationId, "operationId");
    this.assertScope(input.subjectId, input.deviceId, operationId);
    const prior = this.replay(operationId, "shadow", "canary");
    if (prior) return prior;
    if (this.stage === "rejected") {
      return this.reject(
        operationId,
        "shadow",
        "fleet.stage_illegal",
        "orchestrator already rejected — cannot advance",
      );
    }
    if (this.stage !== "shadow") {
      return this.reject(
        operationId,
        this.stage,
        "fleet.stage_illegal",
        `expected stage=shadow, found ${this.stage}`,
      );
    }

    const shadow = input.shadow;
    if (shadow.subjectId !== this.subjectId || shadow.deviceId !== this.deviceId) {
      return this.reject(
        operationId,
        "shadow",
        "fleet.subject_scope",
        "shadow report subject/device mismatch",
        shadow.failingSlice,
      );
    }
    if (shadow.timedOut || shadow.advisory === "shadow_timeout") {
      return this.reject(
        operationId,
        "shadow",
        "fleet.shadow_timeout",
        "shadow timeout holds champion — never promotes",
      );
    }
    if (!shadow.completed) {
      return this.reject(
        operationId,
        "shadow",
        "fleet.shadow_incomplete",
        "incomplete shadow run never promotes",
      );
    }
    if (shadow.verdict === "challenger_behind" || shadow.verdict === "reject") {
      return this.reject(
        operationId,
        "shadow",
        "fleet.shadow_behind",
        "challenger behind on shadow — rejected",
        shadow.failingSlice,
      );
    }
    if (shadow.advisory === "coverage_skew") {
      return this.reject(
        operationId,
        "shadow",
        "fleet.coverage_skew",
        "single domain-pack shadow evidence is insufficient",
        shadow.failingSlice,
      );
    }
    if (shadow.advisory === "tie" || shadow.verdict === "hold_champion") {
      return this.reject(
        operationId,
        "shadow",
        "fleet.shadow_tie",
        "ties do not promote from shadow",
        shadow.failingSlice,
      );
    }
    if (shadow.verdict !== "challenger_ahead") {
      return this.reject(
        operationId,
        "shadow",
        "fleet.shadow_incomplete",
        "shadow must signal challenger_ahead before canary",
      );
    }
    if (shadow.domainPackCount < this.minDomainPackCoverage) {
      return this.reject(
        operationId,
        "shadow",
        "fleet.coverage_skew",
        "shadow domain-pack coverage below minimum",
      );
    }
    if (shadow.userFacing.some((serve) => serve.source !== "champion")) {
      return this.reject(
        operationId,
        "shadow",
        "fleet.shadow_incomplete",
        "shadow must never serve challenger outputs",
      );
    }

    this.shadowReport = shadow;
    this.stage = "canary";
    return this.commit(operationId, "shadow", "canary", true);
  }

  /**
   * Gate canary → fleet. Requires healthy multi-slice canary, 100% golden
   * suite, frozen/decontaminated baselines, and at least one strict slice
   * improvement (ties do not promote).
   */
  advanceFromCanary(input: {
    operationId: string;
    subjectId: string;
    deviceId: string;
    canary: CanaryDriftReport;
    golden: FleetGoldenSuiteGate;
    baseline: FleetBaselineGate;
  }): FleetTransitionResult {
    const operationId = requireFleetId(input.operationId, "operationId");
    this.assertScope(input.subjectId, input.deviceId, operationId);
    const prior = this.replay(operationId, "canary", "fleet");
    if (prior) return prior;
    if (this.stage === "rejected") {
      return this.reject(
        operationId,
        "canary",
        "fleet.stage_illegal",
        "orchestrator already rejected — cannot advance",
      );
    }
    if (this.stage !== "canary") {
      return this.reject(
        operationId,
        this.stage,
        "fleet.stage_illegal",
        `expected stage=canary, found ${this.stage}`,
      );
    }

    if (input.baseline.baselineFrozen !== true) {
      return this.reject(
        operationId,
        "canary",
        "fleet.baseline_invalid",
        "fleet requires frozen C0 baselines",
      );
    }
    if (input.baseline.baselineDecontaminated !== true) {
      return this.reject(
        operationId,
        "canary",
        "fleet.baseline_invalid",
        "fleet requires decontaminated C0 baselines",
      );
    }

    const canary = input.canary;
    if (canary.status === "halted") {
      return this.reject(
        operationId,
        "canary",
        "fleet.canary_halted",
        "canary halt blocks fleet promotion",
        canary.failingSlice,
      );
    }
    if (canary.status !== "healthy") {
      return this.reject(
        operationId,
        "canary",
        "fleet.canary_unhealthy",
        "canary must be healthy before fleet",
        canary.failingSlice,
      );
    }
    if (canary.observedSliceCount !== canary.requiredSliceCount) {
      return this.reject(
        operationId,
        "canary",
        "fleet.canary_unhealthy",
        "canary slice coverage incomplete",
      );
    }
    if (canary.domainPackCount < this.minDomainPackCoverage) {
      return this.reject(
        operationId,
        "canary",
        "fleet.coverage_skew",
        "canary domain-pack coverage below minimum",
      );
    }
    const breached = canary.metrics.find((m) => m.breached);
    if (breached) {
      return this.reject(
        operationId,
        "canary",
        "fleet.canary_halted",
        "per-slice drift breach blocks fleet",
        breached.sliceId,
      );
    }

    const golden = input.golden;
    if (
      !Number.isFinite(golden.passRate) ||
      golden.passRate !== 1 ||
      golden.passed !== golden.total ||
      golden.total <= 0
    ) {
      return this.reject(
        operationId,
        "canary",
        "fleet.golden_incomplete",
        "100% golden-turn suite required for fleet",
        undefined,
        golden.passRate,
      );
    }

    // Ties do not promote: require at least one strict slice improvement.
    const improved = canary.metrics.some(
      (m) => m.meanScore > m.baselineScore + Number.EPSILON,
    );
    if (!improved) {
      return this.reject(
        operationId,
        "canary",
        "fleet.tie_no_promote",
        "ties do not promote — need strict per-slice improvement",
      );
    }

    this.canaryReport = canary;
    this.stage = "fleet";
    return this.commit(operationId, "canary", "fleet", true, golden.passRate);
  }

  /**
   * Refuse multi-surgery candidates before any stage advance.
   */
  static assertOneSurgery(surgeryClasses: ReadonlyArray<string>): void {
    if (surgeryClasses.length !== 1 || !surgeryClasses[0]?.trim()) {
      throw new FleetOrchestratorError(
        "one surgery type per stage — multi-class candidate is attribution-void",
        {
          obligation: "fleet.attribution_void",
          failingSlice: surgeryClasses.join("+") || "(empty)",
        },
      );
    }
  }

  private assertScope(
    subjectId: string,
    deviceId: string,
    operationId: string,
  ): void {
    if (
      requireFleetId(subjectId, "subjectId") !== this.subjectId ||
      requireFleetId(deviceId, "deviceId") !== this.deviceId
    ) {
      this.onTelemetry?.({
        event: "learning.fleet_orchestrator.transition",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        candidateId: this.candidateId,
        operationId,
        failureClass: "fleet.subject_scope",
      });
      throw new FleetOrchestratorError(
        "cross-subject fleet orchestrator access denied",
        {
          obligation: "fleet.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
  }

  private replay(
    operationId: string,
    fromStage: FleetStage,
    toStage: FleetStage,
  ): FleetTransitionResult | undefined {
    const prior = this.byOperation.get(operationId);
    if (!prior) return undefined;
    if (prior.fromStage !== fromStage || prior.toStage !== toStage) {
      throw new FleetOrchestratorError(
        "operationId replay with divergent transition",
        {
          obligation: "fleet.idempotent_conflict",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
    const replayed = { ...prior, idempotentReplay: true as const };
    this.onTelemetry?.({
      event: "learning.fleet_orchestrator.transition",
      outcome: replayed.promoted ? "ok" : "fail",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      candidateId: this.candidateId,
      operationId,
      fromStage: replayed.fromStage,
      toStage: replayed.toStage,
      idempotentReplay: true,
      ...(replayed.failingSlice !== undefined
        ? { failingSlice: replayed.failingSlice }
        : {}),
      ...(replayed.failureClass !== undefined
        ? { failureClass: replayed.failureClass }
        : {}),
    });
    return replayed;
  }

  private commit(
    operationId: string,
    fromStage: FleetStage,
    toStage: FleetStage,
    promoted: boolean,
    goldenPassRate?: number,
  ): FleetTransitionResult {
    const result: FleetTransitionResult = Object.freeze({
      schemaVersion: FLEET_ORCH_SCHEMA_VERSION,
      operationId,
      candidateId: this.candidateId,
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      fromStage,
      toStage,
      promoted,
      ...(goldenPassRate !== undefined ? { goldenPassRate } : {}),
      idempotentReplay: false,
    });
    this.remember(operationId, result);
    this.onTelemetry?.({
      event: "learning.fleet_orchestrator.transition",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      candidateId: this.candidateId,
      operationId,
      fromStage,
      toStage,
      ...(goldenPassRate !== undefined ? { goldenPassRate } : {}),
      idempotentReplay: false,
    });
    return result;
  }

  private reject(
    operationId: string,
    fromStage: FleetStage,
    failureClass: FleetOrchFailureClass,
    _detail: string,
    failingSlice?: string,
    goldenPassRate?: number,
  ): FleetTransitionResult {
    this.stage = "rejected";
    const result: FleetTransitionResult = Object.freeze({
      schemaVersion: FLEET_ORCH_SCHEMA_VERSION,
      operationId,
      candidateId: this.candidateId,
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      fromStage,
      toStage: "rejected",
      promoted: false,
      failureClass,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
      ...(goldenPassRate !== undefined ? { goldenPassRate } : {}),
      idempotentReplay: false,
    });
    this.remember(operationId, result);
    this.onTelemetry?.({
      event: "learning.fleet_orchestrator.transition",
      outcome: "fail",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      candidateId: this.candidateId,
      operationId,
      fromStage,
      toStage: "rejected",
      failureClass,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
      ...(goldenPassRate !== undefined ? { goldenPassRate } : {}),
      idempotentReplay: false,
    });
    return result;
  }

  private remember(operationId: string, result: FleetTransitionResult): void {
    this.byOperation.set(operationId, result);
    if (this.byOperation.size > FLEET_ORCH_CACHE_LIMIT) {
      const first = this.byOperation.keys().next().value;
      if (first !== undefined) this.byOperation.delete(first);
    }
  }
}

function requireFleetId(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 128) {
    throw new FleetOrchestratorError(`${field} required`, {
      obligation: "fleet.subject_scope",
    });
  }
  return trimmed;
}

/**
 * Synthetic end-to-end prove: known-good candidate reaches fleet; known-
 * regressed candidate is rejected with the failing slice named.
 */
export async function proveFleetPromotionOrchestratorMicroRun(opts?: {
  onTelemetry?: (event: FleetOrchTelemetryEvent) => void;
}): Promise<{
  ok: true;
  promoted: FleetTransitionResult;
  rejected: FleetTransitionResult;
  stages: ReadonlyArray<FleetStage>;
}> {
  resetShadowScoringRunCache();
  const subjectId = "subj.fleet.prove";
  const deviceId = "dev.fleet.prove";
  const candidateId = "cand.fleet.synthetic.good";

  FleetPromotionOrchestrator.assertOneSurgery(["adapter"]);

  const shadowSamples: ShadowTrafficSample[] = [
    sampleFixture({
      sampleId: "fleet.s1",
      subjectId,
      sliceId: "teacher/en/b8",
      champion: 0.7,
      championOut: "fleet-champ-1",
    }),
    sampleFixture({
      sampleId: "fleet.s2",
      subjectId,
      sliceId: "doctor/en/b8",
      champion: 0.65,
      championOut: "fleet-champ-2",
    }),
  ];
  const shadow = await runShadowScoringAgainstChampion({
    subjectId,
    deviceId,
    runId: "run.fleet.shadow.good",
    samples: shadowSamples,
    scoreChallenger: (sample) => ({
      criticScore: sample.championCriticScore + 0.1,
      outputHash: hashOpaque(`challenger:${sample.sampleId}`),
    }),
  });

  const good = new FleetPromotionOrchestrator({
    subjectId,
    deviceId,
    candidateId,
    surgeryClass: "adapter",
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  const toCanary = good.advanceFromShadow({
    operationId: "op.fleet.shadow.good",
    subjectId,
    deviceId,
    shadow,
  });
  if (!toCanary.promoted || toCanary.toStage !== "canary") {
    throw new Error("known-good must advance shadow→canary");
  }

  const canary = new CanaryCohortController({
    deviceId,
    config: {
      cohortId: "cohort.fleet.good",
      subjectFraction: 1,
      assignmentSeed: "seed:fleet:good",
      baselineRegistryHash: hashOpaque("c0-fleet-baseline"),
      baselineFrozen: true,
      baselineDecontaminated: true,
      surgeryClass: "adapter",
      minDomainPackCoverage: 2,
      slices: [
        { sliceId: "teacher/en/b8", score: 0.8, tolerance: 0.05 },
        { sliceId: "doctor/en/b8", score: 0.75, tolerance: 0.05 },
      ],
    },
  });
  canary.routeAtTurnBoundary({
    operationId: "route.fleet.good",
    subjectId,
    deviceId,
    sessionId: "session.fleet.good",
    boundaryEvent: "TURN_COMPLETE",
  });
  canary.observeDrift({
    operationId: "drift.fleet.good.1",
    subjectId,
    deviceId,
    sliceId: "teacher/en/b8",
    score: 0.86,
  });
  const canaryHealthy = canary.observeDrift({
    operationId: "drift.fleet.good.2",
    subjectId,
    deviceId,
    sliceId: "doctor/en/b8",
    score: 0.81,
  });
  if (canaryHealthy.status !== "healthy") {
    throw new Error("known-good canary must be healthy");
  }

  const promoted = good.advanceFromCanary({
    operationId: "op.fleet.canary.good",
    subjectId,
    deviceId,
    canary: canaryHealthy,
    golden: {
      suiteId: "golden.fleet.prove",
      passRate: 1,
      passed: 12,
      total: 12,
    },
    baseline: {
      baselineRegistryHash: hashOpaque("c0-fleet-baseline"),
      baselineFrozen: true,
      baselineDecontaminated: true,
    },
  });
  if (!promoted.promoted || promoted.toStage !== "fleet") {
    throw new Error("known-good must reach fleet");
  }

  // Known-regressed: shadow behind on teacher slice.
  const badShadow = await runShadowScoringAgainstChampion({
    subjectId,
    deviceId,
    runId: "run.fleet.shadow.bad",
    samples: shadowSamples,
    scoreChallenger: (sample) => ({
      criticScore:
        sample.sliceId === "teacher/en/b8"
          ? sample.championCriticScore - 0.2
          : sample.championCriticScore + 0.05,
      outputHash: hashOpaque(`challenger:bad:${sample.sampleId}`),
    }),
  });
  const bad = new FleetPromotionOrchestrator({
    subjectId,
    deviceId,
    candidateId: "cand.fleet.synthetic.bad",
    surgeryClass: "adapter",
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  const rejected = bad.advanceFromShadow({
    operationId: "op.fleet.shadow.bad",
    subjectId,
    deviceId,
    shadow: badShadow,
  });
  if (
    rejected.promoted ||
    rejected.toStage !== "rejected" ||
    rejected.failingSlice !== "teacher/en/b8"
  ) {
    throw new Error("known-regressed must reject with failingSlice teacher/en/b8");
  }

  try {
    FleetPromotionOrchestrator.assertOneSurgery(["adapter", "critic"]);
    throw new Error("expected multi-surgery refusal");
  } catch (error) {
    if (
      !(
        error instanceof FleetOrchestratorError &&
        error.obligation === "fleet.attribution_void"
      )
    ) {
      throw error;
    }
  }

  return {
    ok: true,
    promoted,
    rejected,
    stages: ["shadow", "canary", "fleet", "rejected"],
  };
}

function validateCanaryConfig(
  config: CanaryCohortConfig,
): Required<Pick<CanaryCohortConfig, "minDomainPackCoverage">> &
  CanaryCohortConfig {
  const cohortId = requireId(config.cohortId, "cohortId");
  const assignmentSeed = requireId(config.assignmentSeed, "assignmentSeed");
  const baselineRegistryHash = requireId(
    config.baselineRegistryHash,
    "baselineRegistryHash",
  );
  const surgeryClass = requireId(config.surgeryClass, "surgeryClass");
  if (
    !Number.isFinite(config.subjectFraction) ||
    config.subjectFraction < 0 ||
    config.subjectFraction > 1
  ) {
    throw new CanaryContractError(
      "subjectFraction must be finite in [0,1]",
      { obligation: "canary.config_invalid" },
    );
  }
  if (config.baselineFrozen !== true) {
    throw new CanaryContractError(
      "canary requires a frozen C0 baseline registry",
      { obligation: "canary.baseline_unfrozen" },
    );
  }
  if (config.baselineDecontaminated !== true) {
    throw new CanaryContractError(
      "canary requires decontaminated C0 eval baselines",
      { obligation: "canary.baseline_contaminated" },
    );
  }
  if (
    config.slices.length === 0 ||
    config.slices.length > CANARY_SLICE_LIMIT
  ) {
    throw new CanaryContractError(
      `canary slices must be 1..${CANARY_SLICE_LIMIT}`,
      { obligation: "canary.slice_limit" },
    );
  }
  const seen = new Set<string>();
  for (const slice of config.slices) {
    parseDomainPack(slice.sliceId);
    if (seen.has(slice.sliceId)) {
      throw new CanaryContractError(
        "duplicate canary baseline slice",
        {
          obligation: "canary.config_invalid",
          failingSlice: slice.sliceId,
        },
      );
    }
    seen.add(slice.sliceId);
    if (
      !Number.isFinite(slice.score) ||
      slice.score < 0 ||
      slice.score > 1 ||
      !Number.isFinite(slice.tolerance) ||
      slice.tolerance < 0 ||
      slice.tolerance > 1
    ) {
      throw new CanaryContractError(
        "canary baseline score/tolerance must be finite in [0,1]",
        {
          obligation: "canary.config_invalid",
          failingSlice: slice.sliceId,
        },
      );
    }
  }
  const minDomainPackCoverage =
    config.minDomainPackCoverage ?? SHADOW_MIN_DOMAIN_PACK_COVERAGE;
  if (
    !Number.isInteger(minDomainPackCoverage) ||
    minDomainPackCoverage < 1 ||
    minDomainPackCoverage > CANARY_SLICE_LIMIT
  ) {
    throw new CanaryContractError(
      "minDomainPackCoverage must be a bounded positive integer",
      { obligation: "canary.config_invalid" },
    );
  }
  const configuredDomainPacks = new Set(
    config.slices.map((slice) => parseDomainPack(slice.sliceId)),
  );
  if (configuredDomainPacks.size < minDomainPackCoverage) {
    throw new CanaryContractError(
      "frozen canary baselines do not meet minimum domain-pack coverage",
      { obligation: "canary.config_invalid" },
    );
  }
  return Object.freeze({
    ...config,
    cohortId,
    assignmentSeed,
    baselineRegistryHash,
    surgeryClass,
    slices: Object.freeze(config.slices.map((s) => Object.freeze({ ...s }))),
    minDomainPackCoverage,
  });
}

function deterministicBucket(
  cohortId: string,
  seed: string,
  subjectId: string,
): number {
  const bytes = createHash("sha256")
    .update(cohortId, "utf8")
    .update("\0", "utf8")
    .update(seed, "utf8")
    .update("\0", "utf8")
    .update(subjectId, "utf8")
    .digest();
  return bytes.readUInt32BE(0) / 0x1_0000_0000;
}

class ShadowTimeoutError extends Error {
  constructor() {
    super("shadow scoring timeout");
    this.name = "ShadowTimeoutError";
  }
}

async function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ShadowScoringError("timeoutMs must be positive", {
      obligation: "shadow.sample_invalid",
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ShadowTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function scoreAllChallengerSamples(input: {
  samples: ReadonlyArray<ShadowTrafficSample>;
  scoreChallenger: ShadowChallengerScorer;
  subjectId: string;
  deviceId: string;
  runId: string;
  onTelemetry?: (event: ShadowScoringTelemetryEvent) => void;
}): Promise<ShadowChallengerScore[]> {
  const out: ShadowChallengerScore[] = [];
  for (const sample of input.samples) {
    const scored = await input.scoreChallenger(sample);
    if (
      typeof scored.criticScore !== "number" ||
      !Number.isFinite(scored.criticScore) ||
      scored.criticScore < 0 ||
      scored.criticScore > 1
    ) {
      throw new ShadowScoringError("challenger critic score must be in [0,1]", {
        obligation: "shadow.score_invalid",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        failingSlice: sample.sliceId,
      });
    }
    requireId(scored.outputHash, "outputHash");
    // Never allow challenger hash to be written as a serve source.
    if (scored.outputHash === sample.championOutputHash) {
      // Identical hash is allowed for audit (same bytes) but serve stays champion.
    }
    input.onTelemetry?.({
      event: "learning.shadow_scoring.sample",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      runId: input.runId,
      sampleId: sample.sampleId,
      sliceId: sample.sliceId,
    });
    out.push({
      criticScore: scored.criticScore,
      outputHash: scored.outputHash,
    });
  }
  return out;
}

function aggregateSliceScores(
  samples: ReadonlyArray<ShadowTrafficSample>,
  challengerScores: ReadonlyArray<ShadowChallengerScore>,
): Map<string, ShadowSliceScoreRow> {
  const acc = new Map<
    string,
    { domainPackId: string; champ: number[]; chall: number[] }
  >();
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const parsed = parseDomainPack(sample.sliceId);
    const row = acc.get(sample.sliceId) ?? {
      domainPackId: parsed,
      champ: [],
      chall: [],
    };
    row.champ.push(sample.championCriticScore);
    row.chall.push(challengerScores[i]!.criticScore);
    acc.set(sample.sliceId, row);
  }
  const out = new Map<string, ShadowSliceScoreRow>();
  for (const [sliceId, row] of acc) {
    const championScore = mean(row.champ);
    const challengerScore = mean(row.chall);
    const delta = challengerScore - championScore;
    let status: ShadowSliceScoreRow["status"] = "tie";
    if (challengerScore + Number.EPSILON < championScore) status = "behind";
    else if (challengerScore > championScore + Number.EPSILON) status = "ahead";
    out.set(sliceId, {
      sliceId,
      domainPackId: row.domainPackId,
      championScore,
      challengerScore,
      delta,
      status,
    });
  }
  return out;
}

function countDomainPacks(samples: ReadonlyArray<ShadowTrafficSample>): number {
  const packs = new Set<string>();
  for (const sample of samples) {
    packs.add(parseDomainPack(sample.sliceId));
  }
  return packs.size;
}

function parseDomainPack(sliceId: string): string {
  const parts = sliceId.split("/");
  if (parts.length !== 3 || !parts[0]) {
    throw new ShadowScoringError("sliceId must be domainPackId/language/bindingId", {
      obligation: "shadow.slice_invalid",
      failingSlice: sliceId,
    });
  }
  return parts[0];
}

function assertSampleShape(
  sample: ShadowTrafficSample,
  subjectId: string,
  deviceId: string,
): void {
  requireId(sample.sampleId, "sampleId");
  requireId(sample.inputHash, "inputHash");
  requireId(sample.championOutputHash, "championOutputHash");
  parseDomainPack(sample.sliceId);
  if (
    typeof sample.championCriticScore !== "number" ||
    !Number.isFinite(sample.championCriticScore) ||
    sample.championCriticScore < 0 ||
    sample.championCriticScore > 1
  ) {
    throw new ShadowScoringError("champion critic score must be in [0,1]", {
      obligation: "shadow.score_invalid",
      subjectId,
      deviceId,
      failingSlice: sample.sliceId,
    });
  }
}

function sampleFixture(input: {
  sampleId: string;
  subjectId: string;
  sliceId: string;
  champion: number;
  championOut: string;
}): ShadowTrafficSample {
  return {
    sampleId: input.sampleId,
    subjectId: input.subjectId,
    sliceId: input.sliceId,
    inputHash: hashOpaque(`input:${input.sampleId}`),
    championCriticScore: input.champion,
    championOutputHash: hashOpaque(input.championOut),
  };
}

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function hashOpaque(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function freezeReport(report: ShadowComparisonReport): ShadowComparisonReport {
  return Object.freeze({
    ...report,
    slices: Object.freeze([...report.slices]),
    userFacing: Object.freeze([...report.userFacing]),
    challengerAuditHashes: Object.freeze([...report.challengerAuditHashes]),
  });
}

function rememberRun(report: ShadowComparisonReport): void {
  byRunId.set(report.runId, report);
  if (byRunId.size > SHADOW_RUN_CACHE_LIMIT) {
    const first = byRunId.keys().next().value;
    if (first !== undefined) byRunId.delete(first);
  }
}

function requireId(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 128) {
    throw new ShadowScoringError(`${field} required`, {
      obligation:
        field === "subjectId" || field === "runId"
          ? "shadow.subject_scope"
          : "shadow.sample_invalid",
    });
  }
  return trimmed;
}
