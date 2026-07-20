/**
 * Session rehydration path — durable load → seed budget + dynamic block.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CHARS_PER_TOKEN_ESTIMATE,
  ContextBudgetManager,
  InMemorySessionDurableStore,
  SESSION_ADVISORY_CLEAN_SESSION,
  SESSION_DURABLE_PROTOCOL_VERSION,
  StreamingTurnHost,
  createEmptySessionDurableState,
  rehydrateSessionForTurn,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function profile() {
  return {
    domainId: "mathematics-mentor",
    charter: "Teach patiently.",
    refusals: ["refusal:medical-advice"],
    languages: ["en"],
  };
}

function durableState(overrides = {}) {
  return {
    protocolVersion: SESSION_DURABLE_PROTOCOL_VERSION,
    subjectId: "anika-k",
    sessionId: "sess-days-old",
    deviceId: "edge-aaaa",
    stateVector: 0,
    profile: profile(),
    activePlan: {
      planId: "plan-1",
      rationale: "ratio practice",
      steps: [
        {
          stepId: "s1",
          goalId: "g1",
          action: "keep-ratio-constraint",
          dependsOn: [],
          status: "active",
        },
      ],
    },
    compactionSummary:
      "<<<SUTRA_COMPACTION_SUMMARY>>>\nratio >= 2\n<<<END_SUTRA_COMPACTION_SUMMARY>>>",
    correctionRefs: [
      {
        memoryId: "mem-corr-1",
        kind: "correction",
        text: "prefer fraction bars before abstract ratios",
      },
    ],
    ...overrides,
  };
}

test("happy path: rehydrate seeds summary + corrections; skips history replay", () => {
  const telemetry = [];
  const store = new InMemorySessionDurableStore({
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(store.put(durableState()).ok, true);

  const budget = new ContextBudgetManager({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    modelCard: { modelId: "slm-local", contextWindow: 2000 },
  });

  const result = rehydrateSessionForTurn({
    store,
    subjectId: "anika-k",
    sessionId: "sess-days-old",
    budget,
    options: {
      utterance: "continue from last week",
      onTelemetry: (e) => telemetry.push(e),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "rehydrated");
  assert.equal(result.usedLlm, false);
  assert.equal(result.seed.skippedHistoryReplay, true);
  assert.equal(result.seed.messages.length, 1);
  assert.equal(result.seed.messages[0].role, "system");
  assert.ok(result.seed.messages[0].content.includes("ratio >= 2"));
  assert.equal(result.seed.memories.length, 1);
  assert.equal(result.seed.memories[0].kind, "correction");
  assert.equal(result.seed.retrieval.length, 0);
  assert.equal(result.seed.pendingDynamicBlock, "continue from last week");
  assert.ok(result.seed.protectedTexts.includes("refusal:medical-advice"));
  assert.equal(result.seed.activePlan.planId, "plan-1");
  assert.ok(result.contextBudgetSnapshot);
  assert.ok(result.contextBudgetSnapshot.tokensUsed > 0);

  // No N-turn user/assistant history in the seed.
  assert.equal(
    result.seed.messages.filter((m) => m.role === "user" || m.role === "assistant")
      .length,
    0,
  );

  assert.ok(telemetry.some((t) => t.action === "rehydrate"));
  assert.ok(!JSON.stringify(telemetry).includes("fraction bars"));
  assert.ok(!JSON.stringify(telemetry).includes("Teach patiently"));

  log({
    event: "runtime.harness.session_rehydrate",
    outcome: "ok",
    case: "seed",
    subjectId: "anika-k",
    correctionCount: result.seed.correctionCount,
    tokensUsed: result.contextBudgetSnapshot.tokensUsed,
  });
});

test("edge: missing durable → clean_session advisory, not crash", () => {
  const store = new InMemorySessionDurableStore();
  const result = rehydrateSessionForTurn({
    store,
    subjectId: "anika-k",
    sessionId: "brand-new",
    options: { utterance: "hello" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "clean_session");
  assert.equal(result.advisory, SESSION_ADVISORY_CLEAN_SESSION);
  assert.equal(result.durableStatus, "not_found");
  assert.equal(result.seed.skippedHistoryReplay, true);
  assert.equal(result.seed.messages.length, 0);
  assert.equal(result.seed.pendingDynamicBlock, "hello");
});

test("edge: empty durable record is distinct clean_session path", () => {
  const store = new InMemorySessionDurableStore();
  const empty = createEmptySessionDurableState({
    subjectId: "anika-k",
    sessionId: "empty-sess",
    profile: profile(),
  });
  assert.equal(store.put(empty).ok, true);
  const result = rehydrateSessionForTurn({
    store,
    subjectId: "anika-k",
    sessionId: "empty-sess",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "clean_session");
  assert.equal(result.durableStatus, "empty");
  assert.equal(result.seed.profile.domainId, "mathematics-mentor");
});

test("edge: sync in flight → typed reject", () => {
  const store = new InMemorySessionDurableStore();
  assert.equal(store.put(durableState()).ok, true);
  const result = rehydrateSessionForTurn({
    store,
    subjectId: "anika-k",
    sessionId: "sess-days-old",
    options: { syncInFlight: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "sync_in_flight");
});

test("sovereignty: budget subject mismatch rejected", () => {
  const store = new InMemorySessionDurableStore();
  assert.equal(store.put(durableState()).ok, true);
  const budget = new ContextBudgetManager({
    subjectId: "other-learner",
    modelCard: { modelId: "slm-local", contextWindow: 1000 },
  });
  const result = rehydrateSessionForTurn({
    store,
    subjectId: "anika-k",
    sessionId: "sess-days-old",
    budget,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "cross_subject");
});

test("turn host: rehydrateSession wires store + context budget", () => {
  const telemetry = [];
  const store = new InMemorySessionDurableStore();
  assert.equal(store.put(durableState()).ok, true);
  const contextBudget = new ContextBudgetManager({
    subjectId: "anika-k",
    modelCard: { modelId: "slm-local", contextWindow: 2000 },
  });
  const host = new StreamingTurnHost({
    subjectId: "anika-k",
    correlationId: "corr-rehydrate",
    deviceId: "edge-aaaa",
    sessionId: "sess-days-old",
    sessionStore: store,
    contextBudget,
    onTelemetry: (e) => telemetry.push(e),
  });

  const result = host.rehydrateSession({
    utterance: "pick up where we left",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "rehydrated");
  assert.equal(host.lastRehydrationResult?.seed.correctionCount, 1);
  assert.ok(
    telemetry.some(
      (t) =>
        t.event === "runtime.harness.session_rehydrate" &&
        t.skippedHistoryReplay === true,
    ),
  );
  // Pad does not pull historical message volume into the budget seed.
  assert.ok(
    result.contextBudgetSnapshot.tokensUsed <
      500 * CONTEXT_CHARS_PER_TOKEN_ESTIMATE,
  );
});

test("idempotent: rehydrate twice yields same seed shape", () => {
  const store = new InMemorySessionDurableStore();
  assert.equal(store.put(durableState()).ok, true);
  const a = rehydrateSessionForTurn({
    store,
    subjectId: "anika-k",
    sessionId: "sess-days-old",
    options: { utterance: "u" },
  });
  const b = rehydrateSessionForTurn({
    store,
    subjectId: "anika-k",
    sessionId: "sess-days-old",
    options: { utterance: "u" },
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.seed.summaryHash, b.seed.summaryHash);
  assert.deepEqual(a.seed.messages, b.seed.messages);
  assert.equal(a.seed.correctionCount, b.seed.correctionCount);
});
