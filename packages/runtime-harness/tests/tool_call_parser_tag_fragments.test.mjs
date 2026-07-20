/**
 * Tag-fragment reassembly: fuzz splits at every declared-tag character offset.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PARSER_DECLARED_TAGS,
  ToolCallParser,
  isTagFragmentPrefix,
  parseChunks,
  tagFragmentHoldStart,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function summarize(events) {
  return events
    .filter((e) => e.type !== "mode_change")
    .map((e) => {
      if (
        e.type === "thought_delta" ||
        e.type === "answer_delta" ||
        e.type === "tool_buffer_delta"
      ) {
        return { type: e.type, delta: e.delta };
      }
      if (e.type === "tool_buffer") return { type: e.type, body: e.body };
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

const OPTS = { subjectId: "anika-k", deviceId: "edge-frag" };

function assertChunkInvariant(stream, label) {
  const baseline = summarize(parseChunks([stream], OPTS));
  for (let offset = 0; offset <= stream.length; offset++) {
    const chunks = [stream.slice(0, offset), stream.slice(offset)];
    const got = summarize(parseChunks(chunks, OPTS));
    assert.deepEqual(
      got,
      baseline,
      `${label}: split at offset ${offset} diverged`,
    );
  }
  // Empty chunk injected at every offset (still no-op for emptiness).
  for (let offset = 0; offset <= stream.length; offset++) {
    const chunks = [
      stream.slice(0, offset),
      "",
      stream.slice(offset),
    ];
    const got = summarize(parseChunks(chunks, OPTS));
    assert.deepEqual(
      got,
      baseline,
      `${label}: empty insert at ${offset} diverged`,
    );
  }
  return baseline;
}

test("happy path: every declared-tag prefix is held until complete", () => {
  for (const [name, tag] of Object.entries(PARSER_DECLARED_TAGS)) {
    for (let i = 1; i < tag.length; i++) {
      const partial = tag.slice(0, i);
      assert.equal(
        isTagFragmentPrefix(partial),
        true,
        `${name} prefix ${JSON.stringify(partial)} must hold`,
      );
      assert.equal(tagFragmentHoldStart(partial), 0);
    }
    assert.equal(
      isTagFragmentPrefix(tag),
      true,
      `${name} full tag is a prefix of itself`,
    );
  }
  assert.equal(isTagFragmentPrefix("hello"), false);
  assert.equal(tagFragmentHoldStart("hello<thou"), "hello".length);
  log({ case: "prefix_hold_table", outcome: "ok" });
});

test("fuzz: split at every char of openThought / closeThought stream", () => {
  const stream = `${PARSER_DECLARED_TAGS.openThought}ab${PARSER_DECLARED_TAGS.closeThought}out`;
  const baseline = assertChunkInvariant(stream, "thought-tags");
  assert.deepEqual(baseline, [
    { type: "thought_delta", delta: "ab" },
    { type: "answer_delta", delta: "out" },
  ]);
  log({ case: "fuzz_thought_offsets", outcome: "ok", len: stream.length });
});

test("fuzz: split at every char of tool open/close fence stream", () => {
  const stream = `${PARSER_DECLARED_TAGS.openToolFence}{"x":1}${PARSER_DECLARED_TAGS.closeToolFence}OK`;
  const baseline = assertChunkInvariant(stream, "tool-fence");
  assert.deepEqual(baseline, [
    { type: "tool_buffer_delta", delta: '{"x":1}' },
    { type: "tool_buffer", body: '{"x":1}' },
    { type: "answer_delta", delta: "OK" },
  ]);
  log({ case: "fuzz_tool_offsets", outcome: "ok", len: stream.length });
});

test("fuzz: split at every offset of combined thought+tool+answer golden-shaped stream", () => {
  const stream =
    "<thought>consider</thought>```tool_call\n{\"toolName\":\"lookup\",\"arguments\":{\"query\":\"ratio\"},\"callId\":\"c1\"}\n```A ratio.";
  const baseline = assertChunkInvariant(stream, "combo");
  assert.equal(baseline[0].type, "thought_delta");
  assert.equal(baseline.some((e) => e.type === "tool_buffer"), true);
  assert.equal(baseline.at(-1).type, "answer_delta");
  log({ case: "fuzz_combo_offsets", outcome: "ok", len: stream.length });
});

test("fuzz: every offset of case-variant tool fence reassembles", () => {
  const stream = "```TOOL_CALL\n{}\n```done";
  assertChunkInvariant(stream, "tool-case");
  log({ case: "fuzz_tool_case", outcome: "ok" });
});

test("edge: char-by-char openThought then body reassembly", () => {
  const telemetry = [];
  const parser = new ToolCallParser({
    ...OPTS,
    onTelemetry: (e) => telemetry.push(e),
  });
  const open = PARSER_DECLARED_TAGS.openThought;
  for (let i = 0; i < open.length; i++) {
    const events = parser.feed(open[i]);
    if (i < open.length - 1) {
      assert.deepEqual(events, []);
      assert.ok(parser.heldFragmentBytes >= 1);
    } else {
      assert.ok(events.some((e) => e.type === "mode_change" && e.to === "thought"));
    }
    assert.ok(
      telemetry.at(-1)?.heldFragmentBytes >= 0,
      "telemetry records hold metadata",
    );
  }
  assert.equal(parser.currentMode, "thought");
  assert.deepEqual(parser.feed("z"), []);
  const close = PARSER_DECLARED_TAGS.closeThought;
  for (let i = 0; i < close.length - 1; i++) {
    assert.deepEqual(parser.feed(close[i]), []);
  }
  const fin = parser.feed(close[close.length - 1]);
  assert.ok(fin.some((e) => e.type === "thought_delta" && e.delta === "z"));
  assert.ok(!JSON.stringify(telemetry).includes('"delta":"z"'));
  log({ case: "char_by_char_thought", outcome: "ok" });
});

test("edge: nested/malformed fence across every split → violation, never answer payload", () => {
  const stream =
    "```tool_call\n{\"a\":1}\n```tool_call\n{\"b\":2}\n```";
  for (let offset = 0; offset <= stream.length; offset++) {
    const events = parseChunks(
      [stream.slice(0, offset), stream.slice(offset)],
      OPTS,
    );
    assert.ok(
      events.some((e) => e.type === "violation"),
      `expected violation at split ${offset}`,
    );
    assert.ok(
      !events.some(
        (e) => e.type === "answer_delta" && /tool_call|"a"|"b"/.test(e.delta),
      ),
      `violation must not leak fence prose as answer at ${offset}`,
    );
  }
  log({ case: "nested_every_split", outcome: "rejected" });
});

test("edge: deadline discards held open tool fragment", () => {
  const parser = new ToolCallParser(OPTS);
  parser.feed("```tool_");
  assert.ok(parser.heldFragmentBytes > 0);
  assert.equal(parser.hasOpenFence, true);
  const events = parser.terminateDeadline();
  assert.ok(
    events.some(
      (e) => e.type === "violation" && e.failureClass === "unclosed_at_deadline",
    ),
  );
  assert.equal(parser.pendingBytes, 0);
  log({ case: "deadline_after_partial", outcome: "rejected" });
});

test("sovereignty: fragment fuzz keeps subjectId on telemetry only", () => {
  const telemetry = [];
  parseChunks(["<thou", "ght>x</thought>"], {
    subjectId: "anika-k",
    deviceId: "edge-frag",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.ok(telemetry.length > 0);
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(telemetry.every((t) => t.deviceId === "edge-frag"));
  log({ case: "telemetry_subject_scope", outcome: "ok" });
});
