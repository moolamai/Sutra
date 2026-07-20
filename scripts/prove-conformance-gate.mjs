/**
 * Integration proof for the contract-conformance CI gate .
 *
 * Operator path:
 *   1. Baseline green (check-conformance gate)
 *   2. Seeded violation (volatile memory) → red with obligation ID + MUST in log
 *   3. Baseline green again
 *
 * Does not mutate the working tree — the red step is an in-process seeded run.
 *
 * Usage (repo root):
 *   node scripts/prove-conformance-gate.mjs
 *   pnpm conformance:prove
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/** Obligation id the seeded volatile memory fixture must fail. */
export const SEED_OBLIGATION_ID = "CK-02.1";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "conformance.prove", ...event })}\n`,
  );
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
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

export async function ensureBuilt() {
  const { ensureConformanceBuilt } = await import(
    pathToFileURL(path.join(REPO_ROOT, "scripts/check-conformance.mjs")).href
  );
  ensureConformanceBuilt();
}

export async function runBaselineGate() {
  const { runConformanceGate } = await import(
    pathToFileURL(path.join(REPO_ROOT, "scripts/check-conformance.mjs")).href
  );
  return runConformanceGate();
}

/**
 * Intentionally broken memory harness against the durability+isolation
 * registry — must fail with {@link SEED_OBLIGATION_ID} visible in JSON report.
 */
export async function runSeededViolation() {
  const dist = pathToFileURL(
    path.join(REPO_ROOT, "packages/contract-conformance/dist/index.js"),
  ).href;
  const {
    createVolatileMemoryHarnessFactory,
    createMemoryDurabilityIsolationRegistry,
    runConformance,
    formatHumanReport,
    MUST_REMEMBER_DURABLE,
  } = await import(dist);

  const report = await runConformance({
    registry: createMemoryDurabilityIsolationRegistry(),
    factory: createVolatileMemoryHarnessFactory(),
    subjectId: "subj-prove-conformance-seed",
    deviceId: "dev-prove",
  });

  const human = formatHumanReport(report);
  return {
    status: report.exitCode,
    report,
    human,
    mustText: MUST_REMEMBER_DURABLE,
    combined: human,
  };
}

export async function proveConformanceGate() {
  emit({ outcome: "start", phase: "prove" });
  await ensureBuilt();

  const green1 = await runBaselineGate();
  if (green1.status !== 0) {
    throw new Error(
      `CONFORMANCE_PROVE_BASELINE_RED:\n${green1.combined.slice(0, 4000)}`,
    );
  }
  emit({ outcome: "ok", phase: "baseline.green" });

  const seeded = await runSeededViolation();
  if (seeded.status === 0) {
    throw new Error(
      "CONFORMANCE_PROVE_SEED_UNEXPECTED_GREEN: volatile memory must fail durability",
    );
  }
  if (!seeded.combined.includes(SEED_OBLIGATION_ID)) {
    throw new Error(
      `CONFORMANCE_PROVE_SEED_MISSING_OBLIGATION_ID: expected ${SEED_OBLIGATION_ID} in report\n${seeded.combined.slice(0, 2000)}`,
    );
  }
  if (!/MUST/i.test(seeded.combined)) {
    throw new Error(
      `CONFORMANCE_PROVE_SEED_MISSING_MUST:\n${seeded.combined.slice(0, 2000)}`,
    );
  }
  // Print the red report so CI logs show obligation IDs loudly.
  process.stdout.write(seeded.combined);
  if (!seeded.combined.endsWith("\n")) process.stdout.write("\n");
  emit({
    outcome: "ok",
    phase: "seeded.red",
    obligationId: SEED_OBLIGATION_ID,
  });

  const green2 = await runBaselineGate();
  if (green2.status !== 0) {
    throw new Error(
      `CONFORMANCE_PROVE_RESTORE_STILL_RED:\n${green2.combined.slice(0, 4000)}`,
    );
  }
  emit({ outcome: "ok", phase: "baseline.green.after-seed" });
  emit({ outcome: "ok", phase: "prove.complete" });
  return { seedObligationId: SEED_OBLIGATION_ID };
}

async function main() {
  try {
    await proveConformanceGate();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

// Keep runNode available for tests that assert CLI wiring without importing prove.
export function runProveViaCli() {
  return runNode(["scripts/prove-conformance-gate.mjs"]);
}
