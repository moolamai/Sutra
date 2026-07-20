/**
 * Seeded guidance-eval scorer — keyword-tolerant rubric scoring vs golden expected.
 * Deterministic: same (scenario, actual, rubric, seed) → identical scores.
 * Model-assisted checks (if any) MUST use deriveModelAssistSeed(); never Math.random().
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GUIDANCE_EVAL_ROOT,
  SCENARIOS_DIR,
  inferRouteAction,
  loadCommittedRubric,
  scoreAgainstExpected,
  validateRubric,
  validateScenario,
} from "./validate.mjs";

export { scoreAgainstExpected, inferRouteAction };

/** @typedef {import('./validate.mjs').GuidanceEvalTelemetry} GuidanceEvalTelemetry */

/**
 * @typedef {{
 *   routeAction: string,
 *   targetConceptId: string | null,
 *   mode?: string,
 *   rationale: string,
 * }} RouterActual
 */

export class GuidanceEvalScoreError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   obligation: string,
   *   failureClass: string,
   *   subjectId?: string,
   *   deviceId?: string,
   *   scenarioId?: string,
   *   score?: number,
   *   failBelow?: number,
   * }} meta
   */
  constructor(message, meta) {
    super(message);
    this.name = "GuidanceEvalScoreError";
    this.obligation = meta.obligation;
    this.failureClass = meta.failureClass;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.scenarioId = meta.scenarioId;
    this.score = meta.score;
    this.failBelow = meta.failBelow;
  }
}

/**
 * Mulberry32 PRNG — seeded, reproducible across runs/hosts.
 * @param {number} seed
 * @returns {() => number} uniform [0, 1)
 */
