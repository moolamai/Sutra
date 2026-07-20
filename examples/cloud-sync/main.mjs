// cloud-sync: two device replicas diverge offline, then converge through
// the real CRDT merge engine. Convergence is a property of the data types:
// merge order cannot change the result.
import { CrdtHarnessResolver, HlcClock, PROTOCOL_VERSION } from "sutra-sdk";

function genesis(subjectId, deviceId, clock) {
  const now = clock.tick();
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId,
    deviceIds: [deviceId],
    activeConceptId: "math.ratios",
    mode: "diagnostic",
    mastery: {},
    frictionLog: [],
    profile: { ageBand: "adolescent", track: "cbse-class-7-maths", language: "en-IN", updatedAt: now },
    stateVector: { session: now },
  };
}

function exercise(state, clock, deviceId, conceptId, correct) {
  const at = clock.tick();
  const entry = (state.mastery[conceptId] ??= { conceptId, alpha: {}, beta: {}, lastExercisedAt: at });
  if (correct) entry.alpha[deviceId] = (entry.alpha[deviceId] ?? 0) + 1;
  else entry.beta[deviceId] = (entry.beta[deviceId] ?? 0) + 1;
  entry.lastExercisedAt = at;
  state.frictionLog.push({
    conceptId,
    hesitationMs: correct ? 800 : 12000,
    inputVelocity: 3,
    revisionCount: correct ? 0 : 4,
    assistanceRequested: !correct,
    outcome: correct ? "correct" : "incorrect",
    capturedAt: at,
  });
  state.stateVector.session = clock.tick();
}

const clockA = new HlcClock("device-aaaa");
const clockB = new HlcClock("device-bbbb");
const a = genesis("subject-9", "device-aaaa", clockA);
const b = genesis("subject-9", "device-bbbb", clockB);

// Diverge: device A practices ratios successfully, device B struggles offline.
exercise(a, clockA, "device-aaaa", "math.ratios", true);
exercise(a, clockA, "device-aaaa", "math.ratios", true);
exercise(b, clockB, "device-bbbb", "math.ratios", false);
exercise(b, clockB, "device-bbbb", "math.fractions", false);

const resolver = new CrdtHarnessResolver();
const ab = resolver.merge(a, b).merged;
const ba = resolver.merge(b, a).merged;

console.log("devices        :", ab.deviceIds.join(", "));
console.log("friction union :", ab.frictionLog.length, "samples");
console.log("ratios shards  :", JSON.stringify(ab.mastery["math.ratios"].alpha), JSON.stringify(ab.mastery["math.ratios"].beta));
if (JSON.stringify(ab) !== JSON.stringify(ba)) throw new Error("merge must be commutative");
if (ab.frictionLog.length !== 4) throw new Error("G-Set union must keep all samples");
console.log("commutative    : true");
console.log("cloud-sync OK");
