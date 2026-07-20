/**
 * Seed-violation proof for PROTOCOL_VERSION bump gate.
 *
 * Operator path:
 *   1. Baseline green
 *   2. Seed an unlogged field on SyncAdvisory.json → gate red with diff
 *   3. Revert → green
 *
 * Always restores SyncAdvisory.json (finally).
 *
 * Usage (repo root):
 *   node scripts/prove-protocol-version-bump-gate.mjs
 *   pnpm protocol:version-bump:prove
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runProtocolVersionBumpGate,
} from "./check-protocol-version-bump.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const SEED_FIELD = "seedUnloggedField";
export const SEED_MARKER = "PROTOCOL_VERSION_BUMP_PROVE_SEED";
export const SEED_SCHEMA = path.join(
  REPO_ROOT,
  "packages/sync-protocol/schemas/SyncAdvisory.json",
);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "protocol.version_bump.prove", ...event })}\n`,
  );
}

export function runBumpGateSubprocess() {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-protocol-version-bump.mjs"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

/**
 * Insert a unilateral optional property on SyncAdvisory — no version/changelog.
 */
export function seedUnloggedField(schemaPath = SEED_SCHEMA) {
  const original = readFileSync(schemaPath, "utf8");
  if (original.includes(SEED_MARKER)) {
    throw new Error(
      "PROTOCOL_VERSION_BUMP_PROVE_ALREADY_SEEDED: clean tree before proving",
    );
  }
  const doc = JSON.parse(original);
  if (!doc.properties || typeof doc.properties !== "object") {
    throw new Error(
      "PROTOCOL_VERSION_BUMP_PROVE_SEED_FAILED: SyncAdvisory.properties missing",
    );
  }
  if (doc.properties[SEED_FIELD]) {
    throw new Error(
      "PROTOCOL_VERSION_BUMP_PROVE_SEED_FAILED: seed field already present",
    );
  }
  doc.properties[SEED_FIELD] = {
    type: "string",
    description: `${SEED_MARKER} — temporary unlogged additive field`,
  };
  writeFileSync(schemaPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return original;
}

export function restoreSchema(original, schemaPath = SEED_SCHEMA) {
  writeFileSync(schemaPath, original, "utf8");
}

/**
 * @returns {{ ok: boolean, phases: object[], failures: string[] }}
 */
export function proveProtocolVersionBumpGate({
  schemaPath = SEED_SCHEMA,
  runGate = runBumpGateSubprocess,
} = {}) {
  /** @type {object[]} */
  const phases = [];
  /** @type {string[]} */
  const failures = [];
  let original = null;

  emit({ event: "protocol.version_bump.prove", outcome: "start" });

  try {
    const baseline = runGate();
    phases.push({
      phase: "baseline",
      status: baseline.status,
      outcome: baseline.status === 0 ? "ok" : "error",
    });
    emit({
      event: "protocol.version_bump.prove",
      phase: "baseline",
      outcome: baseline.status === 0 ? "ok" : "error",
      exitCode: baseline.status,
    });
    if (baseline.status !== 0) {
      failures.push(
        "BASELINE_NOT_GREEN: gate must pass before seeding unlogged field.\n" +
          baseline.combined,
      );
      return { ok: false, phases, failures };
    }

    original = seedUnloggedField(schemaPath);
    emit({
      event: "protocol.version_bump.prove",
      phase: "seed",
      outcome: "ok",
      field: SEED_FIELD,
    });

    const red = runGate();
    phases.push({
      phase: "seeded_red",
      status: red.status,
      outcome: red.status === 0 ? "error" : "ok",
    });
    emit({
      event: "protocol.version_bump.prove",
      phase: "seeded_red",
      outcome: red.status === 0 ? "error" : "ok",
      exitCode: red.status,
    });

    if (red.status === 0) {
      failures.push(
        "SEEDED_DID_NOT_FAIL: unlogged field addition must turn the gate red",
      );
    } else {
      const combined = red.combined;
      if (!combined.includes(SEED_FIELD) && !combined.includes("SyncAdvisory")) {
        failures.push(
          "SEEDED_DIFF_MISSING: failing output must name SyncAdvisory or the seed field",
        );
      }
      if (!combined.includes(OBLIGATIONS.VERSION_BUMP_REQUIRED)) {
        // In-process check for obligation code when subprocess only prints detail text
        const inProcess = runProtocolVersionBumpGate({ emitEvents: false });
        if (
          !inProcess.violations.some(
            (v) => v.obligation === OBLIGATIONS.VERSION_BUMP_REQUIRED,
          ) &&
          !combined.includes("without PROTOCOL_VERSION bump")
        ) {
          failures.push(
            "SEEDED_OBLIGATION_MISSING: expected protocol.version_bump.version_required",
          );
        }
      }
      if (!combined.includes("---") || !combined.includes("+++")) {
        failures.push(
          "SEEDED_NO_DIFF: failing gate must print a unified diff (never bare boolean)",
        );
      }
    }

    restoreSchema(original, schemaPath);
    original = null;

    const green = runGate();
    phases.push({
      phase: "reverted_green",
      status: green.status,
      outcome: green.status === 0 ? "ok" : "error",
    });
    emit({
      event: "protocol.version_bump.prove",
      phase: "reverted_green",
      outcome: green.status === 0 ? "ok" : "error",
      exitCode: green.status,
    });
    if (green.status !== 0) {
      failures.push(
        "REVERT_NOT_GREEN: restoring SyncAdvisory.json must turn the gate green.\n" +
          green.combined,
      );
    }
  } finally {
    if (original !== null) {
      restoreSchema(original, schemaPath);
    }
  }

  const ok = failures.length === 0;
  emit({
    event: "protocol.version_bump.prove",
    outcome: ok ? "ok" : "error",
    failureCount: failures.length,
  });
  return { ok, phases, failures };
}

function main() {
  const result = proveProtocolVersionBumpGate();
  if (!result.ok) {
    process.stderr.write(
      `PROTOCOL_VERSION_BUMP_PROVE_FAILED:\n${result.failures.join("\n\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    "OK: PROTOCOL_VERSION bump prove red→green (unlogged SyncAdvisory field)\n",
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
