/**
 * Seed-violation proof for stranger-test protocol gate.
 *
 * Usage:
 *   node scripts/prove-stranger-test-protocol-gate.mjs
 *   pnpm stranger-test:prove
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runStrangerTestProtocolCheck,
  validateStrangerTestProtocol,
} from "./check-stranger-test-protocol.mjs";

export function runStrangerTestProtocolProve() {
  const lines = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "sutra-stranger-prove-"));

  try {
    const redMissing = validateStrangerTestProtocol({
      protocolPath: path.join(scratch, "missing.md"),
      findingsDir: scratch,
      siteLandingPath: path.join(scratch, "landing.md"),
    });
    if (redMissing.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: missing protocol expected red",
      };
    }
    if (
      !redMissing.violations.some(
        (v) => v.obligation === OBLIGATIONS.MISSING_PROTOCOL,
      )
    ) {
      return {
        status: 1,
        combined: "PROVE_FAILED: expected missing_protocol",
      };
    }
    lines.push("red:missing-protocol");

    // Red: protocol present but no findings recording.
    const proto = path.join(scratch, "PROTOCOL.md");
    writeFileSync(
      proto,
      [
        "# x",
        "8 hours one calendar day",
        "no monorepo no Slack",
        "Success criteria smoke",
        "Recording template Friction log",
        "Tester brief Observe only no coaching",
        "subjectId idempotent syncAttemptId Restart",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(scratch, "landing.md"), "stranger PROTOCOL\n");
    const redFindings = validateStrangerTestProtocol({
      protocolPath: proto,
      findingsDir: scratch,
      siteLandingPath: path.join(scratch, "landing.md"),
    });
    if (redFindings.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: missing findings expected red",
      };
    }
    if (
      !redFindings.violations.some(
        (v) => v.obligation === OBLIGATIONS.MISSING_FINDINGS,
      )
    ) {
      return {
        status: 1,
        combined: `PROVE_FAILED: expected missing_findings:\n${redFindings.violations.map((v) => v.obligation).join(",")}`,
      };
    }
    lines.push("red:missing-findings");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const green = runStrangerTestProtocolCheck({ emitEvents: false });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `PROVE_FAILED: baseline must pass:\n${green.combined}`,
    };
  }
  lines.push("green:baseline");

  return {
    status: 0,
    combined: `OK: stranger-test prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runStrangerTestProtocolProve();
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
