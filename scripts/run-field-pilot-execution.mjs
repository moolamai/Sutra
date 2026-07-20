/**
 * Field pilot execution — two-week device-matrix integration proof.
 *
 * Simulates the operator path from docs/pilot/FIELD-PILOT-KIT.md:
 *   - android-mid + apple-silicon collectors (write-ahead friction)
 *   - daily bounded friction review
 *   - compare observed routing to guidance-eval expectations
 *   - validate dated findings under docs/pilot/findings/
 *
 * Usage (repo root, after pnpm build):
 *   node scripts/run-field-pilot-execution.mjs
 *   pnpm field-pilot:execute
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const FINDINGS_DIR = path.join(REPO_ROOT, "docs", "pilot", "findings");
export const KIT_DOC = path.join(REPO_ROOT, "docs", "pilot", "FIELD-PILOT-KIT.md");
export const GUIDANCE_SCENARIOS_DIR = path.join(
  REPO_ROOT,
  "evals",
  "guidance",
  "scenarios",
  "teacher",
);
export const GUIDANCE_MANIFEST = path.join(GUIDANCE_SCENARIOS_DIR, "manifest.json");

export const PILOT_DAYS = 14;

/** Minimum device matrix for a valid pilot window (kit §1). */
export const DEVICE_MATRIX = Object.freeze([
  {
    profile: "android-mid",
    deviceId: "dev-android-mid-01",
    subjectId: "subj.pilot.learner.a1",
    /** Offline for entire window — sync gap finding. */
    syncAllowed: false,
  },
  {
    profile: "apple-silicon",
    deviceId: "dev-apple-silicon-01",
    subjectId: "subj.pilot.learner.b2",
    syncAllowed: true,
  },
]);

export const OBLIGATIONS = Object.freeze({
  MISSING_FINDINGS: "field_pilot.exec.missing_findings",
  FINDING_SHAPE: "field_pilot.exec.finding_shape",
  PRIVACY: "field_pilot.exec.privacy",
  SUBJECT_SCOPE: "field_pilot.exec.subject_isolation",
  MATRIX: "field_pilot.exec.device_matrix",
  SYNC_GAP: "field_pilot.exec.sync_gap",
  STT_FINDING: "field_pilot.exec.stt_finding",
  ROUTING: "field_pilot.exec.routing_parity",
  TRAJECTORY: "field_pilot.exec.trajectory_forbidden",
  CONCURRENT: "field_pilot.exec.concurrent_subject",
  RESTART: "field_pilot.exec.restart_survival",
  IDEMPOTENT: "field_pilot.exec.idempotent_sync",
  MISSING_KIT: "field_pilot.exec.missing_kit",
  TELEMETRY: "field_pilot.exec.telemetry_unavailable",
});

