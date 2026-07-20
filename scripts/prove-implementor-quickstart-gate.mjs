/**
 * Seed-violation proof for implementor quickstart gate.
 *
 * Usage:
 *   node scripts/prove-implementor-quickstart-gate.mjs
 *   pnpm implementor-quickstart:prove
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runImplementorQuickstartCheck,
  validateImplementorQuickstart,
} from "./check-implementor-quickstart.mjs";

export function runImplementorQuickstartProve() {
  const lines = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "sutra-quic-impl-"));

  try {
    // Red: missing canonical.
    const redMissing = validateImplementorQuickstart({
      canonicalPath: path.join(scratch, "missing.md"),
      siteLandingPath: path.join(scratch, "landing.md"),
    });
    if (redMissing.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: missing canonical expected red",
      };
    }
    if (
      !redMissing.violations.some(
        (v) => v.obligation === OBLIGATIONS.MISSING_CANONICAL,
      )
    ) {
      return {
        status: 1,
        combined: "PROVE_FAILED: expected missing_canonical",
      };
    }
    lines.push("red:missing-canonical");

    // Red: monorepo path leak + missing required sections.
    const leakPath = path.join(scratch, "leak.md");
    const landingPath = path.join(scratch, "landing.md");
    writeFileSync(
      leakPath,
      [
        "# bad",
        "Verified: 2026-07-16",
        "See packages/contract-conformance/src/obligations/model.ts",
        "",
      ].join("\n"),
    );
    writeFileSync(landingPath, "# landing\n");
    const redLeak = validateImplementorQuickstart({
      canonicalPath: leakPath,
      siteLandingPath: landingPath,
      now: new Date("2026-07-16T12:00:00Z"),
    });
    if (redLeak.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: leak guide expected red",
      };
    }
    if (
      !redLeak.violations.some(
        (v) => v.obligation === OBLIGATIONS.MONOREPO_PATH_LEAK,
      )
    ) {
      return {
        status: 1,
        combined: `PROVE_FAILED: expected monorepo_path_leak:\n${redLeak.violations.map((v) => v.obligation).join(",")}`,
      };
    }
    lines.push("red:monorepo-path-leak");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Green: committed guide.
  const green = runImplementorQuickstartCheck({
    emitEvents: false,
    now: new Date("2026-07-16T12:00:00Z"),
  });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `PROVE_FAILED: baseline must pass:\n${green.combined}`,
    };
  }
  lines.push("green:baseline");

  return {
    status: 0,
    combined: `OK: implementor quickstart prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runImplementorQuickstartProve();
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
