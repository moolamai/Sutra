/**
 * Unit tests for implementor quickstart governance gate.
 * Run: node --test scripts/check-implementor-quickstart.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL,
  OBLIGATIONS,
  SITE_LANDING,
  runImplementorQuickstartCheck,
  validateImplementorQuickstart,
} from "./check-implementor-quickstart.mjs";
import { runImplementorQuickstartProve } from "./prove-implementor-quickstart-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");
const SDK_README = path.join(REPO_ROOT, "docs", "sdk", "README.md");
const PKG_SDK_README = path.join(REPO_ROOT, "packages", "sdk", "README.md");

test("happy path: canonical guide covers install → turn → sync", () => {
  assert.ok(existsSync(CANONICAL));
  assert.ok(existsSync(SITE_LANDING));
  const result = runImplementorQuickstartCheck({
    emitEvents: false,
    now: new Date("2026-07-16T12:00:00Z"),
  });
  assert.equal(result.status, 0, result.combined);

  const body = readFileSync(CANONICAL, "utf8");
  assert.match(body, /create-sutra/);
  assert.match(body, /npm install/);
  assert.match(body, /npm run smoke/);
  assert.match(body, /syncAttemptId/);
  assert.match(body, /subjectId/);
});

test("edge: missing canonical fails with named obligation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-quic-miss-"));
  try {
    const result = validateImplementorQuickstart({
      canonicalPath: path.join(dir, "nope.md"),
      siteLandingPath: path.join(dir, "landing.md"),
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.MISSING_CANONICAL),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: concurrent-turn and idempotent sync guidance required", () => {
  const body = readFileSync(CANONICAL, "utf8");
  assert.match(body, /[Cc]oncurrent turns/);
  assert.match(body, /idempotent/i);
  assert.match(body, /Partial failure|partial failure/);
});

test("sovereignty: no raw learner content; subject-scoped sync refuse", () => {
  const body = readFileSync(CANONICAL, "utf8");
  assert.match(body, /never (put |log )?raw learner|no utterance body/i);
  assert.match(body, /Cross-subject|cross-subject|subject mismatch/i);
  assert.match(body, /on-device|self-hosted/);
});

test("links: conformance + certification public docs; no src/ package leaks", () => {
  const body = readFileSync(CANONICAL, "utf8");
  assert.match(body, /conformance-quickstart\.md/);
  assert.match(body, /CERTIFIED-BINDING\.md/);
  assert.doesNotMatch(body, /packages\/[a-z0-9-]+\/src\//i);

  const sdk = readFileSync(SDK_README, "utf8");
  assert.match(sdk, /implementor-quickstart\.md/);
  const pkg = readFileSync(PKG_SDK_README, "utf8");
  assert.match(pkg, /implementor-quickstart\.md/);
});

test("ci and root scripts wire implementor quickstart check", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-implementor-quickstart\.mjs/);
  assert.match(ci, /prove-implementor-quickstart-gate\.mjs/);
  assert.match(ci, /check-implementor-quickstart\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["implementor-quickstart:check"],
    "node scripts/check-implementor-quickstart.mjs",
  );
  assert.equal(
    pkg.scripts["implementor-quickstart:prove"],
    "node scripts/prove-implementor-quickstart-gate.mjs",
  );
});

test("prove gate red→green", () => {
  const result = runImplementorQuickstartProve();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});

test("edge: forged guide with package src path is rejected", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-quic-leak-"));
  try {
    const canonical = path.join(dir, "guide.md");
    const landing = path.join(dir, "landing.md");
    writeFileSync(
      canonical,
      [
        "# x",
        "Verified: 2026-07-16",
        "create-sutra npm install npm run smoke npm run typecheck",
        "subjectId syncAttemptId postSync Concurrent turns idempotent",
        "never put raw learner content",
        "See packages/foo/src/bar.ts",
        "[c](./conformance-quickstart.md)",
        "[b](../bindings/CERTIFIED-BINDING.md)",
        "[p](../protocol/README.md)",
        "",
      ].join("\n"),
    );
    writeFileSync(
      landing,
      "→ [Full guide](/reference/sdk/implementor-quickstart)\n",
    );
    const result = validateImplementorQuickstart({
      canonicalPath: canonical,
      siteLandingPath: landing,
      now: new Date("2026-07-16T12:00:00Z"),
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.MONOREPO_PATH_LEAK),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
