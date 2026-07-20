/**
 * GymEnv step() wired to production turn loop + tool registry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GymEnv,
  GYM_TERMINAL_FRAME_TYPES,
  loadGymScenarioFixture,
  terminalFromHarnessFrames,
} from "../env.ts";
import {
  assertByteIdenticalCanonicalFrames,
  replayProductionTrajectoryThroughGym,
} from "../src/frame_parity.mjs";
import {
  createDefaultGymToolRegistry,
  loadGoldenTurnCorpus,
} from "../src/harness_bridge.mjs";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("happy path: reset loads golden scenario and seeds harness", () => {
  const events: object[] = [];
  const env = new GymEnv({
    subjectId: "subj.gym.env.unit",
    deviceId: "dev-gym-env-unit",
    onTelemetry: (e) => events.push(e),
  });

  const reset = env.reset("thought-answer-basic", 42);
  assert.equal(reset.ok, true, JSON.stringify(reset));
  if (!reset.ok) return;

  assert.equal(reset.scenarioId, "thought-answer-basic");
  assert.equal(reset.seed, 42);
  assert.equal(env.getHarnessSeed(), 42);
  assert.equal(reset.observation.terminal, false);
  assert.ok(
    events.some(
      (e) =>
        (e as { op?: string; outcome?: string }).op === "reset" &&
        (e as { outcome?: string }).outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: turn_loop step uses production host + registry", async () => {
  const events: object[] = [];
  const env = new GymEnv({
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(env.reset("thought-answer-basic", 7).ok, true);

  const stepped = await env.step({ path: "turn_loop" });
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  if (!stepped.ok) return;

  assert.equal(stepped.path, "turn_loop");
  assert.ok((stepped.toolInvocations ?? 0) >= 1);
  assert.equal(stepped.terminal, true);
  assert.ok(
    stepped.terminalFrameType === "TURN_COMPLETE" ||
      stepped.terminalFrameType === "HARNESS_ERROR",
  );
  assert.ok(GYM_TERMINAL_FRAME_TYPES.includes(stepped.terminalFrameType!));

  const types = stepped.frames.map((f) => (f as { type?: string }).type);
  assert.ok(types.includes("SESSION_START"));
  assert.ok(types.includes("TOOL_STATUS"));
  assert.equal(types[types.length - 1], stepped.terminalFrameType);

  const derived = terminalFromHarnessFrames(stepped.frames);
  assert.equal(derived.terminal, true);
  assert.equal("done" in stepped.observation, false);
  assert.ok(
    events.some(
      (e) =>
        (e as { op?: string }).op === "step" &&
        (e as { outcome?: string }).outcome === "ok",
    ),
  );
});

test("happy path: golden_replay path stays byte-identical to production corpus", async () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const fixture = loaded.fixtures.find((f) => f.id === "thought-answer-basic");
  assert.ok(fixture);

  const direct = replayProductionTrajectoryThroughGym(fixture);
  assert.equal(direct.ok, true);
  if (!direct.ok) return;

  const env = new GymEnv();
  assert.equal(env.reset(fixture.id, 1).ok, true);
  const stepped = await env.step({ path: "golden_replay" });
  assert.equal(stepped.ok, true);
  if (!stepped.ok) return;
  assert.equal(stepped.path, "golden_replay");

  const byteCheck = assertByteIdenticalCanonicalFrames(
    direct.frames,
    stepped.frames,
    { turnId: fixture.id },
  );
  assert.equal(byteCheck.ok, true, byteCheck.diff);
});

test("edge: step before reset fails not_reset", async () => {
  const env = new GymEnv({ subjectId: "subj.gym.env.early" });
  const stepped = await env.step({});
  assert.equal(stepped.ok, false);
  if (stepped.ok) return;
  assert.equal(stepped.failureClass, "not_reset");
});

test("edge: unknown scenario / invalid seed", () => {
  const env = new GymEnv();
  const unknown = env.reset("does-not-exist-scenario", 0);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.failureClass, "unknown_scenario");
  }

  const badSeed = env.reset("thought-answer-basic", -1);
  assert.equal(badSeed.ok, false);
  if (!badSeed.ok) {
    assert.equal(badSeed.failureClass, "invalid_seed");
  }
});

test("edge: HARNESS_ERROR via turn_loop on truncated stream", async () => {
  const env = new GymEnv();
  assert.equal(env.reset("harness-error-terminal", 99).ok, true);
  const stepped = await env.step({ path: "turn_loop" });
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  if (!stepped.ok) return;
  assert.equal(stepped.terminal, true);
  assert.equal(stepped.terminalFrameType, "HARNESS_ERROR");
  const last = stepped.frames[stepped.frames.length - 1] as {
    type?: string;
    code?: string;
    gymMock?: boolean;
  };
  assert.equal(last.type, "HARNESS_ERROR");
  assert.equal(last.code, "STREAM_TRUNCATED");
  assert.equal(last.gymMock, undefined);
});

test("edge: invalid tool call returns real TOOL_STATUS error via registry path", async () => {
  const env = new GymEnv();
  assert.equal(env.reset("thought-answer-basic", 3).ok, true);
  const stepped = await env.step({
    path: "turn_loop",
    chunks: [
      "```tool_call\nnot-json\n```",
      "fallback answer after bad tool.",
    ],
  });
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  if (!stepped.ok) return;
  const errStatus = stepped.frames.find(
    (f) =>
      (f as { type?: string; status?: string }).type === "TOOL_STATUS" &&
      (f as { status?: string }).status === "error",
  );
  assert.ok(errStatus, "expected real TOOL_STATUS error from correction/host");
  assert.equal((errStatus as { gymMock?: boolean }).gymMock, undefined);
  assert.equal(stepped.terminal, true);
});

test("edge: unknown tool name yields typed TOOL_STATUS error (not gym mock)", async () => {
  const registry = createDefaultGymToolRegistry();
  const env = new GymEnv({ registry });
  assert.equal(env.reset("thought-answer-basic", 5).ok, true);
  const stepped = await env.step({
    path: "turn_loop",
    chunks: [
      '```tool_call\n{"toolName":"missing-tool","arguments":{"q":"x"},"callId":"c9"}\n```',
      "done",
    ],
  });
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  if (!stepped.ok) return;
  const err = stepped.frames.find(
    (f) =>
      (f as { type?: string; status?: string; toolCallId?: string }).type ===
        "TOOL_STATUS" &&
      (f as { status?: string }).status === "error" &&
      (f as { toolCallId?: string }).toolCallId === "c9",
  );
  assert.ok(err);
  assert.match(String((err as { detail?: string }).detail), /unknown_tool/);
});

test("sovereignty: subject-scoped frames; replay step is idempotent", async () => {
  const env = new GymEnv();
  assert.equal(env.reset("thought-answer-basic", 3).ok, true);
  const step1 = await env.step({ path: "turn_loop" });
  assert.equal(step1.ok, true);
  if (!step1.ok) return;
  for (const frame of step1.frames) {
    assert.equal((frame as { subjectId?: string }).subjectId, step1.subjectId);
  }
  const step2 = await env.step({ path: "turn_loop" });
  assert.equal(step2.ok, true);
  if (!step2.ok) return;
  assert.deepEqual(step2.frames, step1.frames);
  assert.equal(step2.observation.stepIndex, step1.observation.stepIndex);

  const cross = loadGymScenarioFixture(
    { scenarioId: "thought-answer-basic", subjectId: "other-subject" },
    { subjectId: "subj.cross" },
  );
  assert.equal(cross.ok, false);
  if (!cross.ok) {
    assert.equal(cross.failureClass, "cross_subject");
  }
});

test("edge: same seed + scenario turn_loop is reproducible", async () => {
  const env1 = new GymEnv();
  const env2 = new GymEnv();
  assert.equal(env1.reset("thought-answer-basic", 11).ok, true);
  assert.equal(env2.reset("thought-answer-basic", 11).ok, true);
  const s1 = await env1.step({ path: "turn_loop" });
  const s2 = await env2.step({ path: "turn_loop" });
  assert.equal(s1.ok && s2.ok, true);
  if (!s1.ok || !s2.ok) return;
  assert.deepEqual(s1.frames, s2.frames);
  assert.equal(s1.terminalFrameType, s2.terminalFrameType);
});
