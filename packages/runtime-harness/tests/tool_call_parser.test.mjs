/**
 * Incremental tool_call_parser — mode state machine + chunk scanner.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PARSER_MODE_TRANSITIONS,
  PARSER_MODES,
  ToolCallParser,
  parseChunks,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function stripModeNoise(events) {
  return events.filter((e) => e.type !== "mode_change");
}

function summarize(events) {
  return stripModeNoise(events).map((e) => {
    if (e.type === "thought_delta" || e.type === "answer_delta") {
      return { type: e.type, delta: e.delta };
    }
    if (e.type === "tool_buffer_delta") {
      return { type: e.type, delta: e.delta };
    }
    if (e.type === "tool_buffer") {
      return { type: e.type, body: e.body };
    }
    if (e.type === "violation") {
      return {
        type: e.type,
        failureClass: e.failureClass,
        discardedBytes: e.discardedBytes,
      };
    }
    return e;
  });
}

test("happy path: thought → tool fence → answer; modes transition", () => {
  const telemetry = [];
  const events = parseChunks(
    [
      "<thought>consider ratio parts…</thought>",
      '```tool_call\n{"toolName":"lookup","arguments":{"query":"ratio"},"callId":"c1"}\n```',
      "A ratio compares quantities.",
    ],
    {
      subjectId: "anika-k",
      deviceId: "edge-aaaa",
      onTelemetry: (e) => telemetry.push(e),
    },
  );

  const sig = summarize(events);
  assert.deepEqual(sig, [
    { type: "thought_delta", delta: "consider ratio parts…" },
    {
      type: "tool_buffer_delta",
      delta:
        '{"toolName":"lookup","arguments":{"query":"ratio"},"callId":"c1"}',
    },
    {
      type: "tool_buffer",
      body: '{"toolName":"lookup","arguments":{"query":"ratio"},"callId":"c1"}',
    },
    { type: "answer_delta", delta: "A ratio compares quantities." },
  ]);

  assert.ok(PARSER_MODES.includes("thought"));
  assert.ok(PARSER_MODE_TRANSITIONS.some((t) => t.on === "open_tool_fence"));
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(!JSON.stringify(telemetry).includes("consider ratio"));
  log({ case: "happy_path", outcome: "ok", events: sig.length });
});

test("edge: empty chunks are no-op (no spurious transitions)", () => {
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  assert.deepEqual(parser.feed(""), []);
  assert.equal(parser.currentMode, "answer");
  assert.deepEqual(parser.feed(""), []);
  const mid = parser.feed("<thought>x</thought>");
  assert.ok(mid.some((e) => e.type === "thought_delta"));
  assert.deepEqual(parser.feed(""), []);
  log({ case: "empty_chunk_noop", outcome: "ok" });
});

test("edge: partial opening fence held across chunks", () => {
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  const a = parser.feed("<thou");
  assert.deepEqual(summarize(a), []);
  assert.ok(parser.pendingBytes > 0);
  const b = parser.feed("ght>hi</thought>");
  assert.deepEqual(summarize(b), [{ type: "thought_delta", delta: "hi" }]);
  log({ case: "partial_open_hold", outcome: "ok" });
});

test("edge: nested tool fence → violation; buffer discarded; never answer", () => {
  const events = parseChunks(
    ["```tool_call\n{\"a\":1}\n```tool_call\n{\"b\":2}\n```"],
    { subjectId: "anika-k" },
  );
  const violations = events.filter((e) => e.type === "violation");
  assert.ok(violations.length >= 1);
  assert.equal(violations[0].failureClass, "nested_fence");
  const answers = events.filter((e) => e.type === "answer_delta");
  assert.equal(answers.length, 0);
  log({ case: "nested_fence_violation", outcome: "rejected" });
});

test("edge: undeclared markup → violation (not answer)", () => {
  const events = parseChunks(["hello <foo>bar</foo>"], {
    subjectId: "anika-k",
  });
  assert.ok(events.some((e) => e.type === "answer_delta" && e.delta === "hello "));
  assert.ok(
    events.some(
      (e) => e.type === "violation" && e.failureClass === "undeclared_markup",
    ),
  );
  assert.ok(!events.some((e) => e.type === "answer_delta" && e.delta.includes("<foo>")));
  log({ case: "undeclared_markup", outcome: "rejected" });
});

test("edge: deadline with open tool-buffer discards and does not hang", () => {
  const parser = new ToolCallParser({ subjectId: "anika-k" });
  parser.feed("```tool_call\n{\"partial\":");
  assert.equal(parser.currentMode, "tool_buffer");
  const events = parser.terminateDeadline();
  assert.ok(
    events.some(
      (e) =>
        e.type === "violation" && e.failureClass === "unclosed_at_deadline",
    ),
  );
  assert.equal(parser.currentMode, "answer");
  assert.equal(parser.pendingBytes, 0);
  log({ case: "deadline_open_tool", outcome: "rejected" });
});

test("purity: identical stream → identical events across chunkings", () => {
  const full =
    "<thought>ab</thought>```tool_call\n{\"x\":1}\n```OK";
  const one = summarize(parseChunks([full], { subjectId: "anika-k" }));
  const charChunks = [...full].map((c) => c);
  const many = summarize(parseChunks(charChunks, { subjectId: "anika-k" }));
  assert.deepEqual(many, one);

  const mid = summarize(
    parseChunks(
      ["<thought>a", "b</thou", "ght>", "```tool_call\n", '{"x":1}', "\n```", "OK"],
      { subjectId: "anika-k" },
    ),
  );
  assert.deepEqual(mid, one);
  log({ case: "chunking_purity", outcome: "ok" });
});

test("sovereignty: subjectId required; telemetry scoped", () => {
  assert.throws(() => new ToolCallParser({ subjectId: "  " }), /subjectId/);
  const telemetry = [];
  const p = new ToolCallParser({
    subjectId: "anika-k",
    deviceId: "edge-bbbb",
    onTelemetry: (e) => telemetry.push(e),
  });
  p.feed("hi");
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(telemetry.every((t) => t.deviceId === "edge-bbbb"));
  log({ case: "subject_scope", outcome: "ok" });
});

test("tool buffer is emitted raw — parser never executes", () => {
  const body = '{"toolName":"lookup","arguments":{"query":"ratio"},"callId":"c1"}';
  const events = parseChunks([`\`\`\`tool_call\n${body}\n\`\`\``], {
    subjectId: "anika-k",
  });
  const done = events.find((e) => e.type === "tool_buffer");
  assert.equal(done.body, body);
  // No invoke / side-effect hooks exist on the parser surface.
  assert.equal(
    Object.getOwnPropertyNames(ToolCallParser.prototype).includes("invoke"),
    false,
  );
  log({ case: "tool_not_executed", outcome: "ok" });
});
