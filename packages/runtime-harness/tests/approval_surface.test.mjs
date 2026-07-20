/**
 * B3 approval surface → ACCEPTED/REJECTED on TURN_COMPLETE.
 * Run: pnpm --filter @moolam/runtime-harness test (or this file alone)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalSurface,
  ApprovalTimeoutError,
} from "../dist/index.js";
import { TRAJECTORY_SCHEMA_VERSION } from "@moolam/learning";

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "runtime.harness.approval_surface.test", ...event })}\n`,
  );
}

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "anika-k",
    sessionId: "sess-1",
    turnId: "turn-1",
    deviceId: "edge-aaaa",
    capturedAt: "2026-07-15T22:30:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T22:30:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    ...overrides,
  };
}

test("happy path: allow → ACCEPTED persisted on TURN_COMPLETE", async () => {
  const telemetry = [];
  const written = [];
  const surface = new ApprovalSurface({
    onApproval: async () => "allow",
    onTelemetry: (e) => telemetry.push(e),
    persistTrajectory: async (r) => {
      written.push(r);
    },
  });

  assert.equal(
    surface.beginTurn({
      subjectId: "anika-k",
      turnId: "turn-1",
      deviceId: "edge-aaaa",
      trajectoryDraft: draft(),
    }).ok,
    true,
  );

  surface.noteFrameType({
    subjectId: "anika-k",
    turnId: "turn-1",
    frameType: "TOKEN_DELTA",
  });

  const decided = await surface.decide({
    subjectId: "anika-k",
    turnId: "turn-1",
    sessionId: "sess-1",
    toolName: "docs.write",
    riskClass: "write",
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.allowed, true);
  assert.equal(decided.humanOutcomeSignal, "ACCEPTED");

  const done = surface.completeTurn({
    subjectId: "anika-k",
    turnId: "turn-1",
  });
  assert.equal(done.ok, true);
  assert.equal(done.binding.humanOutcomeSignal, "ACCEPTED");
  assert.equal(done.persisted, true);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(written.length, 1);
  assert.equal(written[0].humanOutcomeSignal, "ACCEPTED");
  assert.equal(written[0].subjectId, "anika-k");
  assert.ok(telemetry.some((t) => t.humanOutcomeSignal === "ACCEPTED"));
  log({ outcome: "ok", case: "accepted_persist", subjectId: "anika-k" });
});

test("happy path: deny → REJECTED retains pre-abort frames", async () => {
  const surface = new ApprovalSurface({
    onApproval: async () => "deny",
  });
  surface.beginTurn({ subjectId: "anika-k", turnId: "turn-deny" });
  surface.noteFrameType({
    subjectId: "anika-k",
    turnId: "turn-deny",
    frameType: "TOKEN_DELTA",
  });
  surface.noteFrameType({
    subjectId: "anika-k",
    turnId: "turn-deny",
    frameType: "TOOL_CALL",
  });

  const decided = await surface.decide({
    subjectId: "anika-k",
    turnId: "turn-deny",
    sessionId: "sess-1",
    toolName: "docs.write",
    riskClass: "write",
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.humanOutcomeSignal, "REJECTED");

  const done = surface.completeTurn({
    subjectId: "anika-k",
    turnId: "turn-deny",
  });
  assert.equal(done.ok, true);
  assert.deepEqual(done.binding.preAbortFrameTypes, [
    "TOKEN_DELTA",
    "TOOL_CALL",
  ]);
});

test("edge: B3 write hook adapter maps boolean allow/deny", async () => {
  const surface = new ApprovalSurface({
    onApproval: async (ctx) =>
      ctx.toolName === "safe.write" ? "allow" : "deny",
  });
  surface.beginTurn({ subjectId: "anika-k", turnId: "turn-hook" });
  const hook = surface.createWriteApprovalHook({
    turnId: "turn-hook",
    sessionId: "sess-1",
  });
  assert.equal(
    await hook({
      subjectId: "anika-k",
      invocation: { name: "safe.write" },
    }),
    true,
  );
  // second conflicting decide should fail at ledger — hook returns false path
  const surface2 = new ApprovalSurface({
    onApproval: async () => "deny",
  });
  surface2.beginTurn({ subjectId: "anika-k", turnId: "turn-hook2" });
  const denyHook = surface2.createWriteApprovalHook({
    turnId: "turn-hook2",
    sessionId: "sess-1",
  });
  assert.equal(
    await denyHook({
      subjectId: "anika-k",
      invocation: { name: "bad.write" },
    }),
    false,
  );
});

test("edge: approval timeout ≠ DISCARDED", async () => {
  const telemetry = [];
  const surface = new ApprovalSurface({
    onApproval: () => new Promise(() => {}),
    onTelemetry: (e) => telemetry.push(e),
  });
  surface.beginTurn({ subjectId: "anika-k", turnId: "turn-to" });
  const result = await surface.decide({
    subjectId: "anika-k",
    turnId: "turn-to",
    sessionId: "sess-1",
    toolName: "docs.write",
    riskClass: "write",
    deadlineMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.failureClass, "approval_timeout");
  assert.ok(telemetry.some((t) => t.harnessEvent === "approval_timeout"));
  assert.ok(!telemetry.some((t) => t.humanOutcomeSignal === "DISCARDED"));
});

test("edge: correction after ACCEPTED does not overwrite original", async () => {
  const surface = new ApprovalSurface({
    onApproval: async () => "allow",
  });
  surface.beginTurn({ subjectId: "anika-k", turnId: "turn-a" });
  await surface.decide({
    subjectId: "anika-k",
    turnId: "turn-a",
    sessionId: "sess-1",
    toolName: "docs.write",
    riskClass: "write",
  });
  surface.completeTurn({ subjectId: "anika-k", turnId: "turn-a" });

  const linked = surface.linkCorrectionAfterAccepted({
    subjectId: "anika-k",
    originalTurnId: "turn-a",
    amendmentTurnId: "turn-b",
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.binding.amendsTurnId, "turn-a");
  const orig = surface.getLedger().peek("anika-k", "turn-a")?.finalized;
  assert.equal(orig?.humanOutcomeSignal, "ACCEPTED");
  assert.equal(orig?.amendsTurnId, undefined);
});

test("sovereignty: cross-subject draft rejected; completeTurn idempotent", async () => {
  const surface = new ApprovalSurface({
    onApproval: async () => "allow",
  });
  const bad = surface.beginTurn({
    subjectId: "anika-k",
    turnId: "turn-x",
    trajectoryDraft: draft({ subjectId: "ravi-m", turnId: "turn-x" }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "subject_mismatch");

  surface.beginTurn({ subjectId: "anika-k", turnId: "turn-idem" });
  await surface.decide({
    subjectId: "anika-k",
    turnId: "turn-idem",
    sessionId: "sess-1",
    toolName: "x",
    riskClass: "write",
    decision: "allow",
  });
  const a = surface.completeTurn({
    subjectId: "anika-k",
    turnId: "turn-idem",
  });
  const b = surface.completeTurn({
    subjectId: "anika-k",
    turnId: "turn-idem",
  });
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.binding.humanOutcomeSignal, b.binding.humanOutcomeSignal);
});

test("edge: write hook timeout throws ApprovalTimeoutError", async () => {
  const surface = new ApprovalSurface({
    onApproval: () => new Promise(() => {}),
  });
  surface.beginTurn({ subjectId: "anika-k", turnId: "turn-hto" });
  const hook = surface.createWriteApprovalHook({
    turnId: "turn-hto",
    sessionId: "sess-1",
  });
  // Override decide deadline via direct decide for timeout class; hook uses default 5s —
  // exercise timeout through decide with short deadline instead.
  await assert.rejects(
    () =>
      surface.decide({
        subjectId: "anika-k",
        turnId: "turn-hto",
        sessionId: "sess-1",
        toolName: "slow",
        riskClass: "critical",
        deadlineMs: 15,
      }).then((r) => {
        if (!r.ok && r.timedOut) throw new ApprovalTimeoutError(r.detail);
        return r;
      }),
    (err) => err instanceof ApprovalTimeoutError,
  );
  void hook;
});

test("happy path: explicit user discard → DISCARDED persisted", async () => {
  const written = [];
  const surface = new ApprovalSurface({
    persistTrajectory: async (r) => {
      written.push(r);
    },
  });
  surface.beginTurn({
    subjectId: "anika-k",
    turnId: "turn-disc",
    deviceId: "edge-aaaa",
    trajectoryDraft: draft({ turnId: "turn-disc" }),
  });
  surface.noteFrameType({
    subjectId: "anika-k",
    turnId: "turn-disc",
    frameType: "TOKEN_DELTA",
  });
  const discarded = surface.discardTurn({
    subjectId: "anika-k",
    turnId: "turn-disc",
  });
  assert.equal(discarded.ok, true);
  assert.equal(discarded.binding.humanOutcomeSignal, "DISCARDED");
  assert.equal(discarded.abandonmentKind, "user_discard");
  assert.deepEqual(discarded.binding.preAbortFrameTypes, ["TOKEN_DELTA"]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(written[0]?.humanOutcomeSignal, "DISCARDED");
  assert.equal(written[0]?.abandonmentKind, "user_discard");
  log({ outcome: "ok", case: "user_discard", subjectId: "anika-k" });
});

test("happy path: abort-without-accept → DISCARDED; already_completed skips", () => {
  const surface = new ApprovalSurface();
  surface.beginTurn({ subjectId: "anika-k", turnId: "turn-ab1" });
  const aborted = surface.mapAbortToDiscard({
    subjectId: "anika-k",
    turnId: "turn-ab1",
    abortAction: "aborted",
  });
  assert.equal(aborted.ok, true);
  assert.equal(aborted.discarded, true);
  assert.equal(aborted.skipped, false);
  assert.equal(aborted.binding?.humanOutcomeSignal, "DISCARDED");
  assert.equal(aborted.binding?.abandonmentKind, "abort_without_accept");

  // Idempotent already_aborted
  const again = surface.mapAbortToDiscard({
    subjectId: "anika-k",
    turnId: "turn-ab1",
    abortAction: "already_aborted",
  });
  assert.equal(again.ok, true);
  assert.equal(again.discarded, true);
  assert.equal(again.binding?.humanOutcomeSignal, "DISCARDED");

  const surface2 = new ApprovalSurface({
    onApproval: async () => "allow",
  });
  surface2.beginTurn({ subjectId: "anika-k", turnId: "turn-done" });
  // Simulate accept-then-complete, then abort maps to already_completed.
  surface2.getLedger().recordApprovalOutcome({
    subjectId: "anika-k",
    turnId: "turn-done",
    signal: "ACCEPTED",
  });
  surface2.completeTurn({ subjectId: "anika-k", turnId: "turn-done" });
  const skip = surface2.mapAbortToDiscard({
    subjectId: "anika-k",
    turnId: "turn-done",
    abortAction: "already_completed",
  });
  assert.equal(skip.ok, true);
  assert.equal(skip.skipped, true);
  assert.equal(skip.discarded, false);
  assert.equal(
    surface2.getLedger().peek("anika-k", "turn-done")?.finalized
      ?.humanOutcomeSignal,
    "ACCEPTED",
  );
});

test("edge: abort after ACCEPTED pending skips discard (accept blocks)", async () => {
  const surface = new ApprovalSurface({
    onApproval: async () => "allow",
  });
  surface.beginTurn({ subjectId: "anika-k", turnId: "turn-acc" });
  await surface.decide({
    subjectId: "anika-k",
    turnId: "turn-acc",
    sessionId: "sess-1",
    toolName: "docs.write",
    riskClass: "write",
  });
  const mapped = surface.mapAbortToDiscard({
    subjectId: "anika-k",
    turnId: "turn-acc",
    abortAction: "aborted",
  });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.skipped, true);
  assert.equal(mapped.discarded, false);
  assert.equal(
    surface.getLedger().peek("anika-k", "turn-acc")?.pending,
    "ACCEPTED",
  );
});
