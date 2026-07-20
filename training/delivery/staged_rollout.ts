/**
 * Staged rollout delivery — shadow scoring stage (C5).
 *
 * Duplicates live traffic to the challenger for C3 critic + C0 slice scoring
 * without ever serving challenger outputs. Comparison reports feed later
 * canary/fleet stages; incomplete or timed-out shadow runs hold champion.
 */

import {
  CANARY_DRIFT_SCHEMA_VERSION,
  CanaryCohortController,
  CanaryContractError,
  FLEET_ORCH_SCHEMA_VERSION,
  FleetOrchestratorError,
  FleetPromotionOrchestrator,
  SHADOW_DEFAULT_TIMEOUT_MS,
  SHADOW_MIN_DOMAIN_PACK_COVERAGE,
  SHADOW_SAMPLE_LIMIT,
  SHADOW_SCORING_SCHEMA_VERSION,
  ShadowScoringError,
  proveFleetPromotionOrchestratorMicroRun,
  proveShadowScoringMicroRun,
  resetShadowScoringRunCache,
  runShadowScoringAgainstChampion,
  type ShadowChallengerScorer,
  type ShadowComparisonReport,
  type ShadowScoringTelemetryEvent,
  type ShadowTrafficSample,
  type ShadowUserFacingServe,
  type CanaryCohortConfig,
  type CanaryDriftReport,
  type CanaryRouteDecision,
  type CanaryTelemetryEvent,
  type FleetBaselineGate,
  type FleetGoldenSuiteGate,
  type FleetOrchTelemetryEvent,
  type FleetStage,
  type FleetTransitionResult,
} from "../../packages/learning/src/champion_challenger.ts";

export const STAGED_ROLLOUT_SHADOW_STAGE =
  "staged-rollout.shadow" as const;

export const STAGED_ROLLOUT_SCHEMA_VERSION =
  "training.staged-rollout.shadow.v1" as const;

export type StagedRolloutShadowTelemetryEvent = {
  event: "training.staged_rollout.shadow";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  runId: string;
  stage: typeof STAGED_ROLLOUT_SHADOW_STAGE;
  verdict?: ShadowComparisonReport["verdict"];
  failingSlice?: string;
  servedChampionOnly?: true;
  sampleCount?: number;
  domainPackCount?: number;
  idempotentReplay?: boolean;
  failureClass?: string;
};

export type StagedRolloutShadowResult = {
  ok: true;
  stage: typeof STAGED_ROLLOUT_SHADOW_STAGE;
  schemaVersion: typeof STAGED_ROLLOUT_SCHEMA_VERSION;
  report: ShadowComparisonReport;
  /** User-facing serves from this stage — always champion. */
  userFacing: ReadonlyArray<ShadowUserFacingServe>;
  /** Convenience: true iff every serve is champion-sourced. */
  challengerServed: false;
};

export const STAGED_ROLLOUT_CANARY_STAGE =
  "staged-rollout.canary" as const;

export type StagedRolloutCanaryTelemetryEvent = {
  event:
    | "training.staged_rollout.canary_route"
    | "training.staged_rollout.canary_drift";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  cohortId: string;
  operationId: string;
  stage: typeof STAGED_ROLLOUT_CANARY_STAGE;
  route?: "champion" | "challenger";
  status?: CanaryDriftReport["status"];
  failingSlice?: string;
  baselineRegistryHash?: string;
  idempotentReplay?: boolean;
  failureClass?: string;
};

/**
 * Delivery wrapper for deterministic canary routing and frozen-baseline drift.
 * It exposes no fleet promotion operation; a healthy watch only continues the
 * canary while a breach immediately routes subsequent turns to champion.
 */
export class StagedRolloutCanary {
  private readonly controller: CanaryCohortController;
  private readonly onTelemetry:
    | ((event: StagedRolloutCanaryTelemetryEvent) => void)
    | undefined;

  constructor(options: {
    config: CanaryCohortConfig;
    deviceId: string;
    onTelemetry?: (event: StagedRolloutCanaryTelemetryEvent) => void;
    onCanaryTelemetry?: (event: CanaryTelemetryEvent) => void;
  }) {
    this.onTelemetry = options.onTelemetry;
    this.controller = new CanaryCohortController({
      config: options.config,
      deviceId: options.deviceId,
      ...(options.onCanaryTelemetry !== undefined
        ? { onTelemetry: options.onCanaryTelemetry }
        : {}),
    });
  }

