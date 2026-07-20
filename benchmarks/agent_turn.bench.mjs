// Agent-turn overhead (NFR-06): full CognitiveCore.turn perceive→reflect
// with contract-complete zero-sleep mocks. Measures composition overhead,
// not model/tool wall-clock. Contrasts with core_loop (same floor, agent_turn
// naming/contract surface for the missing-benches gate row).
import { bench, BENCH_SUBJECT_ID } from "./_shared/bench.mjs";
import { createAgentTurnCore, runAgentTurn } from "./_shared/agent_turn_probe.mjs";

const DEVICE_ID = "bench-harness";
const pack = createAgentTurnCore({ subjectId: BENCH_SUBJECT_ID });

await bench(
  "agent turn perceive→reflect (zero-sleep mocks)",
  () =>
    runAgentTurn({
      subjectId: BENCH_SUBJECT_ID,
      sessionId: "bench-sess.agent-turn",
      utterance: "benchmark utterance",
      corePack: pack,
    }),
  {
    warmup: 100,
    iterations: 1000,
    subjectId: BENCH_SUBJECT_ID,
    deviceId: DEVICE_ID,
  },
);
