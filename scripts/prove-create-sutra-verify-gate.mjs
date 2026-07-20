/**
 * Seed-violation proof for create-sutra scaffold verify / CI matrix gate.
 *
 * Intentionally broken input turns the gate red; baseline matrix turns green.
 *
 * Usage (repo root):
 *   node scripts/prove-create-sutra-verify-gate.mjs
 *   pnpm create-sutra:verify:prove
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  SCAFFOLD_VERIFY_MATRIX,
  runCreateSutraScaffoldVerify,
  runCreateSutraScaffoldVerifyMatrix,
} from "./verify-create-sutra-scaffold.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function seedMissingDistPackage(scratchDir) {
  const pkgDir = path.join(scratchDir, "pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: "@moolam/seed-create-sutra-missing-dist",
        version: "0.0.0",
        type: "module",
        main: "./dist/index.js",
        files: ["dist"],
      },
      null,
      2,
    ),
  );
  return [
    {
      name: "@moolam/seed-create-sutra-missing-dist",
      dir: pkgDir,
      manifest: {
        name: "@moolam/seed-create-sutra-missing-dist",
        version: "0.0.0",
      },
    },
  ];
}

export function runCreateSutraVerifyProve() {
  const lines = [];

  // Red: pack phase must fail loudly when dist/ is missing.
  const packScratch = mkdtempSync(path.join(tmpdir(), "sutra-create-sutra-prove-pack-"));
  try {
    const redPack = runCreateSutraScaffoldVerify({
      packages: seedMissingDistPackage(packScratch),
      skipBuild: true,
      emitEvents: false,
      cleanup: true,
    });
    if (redPack.status === 0) {
      return {
        status: 1,
        combined:
          "CREATE_SUTRA_VERIFY_PROVE_FAILED: missing dist seed expected red but was green",
      };
    }
    if (redPack.phase !== "pack") {
      return {
        status: 1,
        combined:
          `CREATE_SUTRA_VERIFY_PROVE_FAILED: expected pack phase, got ${redPack.phase}:\n` +
          `${redPack.combined}`,
      };
    }
    if (!String(redPack.combined).includes("missing dist")) {
      return {
        status: 1,
        combined:
          "CREATE_SUTRA_VERIFY_PROVE_FAILED: pack failure must print missing-dist detail:\n" +
          `${redPack.combined}`,
      };
    }
    lines.push("red:missing-dist:pack");
  } finally {
    rmSync(packScratch, { recursive: true, force: true });
  }

  // Red: empty matrix must fail with a named obligation (never silent).
  const redEmpty = runCreateSutraScaffoldVerifyMatrix({
    matrix: [],
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  if (redEmpty.status === 0) {
    return {
      status: 1,
      combined: "CREATE_SUTRA_VERIFY_PROVE_FAILED: empty matrix expected red",
    };
  }
  if (
    !(redEmpty.violations ?? []).some((v) => v.obligation === OBLIGATIONS.MATRIX_EMPTY)
  ) {
    return {
      status: 1,
      combined:
        "CREATE_SUTRA_VERIFY_PROVE_FAILED: empty matrix must cite matrix_empty obligation:\n" +
        `${redEmpty.combined}`,
    };
  }
  lines.push("red:empty-matrix:matrix_empty");

  // Green: single representative cell (pack once path) against current SDK.
  const greenCell = SCAFFOLD_VERIFY_MATRIX[0];
  const green = runCreateSutraScaffoldVerify({
    projectName: "prove-verify-companion",
    domainPack: greenCell.domainPack,
    storageDriver: greenCell.storageDriver,
    transport: greenCell.transport,
    subjectId: "create-sutra-verify-prove",
    deviceId: "ci",
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  if (green.status !== 0) {
    return {
      status: 1,
      combined:
        `CREATE_SUTRA_VERIFY_PROVE_FAILED: baseline cell must pass after seeds:\n` +
        `${green.combined}`,
    };
  }
  lines.push(`green:${greenCell.id}`);

  return {
    status: 0,
    combined: `OK: create-sutra verify prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runCreateSutraVerifyProve();
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
