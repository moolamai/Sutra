// CRDT merge throughput: how fast the cloud can reconcile replicas.
// Measures CrdtHarnessResolver.merge (including schema validation) over
// documents of increasing size.
import { CrdtHarnessResolver, PROTOCOL_VERSION } from "sutra-sdk";
import { bench } from "./_shared/bench.mjs";

const hlc = (ms, logical, device) => `${String(ms).padStart(15, "0")}:${String(logical).padStart(6, "0")}:${device}`;

function makeState(device, concepts, samples) {
  const mastery = {};
  for (let i = 0; i < concepts; i++) {
    mastery[`concept.${i}`] = {
      conceptId: `concept.${i}`,
      alpha: { [device]: i % 7 },
      beta: { [device]: i % 3 },
      lastExercisedAt: hlc(1_000_000 + i, 0, device),
    };
  }
  const frictionLog = Array.from({ length: samples }, (_, i) => ({
    conceptId: `concept.${i % concepts}`,
    hesitationMs: 1000 + i,
    inputVelocity: 3.1,
    revisionCount: i % 4,
    assistanceRequested: i % 5 === 0,
    outcome: ["correct", "partial", "incorrect", "ungraded"][i % 4],
    capturedAt: hlc(2_000_000 + i, i % 100, device),
  }));
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId: "bench-subject",
    deviceIds: [device],
    activeConceptId: "concept.0",
    mode: "exploratory",
    mastery,
    frictionLog,
    profile: { ageBand: "adult", track: "bench-track", language: "en-IN", updatedAt: hlc(3_000_000, 0, device) },
    stateVector: { session: hlc(3_000_000, 1, device) },
  };
}

const resolver = new CrdtHarnessResolver();
for (const [concepts, samples] of [[10, 20], [50, 200], [200, 1000]]) {
  const a = makeState("device-aaaa", concepts, samples);
  const b = makeState("device-bbbb", concepts, samples);
  await bench(`merge ${concepts} concepts / ${samples} samples`, () => {
    resolver.merge(a, b);
  });
}
