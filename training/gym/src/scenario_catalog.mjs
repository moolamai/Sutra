/**
 * Unified gym scenario catalog — index all golden + guidance scenarios with
 * slice tags; CI smoke runs one seeded episode per slice.
 *
 * Sources (committed):
 *   training/gym/scenarios/golden/manifest.json
 *   training/gym/scenarios/guidance/manifest.json
 * Output (committed):
 *   training/gym/scenarios/catalog.json
 *
 * Language-neutral JSON. Regeneration never auto-commits.
 * Failures always name scenarioId + sliceId.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGuidanceEpisodeTask } from "./guidance_episode_tasks.mjs";
import { GOLDEN_SCENARIO_RELPATH } from "./golden_episode_tasks.mjs";
import { GUIDANCE_SCENARIO_RELPATH } from "./guidance_episode_tasks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GYM_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(GYM_ROOT, "../..");

export const SCENARIO_CATALOG_RELPATH = "training/gym/scenarios/catalog.json";
export const GYM_SCENARIO_CATALOG_SCHEMA = "gym-scenario-catalog.v1";

/** Soft caps (NFR). */
export const CATALOG_SCENARIO_LIMIT = 128;
export const CATALOG_SLICE_LIMIT = 64;

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
export function canonicalizeCatalogJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/**
 * @param {string} [repoRoot]
 */
export function resolveCatalogPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, SCENARIO_CATALOG_RELPATH);
}

/**
 * @param {string} repoRoot
 * @param {string} relDir
 */
function readManifest(repoRoot, relDir) {
  const p = path.join(repoRoot, relDir, "manifest.json");
  if (!existsSync(p)) {
    return {
      ok: false,
      failureClass: "missing_corpus",
      detail: `manifest missing: ${relDir}/manifest.json`,
    };
  }
  try {
    return { ok: true, manifest: JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `manifest not JSON: ${relDir}/manifest.json`,
    };
  }
}

/**
 * Build slice tags for one golden scenario row.
 * @param {{ scenarioId: string, expectedTerminalFrame: string }} row
 */
export function sliceTagsForGolden(row) {
  const terminal = row.expectedTerminalFrame;
  return [
    "a_p6_golden",
    `a_p6_golden.terminal.${terminal}`,
  ];
}

/**
 * Build slice tags for one guidance scenario row.
 * @param {{ scenarioId: string, domainPack?: string, expectedTerminalFrame: string }} row
 */
export function sliceTagsForGuidance(row) {
  const pack =
    typeof row.domainPack === "string" && row.domainPack.trim()
      ? row.domainPack.trim()
      : "unknown";
  return [
    "b8_guidance",
    `b8_guidance.${pack}`,
    `b8_guidance.terminal.${row.expectedTerminalFrame}`,
  ];
}

/**
 * @typedef {{
 *   event: "training.gym.scenario_catalog",
 *   outcome: "ok" | "rejected" | "start",
 *   subjectId: string | null,
 *   deviceId?: string,
 *   action?: string,
 *   failureClass?: string,
 *   scenarioId?: string,
 *   sliceId?: string,
 *   scenarioCount?: number,
 *   sliceCount?: number,
 * }} ScenarioCatalogTelemetry
 */

/**
 * Build unified catalog from committed golden + guidance manifests.
 * @param {{
 *   repoRoot?: string,
 *   deviceId?: string,
 *   onTelemetry?: (e: ScenarioCatalogTelemetry) => void,
 * }} [opts]
 */
