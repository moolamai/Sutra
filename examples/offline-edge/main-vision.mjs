/**
 * offline-edge (vision): local VLM on a committed CK-06 fixture image,
 * injected into the edge CognitiveBindings set, CognitiveCore attachment
 * turn + EdgeAgent with network denied (no sync transport).
 *
 *   pnpm --filter @moolam/examples offline-edge:vision
 *   # or: node examples/offline-edge/main-vision.mjs
 */
import { proveOfflineEdgeVisionBinding } from "sutra-bindings-vision";

const SECRET = "SECRET_OFFLINE_VISION_UTTERANCE";

const proof = await proveOfflineEdgeVisionBinding({
  fixtureId: "valid-schema-answer",
  vlmOptions: { maxInputBytes: 64 },
  onTelemetry: (e) => {
    console.log(
      JSON.stringify({
        event: e.event,
        outcome: e.outcome,
        subjectId: e.subjectId,
        deviceId: e.deviceId,
        fixtureId: e.fixtureId,
      }),
    );
  },
});

if (!proof.ok) {
  for (const f of proof.failures) {
    console.error(`OFFLINE VISION FAIL: ${f}`);
  }
  process.exitCode = 1;
  throw new Error(
    `offline edge vision proof failed (${proof.failures.length})`,
  );
}

if (!proof.visionBound || proof.analyzeAnswerChars < 1) {
  throw new Error("vision binding / analyze contract violated");
}
if (!proof.servedLocally || proof.syncStatus !== "offline-mode") {
  throw new Error("offline contract violated");
}
if (!proof.localityOk || proof.egressAttemptCount !== 0) {
  throw new Error("network-deny / locality contract violated");
}
if (!proof.cognitiveCoreOk || !proof.subjectIsolationOk) {
  throw new Error("CognitiveCore / subject isolation proof failed");
}
if (JSON.stringify(proof).includes(SECRET)) {
  throw new Error("secret leaked into proof payload");
}

console.log("vision bound    :", proof.visionBound);
console.log("fixture         :", proof.fixtureId);
console.log("answer chars    :", proof.analyzeAnswerChars);
console.log("served locally  :", proof.servedLocally);
console.log("sync            :", proof.syncStatus);
console.log("egress attempts :", proof.egressAttemptCount);
console.log("maxInputBytes   :", proof.maxInputBytes);
console.log("offline-edge vision OK");

