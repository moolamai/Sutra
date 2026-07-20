/**
 * Seed-violation proof for PyPI publish policy gate.
 *
 * Usage (repo root):
 *   node scripts/prove-pypi-publish-gate.mjs
 *   pnpm pypi:publish:prove
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  resolvePyPiPublishTarget,
  runPypiPublish,
} from "./run-pypi-publish.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runPypiPublishProve() {
  const blocked = resolvePyPiPublishTarget({
    publishEnabled: true,
    allowProd: false,
    refName: "v1.0.0",
    requestedRegistry: "pypi",
  });
  if (!blocked.violation) {
    return {
      status: 1,
      combined:
        "PYPI_PUBLISH_PROVE_FAILED: expected production publish without flag to be blocked",
    };
  }
  if (blocked.violation.obligation !== OBLIGATIONS.PROD_WITHOUT_FLAG) {
    return {
      status: 1,
      combined: `PYPI_PUBLISH_PROVE_FAILED: unexpected obligation ${blocked.violation.obligation}`,
    };
  }

  const rehearsal = resolvePyPiPublishTarget({
    publishEnabled: true,
    allowProd: false,
    refName: "v0.1.0-rehearsal.1",
  });
  if (!rehearsal.upload || rehearsal.registry !== "testpypi") {
    return {
      status: 1,
      combined:
        "PYPI_PUBLISH_PROVE_FAILED: rehearsal tag must target TestPyPI upload",
    };
  }

  const dryRun = runPypiPublish({
    dryRun: true,
    emitEvents: false,
  });
  if (dryRun.status !== 0) {
    return {
      status: 1,
      combined: `PYPI_PUBLISH_PROVE_FAILED: dry-run publish failed: ${dryRun.combined}`,
    };
  }

  return {
    status: 0,
    combined:
      "OK: pypi publish prove red→green (prod without flag blocked; rehearsal→TestPyPI; dry-run build+check)",
  };
}

function main() {
  const result = runPypiPublishProve();
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
