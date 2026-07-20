/**
 * Consistency checks for the implementor conformance quickstart .
 * Ensures the governance doc stays aligned with real commands / exports.
 *
 * Run: node --test scripts/check-conformance-quickstart.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const QUICKSTART = path.join(REPO_ROOT, "docs/sdk/conformance-quickstart.md");
const PKG_README = path.join(
  REPO_ROOT,
  "packages/contract-conformance/README.md",
);
const SDK_README = path.join(REPO_ROOT, "docs/sdk/README.md");

test("quickstart doc exists", () => {
  assert.equal(existsSync(QUICKSTART), true);
});

test("happy path: quickstart documents install → factory → run → verdicts", () => {
  const body = readFileSync(QUICKSTART, "utf8");
  assert.match(body, /pnpm install --frozen-lockfile/);
  assert.match(body, /pnpm conformance/);
  assert.match(body, /runConformance/);
  assert.match(body, /createMemoryDurabilityIsolationRegistry/);
  assert.match(body, /formatHumanReport/);
  assert.match(body, /subjectId/);
  assert.match(body, /15-minute|15 minute|15 min/i);
  assert.match(body, /obligationId/);
  assert.match(body, /MUST/);
});

test("edge: package README and SDK README link the quickstart", () => {
  const pkg = readFileSync(PKG_README, "utf8");
  const sdk = readFileSync(SDK_README, "utf8");
  assert.match(pkg, /conformance-quickstart\.md/);
  assert.match(sdk, /conformance-quickstart\.md/);
});

test("edge: quickstart names the CI prove seed obligation", () => {
  const body = readFileSync(QUICKSTART, "utf8");
  assert.match(body, /CK-02\.1/);
  assert.match(body, /conformance:prove/);
  assert.match(body, /never plaintext|never raw|synthetic `probe\.\*`/i);
});
