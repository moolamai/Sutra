/**
 * Compile A P6 golden turns into gym scenario fixtures.
 *
 * Source (committed): packages/runtime-harness/fixtures/golden-turns/
 *   (imported A P6 bytes; origin packages/sync-protocol/fixtures/golden-turns)
 * Output (committed): training/gym/scenarios/golden/
 *
 * Language-neutral JSON only. Regeneration never auto-commits — operators
 * review diffs. Each scenario declares expectedTerminalFrame + oracleCheckId.
 * scenarioId === golden turn id so GymEnv.reset(scenarioId) maps 1:1.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GYM_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(GYM_ROOT, "../..");

/**
 * Repo-relative A P6 golden corpus (runtime-harness import of sync-protocol).
 * Touchpoint alias: fixtures/golden-turns/
 */
export const A_P6_GOLDEN_TURNS_RELPATH =
  "packages/runtime-harness/fixtures/golden-turns";

/** Repo-relative compiled gym scenario tree. */
export const GOLDEN_SCENARIO_RELPATH = "training/gym/scenarios/golden";

export const GYM_GOLDEN_SCHEMA_VERSION = "gym-golden-episode.v1";

/** Soft caps (NFR). */
export const GOLDEN_SCENARIO_LIMIT = 64;
export const GOLDEN_FRAME_META_LIMIT = 512;

export const EXPECTED_TERMINAL_FRAMES = Object.freeze([
  "TURN_COMPLETE",
  "HARNESS_ERROR",
]);

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON (sorted keys, 2-space indent, trailing NL). */
export function canonicalizeGoldenScenarioJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/**
 * @param {string} [repoRoot]
 */
export function resolveA_P6GoldenTurnsDir(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, A_P6_GOLDEN_TURNS_RELPATH);
}

/**
 * @param {string} [repoRoot]
 */
export function resolveGoldenScenarioDir(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, GOLDEN_SCENARIO_RELPATH);
}

/**
 * Derive terminal frame class + oracle metadata from a golden turn fixture.
 * Does not copy frame bodies / utterance text into the scenario task.
 * @param {{
 *   id: string,
 *   expectedFrames?: unknown[],
 *   coverage?: unknown[],
 * }} source
 */
export function deriveGoldenOracle(source) {
  const id = source.id;
  const frames = Array.isArray(source.expectedFrames)
    ? source.expectedFrames
    : [];
  const last =
    frames.length > 0 && frames[frames.length - 1]
      ? /** @type {Record<string, unknown>} */ (frames[frames.length - 1])
      : null;
  const terminalType =
    last && typeof last.type === "string" ? last.type : null;

  if (
    !terminalType ||
    !EXPECTED_TERMINAL_FRAMES.includes(
      /** @type {"TURN_COMPLETE"|"HARNESS_ERROR"} */ (terminalType),
    )
  ) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `golden ${id} expectedFrames must end with TURN_COMPLETE or HARNESS_ERROR`,
    };
  }

  if (frames.length > GOLDEN_FRAME_META_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `golden ${id} frames exceed ${GOLDEN_FRAME_META_LIMIT}`,
    };
  }

  const oracleCheckId = `oracle.golden.${id}.frame_sequence`;
  const coverage = Array.isArray(source.coverage)
    ? source.coverage.filter((c) => typeof c === "string")
    : [];

  /** @type {Array<Record<string, unknown>>} */
  const expectedOutcomes = [
    {
      kind: "frame_sequence",
      checkId: `${oracleCheckId}.identity`,
      verifiable: true,
      frameCount: frames.length,
    },
    {
      kind: "terminal_frame",
      checkId: `${oracleCheckId}.terminal`,
      expected: terminalType,
      verifiable: true,
    },
  ];

  return {
    ok: true,
    expectedTerminalFrame: terminalType,
    oracleCheckId,
    expectedOutcomes,
    frameCount: frames.length,
    coverage,
  };
}

/**
 * Compile one A P6 golden turn JSON into a gym scenario task (plain JSON).
 * @param {Record<string, unknown>} source
 * @param {{ sourceFile: string }} meta
 */
