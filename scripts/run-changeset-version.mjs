/**
 * Gated wrapper for `changeset version`.
 *
 * Validates .changeset/config.json before applying version bumps so a
 * misconfigured fixed/ignore list cannot produce a partial release.
 *
 * Usage (repo root):
 *   node scripts/run-changeset-version.mjs
 *   pnpm changeset:version
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChangesetConfigGate } from "./check-changeset-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "changeset.version", ...event })}\n`,
  );
}

export function runChangesetVersion(opts = {}) {
  const subjectId = opts.subjectId ?? "release-version-bump";
  const deviceId = opts.deviceId ?? "ci";
  const dryRun = opts.dryRun === true;
  const emitEvents = opts.emitEvents !== false;

  const gate = runChangesetConfigGate({
    subjectId,
    deviceId,
    emitEvents: false,
    config: opts.config,
    configPath: opts.configPath,
    publicPackages: opts.publicPackages,
  });

  if (gate.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "config-gate",
        violationCount: gate.violations.length,
      });
    }
    return {
      status: 1,
      combined: gate.combined,
      phase: "config-gate",
    };
  }

  if (dryRun) {
    if (emitEvents) {
      emit({
        outcome: "ok",
        subjectId,
        deviceId,
        phase: "dry-run",
        packageCount: gate.publicPackages.length,
      });
    }
    return {
      status: 0,
      combined: `OK: changeset version dry-run — config valid for ${gate.publicPackages.length} package(s)`,
      phase: "dry-run",
    };
  }

  const result = spawnSync("pnpm", ["exec", "changeset", "version"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "changeset version failed").trim();
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "changeset-version",
        exitCode: result.status ?? 1,
      });
    }
    return {
      status: result.status ?? 1,
      combined: `CHANGESET_VERSION_FAILED: ${detail}`,
      phase: "changeset-version",
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "changeset-version",
      packageCount: gate.publicPackages.length,
    });
  }

  return {
    status: 0,
    combined: `OK: changeset version applied for ${gate.publicPackages.length} package(s)`,
    phase: "changeset-version",
    stdout: result.stdout,
  };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = runChangesetVersion({ dryRun });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(result.status);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
