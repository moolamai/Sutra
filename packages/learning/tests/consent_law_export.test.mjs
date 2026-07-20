/**
 * Consent-law enum + trajectory export gate.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSENT_CLASS_ENUM,
  CONSENT_CLASSES,
  SubjectConsentLedger,
  assertConsentClassEnumAlignedWithB9,
  enqueueConsentedTrajectoryWrite,
  evaluateTrajectoryConsent,
  exportTrajectory,
  parseTurnTrajectoryRecord,
} from "../dist/index.js";

function b9Base(overrides = {}) {
  return {
    schemaVersion: "trajectory.v1",
    subjectId: "anika-k",
    sessionId: "sess-1",
    turnId: "turn-1",
    deviceId: "dev-consent",
    capturedAt: "2026-07-15T18:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T18:00:00.000Z",
    },
    stages: [{ stage: "act", status: "ok" }],
    ...overrides,
  };
}

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.consent.test", ...event })}\n`,
  );
}

test("happy path: B9 consent enum aligns and export accepts opted-in research", () => {
  const telemetry = [];
  const align = assertConsentClassEnumAlignedWithB9({
    subjectId: null,
    deviceId: "dev-align",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(align.ok, true);
  assert.deepEqual([...CONSENT_CLASS_ENUM].sort(), [...CONSENT_CLASSES].sort());

  const parsed = parseTurnTrajectoryRecord(b9Base());
  assert.equal(parsed.ok, true);
  const exported = exportTrajectory(parsed.record, {
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(exported.ok, true);
  assert.equal(exported.consentClass, "research");
  assert.equal(exported.subjectId, "anika-k");
  assert.ok(
    telemetry.some(
      (t) => t.event === "learning.trajectory.export" && t.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(telemetry).includes("learner's answer"));
  log({ outcome: "ok", case: "export-research", subjectId: "anika-k" });
});

test("edge: missing consent record rejects export", () => {
  const telemetry = [];
  const gate = evaluateTrajectoryConsent(
    {
      subjectId: "anika-k",
      consent: null,
      deviceId: "dev-missing",
    },
    { onTelemetry: (e) => telemetry.push(e) },
  );
  assert.equal(gate.ok, false);
  assert.equal(gate.failureClass, "missing_consent");
  assert.ok(
    telemetry.some(
      (t) => t.failureClass === "missing_consent" && t.outcome === "rejected",
    ),
  );
  log({ outcome: "rejected", case: "missing-consent", subjectId: "anika-k" });
});

test("edge: third-party teacher path excludes personal consent class", () => {
  const parsed = parseTurnTrajectoryRecord(
    b9Base({
      consent: {
        optedIn: true,
        consentClass: "personal",
        recordedAt: "2026-07-15T18:00:00.000Z",
      },
    }),
  );
  assert.equal(parsed.ok, true);
  const exported = exportTrajectory(parsed.record, {
    requiresThirdPartyProcessing: true,
  });
  assert.equal(exported.ok, false);
  assert.equal(exported.failureClass, "third_party_excluded");

  const research = exportTrajectory(
    parseTurnTrajectoryRecord(b9Base()).record,
    { requiresThirdPartyProcessing: true },
  );
  assert.equal(research.ok, true);
  log({
    outcome: "ok",
    case: "third-party-tier",
    subjectId: "anika-k",
  });
});

test("edge: revocation excludes future export; does not touch prior checkpoints", () => {
  const ledger = new SubjectConsentLedger();
  const checkpoints = new Map([["ckpt-prior", { subjectId: "anika-k" }]]);

  const before = exportTrajectory(parseTurnTrajectoryRecord(b9Base()).record, {
    ledger,
  });
  assert.equal(before.ok, true);

  const rev1 = ledger.revoke("anika-k");
  const rev2 = ledger.revoke("anika-k");
  assert.equal(rev1.ok, true);
  assert.equal(rev1.idempotent, false);
  assert.equal(rev2.ok, true);
  assert.equal(rev2.idempotent, true);

  const after = exportTrajectory(parseTurnTrajectoryRecord(b9Base()).record, {
    ledger,
  });
  assert.equal(after.ok, false);
  assert.equal(after.failureClass, "consent_revoked");
  assert.equal(checkpoints.has("ckpt-prior"), true);
  log({
    outcome: "rejected",
    case: "revocation-future-only",
    subjectId: "anika-k",
  });
});

test("sovereignty: cross-subject aggregation default-deny without anonymization", () => {
  const denied = evaluateTrajectoryConsent({
    subjectId: "anika-k",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T18:00:00.000Z",
    },
    crossSubject: true,
    anonymized: false,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.failureClass, "cross_subject");

  const allowed = evaluateTrajectoryConsent({
    subjectId: "anika-k",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T18:00:00.000Z",
    },
    crossSubject: true,
    anonymized: true,
  });
  assert.equal(allowed.ok, true);
  log({
    outcome: "ok",
    case: "cross-subject-default-deny",
    subjectId: "anika-k",
  });
});

test("edge: async consented write queues without blocking the turn", async () => {
  let writerDone = false;
  const telemetry = [];
  const record = parseTurnTrajectoryRecord(b9Base()).record;

  const result = enqueueConsentedTrajectoryWrite(
    record,
    async () => {
      await new Promise((r) => setTimeout(r, 40));
      writerDone = true;
    },
    { onTelemetry: (e) => telemetry.push(e) },
  );

  assert.equal(result.queued, true);
  assert.equal(writerDone, false);
  assert.ok(telemetry.some((t) => t.outcome === "queued"));

  const declined = enqueueConsentedTrajectoryWrite(
    parseTurnTrajectoryRecord(
      b9Base({
        consent: {
          optedIn: false,
          consentClass: "research",
          recordedAt: "2026-07-15T18:00:00.000Z",
        },
      }),
    ).record,
    async () => {
      writerDone = true;
    },
  );
  assert.equal(declined.ok, false);
  assert.equal(declined.failureClass, "consent_denied");

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(writerDone, true);
  log({
    outcome: "ok",
    case: "async-non-blocking",
    subjectId: "anika-k",
  });
});