  get status(): CanaryDriftReport["status"] {
    return this.controller.status;
  }

  routeAtTurnBoundary(input: {
    operationId: string;
    subjectId: string;
    deviceId: string;
    sessionId: string;
    boundaryEvent: "TURN_COMPLETE";
  }): CanaryRouteDecision {
    try {
      const decision = this.controller.routeAtTurnBoundary(input);
      this.onTelemetry?.({
        event: "training.staged_rollout.canary_route",
        outcome:
          decision.status === "halted" ? "advisory" : "ok",
        subjectId: decision.subjectId,
        deviceId: decision.deviceId,
        cohortId: decision.cohortId,
        operationId: decision.operationId,
        stage: STAGED_ROLLOUT_CANARY_STAGE,
        route: decision.route,
        status: decision.status,
        idempotentReplay: decision.idempotentReplay,
      });
      return decision;
    } catch (error) {
      this.emitCanaryFailure(error, input);
      throw error;
    }
  }

  observeDrift(input: {
    operationId: string;
    subjectId: string;
    deviceId: string;
    sliceId: string;
    score: number;
  }): CanaryDriftReport {
    try {
      const report = this.controller.observeDrift(input);
      this.onTelemetry?.({
        event: "training.staged_rollout.canary_drift",
        outcome: report.status === "halted" ? "fail" : "ok",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        cohortId: report.cohortId,
        operationId: report.operationId,
        stage: STAGED_ROLLOUT_CANARY_STAGE,
        status: report.status,
        baselineRegistryHash: report.baselineRegistryHash,
        ...(report.failingSlice !== undefined
          ? { failingSlice: report.failingSlice }
          : {}),
        idempotentReplay: report.idempotentReplay,
      });
      return report;
    } catch (error) {
      this.emitCanaryFailure(error, input);
      throw error;
    }
  }

  snapshot(operationId: string): CanaryDriftReport {
    return this.controller.snapshot(operationId);
  }

  private emitCanaryFailure(
    error: unknown,
    input: {
      operationId: string;
      subjectId: string;
      deviceId: string;
    },
  ): void {
    if (!(error instanceof CanaryContractError)) return;
    this.onTelemetry?.({
      event: "training.staged_rollout.canary_drift",
      outcome: "fail",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      cohortId: "(rejected)",
      operationId: input.operationId,
      stage: STAGED_ROLLOUT_CANARY_STAGE,
      ...(error.failingSlice !== undefined
        ? { failingSlice: error.failingSlice }
        : {}),
      failureClass: error.obligation,
    });
  }
}

export const STAGED_ROLLOUT_FLEET_STAGE =
  "staged-rollout.fleet" as const;

export type StagedRolloutFleetTelemetryEvent = {
  event: "training.staged_rollout.fleet";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  candidateId: string;
  operationId: string;
  stage: typeof STAGED_ROLLOUT_FLEET_STAGE;
  fromStage?: FleetStage;
  toStage?: FleetStage;
  promoted?: boolean;
  failingSlice?: string;
  goldenPassRate?: number;
  idempotentReplay?: boolean;
  failureClass?: string;
};

/**
 * Delivery orchestrator for shadow → canary → fleet. Gate checks fire at each
 * transition; ties and incomplete golden/canary evidence never promote.
 */
export class StagedRolloutFleetOrchestrator {
  private readonly orch: FleetPromotionOrchestrator;
  private readonly onTelemetry:
    | ((event: StagedRolloutFleetTelemetryEvent) => void)
    | undefined;

