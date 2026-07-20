/**
 * Load + validate the C4 micro-run fixture set (model, corpus, gym).
 * Pinned tiny fixtures only — no network fetch, no GPU requirement.
 *
 * Usage (from repo root or package):
 *   node training/pipeline/micro_run/load_fixtures.mjs
 *   node training/pipeline/micro_run/load_fixtures.mjs --fixtures <dir>
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MICRO_RUN_FIXTURE_SET_SCHEMA = "micro-run.fixture-set.v1";
export const MICRO_RUN_FIXTURES_RELPATH =
  "training/pipeline/micro_run/fixtures";

/** @typedef {"model"|"corpus"|"gym"|"set"|"sft"|"rollout"|"grpo"|"lineage"} MicroRunStage */

export class MicroRunFixtureError extends Error {
  /**
   * @param {string} message
   * @param {{ stage: MicroRunStage, obligation: string, subjectId?: string, deviceId?: string, failingSlice?: string, diff?: string }} meta
   */
  constructor(message, meta) {
    super(message);
    this.name = "MicroRunFixtureError";
    this.stage = meta.stage;
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
    this.diff = meta.diff;
  }
}

/**
 * @param {string|Buffer} bytes
 * @returns {string}
 */
export function sha256Of(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * @param {string} abs
 * @returns {unknown}
 */
function readJson(abs) {
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new MicroRunFixtureError(
      `fixture JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      {
        stage: "set",
        obligation: "micro_run.fixture_io",
        failingSlice: abs,
        diff: String(err),
      },
    );
  }
}

/**
 * @param {string} fixturesDir
 * @param {string} rel
 * @param {string} expectedHash
 * @param {MicroRunStage} stage
 */
function assertPinnedFile(fixturesDir, rel, expectedHash, stage) {
  const abs = path.join(fixturesDir, rel);
  if (!existsSync(abs)) {
    throw new MicroRunFixtureError(`missing pinned fixture file: ${rel}`, {
      stage,
      obligation: "micro_run.fixture_missing",
      failingSlice: rel,
      diff: `expected file at ${abs}`,
    });
  }
  const actual = sha256Of(readFileSync(abs));
  if (actual !== expectedHash) {
    throw new MicroRunFixtureError(
      `contentHash drift on ${rel} (stage=${stage})`,
      {
        stage,
        obligation: "micro_run.pin_drift",
        failingSlice: rel,
        diff: `expected=${expectedHash}\nactual=${actual}`,
      },
    );
  }
  return { abs, actual };
}

/**
 * @param {unknown} model
 * @param {{ subjectId: string, deviceId: string }} ctx
 */
export function assertModelStubPinned(model, ctx) {
  if (!model || typeof model !== "object") {
    throw new MicroRunFixtureError("model stub must be an object", {
      stage: "model",
      obligation: "micro_run.model_invalid",
      ...ctx,
    });
  }
  const m = /** @type {Record<string, unknown>} */ (model);
  if (m.schemaVersion !== "micro-run.slm-stub.v1") {
    throw new MicroRunFixtureError("unsupported model stub schema", {
      stage: "model",
      obligation: "micro_run.model_invalid",
      ...ctx,
      failingSlice: String(m.schemaVersion),
      diff: `expected micro-run.slm-stub.v1 got ${m.schemaVersion}`,
    });
  }
  if (m.requiresGpu === true) {
    throw new MicroRunFixtureError(
      "micro-run model must not require GPU (CPU-class CI only)",
      {
        stage: "model",
        obligation: "micro_run.gpu_forbidden",
        ...ctx,
        failingSlice: String(m.modelId),
        diff: "requiresGpu=true",
      },
    );
  }
  if (m.allowsNetworkFetch === true) {
    throw new MicroRunFixtureError(
      "micro-run model must not allow network fetch — fixtures are pinned offline",
      {
        stage: "model",
        obligation: "micro_run.network_forbidden",
        ...ctx,
        failingSlice: String(m.modelId),
        diff: "allowsNetworkFetch=true",
      },
    );
  }
  if (
    typeof m.baseModelHash !== "string" ||
    m.baseModelHash.length < 8 ||
    m.baseModelHash.toLowerCase() === "latest"
  ) {
    throw new MicroRunFixtureError(
      "model baseModelHash must be an opaque pinned hash (not 'latest')",
      {
        stage: "model",
        obligation: "micro_run.model_unpinned",
        ...ctx,
        failingSlice: String(m.baseModelHash),
      },
    );
  }
}

/**
 * @param {unknown} manifest
 * @param {{ subjectId: string, deviceId: string }} ctx
 */
export function assertCorpusSlice(manifest, ctx) {
  if (!manifest || typeof manifest !== "object") {
    throw new MicroRunFixtureError("corpus manifest must be an object", {
      stage: "corpus",
      obligation: "micro_run.corpus_invalid",
      ...ctx,
    });
  }
  const m = /** @type {Record<string, unknown>} */ (manifest);
  if (m.schemaVersion !== "training.corpus-manifest.v1") {
    throw new MicroRunFixtureError("unsupported corpus manifest schema", {
      stage: "corpus",
      obligation: "micro_run.corpus_invalid",
      ...ctx,
      failingSlice: String(m.schemaVersion),
    });
  }
  if (m.consentClass !== "synthetic") {
    throw new MicroRunFixtureError(
      "micro-run corpus must be consentClass=synthetic",
      {
        stage: "corpus",
        obligation: "micro_run.corpus_consent",
        ...ctx,
        diff: `consentClass=${m.consentClass}`,
      },
    );
  }
  const sources = m.sources;
  if (!Array.isArray(sources) || sources.length < 1) {
    throw new MicroRunFixtureError("corpus must declare ≥1 source", {
      stage: "corpus",
      obligation: "micro_run.corpus_invalid",
      ...ctx,
    });
  }
  const policy = /** @type {Record<string, unknown>} */ (
    m.weightTrainingPolicy ?? {}
  );
  const exclude = policy.excludeKnowledgeModes;
  if (!Array.isArray(exclude) || !exclude.includes("RET")) {
    throw new MicroRunFixtureError(
      "corpus weightTrainingPolicy must exclude RET",
      {
        stage: "corpus",
        obligation: "micro_run.corpus_policy",
        ...ctx,
      },
    );
  }
}

/**
 * @param {unknown} gym
 * @param {{ subjectId: string, deviceId: string, min: number, max: number }} ctx
 */
export function assertGymScenarios(gym, ctx) {
  if (!gym || typeof gym !== "object") {
    throw new MicroRunFixtureError("gym scenarios doc must be an object", {
      stage: "gym",
      obligation: "micro_run.gym_invalid",
      subjectId: ctx.subjectId,
      deviceId: ctx.deviceId,
    });
  }
  const g = /** @type {Record<string, unknown>} */ (gym);
  if (g.schemaVersion !== "micro-run.gym-scenarios.v1") {
    throw new MicroRunFixtureError("unsupported gym scenarios schema", {
      stage: "gym",
      obligation: "micro_run.gym_invalid",
      subjectId: ctx.subjectId,
      deviceId: ctx.deviceId,
      failingSlice: String(g.schemaVersion),
    });
  }
  if (g.subjectId !== ctx.subjectId) {
    throw new MicroRunFixtureError(
      "gym scenarios subjectId does not match fixture set subject",
      {
        stage: "gym",
        obligation: "micro_run.subject_scope",
        subjectId: ctx.subjectId,
        deviceId: ctx.deviceId,
        failingSlice: String(g.subjectId),
        diff: `set=${ctx.subjectId} gym=${g.subjectId}`,
      },
    );
  }
  const scenarios = g.scenarios;
  if (!Array.isArray(scenarios)) {
    throw new MicroRunFixtureError("gym.scenarios must be an array", {
      stage: "gym",
      obligation: "micro_run.gym_invalid",
      subjectId: ctx.subjectId,
      deviceId: ctx.deviceId,
    });
  }
  if (scenarios.length < ctx.min || scenarios.length > ctx.max) {
    throw new MicroRunFixtureError(
      `gym scenario count must be in [${ctx.min}, ${ctx.max}]`,
      {
        stage: "gym",
        obligation: "micro_run.gym_count",
        subjectId: ctx.subjectId,
        deviceId: ctx.deviceId,
        diff: `count=${scenarios.length} bounds=[${ctx.min},${ctx.max}]`,
      },
    );
  }
  for (const s of scenarios) {
    const row = /** @type {Record<string, unknown>} */ (s);
    if (row.subjectId !== ctx.subjectId) {
      throw new MicroRunFixtureError(
        "cross-subject gym scenario entry denied",
        {
          stage: "gym",
          obligation: "micro_run.subject_scope",
          subjectId: ctx.subjectId,
          deviceId: ctx.deviceId,
          failingSlice: String(row.scenarioId),
          diff: `entry subjectId=${row.subjectId}`,
        },
      );
    }
  }
}

/**
 * Load the committed micro-run fixture set and verify all pins.
 *
 * @param {{ fixturesDir?: string, subjectId?: string, deviceId?: string, onTelemetry?: (e: Record<string, unknown>) => void }} [opts]
 */
export function loadMicroRunFixtureSet(opts = {}) {
  const fixturesDir = path.resolve(
    opts.fixturesDir ??
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "fixtures",
      ),
  );
  const setPath = path.join(fixturesDir, "set.manifest.json");
  if (!existsSync(setPath)) {
    throw new MicroRunFixtureError("set.manifest.json missing", {
      stage: "set",
      obligation: "micro_run.fixture_missing",
      failingSlice: setPath,
    });
  }

  const setDoc = /** @type {Record<string, unknown>} */ (readJson(setPath));
  if (setDoc.schemaVersion !== MICRO_RUN_FIXTURE_SET_SCHEMA) {
    throw new MicroRunFixtureError("unsupported fixture set schema", {
      stage: "set",
      obligation: "micro_run.set_invalid",
      failingSlice: String(setDoc.schemaVersion),
    });
  }

  const subjectId =
    opts.subjectId ??
    (typeof setDoc.subjectId === "string" ? setDoc.subjectId : "subj.micro.run");
  const deviceId =
    opts.deviceId ??
    (typeof setDoc.deviceId === "string" ? setDoc.deviceId : "dev.micro.run");
  const ctx = { subjectId, deviceId };

  if (setDoc.requiresGpu === true || setDoc.allowsNetworkFetch === true) {
    throw new MicroRunFixtureError(
      "fixture set must declare requiresGpu=false and allowsNetworkFetch=false",
      {
        stage: "set",
        obligation: "micro_run.set_policy",
        ...ctx,
        diff: `requiresGpu=${setDoc.requiresGpu} allowsNetworkFetch=${setDoc.allowsNetworkFetch}`,
      },
    );
  }

  const modelPin = /** @type {Record<string, string>} */ (setDoc.model);
  const corpusPin = /** @type {Record<string, string>} */ (setDoc.corpus);
  const gymPin = /** @type {Record<string, unknown>} */ (setDoc.gym);

  assertPinnedFile(
    fixturesDir,
    modelPin.relpath,
    modelPin.contentHash,
    "model",
  );
  const model = readJson(path.join(fixturesDir, modelPin.relpath));
  assertModelStubPinned(model, ctx);

  assertPinnedFile(
    fixturesDir,
    corpusPin.manifestRelpath,
    corpusPin.manifestContentHash,
    "corpus",
  );
  assertPinnedFile(
    fixturesDir,
    corpusPin.examplesRelpath,
    corpusPin.examplesContentHash,
    "corpus",
  );
  assertPinnedFile(
    fixturesDir,
    corpusPin.sourceRelpath,
    corpusPin.sourceContentHash,
    "corpus",
  );
  const corpusManifest = readJson(
    path.join(fixturesDir, corpusPin.manifestRelpath),
  );
  assertCorpusSlice(corpusManifest, ctx);

  // Source contentHash on corpus manifest must match the pinned source file.
  const sources = /** @type {Array<Record<string, string>>} */ (
    /** @type {Record<string, unknown>} */ (corpusManifest).sources
  );
  const src0 = sources[0];
  if (src0?.contentHash !== corpusPin.sourceContentHash) {
    throw new MicroRunFixtureError(
      "corpus source contentHash does not match set pin",
      {
        stage: "corpus",
        obligation: "micro_run.pin_drift",
        ...ctx,
        failingSlice: src0?.sourceId,
        diff: `manifest=${src0?.contentHash}\nset=${corpusPin.sourceContentHash}`,
      },
    );
  }

  assertPinnedFile(
    fixturesDir,
    /** @type {string} */ (gymPin.scenariosRelpath),
    /** @type {string} */ (gymPin.scenariosContentHash),
    "gym",
  );
  const gymScenarios = readJson(
    path.join(fixturesDir, /** @type {string} */ (gymPin.scenariosRelpath)),
  );
  const min = Number(gymPin.scenarioCountMin ?? 2);
  const max = Number(gymPin.scenarioCountMax ?? 3);
  assertGymScenarios(gymScenarios, { ...ctx, min, max });

  const taskPins = /** @type {Array<Record<string, string>>} */ (
    gymPin.taskPins ?? []
  );
  if (taskPins.length < min || taskPins.length > max) {
    throw new MicroRunFixtureError(
      `gym taskPins count must be in [${min}, ${max}]`,
      {
        stage: "gym",
        obligation: "micro_run.gym_count",
        ...ctx,
        diff: `taskPins=${taskPins.length}`,
      },
    );
  }
  for (const pin of taskPins) {
    assertPinnedFile(fixturesDir, pin.relpath, pin.contentHash, "gym");
    const task = /** @type {Record<string, unknown>} */ (
      readJson(path.join(fixturesDir, pin.relpath))
    );
    if (task.subjectId !== subjectId) {
      throw new MicroRunFixtureError(
        "gym task subjectId does not match fixture set",
        {
          stage: "gym",
          obligation: "micro_run.subject_scope",
          ...ctx,
          failingSlice: pin.scenarioId,
          diff: `task subjectId=${task.subjectId}`,
        },
      );
    }
    if (task.scenarioId !== pin.scenarioId) {
      throw new MicroRunFixtureError("gym task scenarioId pin mismatch", {
        stage: "gym",
        obligation: "micro_run.pin_drift",
        ...ctx,
        failingSlice: pin.scenarioId,
        diff: `pin=${pin.scenarioId} task=${task.scenarioId}`,
      });
    }
  }

  const event = {
    event: "training.micro_run.fixtures",
    outcome: "ok",
    subjectId,
    deviceId,
    setId: setDoc.setId,
    modelId: /** @type {Record<string, unknown>} */ (model).modelId,
    corpusManifestId: /** @type {Record<string, unknown>} */ (corpusManifest)
      .manifestId,
    gymScenarioCount: taskPins.length,
    baseModelHash: /** @type {Record<string, unknown>} */ (model)
      .baseModelHash,
    stage: "set",
  };
  opts.onTelemetry?.(event);

  return {
    fixturesDir,
    set: setDoc,
    model,
    corpusManifest,
    examples: readJson(path.join(fixturesDir, corpusPin.examplesRelpath)),
    gymScenarios,
    taskPins,
    subjectId,
    deviceId,
    baseModelHash: /** @type {string} */ (
      /** @type {Record<string, unknown>} */ (model).baseModelHash
    ),
  };
}

/**
 * Validate a model stub path as a known-bad / alternate input (for red proves).
 * @param {string} modelPath
 * @param {{ subjectId?: string, deviceId?: string }} [opts]
 */
export function lintMicroRunModelStubFile(modelPath, opts = {}) {
  const subjectId = opts.subjectId ?? "subj.micro.run";
  const deviceId = opts.deviceId ?? "dev.micro.run";
  const model = readJson(modelPath);
  assertModelStubPinned(model, { subjectId, deviceId });
  return { ok: true, model };
}

function parseArgs(argv) {
  /** @type {{ fixturesDir?: string }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixtures" && argv[i + 1]) {
      out.fixturesDir = argv[++i];
    }
  }
  return out;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const loaded = loadMicroRunFixtureSet({
      ...(args.fixturesDir !== undefined
        ? { fixturesDir: args.fixturesDir }
        : {}),
      onTelemetry: (e) => {
        process.stdout.write(`${JSON.stringify(e)}\n`);
      },
    });
    process.stdout.write(
      `${JSON.stringify({
        event: "training.micro_run.fixtures",
        outcome: "ok",
        subjectId: loaded.subjectId,
        deviceId: loaded.deviceId,
        setId: loaded.set.setId,
        baseModelHash: loaded.baseModelHash,
        gymScenarioCount: loaded.taskPins.length,
      })}\n`,
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof MicroRunFixtureError) {
      process.stderr.write(
        `MICRO-RUN FIXTURE FAIL stage=${err.stage} obligation=${err.obligation}` +
          (err.failingSlice ? ` slice=${err.failingSlice}` : "") +
          `\n${err.message}\n`,
      );
      if (err.diff) {
        process.stderr.write(`DIFF\n${err.diff}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(
      `MICRO-RUN FIXTURE FAIL stage=set ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main();
}
