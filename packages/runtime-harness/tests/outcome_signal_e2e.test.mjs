/**
 * End-to-end outcome signal integration — golden harness turns for
 * accept / reject / discard / abort / correction.
 *
 * Asserts persisted trajectories carry human_outcome_signal + executionState.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AbortPipeline,
  ApprovalSurface,
  StreamingTurnHost,
} from "../dist/index.js";
import {
  MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL,
  TRAJECTORY_SCHEMA_VERSION,
  assertTrajectoryExportConsent,
  parseTurnTrajectoryRecord,
} from "@moolam/learning";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "outcome-signal");
const MANIFEST = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
);

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "runtime.harness.outcome_signal.e2e", ...event })}\n`,
  );
}

function loadCase(rel) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, rel), "utf8"));
}

function trajectoryDraft(caze, overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: caze.subjectId,
    sessionId: caze.sessionId,
    turnId: caze.turnId,
    deviceId: caze.deviceId,
    capturedAt: "2026-07-15T23:00:00.000Z",
    locality: caze.locality,
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-15T23:00:00.000Z",
    },
    stages: [
      {
        stage: "act",
        opCode: caze.executionState.commandExecuted,
        status:
          caze.expectedSignal === "ACCEPTED"
            ? "ok"
            : caze.expectedSignal === "REJECTED"
              ? "aborted"
              : "skipped",
      },
    ],
    executionState: { ...caze.executionState },
    policyCheckpointHash: "sha256:outcomee2e01",
    precisionFormat: "int4",
    ...overrides,
  };
}

/**
 * Drive a StreamingTurnHost through declared frame types, mirroring tags into
 * the ApprovalSurface ledger for critic replay.
 */
function streamFrames(host, surface, caze, frameTypes) {
  for (const type of frameTypes) {
    let result;
    if (type === "SESSION_START") {
      result = host.emitSessionStart("2026-07-15T23:00:00.000Z");
    } else if (type === "TOKEN_DELTA" || type === "THOUGHT_DELTA") {
      result = host.emitThoughtDelta("…");
      // ThoughtDelta frame type on wire — map for ledger as TOKEN_DELTA alias
      surface.noteFrameType({
        subjectId: caze.subjectId,
        turnId: caze.turnId,
        frameType: "TOKEN_DELTA",
      });
      assert.equal(result.ok, true, type);
      continue;
    } else if (type === "ANSWER_DELTA") {
      result = host.emitAnswerDelta("draft");
    } else if (type === "TOOL_STATUS") {
      result = host.emitToolStatus({
        toolCallId: "tc-1",
        status: "running",
      });
    } else if (type === "TURN_COMPLETE") {
      result = host.emitTurnComplete(caze.turnId);
    } else {
      throw new Error(`unsupported fixture frame type ${type}`);
    }
    assert.equal(result.ok, true, type);
    if (type !== "TURN_COMPLETE") {
      surface.noteFrameType({
        subjectId: caze.subjectId,
        turnId: caze.turnId,
        frameType: type,
      });
    }
  }
}

function createHarness(caze, { onApproval, persistStore, telemetry }) {
  const pipeline = new AbortPipeline({
    onTelemetry: (e) => telemetry.push({ kind: "abort", ...e }),
  });
  const surface = new ApprovalSurface({
    onApproval,
    onTelemetry: (e) => telemetry.push({ kind: "approval", ...e }),
    persistTrajectory: async (record) => {
      persistStore.push(record);
    },
  });
  const frames = [];
  const host = new StreamingTurnHost({
    subjectId: caze.subjectId,
    correlationId: `corr-${caze.turnId}`,
    deviceId: caze.deviceId,
    sessionId: caze.sessionId,
    onFrame: (f) => frames.push(f),
    onTelemetry: (e) => telemetry.push({ kind: "stream", ...e }),
  });
  return { pipeline, surface, host, frames };
}

test("manifest lists every golden outcome path once", () => {
  const ids = MANIFEST.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const expected of [
    "accepted",
    "rejected",
    "user-discard",
    "abort-without-accept",
    "correction-amendment",
  ]) {
    assert.ok(ids.includes(expected), `missing case ${expected}`);
  }
});

