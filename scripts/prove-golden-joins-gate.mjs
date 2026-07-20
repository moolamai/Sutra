/**
 * Integration proof for the cross-language golden-joins gate .
 *
 * Operator path:
 *   1. Baseline green (TS + Python consumers)
 *   2. Seed a unilateral wrong expectedJoin → both consumers red with case id + mismatch
 *   3. Revert the seed → green
 *
 * Always restores the seeded fixture (finally). Never auto-commits.
 *
 * Usage (repo root):
 *   node scripts/prove-golden-joins-gate.mjs
 *   pnpm golden:joins:prove
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SEED_CASE = path.join(
  REPO_ROOT,
  "packages/sync-protocol/fixtures/golden-joins/01-shard-max-basic.json",
);
const SEED_MARKER = "GOLDEN_JOIN_SEED_DRIFT";
export const SEED_MODE = "diagnostic";

function emit(event) {
  process.stdout.write(`${JSON.stringify({ event: "crdt.golden.prove", ...event })}\n`);
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

/** Build sync-protocol so CrdtHarnessResolver is available. */
export function ensureBuilt() {
  const dist = path.join(
    REPO_ROOT,
    "packages/sync-protocol/dist/crdt_harness_resolver.js",
  );
  // Prefer a fresh build in CI; skip only when a local dist already exists.
  if (existsSync(dist) && process.env.CI !== "true") {
    emit({ outcome: "ok", phase: "build.skip", reason: "dist-present" });
    return;
  }
  const result = run(
    "pnpm",
    ["--filter", "@moolam/sync-protocol", "run", "build"],
    { shell: true },
  );
  if (result.status !== 0 || !existsSync(dist)) {
    throw new Error(
      `GOLDEN_JOIN_PROVE_BUILD_FAILED:status=${result.status}\n${result.combined.slice(0, 2000)}`,
    );
  }
  emit({ outcome: "ok", phase: "build" });
}

export function runTsGoldenJoins() {
  return run(process.execPath, [
    "--test",
    "packages/sync-protocol/tests/golden_joins.test.mjs",
  ]);
}

export function runPyGoldenJoins() {
  const orch = path.join(REPO_ROOT, "packages/cloud-orchestrator");
  return run(
    process.platform === "win32" ? "pytest" : "pytest",
    ["-q", "--tb=short", "tests/test_golden_joins.py"],
    {
      cwd: orch,
      shell: process.platform === "win32",
      env: {
        PYTHONPATH: [
          path.join(orch, "src"),
          path.join(orch, "tests"),
          process.env.PYTHONPATH ?? "",
        ]
          .filter(Boolean)
          .join(path.delimiter),
      },
    },
  );
}

