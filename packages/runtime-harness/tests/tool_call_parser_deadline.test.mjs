/**
 * Unclosed fence deadline termination — never hang waiting for close.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PARSER_DECLARED_TAGS,
  PARSER_MODE_TRANSITIONS,
  ToolCallParser,
  parseChunks,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const OPTS = { subjectId: "anika-k", deviceId: "edge-deadline" };

test("happy path: open tool_buffer deadline → violation, discard, recover", () => {
  const telemetry = [];
  const parser = new ToolCallParser({
    ...OPTS,
    onTelemetry: (e) => telemetry.push(e),
  });
  parser.feed(`${PARSER_DECLARED_TAGS.openToolFence}{"partial":true`);
  assert.equal(parser.currentMode, "tool_buffer");
  assert.equal(parser.hasOpenFence, true);

  const events = parser.terminateDeadline();
  assert.ok(
    events.some(
      (e) =>
        e.type === "violation" && e.failureClass === "unclosed_at_deadline",
    ),
  );
  assert.ok(events.some((e) => e.type === "mode_change" && e.to === "violation"));
  assert.ok(events.some((e) => e.type === "mode_change" && e.to === "answer"));
  assert.equal(parser.currentMode, "answer");
  assert.equal(parser.hasOpenFence, false);
  assert.equal(parser.pendingBytes, 0);
  assert.ok(!events.some((e) => e.type === "answer_delta"));
  assert.ok(!events.some((e) => e.type === "tool_buffer"));

  const rejected = telemetry.filter((t) => t.outcome === "rejected");
  assert.ok(rejected.some((t) => t.failureClass === "unclosed_at_deadline"));
  assert.ok(rejected.every((t) => t.subjectId === "anika-k"));
  assert.ok(!JSON.stringify(telemetry).includes("partial"));
  log({ case: "deadline_tool_buffer", outcome: "rejected" });
});

test("edge: open thought at deadline discards body; never answer", () => {
  const parser = new ToolCallParser(OPTS);
  parser.feed(`${PARSER_DECLARED_TAGS.openThought}secret reasoning`);
  assert.equal(parser.currentMode, "thought");
  const events = parser.terminateDeadline();
  assert.ok(
    events.some((e) => e.failureClass === "unclosed_at_deadline"),
  );
  assert.ok(!events.some((e) => e.type === "answer_delta"));
  assert.ok(!events.some((e) => e.type === "thought_delta"));
  assert.equal(parser.pendingBytes, 0);
  log({ case: "deadline_thought", outcome: "rejected" });
});

test("edge: incomplete open fence held in answer → deadline discards hold", () => {
  const parser = new ToolCallParser(OPTS);
  parser.feed("```tool_");
  assert.equal(parser.currentMode, "answer");
  assert.equal(parser.hasOpenFence, true);
  assert.ok(parser.heldFragmentBytes > 0);

  const events = parser.terminateDeadline();
  assert.ok(
    events.some((e) => e.failureClass === "unclosed_at_deadline"),
  );
  assert.ok(!events.some((e) => e.type === "answer_delta"));
  assert.equal(parser.hasOpenFence, false);
  assert.equal(parser.pendingBytes, 0);
  assert.ok(
    PARSER_MODE_TRANSITIONS.some((t) => t.on === "deadline_held_fragment"),
  );
  log({ case: "deadline_held_open_fragment", outcome: "rejected" });
});

test("edge: held close fence waiting for more bytes → deadline discards (no hang)", () => {
  const parser = new ToolCallParser(OPTS);
  parser.feed(`${PARSER_DECLARED_TAGS.openToolFence}{"a":1}`);
  // Feed only the close ticks — without EOF these stay held (could still be nested).
  parser.feed("\n```");
  assert.equal(parser.currentMode, "tool_buffer");
  assert.equal(parser.hasOpenFence, true);

  const started = Date.now();
  const events = parser.terminateDeadline();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, "deadline must be synchronous (no hang)");
  assert.ok(
    events.some((e) => e.failureClass === "unclosed_at_deadline"),
  );
  assert.ok(!events.some((e) => e.type === "tool_buffer"));
  assert.equal(parser.pendingBytes, 0);
  log({ case: "deadline_held_close", outcome: "rejected", elapsedMs: elapsed });
});

test("edge: empty chunks then deadline — still terminates open fence", () => {
  const parser = new ToolCallParser(OPTS);
  parser.feed("```tool_call\n{");
  assert.deepEqual(parser.feed(""), []);
  assert.deepEqual(parser.feed(""), []);
  const events = parser.terminateDeadline();
  assert.ok(
    events.some((e) => e.failureClass === "unclosed_at_deadline"),
  );
  log({ case: "deadline_after_empty_chunks", outcome: "rejected" });
});

test("edge: idempotent deadline — second call is no-op", () => {
  const parser = new ToolCallParser(OPTS);
  parser.feed("```tool_call\n{");
  const first = parser.terminateDeadline();
  assert.ok(first.some((e) => e.type === "violation"));
  const second = parser.terminateDeadline();
  assert.deepEqual(second, []);
  assert.equal(parser.hasOpenFence, false);
  log({ case: "deadline_idempotent", outcome: "ok" });
});

test("edge: after deadline, later answer text is clean (no fence leak)", () => {
  const parser = new ToolCallParser(OPTS);
  parser.feed('```tool_call\n{"secret":1}');
  parser.terminateDeadline();
  const after = parseChunks(["safe answer"], {
    subjectId: "anika-k",
  });
  // Fresh parser for clean answer; same host continues:
  const cont = parser.feed("safe answer");
  const end = parser.end();
  const answers = [...cont, ...end].filter((e) => e.type === "answer_delta");
  assert.deepEqual(
    answers.map((e) => e.delta).join(""),
    "safe answer",
  );
  assert.ok(!answers.some((e) => e.delta.includes("secret")));
  void after;
  log({ case: "deadline_then_clean_answer", outcome: "ok" });
});

test("sovereignty: deadline telemetry never includes tool payload text", () => {
  const telemetry = [];
  const parser = new ToolCallParser({
    subjectId: "anika-k",
    deviceId: "edge-deadline",
    onTelemetry: (e) => telemetry.push(e),
  });
  parser.feed('```tool_call\n{"learner":"raw-content"}');
  parser.terminateDeadline();
  const blob = JSON.stringify(telemetry);
  assert.ok(!blob.includes("learner"));
  assert.ok(!blob.includes("raw-content"));
  assert.ok(
    telemetry.some(
      (t) =>
        t.outcome === "rejected" && t.failureClass === "unclosed_at_deadline",
    ),
  );
  log({ case: "deadline_telemetry_scope", outcome: "ok" });
});