export function compileGoldenEpisodeTask(source, meta) {
  const id = typeof source.id === "string" ? source.id.trim() : "";
  if (!id) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "golden source missing id",
      subjectId: null,
    };
  }

  const subjectId =
    typeof source.subjectId === "string" && source.subjectId.trim()
      ? source.subjectId.trim()
      : "";
  if (!subjectId) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `golden ${id} missing subjectId`,
      subjectId: null,
    };
  }

  const deviceId =
    typeof source.deviceId === "string" && source.deviceId.trim()
      ? source.deviceId.trim()
      : "gym-golden-compiler";

  if (!Array.isArray(source.expectedFrames) || source.expectedFrames.length < 1) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `golden ${id} requires expectedFrames[]`,
      subjectId,
    };
  }

  const oracle = deriveGoldenOracle(
    /** @type {{ id: string, expectedFrames?: unknown[], coverage?: unknown[] }} */ (
      source
    ),
  );
  if (!oracle.ok) {
    return {
      ok: false,
      failureClass: oracle.failureClass,
      detail: oracle.detail,
      subjectId,
    };
  }

  /** reset() scenario id — identical to A P6 golden turn id. */
  const scenarioId = id;

  const sessionStart = source.expectedFrames.find(
    (f) =>
      f &&
      typeof f === "object" &&
      /** @type {Record<string, unknown>} */ (f).type === "SESSION_START",
  );
  const pinnedAt =
    sessionStart &&
    typeof /** @type {Record<string, unknown>} */ (sessionStart).pinnedAt ===
      "string"
      ? /** @type {Record<string, unknown>} */ (sessionStart).pinnedAt
      : null;

  const task = {
    schemaVersion: GYM_GOLDEN_SCHEMA_VERSION,
    scenarioId,
    sourceKind: "a_p6_golden",
    sourceRelPath: `${A_P6_GOLDEN_TURNS_RELPATH}/${meta.sourceFile}`,
    sourceId: id,
    locality: "on-device",
    subjectId,
    deviceId,
    correlationId:
      typeof source.correlationId === "string" ? source.correlationId : null,
    pinnedAt,
    expectedTerminalFrame: oracle.expectedTerminalFrame,
    oracleCheckId: oracle.oracleCheckId,
    expectedOutcomes: oracle.expectedOutcomes,
    frameCount: oracle.frameCount,
    coverage: oracle.coverage,
  };

  return { ok: true, task, subjectId };
}

/**
 * @typedef {{
 *   event: "training.gym.golden_episode",
 *   outcome: "ok" | "rejected" | "start",
 *   subjectId: string | null,
 *   deviceId?: string,
 *   action?: string,
 *   failureClass?: string,
 *   scenarioId?: string,
 *   taskCount?: number,
 * }} GoldenEpisodeTelemetry
 */

/**
 * Load A P6 golden manifest + turns and compile gym scenario tasks.
 * @param {{
 *   repoRoot?: string,
 *   subjectId?: string | null,
 *   deviceId?: string,
 *   onTelemetry?: (e: GoldenEpisodeTelemetry) => void,
 * }} [opts]
 */
