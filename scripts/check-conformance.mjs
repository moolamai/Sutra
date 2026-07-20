/**
 * Contract-conformance CI gate .
 *
 * Runs:
 *   1. Build @moolam/contract-conformance (+ workspace deps)
 *   2. Package unit suite (reference mocks / obligation registries)
 *   3. @moolam/runtime unit suite (in-repo runtime reference)
 *   4. conformance CLI --self-check (human report; obligation IDs on failure)
 *
 * Exit 1 on any failure. Stdout/stderr always forward so CI logs show
 * offending obligation IDs and MUST text (never silent red).
 *
 * Usage (repo root):
 *   node scripts/check-conformance.mjs
 *   pnpm conformance
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "conformance.gate", ...event })}\n`,
  );
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    shell: opts.shell ?? true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function forward(label, result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  emit({
    outcome: result.status === 0 ? "ok" : "fail",
    phase: label,
    exitCode: result.status,
  });
}

export function ensureConformanceBuilt() {
  const dist = path.join(
    REPO_ROOT,
    "packages/contract-conformance/dist/index.js",
  );
  const runtimeDist = path.join(REPO_ROOT, "packages/runtime/dist/index.js");
  if (
    existsSync(dist) &&
    existsSync(runtimeDist) &&
    process.env.CI !== "true" &&
    process.env.CONFORMANCE_FORCE_BUILD !== "1"
  ) {
    emit({ outcome: "ok", phase: "build.skip", reason: "dist-present" });
    return;
  }
  const result = run("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@moolam/contract-conformance",
    "--filter=@moolam/runtime",
  ]);
  forward("build", result);
  if (result.status !== 0 || !existsSync(dist)) {
    throw new Error(
      `CONFORMANCE_GATE_BUILD_FAILED:status=${result.status}\n${result.combined.slice(0, 4000)}`,
    );
  }
}

export function runConformancePackageTests() {
  return run("pnpm", ["--filter", "@moolam/contract-conformance", "test"]);
}

export function runRuntimePackageTests() {
  return run("pnpm", ["--filter", "@moolam/runtime", "test"]);
}

export function runConformanceCli(extraArgs = []) {
  const bin = path.join(
    REPO_ROOT,
    "packages/contract-conformance/bin/conformance.mjs",
  );
  return run(process.execPath, [
    bin,
    "--self-check",
    "--subject-id",
    "ci-conformance",
    "--device-id",
    "ci",
    "--emit-events",
    ...extraArgs,
  ], { shell: false });
}

/**
 * Full gate. Returns aggregate { status, combined } like other prove scripts.
 */
export function runConformanceGate() {
  ensureConformanceBuilt();

  const steps = [
    ["unit.contract-conformance", runConformancePackageTests],
    ["unit.runtime", runRuntimePackageTests],
    ["cli.self-check", () => runConformanceCli()],
  ];

  let combined = "";
  for (const [label, fn] of steps) {
    const result = fn();
    forward(label, result);
    combined += result.combined;
    if (result.status !== 0) {
      // Surface obligation ids when the CLI or suite already printed them.
      if (!/CK-\d+|RT-\d+|SYNC-\d+/i.test(combined)) {
        process.stderr.write(
          "conformance.gate: failure without obligation-id tokens in log — see steps above\n",
        );
      }
      return { status: result.status, combined };
    }
  }
  return { status: 0, combined };
}

function main() {
  try {
    const result = runConformanceGate();
    process.exitCode = result.status === 0 ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
