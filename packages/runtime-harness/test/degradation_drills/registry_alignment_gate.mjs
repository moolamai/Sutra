/**
 * CI gate: stubbed degradation drills must match the A P6 registry document
 * (behavior + signal code). On mismatch, print a unified diff and fail loudly.
 *
 * Prove path (green → seed red with diff → restore green):
 *   node packages/runtime-harness/test/degradation_drills/registry_alignment_gate.mjs
 *   pnpm --filter @moolam/runtime-harness run degradation-drills:prove
 *
 * Check-only:
 *   node packages/runtime-harness/test/degradation_drills/registry_alignment_gate.mjs --check
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const PKG_ROOT = path.resolve(__dirname, "../..");
const SEED_OVERRIDE_PATH = path.join(
  __dirname,
  ".expected_signals.seed.json",
);

export const SEED_MARKER = "DEGRADE_SEED_DRIFT_INTENTIONAL";
export const SEED_ROW_ID = "model:read";

/** Locked drill rows — must stay aligned with A P6 DEFAULT bindings + tool write. */
export const DEFAULT_EXPECTED_ROWS = Object.freeze([
  {
    id: "model:read",
    dependency: "model",
    operation: "read",
    expectedBehavior: "queue",
    expectedSignalCode: "DEGRADE_QUEUE_AND_WARN",
  },
  {
    id: "model:write",
    dependency: "model",
    operation: "write",
    expectedBehavior: "hard_stop",
    expectedSignalCode: "DEGRADE_HARD_STOP_WRITE",
  },
  {
    id: "sync:read",
    dependency: "sync",
    operation: "read",
    expectedBehavior: "stale_with_marker",
    expectedSignalCode: "DEGRADE_STALE_READ",
  },
  {
    id: "sync:write",
    dependency: "sync",
    operation: "write",
    expectedBehavior: "hard_stop",
    expectedSignalCode: "DEGRADE_HARD_STOP_WRITE",
  },
  {
    id: "tool:write",
    dependency: "tool",
    operation: "write",
    expectedBehavior: "hard_stop",
    expectedSignalCode: "DEGRADE_HARD_STOP_WRITE",
    register: true,
  },
  {
    id: "storage:read",
    dependency: "storage",
    operation: "read",
    expectedBehavior: "stale_with_marker",
    expectedSignalCode: "DEGRADE_STALE_READ",
  },
  {
    id: "storage:write",
    dependency: "storage",
    operation: "write",
    expectedBehavior: "hard_stop",
    expectedSignalCode: "DEGRADE_HARD_STOP_WRITE",
  },
]);

