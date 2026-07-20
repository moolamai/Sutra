// Sync round-trip latency: SyncEngine push + validated adoption over an
// in-process transport that performs a real cloud-side CRDT merge.
// Measures the full edge-to-cloud handoff path minus the network.
import { CrdtHarnessResolver, SyncEngine, PROTOCOL_VERSION } from "sutra-sdk";
import { randomUUID } from "node:crypto";
import { bench } from "./_shared/bench.mjs";

const hlc = (ms, logical, device) => `${String(ms).padStart(15, "0")}:${String(logical).padStart(6, "0")}:${device}`;

function makeState(device, samples) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId: "bench-subject",
    deviceIds: [device],
    activeConceptId: "concept.0",
    mode: "guided",
    mastery: {
      "concept.0": { conceptId: "concept.0", alpha: { [device]: 3 }, beta: { [device]: 1 }, lastExercisedAt: hlc(1_000_000, 0, device) },
    },
    frictionLog: Array.from({ length: samples }, (_, i) => ({
      conceptId: "concept.0",
      hesitationMs: 900 + i,
      inputVelocity: 3,
      revisionCount: 0,
      assistanceRequested: false,
      outcome: "correct",
      capturedAt: hlc(2_000_000 + i, 0, device),
    })),
    profile: { ageBand: "adult", track: "bench-track", language: "en-IN", updatedAt: hlc(3_000_000, 0, device) },
    stateVector: { session: hlc(3_000_000, 1, device) },
  };
}

// In-process "cloud": real merge, zero network.
const resolver = new CrdtHarnessResolver();
let master = makeState("cloud", 0);
const transport = {
  postSync: async (request) => {
    const { merged, advisories } = resolver.merge(master, request.edgeState);
    master = merged;
    return {
      kind: "ok",
      response: {
        protocolVersion: PROTOCOL_VERSION,
        mergedState: merged,
        compactedSampleTimestamps: merged.frictionLog.map((s) => s.capturedAt),
        advisories,
      },
    };
  },
};

const engine = new SyncEngine(transport);
for (const samples of [10, 100, 500]) {
  const edgeState = makeState("device-aaaa", samples);
  await bench(`sync round-trip, ${samples} pending samples`, async () => {
    const outcome = await engine.synchronize({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-aaaa",
      edgeState,
      lastKnownCloudVector: {},
      syncAttemptId: randomUUID(),
    });
    if (outcome.status !== "converged") throw new Error(outcome.status);
  }, { warmup: 5, iterations: 100 });
}
