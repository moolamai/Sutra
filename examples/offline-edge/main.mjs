// offline-edge: a full EdgeAgent turn with no network, no cloud, no real
// model weights. The SlmRuntime and StorageDriver are in-memory mocks; the
// agent loop, telemetry, mastery folding, and state machine are the real
// shipped code.
import { EdgeAgent } from "@moolam/sdk";
import { embed } from "../_shared/mocks.mjs";

/** In-memory StorageDriver (see @moolam/contracts StorageDriver). */
function memoryDriver() {
  const tables = new Map();
  return {
    async execute(sql, params = []) {
      if (sql.trim().startsWith("CREATE")) return;
      if (sql.includes("INSERT") && sql.includes("memory_records")) {
        tables.set(`mem:${params[0]}`, params);
      } else if (sql.includes("INSERT") && sql.includes("friction_samples")) {
        tables.set(`fs:${params[0]}`, params);
      }
    },
    async query() {
      return [];
    },
  };
}

/** Mock SlmRuntime honoring the load/generate/embed contract. */
const runtime = {
  descriptor: { modelId: "mock-phi", quantization: "q4", contextWindow: 4096, languages: ["en-IN"] },
  load: async () => {},
  generate: async ({ prompt }) => ({
    text: `On-device reply grounded in prompt of ${prompt.length} chars.`,
    tokensPerSecond: 42,
    finishReason: "stop",
  }),
  embed: async (text) => Float32Array.from(embed(text)),
};

const agent = new EdgeAgent({
  subjectId: "subject-7",
  deviceId: "edge-demo-device",
  runtime,
  storage: memoryDriver(),
  // no transport: permanently-offline sovereign mode
  profile: { ageBand: "adult", track: "system-design-l5", language: "en-IN" },
});

await agent.initialize();

const reply = await agent.agentTurn("Explain consistent hashing simply.", {
  conceptId: "sd.consistent-hashing",
  hesitationMs: 900,
  inputVelocity: 4.1,
  revisionCount: 0,
  assistanceRequested: false,
  outcome: "ungraded",
  capturedAt: `${String(Date.now()).padStart(15, "0")}:000000:edge-demo-device`,
});

console.log("served locally:", reply.servedLocally);
console.log("reply         :", reply.text);
const sync = await agent.syncNow();
console.log("sync outcome  :", sync.status, "(offline mode has no transport)");
if (!reply.servedLocally || sync.status !== "offline-mode") throw new Error("offline contract violated");
console.log("offline-edge OK");