  constructor(options: {
    subjectId: string;
    deviceId: string;
    candidateId: string;
    surgeryClass: string;
    minDomainPackCoverage?: number;
    onTelemetry?: (event: StagedRolloutFleetTelemetryEvent) => void;
    onFleetTelemetry?: (event: FleetOrchTelemetryEvent) => void;
  }) {
    FleetPromotionOrchestrator.assertOneSurgery([options.surgeryClass]);
    this.onTelemetry = options.onTelemetry;
    this.orch = new FleetPromotionOrchestrator({
      subjectId: options.subjectId,
      deviceId: options.deviceId,
      candidateId: options.candidateId,
      surgeryClass: options.surgeryClass,
      ...(options.minDomainPackCoverage !== undefined
        ? { minDomainPackCoverage: options.minDomainPackCoverage }
        : {}),
      ...(options.onFleetTelemetry !== undefined
        ? { onTelemetry: options.onFleetTelemetry }
        : {}),
    });
  }

  get currentStage(): FleetStage {
    return this.orch.currentStage;
  }

  advanceFromShadow(input: {
    operationId: string;
    subjectId: string;
    deviceId: string;
    shadow: ShadowComparisonReport;
  }): FleetTransitionResult {
    const result = this.orch.advanceFromShadow(input);
    this.emit(result);
    return result;
  }

  advanceFromCanary(input: {
    operationId: string;
    subjectId: string;
    deviceId: string;
    canary: CanaryDriftReport;
    golden: FleetGoldenSuiteGate;
    baseline: FleetBaselineGate;
  }): FleetTransitionResult {
    const result = this.orch.advanceFromCanary(input);
    this.emit(result);
    return result;
  }

  private emit(result: FleetTransitionResult): void {
    this.onTelemetry?.({
      event: "training.staged_rollout.fleet",
      outcome: result.promoted ? "ok" : "fail",
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      candidateId: result.candidateId,
      operationId: result.operationId,
      stage: STAGED_ROLLOUT_FLEET_STAGE,
      fromStage: result.fromStage,
      toStage: result.toStage,
      promoted: result.promoted,
      idempotentReplay: result.idempotentReplay,
      ...(result.failingSlice !== undefined
        ? { failingSlice: result.failingSlice }
        : {}),
      ...(result.goldenPassRate !== undefined
        ? { goldenPassRate: result.goldenPassRate }
        : {}),
      ...(result.failureClass !== undefined
        ? { failureClass: result.failureClass }
        : {}),
    });
  }
}

/**
 * Integration-style synthetic candidate demo: shadow → canary → fleet for a
 * known-good challenger, and named-slice rejection for a known-regressed one.
 */
export async function runSyntheticFleetPromotionDemo(opts?: {
  onTelemetry?: (event: StagedRolloutFleetTelemetryEvent) => void;
  onFleetTelemetry?: (event: FleetOrchTelemetryEvent) => void;
}): Promise<{
  ok: true;
  promoted: FleetTransitionResult;
  rejected: FleetTransitionResult;
  challengerServedInShadow: false;
}> {
  const proved = await proveFleetPromotionOrchestratorMicroRun({
    ...(opts?.onFleetTelemetry !== undefined
      ? { onTelemetry: opts.onFleetTelemetry }
      : {}),
  });

  opts?.onTelemetry?.({
    event: "training.staged_rollout.fleet",
    outcome: "ok",
    subjectId: proved.promoted.subjectId,
    deviceId: proved.promoted.deviceId,
    candidateId: proved.promoted.candidateId,
    operationId: proved.promoted.operationId,
    stage: STAGED_ROLLOUT_FLEET_STAGE,
    fromStage: "canary",
    toStage: "fleet",
    promoted: true,
    goldenPassRate: 1,
    idempotentReplay: false,
  });
  opts?.onTelemetry?.({
    event: "training.staged_rollout.fleet",
    outcome: "fail",
    subjectId: proved.rejected.subjectId,
    deviceId: proved.rejected.deviceId,
    candidateId: proved.rejected.candidateId,
    operationId: proved.rejected.operationId,
    stage: STAGED_ROLLOUT_FLEET_STAGE,
    fromStage: "shadow",
    toStage: "rejected",
    promoted: false,
    ...(proved.rejected.failingSlice !== undefined
      ? { failingSlice: proved.rejected.failingSlice }
      : {}),
    ...(proved.rejected.failureClass !== undefined
      ? { failureClass: proved.rejected.failureClass }
      : {}),
    idempotentReplay: false,
  });

  return {
    ok: true,
    promoted: proved.promoted,
    rejected: proved.rejected,
    challengerServedInShadow: false,
  };
}

