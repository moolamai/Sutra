/**
 * C4 micro-run orchestrator — end-to-end CPU CI path.
 *
 * Stages: fixtures → SFT warmstart → rollout enqueue → GRPO → lineage → candidate.
 * Failures print the failing stage + checkpoint hashes + DIFF. Bounded wall clock.
 *
 * Usage:
 *   pnpm --filter @moolam/training-pipeline micro-run
 *   node training/pipeline/micro_run/orchestrate.mjs --out <dir>
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { proveLoraAdapterUpdateMicroRun } from "../../../packages/bindings-slm/dist/index.js";
import {
  CHECKPOINT_LINEAGE_SCHEMA_VERSION,
  admitCandidateEmissionOrThrow,
  openCheckpointLineageRegistry,
  openLocalEncryptedTrajectoryQueue,
  proveGrpoAdvantageLossMicroRun,
  proveGrpoGroupSamplingMicroRun,
  resetCheckpointLineageCandidateCache,
  resetGrpoAdvantageCache,
  resetGrpoGroupCache,
} from "../../../packages/learning/dist/index.js";
import {
  resetSftWarmstartCache,
  runSftWarmstart,
} from "../../corpus/dist/sft_warmstart.js";
import {
  MicroRunFixtureError,
  loadMicroRunFixtureSet,
} from "./load_fixtures.mjs";

export const MICRO_RUN_ORCHESTRATOR_SCHEMA = "micro-run.orchestrator.v1";

/** Default wall-clock budget for the full micro-run (CPU CI). */
export const MICRO_RUN_WALL_CLOCK_MS_DEFAULT = 60_000;

/** @typedef {"fixtures"|"sft"|"rollout"|"grpo"|"lineage"|"candidate"|"deadline"} MicroRunOrchStage */

export class MicroRunOrchestratorError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   stage: MicroRunOrchStage,
   *   obligation: string,
   *   subjectId?: string,
   *   deviceId?: string,
   *   failingSlice?: string,
   *   diff?: string,
   *   checkpointHash?: string,
   *   parentCheckpointHash?: string,
   * }} meta
   */
  constructor(message, meta) {
    super(message);
    this.name = "MicroRunOrchestratorError";
    this.stage = meta.stage;
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
    this.diff = meta.diff;
    this.checkpointHash = meta.checkpointHash;
    this.parentCheckpointHash = meta.parentCheckpointHash;
  }
}

/**
 * Critic with per-seed scores so GRPO σ stays above the skip floor.
 * @returns {import("@moolam/learning").TrajectoryCritic}
 */
export function createMicroRunDifferentiatingCritic() {
  const rubricId = "critic.micro-run.diff";
  const rubricVersion = "1.0.0";
  return {
    rubricId,
    rubricVersion,
    score(record) {
      const seed =
        typeof record?.rolloutSeed === "number" &&
        Number.isFinite(record.rolloutSeed)
          ? record.rolloutSeed
          : 1;
      const quality = 0.15 * seed;
      return {
        total: quality,
        breakdown: { quality },
        rubricVersion,
      };
    },
  };
}

/**
 * Intentionally broken critic: identical scores → σ≈0 → GRPO group skip.
 * Used by the micro-run CI red fixture (broken GRPO path).
 * @returns {import("@moolam/learning").TrajectoryCritic}
 */
export function createMicroRunFlatCritic() {
  const rubricId = "critic.micro-run.flat";
  const rubricVersion = "1.0.0";
  return {
    rubricId,
    rubricVersion,
    score() {
      return {
        total: 0.5,
        breakdown: { quality: 0.5 },
        rubricVersion,
      };
    },
  };
}

/**
 * @param {number} startedAt
 * @param {number} budgetMs
 * @param {MicroRunOrchStage} nextStage
 * @param {{ subjectId: string, deviceId: string }} ctx
 */
function assertWithinDeadline(startedAt, budgetMs, nextStage, ctx) {
  const elapsed = Date.now() - startedAt;
  if (elapsed > budgetMs) {
    throw new MicroRunOrchestratorError(
      `micro-run wall-clock budget exceeded before stage=${nextStage}`,
      {
        stage: "deadline",
        obligation: "micro_run.wall_clock",
        ...ctx,
        failingSlice: nextStage,
        diff: `elapsedMs=${elapsed} budgetMs=${budgetMs}`,
      },
    );
  }
}

