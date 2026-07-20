/**
 * Keep-a-Changelog baseline consistency for @moolam/sync-protocol.
 *
 * Happy path: CHANGELOG documents the live package version + Unreleased, linked from README.
 * Edge: every committed schemas/*.json type is named in a release section.
 * Edge: contributor docs (package README + root CONTRIBUTING) require Unreleased updates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const CHANGELOG = path.join(PKG_ROOT, "CHANGELOG.md");
const README = path.join(PKG_ROOT, "README.md");
const PACKAGE_JSON = path.join(PKG_ROOT, "package.json");
const SCHEMAS_DIR = path.join(PKG_ROOT, "schemas");
const CONTRIBUTING = path.join(REPO_ROOT, "CONTRIBUTING.md");

/** @param {string} text */
function sectionAfter(text, heading) {
  const idx = text.indexOf(heading);
  if (idx < 0) return "";
  const rest = text.slice(idx + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

test("happy path: Keep-a-Changelog baseline exists and matches package version", async () => {
  const text = await readFile(CHANGELOG, "utf8");
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  const currentVer = pkg.version.replace(/\./g, "\\.");

  assert.match(text, /Keep a Changelog/i);
  assert.match(text, /^## \[Unreleased\]/m);
  assert.match(text, new RegExp(`^## (?:\\[)?${currentVer}(?:\\])?`, "m"));
  assert.match(text, /^## (?:\[)?1\.0\.0(?:\])?/m);
  assert.match(text, /^## \[0\.1\.0\]/m);
  assert.match(text, /CognitiveState/);
  assert.match(text, /SyncRequest/);
  assert.match(text, /SyncResponse/);
  assert.match(text, /protocolVersion/);

  const readme = await readFile(README, "utf8");
  assert.match(readme, /CHANGELOG\.md/);
  assert.match(readme, /\[Unreleased\]/);
});

test("edge: release sections name every committed wire schema type", async () => {
  const text = await readFile(CHANGELOG, "utf8");
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  const documented = [
    sectionAfter(text, "## [Unreleased]"),
    sectionAfter(text, `## ${pkg.version}`),
    sectionAfter(text, `## [${pkg.version}]`),
    sectionAfter(text, "## 1.0.0"),
    sectionAfter(text, "## [1.0.0]"),
    sectionAfter(text, "## [0.1.0]"),
  ].join("\n");
  assert.ok(documented.trim(), "missing changelog release sections");

  const entries = await readdir(SCHEMAS_DIR);
  const types = entries
    .filter((f) => f.endsWith(".json") && f !== "wire-shape-baseline.json")
    .map((f) => f.replace(/\.json$/, ""));
  assert.ok(types.length >= 8, "expected committed wire schemas");
  for (const typeName of types) {
    const named = new RegExp(`\\b${typeName}\\b`);
    assert.ok(
      named.test(documented),
      `CHANGELOG must document schema type ${typeName} in Unreleased or a release section`,
    );
  }
});

test("edge: Unreleased is wired into contributor docs (no silent schema churn)", async () => {
  const contributing = await readFile(CONTRIBUTING, "utf8");
  assert.match(contributing, /packages\/sync-protocol\/CHANGELOG\.md/);
  assert.match(contributing, /\[Unreleased\]/);

  // Sovereignty proxy: changelog never claims to ship learner content or
  // cross-subject reads — it documents wire shape only.
  const changelog = await readFile(CHANGELOG, "utf8");
  assert.doesNotMatch(changelog, /\bexfiltrat/i);
  assert.match(changelog, /subject/i);
});