const DAY_MS = 86_400_000;
const PILOT_START_MS = Date.UTC(2026, 6, 2, 9, 0, 0); // 2026-07-02

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "field_pilot.execution", ...event })}\n`,
  );
}

/** Minimal in-memory StorageDriver matching collector tests. */
export function memoryDriver() {
  const rows = new Map();
  return {
    rows,
    async execute(sql, params = []) {
      if (sql.startsWith("CREATE")) return;
      if (sql.includes("INSERT")) {
        if (!rows.has(params[0])) {
          rows.set(params[0], {
            captured_at: params[0],
            concept_id: params[1],
            hesitation_ms: params[2],
            input_velocity: params[3],
            revision_count: params[4],
            assistance_requested: params[5],
            outcome: params[6],
            synced: 0,
          });
        }
        return;
      }
      if (sql.includes("UPDATE")) {
        const row = rows.get(params[0]);
        if (row) row.synced = 1;
      }
    },
    async query(sql) {
      if (typeof sql === "string" && sql.includes("COUNT(*)")) {
        if (sql.includes("synced = 0")) {
          return [{ n: [...rows.values()].filter((r) => r.synced === 0).length }];
        }
        return [{ n: rows.size }];
      }
      if (
        typeof sql === "string" &&
        /LIMIT\s+\d+/i.test(sql) &&
        sql.includes("captured_at")
      ) {
        const sorted = [...rows.values()].sort((a, b) =>
          a.captured_at < b.captured_at ? -1 : 1,
        );
        if (sorted.length === 0) return [];
        const row = /DESC/i.test(sql) ? sorted[sorted.length - 1] : sorted[0];
        return [{ captured_at: row.captured_at }];
      }
      return [...rows.values()]
        .filter((r) => r.synced === 0)
        .sort((a, b) => (a.captured_at < b.captured_at ? -1 : 1));
    },
  };
}

/**
 * Clone durable rows into a fresh driver (restart survival).
 * @param {ReturnType<typeof memoryDriver>} source
 */
export function cloneDriverState(source) {
  const next = memoryDriver();
  for (const [k, v] of source.rows) {
    next.rows.set(k, { ...v });
  }
  return next;
}

export function listFindingsFiles(dir = FINDINGS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}-.+\.md$/u.test(name))
    .sort();
}

/**
 * Validate dated findings under docs/pilot/findings/.
 * @returns {{ ok: boolean, failures: string[], files: string[] }}
 */
export function validatePilotFindings({ findingsDir = FINDINGS_DIR } = {}) {
  /** @type {string[]} */
  const failures = [];
  const files = listFindingsFiles(findingsDir);

  if (files.length === 0) {
    failures.push(`${OBLIGATIONS.MISSING_FINDINGS}: no YYYY-MM-DD-*.md under findings/`);
    return { ok: false, failures, files };
  }

  let sawSyncGap = false;
  let sawStt = false;
  let sawRouting = false;
  let blob = "";

  for (const name of files) {
    const body = readFileSync(path.join(findingsDir, name), "utf8");
    blob += `\n${body}`;
    if (!/subjectId/i.test(body) || !/deviceId/i.test(body)) {
      failures.push(
        `${OBLIGATIONS.SUBJECT_SCOPE}: ${name} must scope by subjectId and deviceId`,
      );
    }
    if (!/behavioral metadata|never raw keystroke|no raw/i.test(body)) {
      failures.push(`${OBLIGATIONS.PRIVACY}: ${name} must state no raw content export`);
    }
    if (/trajectoryExport["']?\s*:\s*true/i.test(body)) {
      failures.push(`${OBLIGATIONS.TRAJECTORY}: ${name} must not enable trajectoryExport`);
    }
    if (/sync.?gap|synced\s*=\s*0|offline/i.test(body)) sawSyncGap = true;
    if (/stt|classroom.?noise|Indic/i.test(body)) sawStt = true;
    if (/guidance|routeAction|routing/i.test(body)) sawRouting = true;
  }

  if (/utterance body|raw keystroke content\s*[:=]/i.test(blob) &&
    !/never|no raw|forbidden/i.test(blob)) {
    failures.push(`${OBLIGATIONS.PRIVACY}: findings must not embed utterance bodies`);
  }

  if (!sawSyncGap) {
    failures.push(
      `${OBLIGATIONS.SYNC_GAP}: findings must note offline sync gap (synced=0 persist)`,
    );
  }
  if (!sawStt) {
    failures.push(
      `${OBLIGATIONS.STT_FINDING}: findings must record STT classroom-noise anomaly`,
    );
  }
  if (!sawRouting) {
    failures.push(
      `${OBLIGATIONS.ROUTING}: findings must record routing vs guidance-eval review`,
    );
  }

  const ok = failures.length === 0;
  emit({
    outcome: ok ? "ok" : "fail",
    phase: "findings_validate",
    subjectId: "field-pilot-exec",
    deviceId: "ci",
    failureClass: ok ? undefined : failures[0]?.split(":")[0],
    failureCount: failures.length,
    findingCount: files.length,
  });
  return { ok, failures, files };
}

/**
 * Load teacher guidance scenarios (expected routes).
 */
export function loadGuidanceExpectations({
  manifestPath = GUIDANCE_MANIFEST,
  scenariosDir = GUIDANCE_SCENARIOS_DIR,
} = {}) {
  if (!existsSync(manifestPath)) {
    throw Object.assign(new Error(`guidance manifest missing: ${manifestPath}`), {
      obligation: OBLIGATIONS.ROUTING,
    });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const scenarios = [];
  for (const rel of manifest.scenarios ?? []) {
    const abs = path.join(scenariosDir, "..", rel);
    const alt = path.join(path.dirname(manifestPath), path.basename(rel));
    const file = existsSync(abs) ? abs : alt;
    if (!existsSync(file)) {
      throw Object.assign(new Error(`scenario missing: ${rel}`), {
        obligation: OBLIGATIONS.ROUTING,
      });
    }
    scenarios.push(JSON.parse(readFileSync(file, "utf8")));
  }
  return scenarios;
}

/**
 * Compare observed routing (router_actual) to guidance-eval expectations.
 * @param {{ routerActualFromScenario?: Function, maxScenarios?: number }} [opts]
 */
export async function compareRoutingToGuidanceEvals(opts = {}) {
  const scenarios = loadGuidanceExpectations();
  const max = opts.maxScenarios ?? scenarios.length;
  const slice = scenarios.slice(0, max);

  let routerActualFromScenario = opts.routerActualFromScenario;
  if (!routerActualFromScenario) {
    const modPath = path.join(
      REPO_ROOT,
      "evals",
      "guidance",
      "src",
      "router_actual.mjs",
    );
    const mod = await import(pathToFileURL(modPath).href);
    routerActualFromScenario = mod.routerActualFromScenario;
  }

  /** @type {{ scenarioId: string, expected: string, observed: string, ok: boolean }[]} */
  const results = [];
  /** @type {string[]} */
  const anomalies = [];

  for (const scenario of slice) {
    const actual = routerActualFromScenario(scenario);
    const expectedAction = scenario.expected?.routeAction;
    const observedAction = actual?.routeAction;
    const ok = expectedAction === observedAction;
    results.push({
      scenarioId: scenario.scenarioId,
      expected: expectedAction,
      observed: observedAction,
      ok,
    });
    emit({
      outcome: ok ? "ok" : "fail",
      phase: "routing_compare",
      subjectId: scenario.subjectId ?? "field-pilot-exec",
      deviceId: scenario.deviceId ?? "ci",
      scenarioId: scenario.scenarioId,
      expected: expectedAction,
      observed: observedAction,
      failureClass: ok ? undefined : OBLIGATIONS.ROUTING,
    });
    if (!ok) {
      anomalies.push(
        `${OBLIGATIONS.ROUTING}: ${scenario.scenarioId} expected=${expectedAction} observed=${observedAction}`,
      );
    }
  }

  return {
    ok: anomalies.length === 0,
    anomalies,
    results,
    compared: results.length,
  };
}

async function loadCollectorDeps() {
  const telemetryPath = path.join(REPO_ROOT, "packages", "telemetry", "dist", "index.js");
  const syncPath = path.join(REPO_ROOT, "packages", "sync-protocol", "dist", "index.js");
  if (!existsSync(telemetryPath) || !existsSync(syncPath)) {
    throw Object.assign(
      new Error("telemetry/sync-protocol dist missing — run pnpm build"),
      { obligation: OBLIGATIONS.TELEMETRY },
    );
  }
  const [{ CognitiveTelemetryCollector }, { HlcClock }] = await Promise.all([
    import(pathToFileURL(telemetryPath).href),
    import(pathToFileURL(syncPath).href),
  ]);
  return { CognitiveTelemetryCollector, HlcClock };
}

/**
 * Reject concurrent collectors that share subjectId across devices.
 */
export function assertSubjectDeviceIsolation(matrix = DEVICE_MATRIX) {
  const bySubject = new Map();
  for (const d of matrix) {
    if (bySubject.has(d.subjectId) && bySubject.get(d.subjectId) !== d.deviceId) {
      const err = new Error(
        `cross-device subjectId ${d.subjectId} is forbidden (devices ${bySubject.get(d.subjectId)} vs ${d.deviceId})`,
      );
      err.obligation = OBLIGATIONS.CONCURRENT;
      throw err;
    }
    bySubject.set(d.subjectId, d.deviceId);
  }
  const profiles = new Set(matrix.map((d) => d.profile));
  if (!profiles.has("android-mid") || !profiles.has("apple-silicon")) {
    const err = new Error("pilot matrix must include android-mid and apple-silicon");
    err.obligation = OBLIGATIONS.MATRIX;
    throw err;
  }
}

/**
 * Execute the two-week pilot window (deterministic, injectable clock).
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   failures: string[],
 *   dayReviews: object[],
 *   syncGaps: object[],
 *   routing: object,
 *   findings: ReturnType<typeof validatePilotFindings>,
 *   restart: { ok: boolean, unsyncedAfterRestart: number },
 *   idempotent: { ok: boolean },
 * }>}
 */
export async function executeFieldPilotWindow(opts = {}) {
  /** @type {string[]} */
  const failures = [];
  const days = opts.days ?? PILOT_DAYS;
  const matrix = opts.matrix ?? DEVICE_MATRIX;
  const findingsDir = opts.findingsDir ?? FINDINGS_DIR;
  const skipRouting = opts.skipRouting === true;
  const skipFindings = opts.skipFindings === true;

  if (!existsSync(opts.kitPath ?? KIT_DOC)) {
    failures.push(`${OBLIGATIONS.MISSING_KIT}: FIELD-PILOT-KIT.md required`);
  }

  try {
    assertSubjectDeviceIsolation(matrix);
  } catch (e) {
    failures.push(`${e.obligation ?? OBLIGATIONS.CONCURRENT}: ${e.message}`);
  }

  const { CognitiveTelemetryCollector, HlcClock } = opts.deps ?? (await loadCollectorDeps());

  let wallMs = opts.startMs ?? PILOT_START_MS;
  const nowMs = () => wallMs;

  /** @type {{ device: object, driver: ReturnType<typeof memoryDriver>, collector: InstanceType<typeof CognitiveTelemetryCollector> }[]} */
  const hosts = [];
  for (const device of matrix) {
    const driver = memoryDriver();
    const collector = new CognitiveTelemetryCollector(
      driver,
      new HlcClock(device.deviceId, nowMs),
      { nowMs },
    );
    await collector.initialize();
    hosts.push({ device, driver, collector });
  }

  /** @type {object[]} */
  const dayReviews = [];
  /** @type {object[]} */
  const syncGaps = [];

  for (let day = 1; day <= days; day++) {
    for (const host of hosts) {
      const { device, collector } = host;
      const t0 = wallMs;
      collector.observe({
        type: "prompt-rendered",
        conceptId: "math.fractions",
        atMs: t0,
      });
      collector.observe({ type: "input", charsDelta: 8, atMs: t0 + 400 });
      if (day % 5 === 0) {
        collector.observe({ type: "assistance-requested", atMs: t0 + 600 });
      }
      const sample = await collector.submitted(
        day % 7 === 0 ? "partial" : "correct",
        t0 + 1200,
      );
      if (!sample) {
        failures.push(
          `${OBLIGATIONS.TELEMETRY}: no sample day=${day} device=${device.deviceId}`,
        );
      }

      const probe = await collector.castIntegrityProbe();
      const review = {
        day,
        subjectId: device.subjectId,
        deviceId: device.deviceId,
        profile: device.profile,
        durableCount: probe.durableCount,
        unsyncedCount: probe.unsyncedCount,
      };
      dayReviews.push(review);
      emit({
        outcome: "ok",
        phase: "day_review",
        subjectId: device.subjectId,
        deviceId: device.deviceId,
        day,
        durableCount: probe.durableCount,
        unsyncedCount: probe.unsyncedCount,
      });

      if (device.syncAllowed) {
        const pending = await collector.unsynced();
        const stamps = pending.map((s) => s.capturedAt);
        await collector.markSynced(stamps);
        // Idempotent replay
        await collector.markSynced(stamps);
        const after = await collector.unsynced();
        if (after.length !== 0) {
          failures.push(
            `${OBLIGATIONS.IDEMPOTENT}: markSynced left unsynced on ${device.deviceId}`,
          );
        }
      } else {
        syncGaps.push({
          day,
          subjectId: device.subjectId,
          deviceId: device.deviceId,
          unsyncedCount: probe.unsyncedCount,
        });
        emit({
          outcome: "advisory",
          phase: "sync_gap",
          failureClass: OBLIGATIONS.SYNC_GAP,
          subjectId: device.subjectId,
          deviceId: device.deviceId,
          day,
          unsyncedCount: probe.unsyncedCount,
        });
      }
    }
    wallMs += DAY_MS;
  }

  // Restart survival: clone offline device store, re-init, unsynced must remain.
  const offlineHost = hosts.find((h) => !h.device.syncAllowed) ?? hosts[0];
  const restartedDriver = cloneDriverState(offlineHost.driver);
  const restarted = new CognitiveTelemetryCollector(
    restartedDriver,
    new HlcClock(`${offlineHost.device.deviceId}-restart`, nowMs),
    { nowMs },
  );
  await restarted.initialize();
  const unsyncedAfterRestart = (await restarted.unsynced()).length;
  const restartOk = unsyncedAfterRestart > 0;
  if (!restartOk) {
    failures.push(
      `${OBLIGATIONS.RESTART}: write-ahead samples must survive restart with synced=0`,
    );
  }
  emit({
    outcome: restartOk ? "ok" : "fail",
    phase: "restart_survival",
    subjectId: offlineHost.device.subjectId,
    deviceId: offlineHost.device.deviceId,
    unsyncedAfterRestart,
    failureClass: restartOk ? undefined : OBLIGATIONS.RESTART,
  });

  // Partial failure: open window then abandon (no submitted) → no durable poison.
  const partialDriver = memoryDriver();
  const partial = new CognitiveTelemetryCollector(
    partialDriver,
    new HlcClock("partial-abort", nowMs),
    { nowMs },
  );
  await partial.initialize();
  partial.observe({
    type: "prompt-rendered",
    conceptId: "math.ratios",
    atMs: wallMs,
  });
  partial.observe({ type: "input", charsDelta: 3, atMs: wallMs + 100 });
  // abandon without submitted
  const partialCount = await partial.durableSampleCount();
  if (partialCount !== 0) {
    failures.push(
      `${OBLIGATIONS.TELEMETRY}: half-open exercise must not leave durable sample`,
    );
  }

  let routing = { ok: true, anomalies: [], results: [], compared: 0 };
  if (!skipRouting) {
    try {
      routing = await compareRoutingToGuidanceEvals({
        routerActualFromScenario: opts.routerActualFromScenario,
        maxScenarios: opts.maxScenarios,
      });
      if (!routing.ok) {
        failures.push(...routing.anomalies);
      }
    } catch (e) {
      failures.push(
        `${e.obligation ?? OBLIGATIONS.ROUTING}: ${e.message ?? String(e)}`,
      );
      routing = { ok: false, anomalies: failures.slice(-1), results: [], compared: 0 };
    }
  }

  const findings = skipFindings
    ? { ok: true, failures: [], files: [] }
    : validatePilotFindings({ findingsDir });
  if (!findings.ok) {
    failures.push(...findings.failures);
  }

  if (syncGaps.length === 0) {
    failures.push(
      `${OBLIGATIONS.SYNC_GAP}: pilot must leave at least one device unsynced for the window`,
    );
  }

  const ok = failures.length === 0;
  emit({
    outcome: ok ? "ok" : "fail",
    phase: "window_complete",
    subjectId: "field-pilot-exec",
    deviceId: "ci",
    days,
    devices: matrix.length,
    dayReviewCount: dayReviews.length,
    syncGapDays: syncGaps.length,
    routingCompared: routing.compared,
    findingCount: findings.files?.length ?? 0,
    failureCount: failures.length,
    failureClass: ok ? undefined : failures[0]?.split(":")[0],
  });

  return {
    ok,
    failures,
    dayReviews,
    syncGaps,
    routing,
    findings,
    restart: { ok: restartOk, unsyncedAfterRestart },
    idempotent: { ok: !failures.some((f) => f.includes(OBLIGATIONS.IDEMPOTENT)) },
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = await executeFieldPilotWindow();
  if (!result.ok) {
    for (const f of result.failures) {
      console.error(f);
    }
    process.exitCode = 1;
  }
}
