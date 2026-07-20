/**
 * Unit coverage for CycloneDX release SBOM generation and wiring.
 * Run: node --test scripts/check-release-sbom.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  checkReleaseSbom,
} from "./check-release-sbom.mjs";
import {
  assertCycloneDxShape,
  buildCycloneDxBom,
  generateReleaseSboms,
  listPublishableNpmPackages,
  listPythonDirectDeps,
  purl,
} from "./generate-release-sbom.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RELEASE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "release.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");

test("happy path: generateReleaseSboms writes CycloneDX JSON", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-sbom-"));
  try {
    const result = generateReleaseSboms({ outDir: dir });
    assert.equal(result.ok, true);
    assert.ok(result.npmComponents >= 1);
    assert.ok(result.pipComponents >= 1);
    const npm = JSON.parse(readFileSync(result.npmPath, "utf8"));
    assertCycloneDxShape(npm);
    assert.equal(npm.bomFormat, "CycloneDX");
    assert.equal(npm.specVersion, "1.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("happy path: checkReleaseSbom passes against committed wiring", () => {
  const result = checkReleaseSbom();
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("purl: scoped npm and pypi formats", () => {
  assert.equal(
    purl("sutra-sdk", "0.1.0", "npm"),
    "pkg:npm/sutra-sdk@0.1.0",
  );
  assert.equal(
    purl("@moolam/contracts", "0.1.0", "npm"),
    "pkg:npm/%40moolam/contracts@0.1.0",
  );
  assert.equal(purl("fastapi", "0.115", "pypi"), "pkg:pypi/fastapi@0.115");
});

test("listPublishableNpmPackages: publishable npm names only", () => {
  const pkgs = listPublishableNpmPackages();
  assert.ok(pkgs.some((p) => p.name === "sutra-sdk"));
  assert.ok(pkgs.some((p) => p.name.startsWith("@moolam/")));
  assert.ok(pkgs.every((p) => p.name.startsWith("@moolam/") || p.name.startsWith("sutra-")));
});

test("listPythonDirectDeps: reads cloud-orchestrator pyproject", () => {
  const deps = listPythonDirectDeps();
  assert.ok(deps.some((d) => d.name === "fastapi"));
  assert.ok(deps.some((d) => d.name === "uvicorn"), "extras must not truncate the array");
  assert.ok(deps.length >= 8);
});

test("edge: empty components fail assertCycloneDxShape", () => {
  assert.throws(
    () =>
      assertCycloneDxShape(
        buildCycloneDxBom({ name: "x", version: "1", components: [] }),
      ),
    /no_components/,
  );
});

test("edge: workflow without generate step fails MISSING_GENERATE", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-sbom-wf-"));
  try {
    const workflowPath = path.join(dir, "release.yml");
    writeFileSync(
      workflowPath,
      "name: Release\njobs:\n  release:\n    steps: []\n",
      "utf8",
    );
    mkdirSync(path.join(dir, "SBOM"), { recursive: true });
    writeFileSync(
      path.join(dir, "SBOM", "README.md"),
      "CycloneDX .cdx.json\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "PUBLISH-CHECKLIST.md"),
      "SBOM CycloneDX required\n",
      "utf8",
    );
    const result = checkReleaseSbom({
      workflowPath,
      checklistPath: path.join(dir, "PUBLISH-CHECKLIST.md"),
      docsDir: path.join(dir, "SBOM"),
      runGenerate: false,
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.MISSING_GENERATE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: workflow without gh release attach fails MISSING_GH_RELEASE", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-sbom-gh-"));
  try {
    const workflowPath = path.join(dir, "release.yml");
    writeFileSync(
      workflowPath,
      [
        "name: Release",
        "jobs:",
        "  release:",
        "    steps:",
        "      - run: node scripts/generate-release-sbom.mjs",
        "      - run: echo artifacts/sbom/*.cdx.json",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(path.join(dir, "SBOM"), { recursive: true });
    writeFileSync(
      path.join(dir, "SBOM", "README.md"),
      "CycloneDX .cdx.json\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "PUBLISH-CHECKLIST.md"),
      "SBOM CycloneDX required\n",
      "utf8",
    );
    const result = checkReleaseSbom({
      workflowPath,
      checklistPath: path.join(dir, "PUBLISH-CHECKLIST.md"),
      docsDir: path.join(dir, "SBOM"),
      runGenerate: false,
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.MISSING_GH_RELEASE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci scripts and release.yml path filters include SBOM scripts", () => {
  const ci = readFileSync(RELEASE_WORKFLOW, "utf8");
  assert.match(ci, /generate-release-sbom\.mjs/);
  assert.match(ci, /gh release upload/);
  assert.match(ci, /artifacts\/sbom\/\*\.cdx\.json/);
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(pkg.scripts["sbom:generate"], "node scripts/generate-release-sbom.mjs");
  assert.equal(pkg.scripts["sbom:check"], "node scripts/check-release-sbom.mjs");
});
