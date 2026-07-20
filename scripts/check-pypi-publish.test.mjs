/**
 * Unit tests for PyPI publish and rehearsal install gates.
 * Run from repo root: node --test scripts/check-pypi-publish.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS as PUBLISH_OBLIGATIONS,
  PYPI_PROD_UPLOAD_URL,
  PYPI_TEST_UPLOAD_URL,
  resolvePyPiPublishTarget,
  resolveTwineCredentials,
  runPypiPublish,
} from "./run-pypi-publish.mjs";
import {
  IMPORT_PROBE,
  OBLIGATIONS as REHEARSAL_OBLIGATIONS,
  parsePackageVersion,
  runPypiRehearsalInstallFromLocalDist,
  runPypiRehearsalInstallFromTestPyPI,
} from "./verify-pypi-rehearsal-install.mjs";
import { runPypiPublishProve } from "./prove-pypi-publish-gate.mjs";
import { loadPyproject } from "./check-pypi-wheel-pipeline.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "release.yml");

test("happy path: rehearsal tag resolves to TestPyPI upload", () => {
  const target = resolvePyPiPublishTarget({
    publishEnabled: true,
    allowProd: false,
    refName: "v0.1.0-rehearsal.1",
  });
  assert.equal(target.upload, true);
  assert.equal(target.registry, "testpypi");
  assert.equal(target.repositoryUrl, PYPI_TEST_UPLOAD_URL);
});

test("edge: production PyPI without allow flag is blocked", () => {
  const target = resolvePyPiPublishTarget({
    publishEnabled: true,
    allowProd: false,
    refName: "v1.0.0",
    requestedRegistry: "pypi",
  });
  assert.ok(target.violation);
  assert.equal(target.violation.obligation, PUBLISH_OBLIGATIONS.PROD_WITHOUT_FLAG);
});

test("edge: TestPyPI upload requires TEST_PYPI_API_TOKEN", () => {
  const saved = process.env.TEST_PYPI_API_TOKEN;
  delete process.env.TEST_PYPI_API_TOKEN;
  try {
    const creds = resolveTwineCredentials("testpypi");
    assert.equal(creds.ok, false);
    assert.equal(creds.obligation, PUBLISH_OBLIGATIONS.CREDENTIALS_MISSING);
  } finally {
    if (saved !== undefined) {
      process.env.TEST_PYPI_API_TOKEN = saved;
    }
  }
});

test("edge: TestPyPI rehearsal install fails when version is missing", () => {
  const result = runPypiRehearsalInstallFromTestPyPI({
    version: "",
    emitEvents: false,
    cleanup: true,
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === REHEARSAL_OBLIGATIONS.VERSION_MISSING),
  );
});

test("dry-run publish builds and twine-checks without upload", () => {
  const result = runPypiPublish({
    dryRun: true,
    emitEvents: false,
  });
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.phase, "dry-run");
});

test("local-dist rehearsal install imports PROTOCOL_VERSION after wheel build", () => {
  const build = runPypiPublish({ dryRun: true, emitEvents: false });
  assert.equal(build.status, 0, build.combined);

  const result = runPypiRehearsalInstallFromLocalDist({
    subjectId: "pypi-rehearsal-subject",
    deviceId: "pypi-rehearsal-device",
    emitEvents: false,
    cleanup: true,
  });
  assert.equal(result.status, 0, result.combined);
});

test("parsePackageVersion reads pyproject version", () => {
  const version = parsePackageVersion(loadPyproject());
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("publish dry-run emits structured event with subjectId", () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = runPypiPublish({
      dryRun: true,
      subjectId: "pypi-publish-subject",
      deviceId: "pypi-publish-device",
    });
    assert.equal(result.status, 0);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const publishEvent = events.find((e) => e.event === "pypi.publish");
    assert.ok(publishEvent);
    assert.equal(publishEvent.outcome, "ok");
    assert.equal(publishEvent.subjectId, "pypi-publish-subject");
  } finally {
    process.stdout.write = origWrite;
  }
});

test("prove gate red→green on production policy violation", () => {
  const result = runPypiPublishProve();
  assert.equal(result.status, 0, result.combined);
});

test("release workflow wires PyPI publish and TestPyPI rehearsal install", () => {
  const text = readFileSync(RELEASE_WORKFLOW, "utf8");
  assert.match(text, /run-pypi-publish\.mjs/);
  assert.match(text, /verify-pypi-rehearsal-install\.mjs --from-testpypi/);
  assert.match(text, /TEST_PYPI_API_TOKEN/);
  assert.match(text, /PYPI_ALLOW_PROD_PUBLISH/);
  assert.match(text, /pypi-rehearsal-release\/rehearsal-run\.json/);
  assert.match(text, /actions\/setup-python@v5/);
});
