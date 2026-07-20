/**
 * Unit tests for version lockstep CI gate.
 * Run from repo root: node --test scripts/check-version-lockstep.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLiveVersionValues, DISTRIBUTION_TRUTH_SOURCES } from "./check-version-lockstep-doc.mjs";
import {
  OBLIGATIONS,
  collectVersionLockstepSnapshot,
  formatUnifiedDiff,
  runVersionLockstepGate,
  validateVersionLockstep,
} from "./check-version-lockstep.mjs";
import { runVersionLockstepProve } from "./prove-version-lockstep-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

test("happy path: protocol and distribution lockstep satisfied", () => {
  const live = readLiveVersionValues();
  const result = runVersionLockstepGate({ emitEvents: false });
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.canonical, live.sdk_npm);
  assert.equal(live.protocol_ts, live.orchestrator_init_protocol);
});

test("edge: pyproject drift fails with unified diff and path", () => {
  const live = readLiveVersionValues();
  const drifted = { ...live, orchestrator_pyproject: "9.9.9" };
  const result = runVersionLockstepGate({ liveValues: drifted, emitEvents: false });
  assert.equal(result.status, 1);
  assert.ok(result.diff?.includes("packages/cloud-orchestrator/pyproject.toml"));
  assert.ok(result.diff?.includes("--- lockstep/distribution"));
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.VERSION_MISMATCH),
  );
});

test("edge: missing PROTOCOL_VERSION fails with source path", () => {
  const live = readLiveVersionValues();
  const broken = { ...live, protocol_ts: "" };
  const result = runVersionLockstepGate({ liveValues: broken, emitEvents: false });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.SOURCE_MISSING),
  );
  assert.ok(
    result.violations.some((v) => v.path?.includes("contract.ts")),
  );
});

test("formatUnifiedDiff marks offending entries with !", () => {
  const entries = [
    { path: "packages/sync-protocol/package.json", value: "0.1.0" },
    { path: "packages/cloud-orchestrator/pyproject.toml", value: "9.9.9" },
  ];
  const diff = formatUnifiedDiff(entries, "0.1.0");
  assert.match(diff, /! packages\/cloud-orchestrator\/pyproject\.toml: 9\.9\.9/);
  assert.match(diff, /-packages\/cloud-orchestrator\/pyproject\.toml: 9\.9\.9/);
  assert.match(diff, /\+packages\/cloud-orchestrator\/pyproject\.toml: 0\.1\.0/);
});

test("validateVersionLockstep returns canonical on match", () => {
  const snapshot = collectVersionLockstepSnapshot(DISTRIBUTION_TRUTH_SOURCES);
  const result = validateVersionLockstep(snapshot);
  assert.equal(result.status, 0);
  assert.equal(result.canonical, snapshot.entries[0].value);
});

test("gate emits structured event on success", () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = runVersionLockstepGate({
      subjectId: "lockstep-subject",
      deviceId: "lockstep-device",
    });
    assert.equal(result.status, 0);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const gateEvent = events.find((e) => e.event === "version.lockstep.gate");
    assert.ok(gateEvent);
    assert.equal(gateEvent.outcome, "ok");
    assert.equal(gateEvent.subjectId, "lockstep-subject");
    assert.equal(gateEvent.canonical, readLiveVersionValues().sdk_npm);
  } finally {
    process.stdout.write = origWrite;
  }
});

test("prove gate red→green on seeded pyproject drift", () => {
  const result = runVersionLockstepProve();
  assert.equal(result.status, 0, result.combined);
});

test("edge: distribution semver may differ from wire PROTOCOL_VERSION", () => {
  const live = readLiveVersionValues();
  if (live.protocol_ts === live.sdk_npm) {
    return;
  }
  const result = runVersionLockstepGate({ liveValues: live, emitEvents: false });
  assert.equal(result.status, 0, result.combined);
});

test("edge: pyproject drift from sdk npm fails distribution lockstep", () => {
  const live = readLiveVersionValues();
  const drifted = { ...live, orchestrator_pyproject: "0.0.0", orchestrator_init_version: "0.0.0" };
  const result = runVersionLockstepGate({ liveValues: drifted, emitEvents: false });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.VERSION_MISMATCH),
  );
});

test("ci workflow runs version lockstep gate on main merges", () => {
  const text = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(text, /check-version-lockstep\.mjs|version:lockstep/);
  assert.match(text, /prove-version-lockstep-gate\.mjs|version:lockstep:prove/);
  assert.match(text, /version:lockstep/);
});
