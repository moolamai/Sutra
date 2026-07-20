/**
 * offline-edge (speech): local whisper.cpp-class STT on an Indic fixture,
 * injected into the edge CognitiveBindings set, EdgeAgent turn with network
 * denied (no sync transport).
 *
 *   pnpm --filter @moolam/examples offline-edge:speech
 *   # or: node examples/offline-edge/main-speech.mjs
 */
import { proveOfflineEdgeSttBinding } from "sutra-bindings-speech";

const SECRET = "SECRET_OFFLINE_SPEECH_UTTERANCE";

const proof = await proveOfflineEdgeSttBinding({
  fixtureId: "hi-en-codeswitch",
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
    console.error(`OFFLINE SPEECH FAIL: ${f}`);
  }
  process.exitCode = 1;
  throw new Error(
    `offline edge STT proof failed (${proof.failures.length})`,
  );
}

if (!proof.speechBound || !proof.partialBeforeFinal) {
  throw new Error("speech binding / partial-before-final contract violated");
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

console.log("speech bound     :", proof.speechBound);
console.log("fixture          :", proof.fixtureId);
console.log("final chars      :", proof.finalText.length);
console.log("served locally   :", proof.servedLocally);
console.log("sync             :", proof.syncStatus);
console.log("egress attempts  :", proof.egressAttemptCount);
console.log("languages        :", proof.supportedLanguages.join(", "));
console.log("offline-edge speech OK");
