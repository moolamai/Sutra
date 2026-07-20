/**
 * Seed-violation proof for rehearsal install verification gate.
 *
 * Usage (repo root):
 *   node scripts/prove-rehearsal-install-gate.mjs
 *   pnpm publish:rehearsal:prove
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runRehearsalInstallFromLocalPacks,
  runRehearsalInstallFromRegistry,
} from "./verify-rehearsal-install.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REHEARSAL_SEED_MATRIX = Object.freeze([
  {
    kind: "missing-dist-before-pack",
    obligation: OBLIGATIONS.PACK_FAILED,
    packages() {
      return [
        {
          name: "@moolam/seed-rehearsal-missing-dist",
          dir: "",
          manifest: { name: "@moolam/seed-rehearsal-missing-dist", version: "0.0.0" },
        },
      ];
    },
    seed(scratchDir) {
      const pkgDir = path.join(scratchDir, "pkg");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "@moolam/seed-rehearsal-missing-dist",
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
          name: "@moolam/seed-rehearsal-missing-dist",
          dir: pkgDir,
          manifest: { name: "@moolam/seed-rehearsal-missing-dist", version: "0.0.0" },
        },
      ];
    },
  },
  {
    kind: "registry-version-missing",
    obligation: OBLIGATIONS.REGISTRY_VERSION_MISSING,
    run() {
      return runRehearsalInstallFromRegistry({
        registryUrl: "https://npm.pkg.github.com",
        version: "",
        emitEvents: false,
        cleanup: true,
      });
    },
  },
]);

export function runSeededRehearsalViolation(seed) {
  if (seed.run) {
    return seed.run();
  }
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-rehearsal-prove-"));
  try {
    const packages = seed.seed(workRoot);
    return runRehearsalInstallFromLocalPacks({
      workRoot,
      packages,
      cleanup: false,
      emitEvents: false,
    });
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

export function runRehearsalInstallProve() {
  const lines = [];
  for (const seed of REHEARSAL_SEED_MATRIX) {
    const result = runSeededRehearsalViolation(seed);
    if (result.status === 0) {
      return {
        status: 1,
        combined: `PROVE_FAILED: seed "${seed.kind}" expected red but was green`,
      };
    }
    const hit = (result.violations ?? []).some((v) => v.obligation === seed.obligation);
    if (!hit) {
      return {
        status: 1,
        combined:
          `PROVE_FAILED: seed "${seed.kind}" red for wrong reason:\n` +
          `${result.combined}`,
      };
    }
    lines.push(`red:${seed.kind}:${seed.obligation}`);
  }

  const baseline = runRehearsalInstallFromLocalPacks({ emitEvents: false });
  if (baseline.status !== 0) {
    return {
      status: 1,
      combined: `PROVE_FAILED: baseline green expected after seeds:\n${baseline.combined}`,
    };
  }
  lines.push("green:baseline");

  return {
    status: 0,
    combined: `OK: rehearsal install prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runRehearsalInstallProve();
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
