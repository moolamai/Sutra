/**
 * Unit tests for docs-site VitePress scaffold.
 * Run: node --test scripts/check-docs-site.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCS_SITE_ROOT,
  SYNC_MAP,
  syncDocsContent,
} from "../docs-site/scripts/sync-content.mjs";
import {
  OBLIGATIONS,
  runDocsSiteCheck,
  validateDocsSiteScaffold,
} from "./check-docs-site.mjs";
import { runDocsSiteProve } from "./prove-docs-site-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");
const DOCS_README = path.join(REPO_ROOT, "docs", "README.md");

test("happy path: docs-site has VitePress config, nav landing, ownership, sync map", () => {
  assert.ok(existsSync(path.join(DOCS_SITE_ROOT, ".vitepress", "config.mts")));
  assert.ok(existsSync(path.join(DOCS_SITE_ROOT, "index.md")));
  assert.ok(existsSync(path.join(DOCS_SITE_ROOT, "OWNERSHIP.md")));
  assert.ok(existsSync(path.join(DOCS_SITE_ROOT, "package.json")));

  const ownership = readFileSync(path.join(DOCS_SITE_ROOT, "OWNERSHIP.md"), "utf8");
  assert.match(ownership, /Canonical/);
  assert.match(ownership, /docs\//);
  assert.match(ownership, /reference\//);

  const config = readFileSync(
    path.join(DOCS_SITE_ROOT, ".vitepress", "config.mts"),
    "utf8",
  );
  assert.match(config, /nav:/);
  assert.match(config, /sidebar:/);
  assert.match(config, /reference\/overview/);
  assert.match(config, /\/api\//);

  assert.equal(validateDocsSiteScaffold().status, 0);
  assert.ok(SYNC_MAP.some((e) => e.id === "overview"));
  assert.ok(SYNC_MAP.some((e) => e.id === "architecture"));
  assert.ok(SYNC_MAP.some((e) => e.id === "protocol"));
  assert.ok(SYNC_MAP.some((e) => e.id === "sdk"));
});

test("edge: sync fails loudly when source docs are missing", () => {
  const docsRoot = mkdtempSync(path.join(tmpdir(), "sutra-docs-missing-"));
  const referenceRoot = mkdtempSync(path.join(tmpdir(), "sutra-ref-missing-"));
  try {
    const result = syncDocsContent({
      docsRoot,
      referenceRoot,
      emitEvents: false,
    });
    assert.equal(result.status, 1);
    assert.match(result.combined, /missing source/);
  } finally {
    rmSync(docsRoot, { recursive: true, force: true });
    rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test("edge: scaffold gate fails without OWNERSHIP.md", () => {
  const siteRoot = mkdtempSync(path.join(tmpdir(), "sutra-docs-site-scaffold-"));
  try {
    mkdirSync(path.join(siteRoot, ".vitepress"), { recursive: true });
    writeFileSync(path.join(siteRoot, "index.md"), "# hi\n");
    writeFileSync(path.join(siteRoot, ".vitepress", "config.mts"), "export default {}\n");
    const result = validateDocsSiteScaffold({ siteRoot });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.OWNERSHIP_MISSING),
    );
  } finally {
    rmSync(siteRoot, { recursive: true, force: true });
  }
});

test("sovereignty: ownership forbids publishing raw learner content via sync", () => {
  const ownership = readFileSync(path.join(DOCS_SITE_ROOT, "OWNERSHIP.md"), "utf8");
  assert.match(ownership, /never publish raw learner/i);
  assert.match(ownership, /no runtime subject payloads/i);
});

test("ci workflow and root scripts wire docs-site check", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-docs-site\.mjs/);
  assert.match(ci, /prove-docs-site-gate\.mjs/);
  assert.match(ci, /check-docs-site\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(pkg.scripts["docs-site:api"], "pnpm --filter @moolam/docs-site docs:api");
  assert.equal(pkg.scripts["docs-site:check"], "node scripts/check-docs-site.mjs");
  assert.equal(pkg.scripts["docs-site:prove"], "node scripts/prove-docs-site-gate.mjs");
  assert.equal(pkg.scripts["docs-site:sync"], "pnpm --filter @moolam/docs-site docs:sync");
  assert.equal(pkg.scripts["docs-site:build"], "pnpm --filter @moolam/docs-site docs:build");

  const docsReadme = readFileSync(DOCS_README, "utf8");
  assert.match(docsReadme, /docs-site/);
  assert.match(docsReadme, /TypeDoc|\/api\//);
});

test("prove gate red→green for docs-site scaffold", () => {
  const result = runDocsSiteProve();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});

test("check syncs reference tree with generated marker", () => {
  const result = runDocsSiteCheck({ skipBuild: true, emitEvents: false });
  assert.equal(result.status, 0, result.combined);
  assert.ok(existsSync(path.join(DOCS_SITE_ROOT, "reference", ".generated")));
  assert.ok(existsSync(path.join(DOCS_SITE_ROOT, "reference", "overview.md")));
  assert.ok(
    existsSync(path.join(DOCS_SITE_ROOT, "reference", "protocol", "index.md")) ||
      existsSync(path.join(DOCS_SITE_ROOT, "reference", "protocol", "README.md")),
  );
});
