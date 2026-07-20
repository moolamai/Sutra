/**
 * Unit tests for changeset config gate and version-bump wrapper.
 * Run from repo root: node --test scripts/check-changeset-config.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHANGESET_CONFIG_PATH,
  DEFAULT_IGNORED_PACKAGES,
  listPublicMoolamPackages,
  loadChangesetConfig,
  runChangesetConfigGate,
  validateChangesetConfig,
} from "./check-changeset-config.mjs";
import { runChangesetVersion } from "./run-changeset-version.mjs";

test("happy path: repo config covers every public @moolam/* package", () => {
  const config = loadChangesetConfig();
  const publicPackages = listPublicMoolamPackages();
  const result = validateChangesetConfig(config, publicPackages);
  assert.equal(result.status, 0, result.violations.map((v) => v.detail).join("; "));
  assert.equal(result.lockstepPackages.length, publicPackages.length);
  for (const pkg of publicPackages) {
    assert.ok(result.lockstepPackages.includes(pkg), `missing ${pkg}`);
  }
});

test("edge: publishable package missing from fixed group fails gate", () => {
  const config = loadChangesetConfig();
  const publicPackages = listPublicMoolamPackages();
  const broken = {
    ...config,
    fixed: [config.fixed[0].filter((name) => name !== publicPackages[0])],
  };
  const result = validateChangesetConfig(broken, publicPackages);
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some(
      (v) =>
        v.obligation === "changeset.fixed.package" &&
        v.detail.includes(publicPackages[0]),
    ),
  );
});

test("edge: publishable package in ignore list fails gate", () => {
  const config = loadChangesetConfig();
  const publicPackages = listPublicMoolamPackages();
  const victim = publicPackages[0];
  const broken = {
    ...config,
    ignore: [...config.ignore, victim],
  };
  const result = validateChangesetConfig(broken, publicPackages);
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some(
      (v) =>
        v.obligation === "changeset.ignore.publishable" && v.detail.includes(victim),
    ),
  );
});

test("edge: non-publishable workspace package not ignored fails gate", () => {
  const config = loadChangesetConfig();
  const broken = {
    ...config,
    ignore: config.ignore.filter((name) => name !== "@moolam/examples"),
  };
  const result = validateChangesetConfig(broken);
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === "changeset.ignore.workspace"),
  );
});

test("version-bump wrapper dry-run passes config gate and emits event", () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = runChangesetVersion({
      dryRun: true,
      subjectId: "test-subject",
      deviceId: "test-device",
    });
    assert.equal(result.status, 0);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const versionEvent = events.find((e) => e.event === "changeset.version");
    assert.ok(versionEvent);
    assert.equal(versionEvent.outcome, "ok");
    assert.equal(versionEvent.subjectId, "test-subject");
    assert.equal(versionEvent.deviceId, "test-device");
    assert.equal(versionEvent.phase, "dry-run");
  } finally {
    process.stdout.write = origWrite;
  }
});

test("config gate emits structured event on success", () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = runChangesetConfigGate({
      subjectId: "gate-subject",
      deviceId: "gate-device",
    });
    assert.equal(result.status, 0);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const gateEvent = events.find((e) => e.event === "changeset.config.gate");
    assert.ok(gateEvent);
    assert.equal(gateEvent.outcome, "ok");
    assert.equal(gateEvent.subjectId, "gate-subject");
    assert.equal(gateEvent.deviceId, "gate-device");
  } finally {
    process.stdout.write = origWrite;
  }
});

test("committed config file is valid JSON with required ignore entries", () => {
  const config = JSON.parse(readFileSync(CHANGESET_CONFIG_PATH, "utf8"));
  for (const pkg of DEFAULT_IGNORED_PACKAGES) {
    assert.ok(config.ignore.includes(pkg), `ignore missing ${pkg}`);
  }
  assert.equal(config.access, "public");
  assert.equal(config.commit, false);
});