export function createSeededRng(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stable FNV-1a-ish mix of seed + scenarioId for model-assisted probes.
 * @param {number} scenarioSeed
 * @param {string} scenarioId
 */
export function deriveModelAssistSeed(scenarioSeed, scenarioId) {
  let h = scenarioSeed >>> 0;
  const s = String(scenarioId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * @param {{ seed?: number }} scenario
 * @param {{ seedDefault?: number }} rubric
 */
export function resolveScenarioSeed(scenario, rubric) {
  if (typeof scenario.seed === "number") return scenario.seed >>> 0;
  if (typeof rubric.seedDefault === "number") return rubric.seedDefault >>> 0;
  return 42;
}

/**
 * Score one scenario's router actual against its expected block.
 * @param {object} scenario
 * @param {RouterActual} actual
 * @param {ReturnType<typeof loadCommittedRubric>} rubric
 * @param {{ onTelemetry?: (e: GuidanceEvalTelemetry) => void, throwOnValidate?: boolean }} [opts]
 */
export function scoreScenario(scenario, actual, rubric, opts = {}) {
  const events = [];
  const onTelemetry = (e) => {
    events.push(e);
    opts.onTelemetry?.(e);
  };

  const v = validateScenario(scenario, {
    subjectId: scenario.subjectId,
    deviceId: scenario.deviceId,
    onTelemetry,
  });
  if (!v.ok) {
    onTelemetry({
      event: "guidance_eval.score",
      outcome: "fail",
      subjectId: scenario.subjectId ?? "unknown",
      deviceId: scenario.deviceId ?? "ci",
      phase: "validate",
      failureClass: v.failureClass,
      scenarioId: scenario.scenarioId,
    });
    if (opts.throwOnValidate !== false) {
      throw new GuidanceEvalScoreError(
        `scenario invalid: ${(v.errors ?? []).join("; ")}`,
        {
          obligation: v.obligation ?? "guidance_eval.scenario.schema_invalid",
          failureClass: v.failureClass ?? "schema_invalid",
          subjectId: scenario.subjectId,
          deviceId: scenario.deviceId,
          scenarioId: scenario.scenarioId,
        },
      );
    }
    return {
      ok: false,
      scenarioId: scenario.scenarioId,
      subjectId: scenario.subjectId,
      score: 0,
      components: {},
      matchedKeywords: [],
      seed: resolveScenarioSeed(scenario, rubric),
      modelAssistSeed: 0,
      events,
      actual,
      expected: scenario.expected,
    };
  }

  const seed = resolveScenarioSeed(scenario, rubric);
  const modelAssistSeed = deriveModelAssistSeed(seed, scenario.scenarioId);
  // Touch RNG so seed is exercised deterministically (model-assist seam).
  const rng = createSeededRng(modelAssistSeed);
  const _probe = rng();
  void _probe;

  const scored = scoreAgainstExpected(actual, scenario.expected, rubric);
  const pass = scored.score >= rubric.failBelow;
  onTelemetry({
    event: "guidance_eval.score",
    outcome: pass ? "ok" : "fail",
    subjectId: scenario.subjectId,
    deviceId: scenario.deviceId,
    phase: "score",
    failureClass: pass ? undefined : "score_below_scenario",
    scenarioId: scenario.scenarioId,
  });

  return {
    ok: pass,
    scenarioId: scenario.scenarioId,
    subjectId: scenario.subjectId,
    score: scored.score,
    components: scored.components,
    matchedKeywords: scored.matchedKeywords,
    seed,
    modelAssistSeed,
    events,
    actual,
    expected: scenario.expected,
  };
}

/**
 * Score a bounded suite; fails when mean < failBelow (threshold or rubric).
 *
 * @param {{
 *   scenarios: object[],
 *   getActual: (scenario: object, ctx: { seed: number, modelAssistSeed: number, rng: () => number }) => RouterActual | Promise<RouterActual>,
 *   rubric?: ReturnType<typeof loadCommittedRubric>,
 *   failBelow?: number,
 *   onTelemetry?: (e: GuidanceEvalTelemetry) => void,
 *   throwOnSuiteFail?: boolean,
 * }} args
 */
export async function scoreSuite(args) {
  const rubric = args.rubric ?? loadCommittedRubric();
  const failBelow =
    typeof args.failBelow === "number" ? args.failBelow : rubric.failBelow;
  const events = [];
  const onTelemetry = (e) => {
    events.push(e);
    args.onTelemetry?.(e);
  };

  const rv = validateRubric(rubric, {
    subjectId: "guidance-eval-suite",
    deviceId: "ci",
    onTelemetry,
  });
  if (!rv.ok) {
    throw new GuidanceEvalScoreError(
      `rubric invalid: ${(rv.errors ?? []).join("; ")}`,
      {
        obligation: rv.obligation ?? "guidance_eval.rubric.schema_invalid",
        failureClass: rv.failureClass ?? "schema_invalid",
      },
    );
  }

  if (args.scenarios.length > rubric.bounds.maxScenarios) {
    throw new GuidanceEvalScoreError(
      `suite size ${args.scenarios.length} exceeds maxScenarios ${rubric.bounds.maxScenarios}`,
      {
        obligation: "guidance_eval.suite.bounded_scan",
        failureClass: "bounded_scan",
      },
    );
  }

  const results = [];
  for (const scenario of args.scenarios) {
    const seed = resolveScenarioSeed(scenario, rubric);
    const modelAssistSeed = deriveModelAssistSeed(seed, scenario.scenarioId);
    const rng = createSeededRng(modelAssistSeed);
    const actual = await args.getActual(scenario, { seed, modelAssistSeed, rng });
    const row = scoreScenario(scenario, actual, rubric, { onTelemetry });
    results.push(row);
  }

  const mean =
    results.length === 0
      ? 0
      : results.reduce((s, r) => s + r.score, 0) / results.length;
  const suiteOk = mean >= failBelow;

  onTelemetry({
    event: "guidance_eval.suite",
    outcome: suiteOk ? "ok" : "fail",
    subjectId: "guidance-eval-suite",
    deviceId: "ci",
    phase: "aggregate",
    failureClass: suiteOk ? undefined : "score_regression",
  });

  const summary = {
    ok: suiteOk,
    mean,
    failBelow,
    count: results.length,
    results,
    events,
  };

  if (!suiteOk && args.throwOnSuiteFail !== false) {
    const worst = [...results].sort((a, b) => a.score - b.score)[0];
    throw new GuidanceEvalScoreError(
      `guidance eval suite mean ${mean.toFixed(4)} < failBelow ${failBelow}` +
        (worst
          ? ` (worst=${worst.scenarioId} score=${worst.score.toFixed(4)})`
          : ""),
      {
        obligation: "guidance_eval.suite.score_regression",
        failureClass: "score_regression",
        scenarioId: worst?.scenarioId,
        score: mean,
        failBelow,
      },
    );
  }

  return summary;
}

/**
 * Load teacher manifest scenarios (validated paths only).
 * @param {string} [manifestRel]
 */
export function loadTeacherScenarios(manifestRel = "teacher/manifest.json") {
  const manifestPath = path.join(SCENARIOS_DIR, manifestRel);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const scenarios = [];
  for (const rel of manifest.scenarios ?? []) {
    const file = path.join(SCENARIOS_DIR, rel);
    scenarios.push(JSON.parse(readFileSync(file, "utf8")));
  }
  return { manifest, scenarios, root: GUIDANCE_EVAL_ROOT };
}

/**
 * Detect spike from FrictionSample fields (aligns with TaskRouter / route_core).
 * @param {{ hesitationMs: number, assistanceRequested: boolean, outcome: string }} friction
 * @param {number} [spikeMs]
 */
export function isFrictionSpike(friction, spikeMs = 15_000) {
  return (
    friction.hesitationMs > spikeMs ||
    friction.assistanceRequested ||
    friction.outcome === "incorrect"
  );
}

/**
 * Build RouterActual from a route decision + active concept.
 * @param {{ nextConceptId: string, mode: string, rationale: string | string[] }} decision
 * @param {string} activeConceptId
 * @param {boolean} spiked
 */
export function actualFromDecision(decision, activeConceptId, spiked) {
  const rationale = Array.isArray(decision.rationale)
    ? decision.rationale.join(" | ")
    : String(decision.rationale ?? "");
  return {
    routeAction: inferRouteAction({
      nextConceptId: decision.nextConceptId,
      mode: decision.mode,
      activeConceptId,
      spiked,
    }),
    targetConceptId: decision.nextConceptId,
    mode: decision.mode,
    rationale,
  };
}