/** Force wrong expectedJoin.mode — merge will not produce this value for case 01. */
export function seedGoldenDrift(casePath = SEED_CASE) {
  if (!existsSync(casePath)) {
    throw new Error(`GOLDEN_JOIN_PROVE_MISSING_CASE: ${casePath}`);
  }
  const original = readFileSync(casePath, "utf8");
  if (original.includes(SEED_MARKER)) {
    throw new Error("GOLDEN_JOIN_PROVE_ALREADY_SEEDED: clean tree before proving");
  }
  const parsed = JSON.parse(original);
  if (!parsed.expectedJoin || typeof parsed.expectedJoin !== "object") {
    throw new Error("GOLDEN_JOIN_PROVE_SEED_FAILED: expectedJoin missing");
  }
  parsed.expectedJoin = {
    ...parsed.expectedJoin,
    mode: SEED_MODE,
    _seedMarker: SEED_MARKER,
  };
  if (parsed.canonicalJoin) {
    parsed.canonicalJoin = { ...parsed.canonicalJoin, mode: SEED_MODE };
  }
  writeFileSync(casePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return original;
}

export function restoreGoldenCase(original, casePath = SEED_CASE) {
  writeFileSync(casePath, original, "utf8");
}

function assertGreen(label, result) {
  if (result.status !== 0) {
    emit({
      outcome: "error",
      code: "GOLDEN_JOIN_PROVE_UNEXPECTED_RED",
      phase: label,
      status: result.status,
      message: result.combined.slice(0, 2000),
    });
    throw new Error(`GOLDEN_JOIN_PROVE_UNEXPECTED_RED:${label}`);
  }
  emit({ outcome: "ok", phase: label, status: 0 });
}

function assertRedWithDiff(label, result) {
  if (result.status === 0) {
    emit({
      outcome: "error",
      code: "GOLDEN_JOIN_PROVE_UNEXPECTED_GREEN",
      phase: label,
    });
    throw new Error(`GOLDEN_JOIN_PROVE_UNEXPECTED_GREEN:${label}`);
  }
  const blob = result.combined;
  const hasCase = blob.includes("01-shard-max-basic") || blob.includes("byte mismatch");
  const hasMode =
    blob.includes(SEED_MODE) ||
    blob.includes("exploratory") ||
    blob.includes("GOLDEN_JOIN_MISMATCH");
  if (!hasCase || !hasMode) {
    emit({
      outcome: "error",
      code: "GOLDEN_JOIN_PROVE_DIFF_MISSING",
      phase: label,
      message: blob.slice(0, 2500),
    });
    throw new Error(
      `GOLDEN_JOIN_PROVE_DIFF_MISSING:${label} — failing gate must name the case and show the mismatch`,
    );
  }
  emit({
    outcome: "ok",
    phase: label,
    status: result.status,
    code: "GOLDEN_JOIN_MISMATCH",
    caseId: "01-shard-max-basic",
  });
}

export function proveGoldenJoinsGate() {
  ensureBuilt();
  let original = null;
  const phases = [];
  try {
    const tsGreen = runTsGoldenJoins();
    assertGreen("baseline.ts", tsGreen);
    phases.push({ phase: "baseline.ts", status: tsGreen.status });

    const pyGreen = runPyGoldenJoins();
    assertGreen("baseline.py", pyGreen);
    phases.push({ phase: "baseline.py", status: pyGreen.status });

    original = seedGoldenDrift();
    emit({
      outcome: "ok",
      phase: "seed",
      caseId: "01-shard-max-basic",
      seedMode: SEED_MODE,
    });

    const tsRed = runTsGoldenJoins();
    assertRedWithDiff("seeded-red.ts", tsRed);
    phases.push({ phase: "seeded-red.ts", status: tsRed.status });
    // Loud mismatch surface for CI logs (bounded).
    process.stdout.write(
      `\n--- golden-joins seeded-red.ts (excerpt) ---\n${tsRed.combined.slice(0, 3500)}\n---\n`,
    );

    const pyRed = runPyGoldenJoins();
    assertRedWithDiff("seeded-red.py", pyRed);
    phases.push({ phase: "seeded-red.py", status: pyRed.status });
    process.stdout.write(
      `\n--- golden-joins seeded-red.py (excerpt) ---\n${pyRed.combined.slice(0, 3500)}\n---\n`,
    );

    restoreGoldenCase(original);
    original = null;

    const tsAgain = runTsGoldenJoins();
    assertGreen("reverted-green.ts", tsAgain);
    phases.push({ phase: "reverted-green.ts", status: tsAgain.status });

    const pyAgain = runPyGoldenJoins();
    assertGreen("reverted-green.py", pyAgain);
    phases.push({ phase: "reverted-green.py", status: pyAgain.status });

    emit({ outcome: "ok", phase: "complete", phases });
    return { ok: true, phases };
  } finally {
    if (original !== null) {
      restoreGoldenCase(original);
      emit({ outcome: "ok", phase: "restore-finally" });
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    proveGoldenJoinsGate();
    process.exit(0);
  } catch (err) {
    emit({
      outcome: "error",
      code: "GOLDEN_JOIN_PROVE_FAILED",
      message: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
    process.exit(1);
  }
}
