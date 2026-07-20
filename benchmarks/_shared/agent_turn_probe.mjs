/**
 * Agent-turn probe — full CognitiveCore.turn (perceive→reflect) with
 * contract-complete zero-sleep mocks. Measures NFR-06 composition overhead,
 * not model inference time.
 */
import { CognitiveCore } from "sutra-sdk";
import { BENCH_SUBJECT_ID } from "./bench.mjs";

/** Caps concurrent same-subject turns exercised in tests (bounded). */
export const AGENT_TURN_CONCURRENCY_CAP = 4;

/**
 * Contract-complete CognitiveBindings with zero-sleep model/reasoning/tools.
 * Sleeping mocks would pollute NFR-06 (composition only).
 */
export function createZeroSleepBindings(opts = {}) {
  const subjectId = opts.subjectId ?? BENCH_SUBJECT_ID;
  let sleepCalls = 0;
  const noSleep = () => {
    sleepCalls += 1;
    throw new Error("zero-sleep mock violated: sleep/delay forbidden in NFR-06 path");
  };

  const bindings = {
    memory: {
      remember: async (item) => {
        if (item?.subjectId && item.subjectId !== subjectId) {
          const err = new Error("memory.remember: cross-subject write rejected");
          err.failureClass = "subject_isolation";
          throw err;
        }
        return { ...item, id: item?.id ?? "m-bench" };
      },
      recall: async (q) => {
        if (q?.subjectId && q.subjectId !== subjectId) {
          const err = new Error("memory.recall: cross-subject read rejected");
          err.failureClass = "subject_isolation";
          throw err;
        }
        return [
          {
            item: {
              id: "m0",
              subjectId,
              topicId: "t",
              text: "prior",
              kind: "episodic",
              createdAt: "2026-01-01",
            },
            score: 1,
          },
        ];
      },
      associate: async () => {},
      forget: async () => {},
      compact: async () => 0,
    },
    model: {
      descriptor: {
        modelId: "instant-zero-sleep",
        contextWindow: 8192,
        locality: "on-device",
        modalities: ["text"],
      },
      generate: async () => ({ text: "reply", finishReason: "stop" }),
      generateStream: async function* () {
        yield "reply";
      },
      embed: async () => new Float32Array(8),
      /** Test hook — real benches must never call this. */
      sleep: noSleep,
    },
    reasoning: {
      deliberate: async () => ({
        conclusion: "c",
        confidence: 1,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
        unresolvedConstraints: [],
      }),
      sleep: noSleep,
    },
    planning: {
      compose: async () => ({ planId: "p", steps: [], rationale: "r" }),
      revise: async (p) => p,
      nextStep: () => null,
    },
    tools: {
      list: () => [],
      invoke: async (i) => ({
        invocationId: i.invocationId,
        status: "ok",
        output: null,
        latencyMs: 0,
      }),
    },
    knowledge: {
      sources: [],
      retrieve: async () => [
        {
          sourceId: "k",
          citation: "k#1",
          content: "passage",
          score: 1,
          asOf: "2026-01-01",
        },
      ],
    },
  };

  return {
    bindings,
    subjectId,
    getSleepCalls: () => sleepCalls,
  };
}

export function createAgentTurnCore(opts = {}) {
  const pack = createZeroSleepBindings(opts);
  const core = new CognitiveCore(
    {
      domainId: opts.domainId ?? "bench-agent-turn",
      charter: "bench",
      refusals: [],
      languages: ["en"],
    },
    pack.bindings,
  );
  return { core, ...pack };
}

/**
 * One perceive→reflect CognitiveCore.turn with validated subject/session.
 */
export async function runAgentTurn(input) {
  const subjectId = typeof input.subjectId === "string" ? input.subjectId.trim() : "";
  if (!subjectId) {
    const err = new Error("runAgentTurn: subjectId required");
    err.failureClass = "validation_failed";
    throw err;
  }
  const sessionId =
    typeof input.sessionId === "string" && input.sessionId.trim()
      ? input.sessionId.trim()
      : `bench-sess.${subjectId}`;
  const utterance =
    typeof input.utterance === "string" ? input.utterance : "benchmark utterance";

  const pack = input.corePack ?? createAgentTurnCore({ subjectId });
  const out = await pack.core.turn({ subjectId, sessionId, utterance });
  if (pack.getSleepCalls() > 0) {
    const err = new Error("runAgentTurn: sleep invoked on zero-sleep mock");
    err.failureClass = "bench_failed";
    throw err;
  }
  return {
    subjectId,
    sessionId,
    reply: out.reply,
    plan: out.plan ?? null,
    /** Distilled for telemetry — never the raw utterance body. */
    outcome: "ok",
    stagesHint: "perceive-through-reflect",
  };
}