export function compileA_P6GoldenEpisodeTasks(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const deviceId = opts.deviceId ?? "dev-gym-golden-compile";
  /** @type {(e: GoldenEpisodeTelemetry) => void} */
  const emit = (e) => opts.onTelemetry?.(e);

  emit({
    event: "training.gym.golden_episode",
    outcome: "start",
    subjectId: opts.subjectId ?? null,
    deviceId,
    action: "compile",
  });

  const sourceDir = resolveA_P6GoldenTurnsDir(repoRoot);
  const manifestPath = path.join(sourceDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    emit({
      event: "training.gym.golden_episode",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "compile",
      failureClass: "missing_corpus",
    });
    return {
      ok: false,
      failureClass: "missing_corpus",
      detail: `A P6 golden manifest missing: ${A_P6_GOLDEN_TURNS_RELPATH}/manifest.json`,
      subjectId: null,
      tasks: [],
      canonicalCatalogJson: "",
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "A P6 golden manifest is not valid JSON",
      subjectId: null,
      tasks: [],
      canonicalCatalogJson: "",
    };
  }

  const entries = Array.isArray(manifest?.turns) ? manifest.turns : [];
  if (entries.length > GOLDEN_SCENARIO_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `A P6 golden turns exceed ${GOLDEN_SCENARIO_LIMIT}`,
      subjectId: null,
      tasks: [],
      canonicalCatalogJson: "",
    };
  }

  /** @type {object[]} */
  const tasks = [];

  for (const entry of entries) {
    const file = typeof entry?.file === "string" ? entry.file : "";
    const entryId = typeof entry?.id === "string" ? entry.id : "";
    if (!file || !entryId) {
      emit({
        event: "training.gym.golden_episode",
        outcome: "rejected",
        subjectId: null,
        deviceId,
        action: "compile",
        failureClass: "schema_violation",
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "manifest entry missing id/file",
        subjectId: null,
        tasks: [],
        canonicalCatalogJson: "",
      };
    }
    if (file.includes("..") || path.isAbsolute(file)) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `unsafe golden fixture path: ${file}`,
        subjectId: null,
        tasks: [],
        canonicalCatalogJson: "",
      };
    }

    const abs = path.join(sourceDir, file);
    let raw;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      return {
        ok: false,
        failureClass: "missing_fixture",
        detail: `golden fixture missing: ${file}`,
        subjectId: null,
        tasks: [],
        canonicalCatalogJson: "",
      };
    }

    let source;
    try {
      source = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `golden fixture not JSON: ${file}`,
        subjectId: null,
        tasks: [],
        canonicalCatalogJson: "",
      };
    }

    if (source.id !== entryId) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `manifest id ${entryId} != fixture id ${source.id}`,
        subjectId: null,
        tasks: [],
        canonicalCatalogJson: "",
      };
    }

    const compiled = compileGoldenEpisodeTask(source, { sourceFile: file });
    if (!compiled.ok) {
      emit({
        event: "training.gym.golden_episode",
        outcome: "rejected",
        subjectId: compiled.subjectId,
        deviceId,
        action: "compile",
        failureClass: compiled.failureClass,
      });
      return {
        ok: false,
        failureClass: compiled.failureClass,
        detail: compiled.detail,
        subjectId: compiled.subjectId,
        tasks: [],
        canonicalCatalogJson: "",
      };
    }

    tasks.push(compiled.task);

    emit({
      event: "training.gym.golden_episode",
      outcome: "ok",
      subjectId: compiled.task.subjectId,
      deviceId,
      action: "compile_task",
      scenarioId: compiled.task.scenarioId,
    });
  }

  const catalog = {
    schemaVersion: GYM_GOLDEN_SCHEMA_VERSION,
    sourceRelPath: A_P6_GOLDEN_TURNS_RELPATH,
    fixtureAlias: "fixtures/golden-turns",
    taskCount: tasks.length,
    scenarios: tasks.map((t) => ({
      scenarioId: t.scenarioId,
      sourceId: t.sourceId,
      oracleCheckId: t.oracleCheckId,
      expectedTerminalFrame: t.expectedTerminalFrame,
      subjectId: t.subjectId,
      file: `tasks/${t.sourceId}.json`,
    })),
  };

  const canonicalCatalogJson = canonicalizeGoldenScenarioJson(catalog);

  emit({
    event: "training.gym.golden_episode",
    outcome: "ok",
    subjectId: opts.subjectId ?? null,
    deviceId,
    action: "compile",
    taskCount: tasks.length,
  });

  return {
    ok: true,
    tasks,
    catalog,
    canonicalCatalogJson,
    subjectId: opts.subjectId ?? null,
  };
}

/**
 * Load a compiled golden scenario task by scenarioId (subject-scoped).
 * @param {string} scenarioId
 * @param {{
 *   repoRoot?: string,
 *   subjectId: string,
 *   deviceId?: string,
 *   onTelemetry?: (e: GoldenEpisodeTelemetry) => void,
 * }} opts
 */
