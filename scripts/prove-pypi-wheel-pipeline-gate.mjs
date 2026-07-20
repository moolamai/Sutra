/**
 * Seed-violation proof for PyPI wheel pipeline metadata gate.
 *
 * Usage (repo root):
 *   node scripts/prove-pypi-wheel-pipeline-gate.mjs
 *   pnpm pypi:wheel:prove
 */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  loadPyproject,
  runPypiWheelPipelineGate,
  validatePyprojectMetadata,
} from "./check-pypi-wheel-pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runPypiWheelPipelineProve() {
  const baseline = loadPyproject();
  const green = runPypiWheelPipelineGate({
    pyprojectText: baseline,
    metadataOnly: true,
    emitEvents: false,
  });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `PROVE_FAILED: baseline metadata green expected:\n${green.combined}`,
    };
  }

  const broken = baseline.replace(
    /Documentation = "https:\/\/github\.com\/moolamai\/sutra\/tree\/main\/packages\/cloud-orchestrator#readme"/,
    "",
  );
  const red = validatePyprojectMetadata(broken);
  if (red.status === 0) {
    return {
      status: 1,
      combined: "PROVE_FAILED: seeded missing Documentation URL expected red",
    };
  }
  if (!red.violations.some((v) => v.obligation === OBLIGATIONS.URLS_MISSING)) {
    return {
      status: 1,
      combined: `PROVE_FAILED: seeded violation wrong obligation:\n${red.violations
        .map((v) => v.detail)
        .join("; ")}`,
    };
  }

  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-pypi-wheel-prove-"));
  const brokenPath = path.join(workRoot, "pyproject.toml");
  try {
    writeFileSync(brokenPath, broken);
    const gateRed = runPypiWheelPipelineGate({
      pyprojectPath: brokenPath,
      metadataOnly: true,
      emitEvents: false,
    });
    if (gateRed.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: gate red expected for broken pyproject",
      };
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }

  const greenAgain = runPypiWheelPipelineGate({
    pyprojectText: baseline,
    metadataOnly: true,
    emitEvents: false,
  });
  if (greenAgain.status !== 0) {
    return {
      status: 1,
      combined: `PROVE_FAILED: baseline metadata green after seed failed:\n${greenAgain.combined}`,
    };
  }

  return {
    status: 0,
    combined: "OK: pypi wheel pipeline prove red→green (missing Documentation URL)",
  };
}

function main() {
  const result = runPypiWheelPipelineProve();
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
