/**
 * SYNC-02 / SYNC-06 — HLC skew-clamp advisory regression
 * And advisory-surface conformance doc checks .
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/hlc_advisories.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CrdtHarnessResolver,
  MAX_CLOCK_SKEW_MS,
} from "../dist/crdt_harness_resolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "../fixtures/advisories/skew-clamp.json");
const ADVISORY_SURFACE_DOC = path.join(__dirname, "../docs/advisory-surface.md");
const SYNC_ADVISORY_SCHEMA = path.join(__dirname, "../schemas/SyncAdvisory.json");

function emitAdvisoryEvent(event) {
  process.stdout.write(`${JSON.stringify({ event: "crdt.advisory", ...event })}\n`);
}

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

function hlc(physical, logical, deviceId) {
  return `${physical}:${logical}:${deviceId}`;
}

function buildRemote(fx, caseKey) {
  const c = fx.cases[caseKey];
  const remote = structuredClone(fx.remoteTemplate);
  const deviceId = remote.deviceIds[0];
  remote.profile.updatedAt = hlc(c.physical, c.logicalProfile, deviceId);
  remote.stateVector = {
    session: hlc(c.physical, c.logicalSession, deviceId),
    profile: hlc(c.physical, c.logicalProfile, deviceId),
    [`device:${deviceId}`]: hlc(c.physical, c.logicalDevice, deviceId),
  };
  return remote;
}

test("named constant MAX_CLOCK_SKEW_MS matches shared fixture (SYNC-02)", () => {
  const fx = loadFixture();
  assert.equal(fx.MAX_CLOCK_SKEW_MS, MAX_CLOCK_SKEW_MS);
  assert.equal(
    fx.horizonPhysical,
    String(fx.nowMs + fx.MAX_CLOCK_SKEW_MS).padStart(15, "0"),
  );
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "sharedConstant",
    MAX_CLOCK_SKEW_MS,
    subjectId: fx.local.subjectId,
  });
});

test("in-bound physical: no CLOCK_SKEW_CLAMPED advisory", () => {
  const fx = loadFixture();
  assert.equal(fx.specId, "SYNC-02");
  const remote = buildRemote(fx, "inBound");
  const resolver = new CrdtHarnessResolver({ nowMs: fx.nowMs });
  const { merged, advisories } = resolver.merge(fx.local, remote);

  assert.equal(
    advisories.some((a) => a.code === "CLOCK_SKEW_CLAMPED"),
    false,
  );
  assert.equal(merged.subjectId, fx.local.subjectId);
  assert.equal(merged.profile.updatedAt, remote.profile.updatedAt);

  emitAdvisoryEvent({
    outcome: "ok",
    kind: "inBound",
    subjectId: merged.subjectId,
    deviceId: remote.deviceIds[0],
  });
});

test("at-bound physical: no CLOCK_SKEW_CLAMPED advisory", () => {
  const fx = loadFixture();
  const remote = buildRemote(fx, "atBound");
  const resolver = new CrdtHarnessResolver({ nowMs: fx.nowMs });
  const { merged, advisories } = resolver.merge(fx.local, remote);

  assert.equal(
    advisories.some((a) => a.code === "CLOCK_SKEW_CLAMPED"),
    false,
  );
  assert.equal(merged.profile.updatedAt, remote.profile.updatedAt);

  emitAdvisoryEvent({
    outcome: "ok",
    kind: "atBound",
    subjectId: merged.subjectId,
    deviceId: remote.deviceIds[0],
  });
});

test("beyond-bound physical: clamped + advisory carries original→clamped (SYNC-02)", () => {
  const fx = loadFixture();
  const c = fx.cases.beyondBound;
  const remote = buildRemote(fx, "beyondBound");
  const originalProfile = remote.profile.updatedAt;
  const resolver = new CrdtHarnessResolver({ nowMs: fx.nowMs });
  const { merged, advisories } = resolver.merge(fx.local, remote);

  const hits = advisories.filter((a) => a.code === "CLOCK_SKEW_CLAMPED");
  assert.equal(hits.length, 1, "exactly one CLOCK_SKEW_CLAMPED advisory");
  for (const pair of c.expectOriginalToClamped) {
    assert.match(
      hits[0].detail,
      new RegExp(pair.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(hits[0].detail, new RegExp(originalProfile.replace(/:/g, "\\:")));
  assert.match(hits[0].detail, new RegExp(c.expectMergedProfileUpdatedAt.replace(/:/g, "\\:")));
  assert.equal(merged.profile.updatedAt, c.expectMergedProfileUpdatedAt);
  assert.equal(merged.stateVector.session, c.expectMergedSession);

  emitAdvisoryEvent({
    outcome: "ok",
    code: "CLOCK_SKEW_CLAMPED",
    subjectId: merged.subjectId,
    deviceId: remote.deviceIds[0],
    originalProfile,
    clampedProfile: c.expectMergedProfileUpdatedAt,
  });
});

test("edge: replaying the same beyond-bound remote is idempotent", () => {
  const fx = loadFixture();
  const remote = buildRemote(fx, "beyondBound");
  const resolver = new CrdtHarnessResolver({ nowMs: fx.nowMs });
  const first = resolver.merge(fx.local, remote);
  const second = resolver.merge(first.merged, remote);

  assert.deepEqual(second.merged, first.merged);
  assert.equal(
    second.advisories.filter((a) => a.code === "CLOCK_SKEW_CLAMPED").length,
    1,
  );
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "edge.replay-idempotent",
    subjectId: fx.local.subjectId,
    deviceId: remote.deviceIds[0],
  });
});

test("sovereignty: SUBJECT_MISMATCH still refuses cross-subject merge", () => {
  const fx = loadFixture();
  const remote = buildRemote(fx, "beyondBound");
  const resolver = new CrdtHarnessResolver({ nowMs: fx.nowMs });
  const foreign = { ...remote, subjectId: "other-subject" };
  assert.throws(
    () => resolver.merge(fx.local, foreign),
    (err) => err && err.code === "SUBJECT_MISMATCH",
  );
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "subjectIsolation",
    code: "SUBJECT_MISMATCH",
  });
});

test("conformance doc: lists every SyncAdvisory code with real triggers (SKEWCLAMFI-002)", () => {
  assert.equal(existsSync(ADVISORY_SURFACE_DOC), true, "advisory-surface.md missing");
  const doc = readFileSync(ADVISORY_SURFACE_DOC, "utf8");
  const schema = JSON.parse(readFileSync(SYNC_ADVISORY_SCHEMA, "utf8"));
  const codes = schema.properties.code.enum;
  assert.ok(Array.isArray(codes) && codes.length === 5);
  for (const code of codes) {
    assert.match(doc, new RegExp(`\`${code}\``), `doc must catalogue ${code}`);
  }
  assert.match(doc, /MAX_CLOCK_SKEW_MS/);
  assert.match(doc, /skew-clamp\.json/);
  assert.match(doc, /original→clamped/);
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "conformanceDoc.catalogue",
    codes,
  });
});

test("conformance doc: SUBJECT_MISMATCH is abort, not SyncAdvisory", () => {
  const doc = readFileSync(ADVISORY_SURFACE_DOC, "utf8");
  assert.match(doc, /SUBJECT_MISMATCH/);
  assert.match(doc, /Not advisories/);
  assert.match(doc, /subject isolation/i);
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "conformanceDoc.subjectIsolation",
    code: "SUBJECT_MISMATCH",
  });
});

test("conformance doc: replay idempotence and observability called out", () => {
  const doc = readFileSync(ADVISORY_SURFACE_DOC, "utf8");
  assert.match(doc, /Idempotent replay/i);
  assert.match(doc, /crdt\.advisory/);
  assert.match(doc, /subjectId/);
  emitAdvisoryEvent({
    outcome: "ok",
    kind: "conformanceDoc.edgeContracts",
  });
});
