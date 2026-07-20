/**
 * Unit tests for stranger-test triage gate.
 * Run: node --test scripts/check-stranger-test-triage.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  P7_ENTRIES_PATH,
  TRIAGE_PATH,
  runStrangerTestTriageCheck,
  validateStrangerTestTriage,
} from "./check-stranger-test-triage.mjs";
import { runStrangerTestTriageProve } from "./prove-stranger-test-triage-gate.mjs";
import { runImplementorQuickstartCheck } from "./check-implementor-quickstart.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");

test("happy path: triage closes P0/P1 with P7 deferrals", () => {
  assert.ok(existsSync(TRIAGE_PATH));
  assert.ok(existsSync(P7_ENTRIES_PATH));
  const result = runStrangerTestTriageCheck({ emitEvents: false });
  assert.equal(result.status, 0, result.combined);

  const triage = readFileSync(TRIAGE_PATH, "utf8");
  assert.match(triage, /F-001/);
  assert.match(triage, /P7-RFC-INTENT-001/);
  assert.match(triage, /P7-RFC-INTENT-002/);
  assert.match(triage, /Closed/);
});

test("edge: missing triage file fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-triage-miss-"));
  try {
    const result = validateStrangerTestTriage({
      triagePath: path.join(dir, "nope.md"),
      p7Path: path.join(dir, "p7.md"),
      implementorPath: path.join(dir, "i.md"),
      sitePath: path.join(dir, "s.md"),
      createSutraPath: path.join(dir, "c.mjs"),
      findingsDir: dir,
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.MISSING_TRIAGE),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: implementor quickstart documents scratch + observability", () => {
  const qs = runImplementorQuickstartCheck({
    emitEvents: false,
    now: new Date("2026-07-16T12:00:00Z"),
  });
  assert.equal(qs.status, 0, qs.combined);
});

test("sovereignty: triage event and findings keep subjectId / no content bodies", () => {
  const triage = readFileSync(TRIAGE_PATH, "utf8");
  assert.match(triage, /docs_site\.stranger_test\.triage/);
  assert.match(triage, /subjectId/);
  assert.doesNotMatch(triage, /utterance\s*:/);
});

test("p7 entries are explicit and not silent waivers", () => {
  const p7 = readFileSync(P7_ENTRIES_PATH, "utf8");
  assert.match(p7, /P7-RFC-INTENT-001/);
  assert.match(p7, /P7-RFC-INTENT-002/);
  assert.match(p7, /not waived/i);
  assert.match(p7, /Deferred to P7/i);
});

test("ci and root scripts wire stranger-test triage", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-stranger-test-triage\.mjs/);
  assert.match(ci, /prove-stranger-test-triage-gate\.mjs/);
  assert.match(ci, /check-stranger-test-triage\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["stranger-test:triage:check"],
    "node scripts/check-stranger-test-triage.mjs",
  );
  assert.equal(
    pkg.scripts["stranger-test:triage:prove"],
    "node scripts/prove-stranger-test-triage-gate.mjs",
  );
});

test("prove gate red→green", () => {
  const result = runStrangerTestTriageProve();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});
