/**
 * Unit tests for create-sutra CI matrix / verify gate.
 * Run from repo root: node --test scripts/check-create-sutra-matrix.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOMAIN_PACKS,
  STORAGE_DRIVERS,
  TRANSPORTS,
} from "../tools/create-sutra/lib/choices.mjs";
import {
  CI_PINNED,
  OBLIGATIONS,
  SCAFFOLD_VERIFY_MATRIX,
  formatMatrixCellLabel,
  matrixCellSubjectId,
  runCreateSutraScaffoldVerifyMatrix,
} from "./verify-create-sutra-scaffold.mjs";
import { runCreateSutraVerifyProve } from "./prove-create-sutra-verify-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { extractJobBlock, loadPrCi } from "./ci-workflow-test-helpers.mjs";
const PKG_JSON = path.join(REPO_ROOT, "package.json");

test("happy path: matrix covers every domain pack with memory storage", () => {
  assert.ok(SCAFFOLD_VERIFY_MATRIX.length >= 4);
  const domains = new Set(SCAFFOLD_VERIFY_MATRIX.map((c) => c.domainPack));
  for (const id of Object.keys(DOMAIN_PACKS)) {
    assert.ok(domains.has(id), `matrix missing domain pack: ${id}`);
  }
  for (const cell of SCAFFOLD_VERIFY_MATRIX) {
    assert.ok(STORAGE_DRIVERS[cell.storageDriver], cell.id);
    assert.ok(TRANSPORTS[cell.transport], cell.id);
    assert.equal(cell.storageDriver, "memory");
    assert.match(formatMatrixCellLabel(cell), new RegExp(cell.id));
  }
  const transports = new Set(SCAFFOLD_VERIFY_MATRIX.map((c) => c.transport));
  assert.ok(transports.has("offline"));
  assert.ok(transports.has("http"));
});

test("edge: empty matrix fails with named obligation and printed detail", () => {
  const result = runCreateSutraScaffoldVerifyMatrix({
    matrix: [],
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.MATRIX_EMPTY),
  );
  assert.match(result.combined, /empty matrix/i);
});

test("edge: CI pins pnpm and Node versions (lockfile/tool drift guard)", () => {
  const ci = loadPrCi();
  assert.match(ci, new RegExp(`version:\\s*${CI_PINNED.pnpm}`));
  assert.match(ci, new RegExp(`node-version:\\s*${CI_PINNED.nodeMajor}\\b`));

  const integrationsJob =
    extractJobBlock(ci, "integrations-scaffolds");
  assert.match(integrationsJob, new RegExp(`version:\\s*${CI_PINNED.pnpm}`));
  assert.match(integrationsJob, new RegExp(`node-version:\\s*${CI_PINNED.nodeMajor}\\b`));
  assert.match(integrationsJob, /pnpm install --frozen-lockfile/);
});

test("sovereignty: each matrix cell gets a distinct subjectId", () => {
  const ids = SCAFFOLD_VERIFY_MATRIX.map((c) => matrixCellSubjectId(c));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^create-sutra-matrix-/);
  }
});

test("ci workflow runs create-sutra verify matrix and prove gate", () => {
  const text = loadPrCi();
  assert.match(text, /verify-create-sutra-scaffold\.mjs --matrix/);
  assert.match(text, /prove-create-sutra-verify-gate\.mjs/);
  assert.match(text, /check-create-sutra-matrix\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["create-sutra:verify:matrix"],
    "node scripts/verify-create-sutra-scaffold.mjs --matrix",
  );
  assert.equal(
    pkg.scripts["create-sutra:verify:prove"],
    "node scripts/prove-create-sutra-verify-gate.mjs",
  );
});

test("prove gate red→green for verify matrix seeds", () => {
  const result = runCreateSutraVerifyProve();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});