const REQUIRED_DRILL_FILES = Object.freeze([
  "model_down.test.mjs",
  "sync_down.test.mjs",
  "tool_down.test.mjs",
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "runtime.harness.degradation_drill.gate", ...event })}\n`,
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

export function ensureHarnessBuilt() {
  const dist = path.join(PKG_ROOT, "dist", "index.js");
  if (existsSync(dist) && process.env.CI !== "true") {
    emit({
      outcome: "ok",
      phase: "build.skip",
      reason: "dist-present",
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });
    return;
  }
  const result = run(
    "pnpm",
    ["--filter", "@moolam/runtime-harness", "run", "build"],
    { shell: true },
  );
  if (result.status !== 0 || !existsSync(dist)) {
    throw new Error(
      `DEGRADATION_DRILL_PROVE_BUILD_FAILED:status=${result.status}\n${result.combined.slice(0, 2000)}`,
    );
  }
  emit({
    outcome: "ok",
    phase: "build",
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
}

export function loadExpectedRows() {
  if (existsSync(SEED_OVERRIDE_PATH)) {
    const raw = JSON.parse(readFileSync(SEED_OVERRIDE_PATH, "utf8"));
    if (!Array.isArray(raw.rows)) {
      throw new Error("DEGRADATION_DRILL_SEED_INVALID: rows[] required");
    }
    return raw.rows;
  }
  return DEFAULT_EXPECTED_ROWS.map((r) => ({ ...r }));
}

/** Minimal unified diff for gate logs — never learner content. */
export function formatSignalMismatchDiff(expected, actual, rowId) {
  const expectedJson = `${JSON.stringify(expected, null, 2)}\n`;
  const actualJson = `${JSON.stringify(actual, null, 2)}\n`;
  const fromFile = `degradation-drill/${rowId}.expected.json`;
  const toFile = `degradation-drill/${rowId}.actual.json`;
  const expLines = expectedJson.split("\n");
  const actLines = actualJson.split("\n");
  const body = [];
  const max = Math.max(expLines.length, actLines.length);
  for (let i = 0; i < max; i += 1) {
    const e = expLines[i];
    const a = actLines[i];
    if (e === a) {
      if (e !== undefined) body.push(` ${e}`);
    } else {
      if (e !== undefined) body.push(`-${e}`);
      if (a !== undefined) body.push(`+${a}`);
    }
  }
  return [
    `--- ${fromFile}`,
    `+++ ${toFile}`,
    "@@ registry drill signal @@",
    ...body,
  ].join("\n");
}

export function seedExpectedSignalDrift(overridePath = SEED_OVERRIDE_PATH) {
  if (existsSync(overridePath)) {
    throw new Error(
      "DEGRADATION_DRILL_PROVE_ALREADY_SEEDED: clean tree before proving",
    );
  }
  const rows = DEFAULT_EXPECTED_ROWS.map((r) => ({ ...r }));
  const target = rows.find((r) => r.id === SEED_ROW_ID);
  if (!target) {
    throw new Error(`DEGRADATION_DRILL_PROVE_SEED_FAILED: missing ${SEED_ROW_ID}`);
  }
  target.expectedSignalCode = SEED_MARKER;
  writeFileSync(
    overridePath,
    `${JSON.stringify({ version: "1.0.0", rows }, null, 2)}\n`,
    "utf8",
  );
  return overridePath;
}

export function restoreExpectedSignalSeed(overridePath = SEED_OVERRIDE_PATH) {
  if (existsSync(overridePath)) {
    unlinkSync(overridePath);
  }
}

export async function checkRegistryDrillAlignment(options = {}) {
  const subjectId = options.subjectId ?? "anika-k";
  const deviceId = options.deviceId ?? "ci-gate";
  ensureHarnessBuilt();

  const distHref = pathToFileURL(path.join(PKG_ROOT, "dist", "index.js")).href;
  const {
    loadDegradationRegistry,
    invokeWithDegradation,
    degradationModeToBehavior,
    unifiedDiff,
  } = await import(distHref);

  for (const file of REQUIRED_DRILL_FILES) {
    const full = path.join(__dirname, file);
    if (!existsSync(full)) {
      const detail = `missing drill scenario file: ${file}`;
      emit({
        outcome: "error",
        failureClass: "missing_drill",
        detail,
        subjectId,
        deviceId,
      });
      return { ok: false, failureClass: "missing_drill", detail };
    }
  }

  const loaded = loadDegradationRegistry({ subjectId, deviceId });
  if (!loaded.ok) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: loaded.detail,
    };
  }

  // Registry invariants — never fabricate / never silent write retry.
  for (const [mode, spec] of Object.entries(loaded.registry.document.modes)) {
    if (spec.allowsFabrication !== false || spec.allowsSilentWriteRetry !== false) {
      return {
        ok: false,
        failureClass: "fabrication_forbidden",
        detail: `mode ${mode} must forbid fabrication and silent write retry`,
      };
    }
  }

  // Every A P6 binding row must resolve to the document's mode/signal.
  for (const binding of loaded.registry.document.bindings) {
    const resolved = loaded.registry.resolve({
      dependency: binding.surface,
      operation: binding.operation,
      subjectId,
      deviceId,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        failureClass: "binding_resolve_failed",
        detail: `${binding.surface}:${binding.operation} ${resolved.detail}`,
      };
    }
    const expectedBehavior = degradationModeToBehavior(binding.mode);
    const expectedSignal =
      loaded.registry.document.modes[binding.mode].signalCode;
    if (
      resolved.behavior !== expectedBehavior ||
      resolved.signalCode !== expectedSignal
    ) {
      const expected = {
        dependency: binding.surface,
        operation: binding.operation,
        behavior: expectedBehavior,
        signalCode: expectedSignal,
      };
      const actual = {
        dependency: binding.surface,
        operation: binding.operation,
        behavior: resolved.behavior,
        signalCode: resolved.signalCode,
      };
      const diff =
        typeof unifiedDiff === "function"
          ? unifiedDiff(
              `${JSON.stringify(expected, null, 2)}\n`,
              `${JSON.stringify(actual, null, 2)}\n`,
              {
                fromFile: `degradation-drill/${binding.surface}-${binding.operation}.expected.json`,
                toFile: `degradation-drill/${binding.surface}-${binding.operation}.actual.json`,
              },
            )
          : formatSignalMismatchDiff(
              expected,
              actual,
              `${binding.surface}:${binding.operation}`,
            );
      process.stdout.write(`\n${diff}\n`);
      emit({
        outcome: "error",
        failureClass: "signal_mismatch",
        rowId: `${binding.surface}:${binding.operation}`,
        subjectId,
        deviceId,
      });
      return {
        ok: false,
        failureClass: "signal_mismatch",
        detail: `binding ${binding.surface}:${binding.operation} diverged from registry doc`,
        diff,
      };
    }
  }

  const expectedRows = loadExpectedRows();
  const mismatches = [];

  for (const row of expectedRows) {
    if (row.register) {
      loaded.registry.register(row.dependency, "hard_stop", { subjectId });
    }

    const result = await invokeWithDegradation({
      registry: loaded.registry,
      dependency: row.dependency,
      operation: row.operation,
      subjectId,
      deviceId,
      ...(row.expectedBehavior === "stale_with_marker"
        ? {
            lastKnownGood: { snapshot: "lkg", fabricated: false },
            capturedAt: "2026-07-15T16:00:00.000Z",
            freshnessSource: "last-known-good",
          }
        : {}),
      invoke: async () => {
        const err = new Error(`${row.dependency} unavailable`);
        err.name = "DependencyForcedFailure";
        throw err;
      },
      rollback: async () => {},
      enqueue: async () => {},
    });

    const actualBehavior =
      result.degraded === true ? result.behavior : "(live)";
    const actualSignal =
      result.degraded === true ? result.signalCode : "(none)";

    if (
      actualBehavior !== row.expectedBehavior ||
      actualSignal !== row.expectedSignalCode
    ) {
      const expected = {
        id: row.id,
        dependency: row.dependency,
        operation: row.operation,
        behavior: row.expectedBehavior,
        signalCode: row.expectedSignalCode,
        fabricated: false,
        silentWriteRetry: false,
      };
      const actual = {
        id: row.id,
        dependency: row.dependency,
        operation: row.operation,
        behavior: actualBehavior,
        signalCode: actualSignal,
        fabricated: result.degraded ? result.fabricated : false,
        silentWriteRetry: result.degraded ? result.silentWriteRetry : false,
      };
      const diff =
        typeof unifiedDiff === "function"
          ? unifiedDiff(
              `${JSON.stringify(expected, null, 2)}\n`,
              `${JSON.stringify(actual, null, 2)}\n`,
              {
                fromFile: `degradation-drill/${row.id}.expected.json`,
                toFile: `degradation-drill/${row.id}.actual.json`,
              },
            )
          : formatSignalMismatchDiff(expected, actual, row.id);
      mismatches.push({ rowId: row.id, expected, actual, diff });
      process.stdout.write(`\n${diff}\n`);
    } else if (result.degraded) {
      if (result.fabricated !== false || result.silentWriteRetry !== false) {
        return {
          ok: false,
          failureClass: "fabrication_forbidden",
          detail: `${row.id} must set fabricated=false and silentWriteRetry=false`,
        };
      }
    }
  }

  if (mismatches.length > 0) {
    emit({
      outcome: "error",
      failureClass: "signal_mismatch",
      count: mismatches.length,
      rowId: mismatches[0].rowId,
      subjectId,
      deviceId,
    });
    return {
      ok: false,
      failureClass: "signal_mismatch",
      detail: `${mismatches.length} drill row(s) diverged from registry doc`,
      mismatches,
      diff: mismatches[0].diff,
    };
  }

  emit({
    outcome: "ok",
    phase: "check",
    bindingCount: loaded.registry.document.bindings.length,
    rowCount: expectedRows.length,
    subjectId,
    deviceId,
  });
  return {
    ok: true,
    bindingCount: loaded.registry.document.bindings.length,
    rowCount: expectedRows.length,
    subjectId,
    deviceId,
  };
}

function assertGreen(label, result) {
  if (!result.ok) {
    emit({
      outcome: "error",
      code: "DEGRADATION_DRILL_PROVE_UNEXPECTED_RED",
      phase: label,
      detail: result.detail,
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });
    throw new Error(`DEGRADATION_DRILL_PROVE_UNEXPECTED_RED:${label}`);
  }
  emit({
    outcome: "ok",
    phase: label,
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
}

function assertRedWithDiff(label, result) {
  if (result.ok) {
    emit({
      outcome: "error",
      code: "DEGRADATION_DRILL_PROVE_UNEXPECTED_GREEN",
      phase: label,
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });
    throw new Error(`DEGRADATION_DRILL_PROVE_UNEXPECTED_GREEN:${label}`);
  }
  const blob = `${result.detail ?? ""}\n${result.diff ?? ""}`;
  const hasUnified =
    blob.includes("--- degradation-drill/") &&
    blob.includes("+++ degradation-drill/") &&
    (blob.includes("@@ ") || blob.includes(SEED_MARKER));
  const hasSeed = blob.includes(SEED_MARKER) || blob.includes(SEED_ROW_ID);
  if (!hasUnified || !hasSeed) {
    emit({
      outcome: "error",
      code: "DEGRADATION_DRILL_PROVE_DIFF_MISSING",
      phase: label,
      subjectId: "anika-k",
      deviceId: "ci-gate",
      message: blob.slice(0, 2500),
    });
    throw new Error(
      `DEGRADATION_DRILL_PROVE_DIFF_MISSING:${label} — failing gate must print a unified diff naming the row`,
    );
  }
  emit({
    outcome: "ok",
    phase: label,
    code: "DEGRADATION_DRILL_SIGNAL_DRIFT",
    rowId: SEED_ROW_ID,
    seedVisible: hasSeed,
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
}

export async function proveRegistryDrillGate() {
  ensureHarnessBuilt();
  let seeded = false;
  const phases = [];
  try {
    const green = await checkRegistryDrillAlignment();
    assertGreen("baseline", green);
    phases.push({ phase: "baseline", ok: true });

    seedExpectedSignalDrift();
    seeded = true;
    emit({
      outcome: "ok",
      phase: "seed",
      rowId: SEED_ROW_ID,
      seedMarker: SEED_MARKER,
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });

    const red = await checkRegistryDrillAlignment();
    assertRedWithDiff("seeded-red", red);
    phases.push({ phase: "seeded-red", ok: false });
    process.stdout.write(
      `\n--- degradation-drill seeded-red (excerpt) ---\n${(red.diff ?? red.detail ?? "").slice(0, 4000)}\n---\n`,
    );

    restoreExpectedSignalSeed();
    seeded = false;

    const again = await checkRegistryDrillAlignment();
    assertGreen("reverted-green", again);
    phases.push({ phase: "reverted-green", ok: true });

    emit({
      outcome: "ok",
      phase: "complete",
      phases,
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });
    return { ok: true, phases };
  } finally {
    if (seeded) {
      restoreExpectedSignalSeed();
      emit({
        outcome: "ok",
        phase: "restore-finally",
        subjectId: "anika-k",
        deviceId: "ci-gate",
      });
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const checkOnly = process.argv.includes("--check");
  const run = checkOnly
    ? checkRegistryDrillAlignment().then((r) => {
        if (!r.ok) {
          throw new Error(r.detail ?? "alignment check failed");
        }
        return r;
      })
    : proveRegistryDrillGate();

  run
    .then(() => process.exit(0))
    .catch((err) => {
      emit({
        outcome: "error",
        code: "DEGRADATION_DRILL_GATE_FAILED",
        subjectId: "anika-k",
        deviceId: "ci-gate",
        message:
          err instanceof Error ? err.message.slice(0, 500) : String(err),
      });
      process.exit(1);
    });
}
