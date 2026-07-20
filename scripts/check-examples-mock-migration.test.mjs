/**
 * Examples must consume @moolam/contract-mocks, not a local duplicate.
 * Run: node --test scripts/check-examples-mock-migration.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXAMPLES = path.join(REPO_ROOT, "examples");

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkJs(full, out);
    else if (/\.(mjs|js|md)$/.test(name)) out.push(full);
  }
  return out;
}

test("happy path: duplicated examples/_shared/mocks.mjs is removed", () => {
  assert.equal(
    existsSync(path.join(EXAMPLES, "_shared", "mocks.mjs")),
    false,
    "examples/_shared/mocks.mjs must be deleted after migration",
  );
});

test("happy path: example mains import @moolam/contract-mocks where bindings are needed", () => {
  const mains = [
    "teacher-basic/main.mjs",
    "lawyer-basic/main.mjs",
    "vision/main.mjs",
    "voice/main.mjs",
    "custom-domain/main.mjs",
    "memory/main.mjs",
    "offline-edge/main.mjs",
  ];
  for (const rel of mains) {
    const src = readFileSync(path.join(EXAMPLES, rel), "utf8");
    assert.match(
      src,
      /from ["']@moolam\/contract-mocks["']/,
      `${rel} must import @moolam/contract-mocks`,
    );
  }
});

test("edge: no example source reintroduces _shared/mocks imports", () => {
  const offenders = [];
  for (const file of walkJs(EXAMPLES)) {
    const src = readFileSync(file, "utf8");
    if (/_shared\/mocks\.mjs/.test(src) || /examples\/_shared\/mocks/.test(src)) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("edge: examples package declares workspace dependency on contract-mocks", () => {
  const pkg = JSON.parse(
    readFileSync(path.join(EXAMPLES, "package.json"), "utf8"),
  );
  assert.equal(pkg.dependencies["@moolam/contract-mocks"], "workspace:*");
});
