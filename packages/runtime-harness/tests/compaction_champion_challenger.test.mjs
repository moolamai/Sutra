/**
 * Champion/challenger compaction interface swap.
 *
 * Run (after harness emit):
 *   node --test packages/runtime-harness/tests/compaction_champion_challenger.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ContextBudgetManager } from "../dist/context_budget.js";
import {
  COMPACTION_SUMMARY_MARKERS,
  applyCompactionTrigger,
} from "../dist/compaction.js";
import {
  createCompactionInterfaceSwap,
} from "../dist/compaction/champion_challenger.js";

function makeBudget(subjectId = "anika-k", window = 100) {
  return new ContextBudgetManager({
    subjectId,
    deviceId: "edge-aaaa",
    modelCard: {
      modelId: "slm-compaction-swap",
      contextWindow: window,
      locality: "on-device",
      modalities: ["text"],
    },
  });
}

function hotContext(chars) {
  return {
    messages: [{ role: "user", content: "x".repeat(chars) }],
  };
}

test("golden: flag-off result bytes and B5 telemetry match direct baseline", async () => {
  const secret = "PRIVATE_SESSION_TEXT_MUST_NOT_ENTER_TELEMETRY";
  const scenarios = [
    {
      id: "below-74",
      budgetSubject: "anika-k",
      state: { subjectId: "anika-k" },
      context: hotContext(292),
    },
    {
      id: "at-75",
      budgetSubject: "anika-k",
      state: {
        subjectId: "anika-k",
        deviceId: "edge-aaaa",
        openConstraints: ["Keep citations.", secret],
        citationRefs: ["source:ratio"],
      },
      context: hotContext(300),
    },
    {
      id: "empty-durable-state",
      budgetSubject: "anika-k",
      state: { subjectId: "anika-k", deviceId: "edge-aaaa" },
      context: hotContext(300),
    },
    {
      id: "protected-context",
      budgetSubject: "anika-k",
      state: {
        subjectId: "anika-k",
        openConstraints: ["ratio >= 2"],
        verifiedFacts: ["water boils at 100C"],
        citationRefs: ["pack-a#3"],
      },
      context: {
        messages: [
          { role: "system", content: "charter" },
          { role: "user", content: "x".repeat(300) },
        ],
        memories: [
          { kind: "constraint", text: "refusal:medical-advice" },
          { kind: "episodic", text: "temporary detail" },
        ],
        retrieval: [{ id: "r1", text: "retrieved passage", score: 0.2 }],
        protectedTexts: ["approval required"],
      },
    },
    {
      id: "cross-subject-rejection",
      budgetSubject: "anika-k",
      state: { subjectId: "other-subject", openConstraints: [secret] },
      context: hotContext(300),
    },
  ];

  for (const scenario of scenarios) {
    const baselineTelemetry = [];
    const flagOffTelemetry = [];
    const swapTelemetry = [];
    let challengerCalls = 0;
    const baselineInput = {
      budget: makeBudget(scenario.budgetSubject),
      state: scenario.state,
      context: scenario.context,
      options: { onTelemetry: (event) => baselineTelemetry.push(event) },
    };
    const flagOffInput = {
      budget: makeBudget(scenario.budgetSubject),
      state: scenario.state,
      context: scenario.context,
      options: { onTelemetry: (event) => flagOffTelemetry.push(event) },
    };
    const swap = createCompactionInterfaceSwap({
      learnedEnabled: false,
      summarize: async () => {
        challengerCalls += 1;
        return "must-not-run";
      },
      onTelemetry: (event) => swapTelemetry.push(event),
    });

    const baseline = applyCompactionTrigger(baselineInput);
    const flagOff = await swap.compact(flagOffInput);

    assert.equal(
      JSON.stringify(flagOff),
      JSON.stringify(baseline),
      `${scenario.id}: compaction result bytes`,
    );
    assert.equal(
      JSON.stringify(flagOffTelemetry),
      JSON.stringify(baselineTelemetry),
      `${scenario.id}: B5 telemetry bytes`,
    );
    assert.equal(challengerCalls, 0, `${scenario.id}: no silent hybrid`);
    assert.ok(
      swapTelemetry.every(
        (event) =>
          event.event === "runtime.harness.compaction_swap" &&
          event.mode === "champion" &&
          event.path === "champion",
      ),
      `${scenario.id}: swap telemetry identifies champion`,
    );
    assert.ok(
      !JSON.stringify([...baselineTelemetry, ...swapTelemetry]).includes(secret),
      `${scenario.id}: telemetry contains no session content`,
    );
  }
});

test("flag-on challenger serves learned summary; timeout falls back to champion", async () => {
  const events = [];
  const swap = createCompactionInterfaceSwap({
    learnedEnabled: true,
    summarize: async () => "learned challenger summary",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(swap.mode, "challenger");

  const below = await swap.compact({
    budget: makeBudget(),
    state: { subjectId: "anika-k" },
    context: hotContext(292),
  });
  assert.equal(below.ok, true);
  if (below.ok) {
    assert.equal(below.compacted, false);
    assert.equal(below.path, "champion");
  }

  const served = await swap.compact({
    budget: makeBudget(),
    state: {
      subjectId: "anika-k",
      openConstraints: ["ratio >= 2"],
    },
    context: hotContext(300),
  });
  assert.equal(served.ok, true);
  if (served.ok) {
    assert.equal(served.compacted, true);
    assert.equal(served.path, "challenger");
    assert.equal(served.summary, "learned challenger summary");
  }

  const timeoutSwap = createCompactionInterfaceSwap({
    mode: "challenger",
    timeoutMs: 5,
    summarize: async () => await new Promise(() => {}),
    onTelemetry: (e) => events.push(e),
  });
  const fallback = await timeoutSwap.compact({
    budget: makeBudget(),
    state: {
      subjectId: "anika-k",
      openConstraints: ["ratio >= 2"],
    },
    context: hotContext(300),
  });
  assert.equal(fallback.ok, true);
  if (fallback.ok) {
    assert.equal(fallback.path, "champion");
    assert.equal(fallback.advisory, "learned_timeout");
    assert.match(fallback.summary ?? "", /SUTRA_COMPACTION_SUMMARY/);
    assert.ok(fallback.summary.includes(COMPACTION_SUMMARY_MARKERS.open));
  }

  assert.ok(
    events.some(
      (e) => e.path === "challenger" && e.outcome === "ok" && e.mode === "challenger",
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "fallback" &&
        e.failureClass === "learned_timeout" &&
        e.path === "champion",
    ),
  );
});

test("shadow mode serves champion only; cross-subject rejected", async () => {
  const events = [];
  const swap = createCompactionInterfaceSwap({
    mode: "shadow",
    summarize: async () => "shadow-only challenger text",
    onTelemetry: (e) => events.push(e),
  });

  const shadowed = await swap.compact({
    budget: makeBudget(),
    state: {
      subjectId: "anika-k",
      openConstraints: ["keep"],
    },
    context: hotContext(300),
  });
  assert.equal(shadowed.ok, true);
  if (shadowed.ok) {
    assert.equal(shadowed.path, "champion");
    assert.equal(shadowed.mode, "shadow");
    assert.equal(shadowed.challengerDistinct, true);
    assert.match(shadowed.summary ?? "", /SUTRA_COMPACTION_SUMMARY/);
    assert.notEqual(shadowed.summary, "shadow-only challenger text");
  }

  const cross = await swap.compact({
    budget: makeBudget("anika-k"),
    state: { subjectId: "other-subject" },
    context: hotContext(300),
  });
  assert.equal(cross.ok, false);
  if (!cross.ok) {
    assert.equal(cross.failureClass, "cross_subject");
  }

  assert.ok(
    events.some(
      (e) =>
        e.outcome === "shadow" &&
        e.path === "champion" &&
        e.challengerPath === "challenger" &&
        e.challengerDistinct === true,
    ),
  );
  assert.ok(!JSON.stringify(events).includes("shadow-only challenger text"));
});
