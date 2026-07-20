/**
 * Shared loaders for CI workflow self-tests (PR + nightly).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const CI_PR_WORKFLOW = path.join(REPO_ROOT, ".github/workflows/ci.yml");
export const CI_NIGHTLY_WORKFLOW = path.join(
  REPO_ROOT,
  ".github/workflows/ci-nightly.yml",
);

/** GitHub PR check job ids (8). */
export const PR_CHECK_JOB_IDS = Object.freeze([
  "dco",
  "build-test-typescript",
  "build-test-python",
  "protocol-conformance",
  "architecture-docs",
  "security-supply-chain",
  "release-readiness",
  "integrations-scaffolds",
]);

export function loadPrCi() {
  return readFileSync(CI_PR_WORKFLOW, "utf8").replace(/\r\n/g, "\n");
}

export function loadNightlyCi() {
  return readFileSync(CI_NIGHTLY_WORKFLOW, "utf8").replace(/\r\n/g, "\n");
}

export function loadAllCi() {
  return `${loadPrCi()}\n${loadNightlyCi()}`;
}

export function extractJobBlock(yml, jobId) {
  const header = `  ${jobId}:\n`;
  const start = yml.indexOf(header);
  assert.ok(start >= 0, `missing CI job: ${jobId}`);
  const fromJob = yml.slice(start);
  const next = fromJob.slice(header.length).search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? fromJob : fromJob.slice(0, header.length + next);
}

export function extractJobFromPrOrNightly(jobId) {
  const pr = loadPrCi();
  if (pr.includes(`  ${jobId}:\n`)) {
    return extractJobBlock(pr, jobId);
  }
  return extractJobBlock(loadNightlyCi(), jobId);
}
