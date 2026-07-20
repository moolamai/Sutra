/**
 * ContextBudgetManager — model card window + shouldCompact().
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_ADVISORY_MISSING_WINDOW,
  CONTEXT_CHARS_PER_TOKEN_ESTIMATE,
  CONTEXT_COMPACTION_THRESHOLD_DEFAULT,
  CONTEXT_MESSAGE_LIMIT,
  CONTEXT_WINDOW_CONSERVATIVE_DEFAULT,
  ContextBudgetManager,
  estimateContextTextTokens,
  loadContextWindowFromModelCard,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: loads model card window; estimates messages + retrieval; shouldCompact at 75%", () => {
  const telemetry = [];
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    modelCard: {
      modelId: "slm-local",
      contextWindow: 1000,
      locality: "on-device",
      modalities: ["text"],
    },
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(mgr.contextWindow, 1000);
  assert.equal(mgr.compactionThreshold, CONTEXT_COMPACTION_THRESHOLD_DEFAULT);
  assert.equal(mgr.usedConservativeDefault, false);

  // 760 message tokens → 76% of 1000; pending/protected add further.
  const msgText = "x".repeat(760 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
  const measured = mgr.measure({
    messages: [{ role: "system", content: msgText }],
    retrieval: [{ text: "passage-a", score: 0.9 }],
    pendingDynamicBlock: "user asks about ratios",
    protectedTexts: ["refusal:medical-advice", "plan:keep-citations"],
  });
  assert.equal(measured.ok, true);
  assert.ok(measured.snapshot.pendingDynamicTokens > 0);
  assert.ok(measured.snapshot.protectedTokens > 0);
  assert.equal(
    measured.snapshot.tokensUsed,
    measured.snapshot.messageTokens +
      measured.snapshot.retrievalTokens +
      measured.snapshot.memoryTokens +
      measured.snapshot.pendingDynamicTokens +
      measured.snapshot.protectedTokens,
  );
  assert.equal(
    measured.snapshot.headroom,
    Math.max(0, 1000 - measured.snapshot.tokensUsed),
  );
  assert.ok(measured.snapshot.utilization >= CONTEXT_COMPACTION_THRESHOLD_DEFAULT);
  assert.equal(measured.snapshot.shouldCompact, true);
  assert.equal(mgr.shouldCompact(), true);

  assert.ok(telemetry.some((t) => t.action === "load_model_card"));
  assert.ok(telemetry.some((t) => t.action === "measure" && t.shouldCompact === true));
  assert.ok(!JSON.stringify(telemetry).includes("user asks about ratios"));
  assert.ok(!JSON.stringify(telemetry).includes("refusal:medical-advice"));

  log({
    event: "runtime.harness.context_budget",
    outcome: "ok",
    case: "should_compact",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    tokensUsed: measured.snapshot.tokensUsed,
    headroom: measured.snapshot.headroom,
  });
});

test("edge: missing contextWindow → conservative default with advisory", () => {
  const telemetry = [];
  const loaded = loadContextWindowFromModelCard({
    modelId: "unknown-slm",
  });
  assert.equal(loaded.contextWindow, CONTEXT_WINDOW_CONSERVATIVE_DEFAULT);
  assert.equal(loaded.usedConservativeDefault, true);
  assert.equal(loaded.advisory, CONTEXT_ADVISORY_MISSING_WINDOW);

  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "unknown-slm", contextWindow: 0 },
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(mgr.contextWindow, CONTEXT_WINDOW_CONSERVATIVE_DEFAULT);
  assert.equal(mgr.advisory, CONTEXT_ADVISORY_MISSING_WINDOW);
  assert.ok(
    telemetry.some(
      (t) =>
        t.action === "load_model_card" &&
        t.advisory === CONTEXT_ADVISORY_MISSING_WINDOW,
    ),
  );
});

test("edge: zero headroom before generate → shouldCompact even below 75% util of a tiny pack", () => {
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "tiny", contextWindow: 40 },
  });
  // Fill past the window — headroom 0 forces compaction (not silent drop).
  const big = "y".repeat(200);
  const measured = mgr.measure({
    messages: [{ role: "user", content: big }],
    pendingDynamicBlock: "more",
  });
  assert.equal(measured.ok, true);
  assert.equal(measured.snapshot.headroom, 0);
  assert.equal(measured.snapshot.shouldCompact, true);
  assert.ok(measured.snapshot.utilization > CONTEXT_COMPACTION_THRESHOLD_DEFAULT);
});

test("edge: headroom includes pending dynamic block; below threshold stays false", () => {
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "slm-local", contextWindow: 1000 },
  });
  const withoutDynamic = mgr.measure({
    messages: [
      {
        role: "user",
        content: "x".repeat(740 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE),
      },
    ],
  });
  assert.equal(withoutDynamic.ok, true);
  // 740/1000 = 0.74 — below 75% without dynamic.
  assert.equal(withoutDynamic.snapshot.shouldCompact, false);

  const withDynamic = mgr.measure({
    messages: [
      {
        role: "user",
        content: "x".repeat(740 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE),
      },
    ],
    pendingDynamicBlock: "z".repeat(20 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE),
  });
  assert.equal(withDynamic.ok, true);
  assert.ok(
    withDynamic.snapshot.tokensUsed > withoutDynamic.snapshot.tokensUsed,
  );
  assert.equal(withDynamic.snapshot.pendingDynamicTokens, 20);
  assert.equal(withDynamic.snapshot.shouldCompact, true);
});

test("edge: optional card tokenizer is used consistently", () => {
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: {
      modelId: "tok-model",
      contextWindow: 8192,
      estimateTokens: (text) => text.split(/\s+/).filter(Boolean).length,
    },
  });
  assert.equal(mgr.estimateText("one two three"), 3);
  assert.equal(estimateContextTextTokens("abcd"), 1); // heuristic only
  const m = mgr.measure({
    messages: [{ role: "user", content: "alpha beta" }],
    retrieval: [{ text: "gamma delta epsilon" }],
  });
  assert.equal(m.ok, true);
  assert.equal(m.snapshot.messageTokens, 2);
  assert.equal(m.snapshot.retrievalTokens, 3);
});

test("sovereignty: empty subjectId rejected at construction; telemetry has no content", () => {
  assert.throws(
    () =>
      new ContextBudgetManager({
        subjectId: "  ",
        modelCard: { modelId: "m", contextWindow: 100 },
      }),
    /subjectId/,
  );
  const telemetry = [];
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "m", contextWindow: 100 },
    onTelemetry: (e) => telemetry.push(e),
  });
  mgr.measure({
    messages: [{ role: "user", content: "secret learner utterance" }],
  });
  assert.ok(!JSON.stringify(telemetry).includes("secret learner utterance"));
});

test("scalability: message list is hard-capped", () => {
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "m", contextWindow: 8192 },
  });
  const messages = Array.from({ length: CONTEXT_MESSAGE_LIMIT + 1 }, () => ({
    role: "user",
    content: "x",
  }));
  const over = mgr.measure({ messages });
  assert.equal(over.ok, false);
  assert.equal(over.failureClass, "message_limit");
});
