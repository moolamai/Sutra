/**
 * ChatMessage[] → SlmRuntime prompt assembly.
 * Run: pnpm --filter @moolam/edge-agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatPromptAssemblyError,
  EDGE_PROMPT_ASSISTANT_CUE,
  EDGE_PROMPT_OBLIGATION_EMPTY,
  EDGE_PROMPT_OBLIGATION_OVERFLOW,
  EDGE_PROMPT_OBLIGATION_SUBJECT,
  EDGE_PROMPT_ROLE_MARKERS,
  assembleChatMessagesToPrompt,
  estimatePromptTokens,
} from "../dist/index.js";

const SECRET = "SECRET_PROMPT_BODY_MUST_NOT_LEAK";

test("happy path: roles map in order; tool results retained; deterministic", () => {
  const events = [];
  const messages = [
    { role: "system", content: "You are a sovereign tutor." },
    { role: "user", content: "What is hashing?" },
    {
      role: "assistant",
      content: "```tool_call\n{\"toolName\":\"lookup\",\"arguments\":{},\"callId\":\"c1\"}\n```",
    },
    {
      role: "tool",
      toolCallId: "c1",
      content: JSON.stringify({ ok: true, value: "consistent-hash" }),
    },
    { role: "user", content: "Summarize." },
  ];

  const a = assembleChatMessagesToPrompt(messages, {
    contextWindow: 4096,
    subjectId: "subj-a",
    deviceId: "dev-a",
    emit: (e) => events.push(e),
  });
  const b = assembleChatMessagesToPrompt(messages, {
    contextWindow: 4096,
    subjectId: "subj-a",
    deviceId: "dev-a",
  });

  assert.equal(a, b, "identical inputs must yield identical prompts");
  assert.match(a, new RegExp(`^${EDGE_PROMPT_ROLE_MARKERS.system}\\n`));
  assert.ok(a.includes(`${EDGE_PROMPT_ROLE_MARKERS.user}\nWhat is hashing?`));
  assert.ok(a.includes(`${EDGE_PROMPT_ROLE_MARKERS.tool} id=c1\n`));
  assert.ok(a.includes('"value":"consistent-hash"'));
  assert.ok(
    a.endsWith(EDGE_PROMPT_ASSISTANT_CUE) ||
      a.endsWith(EDGE_PROMPT_ASSISTANT_CUE.trimEnd() + "\n"),
  );
  assert.ok(a.indexOf("What is hashing?") < a.indexOf("id=c1"));
  assert.ok(a.indexOf("id=c1") < a.indexOf("Summarize."));

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj-a");
  assert.equal(events[0].deviceId, "dev-a");
  assert.equal(events[0].toolCount, 1);
  assert.equal(events[0].systemCount, 1);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_|hashing|consistent/);
});

test("edge: empty messages → typed error before any Slm call", () => {
  const events = [];
  assert.throws(
    () =>
      assembleChatMessagesToPrompt([], {
        contextWindow: 4096,
        subjectId: "subj-empty",
        emit: (e) => events.push(e),
      }),
    (err) =>
      err instanceof ChatPromptAssemblyError &&
      err.obligationId === EDGE_PROMPT_OBLIGATION_EMPTY,
  );
  assert.equal(events[0]?.outcome, "empty");
});

test("edge: system / total overflow → typed error (no silent truncation)", () => {
  const huge = "x".repeat(500);
  assert.throws(
    () =>
      assembleChatMessagesToPrompt(
        [{ role: "system", content: huge }],
        { contextWindow: 8, subjectId: "subj-ovf" },
      ),
    (err) =>
      err instanceof ChatPromptAssemblyError &&
      err.obligationId === EDGE_PROMPT_OBLIGATION_OVERFLOW &&
      /exceeds contextWindow/i.test(err.message),
  );

  // Non-system content can also overflow the assembled prompt.
  assert.throws(
    () =>
      assembleChatMessagesToPrompt(
        [
          { role: "system", content: "short" },
          { role: "user", content: "y".repeat(200) },
        ],
        { contextWindow: 16, subjectId: "subj-ovf-2" },
      ),
    (err) =>
      err instanceof ChatPromptAssemblyError &&
      err.obligationId === EDGE_PROMPT_OBLIGATION_OVERFLOW,
  );
});

test("edge: empty subjectId rejected (isolation)", () => {
  assert.throws(
    () =>
      assembleChatMessagesToPrompt(
        [{ role: "user", content: "hi" }],
        { contextWindow: 4096, subjectId: "  " },
      ),
    (err) =>
      err instanceof ChatPromptAssemblyError &&
      err.obligationId === EDGE_PROMPT_OBLIGATION_SUBJECT,
  );
});

test("sovereignty: concurrent subjects keep assembly events isolated; no raw content", () => {
  const events = [];
  const msgsA = [{ role: "user", content: SECRET }];
  const msgsB = [{ role: "user", content: "other" }];
  const [pa, pb] = [
    assembleChatMessagesToPrompt(msgsA, {
      contextWindow: 4096,
      subjectId: "subj-a",
      deviceId: "dev-a",
      emit: (e) => events.push(e),
    }),
    assembleChatMessagesToPrompt(msgsB, {
      contextWindow: 4096,
      subjectId: "subj-b",
      deviceId: "dev-b",
      emit: (e) => events.push(e),
    }),
  ];
  assert.notEqual(pa, pb);
  assert.ok(pa.includes(SECRET));
  assert.deepEqual(
    events.map((e) => e.subjectId).sort(),
    ["subj-a", "subj-b"],
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_PROMPT/);
});

test("edge: replay of same messages is idempotent (same prompt)", () => {
  const messages = [
    { role: "system", content: "charter" },
    { role: "user", content: "q" },
    { role: "tool", toolCallId: "t1", content: '{"r":1}' },
  ];
  const opts = { contextWindow: 2048, subjectId: "subj-idem" };
  const first = assembleChatMessagesToPrompt(messages, opts);
  const second = assembleChatMessagesToPrompt(messages, opts);
  assert.equal(first, second);
  assert.equal(estimatePromptTokens(first), estimatePromptTokens(second));
});
