/**
 * Frozen compaction evaluation-suite assembly.
 *
 * The suite projects B5 golden cases into metadata-only scenario descriptors.
 * It does not execute candidates or decide promotion.
 */

import { createHash } from "node:crypto";

export const COMPACTION_EVAL_SUITE_SCHEMA_VERSION =
  "compaction.eval-suite.v1" as const;
export const COMPACTION_EVAL_SUITE_ID = "c6.compaction.full.v1" as const;
export const COMPACTION_EVAL_SCENARIO_LIMIT = 64;

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type CompactionEvalFailureClass =
  | "compaction_eval.invalid_source"
  | "compaction_eval.source_hash_mismatch"
  | "compaction_eval.required_case_missing"
  | "compaction_eval.subject_scope"
  | "compaction_eval.locality_forbidden"
  | "compaction_eval.train_on_eval_void"
  | "compaction_eval.attribution_void"
  | "compaction_eval.capacity";

export type CompactionEvalTelemetryEvent = {
  event: "learning.compaction_eval.assemble";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  suiteId: typeof COMPACTION_EVAL_SUITE_ID;
  failureClass?: CompactionEvalFailureClass;
  sourceCaseCount?: number;
  scenarioCount?: number;
  sourceContentHash?: string;
  failingScenario?: string;
};

export class CompactionEvalContractError extends Error {
  readonly obligation: CompactionEvalFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingScenario: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CompactionEvalFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingScenario?: string;
    },
  ) {
    super(message);
    this.name = "CompactionEvalContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingScenario = meta.failingScenario;
  }
}

export type B5CompactionGoldenCase = {
  id: string;
  kind:
    | "trigger"
    | "second_pass"
    | "empty_stub"
    | "tool_loop_defer"
    | "cross_subject";
  subjectId: string;
  budgetSubjectId?: string;
  expected: {
    compacted: boolean;
    deferred: boolean;
    failureClass: string | null;
  };
};

export type B5CompactionGoldenManifest = {
  fixtureFile: string;
  comparePolicy: string;
  requiredCases: readonly string[];
};

export type CompactionEvalScenario = {
  scenarioId: string;
  sourceCaseId: string;
  sliceId: string;
  pinnedSeed: number;
  expectedHarnessOutcome: "compacted" | "deferred" | "rejected";
  expectedFailureClass: string | null;
  downstreamReplay: {
    required: boolean;
    historyMode: "summary_only";
    taskId: string | null;
    timeoutMs: number;
  };
  rubricThreshold: {
    rubricId: string;
    rubricVersion: string;
    minimumTotal: number | null;
    maximumTotal: number | null;
    requireHardFail: boolean;
    consentChecksGreen: boolean;
  };
};

export type CompactionEvalSuite = {
  schemaVersion: typeof COMPACTION_EVAL_SUITE_SCHEMA_VERSION;
  suiteId: typeof COMPACTION_EVAL_SUITE_ID;
  suiteVersion: "1.0.0";
  heldOut: true;
  excludeFromTrainingCorpora: true;
  frozen: true;
  decontaminated: true;
  locality: "on-device" | "self-hosted";
  subjectId: string;
  pinnedSeed: number;
  source: {
    kind: "b5.compaction-retention";
    fixtureFile: string;
    comparePolicy: string;
    manifestContentHash: string;
    casesContentHash: string;
    requiredCaseIds: string[];
  };
  critic: {
    rubricId: string;
    rubricVersion: string;
  };
  surgeryClasses: ["learned_compaction"];
  scenarios: CompactionEvalScenario[];
  suiteContentHash: `sha256:${string}`;
};

export function computeCompactionEvalSuiteHash(
  suite:
    | CompactionEvalSuite
    | Omit<CompactionEvalSuite, "suiteContentHash">,
): `sha256:${string}` {
  const source = suite as CompactionEvalSuite;
  const { suiteContentHash: _ignored, ...withoutHash } = source;
  return computeCompactionEvalContentHash(JSON.stringify(withoutHash));
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new CompactionEvalContractError(`${field} must be a bounded id`, {
      obligation: "compaction_eval.invalid_source",
    });
  }
  return value;
}

