/**
 * Seed-violation proof for version lockstep gate.
 *
 * Usage (repo root):
 *   node scripts/prove-version-lockstep-gate.mjs
 *   pnpm version:lockstep:prove
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLiveVersionValues } from "./check-version-lockstep-doc.mjs";
import {
  OBLIGATIONS,
  runVersionLockstepGate,
  validateVersionLockstep,
  collectVersionLockstepSnapshot,
} from "./check-version-lockstep.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runVersionLockstepProve() {
  const live = readLiveVersionValues();
  const canonical = live.sdk_npm || live.orchestrator_pyproject || live.sync_protocol_npm;
  if (!canonical) {
    return {
      status: 1,
      combined: "VERSION_LOCKSTEP_PROVE_FAILED: could not read baseline versions",
    };
  }

  const seeded = {
    ...live,
    orchestrator_pyproject: canonical === "0.1.0" ? "9.9.9" : "0.0.0",
  };

  const red = runVersionLockstepGate({
    liveValues: seeded,
    emitEvents: false,
  });
  if (red.status === 0) {
    return {
      status: 1,
      combined: "VERSION_LOCKSTEP_PROVE_FAILED: seeded mismatch did not fail gate",
    };
  }
  if (!red.violations.some((v) => v.obligation === OBLIGATIONS.VERSION_MISMATCH)) {
    return {
      status: 1,
      combined: "VERSION_LOCKSTEP_PROVE_FAILED: expected version_mismatch obligation",
    };
  }
  if (!red.diff?.includes("packages/cloud-orchestrator/pyproject.toml")) {
    return {
      status: 1,
      combined: "VERSION_LOCKSTEP_PROVE_FAILED: diff must cite offending pyproject path",
    };
  }

  const green = runVersionLockstepGate({
    liveValues: live,
    emitEvents: false,
  });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `VERSION_LOCKSTEP_PROVE_FAILED: baseline must pass: ${green.combined}`,
    };
  }

  const snapshot = collectVersionLockstepSnapshot(undefined, { liveValues: seeded });
  const diffOnly = validateVersionLockstep(snapshot);
  if (!diffOnly.diff?.includes("--- lockstep/")) {
    return {
      status: 1,
      combined: "VERSION_LOCKSTEP_PROVE_FAILED: unified diff header missing",
    };
  }

  return {
    status: 0,
    combined: "OK: version lockstep prove red→green (pyproject semver drift)",
  };
}

function main() {
  const result = runVersionLockstepProve();
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
