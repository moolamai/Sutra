/**
 * Integration proof for the golden-turn CI gate.
 *
 * Operator path:
 *   1. Baseline green (golden_turns.test.mjs)
 *   2. Seed wrong expectedFrames delta → red with unified diff in the log
 *   3. Revert the seed → green
 *
 * Always restores the seeded fixture (finally). Never auto-commits.
 *
 * Usage (repo root):
 *   node scripts/prove-golden-turns-gate.mjs
 *   pnpm golden:turns:prove
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SEED_CASE = path.join(
  REPO_ROOT,
  "packages/sync-protocol/fixtures/golden-turns/thought-answer-basic.json",
);
export const SEED_MARKER = "GOLDEN_TURN_SEED_DRIFT";
export const SEED_TURN_ID = "thought-answer-basic";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "golden.turn.prove", ...event })}\n`,
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

/** Build sync-protocol so harness/golden helpers are available. */
export function ensureBuilt() {
  const dist = path.join(
    REPO_ROOT,
    "packages/sync-protocol/dist/golden_turns.js",
  );
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
    ["--filter", "@moolam/sync-protocol", "run", "build"],
    { shell: true },
  );
  if (result.status !== 0 || !existsSync(dist)) {
    throw new Error(
      `GOLDEN_TURN_PROVE_BUILD_FAILED:status=${result.status}\n${result.combined.slice(0, 2000)}`,
    );
  }
  emit({
    outcome: "ok",
    phase: "build",
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
}

export function runGoldenTurns() {
  return run(process.execPath, [
    "--test",
    "packages/sync-protocol/tests/golden_turns.test.mjs",
  ]);
}

/**
 * Force wrong expected ANSWER_DELTA so parser actual ≠ golden expected.
 * Rewrites with canonicalizeGoldenTurn so corpus schema/canonical tests stay
 * green and only the parser-replay assertion turns red (with unified diff).
 * Does not auto-commit. Caller must restore.
 */
export async function seedGoldenTurnDrift(casePath = SEED_CASE) {
  if (!existsSync(casePath)) {
    throw new Error(`GOLDEN_TURN_PROVE_MISSING_CASE: ${casePath}`);
  }
  const original = readFileSync(casePath, "utf8");
  if (original.includes(SEED_MARKER)) {
    throw new Error(
      "GOLDEN_TURN_PROVE_ALREADY_SEEDED: clean tree before proving",
    );
  }
  const distIndex = pathToFileURL(
    path.join(REPO_ROOT, "packages/sync-protocol/dist/index.js"),
  ).href;
  const { canonicalizeGoldenTurn, goldenTurnFixtureSchema } =
    await import(distIndex);
  const parsed = goldenTurnFixtureSchema.parse(JSON.parse(original));
  const answer = parsed.expectedFrames.find((f) => f.type === "ANSWER_DELTA");
  if (!answer || typeof answer.delta !== "string") {
    throw new Error("GOLDEN_TURN_PROVE_SEED_FAILED: ANSWER_DELTA missing");
  }
  answer.delta = `${SEED_MARKER}: intentionally broken expected`;
  writeFileSync(casePath, canonicalizeGoldenTurn(parsed), "utf8");
  return original;
}

export function restoreGoldenTurnCase(original, casePath = SEED_CASE) {
  writeFileSync(casePath, original, "utf8");
}

function assertGreen(label, result) {
  if (result.status !== 0) {
    emit({
      outcome: "error",
      code: "GOLDEN_TURN_PROVE_UNEXPECTED_RED",
      phase: label,
      status: result.status,
      subjectId: "anika-k",
      deviceId: "ci-gate",
      message: result.combined.slice(0, 2000),
    });
    throw new Error(`GOLDEN_TURN_PROVE_UNEXPECTED_RED:${label}`);
  }
  emit({
    outcome: "ok",
    phase: label,
    status: 0,
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
}

function assertRedWithUnifiedDiff(label, result) {
  if (result.status === 0) {
    emit({
      outcome: "error",
      code: "GOLDEN_TURN_PROVE_UNEXPECTED_GREEN",
      phase: label,
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });
    throw new Error(`GOLDEN_TURN_PROVE_UNEXPECTED_GREEN:${label}`);
  }
  const blob = result.combined;
  const hasTurn =
    blob.includes(SEED_TURN_ID) || blob.includes("GOLDEN_TURN_DRIFT");
  const hasUnified =
    blob.includes("--- golden/") &&
    blob.includes("+++ golden/") &&
    blob.includes("@@ ");
  const hasSeed = blob.includes(SEED_MARKER);
  if (!hasTurn || !hasUnified) {
    emit({
      outcome: "error",
      code: "GOLDEN_TURN_PROVE_DIFF_MISSING",
      phase: label,
      subjectId: "anika-k",
      deviceId: "ci-gate",
      message: blob.slice(0, 2500),
    });
    throw new Error(
      `GOLDEN_TURN_PROVE_DIFF_MISSING:${label} — failing gate must name the turn and print a unified diff`,
    );
  }
  emit({
    outcome: "ok",
    phase: label,
    status: result.status,
    code: "GOLDEN_TURN_DRIFT",
    turnId: SEED_TURN_ID,
    seedVisible: hasSeed,
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
}

export async function proveGoldenTurnsGate() {
  ensureBuilt();
  let original = null;
  const phases = [];
  try {
    const green = runGoldenTurns();
    assertGreen("baseline", green);
    phases.push({ phase: "baseline", status: green.status });

    original = await seedGoldenTurnDrift();
    emit({
      outcome: "ok",
      phase: "seed",
      turnId: SEED_TURN_ID,
      seedMarker: SEED_MARKER,
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });

    const red = runGoldenTurns();
    assertRedWithUnifiedDiff("seeded-red", red);
    phases.push({ phase: "seeded-red", status: red.status });
    process.stdout.write(
      `\n--- golden-turns seeded-red (excerpt) ---\n${red.combined.slice(0, 4000)}\n---\n`,
    );

    restoreGoldenTurnCase(original);
    original = null;

    const again = runGoldenTurns();
    assertGreen("reverted-green", again);
    phases.push({ phase: "reverted-green", status: again.status });

    emit({
      outcome: "ok",
      phase: "complete",
      phases,
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });
    return { ok: true, phases };
  } finally {
    if (original !== null) {
      restoreGoldenTurnCase(original);
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
  proveGoldenTurnsGate()
    .then(() => process.exit(0))
    .catch((err) => {
      emit({
        outcome: "error",
        code: "GOLDEN_TURN_PROVE_FAILED",
        subjectId: "anika-k",
        deviceId: "ci-gate",
        message:
          err instanceof Error ? err.message.slice(0, 500) : String(err),
      });
      process.exit(1);
    });
}
