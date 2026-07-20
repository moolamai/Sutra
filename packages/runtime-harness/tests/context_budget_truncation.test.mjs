/**
 * Recall / knowledge truncation — drop lowest scores; never drop refusals.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CHARS_PER_TOKEN_ESTIMATE,
  ContextBudgetManager,
  truncateScoredCandidates,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function padTokens(n, ch = "x") {
  return ch.repeat(n * CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
}

test("happy path: truncates lowest-score memories and passages first", () => {
  const telemetry = [];
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    modelCard: { modelId: "slm-local", contextWindow: 1000 },
    onTelemetry: (e) => telemetry.push(e),
  });

  // Reserved ≈ 100 (messages) + 10 (pending) = 110; threshold budget 750 →
  // truncateable ≈ 640. Provide ~800 of recall/knowledge so some drop.
  const result = mgr.truncateRecallAndKnowledge({
    messages: [{ role: "system", content: padTokens(100) }],
    pendingDynamicBlock: padTokens(10),
    refusals: ["medical-advice", "legal-advice"],
    activeConstraints: ["keep-citations", "max-steps:3"],
    memories: [
      { id: "m-low", text: padTokens(200), score: 0.1 },
      { id: "m-high", text: padTokens(200), score: 0.9 },
    ],
    retrieval: [
      { id: "p-mid", text: padTokens(200), score: 0.5 },
      { id: "p-low", text: padTokens(200), score: 0.05 },
    ],
  });

  assert.equal(result.ok, true);
  assert.ok(result.tokensAfter <= result.tokensBefore);
  assert.ok(result.memoriesDropped + result.retrievalDropped >= 1);
  // Lowest scores dropped first.
  assert.ok(!result.retrievalKept.some((p) => p.id === "p-low"));
  assert.ok(result.memoriesKept.some((m) => m.id === "m-high"));
  // Refusals / constraints preserved (counted as protected).
  assert.equal(result.protectedPreserved, true);
  assert.ok(result.snapshot.protectedTokens > 0);
  assert.match(result.selectionHash, /^[0-9a-f]{64}$/);

  const truncEvents = telemetry.filter((t) => t.action === "truncate");
  assert.equal(truncEvents.length, 1);
  assert.equal(truncEvents[0].tokensBefore, result.tokensBefore);
  assert.equal(truncEvents[0].tokensAfter, result.tokensAfter);
  assert.equal(truncEvents[0].selectionHash, result.selectionHash);
  assert.ok(!JSON.stringify(telemetry).includes("medical-advice"));

  log({
    event: "runtime.harness.context_budget",
    outcome: "ok",
    case: "truncate_low_score",
    subjectId: "anika-k",
    memoriesDropped: result.memoriesDropped,
    retrievalDropped: result.retrievalDropped,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  });
});

test("edge: retrieval over budget drops lowest scores; kept set is deterministic", () => {
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "slm-local", contextWindow: 400 },
  });
  const input = {
    messages: [{ role: "user", content: padTokens(20) }],
    pendingDynamicBlock: padTokens(5),
    refusals: ["scope-boundary"],
    // 3×80 = 240 truncateable tokens; hard-cap budget at 100 so ≥1 drops.
    truncateableBudgetTokens: 100,
    retrieval: [
      { id: "a", text: padTokens(80), score: 0.2 },
      { id: "b", text: padTokens(80), score: 0.8 },
      { id: "c", text: padTokens(80), score: 0.4 },
    ],
    memories: [],
  };
  const once = mgr.truncateRecallAndKnowledge(input);
  const twice = mgr.truncateRecallAndKnowledge(input);
  assert.equal(once.ok, true);
  assert.equal(twice.ok, true);
  assert.equal(once.selectionHash, twice.selectionHash);
  assert.deepEqual(
    once.retrievalKept.map((p) => p.id),
    twice.retrievalKept.map((p) => p.id),
  );
  // Highest relevance retained preferentially.
  assert.ok(once.retrievalKept.some((p) => p.id === "b"));
  assert.ok(once.retrievalDropped >= 1);
  assert.ok(!once.retrievalKept.some((p) => p.id === "a"));
});

test("invariant: refusals and active constraints never truncated", () => {
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "tiny", contextWindow: 200 },
  });
  // Force truncateable budget to 0 — all recall/knowledge must go;
  // protected still in reserved/snapshot.
  const result = mgr.truncateRecallAndKnowledge({
    messages: [{ role: "system", content: padTokens(40) }],
    pendingDynamicBlock: padTokens(10),
    refusals: ["medical-advice"],
    activeConstraints: ["numeric:keep-ratio>=2"],
    truncateableBudgetTokens: 0,
    memories: [{ id: "m1", text: padTokens(50), score: 1 }],
    retrieval: [{ id: "p1", text: padTokens(50), score: 1 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.memoriesKept.length, 0);
  assert.equal(result.retrievalKept.length, 0);
  assert.equal(result.memoriesDropped, 1);
  assert.equal(result.retrievalDropped, 1);
  assert.ok(result.snapshot.protectedTokens > 0);
  // Protected still contribute to tokensAfter via reserved.
  assert.ok(result.tokensAfter >= result.reservedTokens);
  assert.equal(result.tokensAfter, result.reservedTokens);
});

test("edge: zero headroom after reserved still signals shouldCompact (no silent drop of protected)", () => {
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "tiny", contextWindow: 80 },
  });
  const result = mgr.truncateRecallAndKnowledge({
    messages: [{ role: "system", content: padTokens(50) }],
    pendingDynamicBlock: padTokens(20),
    refusals: [padTokens(20, "r")],
    activeConstraints: [padTokens(20, "c")],
    truncateableBudgetTokens: 0,
    retrieval: [{ id: "p", text: padTokens(40), score: 0.9 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.retrievalKept.length, 0);
  assert.equal(result.snapshot.headroom, 0);
  assert.equal(result.snapshot.shouldCompact, true);
});

test("unit: truncateScoredCandidates drops ascending score order", () => {
  const kept = truncateScoredCandidates(
    [
      { kind: "retrieval", index: 0, score: 0.1, tokens: 10, id: "low" },
      { kind: "retrieval", index: 1, score: 0.9, tokens: 10, id: "high" },
      { kind: "memory", index: 0, score: 0.5, tokens: 10, id: "mid" },
    ],
    20,
  );
  assert.equal(kept.keptTokens, 20);
  const ids = kept.kept.map((c) => c.id).sort();
  assert.deepEqual(ids, ["high", "mid"]);
});

test("sovereignty: truncate telemetry never includes passage or refusal text", () => {
  const telemetry = [];
  const mgr = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "slm-local", contextWindow: 500 },
    onTelemetry: (e) => telemetry.push(e),
  });
  const secret = "learner private episode about grades";
  mgr.truncateRecallAndKnowledge({
    refusals: ["never-share-grades"],
    memories: [{ id: "m", text: secret, score: 0.2 }],
    retrieval: [{ id: "p", text: "public formula a/b", score: 0.9 }],
    pendingDynamicBlock: "Explain ratios.",
  });
  const wire = JSON.stringify(telemetry);
  assert.ok(!wire.includes(secret));
  assert.ok(!wire.includes("never-share-grades"));
  assert.ok(!wire.includes("Explain ratios."));
});