export function buildScenarioCatalog(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const deviceId = opts.deviceId ?? "dev-gym-catalog";
  /** @type {(e: ScenarioCatalogTelemetry) => void} */
  const emit = (e) => opts.onTelemetry?.(e);

  emit({
    event: "training.gym.scenario_catalog",
    outcome: "start",
    subjectId: null,
    deviceId,
    action: "build",
  });

  const goldenMan = readManifest(repoRoot, GOLDEN_SCENARIO_RELPATH);
  if (!goldenMan.ok) {
    emit({
      event: "training.gym.scenario_catalog",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "build",
      failureClass: goldenMan.failureClass,
    });
    return {
      ok: false,
      failureClass: goldenMan.failureClass,
      detail: goldenMan.detail,
      catalog: null,
      canonicalJson: "",
    };
  }

  const guidanceMan = readManifest(repoRoot, GUIDANCE_SCENARIO_RELPATH);
  if (!guidanceMan.ok) {
    emit({
      event: "training.gym.scenario_catalog",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "build",
      failureClass: guidanceMan.failureClass,
    });
    return {
      ok: false,
      failureClass: guidanceMan.failureClass,
      detail: guidanceMan.detail,
      catalog: null,
      canonicalJson: "",
    };
  }

  /** @type {object[]} */
  const scenarios = [];

  const goldenRows = Array.isArray(goldenMan.manifest.scenarios)
    ? goldenMan.manifest.scenarios
    : [];
  for (const row of goldenRows) {
    const scenarioId =
      typeof row?.scenarioId === "string" ? row.scenarioId.trim() : "";
    const expectedTerminalFrame =
      typeof row?.expectedTerminalFrame === "string"
        ? row.expectedTerminalFrame
        : "";
    const oracleCheckId =
      typeof row?.oracleCheckId === "string" ? row.oracleCheckId : "";
    const subjectId = typeof row?.subjectId === "string" ? row.subjectId : "";
    if (!scenarioId || !expectedTerminalFrame || !oracleCheckId || !subjectId) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "golden catalog row missing required fields",
        catalog: null,
        canonicalJson: "",
      };
    }
    if (
      !EXPECTED_TERMINAL_FRAMES.includes(
        /** @type {"TURN_COMPLETE"|"HARNESS_ERROR"} */ (expectedTerminalFrame),
      )
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `golden ${scenarioId} invalid expectedTerminalFrame`,
        catalog: null,
        canonicalJson: "",
      };
    }
    scenarios.push({
      scenarioId,
      sourceKind: "a_p6_golden",
      sourceRelPath: `${GOLDEN_SCENARIO_RELPATH}/${row.file ?? ""}`,
      subjectId,
      expectedTerminalFrame,
      oracleCheckId,
      sliceTags: sliceTagsForGolden({ scenarioId, expectedTerminalFrame }),
      smokeKind: "gym_env",
      smokeSeed: 42,
    });
  }

  const guidanceRows = Array.isArray(guidanceMan.manifest.scenarios)
    ? guidanceMan.manifest.scenarios
    : [];
  for (const row of guidanceRows) {
    const scenarioId =
      typeof row?.scenarioId === "string" ? row.scenarioId.trim() : "";
    const expectedTerminalFrame =
      typeof row?.expectedTerminalFrame === "string"
        ? row.expectedTerminalFrame
        : "";
    const oracleCheckId =
      typeof row?.oracleCheckId === "string" ? row.oracleCheckId : "";
    const subjectId = typeof row?.subjectId === "string" ? row.subjectId : "";
    const domainPack =
      typeof row?.domainPack === "string" ? row.domainPack : "";
    if (!scenarioId || !expectedTerminalFrame || !oracleCheckId || !subjectId) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "guidance catalog row missing required fields",
        catalog: null,
        canonicalJson: "",
      };
    }
    // Load pinnedSeed from task file when present.
    let smokeSeed = 0;
    const taskRel =
      typeof row.file === "string"
        ? `${GUIDANCE_SCENARIO_RELPATH}/${row.file}`.replace(/\\/g, "/")
        : "";
    if (taskRel) {
      const abs = path.join(repoRoot, taskRel);
      if (existsSync(abs)) {
        try {
          const task = JSON.parse(readFileSync(abs, "utf8"));
          if (typeof task.pinnedSeed === "number" && Number.isFinite(task.pinnedSeed)) {
            smokeSeed = task.pinnedSeed;
          }
        } catch {
          /* schema checked elsewhere */
        }
      }
    }
    scenarios.push({
      scenarioId,
      sourceKind: "b8_guidance",
      sourceRelPath: taskRel || GUIDANCE_SCENARIO_RELPATH,
      subjectId,
      domainPack,
      expectedTerminalFrame,
      oracleCheckId,
      sliceTags: sliceTagsForGuidance({
        scenarioId,
        domainPack,
        expectedTerminalFrame,
      }),
      smokeKind: "episode_task_load",
      smokeSeed,
    });
  }

  if (scenarios.length > CATALOG_SCENARIO_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `catalog scenarios exceed ${CATALOG_SCENARIO_LIMIT}`,
      catalog: null,
      canonicalJson: "",
    };
  }

  /** @type {Map<string, object[]>} */
  const bySlice = new Map();
  for (const s of scenarios) {
    for (const tag of s.sliceTags) {
      if (!bySlice.has(tag)) bySlice.set(tag, []);
      bySlice.get(tag).push(s);
    }
  }

  if (bySlice.size > CATALOG_SLICE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `catalog slices exceed ${CATALOG_SLICE_LIMIT}`,
      catalog: null,
      canonicalJson: "",
    };
  }

  /** One smoke representative per slice (first scenario, stable sort). */
  const slices = [...bySlice.keys()].sort().map((sliceId) => {
    const members = bySlice.get(sliceId).slice().sort((a, b) =>
      a.scenarioId.localeCompare(b.scenarioId),
    );
    const smoke = members[0];
    return {
      sliceId,
      scenarioCount: members.length,
      scenarioIds: members.map((m) => m.scenarioId),
      smokeScenarioId: smoke.scenarioId,
      smokeKind: smoke.smokeKind,
      smokeSeed: smoke.smokeSeed,
      subjectId: smoke.subjectId,
      expectedTerminalFrame: smoke.expectedTerminalFrame,
      oracleCheckId: smoke.oracleCheckId,
    };
  });

  const catalog = {
    schemaVersion: GYM_SCENARIO_CATALOG_SCHEMA,
    sources: [
      GOLDEN_SCENARIO_RELPATH,
      GUIDANCE_SCENARIO_RELPATH,
      "fixtures/golden-turns",
    ],
    scenarioCount: scenarios.length,
    sliceCount: slices.length,
    scenarios: scenarios
      .slice()
      .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId)),
    slices,
  };

  const canonicalJson = canonicalizeCatalogJson(catalog);

  emit({
    event: "training.gym.scenario_catalog",
    outcome: "ok",
    subjectId: null,
    deviceId,
    action: "build",
    scenarioCount: scenarios.length,
    sliceCount: slices.length,
  });

  return {
    ok: true,
    catalog,
    canonicalJson,
    subjectId: null,
  };
}

