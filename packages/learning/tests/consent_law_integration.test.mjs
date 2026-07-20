/**
 * Consent-law integration + negative fixtures.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_SHARD_CONSENT_CLASSES,
  SubjectConsentLedger,
  applyKillSwitch,
  createLearnedOnState,
  exportTrajectory,
  isKillSwitchBaseline,
  loadAcceptedShardFixtures,
  parseTurnTrajectoryRecord,
  proveConsentGateIntegration,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.consent.integration.test", ...event })}\n`,
  );
}

test("happy path: proveConsentGateIntegration — accepted shards + negatives", async () => {
  const telemetry = [];
  const proved = await proveConsentGateIntegration({
    repoRoot: REPO_ROOT,
    deviceId: "ci-consent-003",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(proved.ok, true, proved.detail);
  assert.equal(proved.acceptedShardCount, 4);
  assert.equal(proved.optOutBlocked, true);
  assert.equal(proved.federatedBlocked, true);
  assert.ok(
    telemetry.some(
      (t) =>
        t.event === "learning.trajectory.export" &&
        t.outcome === "rejected" &&
        t.failureClass === "consent_denied",
    ),
  );
  assert.ok(
    telemetry.some(
      (t) => t.failureClass === "cross_subject" && t.outcome === "rejected",
    ),
  );
  assert.ok(!JSON.stringify(telemetry).includes("utterance"));
  log({
    outcome: "ok",
    case: "prove-integration",
    subjectId: null,
    acceptedShardCount: proved.acceptedShardCount,
  });
});

test("sovereignty: every accepted shard fixture has a known consent class", async () => {
  const loaded = await loadAcceptedShardFixtures({
    repoRoot: REPO_ROOT,
    deviceId: "ci-consent-shards",
  });
  assert.equal(loaded.ok, true, loaded.detail);
  const known = new Set(CORPUS_SHARD_CONSENT_CLASSES);
  for (const shard of loaded.document.shards) {
    assert.ok(
      known.has(shard.consentClass),
      `shard ${shard.shardId} missing known consent class`,
    );
  }
  const classes = new Set(
    loaded.document.shards.map((s) => s.consentClass),
  );
  assert.equal(classes.size, 4);
  log({
    outcome: "ok",
    case: "accepted-shard-classes",
    subjectId: null,
  });
});

test("negative: opt-out subject trajectory blocked from export", async () => {
  const proved = await proveConsentGateIntegration({
    repoRoot: REPO_ROOT,
    deviceId: "ci-opt-out",
  });
  assert.equal(proved.ok, true);

  const optedOut = parseTurnTrajectoryRecord({
    schemaVersion: "trajectory.v1",
    subjectId: "anika-k",
    sessionId: "s",
    turnId: "t-opt",
    deviceId: "dev",
    capturedAt: "2026-07-15T18:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: false,
      consentClass: "product-improve",
      recordedAt: "2026-07-15T18:00:00.000Z",
    },
    stages: [{ stage: "act", status: "ok" }],
  });
  assert.equal(optedOut.ok, true);
  const blocked = exportTrajectory(optedOut.record);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failureClass, "consent_denied");
  log({
    outcome: "rejected",
    case: "opt-out-export",
    subjectId: "anika-k",
  });
});

test("negative: federated path blocked without anonymization flag", async () => {
  const proved = await proveConsentGateIntegration({
    repoRoot: REPO_ROOT,
    deviceId: "ci-federated",
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.federatedBlocked, true);
  log({
    outcome: "rejected",
    case: "federated-no-anon",
    subjectId: "anika-k",
  });
});

test("edge: concurrent revoke+export for same subjectId is consistent", async () => {
  const ledger = new SubjectConsentLedger();
  const record = parseTurnTrajectoryRecord({
    schemaVersion: "trajectory.v1",
    subjectId: "anika-k",
    sessionId: "s-race",
    turnId: "t-race",
    deviceId: "dev-race",
    capturedAt: "2026-07-15T18:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T18:00:00.000Z",
    },
    stages: [{ stage: "act", status: "ok" }],
  }).record;

  const revokes = await Promise.all(
    [1, 2, 3].map(() => Promise.resolve(ledger.revoke("anika-k"))),
  );
  assert.ok(revokes.every((r) => r.ok));
  assert.equal(revokes.filter((r) => r.idempotent).length >= 2, true);

  const exports = await Promise.all(
    [1, 2, 3].map(() =>
      Promise.resolve(exportTrajectory(record, { ledger })),
    ),
  );
  for (const row of exports) {
    assert.equal(row.ok, false);
    assert.equal(row.failureClass, "consent_revoked");
  }
  log({
    outcome: "ok",
    case: "concurrent-revoke-export",
    subjectId: "anika-k",
  });
});

test("edge: kill-switch drill still restores learned baseline beside consent gate", () => {
  const on = createLearnedOnState();
  assert.equal(isKillSwitchBaseline(on), false);
  const result = applyKillSwitch(on, {
    subjectId: null,
    deviceId: "dev-ks-consent",
  });
  assert.equal(result.ok, true);
  assert.equal(isKillSwitchBaseline(result.state), true);
  log({
    outcome: "ok",
    case: "kill-switch-beside-consent",
    subjectId: null,
  });
});
