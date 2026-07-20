/**
 * Episode termination mapping — TURN_COMPLETE / HARNESS_ERROR only;
 * no custom done; invalid tool → real B4 typed error frame.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GymEnv,
  GYM_NON_TERMINAL_FRAME_TYPES,
  GYM_TERMINAL_FRAME_TYPES,
  assertEpisodeTerminationMapping,
  isGymTerminalFrameType,
  terminalFromHarnessFrames,
} from "../env.ts";
import {
  assertByteIdenticalCanonicalFrames,
  replayProductionTrajectoryThroughGym,
} from "../src/frame_parity.mjs";
import {
  HARNESS_FRAME_TYPES,
  loadGoldenTurnCorpus,
} from "../src/harness_bridge.mjs";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

function stubFrame(type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    sequenceIndex: 0,
    correlationId: "corr-term",
    subjectId: "anika-k",
    ...extra,
  };
}

test("happy path: TURN_COMPLETE maps to terminal", () => {
  const events: object[] = [];
  const frames = [
    stubFrame("SESSION_START", {
      protocolVersion: "1.0.0",
      pinnedAt: "2026-07-15T00:00:00.000Z",
    }),
    stubFrame("TURN_COMPLETE", { turnId: "turn-1" }),
  ];
  const mapped = assertEpisodeTerminationMapping({
    frames,
    observation: { terminal: true, terminalFrameType: "TURN_COMPLETE" },
    subjectId: "subj.term.tc",
    deviceId: "dev-term",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(mapped.ok, true, JSON.stringify(mapped));
  if (!mapped.ok) return;
  assert.equal(mapped.terminal, true);
  assert.equal(mapped.terminalFrameType, "TURN_COMPLETE");
  assert.ok(isGymTerminalFrameType(mapped.terminalFrameType));
  assert.ok(GYM_TERMINAL_FRAME_TYPES.includes("TURN_COMPLETE"));
  assert.ok(events.some((e) => (e as { outcome?: string }).outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: HARNESS_ERROR maps to terminal", () => {
  const frames = [
    stubFrame("SESSION_START", {
      protocolVersion: "1.0.0",
      pinnedAt: "2026-07-15T00:00:00.000Z",
    }),
    stubFrame("HARNESS_ERROR", {
      code: "STREAM_TRUNCATED",
      message: "peer closed before TURN_COMPLETE",
      recoverable: true,
    }),
  ];
  const mapped = assertEpisodeTerminationMapping({
    frames,
    observation: { terminal: true, terminalFrameType: "HARNESS_ERROR" },
    subjectId: "subj.term.he",
  });
  assert.equal(mapped.ok, true, JSON.stringify(mapped));
  if (!mapped.ok) return;
  assert.equal(mapped.terminal, true);
  assert.equal(mapped.terminalFrameType, "HARNESS_ERROR");
});

test("edge: no other harness frame type sets terminal / done", () => {
  for (const type of HARNESS_FRAME_TYPES) {
    if (isGymTerminalFrameType(type)) continue;
    assert.ok(
      (GYM_NON_TERMINAL_FRAME_TYPES as readonly string[]).includes(type),
      `${type} should be listed as non-terminal`,
    );
    const derived = terminalFromHarnessFrames([stubFrame(type)]);
    assert.equal(derived.terminal, false, `${type} must not terminate`);
    assert.equal(derived.terminalFrameType, null);

    const mapped = assertEpisodeTerminationMapping({
      frames: [stubFrame(type)],
      observation: { terminal: false, terminalFrameType: null },
      subjectId: "subj.term.non",
    });
    assert.equal(mapped.ok, true, `${type}: ${JSON.stringify(mapped)}`);
  }

  const derivedTerminals = HARNESS_FRAME_TYPES.filter((t) =>
    isGymTerminalFrameType(t),
  );
  assert.deepEqual([...derivedTerminals], [...GYM_TERMINAL_FRAME_TYPES]);
});

test("edge: custom observation.done is rejected", () => {
  const mapped = assertEpisodeTerminationMapping({
    frames: [stubFrame("TURN_COMPLETE", { turnId: "t" })],
    observation: {
      terminal: true,
      terminalFrameType: "TURN_COMPLETE",
      done: true,
    },
    subjectId: "subj.term.done",
  });
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.failureClass, "custom_done_forbidden");
});

test("edge: observation.terminal mismatch vs frames fails loudly", () => {
  const mapped = assertEpisodeTerminationMapping({
    frames: [stubFrame("TOOL_STATUS", { toolCallId: "c1", status: "running" })],
    observation: { terminal: true, terminalFrameType: "TURN_COMPLETE" },
    subjectId: "subj.term.mismatch",
  });
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.failureClass, "terminal_mismatch");
});

test("edge: invalid tool call produces real B4 TOOL_STATUS error (not gym mock)", async () => {
  const events: object[] = [];
  const env = new GymEnv({
    subjectId: "subj.term.tool",
    deviceId: "dev-term",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(env.reset("thought-answer-basic", 2).ok, true);
  const stepped = await env.step({
    path: "turn_loop",
    chunks: [
      "```tool_call\n{not-valid-json\n```",
      "continue after repair path.",
    ],
  });
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  if (!stepped.ok) return;

  const errStatus = stepped.frames.find(
    (f) =>
      (f as { type?: string; status?: string }).type === "TOOL_STATUS" &&
      (f as { status?: string }).status === "error",
  );
  assert.ok(errStatus, "expected real B4 TOOL_STATUS error frame");
  assert.equal((errStatus as { gymMock?: boolean }).gymMock, undefined);
  assert.equal(typeof (errStatus as { sequenceIndex?: number }).sequenceIndex, "number");
  assert.equal((errStatus as { subjectId?: string }).subjectId, stepped.subjectId);

  // TOOL_STATUS alone is not terminal — only last TURN_COMPLETE / HARNESS_ERROR.
  const mid = terminalFromHarnessFrames([errStatus]);
  assert.equal(mid.terminal, false);

  const mapped = assertEpisodeTerminationMapping({
    frames: stepped.frames,
    observation: stepped.observation,
    subjectId: stepped.subjectId,
    deviceId: stepped.deviceId,
  });
  assert.equal(mapped.ok, true, JSON.stringify(mapped));
  if (!mapped.ok) return;
  assert.equal(mapped.terminal, true);
  assert.ok(
    mapped.terminalFrameType === "TURN_COMPLETE" ||
      mapped.terminalFrameType === "HARNESS_ERROR",
  );
  assert.equal("done" in stepped.observation, false);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: GymEnv TURN_COMPLETE / HARNESS_ERROR episodes match mapping", async () => {
  const envOk = new GymEnv();
  assert.equal(envOk.reset("thought-answer-basic", 1).ok, true);
  const okStep = await envOk.step({ path: "turn_loop" });
  assert.equal(okStep.ok, true);
  if (!okStep.ok) return;
  assert.equal(okStep.terminalFrameType, "TURN_COMPLETE");
  assert.equal(
    assertEpisodeTerminationMapping({
      frames: okStep.frames,
      observation: okStep.observation,
      subjectId: okStep.subjectId,
    }).ok,
    true,
  );

  const envErr = new GymEnv();
  assert.equal(envErr.reset("harness-error-terminal", 1).ok, true);
  const errStep = await envErr.step({ path: "turn_loop" });
  assert.equal(errStep.ok, true);
  if (!errStep.ok) return;
  assert.equal(errStep.terminalFrameType, "HARNESS_ERROR");
  assert.equal(
    assertEpisodeTerminationMapping({
      frames: errStep.frames,
      observation: errStep.observation,
      subjectId: errStep.subjectId,
    }).ok,
    true,
  );
});

test("happy path: recorded golden trajectory terminal matches production replay", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  for (const fixture of loaded.fixtures) {
    const replayed = replayProductionTrajectoryThroughGym(fixture);
    assert.equal(replayed.ok, true, fixture.id);
    if (!replayed.ok) continue;

    const byteCheck = assertByteIdenticalCanonicalFrames(
      fixture.expectedFrames,
      replayed.frames,
      { turnId: fixture.id },
    );
    assert.equal(byteCheck.ok, true, `${fixture.id}\n${byteCheck.diff}`);

    const mapped = assertEpisodeTerminationMapping({
      frames: replayed.frames,
      subjectId: fixture.subjectId,
      deviceId: fixture.deviceId,
    });
    assert.equal(mapped.ok, true, fixture.id);
    if (!mapped.ok) continue;
    assert.equal(mapped.terminal, true);
    assert.ok(isGymTerminalFrameType(mapped.terminalFrameType));
    const last = replayed.frames[replayed.frames.length - 1] as {
      type?: string;
    };
    assert.equal(mapped.terminalFrameType, last.type);
  }
});

test("sovereignty: mapping is subject-scoped and idempotent", () => {
  const frames = [stubFrame("TURN_COMPLETE", { turnId: "t-idem" })];
  const a = assertEpisodeTerminationMapping({
    frames,
    subjectId: "subj.term.a",
    deviceId: "dev-a",
  });
  const b = assertEpisodeTerminationMapping({
    frames,
    subjectId: "subj.term.a",
    deviceId: "dev-a",
  });
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);

  const other = assertEpisodeTerminationMapping({
    frames,
    subjectId: "subj.term.b",
    deviceId: "dev-b",
  });
  assert.equal(other.ok, true);
  if (!a.ok || !other.ok) return;
  assert.notEqual(a.subjectId, other.subjectId);
  assert.equal(a.terminalFrameType, other.terminalFrameType);
});
