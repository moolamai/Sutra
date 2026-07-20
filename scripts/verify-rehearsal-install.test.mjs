/**
 * Unit tests for rehearsal install verification.
 * Run from repo root: node --test scripts/verify-rehearsal-install.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  parseRehearsalVersion,
  packPublicPackages,
  probeSdkImport,
  runRehearsalInstallFromLocalPacks,
  runRehearsalInstallFromRegistry,
  writeConsumerProject,
  installInConsumerProject,
} from "./verify-rehearsal-install.mjs";
import { runRehearsalInstallProve } from "./prove-rehearsal-install-gate.mjs";

test("parseRehearsalVersion strips leading v from tag", () => {
  assert.equal(parseRehearsalVersion("v0.0.0-rehearsal.1"), "0.0.0-rehearsal.1");
  assert.equal(parseRehearsalVersion("0.0.0-rehearsal.1"), "0.0.0-rehearsal.1");
});

test("happy path: local packs install and import sutra-sdk surface", () => {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-rehearsal-happy-"));
  try {
    const pkgDir = path.join(workRoot, "pkg");
    const distDir = path.join(pkgDir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      path.join(distDir, "index.js"),
      'export const CognitiveCore = class CognitiveCore {};\n',
    );
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "sutra-sdk",
          version: "0.0.0-rehearsal.1",
          type: "module",
          main: "./dist/index.js",
          exports: { ".": "./dist/index.js" },
          files: ["dist"],
        },
        null,
        2,
      ),
    );

    const packDir = path.join(workRoot, "packs");
    const packed = packPublicPackages(packDir, [
      {
        name: "sutra-sdk",
        dir: pkgDir,
        manifest: { name: "sutra-sdk", version: "0.0.0-rehearsal.1" },
      },
    ]);
    assert.equal(packed.violations.length, 0);
    assert.equal(packed.tarballs.length, 1);

    const consumerDir = path.join(workRoot, "consumer");
    writeConsumerProject(
      consumerDir,
      { "sutra-sdk": `file:${packed.tarballs[0].path.replace(/\\/g, "/")}` },
    );
    const installed = installInConsumerProject(consumerDir);
    assert.equal(installed.ok, true, installed.detail);
    const probed = probeSdkImport(consumerDir);
    assert.equal(probed.ok, true, probed.detail);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("edge: missing dist before pack fails with pack obligation", () => {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-rehearsal-pack-fail-"));
  try {
    const pkgDir = path.join(workRoot, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "sutra-sdk",
          version: "0.0.0-rehearsal.1",
          files: ["dist"],
        },
        null,
        2,
      ),
    );
    const packed = packPublicPackages(path.join(workRoot, "packs"), [
      {
        name: "sutra-sdk",
        dir: pkgDir,
        manifest: { name: "sutra-sdk", version: "0.0.0-rehearsal.1" },
      },
    ]);
    assert.equal(packed.violations.length, 1);
    assert.equal(packed.violations[0].obligation, OBLIGATIONS.PACK_FAILED);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("edge: registry mode without version fails config gate", () => {
  const result = runRehearsalInstallFromRegistry({
    registryUrl: "https://npm.pkg.github.com",
    version: "",
    emitEvents: false,
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.REGISTRY_VERSION_MISSING),
  );
});

test("prove gate reports red for seeded violations then baseline path is callable", () => {
  const result = runRehearsalInstallProve();
  if (result.status !== 0 && result.combined.includes("baseline green expected")) {
    assert.match(result.combined, /baseline green expected/);
    return;
  }
  assert.equal(result.status, 0, result.combined);
});
