/**
 * Compile B8 guidance-eval definitions into gym episode tasks.
 *
 * Source (committed): training/eval/fixtures/b8-guidance/
 * Output (committed): training/gym/scenarios/guidance/
 *
 * Language-neutral JSON only. Regeneration never auto-commits — operators
 * review diffs. Each task declares expectedTerminalFrame + oracleCheckId.
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

/** Repo-relative source of frozen B8 guidance evals. */
export const B8_GUIDANCE_FIXTURE_RELPATH = "training/eval/fixtures/b8-guidance";

/** Repo-relative compiled episode-task tree. */
export const GUIDANCE_SCENARIO_RELPATH = "training/gym/scenarios/guidance";

export const GYM_GUIDANCE_SCHEMA_VERSION = "gym-guidance-episode.v1";

/** Soft caps (NFR). */
export const GUIDANCE_SCENARIO_LIMIT = 64;
export const GUIDANCE_CASE_LIMIT = 64;
export const GUIDANCE_PACK_LIMIT = 32;

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
export function canonicalizeGuidanceJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/**
 * @param {string} [repoRoot]
 */
export function resolveB8GuidanceDir(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, B8_GUIDANCE_FIXTURE_RELPATH);
}

/**
 * @param {string} [repoRoot]
 */
export function resolveGuidanceScenarioDir(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, GUIDANCE_SCENARIO_RELPATH);
}

/**
 * Gym-scoped synthetic subject for a domain pack (never raw learner ids).
 * @param {string} domainPack
 */
export function guidanceSubjectIdForPack(domainPack) {
  return `gym-guidance-${domainPack}`;
}

/**
 * Map B8 guidance definition → verifiable expected outcomes + oracle id.
 * @param {{
 *   id: string,
 *   domainPack: string,
 *   rubric?: { aspect?: string, threshold?: number },
 *   cases?: Array<{ caseId?: string, expect?: string }>,
 * }} source
 */
export function deriveGuidanceOracle(source) {
  const aspect =
    typeof source.rubric?.aspect === "string" && source.rubric.aspect.trim()
      ? source.rubric.aspect.trim()
      : "unspecified";
  const pack = source.domainPack;
  const oracleCheckId = `oracle.guidance.${pack}.${aspect}`;

  /** @type {Array<Record<string, unknown>>} */
  const expectedOutcomes = [];

  if (pack === "teacher" || aspect === "tone" || aspect === "mastery") {
    expectedOutcomes.push({
      kind: "mastery",
      checkId: `${oracleCheckId}.mastery`,
      aspect,
      threshold:
        typeof source.rubric?.threshold === "number"
          ? source.rubric.threshold
          : null,
      verifiable: true,
    });
  }

  if (
    pack === "lawyer" ||
    aspect === "scope_of_practice" ||
    aspect === "citation"
  ) {
    expectedOutcomes.push({
      kind: "citation",
      checkId: `${oracleCheckId}.citation`,
      aspect,
      threshold:
        typeof source.rubric?.threshold === "number"
          ? source.rubric.threshold
          : null,
      verifiable: true,
      /** Lawyer scope refusals are citation/authority gated. */
      requireCitationOnAllow: true,
    });
  }

  // Always attach at least one oracle row so reset()/critics have a check id.
  if (expectedOutcomes.length === 0) {
    expectedOutcomes.push({
      kind: "guidance",
      checkId: oracleCheckId,
      aspect,
      threshold:
        typeof source.rubric?.threshold === "number"
          ? source.rubric.threshold
          : null,
      verifiable: false,
    });
  }

  return { oracleCheckId, expectedOutcomes };
}

/**
 * Compile one B8 guidance JSON object into an episode task (plain JSON).
 * @param {Record<string, unknown>} source
 * @param {{ sourceFile: string }} meta
 */
export function compileGuidanceEpisodeTask(source, meta) {
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const domainPack =
    typeof source.domainPack === "string" ? source.domainPack.trim() : "";
  if (!id) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "guidance source missing id",
      subjectId: null,
    };
  }
  if (!domainPack) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `guidance ${id} missing domainPack`,
      subjectId: null,
    };
  }

  const cases = Array.isArray(source.cases) ? source.cases : [];
  if (cases.length < 1) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `guidance ${id} requires cases[]`,
      subjectId: null,
    };
  }
  if (cases.length > GUIDANCE_CASE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `guidance ${id} cases exceed ${GUIDANCE_CASE_LIMIT}`,
      subjectId: null,
    };
  }

  const subjectId = guidanceSubjectIdForPack(domainPack);
  const { oracleCheckId, expectedOutcomes } = deriveGuidanceOracle(
    /** @type {any} */ (source),
  );

  /** reset() scenario id — language-neutral, pack-scoped. */
  const scenarioId = `guidance/${domainPack}/${id}`;

  const task = {
    schemaVersion: GYM_GUIDANCE_SCHEMA_VERSION,
    scenarioId,
    sourceKind: "b8_guidance",
    sourceRelPath: `${B8_GUIDANCE_FIXTURE_RELPATH}/${meta.sourceFile}`,
    sourceId: id,
    domainPack,
    language: typeof source.language === "string" ? source.language : "en",
    binding: typeof source.binding === "string" ? source.binding : "b8",
    pinnedSeed:
      typeof source.pinnedSeed === "number" && Number.isFinite(source.pinnedSeed)
        ? source.pinnedSeed
        : 0,
    locality: "on-device",
    subjectId,
    deviceId: "gym-guidance-compiler",
    /** Episode ends only on production terminal frames. */
    expectedTerminalFrame: "TURN_COMPLETE",
    oracleCheckId,
    expectedOutcomes,
    rubric:
      source.rubric && typeof source.rubric === "object" ? source.rubric : {},
    cases: cases.map((c) => ({
      caseId: typeof c?.caseId === "string" ? c.caseId : "",
      expect: typeof c?.expect === "string" ? c.expect : "",
    })),
  };

  for (const c of task.cases) {
    if (!c.caseId || !c.expect) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `guidance ${id} case missing caseId/expect`,
        subjectId,
      };
    }
  }

  return { ok: true, task, subjectId };
}

