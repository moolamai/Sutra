/**
 * Post-drill invariant assertion suite.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runKillOrchestratorMidSyncDrill,
  runPartitionRedisPostgresDrill,
  runCorruptCheckpointDrill,
} from "../_shared/sync_chaos_probe.mjs";
import {
  assertCrdtCommutativitySpotCheck,
  assertAdvisoryUniquenessPerAttempt,
  assertZeroRawContentInAudit,
  assertPostDrillInvariants,
  runPostDrillInvariantSuite,
  formatPostDrillInvariantReport,
  FORBIDDEN_CONTENT_MARKERS,
} from "../_shared/chaos_invariants.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRILL = path.join(__dirname, "../chaos/sync_chaos.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.sync_chaos.invariants.test", ...event })}\n`,
  );
}

test("happy path: post-drill suite passes after kill/partition/checkpoint drills", async () => {
  const kill = await runKillOrchestratorMidSyncDrill({
    subjectId: "subj-inv-kill",
    sleep: async () => {},
  });
  const part = await runPartitionRedisPostgresDrill({
    subjectId: "subj-inv-part",
    sleep: async () => {},
  });
  const ckpt = await runCorruptCheckpointDrill({
    subjectId: "subj-inv-ckpt",
    sessionId: "sess-inv",
  });

  const suite = runPostDrillInvariantSuite([kill, part, ckpt]);
  assert.equal(suite.ok, true, suite.failureClass);
  assert.equal(suite.breachCount, 0);
  assert.equal(suite.rows.length, 3);
  assert.ok(suite.rows.every((r) => r.ok));
  assert.match(formatPostDrillInvariantReport(suite), /SUITE PASS/);
  log({ outcome: "ok", case: "suite-after-drills", subjectId: null });
});

test("edge: duplicate syncAttemptId in audits trips uniqueness; content leak fails loud", () => {
  const dup = assertAdvisoryUniquenessPerAttempt({
    audits: [
      {
        subjectId: "s1",
        syncAttemptId: "11111111-1111-4111-8111-111111111111",
        advisoryCodes: ["DUPLICATE_SAMPLE_DROPPED"],
      },
      {
        subjectId: "s1",
        syncAttemptId: "11111111-1111-4111-8111-111111111111",
        advisoryCodes: [],
      },
    ],
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.failureClass, "duplicate_audit_attempt");

  const leak = assertZeroRawContentInAudit({
    audits: [
      {
        subjectId: "s1",
        syncAttemptId: "22222222-2222-4222-8222-222222222222",
        utterance: "secret learner essay",
      },
    ],
  });
  assert.equal(leak.ok, false);
  assert.equal(leak.failureClass, "content_leak");
  assert.ok(FORBIDDEN_CONTENT_MARKERS.includes("utterance"));
  log({ outcome: "rejected", case: "uniqueness-and-leak", subjectId: null });
});

test("edge: commutativity spot-check holds; failed drill fails suite", async () => {
  const comm = assertCrdtCommutativitySpotCheck({
    subjectId: "subj-inv-comm",
    sampleCount: 5,
  });
  assert.equal(comm.ok, true);

  const fakeFail = {
    ok: false,
    failureClass: "convergence_failed",
    drill: "kill_orchestrator_mid_sync",
    subjectId: "subj-inv-fail",
    deviceId: "edge-x",
    syncAttemptId: "33333333-3333-4333-8333-333333333333",
    outcome: { status: "exhausted", attempts: 3, advisoryCodes: [] },
    replicasEqual: false,
    applyCount: 0,
  };
  const row = assertPostDrillInvariants(fakeFail);
  assert.equal(row.ok, false);
  assert.ok(row.breachCount >= 1);

  const suite = runPostDrillInvariantSuite([fakeFail]);
  assert.equal(suite.ok, false);
  assert.match(formatPostDrillInvariantReport(suite), /SUITE FAIL/);
  log({ outcome: "rejected", case: "failed-drill-suite", subjectId: null });
});

test("sovereignty: suite telemetry omits content; sync_chaos wires post-drill suite", () => {
  const okAudit = assertZeroRawContentInAudit({
    subjectId: "subj-sov",
    audits: [
      {
        subjectId: "subj-sov",
        syncAttemptId: "44444444-4444-4444-8444-444444444444",
        advisoryCodes: ["CLOCK_SKEW_CLAMPED"],
      },
    ],
    outcome: { status: "converged", attempts: 1, advisoryCodes: [] },
  });
  assert.equal(okAudit.ok, true);

  const src = readFileSync(DRILL, "utf8");
  assert.match(src, /runPostDrillInvariantSuite|chaos_invariants/);
  assert.doesNotMatch(src, /test-only backdoor|BYPASS/i);
  log({ outcome: "ok", case: "sovereignty-wiring", subjectId: null });
});
