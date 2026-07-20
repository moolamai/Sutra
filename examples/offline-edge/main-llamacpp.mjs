/**
 * offline-edge (llama.cpp): full EdgeAgent CognitiveCore turn with
 * LlamaCppSlmRuntime, permanently offline (no sync transport), network denied
 * via the desktop certification proof harness.
 *
 *   pnpm --filter @moolam/examples offline-edge:llamacpp
 *   # or: node examples/offline-edge/main-llamacpp.mjs
 */
import {
  proveLlamaCppOfflineDesktopTurn,
} from "sutra-bindings-slm";

const SECRET = "SECRET_OFFLINE_LLAMA_UTTERANCE";

const proof = await proveLlamaCppOfflineDesktopTurn({
  onTelemetry: (e) => {
    // Metadata only — never log utterance bodies.
    console.log(
      JSON.stringify({
        event: e.event,
        outcome: e.outcome,
        subjectId: e.subjectId,
        deviceId: e.deviceId,
      }),
    );
  },
});

if (!proof.ok) {
  for (const f of proof.failures) {
    console.error(`OFFLINE TURN FAIL: ${f}`);
  }
  process.exitCode = 1;
  throw new Error(`offline llama.cpp turn proof failed (${proof.failures.length})`);
}

if (!proof.servedLocally || !proof.frictionFolded || !proof.localityOk) {
  throw new Error("offline contract violated");
}
if (proof.syncStatus !== "offline-mode") {
  throw new Error(`expected offline-mode sync, got ${proof.syncStatus}`);
}
if (!proof.restartSurvived || !proof.subjectIsolationOk) {
  throw new Error("restart / subject isolation proof failed");
}
if (!proof.reply?.text) {
  throw new Error("empty reply");
}
if (JSON.stringify(proof).includes(SECRET)) {
  throw new Error("secret utterance leaked into proof payload");
}

console.log("served locally :", proof.servedLocally);
console.log("reply chars    :", proof.reply.text.length);
console.log("sync           :", proof.syncStatus);
console.log("egress attempts:", proof.egressAttemptCount);
console.log("artifact sha   :", proof.measuredArtifactSha256.slice(0, 12), "…");
console.log("llama.cpp pin  :", proof.llamaCppPinnedRevision);
console.log("offline-edge llama.cpp OK");