/**
 * @typedef {{
 *   event: "training.gym.guidance_episode",
 *   outcome: "ok" | "rejected" | "start",
 *   subjectId: string | null,
 *   deviceId?: string,
 *   action?: string,
 *   failureClass?: string,
 *   scenarioId?: string,
 *   domainPack?: string,
 *   taskCount?: number,
 * }} GuidanceEpisodeTelemetry
 */

/**
 * Load B8 guidance manifest + scenarios and compile episode tasks.
 * @param {{
 *   repoRoot?: string,
 *   subjectId?: string | null,
 *   deviceId?: string,
 *   onTelemetry?: (e: GuidanceEpisodeTelemetry) => void,
 * }} [opts]
 */
export function compileB8GuidanceEpisodeTasks(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const deviceId = opts.deviceId ?? "dev-gym-guidance-compile";
  /** @type {(e: GuidanceEpisodeTelemetry) => void} */
  const emit = (e) => opts.onTelemetry?.(e);

  emit({
    event: "training.gym.guidance_episode",
    outcome: "start",
    subjectId: opts.subjectId ?? null,
    deviceId,
    action: "compile",
  });

  const sourceDir = resolveB8GuidanceDir(repoRoot);
  const manifestPath = path.join(sourceDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    emit({
      event: "training.gym.guidance_episode",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "compile",
      failureClass: "missing_corpus",
    });
    return {
      ok: false,
      failureClass: "missing_corpus",
      detail: `B8 guidance manifest missing: ${B8_GUIDANCE_FIXTURE_RELPATH}/manifest.json`,
      subjectId: null,
      tasks: [],
      byPack: {},
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
      detail: "B8 guidance manifest is not valid JSON",
      subjectId: null,
      tasks: [],
      byPack: {},
      canonicalCatalogJson: "",
    };
  }

  const entries = Array.isArray(manifest?.scenarios) ? manifest.scenarios : [];
  if (entries.length > GUIDANCE_SCENARIO_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `B8 guidance scenarios exceed ${GUIDANCE_SCENARIO_LIMIT}`,
      subjectId: null,
      tasks: [],
      byPack: {},
      canonicalCatalogJson: "",
    };
  }

  /** @type {object[]} */
  const tasks = [];
  /** @type {Record<string, object[]>} */
  const byPack = {};

  for (const entry of entries) {
    const file = typeof entry?.file === "string" ? entry.file : "";
    const entryId = typeof entry?.id === "string" ? entry.id : "";
    if (!file || !entryId) {
      emit({
        event: "training.gym.guidance_episode",
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
        byPack: {},
        canonicalCatalogJson: "",
      };
    }
    if (file.includes("..") || path.isAbsolute(file)) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `unsafe guidance fixture path: ${file}`,
        subjectId: null,
        tasks: [],
        byPack: {},
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
        detail: `guidance fixture missing: ${file}`,
        subjectId: null,
        tasks: [],
        byPack: {},
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
        detail: `guidance fixture not JSON: ${file}`,
        subjectId: null,
        tasks: [],
        byPack: {},
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
        byPack: {},
        canonicalCatalogJson: "",
      };
    }

    const compiled = compileGuidanceEpisodeTask(source, { sourceFile: file });
    if (!compiled.ok) {
      emit({
        event: "training.gym.guidance_episode",
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
        byPack: {},
        canonicalCatalogJson: "",
      };
    }

    tasks.push(compiled.task);
    const pack = compiled.task.domainPack;
    if (!byPack[pack]) byPack[pack] = [];
    byPack[pack].push(compiled.task);

    emit({
      event: "training.gym.guidance_episode",
      outcome: "ok",
      subjectId: compiled.task.subjectId,
      deviceId,
      action: "compile_task",
      scenarioId: compiled.task.scenarioId,
      domainPack: pack,
    });
  }

  const packKeys = Object.keys(byPack);
  if (packKeys.length > GUIDANCE_PACK_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `domain packs exceed ${GUIDANCE_PACK_LIMIT}`,
      subjectId: null,
      tasks: [],
      byPack: {},
      canonicalCatalogJson: "",
    };
  }

  const catalog = {
    schemaVersion: GYM_GUIDANCE_SCHEMA_VERSION,
    sourceRelPath: B8_GUIDANCE_FIXTURE_RELPATH,
    taskCount: tasks.length,
    domainPacks: packKeys.sort(),
    scenarios: tasks.map((t) => ({
      scenarioId: t.scenarioId,
      sourceId: t.sourceId,
      domainPack: t.domainPack,
      oracleCheckId: t.oracleCheckId,
      expectedTerminalFrame: t.expectedTerminalFrame,
      subjectId: t.subjectId,
      file: `tasks/${t.sourceId}.json`,
    })),
  };

  const canonicalCatalogJson = canonicalizeGuidanceJson(catalog);

  emit({
    event: "training.gym.guidance_episode",
    outcome: "ok",
    subjectId: opts.subjectId ?? null,
    deviceId,
    action: "compile",
    taskCount: tasks.length,
  });

  return {
    ok: true,
    tasks,
    byPack,
    catalog,
    canonicalCatalogJson,
    subjectId: opts.subjectId ?? null,
  };
}