export function loadGoldenEpisodeTask(scenarioId, opts) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const deviceId = opts.deviceId ?? "dev-gym-golden-load";
  const subjectId =
    typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";

  if (!subjectId) {
    opts.onTelemetry?.({
      event: "training.gym.golden_episode",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "load",
      failureClass: "missing_subject",
      scenarioId,
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      detail: "subjectId required to load golden episode task",
      subjectId: null,
    };
  }

  const compiled = compileA_P6GoldenEpisodeTasks({
    repoRoot,
    deviceId,
  });
  if (!compiled.ok) {
    opts.onTelemetry?.({
      event: "training.gym.golden_episode",
      outcome: "rejected",
      subjectId,
      deviceId,
      action: "load",
      failureClass: compiled.failureClass,
      scenarioId,
    });
    return {
      ok: false,
      failureClass: compiled.failureClass,
      detail: compiled.detail,
      subjectId,
    };
  }

  const task = compiled.tasks.find((t) => t.scenarioId === scenarioId);
  if (!task) {
    opts.onTelemetry?.({
      event: "training.gym.golden_episode",
      outcome: "rejected",
      subjectId,
      deviceId,
      action: "load",
      failureClass: "missing_fixture",
      scenarioId,
    });
    return {
      ok: false,
      failureClass: "missing_fixture",
      detail: `unknown scenarioId: ${scenarioId}`,
      subjectId,
    };
  }

  if (task.subjectId !== subjectId) {
    opts.onTelemetry?.({
      event: "training.gym.golden_episode",
      outcome: "rejected",
      subjectId,
      deviceId,
      action: "load",
      failureClass: "cross_subject",
      scenarioId,
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      detail: `subjectId ${subjectId} cannot load golden task for ${task.subjectId}`,
      subjectId,
    };
  }

  opts.onTelemetry?.({
    event: "training.gym.golden_episode",
    outcome: "ok",
    subjectId,
    deviceId,
    action: "load",
    scenarioId,
  });

  return {
    ok: true,
    task,
    canonicalJson: canonicalizeGoldenScenarioJson(task),
    subjectId,
  };
}

/**
 * Write or verify committed compiled fixtures under training/gym/scenarios/golden/.
 * Never auto-commits to git — writes working tree only when mode=write.
 *
 * @param {{
 *   repoRoot?: string,
 *   mode?: "write" | "check",
 *   deviceId?: string,
 *   onTelemetry?: (e: GoldenEpisodeTelemetry) => void,
 * }} [opts]
 */
export function materializeGoldenScenarioFixtures(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const mode = opts.mode ?? "check";
  const deviceId = opts.deviceId ?? "dev-gym-golden-materialize";

  const compiled = compileA_P6GoldenEpisodeTasks({
    repoRoot,
    deviceId,
    onTelemetry: opts.onTelemetry,
  });
  if (!compiled.ok) {
    return {
      ok: false,
      failureClass: compiled.failureClass,
      detail: compiled.detail,
      diffs: [],
    };
  }

  const outDir = resolveGoldenScenarioDir(repoRoot);
  const tasksDir = path.join(outDir, "tasks");

  /** @type {{ path: string, expected: string }[]} */
  const planned = [];

  planned.push({
    path: path.join(outDir, "manifest.json"),
    expected: compiled.canonicalCatalogJson,
  });

  for (const task of compiled.tasks) {
    planned.push({
      path: path.join(tasksDir, `${task.sourceId}.json`),
      expected: canonicalizeGoldenScenarioJson(task),
    });
  }

  if (mode === "write") {
    mkdirSync(tasksDir, { recursive: true });
    if (existsSync(tasksDir)) {
      for (const name of readdirSync(tasksDir)) {
        if (!name.endsWith(".json")) continue;
        const keep = compiled.tasks.some((t) => `${t.sourceId}.json` === name);
        if (!keep) {
          rmSync(path.join(tasksDir, name), { force: true });
        }
      }
    }
    for (const file of planned) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.expected, "utf8");
    }
    // README is hand-authored — do not overwrite.
    opts.onTelemetry?.({
      event: "training.gym.golden_episode",
      outcome: "ok",
      subjectId: null,
      deviceId,
      action: "materialize_write",
      taskCount: compiled.tasks.length,
    });
    return {
      ok: true,
      mode: "write",
      taskCount: compiled.tasks.length,
      written: planned.length,
    };
  }

  /** @type {string[]} */
  const diffs = [];
  for (const file of planned) {
    if (!existsSync(file.path)) {
      diffs.push(`missing:${path.relative(repoRoot, file.path)}`);
      continue;
    }
    const actual = readFileSync(file.path, "utf8").replace(/\r\n/g, "\n");
    if (actual !== file.expected) {
      diffs.push(`drift:${path.relative(repoRoot, file.path)}`);
    }
  }

  if (diffs.length > 0) {
    opts.onTelemetry?.({
      event: "training.gym.golden_episode",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "materialize_check",
      failureClass: "canonical_drift",
    });
    return {
      ok: false,
      failureClass: "canonical_drift",
      detail:
        "golden episode fixtures drifted — review and re-run compile with --write (do not auto-commit)",
      diffs,
    };
  }

  opts.onTelemetry?.({
    event: "training.gym.golden_episode",
    outcome: "ok",
    subjectId: null,
    deviceId,
    action: "materialize_check",
    taskCount: compiled.tasks.length,
  });

  return {
    ok: true,
    mode: "check",
    taskCount: compiled.tasks.length,
    checked: planned.length,
  };
}