export function computeCompactionEvalContentHash(
  bytes: string | Buffer | Uint8Array,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function mixSeed(seed: number, scenarioId: string): number {
  const digest = createHash("sha256")
    .update(`${seed}:${scenarioId}`, "utf8")
    .digest();
  return digest.readUInt32BE(0);
}

function scenarioFromB5Case(input: {
  source: B5CompactionGoldenCase;
  pinnedSeed: number;
  rubricId: string;
  rubricVersion: string;
}): CompactionEvalScenario {
  const common = {
    scenarioId: `b5.${input.source.id}`,
    sourceCaseId: input.source.id,
    pinnedSeed: mixSeed(input.pinnedSeed, input.source.id),
  };
  if (input.source.kind === "tool_loop_defer") {
    return {
      ...common,
      sliceId: "compaction/deferred/tool-loop",
      expectedHarnessOutcome: "deferred",
      expectedFailureClass: "deferred_tool_loop",
      downstreamReplay: {
        required: false,
        historyMode: "summary_only",
        taskId: null,
        timeoutMs: 2_000,
      },
      rubricThreshold: {
        rubricId: input.rubricId,
        rubricVersion: input.rubricVersion,
        minimumTotal: null,
        maximumTotal: 0,
        requireHardFail: false,
        consentChecksGreen: true,
      },
    };
  }
  if (input.source.kind === "cross_subject") {
    return {
      ...common,
      sliceId: "compaction/sovereignty/cross-subject",
      expectedHarnessOutcome: "rejected",
      expectedFailureClass: "cross_subject",
      downstreamReplay: {
        required: false,
        historyMode: "summary_only",
        taskId: null,
        timeoutMs: 2_000,
      },
      rubricThreshold: {
        rubricId: input.rubricId,
        rubricVersion: input.rubricVersion,
        minimumTotal: null,
        maximumTotal: 0,
        requireHardFail: false,
        consentChecksGreen: true,
      },
    };
  }

  const suffix =
    input.source.kind === "trigger"
      ? "constraint-citation-followup"
      : input.source.kind === "second_pass"
        ? "second-pass-followup"
        : "empty-state-followup";
  return {
    ...common,
    sliceId: `compaction/replay/${input.source.kind.replace("_", "-")}`,
    expectedHarnessOutcome: "compacted",
    expectedFailureClass: null,
    downstreamReplay: {
      required: true,
      historyMode: "summary_only",
      taskId: suffix,
      timeoutMs: 2_000,
    },
    rubricThreshold: {
      rubricId: input.rubricId,
      rubricVersion: input.rubricVersion,
      minimumTotal: 1,
      maximumTotal: null,
      requireHardFail: false,
      consentChecksGreen: true,
    },
  };
}

function consentScenario(input: {
  sourceCaseId: string;
  pinnedSeed: number;
  rubricId: string;
  rubricVersion: string;
}): CompactionEvalScenario {
  const scenarioId = "synthetic.consent-leak-hard-fail";
  return {
    scenarioId,
    sourceCaseId: input.sourceCaseId,
    sliceId: "compaction/sovereignty/consent-leak",
    pinnedSeed: mixSeed(input.pinnedSeed, scenarioId),
    expectedHarnessOutcome: "compacted",
    expectedFailureClass: null,
    downstreamReplay: {
      required: false,
      historyMode: "summary_only",
      taskId: null,
      timeoutMs: 2_000,
    },
    rubricThreshold: {
      rubricId: input.rubricId,
      rubricVersion: input.rubricVersion,
      minimumTotal: null,
      maximumTotal: -2,
      requireHardFail: true,
      consentChecksGreen: false,
    },
  };
}

export function assembleCompactionEvalSuite(input: {
  manifest: B5CompactionGoldenManifest;
  cases: readonly B5CompactionGoldenCase[];
  manifestContentHash: string;
  casesContentHash: string;
  expectedManifestContentHash: string;
  expectedCasesContentHash: string;
  trainingCorpusContentHashes: readonly string[];
  pinnedSeed: number;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  rubricId: string;
  rubricVersion: string;
  surgeryClasses: readonly string[];
  onTelemetry?: (event: CompactionEvalTelemetryEvent) => void;
}): CompactionEvalSuite {
  const subjectId = requireId(input.subjectId, "subjectId");
  const deviceId = requireId(input.deviceId, "deviceId");
  const emitFailure = (
    obligation: CompactionEvalFailureClass,
    message: string,
    failingScenario?: string,
  ): never => {
    input.onTelemetry?.({
      event: "learning.compaction_eval.assemble",
      outcome: "fail",
      subjectId,
      deviceId,
      suiteId: COMPACTION_EVAL_SUITE_ID,
      failureClass: obligation,
      sourceCaseCount: Array.isArray(input.cases) ? input.cases.length : 0,
      sourceContentHash: input.casesContentHash,
      ...(failingScenario !== undefined ? { failingScenario } : {}),
    });
    throw new CompactionEvalContractError(message, {
      obligation,
      subjectId,
      deviceId,
      ...(failingScenario !== undefined ? { failingScenario } : {}),
    });
  };

  if (
    input.locality !== "on-device" &&
    input.locality !== "self-hosted"
  ) {
    emitFailure(
      "compaction_eval.locality_forbidden",
      "compaction eval locality must remain on-device or self-hosted",
    );
  }
  if (
    !Number.isInteger(input.pinnedSeed) ||
    input.pinnedSeed < 0 ||
    input.pinnedSeed > 0xffff_ffff ||
    !Array.isArray(input.cases) ||
    input.cases.length < 1 ||
    input.cases.length > COMPACTION_EVAL_SCENARIO_LIMIT ||
    !Array.isArray(input.manifest.requiredCases) ||
    input.manifest.requiredCases.length < 1 ||
    input.manifest.requiredCases.length > COMPACTION_EVAL_SCENARIO_LIMIT ||
    input.manifest.fixtureFile !== "cases.json" ||
    input.manifest.comparePolicy !== "exact-retention-compare" ||
    !HASH_RE.test(input.manifestContentHash) ||
    !HASH_RE.test(input.casesContentHash)
  ) {
    emitFailure(
      input.cases.length > COMPACTION_EVAL_SCENARIO_LIMIT
        ? "compaction_eval.capacity"
        : "compaction_eval.invalid_source",
      "B5 compaction source is invalid or unbounded",
    );
  }
  if (
    input.manifestContentHash !== input.expectedManifestContentHash ||
    input.casesContentHash !== input.expectedCasesContentHash
  ) {
    emitFailure(
      "compaction_eval.source_hash_mismatch",
      "B5 compaction source hash differs from the frozen pin",
    );
  }
  if (
    input.trainingCorpusContentHashes.length >
    COMPACTION_EVAL_SCENARIO_LIMIT * 16
  ) {
    emitFailure(
      "compaction_eval.capacity",
      "training corpus hash list exceeds the decontamination bound",
    );
  }
  if (
    input.trainingCorpusContentHashes.includes(input.manifestContentHash) ||
    input.trainingCorpusContentHashes.includes(input.casesContentHash)
  ) {
    emitFailure(
      "compaction_eval.train_on_eval_void",
      "B5 compaction eval source collides with a training corpus hash",
    );
  }
  const uniqueSurgery = [...new Set(input.surgeryClasses)];
  if (
    uniqueSurgery.length !== 1 ||
    uniqueSurgery[0] !== "learned_compaction"
  ) {
    emitFailure(
      "compaction_eval.attribution_void",
      "compaction eval requires exactly one learned_compaction surgery class",
    );
  }

  const byId = new Map<string, B5CompactionGoldenCase>();
  for (const sourceCase of input.cases) {
    const id = requireId(sourceCase.id, "case.id");
    const knownKind =
      sourceCase.kind === "trigger" ||
      sourceCase.kind === "second_pass" ||
      sourceCase.kind === "empty_stub" ||
      sourceCase.kind === "tool_loop_defer" ||
      sourceCase.kind === "cross_subject";
    if (
      !knownKind ||
      !sourceCase.expected ||
      typeof sourceCase.expected !== "object" ||
      typeof sourceCase.expected.compacted !== "boolean" ||
      typeof sourceCase.expected.deferred !== "boolean" ||
      (sourceCase.expected.failureClass !== null &&
        typeof sourceCase.expected.failureClass !== "string")
    ) {
      emitFailure(
        "compaction_eval.invalid_source",
        `B5 compaction case ${id} has an invalid expected outcome`,
        id,
      );
    }
    if (byId.has(id)) {
      emitFailure(
        "compaction_eval.invalid_source",
        `duplicate B5 compaction case ${id}`,
        id,
      );
    }
    if (sourceCase.subjectId !== subjectId) {
      emitFailure(
        "compaction_eval.subject_scope",
        `B5 compaction case ${id} crosses subject scope`,
        id,
      );
    }
    if (
      sourceCase.kind === "cross_subject" &&
      (typeof sourceCase.budgetSubjectId !== "string" ||
        sourceCase.budgetSubjectId === subjectId ||
        sourceCase.expected.failureClass !== "cross_subject")
    ) {
      emitFailure(
        "compaction_eval.invalid_source",
        "cross-subject negative scenario must expect typed rejection",
        id,
      );
    }
    const compactedKind =
      sourceCase.kind === "trigger" ||
      sourceCase.kind === "second_pass" ||
      sourceCase.kind === "empty_stub";
    if (
      (compactedKind &&
        (!sourceCase.expected.compacted ||
          sourceCase.expected.deferred ||
          sourceCase.expected.failureClass !== null)) ||
      (sourceCase.kind === "tool_loop_defer" &&
        (sourceCase.expected.compacted ||
          !sourceCase.expected.deferred ||
          sourceCase.expected.failureClass !== "deferred_tool_loop")) ||
      (sourceCase.kind === "cross_subject" &&
        (sourceCase.expected.compacted || sourceCase.expected.deferred))
    ) {
      emitFailure(
        "compaction_eval.invalid_source",
        `B5 compaction case ${id} expectation does not match its kind`,
        id,
      );
    }
    byId.set(id, sourceCase);
  }

  const scenarios: CompactionEvalScenario[] = [];
  for (const id of input.manifest.requiredCases) {
    const source = byId.get(id);
    if (!source) {
      emitFailure(
        "compaction_eval.required_case_missing",
        `required B5 compaction case missing: ${id}`,
        id,
      );
    }
    scenarios.push(
      scenarioFromB5Case({
        source: source!,
        pinnedSeed: input.pinnedSeed,
        rubricId: requireId(input.rubricId, "rubricId"),
        rubricVersion: requireId(input.rubricVersion, "rubricVersion"),
      }),
    );
  }
  const consentSource =
    input.manifest.requiredCases.find(
      (id) => byId.get(id)?.kind === "trigger",
    ) ?? input.manifest.requiredCases[0]!;
  scenarios.push(
    consentScenario({
      sourceCaseId: consentSource,
      pinnedSeed: input.pinnedSeed,
      rubricId: input.rubricId,
      rubricVersion: input.rubricVersion,
    }),
  );
  if (scenarios.length > COMPACTION_EVAL_SCENARIO_LIMIT) {
    emitFailure(
      "compaction_eval.capacity",
      "assembled compaction scenarios exceed the suite bound",
    );
  }

  const withoutHash = {
    schemaVersion: COMPACTION_EVAL_SUITE_SCHEMA_VERSION,
    suiteId: COMPACTION_EVAL_SUITE_ID,
    suiteVersion: "1.0.0" as const,
    heldOut: true as const,
    excludeFromTrainingCorpora: true as const,
    frozen: true as const,
    decontaminated: true as const,
    locality: input.locality,
    subjectId,
    pinnedSeed: input.pinnedSeed,
    source: {
      kind: "b5.compaction-retention" as const,
      fixtureFile: input.manifest.fixtureFile,
      comparePolicy: input.manifest.comparePolicy,
      manifestContentHash: input.manifestContentHash,
      casesContentHash: input.casesContentHash,
      requiredCaseIds: [...input.manifest.requiredCases],
    },
    critic: {
      rubricId: input.rubricId,
      rubricVersion: input.rubricVersion,
    },
    surgeryClasses: ["learned_compaction"] as ["learned_compaction"],
    scenarios,
  };
  const suite: CompactionEvalSuite = {
    ...withoutHash,
    suiteContentHash: computeCompactionEvalSuiteHash(withoutHash),
  };
  input.onTelemetry?.({
    event: "learning.compaction_eval.assemble",
    outcome: "ok",
    subjectId,
    deviceId,
    suiteId: COMPACTION_EVAL_SUITE_ID,
    sourceCaseCount: input.cases.length,
    scenarioCount: scenarios.length,
    sourceContentHash: input.casesContentHash,
  });
  return suite;
}

export type CompactionGateFailureClass =
  | "compaction_gate.invalid_suite"
  | "compaction_gate.consent_scenario_missing"
  | "compaction_gate.subject_scope"
  | "compaction_gate.locality_forbidden"
  | "compaction_gate.invalid_observation"
  | "compaction_gate.downstream_timeout"
  | "compaction_gate.evaluator_failure"
  | "compaction_gate.ci_flag_off_parity"
  | "compaction_gate.ci_promote_expected"
  | "compaction_gate.ci_reject_expected"
  | "compaction_gate.ci_replay_mismatch"
  | "compaction_gate.ci_attribution_void";

export type CompactionGateRejectReason =
  | "champion_invalid"
  | "challenger_threshold_failed"
  | "challenger_regressed"
  | "consent_failed"
  | "tie";

export type CompactionScenarioObservation = {
  scenarioId: string;
  subjectId: string;
  pinnedSeed: number;
  total: number;
  hardFail: boolean;
  harnessOutcome: "compacted" | "deferred" | "rejected";
  failureClass: string | null;
  downstreamReplaySuccess: boolean;
};

export type CompactionCandidateEvaluator = {
  candidateId: string;
  subjectId: string;
  locality: "on-device" | "self-hosted";
  evaluate(
    scenario: CompactionEvalScenario,
    signal: AbortSignal,
  ):
    | CompactionScenarioObservation
    | Promise<CompactionScenarioObservation>;
};

export type CompactionPromotionTelemetryEvent = {
  event:
    | "learning.compaction_gate.scenario"
    | "learning.compaction_gate.verdict";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  suiteId: typeof COMPACTION_EVAL_SUITE_ID;
  suiteContentHash: string;
  championId: string;
  challengerId: string;
  scenarioId?: string;
  failureClass?: CompactionGateFailureClass | CompactionGateRejectReason;
  championTotal?: number;
  challengerTotal?: number;
  metricDelta?: number;
  verdict?: "promote" | "reject";
  failingScenarioCount?: number;
};

export class CompactionGateContractError extends Error {
  readonly obligation: CompactionGateFailureClass;
  readonly subjectId: string;
  readonly deviceId: string;
  readonly failingScenario: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CompactionGateFailureClass;
      subjectId: string;
      deviceId: string;
      failingScenario?: string;
    },
  ) {
    super(message);
    this.name = "CompactionGateContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingScenario = meta.failingScenario;
  }
}