/**
 * Write or verify committed catalog.json. Never auto-commits.
 * @param {{
 *   repoRoot?: string,
 *   mode?: "write" | "check",
 *   deviceId?: string,
 *   onTelemetry?: (e: ScenarioCatalogTelemetry) => void,
 * }} [opts]
 */
export function materializeScenarioCatalog(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const mode = opts.mode ?? "check";
  const deviceId = opts.deviceId ?? "dev-gym-catalog-materialize";

  const built = buildScenarioCatalog({
    repoRoot,
    deviceId,
    onTelemetry: opts.onTelemetry,
  });
  if (!built.ok) {
    return {
      ok: false,
      failureClass: built.failureClass,
      detail: built.detail,
      diffs: [],
    };
  }

  const outPath = resolveCatalogPath(repoRoot);

  if (mode === "write") {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, built.canonicalJson, "utf8");
    opts.onTelemetry?.({
      event: "training.gym.scenario_catalog",
      outcome: "ok",
      subjectId: null,
      deviceId,
      action: "materialize_write",
      scenarioCount: built.catalog.scenarioCount,
      sliceCount: built.catalog.sliceCount,
    });
    return {
      ok: true,
      mode: "write",
      scenarioCount: built.catalog.scenarioCount,
      sliceCount: built.catalog.sliceCount,
    };
  }

  if (!existsSync(outPath)) {
    opts.onTelemetry?.({
      event: "training.gym.scenario_catalog",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "materialize_check",
      failureClass: "canonical_drift",
    });
    return {
      ok: false,
      failureClass: "canonical_drift",
      detail: "catalog.json missing — run catalog:write (do not auto-commit)",
      diffs: [`missing:${SCENARIO_CATALOG_RELPATH}`],
    };
  }

  const actual = readFileSync(outPath, "utf8").replace(/\r\n/g, "\n");
  if (actual !== built.canonicalJson) {
    opts.onTelemetry?.({
      event: "training.gym.scenario_catalog",
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
        "catalog.json drifted — review and re-run catalog:write (do not auto-commit)",
      diffs: [`drift:${SCENARIO_CATALOG_RELPATH}`],
    };
  }

  opts.onTelemetry?.({
    event: "training.gym.scenario_catalog",
    outcome: "ok",
    subjectId: null,
    deviceId,
    action: "materialize_check",
    scenarioCount: built.catalog.scenarioCount,
    sliceCount: built.catalog.sliceCount,
  });

  return {
    ok: true,
    mode: "check",
    scenarioCount: built.catalog.scenarioCount,
    sliceCount: built.catalog.sliceCount,
  };
}

