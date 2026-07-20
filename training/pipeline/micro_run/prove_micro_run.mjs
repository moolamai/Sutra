/**
 * CI prove: micro-run orchestrator green with complete lineage;
 * intentionally broken flat-critic GRPO fixture turns red with stage=grpo;
 * re-running the good path stays green.
 *
 * Usage:
 *   node training/pipeline/micro_run/prove_micro_run.mjs
 *   pnpm --filter @moolam/training-pipeline micro-run:prove
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMicroRunLineageComplete } from "./assert_lineage.mjs";
import {
  MicroRunOrchestratorError,
  createMicroRunFlatCritic,
  formatOrchestratorFailure,
  runMicroRunOrchestrator,
} from "./orchestrate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const BROKEN_GRPO = path.join(
  FIXTURES,
  "violations",
  "broken-grpo-flat-critic.json",
);

/**
 * @param {unknown} raw
 */
function loadBrokenGrpoFixture(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MicroRunOrchestratorError(
      "broken GRPO fixture must be a JSON object",
      {
        stage: "grpo",
        obligation: "micro_run.grpo_fixture",
        diff: `typeof=${raw === null ? "null" : typeof raw}`,
      },
    );
  }
  const doc = /** @type {Record<string, unknown>} */ (raw);
  if (doc.schemaVersion !== "micro-run.grpo-violation.v1") {
    throw new MicroRunOrchestratorError(
      "broken GRPO fixture schemaVersion mismatch",
      {
        stage: "grpo",
        obligation: "micro_run.grpo_fixture",
        diff: `expected=micro-run.grpo-violation.v1 actual=${String(doc.schemaVersion)}`,
      },
    );
  }
  if (doc.stage !== "grpo" || doc.criticMode !== "flat") {
    throw new MicroRunOrchestratorError(
      "broken GRPO fixture must declare stage=grpo criticMode=flat",
      {
        stage: "grpo",
        obligation: "micro_run.grpo_fixture",
        diff: JSON.stringify({
          stage: doc.stage,
          criticMode: doc.criticMode,
        }),
      },
    );
  }
  return doc;
}

/**
 * @param {{
 *   fixturesDir?: string,
 *   onTelemetry?: (e: Record<string, unknown>) => void,
 * }} [opts]
 */
export async function proveMicroRunCiGate(opts = {}) {
  const events = [];
  /** @param {Record<string, unknown>} e */
  const onTelemetry = (e) => {
    events.push(e);
    opts.onTelemetry?.(e);
  };

  const fixturesDir = opts.fixturesDir ?? FIXTURES;
  const violationRaw = JSON.parse(readFileSync(BROKEN_GRPO, "utf8"));
  const violation = loadBrokenGrpoFixture(violationRaw);

  const greenOut = mkdtempSync(path.join(tmpdir(), "micro-run-prove-green-"));
  const green = await runMicroRunOrchestrator({
    fixturesDir,
    outDir: greenOut,
    onTelemetry,
  });

  const asserted = assertMicroRunLineageComplete({
    outDir: green.outDir,
    subjectId: green.subjectId,
    deviceId: green.deviceId,
    lineageRunId: green.candidate.lineageRunId,
    checkpointHash: green.grpoCheckpointHash,
    onTelemetry,
  });

  let grpoRejected = false;
  /** @type {string|undefined} */
  let grpoObligation;
  /** @type {string|undefined} */
  let grpoDiff;
  try {
    await runMicroRunOrchestrator({
      fixturesDir,
      outDir: mkdtempSync(path.join(tmpdir(), "micro-run-prove-red-")),
      critic: createMicroRunFlatCritic(),
      onTelemetry,
    });
  } catch (err) {
    if (
      err instanceof MicroRunOrchestratorError &&
      err.stage === "grpo" &&
      (err.obligation === "micro_run.grpo_group" ||
        err.obligation === "micro_run.grpo_advantage" ||
        err.obligation === String(violation.obligation))
    ) {
      grpoRejected = true;
      grpoObligation = err.obligation;
      grpoDiff = err.diff;
      onTelemetry({
        event: "training.micro_run.prove",
        outcome: "advisory",
        subjectId: green.subjectId,
        deviceId: green.deviceId,
        stage: err.stage,
        obligation: err.obligation,
        checkpointHash: err.checkpointHash,
        diff: err.diff,
        violationId: violation.violationId,
      });
    } else {
      throw err;
    }
  }

  if (!grpoRejected) {
    throw new MicroRunOrchestratorError(
      "expected broken flat-critic GRPO fixture to fail with stage=grpo",
      {
        stage: "grpo",
        obligation: "micro_run.grpo_fixture",
        subjectId: green.subjectId,
        deviceId: green.deviceId,
        failingSlice: String(violation.violationId),
        diff: "flat critic run completed without naming stage=grpo",
      },
    );
  }

  // Revert path: good orchestrator + lineage assert still green.
  const revertOut = mkdtempSync(path.join(tmpdir(), "micro-run-prove-revert-"));
  const revert = await runMicroRunOrchestrator({
    fixturesDir,
    outDir: revertOut,
    onTelemetry,
  });
  assertMicroRunLineageComplete({
    outDir: revert.outDir,
    subjectId: revert.subjectId,
    deviceId: revert.deviceId,
    lineageRunId: revert.candidate.lineageRunId,
    checkpointHash: revert.grpoCheckpointHash,
    onTelemetry,
  });

  return {
    ok: true,
    subjectId: green.subjectId,
    deviceId: green.deviceId,
    lineageComplete: asserted.complete,
    lineageRevision: asserted.revision,
    grpoCheckpointHash: green.grpoCheckpointHash,
    violationRejected: true,
    violationId: violation.violationId,
    grpoObligation,
    grpoDiff,
    telemetryCount: events.length,
  };
}

async function main() {
  try {
    const proved = await proveMicroRunCiGate({
      onTelemetry: (e) => {
        process.stdout.write(`${JSON.stringify(e)}\n`);
      },
    });
    process.stdout.write(
      `${JSON.stringify({
        event: "training.micro_run.prove",
        outcome: "ok",
        subjectId: proved.subjectId,
        deviceId: proved.deviceId,
        lineageComplete: proved.lineageComplete,
        lineageRevision: proved.lineageRevision,
        grpoCheckpointHash: proved.grpoCheckpointHash,
        violationRejected: proved.violationRejected,
        violationId: proved.violationId,
        grpoObligation: proved.grpoObligation,
        telemetryCount: proved.telemetryCount,
      })}\n`,
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof MicroRunOrchestratorError) {
      process.stderr.write(formatOrchestratorFailure(err));
      process.exit(1);
    }
    process.stderr.write(
      `MICRO-RUN PROVE FAIL ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void main();
}