export type CompactionScenarioVerdict = {
  scenarioId: string;
  sliceId: string;
  championTotal: number;
  challengerTotal: number;
  metricDelta: number;
  championPasses: boolean;
  challengerPasses: boolean;
  consentScenario: boolean;
};

export type CompactionPromotionVerdict =
  | {
      schemaVersion: "compaction.promotion-verdict.v1";
      verdict: "promote";
      promoted: true;
      suiteId: typeof COMPACTION_EVAL_SUITE_ID;
      suiteContentHash: string;
      subjectId: string;
      championId: string;
      challengerId: string;
      aggregateDelta: number;
      failingScenarioIds: [];
      scenarios: CompactionScenarioVerdict[];
    }
  | {
      schemaVersion: "compaction.promotion-verdict.v1";
      verdict: "reject";
      promoted: false;
      reason: CompactionGateRejectReason;
      suiteId: typeof COMPACTION_EVAL_SUITE_ID;
      suiteContentHash: string;
      subjectId: string;
      championId: string;
      challengerId: string;
      aggregateDelta: number;
      failingScenarioIds: string[];
      scenarios: CompactionScenarioVerdict[];
    };

const OBSERVATION_KEYS = new Set([
  "scenarioId",
  "subjectId",
  "pinnedSeed",
  "total",
  "hardFail",
  "harnessOutcome",
  "failureClass",
  "downstreamReplaySuccess",
]);

