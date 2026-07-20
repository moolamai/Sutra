/**
 * Seed-violation proof for QUIC-002 guides gate.
 *
 * Usage:
 *   node scripts/prove-quic-conformance-binding-guides-gate.mjs
 *   pnpm quic-guides:prove
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runQuicConformanceBindingGuidesCheck,
  validateQuicConformanceBindingGuides,
} from "./check-quic-conformance-binding-guides.mjs";

export function runQuicConformanceBindingGuidesProve() {
  const lines = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "sutra-quic-guides-"));

  try {
    const redMissing = validateQuicConformanceBindingGuides({
      conformanceCanonical: path.join(scratch, "missing-c.md"),
      bindingCanonical: path.join(scratch, "missing-b.md"),
      conformanceLanding: path.join(scratch, "lc.md"),
      bindingLanding: path.join(scratch, "lb.md"),
      now: new Date("2026-07-16T12:00:00Z"),
    });
    if (redMissing.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: missing canonicals expected red",
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

    const leakC = path.join(scratch, "c.md");
    const leakB = path.join(scratch, "b.md");
    const landC = path.join(scratch, "lc.md");
    const landB = path.join(scratch, "lb.md");
    writeFileSync(
      leakC,
      [
        "# bad",
        "Verified: 2026-07-16",
        "See packages/contract-conformance/src/obligations/model.ts",
        "",
      ].join("\n"),
    );
    writeFileSync(
      leakB,
      [
        "# bad",
        "Verified: 2026-07-16",
        "See packages/bindings-slm/src/foo.ts",
        "",
      ].join("\n"),
    );
    writeFileSync(landC, "# x\n");
    writeFileSync(landB, "# x\n");
    const redLeak = validateQuicConformanceBindingGuides({
      conformanceCanonical: leakC,
      bindingCanonical: leakB,
      conformanceLanding: landC,
      bindingLanding: landB,
      now: new Date("2026-07-16T12:00:00Z"),
    });
    if (redLeak.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: leak guides expected red",
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

  const green = runQuicConformanceBindingGuidesCheck({
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
    combined: `OK: quic guides prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runQuicConformanceBindingGuidesProve();
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
