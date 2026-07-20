/**
 * One-shot authoring helper: writes canonical golden-turn fixtures.
 * Does not run in CI and never auto-commits — human review required.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeGoldenTurn,
  goldenTurnFixtureSchema,
} from "../dist/golden_turns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "fixtures", "golden-turns");

const TOOL_FENCE = [
  "```tool_call",
  JSON.stringify({
    toolName: "lookup",
    arguments: { query: "ratio" },
    callId: "c1",
  }),
  "```",
].join("\n");

function base(meta) {
  return {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    ...meta,
  };
}

function session(corr, seq = 0) {
  return {
    type: "SESSION_START",
    sequenceIndex: seq,
    correlationId: corr,
    subjectId: "anika-k",
    protocolVersion: "1.0.0",
    pinnedAt: "2026-07-15T00:00:00.000Z",
  };
}

function advisory(corr, seq) {
  return {
    type: "ADVISORY_ATTACH",
    sequenceIndex: seq,
    correlationId: corr,
    subjectId: "anika-k",
    advisory: {
      code: "CLOCK_SKEW_CLAMPED",
      detail: "clamped remote physical",
    },
  };
}

function toolRunning(corr, seq, id = "c1") {
  return {
    type: "TOOL_STATUS",
    sequenceIndex: seq,
    correlationId: corr,
    subjectId: "anika-k",
    toolCallId: id,
    status: "running",
  };
}

function toolDone(corr, seq, status, id = "c1") {
  return {
    type: "TOOL_STATUS",
    sequenceIndex: seq,
    correlationId: corr,
    subjectId: "anika-k",
    toolCallId: id,
    status,
  };
}

const turns = [
  base({
    id: "thought-answer-basic",
    correlationId: "corr-gt-01",
    coverage: [
      "thought_delta",
      "answer_delta",
      "tool_call_fence",
      "advisory_attach",
      "turn_complete",
    ],
    input: [
      "<thought>consider ratio parts…</thought>",
      TOOL_FENCE,
      "A ratio compares quantities.",
    ],
    expectedFrames: [
      session("corr-gt-01", 0),
      {
        type: "THOUGHT_DELTA",
        sequenceIndex: 1,
        correlationId: "corr-gt-01",
        subjectId: "anika-k",
        delta: "consider ratio parts…",
      },
      toolRunning("corr-gt-01", 2),
      toolDone("corr-gt-01", 3, "success"),
      {
        type: "ANSWER_DELTA",
        sequenceIndex: 4,
        correlationId: "corr-gt-01",
        subjectId: "anika-k",
        delta: "A ratio compares quantities.",
      },
      advisory("corr-gt-01", 5),
      {
        type: "TURN_COMPLETE",
        sequenceIndex: 6,
        correlationId: "corr-gt-01",
        subjectId: "anika-k",
        turnId: "turn-gt-01",
      },
    ],
  }),
  base({
    id: "tool-call-fence",
    correlationId: "corr-gt-02",
    coverage: ["tool_call_fence", "advisory_attach", "turn_complete"],
    input: [
      TOOL_FENCE,
      "lookup returned: part:whole",
    ],
    expectedFrames: [
      session("corr-gt-02", 0),
      toolRunning("corr-gt-02", 1),
      toolDone("corr-gt-02", 2, "success"),
      {
        type: "ANSWER_DELTA",
        sequenceIndex: 3,
        correlationId: "corr-gt-02",
        subjectId: "anika-k",
        delta: "lookup returned: part:whole",
      },
      advisory("corr-gt-02", 4),
      {
        type: "TURN_COMPLETE",
        sequenceIndex: 5,
        correlationId: "corr-gt-02",
        subjectId: "anika-k",
        turnId: "turn-gt-02",
      },
    ],
  }),
  base({
    id: "correction-loop",
    correlationId: "corr-gt-03",
    coverage: [
      "correction_loop",
      "tool_call_fence",
      "thought_delta",
      "advisory_attach",
      "turn_complete",
    ],
    input: [
      "```tool_call\nnot-json\n```",
      "<thought>repair tool envelope…</thought>",
      TOOL_FENCE,
      "Corrected after repair.",
    ],
    expectedFrames: [
      session("corr-gt-03", 0),
      toolDone("corr-gt-03", 1, "error"),
      {
        type: "THOUGHT_DELTA",
        sequenceIndex: 2,
        correlationId: "corr-gt-03",
        subjectId: "anika-k",
        delta: "repair tool envelope…",
      },
      toolRunning("corr-gt-03", 3),
      toolDone("corr-gt-03", 4, "success"),
      {
        type: "ANSWER_DELTA",
        sequenceIndex: 5,
        correlationId: "corr-gt-03",
        subjectId: "anika-k",
        delta: "Corrected after repair.",
      },
      advisory("corr-gt-03", 6),
      {
        type: "TURN_COMPLETE",
        sequenceIndex: 7,
        correlationId: "corr-gt-03",
        subjectId: "anika-k",
        turnId: "turn-gt-03",
      },
    ],
  }),
  base({
    id: "meter-tick",
    correlationId: "corr-gt-04",
    coverage: [
      "meter_tick",
      "tool_call_fence",
      "advisory_attach",
      "turn_complete",
    ],
    input: [TOOL_FENCE, "Metered reply."],
    expectedFrames: [
      session("corr-gt-04", 0),
      toolRunning("corr-gt-04", 1),
      toolDone("corr-gt-04", 2, "success"),
      {
        type: "ANSWER_DELTA",
        sequenceIndex: 3,
        correlationId: "corr-gt-04",
        subjectId: "anika-k",
        delta: "Metered reply.",
      },
      advisory("corr-gt-04", 4),
      {
        type: "METER_TICK",
        sequenceIndex: 5,
        correlationId: "corr-gt-04",
        subjectId: "anika-k",
        tick: {
          inputTokens: 12,
          outputTokens: 4,
          cachedInputTokens: 2,
          latencyMs: 35,
          modelId: "slm-local",
          locality: "on-device",
          aborted: false,
        },
      },
      {
        type: "TURN_COMPLETE",
        sequenceIndex: 6,
        correlationId: "corr-gt-04",
        subjectId: "anika-k",
        turnId: "turn-gt-04",
      },
    ],
  }),
  base({
    id: "harness-error-terminal",
    correlationId: "corr-gt-05",
    coverage: [
      "harness_error",
      "tool_call_fence",
      "advisory_attach",
    ],
    input: [TOOL_FENCE, "<stream truncated>"],
    expectedFrames: [
      session("corr-gt-05", 0),
      toolRunning("corr-gt-05", 1),
      advisory("corr-gt-05", 2),
      {
        type: "HARNESS_ERROR",
        sequenceIndex: 3,
        correlationId: "corr-gt-05",
        subjectId: "anika-k",
        code: "STREAM_TRUNCATED",
        message: "peer closed before TURN_COMPLETE",
        recoverable: true,
      },
    ],
  }),
];

mkdirSync(OUT, { recursive: true });

const manifestTurns = [];
for (const raw of turns) {
  const fixture = goldenTurnFixtureSchema.parse(raw);
  const file = `${fixture.id}.json`;
  writeFileSync(join(OUT, file), canonicalizeGoldenTurn(fixture), "utf8");
  manifestTurns.push({ id: fixture.id, file });
  console.log(`wrote ${file}`);
}

const manifest = {
  version: "1.0.0",
  description:
    "Initial golden-turn corpus: thought/answer, tool fence, correction, meter tick, harness error.",
  turns: manifestTurns,
};
writeFileSync(
  join(OUT, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log("wrote manifest.json");
