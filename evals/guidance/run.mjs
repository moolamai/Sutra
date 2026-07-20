/**
 * Guidance eval CI runner — loads threshold.json + teacher scenarios, scores via
 * route_core on the committed teacher-cbse-slice pack, fails below minAggregateScore.
 *
 * Usage (repo root or evals/guidance):
 *   node evals/guidance/run.mjs
 *   pnpm --filter @moolam/guidance-evals gate
 *
 * On failure always prints per-scenario DIFF (expected vs actual + score delta).
 * Never prints raw learner content.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GuidanceEvalScoreError,
  loadTeacherScenarios,
  scoreSuite,
} from "./src/score.mjs";
import { routerActualFromScenario, getRouteGraph } from "./src/router_actual.mjs";
import { loadCommittedRubric, GUIDANCE_EVAL_ROOT } from "./src/validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const THRESHOLD_PATH = path.join(GUIDANCE_EVAL_ROOT, "threshold.json");
export const THRESHOLD_SCHEMA_VERSION = "guidance-eval.threshold.v1";

/**
 * @typedef {{
 *   schemaVersion: string,
 *   minAggregateScore: number,
 *   packId: string,
 *   packPath: string,
 *   manifest: string,
 *   tooling?: { node?: string, pnpm?: string },
 * }} GuidanceEvalThreshold
 */

/**
 * @param {string} [thresholdPath]
 * @returns {GuidanceEvalThreshold}
 */
export function loadThreshold(thresholdPath = THRESHOLD_PATH) {
  if (!existsSync(thresholdPath)) {
    throw new GuidanceEvalScoreError(
      `threshold.json missing at ${thresholdPath}`,
      {
        obligation: "guidance_eval.threshold.missing",
        failureClass: "threshold_invalid",
      },
    );
  }
  return JSON.parse(readFileSync(thresholdPath, "utf8"));
}

/**
 * @param {GuidanceEvalThreshold} threshold
 * @param {ReturnType<typeof loadCommittedRubric>} rubric
 * @param {{ repoRoot?: string }} [opts]
 */
