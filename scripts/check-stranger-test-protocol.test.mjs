/**
 * Unit tests for stranger-test protocol gate.
 * Run: node --test scripts/check-stranger-test-protocol.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  PROTOCOL_PATH,
  SITE_LANDING,
  listFindingsFiles,
  runStrangerTestProtocolCheck,
  validateStrangerTestProtocol,
} from "./check-stranger-test-protocol.mjs";
import { runStrangerTestProtocolProve } from "./prove-stranger-test-protocol-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");
const CREATE_SUTRA = path.join(
  REPO_ROOT,
  "tools",
  "create-sutra",
  "bin",
  "create-sutra.mjs",
);

test("happy path: protocol + findings + site landing", () => {
  assert.ok(existsSync(PROTOCOL_PATH));
  assert.ok(existsSync(SITE_LANDING));
  assert.ok(listFindingsFiles().length >= 1);

  const result = runStrangerTestProtocolCheck({ emitEvents: false });
  assert.equal(result.status, 0, result.combined);

  const protocol = readFileSync(PROTOCOL_PATH, "utf8");
  assert.match(protocol, /no monorepo/i);
  assert.match(protocol, /no Slack/i);
  assert.match(protocol, /Recording template/i);
  assert.match(protocol, /8 hours|≤ 8 h/i);
});

test("edge: missing protocol fails with named obligation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-stranger-miss-"));
  try {
    const result = validateStrangerTestProtocol({
      protocolPath: path.join(dir, "nope.md"),
      findingsDir: dir,
      siteLandingPath: path.join(dir, "landing.md"),
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.MISSING_PROTOCOL),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: findings without friction IDs fail", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-stranger-friction-"));
  try {
    writeFileSync(
      path.join(dir, "PROTOCOL.md"),
      [
        "8 hours one calendar day no monorepo no Slack",
        "Success criteria smoke Recording template Friction log",
        "Tester brief Observe only no coaching subjectId",
        "idempotent syncAttemptId Restart",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(dir, "landing.md"), "stranger PROTOCOL\n");
    writeFileSync(
      path.join(dir, "FINDINGS-2099-01-01.md"),
      [
        "Active wall-clock 1",
        "Outcome pass",
        "subjectId demo",
        "docs_site.stranger_test",
        "no raw learner utterance body",
        "Friction log (empty)",
        "",
      ].join("\n"),
    );
    const result = validateStrangerTestProtocol({
      protocolPath: path.join(dir, "PROTOCOL.md"),
      findingsDir: dir,
      siteLandingPath: path.join(dir, "landing.md"),
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.MISSING_FRICTION),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: findings record subjectId and no utterance bodies", () => {
  const latest = listFindingsFiles().at(-1);
  assert.ok(latest);
  const body = readFileSync(
    path.join(path.dirname(PROTOCOL_PATH), latest),
    "utf8",
  );
  assert.match(body, /subjectId/);
  assert.match(body, /utterance body|no raw learner/i);
  assert.match(body, /docs_site\.stranger_test/);
});

test("executed session recorded restart/idempotency notes", () => {
  const latest = listFindingsFiles().at(-1);
  const body = readFileSync(
    path.join(path.dirname(PROTOCOL_PATH), latest),
    "utf8",
  );
  assert.match(body, /[Rr]estart/);
  assert.match(body, /idempotent|syncAttemptId/i);
  assert.match(body, /F-001/);
});

test("create-sutra CLI parses (F-001 regression)", () => {
  const src = readFileSync(CREATE_SUTRA, "utf8");
  // Parentheses required so `.trim() || default` is not a SyntaxError.
  assert.match(
    src,
    /\(\(await rl\.question\(`Output directory/,
  );
});

test("ci and root scripts wire stranger-test check", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-stranger-test-protocol\.mjs/);
  assert.match(ci, /prove-stranger-test-protocol-gate\.mjs/);
  assert.match(ci, /check-stranger-test-protocol\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["stranger-test:check"],
    "node scripts/check-stranger-test-protocol.mjs",
  );
  assert.equal(
    pkg.scripts["stranger-test:prove"],
    "node scripts/prove-stranger-test-protocol-gate.mjs",
  );
});

test("prove gate red→green", () => {
  const result = runStrangerTestProtocolProve();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});