/**
 * Load committed catalog (byte-identical source for smoke / consumers).
 * @param {{ repoRoot?: string }} [opts]
 */
export function loadScenarioCatalog(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const p = resolveCatalogPath(repoRoot);
  if (!existsSync(p)) {
    return {
      ok: false,
      failureClass: "missing_corpus",
      detail: `catalog missing: ${SCENARIO_CATALOG_RELPATH}`,
    };
  }
  try {
    const catalog = JSON.parse(readFileSync(p, "utf8"));
    return { ok: true, catalog };
  } catch {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "catalog.json is not valid JSON",
    };
  }
}

/**
 * Format a smoke failure naming scenario id and slice (required by task).
 * @param {{ scenarioId: string, sliceId: string, failureClass: string, detail: string }} f
 */
export function formatSmokeFailure(f) {
  return `scenarioId=${f.scenarioId} slice=${f.sliceId} failureClass=${f.failureClass} — ${f.detail}`;
}

/**
 * Run one seeded smoke episode per catalog slice.
 * - gym_env: GymEnv.reset + golden_replay step (A P6 path)
 * - episode_task_load: subject-scoped guidance task load (oracle present)
 *
 * @param {{
 *   repoRoot?: string,
 *   deviceId?: string,
 *   onTelemetry?: (e: ScenarioCatalogTelemetry) => void,
 *   GymEnv?: typeof import("../env.ts").GymEnv,
 * }} [opts]
 */