export function validateThreshold(threshold, rubric, opts = {}) {
  const errors = [];
  if (threshold.schemaVersion !== THRESHOLD_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${THRESHOLD_SCHEMA_VERSION}, got ${threshold.schemaVersion}`,
    );
  }
  if (
    typeof threshold.minAggregateScore !== "number" ||
    threshold.minAggregateScore < 0 ||
    threshold.minAggregateScore > 1
  ) {
    errors.push("minAggregateScore must be a number in [0,1]");
  }
  if (threshold.minAggregateScore < rubric.failBelow) {
    errors.push(
      `minAggregateScore (${threshold.minAggregateScore}) must be >= rubric.failBelow (${rubric.failBelow})`,
    );
  }
  if (threshold.packId !== "teacher-cbse-slice") {
    errors.push(
      `packId must be teacher-cbse-slice (production pack), got ${threshold.packId}`,
    );
  }
  if (
    typeof threshold.packPath !== "string" ||
    !threshold.packPath.includes("teacher-cbse-slice.json") ||
    threshold.packPath.includes("demo-math-sd-slice")
  ) {
    errors.push(
      "packPath must point at teacher-cbse-slice.json (not demo-math-sd-slice)",
    );
  }
  const repoRoot =
    opts.repoRoot ?? path.resolve(GUIDANCE_EVAL_ROOT, "..", "..");
  const packAbs = path.resolve(repoRoot, threshold.packPath);
  if (!existsSync(packAbs)) {
    errors.push(`packPath does not exist: ${packAbs}`);
  }
  if (threshold.tooling?.node && threshold.tooling.node !== "22") {
    errors.push(
      `tooling.node pinned to 22 for CI lockfile parity, got ${threshold.tooling.node}`,
    );
  }
  if (threshold.tooling?.pnpm && threshold.tooling.pnpm !== "10.30.3") {
    errors.push(
      `tooling.pnpm pinned to 10.30.3 for CI lockfile parity, got ${threshold.tooling.pnpm}`,
    );
  }
  if (errors.length) {
    throw new GuidanceEvalScoreError(errors.join("; "), {
      obligation: "guidance_eval.threshold.invalid",
      failureClass: "threshold_invalid",
    });
  }
  return packAbs;
}

/**
 * Emit structured DIFF lines for scenarios below threshold or mismatched route.
 * @param {Awaited<ReturnType<typeof scoreSuite>>} summary
 */
export function emitScenarioDiffs(summary) {
  for (const row of summary.results) {
    const mismatch =
      row.score < summary.failBelow ||
      row.actual.routeAction !== row.expected.routeAction ||
      row.actual.targetConceptId !== row.expected.targetConceptId;
    if (!mismatch) continue;
    const line = {
      event: "guidance_eval.diff",
      outcome: "fail",
      subjectId: row.subjectId,
      deviceId: "ci",
      scenarioId: row.scenarioId,
      expected: {
        routeAction: row.expected.routeAction,
        targetConceptId: row.expected.targetConceptId,
        mode: row.expected.mode ?? null,
      },
      actual: {
        routeAction: row.actual.routeAction,
        targetConceptId: row.actual.targetConceptId,
        mode: row.actual.mode ?? null,
      },
      score: row.score,
      failBelow: summary.failBelow,
      scoreDelta: Number((row.score - summary.failBelow).toFixed(6)),
    };
    console.error(JSON.stringify(line));
  }
}

/**
 * Run the guidance-eval gate.
 * @param {{
 *   thresholdPath?: string,
 *   threshold?: GuidanceEvalThreshold,
 *   getActual?: (scenario: object) => object,
 *   emit?: boolean,
 *   exit?: boolean,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, summary: object, threshold: GuidanceEvalThreshold, exitCode: number }>}
 */
export async function runGuidanceEvalGate(opts = {}) {
  const events = [];
  const emit = opts.emit !== false;
  const log = (obj) => {
    if (emit) console.log(JSON.stringify(obj));
    events.push(obj);
  };
  const errLog = (obj) => {
    if (emit) console.error(JSON.stringify(obj));
    events.push(obj);
  };

  const rubric = loadCommittedRubric();
  const threshold = opts.threshold ?? loadThreshold(opts.thresholdPath);
  const packAbs = validateThreshold(threshold, rubric);
  const { graph, packId, versionStamp } = getRouteGraph(packAbs);
  void graph;
  if (packId !== threshold.packId) {
    throw new GuidanceEvalScoreError(
      `loaded packId ${packId} != threshold.packId ${threshold.packId}`,
      {
        obligation: "guidance_eval.threshold.pack_mismatch",
        failureClass: "threshold_invalid",
      },
    );
  }

  const { scenarios } = loadTeacherScenarios(threshold.manifest);
  log({
    event: "guidance_eval.gate",
    outcome: "start",
    subjectId: "guidance-eval-gate",
    deviceId: "ci",
    phase: "boot",
    packId,
    versionStamp,
    minAggregateScore: threshold.minAggregateScore,
    scenarioCount: scenarios.length,
  });

  const getActual =
    opts.getActual ??
    ((scenario) => routerActualFromScenario(scenario, { packPath: packAbs }));

  const summary = await scoreSuite({
    scenarios,
    rubric,
    failBelow: threshold.minAggregateScore,
    throwOnSuiteFail: false,
    getActual,
    onTelemetry: (e) => {
      if (e.outcome === "fail" || e.event === "guidance_eval.suite") {
        log(e);
      }
    },
  });

  if (!summary.ok) {
    emitScenarioDiffs(summary);
    errLog({
      event: "guidance_eval.gate",
      outcome: "fail",
      subjectId: "guidance-eval-gate",
      deviceId: "ci",
      phase: "aggregate",
      failureClass: "score_regression",
      mean: summary.mean,
      minAggregateScore: threshold.minAggregateScore,
      scoreDelta: Number(
        (summary.mean - threshold.minAggregateScore).toFixed(6),
      ),
      count: summary.count,
    });
    return { ok: false, summary, threshold, exitCode: 1, events };
  }

  log({
    event: "guidance_eval.gate",
    outcome: "ok",
    subjectId: "guidance-eval-gate",
    deviceId: "ci",
    phase: "aggregate",
    mean: summary.mean,
    minAggregateScore: threshold.minAggregateScore,
    count: summary.count,
    packId,
    versionStamp,
  });
  return { ok: true, summary, threshold, exitCode: 0, events };
}

async function main() {
  try {
    const result = await runGuidanceEvalGate();
    process.exit(result.exitCode);
  } catch (err) {
    if (err instanceof GuidanceEvalScoreError) {
      console.error(
        JSON.stringify({
          event: "guidance_eval.gate",
          outcome: "fail",
          subjectId: "guidance-eval-gate",
          deviceId: "ci",
          failureClass: err.failureClass,
          obligation: err.obligation,
          message: err.message,
          scenarioId: err.scenarioId,
        }),
      );
      process.exit(1);
    }
    throw err;
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  await main();
}

void __dirname;
