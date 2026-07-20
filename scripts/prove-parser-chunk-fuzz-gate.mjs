/**
 * Integration proof for the parser chunk-boundary fuzz CI gate.
 *
 * Operator path:
 *   1. Baseline green (golden_turn_chunk_fuzz.test.mjs)
 *   2. Seed PARSER_CHUNK_FUZZ_SEED_DRIFT=1 → red with unified diff in the log
 *   3. Clear seed → green
 *
 * Never auto-commits. Usage (repo root):
 *   node scripts/prove-parser-chunk-fuzz-gate.mjs
 *   pnpm golden:fuzz:prove
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const SEED_MARKER = "PARSER_CHUNK_FUZZ_SEED_DRIFT";
export const SEED_ENV = "PARSER_CHUNK_FUZZ_SEED_DRIFT";
export const FUZZ_TEST =
  "packages/runtime-harness/tests/golden_turn_chunk_fuzz.test.mjs";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "parser.chunk_fuzz.prove", ...event })}\n`,
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

/** Build runtime-harness (+ sync-protocol) so dist fuzz helpers exist. */
export function ensureBuilt() {
  const dist = path.join(
    REPO_ROOT,
    "packages/runtime-harness/dist/chunk_boundary_fuzz.js",
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
    ["--filter", "@moolam/runtime-harness", "run", "build"],
    { shell: true },
  );
  if (result.status !== 0 || !existsSync(dist)) {
    throw new Error(
      `PARSER_CHUNK_FUZZ_PROVE_BUILD_FAILED:status=${result.status}\n${result.combined.slice(0, 2000)}`,
    );
  }
  emit({
    outcome: "ok",
    phase: "build",
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
}

export function runChunkFuzz(env = {}) {
  return run(process.execPath, ["--test", FUZZ_TEST], { env });
}

function assertGreen(label, result) {
  if (result.status !== 0) {
    emit({
      outcome: "error",
      code: "PARSER_CHUNK_FUZZ_PROVE_UNEXPECTED_RED",
      phase: label,
      status: result.status,
      subjectId: "anika-k",
      deviceId: "ci-gate",
      message: result.combined.slice(0, 2000),
    });
    throw new Error(`PARSER_CHUNK_FUZZ_PROVE_UNEXPECTED_RED:${label}`);
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
      code: "PARSER_CHUNK_FUZZ_PROVE_UNEXPECTED_GREEN",
      phase: label,
      subjectId: "anika-k",
      deviceId: "ci-gate",
    });
    throw new Error(`PARSER_CHUNK_FUZZ_PROVE_UNEXPECTED_GREEN:${label}`);
  }
  const blob = result.combined;
  const hasDrift =
    blob.includes("CHUNK_BOUNDARY_FUZZ_DRIFT") ||
    blob.includes(SEED_MARKER);
  const hasUnified =
    blob.includes("--- fuzz/") &&
    blob.includes("+++ fuzz/") &&
    blob.includes("@@ ");
  if (!hasDrift || !hasUnified) {
    emit({
      outcome: "error",
      code: "PARSER_CHUNK_FUZZ_PROVE_DIFF_MISSING",
      phase: label,
      subjectId: "anika-k",
      deviceId: "ci-gate",
      message: blob.slice(0, 2500),
    });
    throw new Error(
      `PARSER_CHUNK_FUZZ_PROVE_DIFF_MISSING:${label} — failing gate must print a unified event diff`,
    );
  }
  emit({
    outcome: "ok",
    phase: label,
    status: result.status,
    code: "CHUNK_BOUNDARY_FUZZ_DRIFT",
    seedVisible: blob.includes(SEED_MARKER),
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
}

export function proveParserChunkFuzzGate() {
  ensureBuilt();
  const phases = [];

  const green = runChunkFuzz({ [SEED_ENV]: "0" });
  assertGreen("baseline", green);
  phases.push({ phase: "baseline", status: green.status });

  emit({
    outcome: "ok",
    phase: "seed",
    seedEnv: SEED_ENV,
    seedMarker: SEED_MARKER,
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });

  const red = runChunkFuzz({ [SEED_ENV]: "1" });
  assertRedWithUnifiedDiff("seeded-red", red);
  phases.push({ phase: "seeded-red", status: red.status });
  process.stdout.write(
    `\n--- parser-chunk-fuzz seeded-red (excerpt) ---\n${red.combined.slice(0, 4000)}\n---\n`,
  );

  const again = runChunkFuzz({ [SEED_ENV]: "0" });
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
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    proveParserChunkFuzzGate();
    process.exit(0);
  } catch (err) {
    emit({
      outcome: "error",
      code: "PARSER_CHUNK_FUZZ_PROVE_FAILED",
      subjectId: "anika-k",
      deviceId: "ci-gate",
      message: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
    process.exit(1);
  }
}