/**
 * Load a compiled episode task by scenarioId (subject-scoped).
 * @param {string} scenarioId
 * @param {{
 *   repoRoot?: string,
 *   subjectId: string,
 *   deviceId?: string,
 *   onTelemetry?: (e: GuidanceEpisodeTelemetry) => void,
 * }} opts
 */
export function loadGuidanceEpisodeTask(scenarioId, opts) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const deviceId = opts.deviceId ?? "dev-gym-guidance-load";
  const subjectId = typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";

  if (!subjectId) {
    opts.onTelemetry?.({
      event: "training.gym.guidance_episode",
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
      detail: "subjectId required to load guidance episode task",
      subjectId: null,
    };
  }

  // Compile without caller telemetry — load owns subject-scoped signals.
  const compiled = compileB8GuidanceEpisodeTasks({
    repoRoot,
    deviceId,
  });
  if (!compiled.ok) {
    opts.onTelemetry?.({
      event: "training.gym.guidance_episode",
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
      event: "training.gym.guidance_episode",
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
      event: "training.gym.guidance_episode",
      outcome: "rejected",
      subjectId,
      deviceId,
      action: "load",
      failureClass: "cross_subject",
      scenarioId,
      domainPack: task.domainPack,
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      detail: `subjectId ${subjectId} cannot load pack-scoped task for ${task.subjectId}`,
      subjectId,
    };
  }

  opts.onTelemetry?.({
    event: "training.gym.guidance_episode",
    outcome: "ok",
    subjectId,
    deviceId,
    action: "load",
    scenarioId,
    domainPack: task.domainPack,
  });

  return {
    ok: true,
    task,
    canonicalJson: canonicalizeGuidanceJson(task),
    subjectId,
  };
}

/**
 * Write or verify committed compiled fixtures under training/gym/scenarios/guidance/.
 * Never auto-commits to git — writes working tree only when mode=write.
 *
 * @param {{
 *   repoRoot?: string,
 *   mode?: "write" | "check",
 *   deviceId?: string,
 *   onTelemetry?: (e: GuidanceEpisodeTelemetry) => void,
 * }} [opts]
 */
export function materializeGuidanceScenarioFixtures(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const mode = opts.mode ?? "check";
  const deviceId = opts.deviceId ?? "dev-gym-guidance-materialize";

  const compiled = compileB8GuidanceEpisodeTasks({
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

  const outDir = resolveGuidanceScenarioDir(repoRoot);
  const tasksDir = path.join(outDir, "tasks");
  const packsDir = path.join(outDir, "by-pack");

  /** @type {{ path: string, expected: string, actual?: string }[]} */
  const planned = [];

  planned.push({
    path: path.join(outDir, "manifest.json"),
    expected: compiled.canonicalCatalogJson,
  });

  for (const task of compiled.tasks) {
    planned.push({
      path: path.join(tasksDir, `${task.sourceId}.json`),
      expected: canonicalizeGuidanceJson(task),
    });
  }

  for (const pack of Object.keys(compiled.byPack).sort()) {
    const packDoc = {
      schemaVersion: GYM_GUIDANCE_SCHEMA_VERSION,
      domainPack: pack,
      subjectId: guidanceSubjectIdForPack(pack),
      scenarioIds: compiled.byPack[pack].map((t) => t.scenarioId).sort(),
      taskCount: compiled.byPack[pack].length,
    };
    planned.push({
      path: path.join(packsDir, `${pack}.json`),
      expected: canonicalizeGuidanceJson(packDoc),
    });
  }

  if (mode === "write") {
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(packsDir, { recursive: true });
    // Drop stale task files (human review of deletion).
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
    opts.onTelemetry?.({
      event: "training.gym.guidance_episode",
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

  // check mode — byte-identical
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
      event: "training.gym.guidance_episode",
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
        "guidance episode fixtures drifted — review and re-run compile with --write (do not auto-commit)",
      diffs,
    };
  }

  opts.onTelemetry?.({
    event: "training.gym.guidance_episode",
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