test("e2e happy path: accept → ACCEPTED + executionState on persisted trajectory", async () => {
  const entry = MANIFEST.cases.find((c) => c.id === "accepted");
  const caze = loadCase(entry.file);
  const persistStore = [];
  const telemetry = [];
  const { pipeline, surface, host, frames } = createHarness(caze, {
    onApproval: async () => "allow",
    persistStore,
    telemetry,
  });

  assert.equal(
    pipeline.registerTurn({
      turnId: caze.turnId,
      subjectId: caze.subjectId,
      deviceId: caze.deviceId,
    }).ok,
    true,
  );
  assert.equal(
    surface.beginTurn({
      subjectId: caze.subjectId,
      turnId: caze.turnId,
      deviceId: caze.deviceId,
      trajectoryDraft: trajectoryDraft(caze),
    }).ok,
    true,
  );

  const preComplete = caze.streamFrames.filter((t) => t !== "TURN_COMPLETE");
  streamFrames(host, surface, caze, preComplete);

  const decided = await surface.decide({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    sessionId: caze.sessionId,
    deviceId: caze.deviceId,
    toolName: "tool.write",
    riskClass: "write",
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.humanOutcomeSignal, "ACCEPTED");

  assert.equal(host.emitTurnComplete(caze.turnId).ok, true);
  const completed = surface.completeTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.binding.humanOutcomeSignal, "ACCEPTED");

  pipeline.markTurnCompleted(caze.turnId, {
    subjectId: caze.subjectId,
    effectsCommitted: true,
  });
  const abortAfter = await pipeline.abort(caze.turnId, {
    subjectId: caze.subjectId,
  });
  assert.equal(abortAfter.action, "already_completed");
  const skipDiscard = surface.mapAbortToDiscard({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    abortAction: abortAfter.action,
  });
  assert.equal(skipDiscard.skipped, true);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(persistStore.length, 1);
  const rec = persistStore[0];
  assert.equal(rec.humanOutcomeSignal, "ACCEPTED");
  assert.deepEqual(rec.executionState, caze.executionState);
  assert.equal(rec.subjectId, caze.subjectId);
  assert.equal(rec.preAbortFrameTypes, undefined);

  const gate = assertTrajectoryExportConsent(rec);
  assert.equal(gate.ok, true);
  assert.ok(frames.some((f) => f.type === "TURN_COMPLETE"));
  assert.ok(
    telemetry.some(
      (t) =>
        t.kind === "approval" && t.humanOutcomeSignal === "ACCEPTED",
    ),
  );
  log({
    outcome: "ok",
    case: caze.id,
    subjectId: caze.subjectId,
    deviceId: caze.deviceId,
    signal: rec.humanOutcomeSignal,
  });
});

test("e2e happy path: reject → REJECTED keeps pre-abort frames + executionState", async () => {
  const caze = loadCase("cases/rejected.json");
  const persistStore = [];
  const telemetry = [];
  const { surface, host } = createHarness(caze, {
    onApproval: async () => "deny",
    persistStore,
    telemetry,
  });

  surface.beginTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    deviceId: caze.deviceId,
    trajectoryDraft: trajectoryDraft(caze),
  });
  streamFrames(
    host,
    surface,
    caze,
    caze.streamFrames.filter((t) => t !== "TURN_COMPLETE"),
  );

  const decided = await surface.decide({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    sessionId: caze.sessionId,
    toolName: "tool.write",
    riskClass: "write",
  });
  assert.equal(decided.humanOutcomeSignal, "REJECTED");

  host.emitTurnComplete(caze.turnId);
  const done = surface.completeTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
  });
  assert.equal(done.ok, true);
  assert.deepEqual(
    done.binding.preAbortFrameTypes,
    caze.expectedPreAbortFrameTypes,
  );

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(persistStore[0].humanOutcomeSignal, "REJECTED");
  assert.deepEqual(persistStore[0].executionState, caze.executionState);
  assert.deepEqual(
    persistStore[0].preAbortFrameTypes,
    caze.expectedPreAbortFrameTypes,
  );
  log({
    outcome: "ok",
    case: caze.id,
    subjectId: caze.subjectId,
    signal: "REJECTED",
  });
});

