/**
 * Turn trajectory v1 — committed schema export + golden round-trip fixtures.
 * Run: pnpm --filter @moolam/telemetry test (after sync-protocol schemas:export + build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRAJECTORY_FORBIDDEN_CONTENT_KEYS,
  TRAJECTORY_FORMAT_GOLDEN_FIXTURES_RELPATH,
  TRAJECTORY_FORMAT_GOLDEN_MANIFEST,
  TRAJECTORY_FORMAT_VERSION,
  TURN_TRAJECTORY_V1_COMMITTED_SCHEMA_RELPATH,
  assertTrajectorySchemaPrivacy,
  assertTurnTrajectoryExportConsent,
  emitTrajectoryObservability,
  enqueueTurnTrajectoryWrite,
  parseTurnTrajectoryV1,
  toTurnTrajectoryJsonSchema,
  turnTrajectoryV1Schema,
} from "../dist/index.js";
import { PROTOCOL_VERSION } from "@moolam/sync-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const REPO_ROOT = join(PKG, "..", "..");
const FIXTURE_ROOT = join(PKG, TRAJECTORY_FORMAT_GOLDEN_FIXTURES_RELPATH);
const COMMITTED_SCHEMA = join(
  REPO_ROOT,
  "packages",
  "sync-protocol",
  TURN_TRAJECTORY_V1_COMMITTED_SCHEMA_RELPATH,
);

function loadJson(relPath) {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, relPath), "utf8"));
}

const manifest = loadJson(TRAJECTORY_FORMAT_GOLDEN_MANIFEST);

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "telemetry.trajectory.fixture", ...event })}\n`,
  );
}

test("manifest documents goldens, violation, and committed schema path", () => {
  assert.equal(manifest.schemaVersion, TRAJECTORY_FORMAT_VERSION);
  assert.equal(manifest.committedSchema, TURN_TRAJECTORY_V1_COMMITTED_SCHEMA_RELPATH);
  assert.ok(manifest.goldens.length >= 2);
  assert.ok(manifest.violations.length >= 1);
  assert.ok(
    manifest.violations.some((v) => v.forbiddenKey === "keystrokes"),
  );
});

test("committed TurnTrajectoryV1.json matches exporter helper + privacy gate", () => {
  const committed = JSON.parse(readFileSync(COMMITTED_SCHEMA, "utf8"));
  const fromHelper = toTurnTrajectoryJsonSchema(PROTOCOL_VERSION);

  assert.equal(committed.title, "TurnTrajectoryV1");
  assert.equal(committed["x-protocol-version"], PROTOCOL_VERSION);
  assert.equal(
    committed["x-trajectory-format-version"],
    TRAJECTORY_FORMAT_VERSION,
  );
  assert.equal(fromHelper.title, committed.title);
  assert.equal(
    fromHelper["x-trajectory-format-version"],
    committed["x-trajectory-format-version"],
  );

  const privacy = assertTrajectorySchemaPrivacy(committed);
  assert.equal(privacy.ok, true);
  for (const key of TRAJECTORY_FORBIDDEN_CONTENT_KEYS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(committed.properties ?? {}, key),
      `committed schema must not declare property ${key}`,
    );
  }
  log({
    outcome: "ok",
    case: "committed_schema",
    subjectId: null,
    deviceId: "test",
  });
});

for (const entry of manifest.goldens) {
  test(`golden round-trip: ${entry.id}`, () => {
    const raw = loadJson(entry.file);
    const parsed = parseTurnTrajectoryV1(raw);
    assert.equal(parsed.ok, true, parsed.ok === false ? parsed.detail : "");
    assert.equal(parsed.record.locality, entry.locality);
    assert.equal(parsed.record.stages.length, entry.expectStageCount);
    assert.equal(parsed.record.toolCalls.length, entry.expectToolCallCount);
    assert.equal(parsed.subjectId, raw.subjectId);
    assert.equal(parsed.deviceId, raw.deviceId);

    for (const key of TRAJECTORY_FORBIDDEN_CONTENT_KEYS) {
      assert.ok(!(key in raw), `${entry.id} golden must omit ${key}`);
      assert.ok(!(key in parsed.record), `${entry.id} parse must omit ${key}`);
    }

    const again = turnTrajectoryV1Schema.parse(
      JSON.parse(JSON.stringify(parsed.record)),
    );
    assert.deepEqual(again, parsed.record);

    const consent = assertTurnTrajectoryExportConsent(parsed.record, () => ({
      consentRecordId: parsed.record.consentRecordId,
      subjectId: parsed.record.subjectId,
      optedIn: true,
      active: true,
    }));
    assert.equal(consent.ok, true);

    let wrote = false;
    const queued = enqueueTurnTrajectoryWrite(parsed.record, async () => {
      wrote = true;
    });
    assert.equal(queued.queued, true);
    assert.equal(wrote, false);

    emitTrajectoryObservability({
      event: "telemetry.trajectory",
      outcome: "ok",
      subjectId: parsed.subjectId,
      deviceId: parsed.deviceId,
      stageCount: parsed.record.stages.length,
      toolCallCount: parsed.record.toolCalls.length,
    });
    log({
      outcome: "ok",
      case: "golden",
      id: entry.id,
      subjectId: parsed.subjectId,
      deviceId: parsed.deviceId,
    });
  });
}

for (const entry of manifest.violations) {
  test(`violation rejected: ${entry.id}`, () => {
    const raw = loadJson(entry.file);
    assert.ok(entry.forbiddenKey in raw);
    const parsed = parseTurnTrajectoryV1(raw);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.failureClass, entry.expectedFailureClass);
    assert.equal(parsed.issuePath, entry.forbiddenKey);
    emitTrajectoryObservability({
      event: "telemetry.trajectory",
      outcome: "rejected",
      subjectId: typeof raw.subjectId === "string" ? raw.subjectId : "unknown",
      deviceId: typeof raw.deviceId === "string" ? raw.deviceId : undefined,
      failureClass: parsed.failureClass,
    });
    log({
      outcome: "rejected",
      case: "violation",
      id: entry.id,
      subjectId: parsed.subjectId,
      failureClass: parsed.failureClass,
    });
  });
}

test("edge: replay of golden payload is idempotent (byte-stable JSON)", () => {
  const entry = manifest.goldens[0];
  const raw = loadJson(entry.file);
  const a = parseTurnTrajectoryV1(raw);
  const b = parseTurnTrajectoryV1(JSON.parse(JSON.stringify(raw)));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.record, b.record);
});
