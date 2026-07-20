/**
 * Unit tests for PyPI wheel pipeline gate.
 * Run from repo root: node --test scripts/check-pypi-wheel-pipeline.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  PYPROJECT_PATH,
  REQUIRED_URLS,
  loadPyproject,
  parseProjectUrls,
  runPypiWheelPipelineGate,
  validatePyprojectMetadata,
} from "./check-pypi-wheel-pipeline.mjs";
import { runPypiWheelPipelineProve } from "./prove-pypi-wheel-pipeline-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

test("happy path: committed pyproject has required urls and hatchling config", () => {
  const text = loadPyproject();
  const result = validatePyprojectMetadata(text);
  assert.equal(result.status, 0, result.violations.map((v) => v.detail).join("; "));
  for (const key of REQUIRED_URLS) {
    assert.ok(result.urls[key], `missing url ${key}`);
  }
});

test("edge: missing project.urls section fails metadata gate", () => {
  const text = loadPyproject().replace(/\[project\.urls\][\s\S]*?(?=\n\[project\.optional-dependencies\])/, "");
  const result = validatePyprojectMetadata(text);
  assert.equal(result.status, 1);
  assert.ok(result.violations.some((v) => v.obligation === OBLIGATIONS.URLS_MISSING));
});

test("edge: non-hatchling build backend fails metadata gate", () => {
  const text = loadPyproject().replace(
    'build-backend = "hatchling.build"',
    'build-backend = "setuptools.build_meta"',
  );
  const result = validatePyprojectMetadata(text);
  assert.equal(result.status, 1);
  assert.ok(result.violations.some((v) => v.obligation === OBLIGATIONS.BUILD_BACKEND));
});

test("parseProjectUrls extracts Homepage Repository Documentation", () => {
  const urls = parseProjectUrls(loadPyproject());
  assert.match(urls.Homepage, /github\.com\/moolamai\/sutra/);
  assert.match(urls.Repository, /github\.com\/moolamai\/sutra/);
  assert.match(urls.Documentation, /cloud-orchestrator/);
});

test("prove gate red→green on seeded metadata violation", () => {
  const result = runPypiWheelPipelineProve();
  assert.equal(result.status, 0, result.combined);
});

test("metadata-only gate emits structured event on success", () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = runPypiWheelPipelineGate({
      metadataOnly: true,
      subjectId: "pypi-subject",
      deviceId: "pypi-device",
    });
    assert.equal(result.status, 0);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const gateEvent = events.find((e) => e.event === "pypi.wheel.pipeline.gate");
    assert.ok(gateEvent);
    assert.equal(gateEvent.outcome, "ok");
    assert.equal(gateEvent.subjectId, "pypi-subject");
  } finally {
    process.stdout.write = origWrite;
  }
});

test("ci workflow runs pypi wheel pipeline gate on main merges", () => {
  const text = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(text, /check-pypi-wheel-pipeline\.mjs/);
  assert.match(text, /python -m build/);
  assert.match(text, /twine check/);
});
