/**
 * Unit tests for integration templates CI matrix.
 * Run: node --test scripts/check-integration-templates-matrix.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CI_PINNED,
  INTEGRATION_TEMPLATE_MATRIX,
  OBLIGATIONS,
  formatMatrixCellLabel,
  matrixCellSubjectId,
  resolveMatrixCells,
  runIntegrationTemplatesMatrix,
} from "./verify-integration-templates-matrix.mjs";
import { runIntegrationTemplatesMatrixProve } from "./prove-integration-templates-matrix-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { extractJobBlock, loadPrCi } from "./ci-workflow-test-helpers.mjs";
const PKG_JSON = path.join(REPO_ROOT, "package.json");

test("happy path: matrix covers edge-app, node-service, fastapi-adapter", () => {
  assert.equal(INTEGRATION_TEMPLATE_MATRIX.length, 3);
  const ids = INTEGRATION_TEMPLATE_MATRIX.map((c) => c.id);
  assert.deepEqual(ids, ["edge-app", "node-service", "fastapi-adapter"]);
  assert.ok(INTEGRATION_TEMPLATE_MATRIX.some((c) => c.needsPython));
  assert.ok(INTEGRATION_TEMPLATE_MATRIX.some((c) => !c.needsPython));
  for (const cell of INTEGRATION_TEMPLATE_MATRIX) {
    assert.match(formatMatrixCellLabel(cell), new RegExp(cell.id));
  }
});

test("edge: empty matrix fails with named obligation and printed detail", () => {
  const result = runIntegrationTemplatesMatrix({
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

test("edge: unknown template fails with named obligation", () => {
  const result = runIntegrationTemplatesMatrix({
    template: "nope",
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some(
      (v) => v.obligation === OBLIGATIONS.MATRIX_UNKNOWN_TEMPLATE,
    ),
  );
});

test("edge: CI pins pnpm and Node versions (lockfile/tool drift guard)", () => {
  const ci = loadPrCi();
  const job = extractJobBlock(ci, "integrations-scaffolds");
  assert.match(job, new RegExp(`version:\\s*${CI_PINNED.pnpm}`));
  assert.match(job, new RegExp(`node-version:\\s*${CI_PINNED.nodeMajor}\\b`));
  assert.match(job, /pnpm install --frozen-lockfile/);
  assert.match(job, /--template=edge-app/);
  assert.match(job, /--template=node-service/);
  assert.match(job, /--template=fastapi-adapter/);
});

test("sovereignty: each matrix cell gets a distinct subjectId", () => {
  const ids = INTEGRATION_TEMPLATE_MATRIX.map((c) => matrixCellSubjectId(c));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^integration-matrix-/);
  }
});

test("resolveMatrixCells: single template filter", () => {
  const cells = resolveMatrixCells({ template: "node-service" });
  assert.equal(cells.length, 1);
  assert.equal(cells[0].id, "node-service");
});

test("ci workflow and package scripts wire matrix gate", () => {
  const text = loadPrCi();
  assert.match(text, /verify-integration-templates-matrix\.mjs/);
  assert.match(text, /prove-integration-templates-matrix-gate\.mjs/);
  assert.match(text, /check-integration-templates-matrix\.test\.mjs/);
  assert.match(text, /--template=/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["integration:templates:verify:matrix"],
    "node scripts/verify-integration-templates-matrix.mjs --matrix",
  );
  assert.equal(
    pkg.scripts["integration:templates:verify:prove"],
    "node scripts/prove-integration-templates-matrix-gate.mjs",
  );
});

test("prove gate red→green for integration templates matrix", () => {
  const result = runIntegrationTemplatesMatrixProve();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});
