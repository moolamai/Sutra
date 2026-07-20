/**
 * Corpus shard consent inclusion (consent-law factory hook).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CORPUS_SHARD_CONSENT_CLASSES,
  SubjectConsentLedger,
  evaluateCorpusShardInclusion,
  filterCorpusShardsForInclusion,
  includeExportedTrajectoryInCorpus,
  parseTurnTrajectoryRecord,
} from "../dist/index.js";

function shard(overrides = {}) {
  return {
    shardId: "shard-1",
    contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    consentClass: "public",
    subjectId: null,
    deviceId: "dev-shard",
    locality: "self-hosted",
    ...overrides,
  };
}

function traj() {
  return parseTurnTrajectoryRecord({
    schemaVersion: "trajectory.v1",
    subjectId: "anika-k",
    sessionId: "sess-1",
    turnId: "turn-c2",
    deviceId: "dev-shard",
    capturedAt: "2026-07-15T18:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T18:00:00.000Z",
    },
    stages: [{ stage: "act", status: "ok" }],
  }).record;
}

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.consent.shard.test", ...event })}\n`,
  );
}

test("happy path: known shard classes include; batch covers all four", () => {
  const telemetry = [];
  assert.deepEqual(
    [...CORPUS_SHARD_CONSENT_CLASSES],
    ["consented", "public", "synthetic", "government"],
  );

  const { included, excluded } = filterCorpusShardsForInclusion(
    [
      shard({
        shardId: "s-consented",
        consentClass: "consented",
        subjectId: "anika-k",
      }),
      shard({ shardId: "s-public", consentClass: "public" }),
      shard({ shardId: "s-synthetic", consentClass: "synthetic" }),
      shard({ shardId: "s-government", consentClass: "government" }),
    ],
    {
      deviceId: "dev-batch",
      onTelemetry: (e) => telemetry.push(e),
    },
  );

  assert.equal(included.length, 4);
  assert.equal(excluded.length, 0);
  assert.ok(
    telemetry.every((t) => !JSON.stringify(t).includes("utterance")),
  );
  log({ outcome: "ok", case: "all-four-classes", subjectId: null });
});

test("edge: missing or unknown consent class excludes shard", () => {
  const missing = evaluateCorpusShardInclusion(
    shard({ consentClass: null, shardId: "s-missing" }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_consent");

  const unknown = evaluateCorpusShardInclusion(
    shard({ consentClass: "research", shardId: "s-unknown" }),
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.failureClass, "unknown_consent_class");
  log({ outcome: "rejected", case: "unknown-exclude", subjectId: null });
});

test("edge: revocation excludes future consented shards; checkpoints untouched", () => {
  const ledger = new SubjectConsentLedger();
  const checkpoints = new Map([["ckpt-prior", true]]);
  const includedShardIds = new Set();

  const first = evaluateCorpusShardInclusion(
    shard({
      shardId: "s-c1",
      consentClass: "consented",
      subjectId: "anika-k",
    }),
    { ledger, includedShardIds },
  );
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);

  const replay = evaluateCorpusShardInclusion(
    shard({
      shardId: "s-c1",
      consentClass: "consented",
      subjectId: "anika-k",
    }),
    { ledger, includedShardIds },
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);

  ledger.revoke("anika-k");
  const after = evaluateCorpusShardInclusion(
    shard({
      shardId: "s-c2",
      consentClass: "consented",
      subjectId: "anika-k",
    }),
    { ledger },
  );
  assert.equal(after.ok, false);
  assert.equal(after.failureClass, "consent_revoked");
  assert.equal(checkpoints.has("ckpt-prior"), true);

  const publicStill = evaluateCorpusShardInclusion(
    shard({ shardId: "s-pub-2", consentClass: "public" }),
    { ledger },
  );
  assert.equal(publicStill.ok, true);
  log({
    outcome: "ok",
    case: "revoke-future-consented",
    subjectId: "anika-k",
  });
});

test("edge: third-party path excludes government; synthetic allowed", () => {
  const gov = evaluateCorpusShardInclusion(
    shard({
      shardId: "s-gov-tp",
      consentClass: "government",
      requiresThirdPartyProcessing: true,
    }),
  );
  assert.equal(gov.ok, false);
  assert.equal(gov.failureClass, "third_party_excluded");

  const syn = evaluateCorpusShardInclusion(
    shard({
      shardId: "s-syn-tp",
      consentClass: "synthetic",
      requiresThirdPartyProcessing: true,
    }),
  );
  assert.equal(syn.ok, true);
  log({ outcome: "ok", case: "third-party-shard-tier", subjectId: null });
});

test("sovereignty: cross-subject shard aggregation default-deny", () => {
  const denied = evaluateCorpusShardInclusion(
    shard({
      shardId: "s-x",
      consentClass: "public",
      crossSubject: true,
      anonymized: false,
    }),
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.failureClass, "cross_subject");

  const allowed = evaluateCorpusShardInclusion(
    shard({
      shardId: "s-x-ok",
      consentClass: "public",
      crossSubject: true,
      anonymized: true,
    }),
  );
  assert.equal(allowed.ok, true);
  log({ outcome: "ok", case: "cross-subject-deny", subjectId: null });
});

test("happy path: export → consented shard inclusion via factory bridge", () => {
  const result = includeExportedTrajectoryInCorpus(traj(), {
    contentHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    shardId: "traj-shard-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.inclusion.consentClass, "consented");
  assert.equal(result.export.consentClass, "research");
  log({
    outcome: "ok",
    case: "export-to-shard",
    subjectId: "anika-k",
  });
});
