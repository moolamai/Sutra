/**
 * Round-trip + B9 backward-compat fixtures for TurnTrajectoryRecord.
 * Golden B9 parse without training fields; extended: parse → canonical JSON → parse;
 * one violation per C0 training field class.
 *
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRAJECTORY_COMMITTED_SCHEMA_RELPATH,
  TRAJECTORY_GOLDEN_FIXTURES_RELPATH,
  TRAJECTORY_STAGE_LIMIT,
  TRAJECTORY_TRAINING_FIELD_CLASSES,
  assertTrajectoryExportConsent,
  enqueueTrajectoryWrite,
  parseTurnTrajectoryRecord,
  toCanonicalTrajectoryJson,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const REPO_ROOT = join(PKG, "..", "..");
const FIXTURE_DIR = join(PKG, TRAJECTORY_GOLDEN_FIXTURES_RELPATH);
const MANIFEST = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
);

const TRAINING_KEYS = [
  "policyCheckpointHash",
  "rolloutSeed",
  "precisionFormat",
  "executionState",
  "routerReplayMap",
];

function loadJson(rel) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, rel), "utf8"));
}

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.trajectory.roundtrip", ...event })}\n`,
  );
}

test("manifest covers every training field class with one violation", () => {
  const covered = MANIFEST.violations.map((v) => v.fieldClass);
  assert.equal(new Set(covered).size, covered.length);
  for (const fieldClass of TRAJECTORY_TRAINING_FIELD_CLASSES) {
    assert.ok(
      covered.includes(fieldClass),
      `manifest missing violation for ${fieldClass}`,
    );
  }
});

test("happy path: golden B9 fixtures parse without training fields (additive)", () => {
  assert.ok(MANIFEST.b9.length >= 2, "need ≥2 golden B9 fixtures");
  for (const entry of MANIFEST.b9) {
    const raw = loadJson(entry.file);
    const parsed = parseTurnTrajectoryRecord(raw);
    assert.equal(parsed.ok, true, entry.id);
    assert.equal(parsed.record.locality, entry.locality);
    assert.equal(parsed.subjectId, raw.subjectId);
    for (const key of TRAINING_KEYS) {
      assert.equal(
        parsed.record[key],
        undefined,
        `${entry.id} must not invent ${key}`,
      );
      assert.ok(!(key in raw), `${entry.id} golden file must omit ${key}`);
    }
    const gate = assertTrajectoryExportConsent(parsed.record);
    assert.equal(gate.ok, true, entry.id);
    emit({
      outcome: "ok",
      case: "b9_golden",
      id: entry.id,
      subjectId: parsed.subjectId,
      deviceId: parsed.deviceId ?? null,
    });
  }
});

test("happy path: extended fixtures round-trip parse → canonical JSON → parse", () => {
  for (const entry of MANIFEST.extended) {
    const raw = loadJson(entry.file);
    const first = parseTurnTrajectoryRecord(raw);
    assert.equal(first.ok, true, entry.id);

    if (entry.hasRouterReplayMap === false) {
      assert.equal(first.record.routerReplayMap, undefined, entry.id);
    } else {
      assert.ok(first.record.routerReplayMap, entry.id);
    }
    if (entry.streamAbort) {
      assert.equal(first.record.executionState?.statusCode, "stream_aborted");
      assert.ok(first.record.executionState?.commandExecuted);
    }

    const canonical = toCanonicalTrajectoryJson(first.record);
    assert.match(canonical, /\n$/);
    // Stable key order: subjectId before turnId alphabetically in object keys
    const replay = parseTurnTrajectoryRecord(JSON.parse(canonical));
    assert.equal(replay.ok, true, `${entry.id} re-parse`);
    assert.deepEqual(replay.record, first.record);

    const secondCanonical = toCanonicalTrajectoryJson(replay.record);
    assert.equal(secondCanonical, canonical, `${entry.id} canonical stable`);

    emit({
      outcome: "ok",
      case: "extended_roundtrip",
      id: entry.id,
      subjectId: first.subjectId,
      deviceId: first.deviceId ?? null,
      bytes: canonical.length,
    });
  }
});

test("happy path: B9 golden also round-trips without injecting training keys", () => {
  for (const entry of MANIFEST.b9) {
    const first = parseTurnTrajectoryRecord(loadJson(entry.file));
    assert.equal(first.ok, true);
    const canonical = toCanonicalTrajectoryJson(first.record);
    for (const key of TRAINING_KEYS) {
      assert.ok(
        !canonical.includes(`"${key}"`),
        `${entry.id} canonical must omit ${key}`,
      );
    }
    const replay = parseTurnTrajectoryRecord(JSON.parse(canonical));
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.record, first.record);
  }
});

test("edge: violation per training field class rejects with typed failure", () => {
  for (const violation of MANIFEST.violations) {
    const raw = loadJson(violation.file);
    const parsed = parseTurnTrajectoryRecord(raw);
    assert.equal(parsed.ok, false, violation.id);
    assert.equal(
      parsed.failureClass,
      violation.failureClass,
      `${violation.id} failureClass`,
    );
    if (violation.issuePathContains) {
      assert.ok(
        (parsed.issuePath ?? "").includes(violation.issuePathContains) ||
          parsed.detail.includes(violation.issuePathContains),
        `${violation.id} path/detail should name ${violation.issuePathContains}: ${parsed.issuePath} ${parsed.detail}`,
      );
    }
    emit({
      outcome: "rejected",
      case: "field_class_violation",
      id: violation.id,
      fieldClass: violation.fieldClass,
      failureClass: parsed.failureClass,
      subjectId: parsed.subjectId,
      deviceId: null,
    });
  }
});

test("edge: raw keystrokes + consent deny remain sovereign rejects", () => {
  const withKeys = {
    ...loadJson("b9-base-on-device.json"),
    keystrokes: "typed-secret",
  };
  const ks = parseTurnTrajectoryRecord(withKeys);
  assert.equal(ks.ok, false);
  assert.equal(ks.failureClass, "keystroke_forbidden");

  const declined = parseTurnTrajectoryRecord({
    ...loadJson("b9-base-on-device.json"),
    consent: {
      optedIn: false,
      consentClass: "research",
      recordedAt: "2026-07-15T18:00:00.000Z",
    },
  });
  assert.equal(declined.ok, true);
  const gate = assertTrajectoryExportConsent(declined.record);
  assert.equal(gate.ok, false);
  assert.equal(gate.failureClass, "consent_denied");
  emit({
    outcome: "ok",
    case: "sovereignty_negative",
    subjectId: "anika-k",
    deviceId: null,
  });
});

test("edge: subject isolation — concurrent parses do not cross subjectId", async () => {
  const a = loadJson("b9-base-on-device.json");
  const b = loadJson("b9-self-hosted.json");
  assert.notEqual(a.subjectId, b.subjectId);

  const [pa, pb] = await Promise.all([
    Promise.resolve(parseTurnTrajectoryRecord(a)),
    Promise.resolve(parseTurnTrajectoryRecord(b)),
  ]);
  assert.equal(pa.ok && pb.ok, true);
  assert.equal(pa.subjectId, "anika-k");
  assert.equal(pb.subjectId, "ravi-m");
  assert.notEqual(pa.record.sessionId, pb.record.sessionId);
});

test("edge: async write never blocks; NFR stage bound rejects oversized lists", async () => {
  const telemetry = [];
  const record = parseTurnTrajectoryRecord(
    loadJson("extended-dense-slm.json"),
  ).record;
  let done = false;
  const queued = enqueueTrajectoryWrite(
    record,
    async () => {
      await new Promise((r) => setTimeout(r, 30));
      done = true;
    },
    { onTelemetry: (e) => telemetry.push(e) },
  );
  assert.equal(queued.queued, true);
  assert.equal(done, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(done, true);
  assert.ok(telemetry.some((t) => t.outcome === "queued"));
  assert.ok(telemetry.some((t) => t.outcome === "ok"));
  assert.ok(!JSON.stringify(telemetry).includes("utterance"));

  const oversized = {
    ...loadJson("b9-base-on-device.json"),
    stages: Array.from({ length: TRAJECTORY_STAGE_LIMIT + 1 }, (_, i) => ({
      stage: `s${i}`,
      status: "ok",
    })),
  };
  const bad = parseTurnTrajectoryRecord(oversized);
  assert.equal(bad.ok, false);
  assert.ok(
    bad.failureClass === "schema_violation" ||
      bad.failureClass === "section_limit",
  );
});

test("committed schema documents training fields as optional (B9 required set)", () => {
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, TRAJECTORY_COMMITTED_SCHEMA_RELPATH), "utf8"),
  );
  const required = new Set(schema.required ?? []);
  for (const key of TRAINING_KEYS) {
    assert.ok(schema.properties?.[key], `schema missing ${key}`);
    assert.ok(!required.has(key), `${key} must stay optional for B9 compat`);
  }
  assert.equal(schema["x-invariants"]?.additiveEvolutionOnly, true);
  emit({
    outcome: "ok",
    case: "schema_optional_training",
    subjectId: null,
    deviceId: "ci",
  });
});
