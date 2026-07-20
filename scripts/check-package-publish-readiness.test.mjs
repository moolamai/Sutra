/**
 * Unit tests for package publish-readiness gate.
 * Run from repo root: node --test scripts/check-package-publish-readiness.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditPackageManifest,
  analyzePackDryRunOutput,
  listPackageManifests,
  runPackagePublishReadinessGate,
  runPackagePackDryRunGate,
  OBLIGATIONS,
  MONO_REPO_GIT_URL,
  MONO_REPO_HOMEPAGE_BASE,
} from "./check-package-publish-readiness.mjs";
import { runPackagePublishReadinessProve } from "./prove-package-publish-readiness-gate.mjs";
import {
  PACK_SEED_MATRIX,
  runSeededPackViolation,
  runPackagePublishPackProve,
} from "./prove-package-publish-pack-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function publicManifest(name, relDir) {
  return {
    name,
    license: "Apache-2.0",
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: MONO_REPO_GIT_URL,
      directory: relDir,
    },
    homepage: `${MONO_REPO_HOMEPAGE_BASE}/${relDir}#readme`,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    files: ["dist"],
  };
}

test("happy path: public package with dist exports passes audit", () => {
  const relDir = "packages/contracts";
  const violations = auditPackageManifest(
    publicManifest("@moolam/contracts", relDir),
    relDir,
  );
  assert.equal(violations.length, 0, JSON.stringify(violations));
});

test("edge: missing publishConfig.access fails audit", () => {
  const relDir = "packages/sdk";
  const manifest = publicManifest("sutra-sdk", relDir);
  delete manifest.publishConfig;
  const violations = auditPackageManifest(manifest, relDir);
  assert.ok(violations.some((v) => v.obligation.includes("publishConfig")));
});

test("edge: files whitelist rejects tests/", () => {
  const relDir = "packages/runtime";
  const manifest = publicManifest("@moolam/runtime", relDir);
  manifest.files = ["dist", "tests"];
  const violations = auditPackageManifest(manifest, relDir);
  assert.ok(violations.some((v) => v.obligation.includes("files.forbidden")));
});

test("edge: private packages must not declare public publishConfig", () => {
  const relDir = "packages/cloud-orchestrator";
  const violations = auditPackageManifest(
    {
      name: "@moolam/cloud-orchestrator",
      private: true,
      publishConfig: { access: "public" },
      license: "Apache-2.0",
    },
    relDir,
  );
  assert.ok(violations.some((v) => v.obligation.includes("private.publishConfig")));
});

test("integration: repo public package manifests pass metadata audit", () => {
  const listed = listPackageManifests();
  const publicCount = listed.filter((p) => p.manifest.private !== true).length;
  assert.ok(publicCount >= 9, `expected at least 9 public packages, got ${publicCount}`);
  const result = runPackagePublishReadinessGate({
    emitEvents: false,
    verifyDistArtifacts: false,
    runPack: false,
  });
  assert.equal(result.status, 0, result.combined);
});

test("edge: pack analysis fails when dist/ is absent from tarball", () => {
  const manifest = publicManifest("@moolam/seed", "packages/seed");
  const output = `📦  @moolam/seed@0.0.0\nTarball Contents\npackage.json\nTarball Details\nseed-0.0.0.tgz\n`;
  const issues = analyzePackDryRunOutput(output, manifest);
  assert.ok(issues.some((i) => i.obligation === OBLIGATIONS.PACK_DIST_MISSING));
  assert.ok(issues.some((i) => i.obligation === OBLIGATIONS.PACK_EXPORT_MISSING));
});

test("edge: seeded missing-dist pack violation fails with pack.dist_missing", () => {
  const seeded = runSeededPackViolation("missing-dist-tarball");
  assert.equal(seeded.status, 1);
  assert.equal(seeded.hit?.obligation, OBLIGATIONS.PACK_DIST_MISSING);
});

test("edge: seeded missing export target fails with pack.export_missing", () => {
  const seeded = runSeededPackViolation("export-target-absent");
  assert.equal(seeded.status, 1);
  assert.equal(seeded.hit?.obligation, OBLIGATIONS.PACK_EXPORT_MISSING);
});

test("integration: repo public packages pass pack dry-run gate", () => {
  const result = runPackagePackDryRunGate({ emitEvents: false });
  assert.equal(result.status, 0, result.combined);
  assert.ok(result.packagesAudited >= 9);
});

test("prove pack gate: baseline green, seeds red, baseline green again", () => {
  const result = runPackagePublishPackProve();
  assert.equal(result.status, 0, result.combined);
  assert.equal(PACK_SEED_MATRIX.length, 2);
});

test("prove gate: baseline green, seeds red, baseline green again", () => {
  const result = runPackagePublishReadinessProve();
  assert.equal(result.status, 0, result.combined);
});

test("root package.json exposes publish readiness scripts", () => {
  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(root.scripts["publish:readiness"], /check-package-publish-readiness/);
  assert.match(root.scripts["publish:readiness:prove"], /prove-package-publish-readiness/);
  assert.match(root.scripts["publish:pack"], /--pack-only/);
  assert.match(root.scripts["publish:pack:prove"], /prove-package-publish-pack/);
});

test("CI wiring: package-publish-readiness job runs metadata, pack, prove, and tests", () => {
  const ciYml = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  const block = ciYml.replace(/\r\n/g, "\n");
  assert.match(block, /release-readiness:/);
  assert.match(block, /pnpm publish:readiness/);
  assert.match(block, /pnpm publish:pack/);
  assert.match(block, /pnpm publish:pack:prove/);
  assert.match(block, /check-package-publish-readiness\.test\.mjs/);
});
