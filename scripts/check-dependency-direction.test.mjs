/**
 * Unit tests for dependency-direction boundary rules .
 * Run: node --test scripts/check-dependency-direction.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RULE_IDS,
  DEFAULT_CRUISE_PATHS,
  VIOLATION_REPORT_LIMIT,
  extractViolations,
  formatViolationEdges,
  runDependencyDirectionGate,
  runSeededDependencyViolation,
  scanTrainingForHarnessReimplementation,
} from "./check-dependency-direction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const config = require(path.join(REPO_ROOT, ".dependency-cruiser.cjs"));

test("happy path: current tree passes dependency-direction rules", async () => {
  const result = await runDependencyDirectionGate({
    subjectId: "subj-deps-unit-happy",
    deviceId: "dev-deps-unit",
    emitEvents: false,
  });
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.violations.length, 0);
  assert.ok(DEFAULT_CRUISE_PATHS.includes("packages"));
  assert.ok(DEFAULT_CRUISE_PATHS.includes("training"));
});

test("config encodes CK-01 + anti-cheat boundary rules with type-only edges enabled", () => {
  const names = new Set(config.forbidden.map((r) => r.name));
  assert.ok(names.has(RULE_IDS.CONTRACTS_IMPORT_NOTHING));
  assert.ok(names.has(RULE_IDS.NO_IMPORT_DOMAINS));
  assert.ok(names.has(RULE_IDS.NO_RELATIVE_CROSS_PACKAGE));
  assert.ok(names.has(RULE_IDS.ANTI_CHEAT_GYM_FORBIDDEN_PKG));
  assert.ok(names.has(RULE_IDS.ANTI_CHEAT_NO_RELATIVE_HARNESS_SRC));
  assert.equal(config.RULE_IDS.ANTI_CHEAT_HARNESS_REIMPL, RULE_IDS.ANTI_CHEAT_HARNESS_REIMPL);
  assert.equal(config.options.tsPreCompilationDeps, true);
  assert.equal(config.RULE_IDS.CONTRACTS_IMPORT_NOTHING, RULE_IDS.CONTRACTS_IMPORT_NOTHING);
});

test("edge: seeded type-only import into contracts fails with file and edge", async () => {
  const seeded = await runSeededDependencyViolation("contracts-type-only");
  assert.equal(seeded.status, 1, seeded.combined);
  const hit = seeded.violations.find(
    (v) =>
      v.rule === RULE_IDS.CONTRACTS_IMPORT_NOTHING && /zod/i.test(`${v.to}`),
  );
  assert.ok(hit, `expected type-only zod edge in ${seeded.edgeText}`);
  assert.match(hit.from, /packages[/\\]contracts[/\\]src[/\\]index\.ts/);
  assert.match(formatViolationEdges([hit]), /→/);
});

test("edge: seeded domains/ import fails with file and edge", async () => {
  const seeded = await runSeededDependencyViolation("domains");
  assert.equal(seeded.status, 1, seeded.combined);
  const hit = seeded.violations.find((v) => v.rule === RULE_IDS.NO_IMPORT_DOMAINS);
  assert.ok(hit, `expected ${RULE_IDS.NO_IMPORT_DOMAINS} in ${seeded.edgeText}`);
  assert.match(hit.from, /leak\.ts/);
  assert.match(hit.to, /domains/);
});

test("edge: seeded relative cross-package deep-import fails with file and edge", async () => {
  const seeded = await runSeededDependencyViolation("relative-cross-package");
  assert.equal(seeded.status, 1, seeded.combined);
  const hit = seeded.violations.find(
    (v) => v.rule === RULE_IDS.NO_RELATIVE_CROSS_PACKAGE,
  );
  assert.ok(
    hit,
    `expected ${RULE_IDS.NO_RELATIVE_CROSS_PACKAGE} in ${seeded.edgeText}`,
  );
  assert.match(hit.from, /escape\.ts/);
  assert.match(hit.to, /cognitive-core/);
});

test("edge: seeded gym import of non-harness package fails", async () => {
  const seeded = await runSeededDependencyViolation("gym-forbidden-package");
  assert.equal(seeded.status, 1, seeded.combined);
  const hit = seeded.violations.find(
    (v) => v.rule === RULE_IDS.ANTI_CHEAT_GYM_FORBIDDEN_PKG,
  );
  assert.ok(
    hit,
    `expected ${RULE_IDS.ANTI_CHEAT_GYM_FORBIDDEN_PKG} in ${seeded.edgeText}`,
  );
  assert.match(hit.from, /fork_path\.mjs/);
  assert.match(hit.to, /cognitive-core/);
});

test("edge: seeded relative deep-import of runtime-harness/src fails", async () => {
  const seeded = await runSeededDependencyViolation(
    "training-relative-harness-src",
  );
  assert.equal(seeded.status, 1, seeded.combined);
  const hit = seeded.violations.find(
    (v) => v.rule === RULE_IDS.ANTI_CHEAT_NO_RELATIVE_HARNESS_SRC,
  );
  assert.ok(
    hit,
    `expected ${RULE_IDS.ANTI_CHEAT_NO_RELATIVE_HARNESS_SRC} in ${seeded.edgeText}`,
  );
  assert.match(hit.from, /deep_import\.mjs/);
  assert.match(hit.to, /runtime-harness[/\\]src/);
});

test("edge: seeded local ToolCallParser under training/ fails content-scan", async () => {
  const seeded = await runSeededDependencyViolation("harness-reimplementation");
  assert.equal(seeded.status, 1, seeded.combined);
  const hit = seeded.violations.find(
    (v) => v.rule === RULE_IDS.ANTI_CHEAT_HARNESS_REIMPL,
  );
  assert.ok(
    hit,
    `expected ${RULE_IDS.ANTI_CHEAT_HARNESS_REIMPL} in ${seeded.edgeText}`,
  );
  assert.match(hit.from, /local_parser\.mjs/);
  assert.equal(hit.to, "ToolCallParser");
});

test("happy path: live training/ has no harness reimplementation symbols", () => {
  const scanned = scanTrainingForHarnessReimplementation(REPO_ROOT);
  assert.equal(
    scanned.violations.length,
    0,
    formatViolationEdges(scanned.violations),
  );
});

test("sovereignty / subject-isolation: gate events carry subjectId and deviceId", async () => {
  const result = await runDependencyDirectionGate({
    subjectId: "subj-iso-a",
    deviceId: "dev-iso-a",
    emitEvents: false,
  });
  assert.equal(result.subjectId, "subj-iso-a");
  assert.equal(result.deviceId, "dev-iso-a");
  assert.notEqual(result.subjectId, "subj-iso-b");
});

test("scalability: violation report is bounded", () => {
  const many = Array.from({ length: VIOLATION_REPORT_LIMIT + 20 }, (_, i) => ({
    source: `f${i}.ts`,
    dependencies: [
      {
        module: `m${i}`,
        resolved: `r${i}`,
        rules: [{ name: "x", severity: "error" }],
      },
    ],
  }));
  const extracted = extractViolations({ modules: many });
  assert.ok(extracted.length <= VIOLATION_REPORT_LIMIT);
});
