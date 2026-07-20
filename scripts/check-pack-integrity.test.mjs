/**
 * Unit tests for post-pack integrity gate.
 * Run from repo root: node --test scripts/check-pack-integrity.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  recordPackIntegrityManifest,
  verifyPackIntegrityManifest,
} from "./check-pack-integrity.mjs";
import { runPackIntegrityProve } from "./prove-pack-integrity-gate.mjs";

function seedPackage(scratchDir) {
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

test("happy path: record then verify matches digests", () => {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-pack-integrity-happy-"));
  const packDir = path.join(workRoot, "packs");
  const manifestPath = path.join(workRoot, "manifest.json");
  const packages = seedPackage(workRoot);
  try {
    const recorded = recordPackIntegrityManifest({ packDir, manifestPath, packages });
    assert.equal(recorded.status, 0, recorded.combined);
    const verified = verifyPackIntegrityManifest({ packDir, manifestPath, packages });
    assert.equal(verified.status, 0, verified.combined);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("edge: verify without manifest fails", () => {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-pack-integrity-no-manifest-"));
  try {
    const verified = verifyPackIntegrityManifest({
      packDir: path.join(workRoot, "packs"),
      manifestPath: path.join(workRoot, "missing.json"),
      packages: seedPackage(workRoot),
    });
    assert.equal(verified.status, 1);
    assert.ok(
      verified.violations.some((v) => v.obligation === OBLIGATIONS.MANIFEST_MISSING),
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("edge: source mutation between record and verify fails digest check", () => {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-pack-integrity-drift-"));
  const packDir = path.join(workRoot, "packs");
  const manifestPath = path.join(workRoot, "manifest.json");
  const packages = seedPackage(workRoot);
  try {
    const recorded = recordPackIntegrityManifest({ packDir, manifestPath, packages });
    assert.equal(recorded.status, 0);
    writeFileSync(
      path.join(packages[0].dir, "dist", "index.js"),
      'export const Probe = "mutated";\n',
    );
    const verified = verifyPackIntegrityManifest({ packDir, manifestPath, packages });
    assert.equal(verified.status, 1);
    assert.ok(
      verified.violations.some((v) => v.obligation === OBLIGATIONS.DIGEST_DRIFT),
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("prove gate red→green on seeded digest drift", () => {
  const result = runPackIntegrityProve();
  assert.equal(result.status, 0, result.combined);
});
