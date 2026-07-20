/**
 * Seed-violation proof for post-pack integrity gate.
 *
 * Usage (repo root):
 *   node scripts/prove-pack-integrity-gate.mjs
 *   pnpm publish:integrity:prove
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  recordPackIntegrityManifest,
  verifyPackIntegrityManifest,
} from "./check-pack-integrity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function seedPackage(scratchDir) {
  const pkgDir = path.join(scratchDir, "pkg");
  const distDir = path.join(pkgDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(path.join(distDir, "index.js"), 'export const Probe = "ok";\n');
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: "@moolam/seed-pack-integrity",
        version: "0.0.0",
        type: "module",
        main: "./dist/index.js",
        exports: { ".": "./dist/index.js" },
        files: ["dist"],
      },
      null,
      2,
    ),
  );
  return [
    {
      name: "@moolam/seed-pack-integrity",
      dir: pkgDir,
      manifest: { name: "@moolam/seed-pack-integrity", version: "0.0.0" },
    },
  ];
}

export function runPackIntegrityProve() {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-pack-integrity-prove-"));
  const packDir = path.join(workRoot, "packs");
  const manifestPath = path.join(workRoot, "manifest.json");
  const packages = seedPackage(workRoot);

  try {
    const recorded = recordPackIntegrityManifest({ packDir, manifestPath, packages });
    if (recorded.status !== 0) {
      return {
        status: 1,
        combined: `PROVE_FAILED: record baseline red:\n${recorded.combined}`,
      };
    }

    const pkgDir = packages[0].dir;
    writeFileSync(
      path.join(pkgDir, "dist", "index.js"),
      'export const Probe = "mutated";\n',
    );

    const verified = verifyPackIntegrityManifest({ packDir, manifestPath, packages });
    if (verified.status === 0) {
      return {
        status: 1,
        combined: "PROVE_FAILED: digest drift seed expected red but was green",
      };
    }
    const hit = verified.violations.some((v) => v.obligation === OBLIGATIONS.DIGEST_DRIFT);
    if (!hit) {
      return {
        status: 1,
        combined: `PROVE_FAILED: digest drift seed red for wrong reason:\n${verified.combined}`,
      };
    }

    rmSync(packDir, { recursive: true, force: true });
    mkdirSync(packDir, { recursive: true });
    const rerecord = recordPackIntegrityManifest({ packDir, manifestPath, packages });
    if (rerecord.status !== 0) {
      return {
        status: 1,
        combined: `PROVE_FAILED: baseline green after drift seed failed:\n${rerecord.combined}`,
      };
    }

    const green = verifyPackIntegrityManifest({ packDir, manifestPath, packages });
    if (green.status !== 0) {
      return {
        status: 1,
        combined: `PROVE_FAILED: baseline verify green failed:\n${green.combined}`,
      };
    }

    return {
      status: 0,
      combined: "OK: pack integrity prove red→green (digest drift)",
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function main() {
  const result = runPackIntegrityProve();
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