/**
 * Run the shadow stage: duplicate samples to challenger for scoring, keep
 * champion as the only user-facing source, emit a comparison report.
 */
export async function runStagedRolloutShadowScoring(input: {
  subjectId: string;
  deviceId: string;
  runId: string;
  samples: ReadonlyArray<ShadowTrafficSample>;
  scoreChallenger: ShadowChallengerScorer;
  timeoutMs?: number;
  surgeryClasses?: ReadonlyArray<string>;
  onTelemetry?: (event: StagedRolloutShadowTelemetryEvent) => void;
  onShadowTelemetry?: (event: ShadowScoringTelemetryEvent) => void;
}): Promise<StagedRolloutShadowResult> {
  try {
    const report = await runShadowScoringAgainstChampion({
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      runId: input.runId,
      samples: input.samples,
      scoreChallenger: input.scoreChallenger,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.surgeryClasses !== undefined
        ? { surgeryClasses: input.surgeryClasses }
        : {}),
      ...(input.onShadowTelemetry !== undefined
        ? { onTelemetry: input.onShadowTelemetry }
        : {}),
    });

    if (report.userFacing.some((serve) => serve.source !== "champion")) {
      throw new ShadowScoringError(
        "staged rollout shadow leaked non-champion serve",
        {
          obligation: "shadow.challenger_serve_forbidden",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }

    input.onTelemetry?.({
      event: "training.staged_rollout.shadow",
      outcome:
        report.verdict === "challenger_behind" || report.verdict === "reject"
          ? "fail"
          : report.advisory !== undefined
            ? "advisory"
            : "ok",
      subjectId: report.subjectId,
      deviceId: report.deviceId,
      runId: report.runId,
      stage: STAGED_ROLLOUT_SHADOW_STAGE,
      verdict: report.verdict,
      servedChampionOnly: true,
      sampleCount: report.sampleCount,
      domainPackCount: report.domainPackCount,
      idempotentReplay: report.idempotentReplay,
      ...(report.failingSlice !== undefined
        ? { failingSlice: report.failingSlice }
        : {}),
      ...(report.failureClass !== undefined
        ? { failureClass: report.failureClass }
        : {}),
    });

    return {
      ok: true,
      stage: STAGED_ROLLOUT_SHADOW_STAGE,
      schemaVersion: STAGED_ROLLOUT_SCHEMA_VERSION,
      report,
      userFacing: report.userFacing,
      challengerServed: false,
    };
  } catch (error) {
    if (error instanceof ShadowScoringError) {
      input.onTelemetry?.({
        event: "training.staged_rollout.shadow",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        runId: input.runId,
        stage: STAGED_ROLLOUT_SHADOW_STAGE,
        failureClass: error.obligation,
        ...(error.failingSlice !== undefined
          ? { failingSlice: error.failingSlice }
          : {}),
      });
    }
    throw error;
  }
}

export {
  CANARY_DRIFT_SCHEMA_VERSION,
  CanaryCohortController,
  CanaryContractError,
  FLEET_ORCH_SCHEMA_VERSION,
  FleetOrchestratorError,
  FleetPromotionOrchestrator,
  SHADOW_DEFAULT_TIMEOUT_MS,
  SHADOW_MIN_DOMAIN_PACK_COVERAGE,
  SHADOW_SAMPLE_LIMIT,
  SHADOW_SCORING_SCHEMA_VERSION,
  ShadowScoringError,
  proveFleetPromotionOrchestratorMicroRun,
  proveShadowScoringMicroRun,
  resetShadowScoringRunCache,
  runShadowScoringAgainstChampion,
};

export type {
  CanaryCohortConfig,
  CanaryDriftReport,
  CanaryRouteDecision,
  CanaryTelemetryEvent,
  FleetBaselineGate,
  FleetGoldenSuiteGate,
  FleetOrchTelemetryEvent,
  FleetStage,
  FleetTransitionResult,
  ShadowChallengerScorer,
  ShadowComparisonReport,
  ShadowScoringTelemetryEvent,
  ShadowTrafficSample,
  ShadowUserFacingServe,
};
