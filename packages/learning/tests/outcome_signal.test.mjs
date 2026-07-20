/**
 * Human outcome signal ledger — ACCEPTED/REJECTED set-once; typed enum.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ABANDONMENT_KINDS,
  HUMAN_OUTCOME_SIGNALS,
  MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL,
  OutcomeSignalLedger,
  TRAJECTORY_SCHEMA_VERSION,
  approvalDecisionToOutcome,
  attachOutcomeSignal,
  parseHumanOutcomeSignal,
  persistTrajectoryWithOutcome,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.outcome_signal.test", ...event })}\n`,
  );
}

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "anika-k",
    sessionId: "sess-1",
    turnId: "turn-1",
    deviceId: "edge-aaaa",
    capturedAt: "2026-07-15T22:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T22:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    ...overrides,
  };
}

test("happy path: ACCEPTED from approval → finalize on TURN_COMPLETE", () => {
  const telemetry = [];
  const ledger = new OutcomeSignalLedger({
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-1" }).ok, true);
  assert.equal(
    ledger.recordApprovalOutcome({
      subjectId: "anika-k",
      turnId: "turn-1",
      signal: approvalDecisionToOutcome(true),
    }).ok,
    true,
  );
  const fin = ledger.finalizeOnTurnComplete({
    subjectId: "anika-k",
    turnId: "turn-1",
  });
  assert.equal(fin.ok, true);
  assert.equal(fin.binding.humanOutcomeSignal, "ACCEPTED");
  assert.ok(telemetry.some((t) => t.humanOutcomeSignal === "ACCEPTED"));
  log({ outcome: "ok", case: "accepted", subjectId: "anika-k" });
});

test("happy path: REJECTED keeps pre-abort frame types for critic replay", () => {
  const ledger = new OutcomeSignalLedger();
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-r", deviceId: "edge-aaaa" });
  assert.equal(
    ledger.recordFrameType({
      subjectId: "anika-k",
      turnId: "turn-r",
      frameType: "TOKEN_DELTA",
    }).ok,
    true,
  );
  assert.equal(
    ledger.recordFrameType({
      subjectId: "anika-k",
      turnId: "turn-r",
      frameType: "TOOL_STATUS",
    }).ok,
    true,
  );
  ledger.recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-r",
    signal: "REJECTED",
  });
  const fin = ledger.finalizeOnTurnComplete({
    subjectId: "anika-k",
    turnId: "turn-r",
  });
  assert.equal(fin.ok, true);
  assert.deepEqual(fin.binding.preAbortFrameTypes, [
    "TOKEN_DELTA",
    "TOOL_STATUS",
  ]);
});

test("edge: free string rejected; typed enum only", () => {
  assert.equal(parseHumanOutcomeSignal("accepted").ok, false);
  assert.equal(parseHumanOutcomeSignal("ACCEPTED").ok, true);
  assert.deepEqual([...HUMAN_OUTCOME_SIGNALS], [
    "ACCEPTED",
    "REJECTED",
    "DISCARDED",
  ]);
  const ledger = new OutcomeSignalLedger();
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-x" });
  const bad = ledger.recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-x",
    signal: "looks-good",
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "schema_violation");
});

test("edge: DISCARDED refused from approval path", () => {
  const ledger = new OutcomeSignalLedger();
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-d" });
  const r = ledger.recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-d",
    signal: "DISCARDED",
  });
  assert.equal(r.ok, false);
  assert.equal(r.failureClass, "discarded_not_from_approval");
});

test("edge: set-once — second conflicting signal rejected", () => {
  const ledger = new OutcomeSignalLedger();
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-2" });
  ledger.recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-2",
    signal: "ACCEPTED",
  });
  const second = ledger.recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-2",
    signal: "REJECTED",
  });
  assert.equal(second.ok, false);
  assert.equal(second.failureClass, "already_set");
});

test("edge: approval timeout is harness event, not DISCARDED", () => {
  const telemetry = [];
  const ledger = new OutcomeSignalLedger({
    onTelemetry: (e) => telemetry.push(e),
  });
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-t" });
  const t = ledger.recordApprovalTimeout({
    subjectId: "anika-k",
    turnId: "turn-t",
  });
  assert.equal(t.ok, true);
  assert.equal(t.harnessEvent, "approval_timeout");
  assert.ok(telemetry.some((e) => e.harnessEvent === "approval_timeout"));
  assert.ok(!telemetry.some((e) => e.humanOutcomeSignal === "DISCARDED"));
  // Explicit discard after timeout is still allowed (user action).
  const discard = ledger.recordAbandonmentOutcome({
    subjectId: "anika-k",
    turnId: "turn-t",
    kind: "user_discard",
  });
  assert.equal(discard.ok, true);
  assert.equal(discard.humanOutcomeSignal, "DISCARDED");
});

test("happy path: user_discard and abort_without_accept → DISCARDED", () => {
  assert.deepEqual([...ABANDONMENT_KINDS], [
    "user_discard",
    "abort_without_accept",
  ]);
  const ledger = new OutcomeSignalLedger();
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-ud" });
  ledger.recordFrameType({
    subjectId: "anika-k",
    turnId: "turn-ud",
    frameType: "TOKEN_DELTA",
  });
  assert.equal(
    ledger.recordAbandonmentOutcome({
      subjectId: "anika-k",
      turnId: "turn-ud",
      kind: "user_discard",
    }).ok,
    true,
  );
  const fin = ledger.finalizeOnTurnComplete({
    subjectId: "anika-k",
    turnId: "turn-ud",
  });
  assert.equal(fin.ok, true);
  assert.equal(fin.binding.humanOutcomeSignal, "DISCARDED");
  assert.equal(fin.binding.abandonmentKind, "user_discard");
  assert.deepEqual(fin.binding.preAbortFrameTypes, ["TOKEN_DELTA"]);

  const ledger2 = new OutcomeSignalLedger();
  ledger2.beginTurn({ subjectId: "anika-k", turnId: "turn-ab" });
  ledger2.recordAbandonmentOutcome({
    subjectId: "anika-k",
    turnId: "turn-ab",
    kind: "abort_without_accept",
  });
  const fin2 = ledger2.finalizeOnTurnComplete({
    subjectId: "anika-k",
    turnId: "turn-ab",
  });
  assert.equal(fin2.binding.humanOutcomeSignal, "DISCARDED");
  assert.equal(fin2.binding.abandonmentKind, "abort_without_accept");
  log({ outcome: "ok", case: "discarded", subjectId: "anika-k" });
});

test("edge: ACCEPTED blocks DISCARDED; correction doc preserves prior", () => {
  assert.equal(MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL.priorSignalImmutable, true);
  assert.equal(
    MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL.path,
    "linkCorrectionAmendment",
  );
  const ledger = new OutcomeSignalLedger();
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-blk" });
  ledger.recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-blk",
    signal: "ACCEPTED",
  });
  const blocked = ledger.recordAbandonmentOutcome({
    subjectId: "anika-k",
    turnId: "turn-blk",
    kind: "user_discard",
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failureClass, "accept_blocks_discard");
});

test("edge: correction after ACCEPTED links amendment — never overwrites", () => {
  const ledger = new OutcomeSignalLedger();
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-orig" });
  ledger.recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-orig",
    signal: "ACCEPTED",
  });
  ledger.finalizeOnTurnComplete({
    subjectId: "anika-k",
    turnId: "turn-orig",
  });

  const amendment = ledger.linkCorrectionAmendment({
    subjectId: "anika-k",
    originalTurnId: "turn-orig",
    amendmentTurnId: "turn-amend",
  });
  assert.equal(amendment.ok, true);
  assert.equal(amendment.binding.amendsTurnId, "turn-orig");
  assert.equal(amendment.binding.humanOutcomeSignal, "ACCEPTED");

  const original = ledger.peek("anika-k", "turn-orig")?.finalized;
  assert.equal(original?.humanOutcomeSignal, "ACCEPTED");
  assert.equal(original?.amendsTurnId, undefined);
});

test("sovereignty: subject mismatch rejected; persist is async", async () => {
  const ledger = new OutcomeSignalLedger();
  ledger.beginTurn({ subjectId: "anika-k", turnId: "turn-s" });
  const cross = ledger.recordApprovalOutcome({
    subjectId: "ravi-m",
    turnId: "turn-s",
    signal: "ACCEPTED",
  });
  assert.equal(cross.ok, false);
  assert.ok(
    cross.failureClass === "not_started" ||
      cross.failureClass === "subject_mismatch",
  );

  ledger.recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-s",
    signal: "ACCEPTED",
  });
  const fin = ledger.finalizeOnTurnComplete({
    subjectId: "anika-k",
    turnId: "turn-s",
  });
  let done = false;
  const q = persistTrajectoryWithOutcome(
    draft({ turnId: "turn-s" }),
    fin.binding,
    async () => {
      await new Promise((r) => setTimeout(r, 25));
      done = true;
    },
  );
  assert.equal(q.queued, true);
  assert.equal(done, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, true);

  const attached = attachOutcomeSignal(draft({ turnId: "turn-s" }), fin.binding);
  assert.equal(attached.humanOutcomeSignal, "ACCEPTED");
  log({ outcome: "ok", case: "async_persist", subjectId: "anika-k" });
});