/**
 * @param {unknown} examplesDoc
 * @param {string} subjectId
 */
function assertExamplesSubjectScope(examplesDoc, subjectId) {
  const doc = /** @type {Record<string, unknown>} */ (examplesDoc ?? {});
  if (doc.subjectId !== subjectId) {
    throw new MicroRunOrchestratorError(
      "examples subjectId does not match fixture set subject",
      {
        stage: "sft",
        obligation: "micro_run.subject_scope",
        subjectId,
        failingSlice: String(doc.subjectId),
        diff: `set=${subjectId} examples=${doc.subjectId}`,
      },
    );
  }
  const examples = /** @type {Array<Record<string, unknown>>} */ (
    doc.examples ?? []
  );
  for (const ex of examples) {
    if (ex.subjectId !== subjectId) {
      throw new MicroRunOrchestratorError(
        "cross-subject SFT example denied",
        {
          stage: "sft",
          obligation: "micro_run.subject_scope",
          subjectId,
          failingSlice: String(ex.exampleId),
          diff: `example subjectId=${ex.subjectId}`,
        },
      );
    }
  }
  return examples;
}

/**
 * Run the full micro-run pipeline against the pinned fixture set.
 *
 * @param {{
 *   fixturesDir?: string,
 *   outDir?: string,
 *   wallClockMs?: number,
 *   failAt?: MicroRunOrchStage,
 *   subjectId?: string,
 *   deviceId?: string,
 *   critic?: import("@moolam/learning").TrajectoryCritic,
 *   onTelemetry?: (e: Record<string, unknown>) => void,
 * }} [opts]
 */
