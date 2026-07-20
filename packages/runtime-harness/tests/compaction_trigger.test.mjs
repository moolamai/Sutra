/**
 * Compaction trigger wire — shouldCompact → replace + re-estimate.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPACTION_SUMMARY_MARKERS,
  CONTEXT_CHARS_PER_TOKEN_ESTIMATE,
  ContextBudgetManager,
  applyCompactionTrigger,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function makeMgr(telemetry, window = 400) {
  return new ContextBudgetManager({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    modelCard: {
      modelId: "slm-local",
      contextWindow: window,
      locality: "on-device",
      modalities: ["text"],
    },
    onTelemetry: (e) => telemetry.push(e),
  });
}

test("happy path: shouldCompact → replace eligible context, emit hash, headroom rises", () => {
  const telemetry = [];
  const mgr = makeMgr(telemetry, 400);
  // Fill ~80% with ephemeral history + memories + retrieval.
  const hist = "h".repeat(200 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
  const result = applyCompactionTrigger({
    budget: mgr,
    state: {
      subjectId: "anika-k",
      deviceId: "edge-aaaa",
      openConstraints: ["ratio >= 2"],
      verifiedFacts: ["water boils at 100C"],
      citationRefs: ["pack-a#§3"],
      episodicDetail: ["yesterday tutoring note"],
    },
    context: {
      messages: [
        { role: "system", content: "charter:keep-citations" },
        { role: "user", content: hist },
        { role: "assistant", content: hist },
      ],
      memories: [
        { kind: "constraint", text: "refusal:medical-advice" },
        { kind: "episodic", text: "noisy episodic blob ".repeat(20) },
      ],
      retrieval: [{ text: "long passage ".repeat(40), score: 0.2, id: "p1" }],
      pendingDynamicBlock: "user asks about ratios",
      protectedTexts: ["plan:keep-citations"],
    },
    options: { onTelemetry: (e) => telemetry.push(e) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.usedLlm, false);
  assert.ok(result.summary.includes("ratio >= 2"));
  assert.ok(result.summary.includes("pack-a#§3"));
  assert.match(result.summaryHash, /^[0-9a-f]{64}$/);
  assert.ok(result.headroomAfter >= result.headroomBefore);
  assert.ok(result.tokensAfter <= result.tokensBefore);
  assert.ok(
    result.context.messages.some(
      (m) =>
        m.role === "system" &&
        m.content.startsWith(COMPACTION_SUMMARY_MARKERS.open),
    ),
  );
  assert.ok(
    result.context.messages.some(
      (m) => m.role === "system" && m.content === "charter:keep-citations",
    ),
  );
  assert.equal(
    result.context.messages.filter((m) => m.role === "user").length,
    0,
  );
  assert.ok(
    result.context.memories.some((m) => m.text === "refusal:medical-advice"),
  );
  assert.equal(result.context.retrieval.length, 0);
  assert.ok(result.memoriesDropped >= 1);
  assert.ok(result.retrievalDropped >= 1);

  assert.ok(
    telemetry.some(
      (t) =>
        t.event === "runtime.harness.compaction" &&
        t.action === "replace" &&
        t.summaryHash &&
        t.tokensBefore !== undefined &&
        t.tokensAfter !== undefined,
    ),
  );
  assert.ok(
    telemetry.some(
      (t) =>
        t.event === "runtime.harness.compaction" && t.action === "re_estimate",
    ),
  );
  assert.ok(!JSON.stringify(telemetry).includes("ratio >= 2"));
  assert.ok(!JSON.stringify(telemetry).includes("yesterday tutoring"));

  log({
    event: "runtime.harness.compaction",
    outcome: "ok",
    case: "trigger",
    subjectId: "anika-k",
    summaryHash: result.summaryHash.slice(0, 12),
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    headroomBefore: result.headroomBefore,
    headroomAfter: result.headroomAfter,
  });
});

test("edge: below threshold → skip without replacing context", () => {
  const telemetry = [];
  const mgr = makeMgr(telemetry, 4000);
  const result = applyCompactionTrigger({
    budget: mgr,
    state: {
      subjectId: "anika-k",
      openConstraints: ["c1"],
    },
    context: {
      messages: [{ role: "user", content: "tiny" }],
    },
    options: { onTelemetry: (e) => telemetry.push(e) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, false);
  assert.equal(result.summary, undefined);
  assert.equal(result.context.messages[0].content, "tiny");
  assert.ok(telemetry.some((t) => t.action === "skipped" && t.compacted === false));
});

test("edge: tool loop active → deferred, context untouched", () => {
  const telemetry = [];
  const mgr = makeMgr(telemetry, 200);
  const hist = "x".repeat(180 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
  const result = applyCompactionTrigger({
    budget: mgr,
    state: { subjectId: "anika-k", openConstraints: ["c1"] },
    context: {
      messages: [{ role: "user", content: hist }],
    },
    options: {
      toolLoopActive: true,
      onTelemetry: (e) => telemetry.push(e),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(result.failureClass, "deferred_tool_loop");
  assert.ok(telemetry.some((t) => t.outcome === "deferred"));
});

test("edge: empty durable state still compresses with stub when over threshold", () => {
  const mgr = makeMgr([], 200);
  const hist = "y".repeat(180 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
  const result = applyCompactionTrigger({
    budget: mgr,
    state: { subjectId: "anika-k" },
    context: {
      messages: [
        { role: "user", content: hist },
        { role: "assistant", content: hist },
      ],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.emptyStub, true);
  assert.ok(result.summary.includes(COMPACTION_SUMMARY_MARKERS.none));
});

test("sovereignty: cross-subject budget vs state rejected", () => {
  const telemetry = [];
  const mgr = new ContextBudgetManager({
    subjectId: "other-learner",
    modelCard: { modelId: "slm-local", contextWindow: 400 },
  });
  const result = applyCompactionTrigger({
    budget: mgr,
    state: { subjectId: "anika-k", openConstraints: ["secret"] },
    context: { messages: [{ role: "user", content: "x".repeat(400) }] },
    options: { onTelemetry: (e) => telemetry.push(e) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "cross_subject");
  assert.ok(!JSON.stringify(telemetry).includes("secret"));
});

test("idempotent: same idempotencyKey + already-applied summary marks replay", () => {
  const mgr = makeMgr([], 300);
  const hist = "z".repeat(220 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
  const state = {
    subjectId: "anika-k",
    openConstraints: ["ratio >= 2"],
    verifiedFacts: ["f1"],
    citationRefs: ["c1"],
  };
  const context = {
    messages: [
      { role: "system", content: "charter" },
      { role: "user", content: hist },
    ],
    memories: [{ kind: "episodic", text: "drop-me" }],
    retrieval: [{ text: "passage", score: 0.1 }],
  };
  const first = applyCompactionTrigger({
    budget: mgr,
    state,
    context,
    options: { idempotencyKey: "turn-1" },
  });
  assert.equal(first.ok, true);
  assert.equal(first.compacted, true);

  const second = applyCompactionTrigger({
    budget: mgr,
    state,
    context: first.context,
    options: { idempotencyKey: "turn-1" },
  });
  // After first replace, util may drop below threshold → skip; if still
  // compacting, must be idempotent with same hash.
  if (second.compacted) {
    assert.equal(second.summaryHash, first.summaryHash);
    assert.equal(second.idempotentReplay, true);
  } else {
    assert.equal(second.ok, true);
    assert.equal(second.compacted, false);
  }
});

test("invariant: constrained texts survive replace verbatim", () => {
  const mgr = makeMgr([], 300);
  const hist = "q".repeat(240 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
  const result = applyCompactionTrigger({
    budget: mgr,
    state: {
      subjectId: "anika-k",
      openConstraints: ["  ratio>=2  "],
      verifiedFacts: ["fact-verbatim"],
      citationRefs: ["cite#1"],
    },
    context: {
      messages: [{ role: "user", content: hist }],
      memories: [{ kind: "refusal", text: "refusal:scope" }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.ok(result.summary.includes("-   ratio>=2  "));
  assert.ok(result.summary.includes("fact-verbatim"));
  assert.ok(result.summary.includes("cite#1"));
  assert.ok(
    result.context.memories.some((m) => m.text === "refusal:scope"),
  );
});
