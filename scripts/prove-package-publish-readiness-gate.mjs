/**
 * Seed-violation proof for package publish metadata gate.
 *
 * Operator path:
 *   1. Baseline green (pnpm publish:readiness after build)
 *   2. For each seed: in-memory manifest audit → red with exact obligation
 *   3. Baseline green again (tree never mutated)
 *
 * Usage (repo root):
 *   node scripts/prove-package-publish-readiness-gate.mjs
 *   pnpm publish:readiness:prove
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  auditPackageManifest,
  runPackagePublishReadinessGate,
} from "./check-package-publish-readiness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Ordered seed matrix — one entry per obligation class. */
export const SEED_MATRIX = Object.freeze([
  {
    kind: "missing-publish-config",
    obligation: OBLIGATIONS.PUBLISH_CONFIG_MISSING,
    mutate(manifest) {
      delete manifest.publishConfig;
      return manifest;
    },
  },
  {
    kind: "files-includes-src",
    obligation: OBLIGATIONS.FILES_FORBIDDEN_ENTRY,
    mutate(manifest) {
      manifest.files = [...(manifest.files ?? ["dist"]), "src"];
      return manifest;
    },
  },
  {
    kind: "exports-outside-dist",
    obligation: OBLIGATIONS.EXPORT_NOT_DIST,
    mutate(manifest) {
      manifest.exports = {
        ".": {
          types: "./src/index.ts",
          import: "./src/index.ts",
        },
      };
      return manifest;
    },
  },
  {
    kind: "private-with-public-publish",
    obligation: OBLIGATIONS.PRIVATE_HAS_PUBLIC_PUBLISH,
    mutate(manifest) {
      return {
        ...manifest,
        name: "@moolam/contract-mocks",
        private: true,
        publishConfig: { access: "public" },
      };
    },
  },
]);

export const SEED_PHASE_LIMIT = SEED_MATRIX.length;

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "publish.readiness.prove", ...event })}\n`,
  );
}

function basePublicManifest() {
  return {
    name: "@moolam/contracts",
    version: "0.1.0",
    license: "Apache-2.0",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    files: ["dist"],
    homepage:
      "https://github.com/moolamai/sutra/tree/main/packages/contracts#readme",
    repository: {
      type: "git",
      url: "git+https://github.com/moolamai/sutra.git",
      directory: "packages/contracts",
    },
    publishConfig: { access: "public" },
  };
}

export function runSeededPublishViolation(kind) {
  const seed = SEED_MATRIX.find((s) => s.kind === kind);
  if (!seed) {
    throw new Error(`UNKNOWN_PUBLISH_READINESS_SEED:${kind}`);
  }
  const manifest = seed.mutate(basePublicManifest());
  const violations = auditPackageManifest(manifest, "packages/contracts", {
    verifyDistArtifacts: false,
  });
  const hit = violations.find((v) => v.obligation === seed.obligation);
  return {
    status: hit ? 1 : 0,
    violations,
    hit,
    seed,
  };
}

export function runPackagePublishReadinessProve() {
  emit({ outcome: "start", phase: "baseline" });
  const baseline = runPackagePublishReadinessGate({
    subjectId: "prove-publish-readiness-baseline",
    deviceId: "prove",
    verifyDistArtifacts: false,
  });
  if (baseline.status !== 0) {
    emit({ outcome: "fail", phase: "baseline", violationCount: baseline.violations.length });
    return {
      status: 1,
      combined: `PROVE_BASELINE_NOT_GREEN:\n${baseline.combined}`,
    };
  }
  emit({ outcome: "ok", phase: "baseline", packagesAudited: baseline.packagesAudited });

  for (const seed of SEED_MATRIX) {
    emit({ outcome: "start", phase: "seed", kind: seed.kind });
    const seeded = runSeededPublishViolation(seed.kind);
    if (seeded.status !== 1 || !seeded.hit) {
      emit({ outcome: "fail", phase: "seed", kind: seed.kind });
      return {
        status: 1,
        combined:
          `PROVE_SEED_DID_NOT_FAIL:${seed.kind} expected ${seed.obligation}\n` +
          `violations=${JSON.stringify(seeded.violations)}`,
      };
    }
    emit({
      outcome: "ok",
      phase: "seed",
      kind: seed.kind,
      obligation: seed.obligation,
    });
  }

  const after = runPackagePublishReadinessGate({
    subjectId: "prove-publish-readiness-after",
    deviceId: "prove",
    verifyDistArtifacts: false,
  });
  if (after.status !== 0) {
    emit({ outcome: "fail", phase: "post-baseline" });
    return {
      status: 1,
      combined: `PROVE_POST_BASELINE_NOT_GREEN:\n${after.combined}`,
    };
  }

  emit({ outcome: "ok", phase: "complete", seedCount: SEED_MATRIX.length });
  return {
    status: 0,
    combined: `OK: publish readiness prove (${SEED_MATRIX.length} seeds)`,
  };
}

function main() {
  const result = runPackagePublishReadinessProve();
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
