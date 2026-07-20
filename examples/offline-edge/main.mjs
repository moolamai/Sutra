// offline-edge: a full EdgeAgent turn with no network, no cloud, no real
// model weights. The SlmRuntime and StorageDriver are in-memory mocks; the
// agent loop, telemetry, mastery folding, and state machine are the real
// shipped code.
//
// Golden inputs from
// golden-turn.json; assert servedLocally + friction fold + offline sync.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EdgeAgent } from "sutra-sdk";
import { embed } from "@moolam/contract-mocks";

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(HERE, "golden-turn.json"), "utf8"),
);

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
  descriptor: {
    modelId: "mock-phi",
    quantization: "q4",
    contextWindow: 4096,
    languages: ["en-IN"],
  },
  load: async () => {},
  generate: async ({ prompt }) => ({
    text: `On-device reply grounded in prompt of ${prompt.length} chars.`,
    tokensPerSecond: 42,
    finishReason: "stop",
  }),
  embed: async (text) => Float32Array.from(embed(text)),
};

const agent = new EdgeAgent({
  subjectId: golden.subjectId,
  deviceId: golden.deviceId,
  runtime,
  storage: memoryDriver(),
  // no transport: permanently-offline sovereign mode
  profile: golden.profile,
});

await agent.initialize();

const reply = await agent.agentTurn(golden.utterance, { ...golden.friction });

console.log("served locally:", reply.servedLocally);
console.log("reply         :", reply.text);
const sync = await agent.syncNow();
console.log("sync outcome  :", sync.status, "(offline mode has no transport)");

const mastery = agent.cognitiveState.mastery[golden.expect.conceptId];
if (!reply.servedLocally || sync.status !== golden.expect.syncStatus) {
  throw new Error("offline contract violated");
}
if (reply.conceptId !== golden.expect.conceptId) {
  throw new Error(`conceptId mismatch: ${reply.conceptId}`);
}
if (!reply.text?.startsWith(golden.expect.replyTextPrefix)) {
  throw new Error("reply shape / mock grounding violated");
}
const keys = Object.keys(reply).sort().join(",");
const expectedKeys = [...golden.expect.replyKeys].sort().join(",");
if (keys !== expectedKeys) {
  throw new Error(`AgentReply keys drifted: ${keys}`);
}
if (!mastery || mastery.lastExercisedAt !== golden.friction.capturedAt) {
  throw new Error("friction fold missing after golden turn");
}

console.log("offline-edge OK");
