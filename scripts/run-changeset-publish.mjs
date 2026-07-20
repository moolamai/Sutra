/**
 * Gated wrapper for `changeset publish` with npm provenance when enabled.
 *
 * Usage (repo root):
 *   node scripts/run-changeset-publish.mjs
 *   node scripts/run-changeset-publish.mjs --dry-run
 *   pnpm changeset:publish
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveProvenanceForPublish,
  runReleaseProvenanceGate,
} from "./check-release-provenance.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "changeset.publish", ...event })}\n`,
  );
}

export function runChangesetPublish(opts = {}) {
  const subjectId = opts.subjectId ?? "release-publish";
  const deviceId = opts.deviceId ?? "ci";
  const dryRun = opts.dryRun === true || process.argv.includes("--dry-run");
  const emitEvents = opts.emitEvents !== false;

  const gate = runReleaseProvenanceGate({
    subjectId,
    deviceId,
    emitEvents: false,
    workflowText: opts.workflowText,
    checklistText: opts.checklistText,
  });
  if (gate.status !== 0 && !dryRun) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "provenance-config-gate",
        violationCount: gate.violations.length,
      });
    }
    return {
      status: 1,
      phase: "provenance-config-gate",
      combined: gate.combined,
    };
  }

  const provenance = resolveProvenanceForPublish({
    dryRun,
    registry: opts.registry ?? process.env.registry,
  });
  if (provenance.violation) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "provenance-policy",
        obligation: provenance.violation.obligation,
      });
    }
    return {
      status: 1,
      phase: "provenance-policy",
      combined: `CHANGESET_PUBLISH_FAILED: [${provenance.violation.obligation}] ${provenance.violation.detail}`,
    };
  }

  const env = {
    ...process.env,
    ...(dryRun ? { NPM_CONFIG_DRY_RUN: "true" } : {}),
    ...(provenance.enabled ? { NPM_CONFIG_PROVENANCE: "true" } : {}),
  };

  const result = spawnSync("pnpm", ["exec", "changeset", "publish"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env,
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "changeset publish failed").trim();
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "changeset-publish",
        provenance: provenance.enabled,
        exitCode: result.status ?? 1,
      });
    }
    return {
      status: result.status ?? 1,
      phase: "changeset-publish",
      combined: `CHANGESET_PUBLISH_FAILED: ${detail}`,
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "changeset-publish",
      provenance: provenance.enabled,
      provenanceReason: provenance.reason ?? "enabled",
      dryRun,
    });
  }

  return {
    status: 0,
    phase: "changeset-publish",
    provenance: provenance.enabled,
    combined: provenance.enabled
      ? "OK: changeset publish completed with npm provenance enabled"
      : `OK: changeset publish completed (${provenance.reason ?? "no-provenance"})`,
    stdout: result.stdout,
  };
}

function main() {
  const result = runChangesetPublish({ dryRun: process.argv.includes("--dry-run") });
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
