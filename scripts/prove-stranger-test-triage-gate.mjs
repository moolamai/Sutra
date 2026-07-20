/**
 * Seed-violation proof for stranger-test triage gate.
 *
 * Usage:
 *   node scripts/prove-stranger-test-triage-gate.mjs
 *   pnpm stranger-test:triage:prove
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runStrangerTestTriageCheck,
  validateStrangerTestTriage,
} from "./check-stranger-test-triage.mjs";

export function runStrangerTestTriageProve() {
  const lines = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "sutra-stranger-triage-"));

  try {
    const redMissing = validateStrangerTestTriage({
      triagePath: path.join(scratch, "missing.md"),
      p7Path: path.join(scratch, "p7.md"),
      implementorPath: path.join(scratch, "impl.md"),
      sitePath: path.join(scratch, "site.md"),
      createSutraPath: path.join(scratch, "cli.mjs"),
      findingsDir: scratch,
    });
    if (redMissing.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: missing triage expected red",
      };
    }
    if (
      !redMissing.violations.some(
        (v) => v.obligation === OBLIGATIONS.MISSING_TRIAGE,
      )
    ) {
      return {
        status: 1,
        combined: "PROVE_FAILED: expected missing_triage",
      };
    }
    lines.push("red:missing-triage");

    // Red: triage without P7 intents / quickstart fixes.
    writeFileSync(
      path.join(scratch, "TRIAGE.md"),
      ["F-001 Closed", "F-002 open", "F-003", "F-004", "F-005", ""].join("\n"),
    );
    writeFileSync(path.join(scratch, "p7.md"), "# empty\n");
    writeFileSync(path.join(scratch, "impl.md"), "# no scratch\n");
    writeFileSync(path.join(scratch, "site.md"), "# no brief\n");
    writeFileSync(path.join(scratch, "cli.mjs"), "export {}\n");
    writeFileSync(path.join(scratch, "FINDINGS-2099-01-01.md"), "F-001\n");
    const redOpen = validateStrangerTestTriage({
      triagePath: path.join(scratch, "TRIAGE.md"),
      p7Path: path.join(scratch, "p7.md"),
      implementorPath: path.join(scratch, "impl.md"),
      sitePath: path.join(scratch, "site.md"),
      createSutraPath: path.join(scratch, "cli.mjs"),
      findingsDir: scratch,
    });
    if (redOpen.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: incomplete triage expected red",
      };
    }
    lines.push("red:incomplete-triage");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const green = runStrangerTestTriageCheck({ emitEvents: false });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `PROVE_FAILED: baseline must pass:\n${green.combined}`,
    };
  }
  lines.push("green:baseline");

  return {
    status: 0,
    combined: `OK: stranger-test triage prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runStrangerTestTriageProve();
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