function observationPassesScenario(
  observation: CompactionScenarioObservation,
  scenario: CompactionEvalScenario,
): boolean {
  const threshold = scenario.rubricThreshold;
  const scorePasses =
    (threshold.minimumTotal === null ||
      observation.total >= threshold.minimumTotal) &&
    (threshold.maximumTotal === null ||
      observation.total <= threshold.maximumTotal);
  return (
    scorePasses &&
    observation.hardFail === threshold.requireHardFail &&
    observation.harnessOutcome === scenario.expectedHarnessOutcome &&
    observation.failureClass === scenario.expectedFailureClass &&
    (!scenario.downstreamReplay.required ||
      observation.downstreamReplaySuccess)
  );
}

function scenarioMetricDelta(
  champion: CompactionScenarioObservation,
  challenger: CompactionScenarioObservation,
  scenario: CompactionEvalScenario,
): number {
  return scenario.rubricThreshold.minimumTotal !== null
    ? challenger.total - champion.total
    : champion.total - challenger.total;
}

function validateObservation(input: {
  observation: unknown;
  scenario: CompactionEvalScenario;
  expectedSubjectId: string;
  deviceId: string;
}): CompactionScenarioObservation {
  const value = input.observation as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => !OBSERVATION_KEYS.has(key)) ||
    value.scenarioId !== input.scenario.scenarioId ||
    value.subjectId !== input.expectedSubjectId ||
    value.pinnedSeed !== input.scenario.pinnedSeed ||
    typeof value.total !== "number" ||
    !Number.isFinite(value.total) ||
    Math.abs(value.total) > 1_000_000 ||
    typeof value.hardFail !== "boolean" ||
    (value.harnessOutcome !== "compacted" &&
      value.harnessOutcome !== "deferred" &&
      value.harnessOutcome !== "rejected") ||
    (value.failureClass !== null && typeof value.failureClass !== "string") ||
    typeof value.downstreamReplaySuccess !== "boolean"
  ) {
    const obligation =
      value?.subjectId !== undefined &&
      value.subjectId !== input.expectedSubjectId
        ? "compaction_gate.subject_scope"
        : "compaction_gate.invalid_observation";
    throw new CompactionGateContractError(
      `invalid observation for scenario ${input.scenario.scenarioId}`,
      {
        obligation,
        subjectId: input.expectedSubjectId,
        deviceId: input.deviceId,
        failingScenario: input.scenario.scenarioId,
      },
    );
  }
  return value as unknown as CompactionScenarioObservation;
}