test("e2e happy path: user discard → DISCARDED (diff surface)", async () => {
  const caze = loadCase("cases/user-discard.json");
  const persistStore = [];
  const { surface, host } = createHarness(caze, {
    persistStore,
    telemetry: [],
  });

  surface.beginTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    deviceId: caze.deviceId,
    trajectoryDraft: trajectoryDraft(caze),
  });
  streamFrames(host, surface, caze, caze.streamFrames);

  const discarded = surface.discardTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
  });
  assert.equal(discarded.ok, true);
  assert.equal(discarded.binding.humanOutcomeSignal, "DISCARDED");
  assert.equal(discarded.abandonmentKind, "user_discard");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(persistStore[0].humanOutcomeSignal, "DISCARDED");
  assert.equal(persistStore[0].abandonmentKind, "user_discard");
  assert.deepEqual(persistStore[0].executionState, caze.executionState);
  assert.deepEqual(
    persistStore[0].preAbortFrameTypes,
    caze.expectedPreAbortFrameTypes,
  );
});

test("e2e happy path: abort-without-accept → DISCARDED via AbortPipeline", async () => {
  const caze = loadCase("cases/abort-without-accept.json");
  const persistStore = [];
  const telemetry = [];
  const { pipeline, surface, host } = createHarness(caze, {
    persistStore,
    telemetry,
  });

  assert.equal(
    pipeline.registerTurn({
      turnId: caze.turnId,
      subjectId: caze.subjectId,
      deviceId: caze.deviceId,
    }).ok,
    true,
  );
  surface.beginTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    deviceId: caze.deviceId,
    trajectoryDraft: trajectoryDraft(caze),
  });
  streamFrames(host, surface, caze, caze.streamFrames);

  const abortResult = await pipeline.abort(caze.turnId, {
    subjectId: caze.subjectId,
  });
  assert.equal(abortResult.ok, true);
  assert.equal(abortResult.action, "aborted");

  const mapped = surface.mapAbortToDiscard({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    abortAction: abortResult.action,
  });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.discarded, true);
  assert.equal(mapped.binding.humanOutcomeSignal, "DISCARDED");
  assert.equal(mapped.binding.abandonmentKind, "abort_without_accept");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(persistStore[0].humanOutcomeSignal, "DISCARDED");
  assert.deepEqual(persistStore[0].executionState, caze.executionState);

  // Idempotent second abort → already_aborted still DISCARDED
  const abort2 = await pipeline.abort(caze.turnId, {
    subjectId: caze.subjectId,
  });
  assert.equal(abort2.action, "already_aborted");
  const mapped2 = surface.mapAbortToDiscard({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    abortAction: abort2.action,
  });
  assert.equal(mapped2.discarded, true);
  assert.equal(persistStore.length, 1);
});

test("e2e happy path: correction after ACCEPTED preserves prior signal", async () => {
  const caze = loadCase("cases/correction-amendment.json");
  assert.equal(MANUAL_CORRECTION_PRESERVES_PRIOR_SIGNAL.priorSignalImmutable, true);

  const persistStore = [];
  const { surface, host } = createHarness(caze, {
    onApproval: async () => "allow",
    persistStore,
    telemetry: [],
  });

  surface.beginTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    deviceId: caze.deviceId,
    trajectoryDraft: trajectoryDraft(caze),
  });
  streamFrames(
    host,
    surface,
    caze,
    caze.streamFrames.filter((t) => t !== "TURN_COMPLETE"),
  );
  await surface.decide({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    sessionId: caze.sessionId,
    toolName: "tool.write",
    riskClass: "write",
  });
  host.emitTurnComplete(caze.turnId);
  surface.completeTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
  });

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(persistStore[0].humanOutcomeSignal, "ACCEPTED");

  const linked = surface.linkCorrectionAfterAccepted({
    subjectId: caze.subjectId,
    originalTurnId: caze.turnId,
    amendmentTurnId: caze.amendmentTurnId,
    deviceId: caze.deviceId,
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.binding.amendsTurnId, caze.turnId);
  assert.equal(linked.binding.humanOutcomeSignal, "ACCEPTED");

  const original = surface.getLedger().peek(caze.subjectId, caze.turnId)
    ?.finalized;
  assert.equal(original?.humanOutcomeSignal, "ACCEPTED");
  assert.equal(original?.amendsTurnId, undefined);
  // Never overwrite via discard after ACCEPTED
  const blocked = surface.discardTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
  });
  assert.equal(blocked.ok, false);
});

