/**
 * Integration proof for the contract-mocks conformance CI gate .
 *
 * Operator path:
 *   1. Baseline green (check-mock-conformance gate)
 *   2. Seeded violation (accept-oversized vision) → red with obligation ID + MUST
 *   3. Baseline green again
 *
 * Does not mutate the working tree — the red step is an in-process seeded run.
 *
 * Usage (repo root):
 *   node scripts/prove-mock-conformance-gate.mjs
 *   pnpm mocks:conformance:prove
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/** Obligation id the seeded oversized-vision fixture must fail. */
export const MOCK_SEED_OBLIGATION_ID = "CK-06.1";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "mock.conformance.prove", ...event })}\n`,
  );
}

export async function ensureBuilt() {
  const { ensureMockConformanceBuilt } = await import(
    pathToFileURL(path.join(REPO_ROOT, "scripts/check-mock-conformance.mjs")).href
  );
  ensureMockConformanceBuilt();
}

export async function runBaselineGate() {
  const { runMockConformanceGate } = await import(
    pathToFileURL(path.join(REPO_ROOT, "scripts/check-mock-conformance.mjs")).href
  );
  return runMockConformanceGate();
}

/**
 * Intentionally broken vision harness against the vision registry —
 * must fail with {@link MOCK_SEED_OBLIGATION_ID} visible in the report.
 */
export async function runSeededMockViolation() {
  const confHref = pathToFileURL(
    path.join(REPO_ROOT, "packages/contract-conformance/dist/index.js"),
  ).href;
  const {
    createAcceptOversizedVisionHarnessFactory,
    createVisionObligationsRegistry,
    runConformance,
    formatHumanReport,
    MUST_REJECT_OVERSIZED,
  } = await import(confHref);

  const report = await runConformance({
    registry: createVisionObligationsRegistry(),
    factory: createAcceptOversizedVisionHarnessFactory(),
    subjectId: "subj-prove-mock-conformance-seed",
    deviceId: "dev-prove-mock",
  });

  const human = formatHumanReport(report);
  return {
    status: report.exitCode,
    report,
    human,
    mustText: MUST_REJECT_OVERSIZED,
    combined: human,
  };
}

export async function proveMockConformanceGate() {
  emit({ outcome: "start", phase: "prove" });
  await ensureBuilt();

  const green1 = await runBaselineGate();
  if (green1.status !== 0) {
    throw new Error(
      `MOCK_CONFORMANCE_PROVE_BASELINE_RED:\n${(green1.combined ?? "").slice(0, 4000)}`,
    );
  }
  emit({ outcome: "ok", phase: "baseline.green" });

  const seeded = await runSeededMockViolation();
  if (seeded.status === 0) {
    throw new Error(
      "MOCK_CONFORMANCE_PROVE_SEED_UNEXPECTED_GREEN: accept-oversized vision must fail CK-06.1",
    );
  }
  if (!seeded.combined.includes(MOCK_SEED_OBLIGATION_ID)) {
    throw new Error(
      `MOCK_CONFORMANCE_PROVE_SEED_MISSING_OBLIGATION_ID: expected ${MOCK_SEED_OBLIGATION_ID} in report\n${seeded.combined.slice(0, 2000)}`,
    );
  }
  if (!/MUST/i.test(seeded.combined)) {
    throw new Error(
      `MOCK_CONFORMANCE_PROVE_SEED_MISSING_MUST:\n${seeded.combined.slice(0, 2000)}`,
    );
  }
  // Print the red report so CI logs show obligation IDs loudly.
  process.stdout.write(seeded.combined);
  if (!seeded.combined.endsWith("\n")) process.stdout.write("\n");
  emit({
    outcome: "ok",
    phase: "seeded.red",
    obligationId: MOCK_SEED_OBLIGATION_ID,
  });

  const green2 = await runBaselineGate();
  if (green2.status !== 0) {
    throw new Error(
      `MOCK_CONFORMANCE_PROVE_RESTORE_STILL_RED:\n${(green2.combined ?? "").slice(0, 4000)}`,
    );
  }
  emit({ outcome: "ok", phase: "baseline.green.after-seed" });
  emit({ outcome: "ok", phase: "prove.complete" });
  return { seedObligationId: MOCK_SEED_OBLIGATION_ID };
}

async function main() {
  try {
    await proveMockConformanceGate();
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