async function evaluateWithTimeout(input: {
  evaluator: CompactionCandidateEvaluator;
  scenario: CompactionEvalScenario;
  deviceId: string;
}): Promise<CompactionScenarioObservation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new CompactionGateContractError(
          `scenario ${input.scenario.scenarioId} exceeded ${input.scenario.downstreamReplay.timeoutMs}ms`,
          {
            obligation: "compaction_gate.downstream_timeout",
            subjectId: input.evaluator.subjectId,
            deviceId: input.deviceId,
            failingScenario: input.scenario.scenarioId,
          },
        ),
      );
    }, input.scenario.downstreamReplay.timeoutMs);
  });
  try {
    const observed = await Promise.race([
      Promise.resolve(
        input.evaluator.evaluate(input.scenario, controller.signal),
      ),
      timeout,
    ]);
    return validateObservation({
      observation: observed,
      scenario: input.scenario,
      expectedSubjectId: input.evaluator.subjectId,
      deviceId: input.deviceId,
    });
  } catch (error) {
    if (error instanceof CompactionGateContractError) throw error;
    throw new CompactionGateContractError(
      `evaluator ${input.evaluator.candidateId} failed on ${input.scenario.scenarioId}`,
      {
        obligation: "compaction_gate.evaluator_failure",
        subjectId: input.evaluator.subjectId,
        deviceId: input.deviceId,
        failingScenario: input.scenario.scenarioId,
      },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run champion and challenger against every frozen scenario. Candidate-quality
 * failures return a reject verdict; malformed evidence and timeouts throw typed
 * contract errors. Evaluation is sequential to avoid same-subject state races.
 */
export async function runCompactionPromotionGate(input: {
  suite: CompactionEvalSuite;
  champion: CompactionCandidateEvaluator;
  challenger: CompactionCandidateEvaluator;
  deviceId: string;
  onTelemetry?: (event: CompactionPromotionTelemetryEvent) => void;
}): Promise<CompactionPromotionVerdict> {
  const subjectId = input.suite.subjectId;
  const commonTelemetry = {
    subjectId,
    deviceId: input.deviceId,
    suiteId: COMPACTION_EVAL_SUITE_ID,
    suiteContentHash: input.suite.suiteContentHash,
    championId: input.champion.candidateId,
    challengerId: input.challenger.candidateId,
  };
  const contractFailure = (
    obligation: CompactionGateFailureClass,
    message: string,
    failingScenario?: string,
  ): never => {
    input.onTelemetry?.({
      event: "learning.compaction_gate.verdict",
      outcome: "fail",
      ...commonTelemetry,
      verdict: "reject",
      failureClass: obligation,
      failingScenarioCount: failingScenario === undefined ? 0 : 1,
      ...(failingScenario !== undefined
        ? { scenarioId: failingScenario }
        : {}),
    });
    throw new CompactionGateContractError(message, {
      obligation,
      subjectId,
      deviceId: input.deviceId,
      ...(failingScenario !== undefined ? { failingScenario } : {}),
    });
  };
  if (
    input.suite.suiteId !== COMPACTION_EVAL_SUITE_ID ||
    input.suite.suiteContentHash !== computeCompactionEvalSuiteHash(input.suite) ||
    !input.suite.frozen ||
    !input.suite.decontaminated ||
    !input.suite.heldOut ||
    !input.suite.excludeFromTrainingCorpora ||
    input.suite.scenarios.length < 1 ||
    input.suite.scenarios.length > COMPACTION_EVAL_SCENARIO_LIMIT
  ) {
    contractFailure(
      "compaction_gate.invalid_suite",
      "compaction promotion requires a bounded frozen, held-out suite",
    );
  }
  if (
    !ID_RE.test(input.deviceId) ||
    !ID_RE.test(input.champion.candidateId) ||
    !ID_RE.test(input.challenger.candidateId) ||
    input.champion.candidateId === input.challenger.candidateId
  ) {
    contractFailure(
      "compaction_gate.invalid_observation",
      "gate device and distinct candidate ids must be bounded identifiers",
    );
  }
  const consentScenarios = input.suite.scenarios.filter(
    (scenario) =>
      scenario.rubricThreshold.requireHardFail &&
      scenario.rubricThreshold.maximumTotal !== null &&
      scenario.rubricThreshold.maximumTotal <= -2,
  );
  if (consentScenarios.length === 0) {
    contractFailure(
      "compaction_gate.consent_scenario_missing",
      "compaction promotion suite must include a consent hard-fail scenario",
    );
  }
  for (const evaluator of [input.champion, input.challenger]) {
    if (evaluator.subjectId !== subjectId) {
      contractFailure(
        "compaction_gate.subject_scope",
        `candidate ${evaluator.candidateId} crosses subject scope`,
      );
    }
    if (evaluator.locality !== input.suite.locality) {
      contractFailure(
        "compaction_gate.locality_forbidden",
        `candidate ${evaluator.candidateId} crosses locality boundary`,
      );
    }
  }

  const scenarios: CompactionScenarioVerdict[] = [];
  for (const scenario of input.suite.scenarios) {
    let champion: CompactionScenarioObservation;
    let challenger: CompactionScenarioObservation;
    try {
      champion = await evaluateWithTimeout({
        evaluator: input.champion,
        scenario,
        deviceId: input.deviceId,
      });
      challenger = await evaluateWithTimeout({
        evaluator: input.challenger,
        scenario,
        deviceId: input.deviceId,
      });
    } catch (error) {
      const typed =
        error instanceof CompactionGateContractError
          ? error
          : new CompactionGateContractError("compaction evaluator failed", {
              obligation: "compaction_gate.evaluator_failure",
              subjectId,
              deviceId: input.deviceId,
              failingScenario: scenario.scenarioId,
            });
      input.onTelemetry?.({
        event: "learning.compaction_gate.scenario",
        outcome: "fail",
        ...commonTelemetry,
        scenarioId: scenario.scenarioId,
        failureClass: typed.obligation,
      });
      throw typed;
    }
    const championPasses = observationPassesScenario(champion, scenario);
    const challengerPasses = observationPassesScenario(challenger, scenario);
    const metricDelta = scenarioMetricDelta(champion, challenger, scenario);
    const consentScenario = consentScenarios.includes(scenario);
    scenarios.push({
      scenarioId: scenario.scenarioId,
      sliceId: scenario.sliceId,
      championTotal: champion.total,
      challengerTotal: challenger.total,
      metricDelta,
      championPasses,
      challengerPasses,
      consentScenario,
    });
    input.onTelemetry?.({
      event: "learning.compaction_gate.scenario",
      outcome:
        championPasses && challengerPasses && metricDelta >= 0 ? "ok" : "fail",
      ...commonTelemetry,
      scenarioId: scenario.scenarioId,
      championTotal: champion.total,
      challengerTotal: challenger.total,
      metricDelta,
    });
  }

  const championInvalid = scenarios
    .filter((scenario) => !scenario.championPasses)
    .map((scenario) => scenario.scenarioId);
  const consentFailed = scenarios
    .filter((scenario) => scenario.consentScenario && !scenario.challengerPasses)
    .map((scenario) => scenario.scenarioId);
  const thresholdFailed = scenarios
    .filter((scenario) => !scenario.challengerPasses)
    .map((scenario) => scenario.scenarioId);
  const comparisonEpsilon = 1e-9;
  const regressed = scenarios
    .filter((scenario) => scenario.metricDelta < -comparisonEpsilon)
    .map((scenario) => scenario.scenarioId);
  const aggregateDelta = scenarios.reduce(
    (total, scenario) => total + scenario.metricDelta,
    0,
  );

  let reason: CompactionGateRejectReason | undefined;
  let failingScenarioIds: string[] = [];
  if (championInvalid.length > 0) {
    reason = "champion_invalid";
    failingScenarioIds = championInvalid;
  } else if (consentFailed.length > 0) {
    reason = "consent_failed";
    failingScenarioIds = consentFailed;
  } else if (thresholdFailed.length > 0) {
    reason = "challenger_threshold_failed";
    failingScenarioIds = thresholdFailed;
  } else if (regressed.length > 0) {
    reason = "challenger_regressed";
    failingScenarioIds = regressed;
  } else if (aggregateDelta <= comparisonEpsilon) {
    reason = "tie";
    failingScenarioIds = input.suite.scenarios.map(
      (scenario) => scenario.scenarioId,
    );
  }

  if (reason !== undefined) {
    const verdict: CompactionPromotionVerdict = {
      schemaVersion: "compaction.promotion-verdict.v1",
      verdict: "reject",
      promoted: false,
      reason,
      suiteId: COMPACTION_EVAL_SUITE_ID,
      suiteContentHash: input.suite.suiteContentHash,
      subjectId,
      championId: input.champion.candidateId,
      challengerId: input.challenger.candidateId,
      aggregateDelta,
      failingScenarioIds,
      scenarios,
    };
    input.onTelemetry?.({
      event: "learning.compaction_gate.verdict",
      outcome: "fail",
      ...commonTelemetry,
      verdict: "reject",
      failureClass: reason,
      metricDelta: aggregateDelta,
      failingScenarioCount: failingScenarioIds.length,
      ...(failingScenarioIds[0] !== undefined
        ? { scenarioId: failingScenarioIds[0] }
        : {}),
    });
    return verdict;
  }

  const verdict: CompactionPromotionVerdict = {
    schemaVersion: "compaction.promotion-verdict.v1",
    verdict: "promote",
    promoted: true,
    suiteId: COMPACTION_EVAL_SUITE_ID,
    suiteContentHash: input.suite.suiteContentHash,
    subjectId,
    championId: input.champion.candidateId,
    challengerId: input.challenger.candidateId,
    aggregateDelta,
    failingScenarioIds: [],
    scenarios,
  };
  input.onTelemetry?.({
    event: "learning.compaction_gate.verdict",
    outcome: "ok",
    ...commonTelemetry,
    verdict: "promote",
    metricDelta: aggregateDelta,
    failingScenarioCount: 0,
  });
  return verdict;
}

export type CompactionCiGateFailureClass = CompactionGateFailureClass;

export type CompactionCiGateTelemetryEvent = {
  event: "learning.compaction_gate.ci";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  suiteId: typeof COMPACTION_EVAL_SUITE_ID;
  suiteContentHash: string;
  failureClass?: CompactionCiGateFailureClass | CompactionGateRejectReason;
  fixture?:
    | "flag_off_parity"
    | "seeded_promote"
    | "tie_reject"
    | "regression_reject"
    | "subject_scope";
  verdict?: "promote" | "reject";
  failingScenarioCount?: number;
  scenarioId?: string;
};

/**
 * Deterministic seeded evaluator for CI fixtures.
 * Emits threshold-passing observations, optionally with uplift or scenario overrides.
 */
export function createSeededCompactionEvaluator(input: {
  candidateId: string;
  subjectId: string;
  locality: "on-device" | "self-hosted";
  uplift?: number;
  overrideScenarioId?: string;
  overrideTotal?: number;
  overrideHardFail?: boolean;
}): CompactionCandidateEvaluator {
  const uplift = input.uplift ?? 0;
  return {
    candidateId: input.candidateId,
    subjectId: input.subjectId,
    locality: input.locality,
    evaluate(scenario) {
      const threshold = scenario.rubricThreshold;
      let total =
        threshold.minimumTotal !== null
          ? threshold.minimumTotal + uplift
          : threshold.maximumTotal!;
      let hardFail = threshold.requireHardFail;
      if (
        input.overrideScenarioId !== undefined &&
        scenario.scenarioId === input.overrideScenarioId
      ) {
        if (input.overrideTotal !== undefined) total = input.overrideTotal;
        if (input.overrideHardFail !== undefined) {
          hardFail = input.overrideHardFail;
        }
      }
      return {
        scenarioId: scenario.scenarioId,
        subjectId: input.subjectId,
        pinnedSeed: scenario.pinnedSeed,
        total,
        hardFail,
        harnessOutcome: scenario.expectedHarnessOutcome,
        failureClass: scenario.expectedFailureClass,
        downstreamReplaySuccess: scenario.downstreamReplay.required,
      };
    },
  };
}

function assertRejectVerdict(
  verdict: CompactionPromotionVerdict,
  expectedReason: CompactionGateRejectReason,
  meta: {
    subjectId: string;
    deviceId: string;
    fixture: CompactionCiGateTelemetryEvent["fixture"];
    onTelemetry?: (event: CompactionCiGateTelemetryEvent) => void;
    suite: CompactionEvalSuite;
  },
): Extract<CompactionPromotionVerdict, { verdict: "reject" }> {
  if (verdict.verdict !== "reject" || verdict.reason !== expectedReason) {
    meta.onTelemetry?.({
      event: "learning.compaction_gate.ci",
      outcome: "fail",
      subjectId: meta.subjectId,
      deviceId: meta.deviceId,
      suiteId: COMPACTION_EVAL_SUITE_ID,
      suiteContentHash: meta.suite.suiteContentHash,
      failureClass: "compaction_gate.ci_reject_expected",
      ...(meta.fixture !== undefined ? { fixture: meta.fixture } : {}),
      verdict: verdict.verdict,
      failingScenarioCount:
        verdict.verdict === "reject" ? verdict.failingScenarioIds.length : 0,
    });
    throw new CompactionGateContractError(
      `CI fixture ${meta.fixture} expected reject(${expectedReason})`,
      {
        obligation: "compaction_gate.ci_reject_expected",
        subjectId: meta.subjectId,
        deviceId: meta.deviceId,
        ...(verdict.verdict === "reject" && verdict.failingScenarioIds[0]
          ? { failingScenario: verdict.failingScenarioIds[0] }
          : {}),
      },
    );
  }
  return verdict;
}

/**
 * CI prove harness: flag-off parity (tie) green; seeded challenger promotes;
 * tie and regression fixtures reject with named scenarios; idempotent replay;
 * cross-subject candidates are refused.
 */
export async function proveCompactionPromotionGateCi(input: {
  suite: CompactionEvalSuite;
  deviceId?: string;
  onTelemetry?: (
    event: CompactionPromotionTelemetryEvent | CompactionCiGateTelemetryEvent,
  ) => void;
}): Promise<{
  ok: true;
  flagOffParity: Extract<CompactionPromotionVerdict, { verdict: "reject" }>;
  seededPromote: Extract<CompactionPromotionVerdict, { verdict: "promote" }>;
  tieReject: Extract<CompactionPromotionVerdict, { verdict: "reject" }>;
  regressionReject: Extract<CompactionPromotionVerdict, { verdict: "reject" }>;
  replayOk: true;
}> {
  const deviceId = input.deviceId ?? "ci";
  const subjectId = input.suite.subjectId;
  const suite = input.suite;
  const telemetryBase = {
    subjectId,
    deviceId,
    suiteId: COMPACTION_EVAL_SUITE_ID,
    suiteContentHash: suite.suiteContentHash,
  };

  if (
    suite.surgeryClasses.length !== 1 ||
    suite.surgeryClasses[0] !== "learned_compaction"
  ) {
    input.onTelemetry?.({
      event: "learning.compaction_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "compaction_gate.ci_attribution_void",
    });
    throw new CompactionGateContractError(
      "CI compaction gate requires exactly one learned_compaction surgery class",
      {
        obligation: "compaction_gate.ci_attribution_void",
        subjectId,
        deviceId,
      },
    );
  }

  const champion = createSeededCompactionEvaluator({
    candidateId: "ci.champion.deterministic",
    subjectId,
    locality: suite.locality,
  });

  // Flag-off parity: challenger mirrors champion byte-identical scores → tie.
  const flagOffChallenger = createSeededCompactionEvaluator({
    candidateId: "ci.challenger.flag-off",
    subjectId,
    locality: suite.locality,
  });
  const flagOffParity = assertRejectVerdict(
    await runCompactionPromotionGate({
      suite,
      champion,
      challenger: flagOffChallenger,
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
  if (flagOffParity.aggregateDelta !== 0) {
    input.onTelemetry?.({
      event: "learning.compaction_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "compaction_gate.ci_flag_off_parity",
      fixture: "flag_off_parity",
      verdict: "reject",
    });
    throw new CompactionGateContractError(
      "flag-off parity challenger must score identically to champion",
      {
        obligation: "compaction_gate.ci_flag_off_parity",
        subjectId,
        deviceId,
      },
    );
  }

  const seededChallenger = createSeededCompactionEvaluator({
    candidateId: "ci.challenger.seeded-promote",
    subjectId,
    locality: suite.locality,
    uplift: 1,
  });
  const seededPromote = await runCompactionPromotionGate({
    suite,
    champion,
    challenger: seededChallenger,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (seededPromote.verdict !== "promote" || !seededPromote.promoted) {
    input.onTelemetry?.({
      event: "learning.compaction_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "compaction_gate.ci_promote_expected",
      fixture: "seeded_promote",
      verdict: seededPromote.verdict,
      failingScenarioCount:
        seededPromote.verdict === "reject"
          ? seededPromote.failingScenarioIds.length
          : 0,
      ...(seededPromote.verdict === "reject" &&
      seededPromote.failingScenarioIds[0]
        ? { scenarioId: seededPromote.failingScenarioIds[0] }
        : {}),
    });
    throw new CompactionGateContractError(
      "seeded challenger beating baseline must promote",
      {
        obligation: "compaction_gate.ci_promote_expected",
        subjectId,
        deviceId,
        ...(seededPromote.verdict === "reject" &&
        seededPromote.failingScenarioIds[0]
          ? { failingScenario: seededPromote.failingScenarioIds[0] }
          : {}),
      },
    );
  }

  const replayPromote = await runCompactionPromotionGate({
    suite,
    champion,
    challenger: seededChallenger,
    deviceId,
  });
  if (JSON.stringify(replayPromote) !== JSON.stringify(seededPromote)) {
    input.onTelemetry?.({
      event: "learning.compaction_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "compaction_gate.ci_replay_mismatch",
      fixture: "seeded_promote",
    });
    throw new CompactionGateContractError(
      "compaction promotion CI gate replay is not idempotent",
      {
        obligation: "compaction_gate.ci_replay_mismatch",
        subjectId,
        deviceId,
      },
    );
  }

  const tieReject = assertRejectVerdict(
    await runCompactionPromotionGate({
      suite,
      champion,
      challenger: createSeededCompactionEvaluator({
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

  const regressionTarget =
    suite.scenarios.find((scenario) => scenario.downstreamReplay.required)
      ?.scenarioId ?? suite.scenarios[0]!.scenarioId;
  const regressionReject = assertRejectVerdict(
    await runCompactionPromotionGate({
      suite,
      champion,
      challenger: createSeededCompactionEvaluator({
        candidateId: "ci.challenger.regression",
        subjectId,
        locality: suite.locality,
        uplift: 1,
        overrideScenarioId: regressionTarget,
        overrideTotal: 0,
      }),
      deviceId,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    }),
    "challenger_threshold_failed",
    {
      subjectId,
      deviceId,
      fixture: "regression_reject",
      suite,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  );
  if (!regressionReject.failingScenarioIds.includes(regressionTarget)) {
    throw new CompactionGateContractError(
      `regression reject must name failing scenario ${regressionTarget}`,
      {
        obligation: "compaction_gate.ci_reject_expected",
        subjectId,
        deviceId,
        failingScenario: regressionTarget,
      },
    );
  }

  let subjectBlocked = false;
  try {
    await runCompactionPromotionGate({
      suite,
      champion,
      challenger: createSeededCompactionEvaluator({
        candidateId: "ci.challenger.cross-subject",
        subjectId: `${subjectId}.other`,
        locality: suite.locality,
        uplift: 1,
      }),
      deviceId,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
  } catch (error) {
    if (
      error instanceof CompactionGateContractError &&
      error.obligation === "compaction_gate.subject_scope"
    ) {
      subjectBlocked = true;
    } else {
      throw error;
    }
  }
  if (!subjectBlocked) {
    input.onTelemetry?.({
      event: "learning.compaction_gate.ci",
      outcome: "fail",
      ...telemetryBase,
      failureClass: "compaction_gate.subject_scope",
      fixture: "subject_scope",
    });
    throw new CompactionGateContractError(
      "cross-subject challenger must be refused by the CI gate",
      {
        obligation: "compaction_gate.subject_scope",
        subjectId,
        deviceId,
      },
    );
  }

  input.onTelemetry?.({
    event: "learning.compaction_gate.ci",
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
    regressionReject,
    replayOk: true,
  };
}