export async function runMicroRunOrchestrator(opts = {}) {
  const startedAt = Date.now();
  const wallClockMs = opts.wallClockMs ?? MICRO_RUN_WALL_CLOCK_MS_DEFAULT;
  const tel = opts.onTelemetry;

  /** @param {Record<string, unknown>} e */
  const emit = (e) => {
    tel?.(e);
  };

  resetSftWarmstartCache();
  resetGrpoGroupCache();
  resetGrpoAdvantageCache();
  resetCheckpointLineageCandidateCache();

  // --- fixtures ---
  assertWithinDeadline(startedAt, wallClockMs, "fixtures", {
    subjectId: opts.subjectId ?? "subj.micro.run",
    deviceId: opts.deviceId ?? "dev.micro.run",
  });
  if (opts.failAt === "fixtures") {
    throw new MicroRunOrchestratorError("injected failure at fixtures stage", {
      stage: "fixtures",
      obligation: "micro_run.injected_fail",
      subjectId: opts.subjectId ?? "subj.micro.run",
      deviceId: opts.deviceId ?? "dev.micro.run",
    });
  }

  let loaded;
  try {
    loaded = loadMicroRunFixtureSet({
      ...(opts.fixturesDir !== undefined
        ? { fixturesDir: opts.fixturesDir }
        : {}),
      ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      onTelemetry: (e) => emit({ ...e, orchStage: "fixtures" }),
    });
  } catch (err) {
    if (err instanceof MicroRunFixtureError) {
      throw new MicroRunOrchestratorError(err.message, {
        stage: /** @type {MicroRunOrchStage} */ (
          err.stage === "model" ||
          err.stage === "corpus" ||
          err.stage === "gym" ||
          err.stage === "set"
            ? "fixtures"
            : err.stage
        ),
        obligation: err.obligation,
        subjectId: err.subjectId,
        deviceId: err.deviceId,
        failingSlice: err.failingSlice,
        diff: err.diff,
      });
    }
    throw err;
  }

  const subjectId = loaded.subjectId;
  const deviceId = loaded.deviceId;
  const ctx = { subjectId, deviceId };
  const baseModelHash = loaded.baseModelHash;
  const outDir =
    opts.outDir ??
    mkdtempSync(path.join(tmpdir(), "micro-run-out-"));
  mkdirSync(outDir, { recursive: true });

  emit({
    event: "training.micro_run.orchestrator",
    outcome: "ok",
    stage: "fixtures",
    subjectId,
    deviceId,
    setId: loaded.set.setId,
    baseModelHash,
  });

  // --- SFT ---
  assertWithinDeadline(startedAt, wallClockMs, "sft", ctx);
  if (opts.failAt === "sft") {
    throw new MicroRunOrchestratorError("injected failure at SFT stage", {
      stage: "sft",
      obligation: "micro_run.injected_fail",
      ...ctx,
      checkpointHash: baseModelHash,
    });
  }

  const examples = assertExamplesSubjectScope(loaded.examples, subjectId);
  const sft = runSftWarmstart({
    manifest: loaded.corpusManifest,
    examples: /** @type {import("@moolam/training-corpus/sft-warmstart").SftTrainingExample[]} */ (
      examples
    ),
    baseCheckpointHash: baseModelHash,
    subjectId,
    deviceId,
    runId: `sft.micro-run.${subjectId}`,
    publishedAt: "2026-07-16T15:00:00.000Z",
    onTelemetry: (e) => emit({ ...e, orchStage: "sft" }),
  });
  if (!sft.ok) {
    throw new MicroRunOrchestratorError("SFT warmstart failed", {
      stage: "sft",
      obligation: "micro_run.sft_failed",
      ...ctx,
      checkpointHash: baseModelHash,
      diff: JSON.stringify(sft),
    });
  }

  const sftCheckpointHash = sft.checkpoint.checkpointHash;
  emit({
    event: "training.micro_run.orchestrator",
    outcome: "ok",
    stage: "sft",
    subjectId,
    deviceId,
    checkpointHash: sftCheckpointHash,
    corpusManifestHash: sft.corpusManifestHash,
    supervisedLoss: sft.supervisedLoss,
  });

  // --- rollout ---
  assertWithinDeadline(startedAt, wallClockMs, "rollout", ctx);
  if (opts.failAt === "rollout") {
    throw new MicroRunOrchestratorError("injected failure at rollout stage", {
      stage: "rollout",
      obligation: "micro_run.injected_fail",
      ...ctx,
      checkpointHash: sftCheckpointHash,
    });
  }

  const queueDir = path.join(outDir, "trajectory-queue");
  mkdirSync(queueDir, { recursive: true });
  const queueKey = randomBytes(32);
  const queue = openLocalEncryptedTrajectoryQueue({
    rootDir: queueDir,
    keyMaterial: queueKey,
    maxDepth: 16,
    onTelemetry: (e) => emit({ ...e, orchStage: "rollout" }),
  });

  const gymScenarios = /** @type {Record<string, unknown>} */ (
    loaded.gymScenarios
  );
  const scenarioRows = /** @type {Array<Record<string, string>>} */ (
    gymScenarios.scenarios ?? []
  );
  const promptId =
    scenarioRows[0]?.promptId ?? "prompt.micro.thought-answer";

  /** @type {import("@moolam/learning").TurnTrajectoryRecord[]} */
  const rollouts = [];
  for (let i = 0; i < 4; i++) {
    const trajectoryId = `traj.micro-run.${i + 1}`;
    /** @type {import("@moolam/learning").TurnTrajectoryRecord} */
    const traj = {
      schemaVersion: "trajectory.v1",
      subjectId,
      sessionId: `sess.micro-run.${promptId}`,
      turnId: trajectoryId,
      deviceId,
      capturedAt: "2026-07-16T15:01:00.000Z",
      locality: "on-device",
      consent: {
        optedIn: true,
        consentClass: "research",
        recordedAt: "2026-07-16T15:01:00.000Z",
      },
      stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
      policyCheckpointHash: sftCheckpointHash,
      rolloutSeed: i + 1,
    };
    rollouts.push(traj);
    const enq = queue.enqueue({ trajectory: traj });
    if (!enq.queued) {
      throw new MicroRunOrchestratorError("rollout enqueue rejected", {
        stage: "rollout",
        obligation: "micro_run.rollout_queue",
        ...ctx,
        checkpointHash: sftCheckpointHash,
        failingSlice: trajectoryId,
      });
    }
  }
  let dequeued = 0;
  while (true) {
    const next = queue.dequeue({ subjectId });
    if (!next.dequeued) break;
    dequeued += 1;
  }
  if (dequeued !== 4) {
    throw new MicroRunOrchestratorError(
      "rollout queue dequeue count mismatch",
      {
        stage: "rollout",
        obligation: "micro_run.rollout_queue",
        ...ctx,
        checkpointHash: sftCheckpointHash,
        diff: `enqueued=4 dequeued=${dequeued}`,
      },
    );
  }
  emit({
    event: "training.micro_run.orchestrator",
    outcome: "ok",
    stage: "rollout",
    subjectId,
    deviceId,
    checkpointHash: sftCheckpointHash,
    rolloutCount: rollouts.length,
    promptId,
  });

  // --- GRPO ---
  assertWithinDeadline(startedAt, wallClockMs, "grpo", ctx);
  if (opts.failAt === "grpo") {
    throw new MicroRunOrchestratorError("injected failure at GRPO stage", {
      stage: "grpo",
      obligation: "micro_run.injected_fail",
      ...ctx,
      checkpointHash: sftCheckpointHash,
    });
  }

  const critic = opts.critic ?? createMicroRunDifferentiatingCritic();
  const groupProved = proveGrpoGroupSamplingMicroRun({
    subjectId,
    deviceId,
    promptId,
    policyCheckpointHash: sftCheckpointHash,
    critic,
    groupSize: 4,
    corpusManifestId: String(
      /** @type {Record<string, unknown>} */ (loaded.corpusManifest).manifestId,
    ),
    hyperparametersId: "hyper.micro-run.v1",
    loraRank: 16,
    loraAlpha: 32,
    onTelemetry: (e) => emit({ ...e, orchStage: "grpo" }),
  });

  if (!groupProved.group.admitted || groupProved.group.skipped) {
    throw new MicroRunOrchestratorError(
      "GRPO group sampling skipped or failed — need differentiated critic scores",
      {
        stage: "grpo",
        obligation: "micro_run.grpo_group",
        ...ctx,
        checkpointHash: sftCheckpointHash,
        diff: JSON.stringify({
          admitted: groupProved.group.admitted,
          skipped: groupProved.group.skipped,
          sigma: groupProved.group.sigma,
        }),
      },
    );
  }

  const advProved = proveGrpoAdvantageLossMicroRun({
    group: groupProved.group,
    onTelemetry: (e) => emit({ ...e, orchStage: "grpo" }),
  });
  if (!advProved.ok || advProved.skipped || !advProved.loss) {
    throw new MicroRunOrchestratorError("GRPO advantage/loss skipped or failed", {
      stage: "grpo",
      obligation: "micro_run.grpo_advantage",
      ...ctx,
      checkpointHash: sftCheckpointHash,
      diff: JSON.stringify({
        skipped: advProved.skipped,
        computed: advProved.advantage?.computed,
      }),
    });
  }

  const policyLoss = advProved.loss.loss;

  const lora = proveLoraAdapterUpdateMicroRun({
    subjectId,
    deviceId,
    baseModelHash: sftCheckpointHash,
    loss: policyLoss,
    rank: 16,
    alpha: 32,
    onTelemetry: (e) => emit({ ...e, orchStage: "grpo" }),
  });

  const grpoCheckpointHash = lora.update.artifact.deltaHash;
  emit({
    event: "training.micro_run.orchestrator",
    outcome: "ok",
    stage: "grpo",
    subjectId,
    deviceId,
    checkpointHash: grpoCheckpointHash,
    parentCheckpointHash: sftCheckpointHash,
    policyLoss,
    deltaHash: grpoCheckpointHash,
  });

  // --- lineage ---
  assertWithinDeadline(startedAt, wallClockMs, "lineage", ctx);
  if (opts.failAt === "lineage") {
    throw new MicroRunOrchestratorError("injected failure at lineage stage", {
      stage: "lineage",
      obligation: "micro_run.injected_fail",
      ...ctx,
      checkpointHash: grpoCheckpointHash,
      parentCheckpointHash: sftCheckpointHash,
    });
  }

  const lineageDir = path.join(outDir, "lineage");
  mkdirSync(lineageDir, { recursive: true });
  const registry = openCheckpointLineageRegistry({
    backend: "fs",
    rootDir: lineageDir,
    onTelemetry: (e) => emit({ ...e, orchStage: "lineage" }),
  });

  const criticHash = `sha256:${createHash("sha256")
    .update(`${critic.rubricId}@${critic.rubricVersion}`)
    .digest("hex")}`;

  const sftRow = registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: `run.micro-run.sft.${subjectId}`,
      subjectId,
      deviceId,
      locality: "on-device",
      checkpointHash: sftCheckpointHash,
      corpusManifestHash: sft.corpusManifestHash,
      baseModelHash,
      hyperparameters: { lr: 1e-4, epochs: 1 },
      criticVersions: [
        {
          rubricId: critic.rubricId,
          rubricVersion: critic.rubricVersion,
          contentHash: criticHash,
        },
      ],
      stage: "SFT",
      evalVerdicts: [],
      recordedAt: "2026-07-16T15:02:00.000Z",
    },
    onTelemetry: (e) => emit({ ...e, orchStage: "lineage" }),
  });

  const grpoRow = registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: `run.micro-run.grpo.${subjectId}`,
      subjectId,
      deviceId,
      locality: "on-device",
      checkpointHash: grpoCheckpointHash,
      parentCheckpointHash: sftCheckpointHash,
      corpusManifestHash: sft.corpusManifestHash,
      baseModelHash,
      hyperparameters: {
        lr: 5e-5,
        groupSize: 4,
        clipEps: 0.2,
        loraRank: 16,
        loraAlpha: 32,
      },
      criticVersions: [
        {
          rubricId: critic.rubricId,
          rubricVersion: critic.rubricVersion,
          contentHash: criticHash,
        },
      ],
      stage: "GRPO",
      evalVerdicts: [{ verdictId: "micro-run.ci", outcome: "pass" }],
      recordedAt: "2026-07-16T15:03:00.000Z",
    },
    expectedRevision: sftRow.revision,
    onTelemetry: (e) => emit({ ...e, orchStage: "lineage" }),
  });

  emit({
    event: "training.micro_run.orchestrator",
    outcome: "ok",
    stage: "lineage",
    subjectId,
    deviceId,
    checkpointHash: grpoCheckpointHash,
    parentCheckpointHash: sftCheckpointHash,
    lineageRevision: grpoRow.revision,
  });

  // --- candidate ---
  assertWithinDeadline(startedAt, wallClockMs, "candidate", ctx);
  if (opts.failAt === "candidate") {
    throw new MicroRunOrchestratorError(
      "injected failure at candidate stage",
      {
        stage: "candidate",
        obligation: "micro_run.injected_fail",
        ...ctx,
        checkpointHash: grpoCheckpointHash,
      },
    );
  }

  const admitted = admitCandidateEmissionOrThrow(
    {
      candidateId: `cand.micro-run.${subjectId}`,
      subjectId,
      deviceId,
      lineageRunId: grpoRow.row.runId,
      checkpointHash: grpoCheckpointHash,
    },
    registry,
    { onTelemetry: (e) => emit({ ...e, orchStage: "candidate" }) },
  );

  const candidatePath = path.join(outDir, "candidate.json");
  const candidateArtifact = {
    schemaVersion: MICRO_RUN_ORCHESTRATOR_SCHEMA,
    candidateId: admitted.candidateId,
    subjectId,
    deviceId,
    locality: "on-device",
    baseModelHash,
    sftCheckpointHash,
    grpoCheckpointHash,
    corpusManifestHash: sft.corpusManifestHash,
    lineageRunId: grpoRow.row.runId,
    lineageRevision: grpoRow.revision,
    gymScenarioCount: loaded.taskPins.length,
    elapsedMs: Date.now() - startedAt,
    wallClockMs,
    stagesCompleted: [
      "fixtures",
      "sft",
      "rollout",
      "grpo",
      "lineage",
      "candidate",
    ],
  };
  writeFileSync(
    candidatePath,
    `${JSON.stringify(candidateArtifact, null, 2)}\n`,
    "utf8",
  );

  if (!existsSync(candidatePath)) {
    throw new MicroRunOrchestratorError("candidate artifact missing after write", {
      stage: "candidate",
      obligation: "micro_run.candidate_io",
      ...ctx,
      checkpointHash: grpoCheckpointHash,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  emit({
    event: "training.micro_run.orchestrator",
    outcome: "ok",
    stage: "candidate",
    subjectId,
    deviceId,
    checkpointHash: grpoCheckpointHash,
    parentCheckpointHash: sftCheckpointHash,
    candidateId: admitted.candidateId,
    elapsedMs,
    candidatePath,
  });

  return {
    ok: true,
    schemaVersion: MICRO_RUN_ORCHESTRATOR_SCHEMA,
    subjectId,
    deviceId,
    outDir,
    candidatePath,
    candidate: candidateArtifact,
    sftCheckpointHash,
    grpoCheckpointHash,
    corpusManifestHash: sft.corpusManifestHash,
    lineageRevision: grpoRow.revision,
    elapsedMs,
    wallClockMs,
  };
}

/**
 * Format a stage failure for CI logs (always include DIFF when present).
 * @param {MicroRunOrchestratorError} err
 */
export function formatOrchestratorFailure(err) {
  let msg =
    `MICRO-RUN FAIL stage=${err.stage} obligation=${err.obligation}` +
    (err.failingSlice ? ` slice=${err.failingSlice}` : "") +
    (err.checkpointHash ? ` checkpointHash=${err.checkpointHash}` : "") +
    (err.parentCheckpointHash
      ? ` parentCheckpointHash=${err.parentCheckpointHash}`
      : "") +
    `\n${err.message}\n`;
  if (err.diff) {
    msg += `DIFF\n${err.diff}\n`;
  }
  return msg;
}

function parseArgs(argv) {
  /** @type {{ fixturesDir?: string, outDir?: string, wallClockMs?: number, failAt?: MicroRunOrchStage }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixtures" && argv[i + 1]) out.fixturesDir = argv[++i];
    else if (a === "--out" && argv[i + 1]) out.outDir = argv[++i];
    else if (a === "--wall-clock-ms" && argv[i + 1])
      out.wallClockMs = Number(argv[++i]);
    else if (a === "--fail-at" && argv[i + 1])
      out.failAt = /** @type {MicroRunOrchStage} */ (argv[++i]);
  }
  return out;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runMicroRunOrchestrator({
      ...(args.fixturesDir !== undefined
        ? { fixturesDir: args.fixturesDir }
        : {}),
      ...(args.outDir !== undefined ? { outDir: args.outDir } : {}),
      ...(args.wallClockMs !== undefined
        ? { wallClockMs: args.wallClockMs }
        : {}),
      ...(args.failAt !== undefined ? { failAt: args.failAt } : {}),
      onTelemetry: (e) => {
        process.stdout.write(`${JSON.stringify(e)}\n`);
      },
    });
    process.stdout.write(
      `${JSON.stringify({
        event: "training.micro_run.orchestrator",
        outcome: "ok",
        subjectId: result.subjectId,
        deviceId: result.deviceId,
        sftCheckpointHash: result.sftCheckpointHash,
        grpoCheckpointHash: result.grpoCheckpointHash,
        corpusManifestHash: result.corpusManifestHash,
        lineageRevision: result.lineageRevision,
        elapsedMs: result.elapsedMs,
        candidatePath: result.candidatePath,
      })}\n`,
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof MicroRunOrchestratorError) {
      process.stderr.write(formatOrchestratorFailure(err));
      process.exit(1);
    }
    if (err instanceof MicroRunFixtureError) {
      process.stderr.write(
        formatOrchestratorFailure(
          new MicroRunOrchestratorError(err.message, {
            stage: "fixtures",
            obligation: err.obligation,
            subjectId: err.subjectId,
            deviceId: err.deviceId,
            failingSlice: err.failingSlice,
            diff: err.diff,
          }),
        ),
      );
      process.exit(1);
    }
    process.stderr.write(
      `MICRO-RUN FAIL stage=unknown ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  await main();
}