test("e2e edge: approval timeout ≠ DISCARDED; consent gate still enforced", async () => {
  const caze = {
    ...loadCase("cases/accepted.json"),
    turnId: "turn-outcome-timeout",
  };
  const telemetry = [];
  const surface = new ApprovalSurface({
    onApproval: () => new Promise(() => {}),
    onTelemetry: (e) => telemetry.push(e),
  });
  surface.beginTurn({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    deviceId: caze.deviceId,
  });
  const result = await surface.decide({
    subjectId: caze.subjectId,
    turnId: caze.turnId,
    sessionId: caze.sessionId,
    toolName: "tool.write",
    riskClass: "write",
    deadlineMs: 20,
  });
  assert.equal(result.timedOut, true);
  assert.ok(telemetry.some((t) => t.harnessEvent === "approval_timeout"));
  assert.ok(!telemetry.some((t) => t.humanOutcomeSignal === "DISCARDED"));

  const declined = trajectoryDraft(caze, {
    turnId: caze.turnId,
    consent: {
      optedIn: false,
      consentClass: "research",
      recordedAt: "2026-07-15T23:00:00.000Z",
    },
  });
  const parsed = parseTurnTrajectoryRecord(declined);
  assert.equal(parsed.ok, true);
  const gate = assertTrajectoryExportConsent(parsed.record);
  assert.equal(gate.ok, false);
  assert.equal(gate.failureClass, "consent_denied");
});

test("e2e edge: subject isolation across concurrent accept + discard", async () => {
  const storeA = [];
  const storeB = [];
  const a = loadCase("cases/accepted.json");
  const b = {
    ...loadCase("cases/user-discard.json"),
    subjectId: "ravi-m",
    turnId: "turn-outcome-ravi",
    deviceId: "host-bbbb",
  };

  const surfaceA = new ApprovalSurface({
    onApproval: async () => "allow",
    persistTrajectory: async (r) => storeA.push(r),
  });
  const surfaceB = new ApprovalSurface({
    persistTrajectory: async (r) => storeB.push(r),
  });

  await Promise.all([
    (async () => {
      surfaceA.beginTurn({
        subjectId: a.subjectId,
        turnId: a.turnId,
        trajectoryDraft: trajectoryDraft(a),
      });
      await surfaceA.decide({
        subjectId: a.subjectId,
        turnId: a.turnId,
        sessionId: a.sessionId,
        toolName: "tool.write",
        riskClass: "write",
      });
      surfaceA.completeTurn({
        subjectId: a.subjectId,
        turnId: a.turnId,
      });
    })(),
    (async () => {
      surfaceB.beginTurn({
        subjectId: b.subjectId,
        turnId: b.turnId,
        trajectoryDraft: trajectoryDraft(b),
      });
      surfaceB.discardTurn({
        subjectId: b.subjectId,
        turnId: b.turnId,
      });
    })(),
  ]);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(storeA[0].subjectId, "anika-k");
  assert.equal(storeA[0].humanOutcomeSignal, "ACCEPTED");
  assert.equal(storeB[0].subjectId, "ravi-m");
  assert.equal(storeB[0].humanOutcomeSignal, "DISCARDED");
  assert.notEqual(storeA[0].subjectId, storeB[0].subjectId);
});

test("e2e edge: set-once — second conflicting decision rejected; async write non-blocking", async () => {
  let writerStarted = false;
  let writerDone = false;
  const surface = new ApprovalSurface({
    onApproval: async () => "allow",
    persistTrajectory: async () => {
      writerStarted = true;
      await new Promise((r) => setTimeout(r, 35));
      writerDone = true;
    },
  });
  const caze = loadCase("cases/accepted.json");
  surface.beginTurn({
    subjectId: caze.subjectId,
    turnId: "turn-once",
    trajectoryDraft: trajectoryDraft({ ...caze, turnId: "turn-once" }),
  });
  await surface.decide({
    subjectId: caze.subjectId,
    turnId: "turn-once",
    sessionId: caze.sessionId,
    toolName: "tool.write",
    riskClass: "write",
  });
  const conflict = await surface.decide({
    subjectId: caze.subjectId,
    turnId: "turn-once",
    sessionId: caze.sessionId,
    toolName: "tool.write",
    riskClass: "write",
    decision: "deny",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.failureClass, "already_set");

  const queued = surface.completeTurn({
    subjectId: caze.subjectId,
    turnId: "turn-once",
  });
  assert.equal(queued.ok, true);
  assert.equal(queued.persisted, true);
  assert.equal(writerDone, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(writerStarted, true);
  assert.equal(writerDone, true);
});
