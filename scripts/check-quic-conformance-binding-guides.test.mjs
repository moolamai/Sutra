/**
 * Unit tests for QUIC-002 conformance + binding certification guides.
 * Run: node --test scripts/check-quic-conformance-binding-guides.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINDING_CANONICAL,
  BINDING_LANDING,
  CONFORMANCE_CANONICAL,
  CONFORMANCE_LANDING,
  OBLIGATIONS,
  runQuicConformanceBindingGuidesCheck,
  validateQuicConformanceBindingGuides,
} from "./check-quic-conformance-binding-guides.mjs";
import { runQuicConformanceBindingGuidesProve } from "./prove-quic-conformance-binding-guides-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");
const SDK_README = path.join(REPO_ROOT, "docs", "sdk", "README.md");

test("happy path: both guides exist and validate", () => {
  assert.ok(existsSync(CONFORMANCE_CANONICAL));
  assert.ok(existsSync(BINDING_CANONICAL));
  assert.ok(existsSync(CONFORMANCE_LANDING));
  assert.ok(existsSync(BINDING_LANDING));

  const result = runQuicConformanceBindingGuidesCheck({
    emitEvents: false,
    now: new Date("2026-07-16T12:00:00Z"),
  });
  assert.equal(result.status, 0, result.combined);

  const conf = readFileSync(CONFORMANCE_CANONICAL, "utf8");
  assert.match(conf, /runConformance/);
  assert.match(conf, /pnpm exec conformance/);
  assert.match(conf, /subjectId/);

  const bind = readFileSync(BINDING_CANONICAL, "utf8");
  assert.match(bind, /CK-03/);
  assert.match(bind, /egressRecord/);
  assert.match(bind, /Pass \(green\)|Fail \(red\)/);
});

test("edge: missing canonical fails with named obligation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-quic2-miss-"));
  try {
    const result = validateQuicConformanceBindingGuides({
      conformanceCanonical: path.join(dir, "no-c.md"),
      bindingCanonical: path.join(dir, "no-b.md"),
      conformanceLanding: path.join(dir, "lc.md"),
      bindingLanding: path.join(dir, "lb.md"),
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.violations.some((v) => v.obligation === OBLIGATIONS.MISSING_CANONICAL),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: concurrent + idempotent guidance present", () => {
  const conf = readFileSync(CONFORMANCE_CANONICAL, "utf8");
  assert.match(conf, /[Cc]oncurrent/);
  assert.match(conf, /idempotent/i);
  const bind = readFileSync(BINDING_CANONICAL, "utf8");
  assert.match(bind, /idempotent/i);
  assert.match(bind, /Partial failure|partial failure/i);
});

test("sovereignty: no raw learner content; subject-scoped", () => {
  const conf = readFileSync(CONFORMANCE_CANONICAL, "utf8");
  assert.match(conf, /never (put )?raw learner|synthetic `probe\.\*`/i);
  assert.match(conf, /Cross-subject|cross-subject/i);
  const bind = readFileSync(BINDING_CANONICAL, "utf8");
  assert.match(bind, /never.*utterance|no content bodies/i);
  assert.match(bind, /subjectId/);
  assert.match(bind, /on-device|zero.?egress/i);
});

test("links: public checklist + cross-guides; no package src leaks", () => {
  const conf = readFileSync(CONFORMANCE_CANONICAL, "utf8");
  const bind = readFileSync(BINDING_CANONICAL, "utf8");
  assert.match(conf, /CERTIFIED-BINDING\.md/);
  assert.match(conf, /binding-certification-guide\.md/);
  assert.match(bind, /CERTIFIED-BINDING\.md/);
  assert.match(bind, /conformance-stub-guide\.md/);
  assert.doesNotMatch(conf, /packages\/[a-z0-9-]+\/src\//i);
  assert.doesNotMatch(bind, /packages\/[a-z0-9-]+\/src\//i);

  const sdk = readFileSync(SDK_README, "utf8");
  assert.match(sdk, /conformance-stub-guide\.md/);
  assert.match(sdk, /binding-certification-guide\.md/);
});

test("ci and root scripts wire quic guides check", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-quic-conformance-binding-guides\.mjs/);
  assert.match(ci, /prove-quic-conformance-binding-guides-gate\.mjs/);
  assert.match(ci, /check-quic-conformance-binding-guides\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["quic-guides:check"],
    "node scripts/check-quic-conformance-binding-guides.mjs",
  );
  assert.equal(
    pkg.scripts["quic-guides:prove"],
    "node scripts/prove-quic-conformance-binding-guides-gate.mjs",
  );
});

test("prove gate red→green", () => {
  const result = runQuicConformanceBindingGuidesProve();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});

test("edge: forged guide with package src path is rejected", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-quic2-leak-"));
  try {
    const c = path.join(dir, "c.md");
    const b = path.join(dir, "b.md");
    const lc = path.join(dir, "lc.md");
    const lb = path.join(dir, "lb.md");
    writeFileSync(
      c,
      [
        "Verified: 2026-07-16",
        "pnpm exec conformance --self-check",
        "createStubMemoryHarnessFactory runConformance subjectId",
        "Concurrent idempotent",
        "never put raw learner synthetic `probe.*`",
        "packages/foo/src/bar.ts",
        "binding-certification-guide.md CERTIFIED-BINDING.md",
        "exit **0**",
        "",
      ].join("\n"),
    );
    writeFileSync(
      b,
      [
        "Verified: 2026-07-16",
        "pnpm --filter sutra-bindings-slm run certify",
        "CK-03.1 egressRecord Pass (green) Fail (red)",
        "subjectId idempotent Partial failure",
        "never embed utterance no content bodies",
        "packages/bar/src/x.ts",
        "conformance-stub-guide.md CERTIFIED-BINDING.md",
        "",
      ].join("\n"),
    );
    writeFileSync(lc, "conformance-stub-guide\n");
    writeFileSync(lb, "binding-certification-guide\n");
    const result = validateQuicConformanceBindingGuides({
      conformanceCanonical: c,
      bindingCanonical: b,
      conformanceLanding: lc,
      bindingLanding: lb,
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
