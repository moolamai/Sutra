/**
 * CI wiring checks for the dependency-direction lint job .
 *
 * Ensures the root CI job cruises packages/playground/examples/training, pins
 * tool versions, and never fails silently (file→edge + prove red→green).
 *
 * Run: node --test scripts/check-dependency-direction-ci.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CRUISE_PATHS,
  RULE_IDS,
  runDependencyDirectionGate,
  runSeededDependencyViolation,
  formatViolationEdges,
} from "./check-dependency-direction.mjs";

import {
  PR_CHECK_JOB_IDS,
  extractJobBlock,
  loadPrCi,
} from "./ci-workflow-test-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PKG_JSON = path.join(REPO_ROOT, "package.json");

/** Jobs that must remain in the PR workflow (required check set). */
export const REQUIRED_CI_JOBS = PR_CHECK_JOB_IDS;

test("happy path: dependency-direction job is in the required CI set", () => {
  const yml = loadPrCi();
  for (const job of REQUIRED_CI_JOBS) {
    assert.match(yml, new RegExp(`^  ${job}:`, "m"), `required job missing: ${job}`);
  }
  const block = extractJobBlock(yml, "architecture-docs");
  assert.match(block, /pnpm deps:lint/);
  assert.match(block, /pnpm deps:lint:prove/);
  assert.match(
    block,
    /check-dependency-direction\.test\.mjs/,
  );
  assert.match(block, /Dependency direction gate/);
});

test("edge: pnpm version is pinned (lockfile/tool drift guard)", () => {
  const block = extractJobBlock(loadPrCi(), "architecture-docs");
  assert.match(block, /pnpm\/action-setup@v4/);
  assert.match(block, /version:\s*10\.30\.3/);
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.match(block, /node-version:\s*22/);
});

test("edge: root lint wires deps:lint; cruise covers packages/playground/examples/training", () => {
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.match(pkg.scripts.lint, /deps:lint/);
  assert.equal(pkg.scripts["deps:lint"], "node scripts/check-dependency-direction.mjs");
  assert.deepEqual([...DEFAULT_CRUISE_PATHS].sort(), [
    "examples",
    "packages",
    "playground",
    "training",
  ]);
});

test("happy path: gate is green and emits subject-scoped outcome", async () => {
  const result = await runDependencyDirectionGate({
    subjectId: "subj-ci-gate-happy",
    deviceId: "dev-ci-gate",
    emitEvents: false,
  });
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.subjectId, "subj-ci-gate-happy");
  assert.equal(result.deviceId, "dev-ci-gate");
  assert.notEqual(result.subjectId, "subj-other");
});

test("edge: seeded violation fails loudly with file and edge (never bare boolean)", async () => {
  const seeded = await runSeededDependencyViolation("domains");
  assert.equal(seeded.status, 1);
  assert.ok(seeded.edgeText.length > 0);
  assert.match(seeded.edgeText, new RegExp(RULE_IDS.NO_IMPORT_DOMAINS));
  assert.match(seeded.edgeText, /→/);
  assert.match(seeded.edgeText, /domains/);
  const line = formatViolationEdges(seeded.violations);
  assert.notEqual(line, "false");
  assert.notEqual(line, "true");
});
