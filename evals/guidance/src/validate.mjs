/**
 * Validate guidance-eval scenario + rubric documents (AJV).
 * Emits structured telemetry with subjectId/deviceId — never raw content.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GUIDANCE_EVAL_ROOT = path.join(__dirname, "..");
export const SCENARIO_SCHEMA_PATH = path.join(
  GUIDANCE_EVAL_ROOT,
  "schemas",
  "scenario-v1.json",
);
export const RUBRIC_SCHEMA_PATH = path.join(
  GUIDANCE_EVAL_ROOT,
  "schemas",
  "rubric-v1.json",
);
export const RUBRIC_PATH = path.join(GUIDANCE_EVAL_ROOT, "rubric.json");
export const SCENARIOS_DIR = path.join(GUIDANCE_EVAL_ROOT, "scenarios");

export const SCENARIO_SCHEMA_VERSION = "guidance-eval.scenario.v1";
export const RUBRIC_SCHEMA_VERSION = "guidance-eval.rubric.v1";

const WEIGHT_SUM_EPS = 1e-9;

/** @typedef {'schema_invalid'|'weight_sum'|'bounded_scan'|'ok'} FailureClass */

/**
 * @typedef {{
 *   event: string,
 *   outcome: 'ok'|'fail',
 *   subjectId: string,
 *   deviceId: string,
 *   phase: string,
 *   failureClass?: FailureClass,
 *   scenarioId?: string,
 *   violationCount?: number,
 * }} GuidanceEvalTelemetry
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   obligation?: string,
 *   failureClass?: FailureClass,
 *   errors?: string[],
 *   events: GuidanceEvalTelemetry[],
 *   value?: unknown,
 * }} ValidateResult
 */

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

let _scenarioValidate;
let _rubricValidate;

function getScenarioValidator() {
  if (!_scenarioValidate) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    _scenarioValidate = ajv.compile(loadJson(SCENARIO_SCHEMA_PATH));
  }
  return _scenarioValidate;
}

function getRubricValidator() {
  if (!_rubricValidate) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    _rubricValidate = ajv.compile(loadJson(RUBRIC_SCHEMA_PATH));
  }
  return _rubricValidate;
}

/**
 * @param {GuidanceEvalTelemetry[]} events
 * @param {((e: GuidanceEvalTelemetry) => void) | undefined} onTelemetry
 * @param {GuidanceEvalTelemetry} ev
 */
function pushEvent(events, onTelemetry, ev) {
  events.push(ev);
  if (onTelemetry) onTelemetry(ev);
}

/**
 * @param {unknown} raw
 * @param {{ subjectId?: string, deviceId?: string, onTelemetry?: (e: GuidanceEvalTelemetry) => void }} [opts]
 * @returns {ValidateResult}
 */
