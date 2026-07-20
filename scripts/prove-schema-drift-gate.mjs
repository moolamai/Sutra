/**
 * Integration proof for the schema-drift gate ( / A-G2).
 *
 * Operator path the design requires:
 *   1. Baseline green
 *   2. Seed one unilateral Pydantic field → gate red with unified diff naming it
 *   3. Revert the seed → gate green
 *
 * Always restores contract_models.py (finally), so a mid-run interrupt cannot
 * leave the tree permanently drifted.
 *
 * Usage (repo root):
 *   node scripts/prove-schema-drift-gate.mjs
 *   pnpm schemas:drift:prove
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CONTRACT_MODELS = path.join(
  REPO_ROOT,
  "packages/cloud-orchestrator/src/sutra_orchestrator/contract_models.py",
);

/** Unique field name — must appear in the failing unified diff. */
export const SEED_FIELD = "seedDriftMarker";
const SEED_MARKER = "SCHEMA_DRIFT_SEED";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function runDriftGate() {
  const result = spawnSync(process.execPath, ["scripts/check-schema-drift.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

/**
 * Insert a unilateral Pydantic-only field on SyncAdvisory.
 * Preserves the file's existing newline style (LF / CRLF).
 */
export function seedPydanticDrift(contractPath = CONTRACT_MODELS) {
  const original = readFileSync(contractPath, "utf8");
  if (original.includes(SEED_MARKER)) {
    throw new Error("SCHEMA_DRIFT_PROVE_ALREADY_SEEDED: clean tree before proving");
  }
  const nl = original.includes("\r\n") ? "\r\n" : "\n";
  const seedLine = `    ${SEED_FIELD}: str | None = None  # ${SEED_MARKER} — temporary unilateral drift`;
  const replaced = original.replace(
    /(class SyncAdvisory\(BaseModel\):[\s\S]*?^\s+detail: str)(\r?\n)/m,
    (_m, prefix, nl) => `${prefix}${nl}${seedLine}`,
  );
  if (replaced === original) {
    throw new Error(
      "SCHEMA_DRIFT_PROVE_SEED_FAILED: SyncAdvisory.detail anchor not found",
    );
  }
  writeFileSync(contractPath, replaced, "utf8");
  return original;
}

export function restoreContract(original, contractPath = CONTRACT_MODELS) {
  writeFileSync(contractPath, original, "utf8");
}

/**
 * @returns {{ ok: boolean, phases: object[], failures: string[] }}
 */
export function proveSchemaDriftGate({
  contractPath = CONTRACT_MODELS,
  runGate = runDriftGate,
} = {}) {
  /** @type {object[]} */
  const phases = [];
  /** @type {string[]} */
  const failures = [];
  let original = null;

  emit({ event: "schema.drift.prove", outcome: "start" });

  try {
    // --- Phase A: baseline must be green ---
    const baseline = runGate();
    phases.push({
      phase: "baseline",
      status: baseline.status,
      outcome: baseline.status === 0 ? "ok" : "error",
    });
    emit({
      event: "schema.drift.prove",
      phase: "baseline",
      outcome: baseline.status === 0 ? "ok" : "error",
      exitCode: baseline.status,
    });
    if (baseline.status !== 0) {
      failures.push(
        "BASELINE_NOT_GREEN: gate must pass before seeding drift.\n" +
          baseline.combined,
      );
      return { ok: false, phases, failures };
    }

    // --- Phase B: seed unilateral Pydantic field ---
    original = seedPydanticDrift(contractPath);
    emit({
      event: "schema.drift.prove",
      phase: "seed",
      outcome: "ok",
      field: SEED_FIELD,
    });

    const red = runGate();
    const redHasDiff =
      red.combined.includes("--- ") &&
      red.combined.includes("+++ ") &&
      (red.combined.includes(SEED_FIELD) ||
        red.combined.includes("seedDriftMarker"));
    const redOk = red.status !== 0 && redHasDiff;
    phases.push({
      phase: "seeded-red",
      status: red.status,
      outcome: redOk ? "ok" : "error",
      sawUnifiedDiff: red.combined.includes("--- "),
      sawSeedField: red.combined.includes(SEED_FIELD),
    });
    emit({
      event: "schema.drift.prove",
      phase: "seeded-red",
      outcome: redOk ? "ok" : "error",
      exitCode: red.status,
      sawUnifiedDiff: red.combined.includes("--- "),
      sawSeedField: red.combined.includes(SEED_FIELD),
    });
    if (red.status === 0) {
      failures.push(
        "SEEDED_DRIFT_DID_NOT_FAIL: gate stayed green after unilateral Pydantic field.",
      );
    } else if (!redHasDiff) {
      failures.push(
        "SEEDED_DRIFT_NO_DIFF: gate failed but did not print a unified diff naming " +
          `${SEED_FIELD}.\n` +
          red.combined.slice(0, 4000),
      );
    }

    // --- Phase C: revert ---
    restoreContract(original, contractPath);
    original = null;
    emit({ event: "schema.drift.prove", phase: "revert", outcome: "ok" });

    const green = runGate();
    const greenOk = green.status === 0;
    phases.push({
      phase: "reverted-green",
      status: green.status,
      outcome: greenOk ? "ok" : "error",
    });
    emit({
      event: "schema.drift.prove",
      phase: "reverted-green",
      outcome: greenOk ? "ok" : "error",
      exitCode: green.status,
    });
    if (!greenOk) {
      failures.push(
        "REVERT_NOT_GREEN: gate still failing after restoring contract_models.py.\n" +
          green.combined.slice(0, 4000),
      );
    }

    // Subject-isolation sanity: restored source still names subjectId
    const restored = readFileSync(contractPath, "utf8");
    if (!restored.includes("subjectId")) {
      failures.push(
        "SUBJECT_ISOLATION_BROKEN: restored contract_models.py lost subjectId.",
      );
    }
    if (restored.includes(SEED_MARKER)) {
      failures.push(
        "SEED_LEFT_BEHIND: SCHEMA_DRIFT_SEED marker still present after revert.",
      );
    }

    const ok = failures.length === 0;
    emit({
      event: "schema.drift.prove",
      outcome: ok ? "ok" : "error",
      failureCount: failures.length,
      phases: phases.map((p) => p.phase),
    });
    return { ok, phases, failures, redLog: red.combined, greenLog: green.combined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(message);
    emit({
      event: "schema.drift.prove",
      outcome: "error",
      code: "SCHEMA_DRIFT_PROVE_FAILED",
      message,
    });
    return { ok: false, phases, failures };
  } finally {
    if (original !== null && existsSync(contractPath)) {
      try {
        restoreContract(original, contractPath);
        emit({
          event: "schema.drift.prove",
          phase: "restore-finally",
          outcome: "ok",
        });
      } catch (restoreErr) {
        emit({
          event: "schema.drift.prove",
          phase: "restore-finally",
          outcome: "error",
          message:
            restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
        });
      }
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = proveSchemaDriftGate();
  if (!result.ok) {
    for (const block of result.failures) {
      console.error("\n======== SCHEMA DRIFT PROVE FAILED ========\n");
      console.error(block);
    }
    process.exitCode = 1;
  }
}
