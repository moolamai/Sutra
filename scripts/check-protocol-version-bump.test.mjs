/**
 * Unit tests for PROTOCOL_VERSION bump CI gate.
 * Run from repo root: node --test scripts/check-protocol-version-bump.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  BASELINE_PATH,
  CHANGELOG_PATH,
  collectWireShapeSnapshot,
  formatBaselineDocument,
  loadBaseline,
  validateProtocolVersionBump,
  runProtocolVersionBumpGate,
  changelogMentionsTypes,
  recordWireShapeBaseline,
} from "./check-protocol-version-bump.mjs";
import {
  proveProtocolVersionBumpGate,
  SEED_FIELD,
} from "./prove-protocol-version-bump-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

test("happy path: committed baseline matches live wire shape", () => {
  const events = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const text = String(chunk);
    if (text.includes("protocol.version_bump.gate")) {
      events.push(JSON.parse(text));
    }
    return origWrite(chunk, ...rest);
  };
  try {
    const result = runProtocolVersionBumpGate();
    assert.equal(result.status, 0, result.combined);
    assert.equal(result.violations.length, 0);
    const gateEvent = events.find((e) => e.event === "protocol.version_bump.gate");
    assert.ok(gateEvent);
    assert.equal(gateEvent.outcome, "ok");
    assert.equal(gateEvent.subjectId, "protocol-version-bump");
    assert.equal(gateEvent.deviceId, "ci");
  } finally {
    process.stdout.write = origWrite;
  }
});

test("edge: unlogged wire field addition requires PROTOCOL_VERSION bump + prints diff", () => {
  const live = collectWireShapeSnapshot();
  const baseline = formatBaselineDocument(live);
  const seeded = structuredClone(live);
  // Simulate hash change on SyncAdvisory without bumping version.
  seeded.types.SyncAdvisory = "0".repeat(64);
  seeded.canons.SyncAdvisory = {
    ...live.canons.SyncAdvisory,
    properties: {
      ...live.canons.SyncAdvisory.properties,
      [SEED_FIELD]: { type: "string" },
    },
  };

  const result = validateProtocolVersionBump({
    snapshot: seeded,
    baseline,
    changelogText: readFileSync(CHANGELOG_PATH, "utf8"),
  });

  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.VERSION_BUMP_REQUIRED),
  );
  assert.match(result.diff ?? "", /SyncAdvisory/);
  assert.match(result.diff ?? "", /^--- /m);
  assert.match(result.diff ?? "", /^\+\+\+ /m);
  assert.match(result.combined, /without PROTOCOL_VERSION bump/);
});

test("edge: wire change with version bump but missing CHANGELOG type name fails", () => {
  const live = collectWireShapeSnapshot();
  const baseline = formatBaselineDocument(live);
  const seeded = structuredClone(live);
  seeded.protocolVersion = "9.9.9";
  seeded.types.FrictionSample = "f".repeat(64);

  const result = validateProtocolVersionBump({
    snapshot: seeded,
    baseline,
    changelogText: "## [Unreleased]\n\n### Added\n\n- unrelated note without type name\n",
  });

  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.CHANGELOG_REQUIRED),
  );
  assert.match(result.combined, /FrictionSample/);
});

test("edge: version bump without shape change fails closed", () => {
  const live = collectWireShapeSnapshot();
  const baseline = formatBaselineDocument(live);
  const seeded = { ...live, protocolVersion: "9.9.9" };

  const result = validateProtocolVersionBump({
    snapshot: seeded,
    baseline,
    changelogText: readFileSync(CHANGELOG_PATH, "utf8"),
  });

  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.VERSION_WITHOUT_SHAPE),
  );
  assert.match(result.diff ?? "", /PROTOCOL_VERSION/);
});

test("edge: empty / cross-subject scope stays metadata-only on failure events", () => {
  const events = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const text = String(chunk);
    if (text.includes("protocol.version_bump.gate")) {
      events.push(JSON.parse(text));
    }
    return origWrite(chunk, ...rest);
  };
  try {
    const live = collectWireShapeSnapshot();
    const baseline = formatBaselineDocument(live);
    const seeded = structuredClone(live);
    seeded.types.SyncRequest = "a".repeat(64);

    const result = runProtocolVersionBumpGate({
      snapshot: seeded,
      baseline,
      changelogText: "## [Unreleased]\n",
      subjectId: "",
      deviceId: "ci-device",
    });
    assert.equal(result.status, 1);
    const gateEvent = events.find((e) => e.event === "protocol.version_bump.gate");
    assert.ok(gateEvent);
    assert.equal(gateEvent.outcome, "fail");
    assert.equal(gateEvent.subjectId, "");
    assert.equal(gateEvent.deviceId, "ci-device");
    assert.equal("utterance" in gateEvent, false);
    assert.equal("content" in gateEvent, false);
  } finally {
    process.stdout.write = origWrite;
  }
});

test("changelogMentionsTypes requires Unreleased coverage", () => {
  const text = readFileSync(CHANGELOG_PATH, "utf8");
  const ok = changelogMentionsTypes(text, ["SyncAdvisory"]);
  assert.equal(ok.ok, true);
  const miss = changelogMentionsTypes("## [Unreleased]\n\n- nothing\n", [
    "SyncAdvisory",
  ]);
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.missing, ["SyncAdvisory"]);
});

test("ci workflow runs PROTOCOL_VERSION bump gate + prove", () => {
  const ci = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(ci, /check-protocol-version-bump\.mjs/);
  assert.match(ci, /prove-protocol-version-bump-gate\.mjs/);
  assert.match(ci, /PROTOCOL_VERSION bump gate/);
});

test("prove gate: intentionally broken schema turns red; revert turns green", () => {
  // Ensure baseline file exists for subprocess prove.
  assert.ok(loadBaseline(BASELINE_PATH), "wire-shape-baseline.json must exist");
  const result = proveProtocolVersionBumpGate();
  assert.equal(result.ok, true, result.failures.join("\n\n"));
  assert.ok(result.phases.some((p) => p.phase === "seeded_red" && p.status !== 0));
  assert.ok(result.phases.some((p) => p.phase === "reverted_green" && p.status === 0));
});

test("record helper is idempotent with live snapshot", () => {
  const before = loadBaseline(BASELINE_PATH);
  const recorded = recordWireShapeBaseline(BASELINE_PATH);
  const after = loadBaseline(BASELINE_PATH);
  assert.deepEqual(recorded, before);
  assert.deepEqual(after, before);
});
