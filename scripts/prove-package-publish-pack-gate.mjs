/**
 * Seed-violation proof for pnpm pack --dry-run gate.
 *
 * Operator path:
 *   1. Baseline green (pnpm publish:pack after build)
 *   2. For each seed: scratch package → red with exact pack obligation
 *   3. Baseline green again (tree never mutated)
 *
 * Usage (repo root):
 *   node scripts/prove-package-publish-pack-gate.mjs
 *   pnpm publish:pack:prove
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runPackDryRun,
  runPackagePackDryRunGate,
} from "./check-package-publish-readiness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Ordered seed matrix — one entry per pack failure class. */
export const PACK_SEED_MATRIX = Object.freeze([
  {
    kind: "missing-dist-tarball",
    obligation: OBLIGATIONS.PACK_DIST_MISSING,
    seed(scratchDir) {
      writeFileSync(
        path.join(scratchDir, "package.json"),
        JSON.stringify(
          {
            name: "@moolam/seed-pack-missing-dist",
            version: "0.0.0",
            files: ["dist"],
            main: "./dist/index.js",
            types: "./dist/index.d.ts",
            exports: {
              ".": {
                types: "./dist/index.d.ts",
                import: "./dist/index.js",
              },
            },
          },
          null,
          2,
        ),
      );
    },
    notes: "files includes dist but tarball has no dist/ output",
  },
  {
    kind: "export-target-absent",
    obligation: OBLIGATIONS.PACK_EXPORT_MISSING,
    seed(scratchDir) {
      mkdirSync(path.join(scratchDir, "dist"), { recursive: true });
      writeFileSync(path.join(scratchDir, "dist", "index.js"), "export {};\n");
      writeFileSync(
        path.join(scratchDir, "package.json"),
        JSON.stringify(
          {
            name: "@moolam/seed-pack-missing-export",
            version: "0.0.0",
            files: ["dist"],
            main: "./dist/index.js",
            exports: {
              ".": {
                import: "./dist/missing.js",
                types: "./dist/missing.d.ts",
              },
            },
          },
          null,
          2,
        ),
      );
    },
    notes: "exports map references files not present in tarball",
  },
]);

export const PACK_SEED_PHASE_LIMIT = PACK_SEED_MATRIX.length;

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "publish.pack.prove", ...event })}\n`,
  );
}

export function runSeededPackViolation(kind) {
  const seed = PACK_SEED_MATRIX.find((s) => s.kind === kind);
  if (!seed) {
    throw new Error(`UNKNOWN_PACK_PROVE_SEED:${kind}`);
  }
  const scratchDir = mkdtempSync(path.join(tmpdir(), "sutra-pack-prove-"));
  try {
    seed.seed(scratchDir);
    const manifest = JSON.parse(
      readFileSync(path.join(scratchDir, "package.json"), "utf8"),
    );
    const packed = runPackDryRun(scratchDir, manifest);
    const hit = (packed.issues ?? []).find((i) => i.obligation === seed.obligation);
    return {
      status: packed.ok ? 0 : 1,
      packed,
      hit,
      seed,
      scratchDir,
    };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

export function runPackagePublishPackProve() {
  emit({ outcome: "start", phase: "baseline" });
  const baseline = runPackagePackDryRunGate({
    subjectId: "prove-publish-pack-baseline",
    deviceId: "prove",
  });
  if (baseline.status !== 0) {
    emit({ outcome: "fail", phase: "baseline", violationCount: baseline.violations.length });
    return {
      status: 1,
      combined: `PROVE_PACK_BASELINE_NOT_GREEN:\n${baseline.combined}`,
    };
  }
  emit({ outcome: "ok", phase: "baseline", packagesAudited: baseline.packagesAudited });

  for (const seed of PACK_SEED_MATRIX) {
    emit({ outcome: "start", phase: "seed", kind: seed.kind });
    const seeded = runSeededPackViolation(seed.kind);
    if (seeded.status !== 1 || !seeded.hit) {
      emit({ outcome: "fail", phase: "seed", kind: seed.kind });
      return {
        status: 1,
        combined:
          `PROVE_PACK_SEED_DID_NOT_FAIL:${seed.kind} expected ${seed.obligation}\n` +
          `detail=${seeded.packed?.detail ?? "no detail"}`,
      };
    }
    emit({
      outcome: "ok",
      phase: "seed",
      kind: seed.kind,
      obligation: seed.obligation,
    });
  }

  const after = runPackagePackDryRunGate({
    subjectId: "prove-publish-pack-after",
    deviceId: "prove",
  });
  if (after.status !== 0) {
    emit({ outcome: "fail", phase: "post-baseline" });
    return {
      status: 1,
      combined: `PROVE_PACK_POST_BASELINE_NOT_GREEN:\n${after.combined}`,
    };
  }

  emit({ outcome: "ok", phase: "complete", seedCount: PACK_SEED_MATRIX.length });
  return {
    status: 0,
    combined: `OK: pack dry-run prove (${PACK_SEED_MATRIX.length} seeds)`,
  };
}

function main() {
  const result = runPackagePublishPackProve();
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
