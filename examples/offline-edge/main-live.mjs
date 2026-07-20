/**
 * offline-edge (live): full EdgeAgent turn with a real local Ollama model.
 *
 * Prerequisites: Ollama running on loopback; model pulled (default qwen2.5:0.5b).
 * CI uses the in-process stand-in via offline-edge:llamacpp — this script is
 * opt-in for local demos.
 *
 *   pnpm --filter @moolam/examples offline-edge:live
 */
import { runOfflineEdgeLiveTurn } from "sutra-bindings-slm";

const result = await runOfflineEdgeLiveTurn({
  onTelemetry: (event) => {
    console.log(
      JSON.stringify({
        event: event.event,
        outcome: event.outcome,
        subjectId: event.subjectId,
        deviceId: event.deviceId,
        ...(event.ollamaModel ? { ollamaModel: event.ollamaModel } : {}),
      }),
    );
  },
});

if (!result.ok) {
  for (const failure of result.failures) {
    console.error(`OFFLINE LIVE FAIL: ${failure}`);
  }
  if (result.failures.some((f) => f.includes("not in /api/tags"))) {
    console.error(
      `Hint: ollama pull ${result.ollamaModel}  (or set SUTRA_OLLAMA_MODEL)`,
    );
  }
  const daemonMissing = result.failures.some(
    (f) =>
      /fetch failed|ECONNREFUSED|not reachable/i.test(f) ||
      f.includes("not in /api/tags"),
  );
  if (daemonMissing) {
    console.error("");
    console.error("Ollama is not running (or not installed). Install it first:");
    console.error("  Windows: winget install Ollama.Ollama");
    console.error("  Or:      https://ollama.com/download");
    console.error("Then open a new terminal and run:");
    console.error(`  ollama pull ${result.ollamaModel}`);
    console.error("  pnpm --filter @moolam/examples offline-edge:live");
    console.error("");
    console.error(
      "No Ollama? Use the CI stand-in instead: pnpm --filter @moolam/examples offline-edge:llamacpp",
    );
  } else if (result.failures.some((f) => f.includes("fetch failed"))) {
    console.error("");
    console.error(
      "Ollama responded to /api/tags but the live turn could not reach it.",
    );
    console.error(
      "Ensure the Ollama app is running (system tray) and retry.",
    );
  }
  process.exitCode = 1;
  throw new Error(
    `offline-edge live failed (${result.failures.length} issue(s))`,
  );
}

console.log("served locally     :", result.servedLocally);
console.log("ollama model       :", result.ollamaModel);
console.log("ollama base        :", result.ollamaBaseUrl);
console.log("reply preview      :", result.reply?.text?.slice(0, 240));
console.log("sync               :", result.syncStatus);
console.log("third-party egress :", result.thirdPartyEgressCount);
console.log("loopback egress    :", result.loopbackEgressCount);
console.log("offline-edge live OK");
