/**
 * Seed-violation proof for integration templates CI matrix gate.
 *
 * Usage (repo root):
 *   node scripts/prove-integration-templates-matrix-gate.mjs
 *   pnpm integration:templates:verify:prove
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTEGRATION_TEMPLATE_MATRIX,
  OBLIGATIONS,
  runIntegrationTemplatesMatrix,
} from "./verify-integration-templates-matrix.mjs";

export function runIntegrationTemplatesMatrixProve() {
  const lines = [];

  // Red: empty matrix.
  const redEmpty = runIntegrationTemplatesMatrix({
    matrix: [],
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  if (redEmpty.status === 0) {
    return {
      status: 1,
      combined: "INTEGRATION_MATRIX_PROVE_FAILED: empty matrix expected red",
    };
  }
  if (
    !(redEmpty.violations ?? []).some((v) => v.obligation === OBLIGATIONS.MATRIX_EMPTY)
  ) {
    return {
      status: 1,
      combined:
        "INTEGRATION_MATRIX_PROVE_FAILED: empty matrix must cite matrix.empty:\n" +
        `${redEmpty.combined}`,
    };
  }
  lines.push("red:empty-matrix");

  // Red: unknown template id.
  const redUnknown = runIntegrationTemplatesMatrix({
    template: "not-a-real-template",
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  if (redUnknown.status === 0) {
    return {
      status: 1,
      combined: "INTEGRATION_MATRIX_PROVE_FAILED: unknown template expected red",
    };
  }
  if (
    !(redUnknown.violations ?? []).some(
      (v) => v.obligation === OBLIGATIONS.MATRIX_UNKNOWN_TEMPLATE,
    )
  ) {
    return {
      status: 1,
      combined:
        "INTEGRATION_MATRIX_PROVE_FAILED: unknown template must cite unknown_template:\n" +
        `${redUnknown.combined}`,
    };
  }
  lines.push("red:unknown-template");

  // Red: missing dist before pack (printed detail).
  const scratch = mkdtempSync(path.join(tmpdir(), "sutra-integration-matrix-prove-"));
  try {
    const pkgDir = path.join(scratch, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "@moolam/seed-integration-matrix-missing-dist",
          version: "0.0.0",
          type: "module",
          main: "./dist/index.js",
          files: ["dist"],
        },
        null,
        2,
      ),
    );
    const redPack = runIntegrationTemplatesMatrix({
      packages: [
        {
          name: "@moolam/seed-integration-matrix-missing-dist",
          dir: pkgDir,
          manifest: {
            name: "@moolam/seed-integration-matrix-missing-dist",
            version: "0.0.0",
          },
        },
      ],
      matrix: [INTEGRATION_TEMPLATE_MATRIX[0]],
      skipBuild: true,
      emitEvents: false,
      cleanup: true,
    });
    if (redPack.status === 0 || redPack.phase !== "pack") {
      return {
        status: 1,
        combined:
          `INTEGRATION_MATRIX_PROVE_FAILED: missing dist expected pack red:\n` +
          `${redPack.combined}`,
      };
    }
    if (!String(redPack.combined).includes("missing dist")) {
      return {
        status: 1,
        combined:
          "INTEGRATION_MATRIX_PROVE_FAILED: pack failure must print missing-dist detail:\n" +
          `${redPack.combined}`,
      };
    }
    lines.push("red:missing-dist:pack");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Green: full three-template matrix against current SDK.
  const green = runIntegrationTemplatesMatrix({
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `INTEGRATION_MATRIX_PROVE_FAILED: baseline matrix must pass:\n${green.combined}`,
    };
  }
  if ((green.cells ?? []).length !== INTEGRATION_TEMPLATE_MATRIX.length) {
    return {
      status: 1,
      combined: `INTEGRATION_MATRIX_PROVE_FAILED: expected ${INTEGRATION_TEMPLATE_MATRIX.length} cells`,
    };
  }
  lines.push(`green:matrix(${green.cells.join(",")})`);

  return {
    status: 0,
    combined: `OK: integration templates matrix prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runIntegrationTemplatesMatrixProve();
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
