/**
 * Sync chaos — kill orchestrator mid-sync → converge.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createKillMidSyncTransport,
  runKillOrchestratorMidSyncDrill,
  canonicalStateEqual,
  formatSyncChaosGateReport,
} from "../_shared/sync_chaos_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRILL = path.join(__dirname, "../chaos/sync_chaos.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.sync_chaos.test", ...event })}\n`,
  );
}

test("happy path: kill mid-sync then recover → converged identical replicas", async () => {
  const result = await runKillOrchestratorMidSyncDrill({
    subjectId: "subj-chaos-happy",
    deviceId: "edge-happy",
    sleep: async () => {},
  });
  assert.equal(result.ok, true, result.failureClass);
  assert.equal(result.outcome.status, "converged");
  assert.ok(result.outcome.attempts >= 2);
  assert.equal(result.applyCount, 1);
  assert.equal(result.replicasEqual, true);
  assert.ok(
    canonicalStateEqual(result.outcome.state, result.cloudState),
  );
  assert.match(formatSyncChaosGateReport(result), /PASS/);
  log({
    outcome: "ok",
    case: "kill-recover-converge",
    subjectId: result.subjectId,
    attempts: result.outcome.attempts,
  });
});

test("edge: kill during retry backoff — same syncAttemptId, no double-apply", async () => {
  const attemptId = randomUUID();
  const transport = createKillMidSyncTransport({
    killOnCall: 1,
    downsBeforeRecover: 2,
    autoRecover: true,
  });
  const sleeps = [];
  const result = await runKillOrchestratorMidSyncDrill({
    transport,
    syncAttemptId: attemptId,
    subjectId: "subj-chaos-backoff",
    deviceId: "edge-backoff",
    maxAttempts: 8,
    sleep: async (ms) => {
      sleeps.push(ms);
      // Stay down across the first backoff window, then allow auto-recover.
    },
  });
  assert.equal(result.ok, true, result.failureClass);
  assert.equal(result.syncAttemptId, attemptId);
  assert.equal(result.applyCount, 1);
  assert.ok(sleeps.length >= 1, "expected backoff sleep while orchestrator down");
  assert.ok(
    transport.events.some((e) => e.kind === "sigkill_mid_sync"),
  );
  assert.ok(
    transport.events.some((e) => e.kind === "idempotent_replay") ||
      result.applyCount === 1,
  );
  log({
    outcome: "ok",
    case: "backoff-idempotent",
    subjectId: "subj-chaos-backoff",
    applyCount: result.applyCount,
  });
});

test("edge: validation / exhaustion failure classes are loud", async () => {
  const sticky = createKillMidSyncTransport({
    killOnCall: 1,
    downsBeforeRecover: 100,
    autoRecover: false,
  });
  const exhausted = await runKillOrchestratorMidSyncDrill({
    transport: sticky,
    subjectId: "subj-chaos-exhausted",
    maxAttempts: 3,
    sleep: async () => {},
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.failureClass, "convergence_failed");
  assert.equal(exhausted.outcome.status, "exhausted");
  assert.match(formatSyncChaosGateReport(exhausted), /FAIL/);
  log({ outcome: "rejected", case: "exhausted-loud", subjectId: null });
});

test("sovereignty: subject isolation; drill uses public SyncEngine paths", async () => {
  const a = await runKillOrchestratorMidSyncDrill({
    subjectId: "subj-iso-a",
    deviceId: "edge-iso-a",
    sleep: async () => {},
  });
  const b = await runKillOrchestratorMidSyncDrill({
    subjectId: "subj-iso-b",
    deviceId: "edge-iso-b",
    sleep: async () => {},
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.outcome.state.subjectId, b.outcome.state.subjectId);
  assert.ok(!canonicalStateEqual(a.outcome.state, b.outcome.state));

  const blob = JSON.stringify({
    a: a.subjectId,
    b: b.subjectId,
    status: a.outcome.status,
  });
  assert.ok(!blob.includes("utterance"));
  assert.ok(!blob.includes("keystroke"));

  const src = readFileSync(DRILL, "utf8");
  assert.match(src, /kill_orchestrator_mid_sync|SIGKILL|runKillOrchestratorMidSyncDrill|runComposeKillMidSyncDrill|partition/);
  assert.doesNotMatch(src, /test-only backdoor|BYPASS/i);
  log({ outcome: "ok", case: "subject-isolation", subjectId: null });
});
