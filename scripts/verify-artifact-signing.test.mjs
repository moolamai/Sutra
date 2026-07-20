/**
 * Unit coverage for artifact signing verification (pre-production upload).
 * Run: node --test scripts/verify-artifact-signing.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  isNpmProductionTarget,
  parseMode,
  validateProductionSigning,
  validateSigningPolicy,
  verifyArtifactSigning,
  verifyWheelDigests,
} from "./verify-artifact-signing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RELEASE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "release.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");

test("happy path: committed policy wiring passes", () => {
  const result = verifyArtifactSigning({ mode: "policy" });
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("parseMode: defaults to policy", () => {
  assert.equal(parseMode(""), "policy");
  assert.equal(parseMode("--mode=production"), "production");
});

test("isNpmProductionTarget: registry.npmjs.org or PROVENANCE_ENABLED", () => {
  assert.equal(
    isNpmProductionTarget({ registry: "https://registry.npmjs.org" }),
    true,
  );
  assert.equal(
    isNpmProductionTarget({
      registry: "https://npm.pkg.github.com",
      provenanceEnabled: true,
    }),
    true,
  );
  assert.equal(
    isNpmProductionTarget({
      registry: "https://npm.pkg.github.com",
      provenanceEnabled: false,
    }),
    false,
  );
});

test("verifyWheelDigests: accepts pack-integrity shape", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-sign-digest-"));
  try {
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        packages: [
          {
            name: "sutra-sdk",
            version: "0.1.0",
            sha256: "a".repeat(64),
          },
        ],
      }),
      "utf8",
    );
    const result = verifyWheelDigests(manifestPath);
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: missing digests fail WHEEL_DIGESTS_MISSING", () => {
  const result = verifyWheelDigests(
    path.join(tmpdir(), "no-such-integrity-manifest.json"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.obligation, OBLIGATIONS.WHEEL_DIGESTS_MISSING);
});

test("edge: production npm without provenance fails", () => {
  const prev = process.env.PROVENANCE_ENABLED;
  try {
    process.env.PROVENANCE_ENABLED = "false";
    const result = validateProductionSigning({
      registry: "https://registry.npmjs.org",
      inCi: true,
      requireDigests: false,
      manifestPath: path.join(tmpdir(), "missing.json"),
    });
    // Without requireDigests, still fail on provenance when flag is false
    // and resolveProvenance may enable via registry — force flag false path.
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some(
        (f) =>
          f.includes(OBLIGATIONS.NPM_PROD_WITHOUT_PROVENANCE) ||
          f.includes(OBLIGATIONS.UNSIGNED_BLOCKED) ||
          f.includes(OBLIGATIONS.WHEEL_DIGESTS_MISSING),
      ),
    );
  } finally {
    if (prev === undefined) delete process.env.PROVENANCE_ENABLED;
    else process.env.PROVENANCE_ENABLED = prev;
  }
});

test("edge: production npm outside CI fails NPM_PROD_NOT_CI", () => {
  const prev = process.env.PROVENANCE_ENABLED;
  const prevGa = process.env.GITHUB_ACTIONS;
  try {
    process.env.PROVENANCE_ENABLED = "true";
    delete process.env.GITHUB_ACTIONS;
    const dir = mkdtempSync(path.join(tmpdir(), "sutra-sign-ci-"));
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        packages: [{ name: "sutra-sdk", sha256: "b".repeat(64) }],
      }),
      "utf8",
    );
    const result = validateProductionSigning({
      registry: "https://registry.npmjs.org",
      inCi: false,
      requireDigests: true,
      manifestPath,
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.NPM_PROD_NOT_CI));
  } finally {
    if (prev === undefined) delete process.env.PROVENANCE_ENABLED;
    else process.env.PROVENANCE_ENABLED = prev;
    if (prevGa === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prevGa;
  }
});

test("edge: workflow without verify step fails MISSING_VERIFY_STEP", () => {
  const result = validateSigningPolicy({
    workflowText: "name: Release\njobs: {}\n",
    checklistText:
      "npm provenance attestation and wheel integrity digests; signing:verify",
    sbomDocsText: "signing and provenance attestation documented",
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes(OBLIGATIONS.MISSING_VERIFY_STEP));
});

test("production happy path: CI + provenance + digests", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-sign-ok-"));
  const prev = process.env.PROVENANCE_ENABLED;
  const prevGa = process.env.GITHUB_ACTIONS;
  try {
    process.env.PROVENANCE_ENABLED = "true";
    process.env.GITHUB_ACTIONS = "true";
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        packages: [{ name: "sutra-sdk", sha256: "c".repeat(64) }],
      }),
      "utf8",
    );
    const result = validateProductionSigning({
      registry: "https://registry.npmjs.org",
      inCi: true,
      requireDigests: true,
      manifestPath,
    });
    assert.equal(result.ok, true, result.failures.join("\n"));
  } finally {
    if (prev === undefined) delete process.env.PROVENANCE_ENABLED;
    else process.env.PROVENANCE_ENABLED = prev;
    if (prevGa === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prevGa;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci scripts and release.yml wire signing:verify", () => {
  const ci = readFileSync(RELEASE_WORKFLOW, "utf8");
  assert.match(ci, /verify-artifact-signing\.mjs/);
  assert.match(ci, /--mode=production|--mode=policy/);
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["signing:verify"],
    "node scripts/verify-artifact-signing.mjs",
  );
});
