/**
 * Integration proof for the guidance routing-quality eval CI gate.
 *
 * Operator path:
 *   1. Baseline green (threshold + teacher scenarios on production pack)
 *   2. Seed broken threshold + wrong expected route → gate red with DIFF
 *   3. Revert → green
 *
 * Always restores seeded files (finally). Never auto-commits.
 *
 * Usage (repo root):
 *   node scripts/prove-guidance-eval-gate.mjs
 *   pnpm guidance:eval:prove
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const THRESHOLD_PATH = path.join(
  REPO_ROOT,
  "evals/guidance/threshold.json",
);
export const SEED_SCENARIO_PATH = path.join(
  REPO_ROOT,
  "evals/guidance/scenarios/teacher/advance-fractions-to-ratios.json",
);
export const SEED_MARKER = "GUIDANCE_EVAL_SEED";
/** Impossible aggregate — suite mean is below this when goldens are healthy. */
export const SEED_MIN_AGGREGATE = 0.999;
/** Wrong expected route for the seeded scenario (actual stays advance). */
export const SEED_ROUTE_ACTION = "hold";
export const SEED_SCENARIO_ID = "teacher/advance-fractions-to-ratios";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "guidance_eval.prove", ...event })}\n`,
  );
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    shell: opts.shell ?? false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

/** Run the committed guidance-eval gate (builds domain-loader via package script). */
export function runGuidanceEvalGate() {
  return run(
    "pnpm",
    ["--filter", "@moolam/guidance-evals", "gate"],
    { shell: true },
  );
}

/**
 * Raise minAggregateScore and flip one golden's expected.routeAction.
 * @returns {{ thresholdOriginal: string, scenarioOriginal: string }}
 */
export function seedBrokenThresholdRouting({
  thresholdPath = THRESHOLD_PATH,
  scenarioPath = SEED_SCENARIO_PATH,
} = {}) {
  if (!existsSync(thresholdPath)) {
    throw new Error(`GUIDANCE_EVAL_PROVE_MISSING_THRESHOLD: ${thresholdPath}`);
  }
  if (!existsSync(scenarioPath)) {
    throw new Error(`GUIDANCE_EVAL_PROVE_MISSING_SCENARIO: ${scenarioPath}`);
  }

  const thresholdOriginal = readFileSync(thresholdPath, "utf8");
  const scenarioOriginal = readFileSync(scenarioPath, "utf8");
  if (thresholdOriginal.includes(SEED_MARKER)) {
    throw new Error(
      "GUIDANCE_EVAL_PROVE_ALREADY_SEEDED: clean tree before proving",
    );
  }

  const threshold = JSON.parse(thresholdOriginal);
  threshold.minAggregateScore = SEED_MIN_AGGREGATE;
  threshold._seedMarker = SEED_MARKER;
  writeFileSync(thresholdPath, `${JSON.stringify(threshold, null, 2)}\n`, "utf8");

  const scenario = JSON.parse(scenarioOriginal);
  if (!scenario.expected || typeof scenario.expected !== "object") {
    throw new Error("GUIDANCE_EVAL_PROVE_SEED_FAILED: expected missing");
  }
  // Keep scenario schema-valid (additionalProperties: false; tags are enum).
  scenario.expected = {
    ...scenario.expected,
    routeAction: SEED_ROUTE_ACTION,
  };
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");

  return { thresholdOriginal, scenarioOriginal };
}

export function restoreSeededFiles(
  { thresholdOriginal, scenarioOriginal },
  {
    thresholdPath = THRESHOLD_PATH,
    scenarioPath = SEED_SCENARIO_PATH,
  } = {},
) {
  writeFileSync(thresholdPath, thresholdOriginal, "utf8");
  writeFileSync(scenarioPath, scenarioOriginal, "utf8");
}

/**
 * @returns {{ ok: boolean, phases: object[], failures: string[] }}
 */
export function proveGuidanceEvalGate({
  thresholdPath = THRESHOLD_PATH,
  scenarioPath = SEED_SCENARIO_PATH,
  runGate = runGuidanceEvalGate,
} = {}) {
  /** @type {object[]} */
  const phases = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {{ thresholdOriginal: string, scenarioOriginal: string } | null} */
  let originals = null;

  emit({ outcome: "start", subjectId: "guidance-eval-prove", deviceId: "ci" });

  try {
    const baseline = runGate();
    phases.push({
      phase: "baseline",
      status: baseline.status,
      outcome: baseline.status === 0 ? "ok" : "error",
    });
    emit({
      phase: "baseline",
      outcome: baseline.status === 0 ? "ok" : "error",
      exitCode: baseline.status,
      subjectId: "guidance-eval-prove",
      deviceId: "ci",
    });
    if (baseline.status !== 0) {
      failures.push(
        "BASELINE_NOT_GREEN: gate must pass before seeding drift.\n" +
          baseline.combined.slice(0, 4000),
      );
      return { ok: false, phases, failures };
    }

    originals = seedBrokenThresholdRouting({ thresholdPath, scenarioPath });
    emit({
      phase: "seed",
      outcome: "ok",
      subjectId: "guidance-eval-prove",
      deviceId: "ci",
      minAggregateScore: SEED_MIN_AGGREGATE,
      routeAction: SEED_ROUTE_ACTION,
      scenarioId: SEED_SCENARIO_ID,
    });

    const red = runGate();
    const redHasDiff =
      red.combined.includes("guidance_eval.diff") &&
      red.combined.includes(SEED_SCENARIO_ID) &&
      red.combined.includes("scoreDelta") &&
      (red.combined.includes(SEED_ROUTE_ACTION) ||
        red.combined.includes('"expected"'));
    const redOk = red.status !== 0 && redHasDiff;
    phases.push({
      phase: "seeded-red",
      status: red.status,
      outcome: redOk ? "ok" : "error",
      sawDiff: red.combined.includes("guidance_eval.diff"),
      sawScenarioId: red.combined.includes(SEED_SCENARIO_ID),
      sawScoreDelta: red.combined.includes("scoreDelta"),
    });
    emit({
      phase: "seeded-red",
      outcome: redOk ? "ok" : "error",
      exitCode: red.status,
      subjectId: "guidance-eval-prove",
      deviceId: "ci",
      sawDiff: red.combined.includes("guidance_eval.diff"),
      sawScenarioId: red.combined.includes(SEED_SCENARIO_ID),
      sawScoreDelta: red.combined.includes("scoreDelta"),
    });
    if (red.status === 0) {
      failures.push(
        "SEEDED_DRIFT_DID_NOT_FAIL: gate stayed green after broken threshold/routing.",
      );
    } else if (!redHasDiff) {
      failures.push(
        "SEEDED_DRIFT_NO_DIFF: gate failed but did not print guidance_eval.diff " +
          `with scenarioId=${SEED_SCENARIO_ID} and scoreDelta.\n` +
          red.combined.slice(0, 4000),
      );
    }

    restoreSeededFiles(originals, { thresholdPath, scenarioPath });
    originals = null;
    emit({
      phase: "revert",
      outcome: "ok",
      subjectId: "guidance-eval-prove",
      deviceId: "ci",
    });

    const green = runGate();
    const greenOk = green.status === 0;
    phases.push({
      phase: "reverted-green",
      status: green.status,
      outcome: greenOk ? "ok" : "error",
    });
    emit({
      phase: "reverted-green",
      outcome: greenOk ? "ok" : "error",
      exitCode: green.status,
      subjectId: "guidance-eval-prove",
      deviceId: "ci",
    });
    if (!greenOk) {
      failures.push(
        "REVERT_NOT_GREEN: gate still failing after restoring threshold/scenario.\n" +
          green.combined.slice(0, 4000),
      );
    }

    const restoredThreshold = readFileSync(thresholdPath, "utf8");
    const restoredScenario = readFileSync(scenarioPath, "utf8");
    if (restoredThreshold.includes(SEED_MARKER)) {
      failures.push(
        "SEED_LEFT_BEHIND: GUIDANCE_EVAL_SEED marker still present after revert.",
      );
    }
    const restoredScenarioParsed = JSON.parse(restoredScenario);
    if (restoredScenarioParsed.expected?.routeAction === SEED_ROUTE_ACTION) {
      failures.push(
        "SEED_LEFT_BEHIND: seeded routeAction still present after revert.",
      );
    }
    if (!restoredScenario.includes("subjectId")) {
      failures.push(
        "SUBJECT_ISOLATION_BROKEN: restored scenario lost subjectId.",
      );
    }
    if (!restoredThreshold.includes("teacher-cbse-slice")) {
      failures.push(
        "PACK_INVARIANT_BROKEN: restored threshold lost teacher-cbse-slice pack.",
      );
    }

    const ok = failures.length === 0;
    emit({
      outcome: ok ? "ok" : "error",
      failureCount: failures.length,
      phases: phases.map((p) => p.phase),
      subjectId: "guidance-eval-prove",
      deviceId: "ci",
    });
    return {
      ok,
      phases,
      failures,
      redLog: red.combined,
      greenLog: green.combined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(message);
    emit({
      outcome: "error",
      code: "GUIDANCE_EVAL_PROVE_FAILED",
      message,
      subjectId: "guidance-eval-prove",
      deviceId: "ci",
    });
    return { ok: false, phases, failures };
  } finally {
    if (originals !== null) {
      try {
        restoreSeededFiles(originals, { thresholdPath, scenarioPath });
        emit({
          phase: "restore-finally",
          outcome: "ok",
          subjectId: "guidance-eval-prove",
          deviceId: "ci",
        });
      } catch (restoreErr) {
        emit({
          phase: "restore-finally",
          outcome: "error",
          message:
            restoreErr instanceof Error
              ? restoreErr.message
              : String(restoreErr),
          subjectId: "guidance-eval-prove",
          deviceId: "ci",
        });
      }
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

if (isMain) {
  const result = proveGuidanceEvalGate();
  if (!result.ok) {
    for (const block of result.failures) {
      console.error("\n======== GUIDANCE EVAL PROVE FAILED ========\n");
      console.error(block);
    }
    process.exitCode = 1;
  }
}
