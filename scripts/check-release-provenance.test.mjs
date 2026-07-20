/**
 * Unit tests for release provenance gate and publish wrapper policy.
 * Run from repo root: node --test scripts/check-release-provenance.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NPM_PROD_REGISTRY,
  OBLIGATIONS,
  loadReleaseWorkflow,
  resolveProvenanceForPublish,
  runReleaseProvenanceGate,
  validateReleaseProvenanceConfig,
} from "./check-release-provenance.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKLIST = path.join(REPO_ROOT, "docs", "sdk", "PUBLISH-CHECKLIST.md");

test("happy path: committed release workflow satisfies provenance gate", () => {
  const workflow = loadReleaseWorkflow();
  const checklist = readFileSync(CHECKLIST, "utf8");
  const result = validateReleaseProvenanceConfig(workflow, checklist);
  assert.equal(result.status, 0, result.violations.map((v) => v.detail).join("; "));
});

test("edge: workflow missing id-token write fails gate", () => {
  const workflow = loadReleaseWorkflow().replace(/id-token:\s*write\n?/m, "");
  const result = validateReleaseProvenanceConfig(workflow, readFileSync(CHECKLIST, "utf8"));
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.ID_TOKEN_PERMISSION),
  );
});

test("edge: production registry publish requires CI for provenance", () => {
  const prev = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try {
    const resolved = resolveProvenanceForPublish({
      dryRun: false,
      registry: NPM_PROD_REGISTRY,
    });
    assert.equal(resolved.enabled, false);
    assert.ok(resolved.violation);
    assert.equal(resolved.violation.obligation, "provenance.publish.ci_only");
  } finally {
    if (prev === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prev;
  }
});

test("provenance disabled for scratch registry and dry-run", () => {
  assert.equal(
    resolveProvenanceForPublish({
      dryRun: true,
      registry: NPM_PROD_REGISTRY,
    }).enabled,
    false,
  );
  assert.equal(
    resolveProvenanceForPublish({
      dryRun: false,
      registry: "https://npm.pkg.github.com",
    }).enabled,
    false,
  );
});

test("gate emits structured event on success", () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = runReleaseProvenanceGate({
      subjectId: "prov-subject",
      deviceId: "prov-device",
    });
    assert.equal(result.status, 0);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const gateEvent = events.find((e) => e.event === "release.provenance.gate");
    assert.ok(gateEvent);
    assert.equal(gateEvent.outcome, "ok");
    assert.equal(gateEvent.subjectId, "prov-subject");
  } finally {
    process.stdout.write = origWrite;
  }
});

test("publish wrapper policy: dry-run never enables provenance", () => {
  const provenance = resolveProvenanceForPublish({
    dryRun: true,
    registry: NPM_PROD_REGISTRY,
  });
  assert.equal(provenance.enabled, false);
  assert.equal(provenance.reason, "dry-run");
});