export async function runScenarioCatalogSmoke(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const deviceId = opts.deviceId ?? "dev-gym-catalog-smoke";
  /** @type {(e: ScenarioCatalogTelemetry) => void} */
  const emit = (e) => opts.onTelemetry?.(e);

  emit({
    event: "training.gym.scenario_catalog",
    outcome: "start",
    subjectId: null,
    deviceId,
    action: "smoke",
  });

  const loaded = loadScenarioCatalog({ repoRoot });
  if (!loaded.ok) {
    emit({
      event: "training.gym.scenario_catalog",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "smoke",
      failureClass: loaded.failureClass,
    });
    return {
      ok: false,
      failureClass: loaded.failureClass,
      detail: loaded.detail,
      failures: [],
      smoked: 0,
    };
  }

  const slices = Array.isArray(loaded.catalog.slices)
    ? loaded.catalog.slices
    : [];
  if (slices.length === 0) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "catalog has no slices",
      failures: [],
      smoked: 0,
    };
  }
  if (slices.length > CATALOG_SLICE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `smoke slices exceed ${CATALOG_SLICE_LIMIT}`,
      failures: [],
      smoked: 0,
    };
  }

  /** @type {string[]} */
  const failures = [];
  let smoked = 0;

  // Lazy-load GymEnv only when needed (golden slices).
  let GymEnvCtor = opts.GymEnv;
  if (!GymEnvCtor) {
    const mod = await import("../env.ts");
    GymEnvCtor = mod.GymEnv;
  }

  for (const slice of slices) {
    const sliceId = String(slice.sliceId ?? "");
    const scenarioId = String(slice.smokeScenarioId ?? "");
    const subjectId = String(slice.subjectId ?? "");
    const smokeKind = String(slice.smokeKind ?? "");
    const smokeSeed =
      typeof slice.smokeSeed === "number" && Number.isInteger(slice.smokeSeed)
        ? slice.smokeSeed
        : 0;
    const expectedTerminal = String(slice.expectedTerminalFrame ?? "");

    if (!sliceId || !scenarioId || !subjectId) {
      const msg = formatSmokeFailure({
        scenarioId: scenarioId || "(missing)",
        sliceId: sliceId || "(missing)",
        failureClass: "schema_violation",
        detail: "slice missing smokeScenarioId/subjectId/sliceId",
      });
      failures.push(msg);
      emit({
        event: "training.gym.scenario_catalog",
        outcome: "rejected",
        subjectId: subjectId || null,
        deviceId,
        action: "smoke_slice",
        failureClass: "schema_violation",
        scenarioId,
        sliceId,
      });
      continue;
    }

    if (smokeKind === "gym_env") {
      const env = new GymEnvCtor({
        subjectId,
        deviceId,
        onTelemetry: (e) => {
          // Bridge env telemetry without raw content.
          if (e.outcome === "error") {
            emit({
              event: "training.gym.scenario_catalog",
              outcome: "rejected",
              subjectId: e.subjectId,
              deviceId: e.deviceId,
              action: "smoke_slice",
              failureClass: e.failureClass ?? "harness_reject",
              scenarioId,
              sliceId,
            });
          }
        },
      });
      const reset = env.reset(scenarioId, smokeSeed);
      if (!reset.ok) {
        const msg = formatSmokeFailure({
          scenarioId,
          sliceId,
          failureClass: reset.failureClass,
          detail: reset.detail,
        });
        failures.push(msg);
        continue;
      }
      const stepped = await env.step({ path: "golden_replay" });
      if (!stepped.ok) {
        const msg = formatSmokeFailure({
          scenarioId,
          sliceId,
          failureClass: stepped.failureClass,
          detail: stepped.detail,
        });
        failures.push(msg);
        continue;
      }
      if (
        !stepped.terminal ||
        stepped.terminalFrameType !== expectedTerminal
      ) {
        const msg = formatSmokeFailure({
          scenarioId,
          sliceId,
          failureClass: "oracle_mismatch",
          detail: `expected terminal ${expectedTerminal}, got ${String(stepped.terminalFrameType)}`,
        });
        failures.push(msg);
        emit({
          event: "training.gym.scenario_catalog",
          outcome: "rejected",
          subjectId,
          deviceId,
          action: "smoke_slice",
          failureClass: "oracle_mismatch",
          scenarioId,
          sliceId,
        });
        continue;
      }
      smoked += 1;
      emit({
        event: "training.gym.scenario_catalog",
        outcome: "ok",
        subjectId,
        deviceId,
        action: "smoke_slice",
        scenarioId,
        sliceId,
      });
      continue;
    }

    if (smokeKind === "episode_task_load") {
      const loadedTask = loadGuidanceEpisodeTask(scenarioId, {
        repoRoot,
        subjectId,
        deviceId,
      });
      if (!loadedTask.ok) {
        const msg = formatSmokeFailure({
          scenarioId,
          sliceId,
          failureClass: loadedTask.failureClass,
          detail: loadedTask.detail,
        });
        failures.push(msg);
        emit({
          event: "training.gym.scenario_catalog",
          outcome: "rejected",
          subjectId,
          deviceId,
          action: "smoke_slice",
          failureClass: loadedTask.failureClass,
          scenarioId,
          sliceId,
        });
        continue;
      }
      if (
        loadedTask.task.expectedTerminalFrame !== expectedTerminal ||
        !loadedTask.task.oracleCheckId
      ) {
        const msg = formatSmokeFailure({
          scenarioId,
          sliceId,
          failureClass: "oracle_mismatch",
          detail: "guidance task missing terminal/oracle",
        });
        failures.push(msg);
        continue;
      }
      // Seed recorded for future GymEnv wiring; load is the smoke for now.
      void smokeSeed;
      smoked += 1;
      emit({
        event: "training.gym.scenario_catalog",
        outcome: "ok",
        subjectId,
        deviceId,
        action: "smoke_slice",
        scenarioId,
        sliceId,
      });
      continue;
    }

    const msg = formatSmokeFailure({
      scenarioId,
      sliceId,
      failureClass: "config",
      detail: `unknown smokeKind: ${smokeKind}`,
    });
    failures.push(msg);
  }

  if (failures.length > 0) {
    emit({
      event: "training.gym.scenario_catalog",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      action: "smoke",
      failureClass: "smoke_failed",
      sliceCount: slices.length,
    });
    return {
      ok: false,
      failureClass: "smoke_failed",
      detail: failures[0],
      failures,
      smoked,
    };
  }

  emit({
    event: "training.gym.scenario_catalog",
    outcome: "ok",
    subjectId: null,
    deviceId,
    action: "smoke",
    scenarioCount: loaded.catalog.scenarioCount,
    sliceCount: slices.length,
  });

  return {
    ok: true,
    smoked,
    sliceCount: slices.length,
    scenarioCount: loaded.catalog.scenarioCount,
  };
}
