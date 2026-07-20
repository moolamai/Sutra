// NFR-03 endurance proof: 1k pending friction samples → converged.
// Compose path: POST /v1/sync on docker-compose orchestrator (public contract).
// Fallback: in-process merge when compose is down (CI gate floor only).
import { randomUUID } from "node:crypto";
import { bench, emitBenchTelemetry } from "../_shared/bench.mjs";
import {
  PENDING_SAMPLES,
  NFR03_BUDGET_P95_MS,
  createHttpSyncTransport,
  createInProcessSyncTransport,
  measureSyncConvergenceMs,
  orchestratorHealthy,
} from "../_shared/sync_convergence_probe.mjs";

const ORCH_URL = process.env.SUTRA_ORCHESTRATOR_URL ?? "http://127.0.0.1:8000";
const API_KEY = process.env.SUTRA_API_KEY ?? "compose-operator-surface";
const DEVICE_ID = "edge-conv-bench";

const composeUp = await orchestratorHealthy(ORCH_URL);
const transport = composeUp
  ? createHttpSyncTransport(ORCH_URL, API_KEY)
  : createInProcessSyncTransport();

process.stdout.write(
  `${JSON.stringify({
    event: "benchmarks.sync_convergence.start",
    outcome: composeUp ? "compose" : "in_process_fallback",
    orchestratorUrl: composeUp ? ORCH_URL : null,
    pendingSamples: PENDING_SAMPLES,
    nfrId: "NFR-03",
    budgetP95Ms: NFR03_BUDGET_P95_MS,
    subjectId: "subj-sync-convergence",
    deviceId: DEVICE_ID,
  })}\n`,
);

if (!composeUp) {
  process.stdout.write(
    `${JSON.stringify({
      event: "benchmarks.sync_convergence.notice",
      outcome: "compose_unavailable",
      detail:
        "Start infra/docker-compose for full NFR-03 end-to-end proof; running in-process SyncEngine floor.",
      subjectId: "subj-sync-convergence",
      deviceId: DEVICE_ID,
    })}\n`,
  );
}

await bench(
  `sync convergence, ${PENDING_SAMPLES} pending samples`,
  async (i) => {
    const subjectId = composeUp
      ? `subj-nfr03-${String(i).padStart(4, "0")}`
      : "subj-sync-convergence";
    const { outcome } = await measureSyncConvergenceMs(transport, {
      deviceId: DEVICE_ID,
      subjectId,
      sampleCount: PENDING_SAMPLES,
      syncAttemptId: randomUUID(),
    });
    if (outcome.status !== "converged") {
      const err = new Error(
        `sync outcome ${outcome.status} (subject=${subjectId})`,
      );
      err.failureClass = "sync_not_converged";
      throw err;
    }
  },
  {
    warmup: composeUp ? 3 : 5,
    iterations: composeUp ? 12 : 30,
    subjectId: "subj-sync-convergence",
    deviceId: DEVICE_ID,
    emitStructured: true,
  },
);

emitBenchTelemetry({
  outcome: "ok",
  name: "sync_convergence.summary",
  subjectId: "subj-sync-convergence",
  deviceId: DEVICE_ID,
  nfrId: "NFR-03",
  budgetP95Ms: NFR03_BUDGET_P95_MS,
  pendingSamples: PENDING_SAMPLES,
  path: composeUp ? "compose" : "in_process_fallback",
});