export function validateScenario(raw, opts = {}) {
  const subjectId = opts.subjectId ?? "guidance-eval-validate";
  const deviceId = opts.deviceId ?? "ci";
  const events = [];
  const validate = getScenarioValidator();

  if (!validate(raw)) {
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message}`,
    );
    pushEvent(events, opts.onTelemetry, {
      event: "guidance_eval.scenario.validate",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "schema",
      failureClass: "schema_invalid",
      violationCount: errors.length,
    });
    return {
      ok: false,
      obligation: "guidance_eval.scenario.schema_invalid",
      failureClass: "schema_invalid",
      errors,
      events,
    };
  }

  const scenario = /** @type {{ frictionHistory: unknown[], scenarioId: string, subjectId: string }} */ (
    raw
  );
  const historyLen = Array.isArray(scenario.frictionHistory)
    ? scenario.frictionHistory.length
    : 0;
  if (historyLen > 64) {
    pushEvent(events, opts.onTelemetry, {
      event: "guidance_eval.scenario.validate",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "bounds",
      failureClass: "bounded_scan",
      scenarioId: scenario.scenarioId,
      violationCount: 1,
    });
    return {
      ok: false,
      obligation: "guidance_eval.scenario.bounded_scan",
      failureClass: "bounded_scan",
      errors: [`frictionHistory length ${historyLen} exceeds 64`],
      events,
    };
  }

  pushEvent(events, opts.onTelemetry, {
    event: "guidance_eval.scenario.validate",
    outcome: "ok",
    subjectId: scenario.subjectId || subjectId,
    deviceId,
    phase: "schema",
    scenarioId: scenario.scenarioId,
  });
  return { ok: true, events, value: raw };
}

/**
 * @param {unknown} raw
 * @param {{ subjectId?: string, deviceId?: string, onTelemetry?: (e: GuidanceEvalTelemetry) => void }} [opts]
 * @returns {ValidateResult}
 */
export function validateRubric(raw, opts = {}) {
  const subjectId = opts.subjectId ?? "guidance-eval-rubric";
  const deviceId = opts.deviceId ?? "ci";
  const events = [];
  const validate = getRubricValidator();

  if (!validate(raw)) {
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message}`,
    );
    pushEvent(events, opts.onTelemetry, {
      event: "guidance_eval.rubric.validate",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "schema",
      failureClass: "schema_invalid",
      violationCount: errors.length,
    });
    return {
      ok: false,
      obligation: "guidance_eval.rubric.schema_invalid",
      failureClass: "schema_invalid",
      errors,
      events,
    };
  }

  const rubric = /** @type {{ weights: Record<string, number> }} */ (raw);
  const sum =
    rubric.weights.routeAction +
    rubric.weights.targetConceptId +
    rubric.weights.mode +
    rubric.weights.rationaleKeywords;
  if (Math.abs(sum - 1) > WEIGHT_SUM_EPS) {
    pushEvent(events, opts.onTelemetry, {
      event: "guidance_eval.rubric.validate",
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "weights",
      failureClass: "weight_sum",
      violationCount: 1,
    });
    return {
      ok: false,
      obligation: "guidance_eval.rubric.weight_sum",
      failureClass: "weight_sum",
      errors: [`weights sum to ${sum}, expected 1.0`],
      events,
    };
  }

  pushEvent(events, opts.onTelemetry, {
    event: "guidance_eval.rubric.validate",
    outcome: "ok",
    subjectId,
    deviceId,
    phase: "schema",
  });
  return { ok: true, events, value: raw };
}

export function loadCommittedRubric() {
  return loadJson(RUBRIC_PATH);
}

export function loadScenarioFile(filePath) {
  return loadJson(filePath);
}

/**
 * Partial score of an actual routing decision against expected + rubric.
 * Rationale keywords use fractional match unless requireAll is true.
 *
 * @param {{
 *   routeAction: string,
 *   targetConceptId: string | null,
 *   mode?: string,
 *   rationale: string,
 * }} actual
 * @param {{
 *   routeAction: string,
 *   targetConceptId: string | null,
 *   mode?: string,
 *   rationaleKeywords: string[],
 * }} expected
 * @param {ReturnType<typeof loadCommittedRubric>} rubric
 * @returns {{ score: number, components: Record<string, number>, matchedKeywords: string[] }}
 */
export function scoreAgainstExpected(actual, expected, rubric) {
  const w = rubric.weights;
  const components = {
    routeAction: actual.routeAction === expected.routeAction ? 1 : 0,
    targetConceptId:
      actual.targetConceptId === expected.targetConceptId ? 1 : 0,
    mode:
      expected.mode == null || actual.mode === expected.mode ? 1 : 0,
    rationaleKeywords: 0,
  };

  const hay = rubric.keywordMatch.caseInsensitive
    ? String(actual.rationale ?? "").toLowerCase()
    : String(actual.rationale ?? "");
  const matched = [];
  for (const kw of expected.rationaleKeywords) {
    const needle = rubric.keywordMatch.caseInsensitive
      ? kw.toLowerCase()
      : kw;
    if (hay.includes(needle)) matched.push(kw);
  }
  if (rubric.keywordMatch.requireAll) {
    components.rationaleKeywords =
      matched.length === expected.rationaleKeywords.length ? 1 : 0;
  } else {
    components.rationaleKeywords =
      expected.rationaleKeywords.length === 0
        ? 1
        : matched.length / expected.rationaleKeywords.length;
  }

  const score =
    components.routeAction * w.routeAction +
    components.targetConceptId * w.targetConceptId +
    components.mode * w.mode +
    components.rationaleKeywords * w.rationaleKeywords;

  return { score, components, matchedKeywords: matched };
}

/**
 * Map router nextConceptId + mode + spike semantics → routeAction for scoring.
 * @param {{ nextConceptId: string, mode: string, activeConceptId: string, spiked: boolean }} args
 */
export function inferRouteAction(args) {
  if (args.mode === "prerequisite-remediation") return "remediate";
  if (args.nextConceptId !== args.activeConceptId && !args.spiked) {
    return "advance";
  }
  return "hold";
}
