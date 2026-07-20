/**
 * Unit tests for docs-site TypeDoc API reference generation.
 * Run: node --test scripts/check-docs-site-api.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_PACKAGES,
  API_ROOT,
  DOCS_SITE_ROOT,
  OBLIGATIONS,
  generateApiReference,
  validateDeclarations,
  verifyApiFingerprint,
} from "../docs-site/scripts/generate-api.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");
const DOCS_SITE_PKG = path.join(DOCS_SITE_ROOT, "package.json");

test("happy path: typedoc config, api nav, and generate from dist", () => {
  assert.ok(existsSync(path.join(DOCS_SITE_ROOT, "typedoc.json")));
  const config = readFileSync(
    path.join(DOCS_SITE_ROOT, ".vitepress", "config.mts"),
    "utf8",
  );
  assert.match(config, /\/api\//);
  assert.match(config, /text: "API"/);

  const sitePkg = JSON.parse(readFileSync(DOCS_SITE_PKG, "utf8"));
  assert.equal(sitePkg.scripts["docs:api"], "node scripts/generate-api.mjs");
  assert.match(sitePkg.scripts["docs:build"], /docs:api/);
  assert.ok(sitePkg.devDependencies.typedoc);
  assert.ok(sitePkg.devDependencies["typedoc-plugin-markdown"]);

  assert.ok(API_PACKAGES.includes("sdk"));
  assert.ok(API_PACKAGES.includes("contracts"));

  const result = generateApiReference({ emitEvents: false });
  assert.equal(result.status, 0, result.combined);
  assert.ok(existsSync(path.join(API_ROOT, ".generated")));
  assert.ok(existsSync(path.join(API_ROOT, ".fingerprint")));
  assert.ok(
    existsSync(path.join(API_ROOT, "index.md")) ||
      existsSync(path.join(API_ROOT, "README.md")) ||
      existsSync(path.join(API_ROOT, "modules.md")),
  );
  assert.equal(verifyApiFingerprint({ skipStale: true }).status, 0);
});

test("edge: missing dist declarations fails with named obligation", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sutra-api-missing-"));
  try {
    mkdirSync(path.join(repo, "packages", "sdk"), { recursive: true });
    const result = validateDeclarations({
      repoRoot: repo,
      packages: ["sdk"],
      skipStale: true,
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.DIST_MISSING),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("edge: stale declarations fail docs:api validate", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sutra-api-stale-"));
  try {
    const pkg = path.join(repo, "packages", "sdk");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    mkdirSync(path.join(pkg, "src"), { recursive: true });
    const distPath = path.join(pkg, "dist", "index.d.ts");
    writeFileSync(distPath, "export declare const x: number;\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(distPath, old, old);
    writeFileSync(path.join(pkg, "src", "index.ts"), "export const x = 1;\n");
    const result = validateDeclarations({
      repoRoot: repo,
      packages: ["sdk"],
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.STALE_DECLARATIONS),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sovereignty: ownership forbids hand-maintained API and learner content", () => {
  const ownership = readFileSync(path.join(DOCS_SITE_ROOT, "OWNERSHIP.md"), "utf8");
  assert.match(ownership, /Never hand-edit/i);
  assert.match(ownership, /dist\/\*\.d\.ts/);
  assert.match(ownership, /never publish raw learner/i);
  assert.match(ownership, /public TypeScript surfaces only/i);
});

test("ci and root scripts wire docs-site api", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /docs-site/);
  assert.match(ci, /sutra-sdk\.\.\./);
  assert.match(ci, /check-docs-site-api\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(pkg.scripts["docs-site:api"], "pnpm --filter @moolam/docs-site docs:api");
  assert.match(pkg.scripts["docs-site:build"], /docs:build/);
});
