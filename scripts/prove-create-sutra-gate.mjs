/**
 * Seed-violation proof for create-sutra scaffolder gate.
 *
 * Usage (repo root):
 *   node scripts/prove-create-sutra-gate.mjs
 *   pnpm create-sutra:prove
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCreateSutraScaffold } from "../tools/create-sutra/lib/scaffold.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runCreateSutraProve() {
  const red = runCreateSutraScaffold({
    projectName: "INVALID NAME",
    domainPack: "teacher",
    storageDriver: "memory",
    transport: "offline",
    outDir: path.join(__dirname, "..", "artifacts", "create-sutra-prove-red"),
    emitEvents: false,
  });
  if (red.status === 0) {
    return {
      status: 1,
      combined: "CREATE_SUTRA_PROVE_FAILED: invalid project name must fail gate",
    };
  }
  if (!red.violations.some((v) => v.obligation === "create_sutra.project_name.invalid")) {
    return {
      status: 1,
      combined: "CREATE_SUTRA_PROVE_FAILED: expected project_name.invalid obligation",
    };
  }

  const green = runCreateSutraScaffold({
    projectName: "prove-companion",
    domainPack: "custom",
    storageDriver: "memory",
    transport: "offline",
    outDir: path.join(__dirname, "..", "artifacts", "create-sutra-prove-green"),
    overwrite: true,
    emitEvents: false,
  });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `CREATE_SUTRA_PROVE_FAILED: valid scaffold must pass: ${green.combined}`,
    };
  }

  return {
    status: 0,
    combined: "OK: create-sutra prove red→green (invalid name blocked; valid scaffold emitted)",
  };
}

function main() {
  const result = runCreateSutraProve();
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
