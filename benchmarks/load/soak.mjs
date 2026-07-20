// Soak: concurrent-subject load for a configured window + leak detection.
// Samples edge harness + orchestrator RSS/handles every interval; fail on
// post-warmup monotonic growth beyond tolerance.
// Public wire: POST /v1/sync + POST /v1/agent/turn (no test backdoors).
// Compose when healthy; in-process floor when compose absent.
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_SUBJECT_COUNT,
  DEFAULT_ROUNDS_PER_WORKER,
  NFR04_TURN_P95_MS,
  LOAD_SYNC_P95_MS,
  LOAD_MAX_ERROR_RATE,
  createHttpLoadClient,
  createInProcessLoadClient,
  runConcurrentSubjectLoad,
  evaluateConcurrentLoadGate,
  formatConcurrentLoadGateReport,
  emitConcurrentLoadTelemetry,
  orchestratorHealthy,
} from "../_shared/concurrent_load_probe.mjs";
import {
  DEFAULT_SOAK_MS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_WARMUP_SAMPLES,
  DEFAULT_RSS_GROWTH_TOLERANCE_BYTES,
  DEFAULT_HANDLE_GROWTH_TOLERANCE,
  runSoakWithLeakDetection,
  formatSoakLeakGateReport,
  emitSoakLeakTelemetry,
} from "../_shared/soak_leak_probe.mjs";

const ORCH_URL = process.env.SUTRA_ORCHESTRATOR_URL ?? "http://127.0.0.1:8000";
const API_KEY = process.env.SUTRA_API_KEY ?? "compose-operator-surface";
const DEVICE_PREFIX = "edge-load-soak";

const concurrency = Number(process.env.SUTRA_LOAD_CONCURRENCY ?? DEFAULT_CONCURRENCY);
const subjectCount = Number(process.env.SUTRA_LOAD_SUBJECTS ?? DEFAULT_SUBJECT_COUNT);
const roundsPerWorker = Number(
  process.env.SUTRA_LOAD_ROUNDS ?? DEFAULT_ROUNDS_PER_WORKER,
);

/** Full proof default 30m; CI uses SUTRA_SOAK_MS (e.g. 8000) + shorter sample interval. */
const soakMs = Number(process.env.SUTRA_SOAK_MS ?? DEFAULT_SOAK_MS);
const sampleIntervalMs = Number(
  process.env.SUTRA_SOAK_SAMPLE_MS ?? DEFAULT_SAMPLE_INTERVAL_MS,
);
const warmupSamples = Number(
  process.env.SUTRA_SOAK_WARMUP_SAMPLES ?? DEFAULT_WARMUP_SAMPLES,
);

const composeUp = await orchestratorHealthy(ORCH_URL);
const client = composeUp
  ? createHttpLoadClient(ORCH_URL, API_KEY)
  : createInProcessLoadClient();

emitConcurrentLoadTelemetry({
  outcome: composeUp ? "compose" : "in_process_fallback",
  action: "start",
  orchestratorUrl: composeUp ? ORCH_URL : null,
  concurrency,
  subjectCount,
  roundsPerWorker,
  soakMs,
  sampleIntervalMs,
  warmupSamples,
  rssGrowthToleranceBytes: DEFAULT_RSS_GROWTH_TOLERANCE_BYTES,
  handleGrowthTolerance: DEFAULT_HANDLE_GROWTH_TOLERANCE,
  nfrTurnId: "NFR-04",
  turnBudgetP95Ms: NFR04_TURN_P95_MS,
  syncBudgetP95Ms: LOAD_SYNC_P95_MS,
  maxErrorRate: LOAD_MAX_ERROR_RATE,
  deviceId: DEVICE_PREFIX,
  subjectId: null,
});

if (!composeUp) {
  emitConcurrentLoadTelemetry({
    outcome: "compose_unavailable",
    action: "notice",
    detail:
      "Start infra/docker-compose for full soak leak proof; running in-process floor.",
    deviceId: DEVICE_PREFIX,
    subjectId: null,
  });
}

const soak = await runSoakWithLeakDetection({
  soakMs,
  sampleIntervalMs,
  warmupSamples,
  deviceId: DEVICE_PREFIX,
  runLoadCycle: async ({ tick }) => {
    const result = await runConcurrentSubjectLoad({
      client,
      concurrency,
      subjectCount,
      roundsPerWorker,
      warmupRounds: tick === 0 ? 1 : 0,
      deviceIdPrefix: `${DEVICE_PREFIX}-t${tick}`,
    });
    return result;
  },
});

const lastLoad = soak.loadResults[soak.loadResults.length - 1];
if (lastLoad) {
  emitConcurrentLoadTelemetry({
    outcome: lastLoad.errorCount === 0 ? "ok" : "rejected",
    action: "summary",
    path: lastLoad.path,
    concurrency: lastLoad.concurrency,
    subjectCount: lastLoad.subjectCount,
    subjectsTouched: lastLoad.subjectsTouched.length,
    syncP95: lastLoad.sync.p95,
    turnP95: lastLoad.turn.p95,
    errorCount: lastLoad.errorCount,
    errorRate: lastLoad.errorRate,
    totalElapsedMs: lastLoad.totalElapsedMs,
    soakTicks: soak.ticks,
    deviceId: DEVICE_PREFIX,
    subjectId: null,
  });

  process.stdout.write(
    `concurrent load  sync_p95=${lastLoad.sync.p95.toFixed(3)}ms  turn_p95=${lastLoad.turn.p95.toFixed(3)}ms  ` +
      `errors=${lastLoad.errorCount}  error_rate=${(lastLoad.errorRate * 100).toFixed(2)}%  ` +
      `subjects=${lastLoad.subjectsTouched.length}/${lastLoad.subjectCount}  path=${lastLoad.path}\n`,
  );

  const loadGate = evaluateConcurrentLoadGate(lastLoad);
  process.stdout.write(formatConcurrentLoadGateReport(loadGate, lastLoad));
  if (!loadGate.ok) process.exitCode = 1;
}

emitSoakLeakTelemetry({
  outcome: soak.leakGate.ok ? "ok" : "rejected",
  action: "gate",
  failureClass: soak.leakGate.failureClass ?? null,
  ticks: soak.ticks,
  soakMs: soak.soakMs,
  sampleIntervalMs: soak.sampleIntervalMs,
  breachCount: soak.leakGate.breaches?.length ?? 0,
  deviceId: DEVICE_PREFIX,
  subjectId: null,
});

process.stdout.write(
  formatSoakLeakGateReport(soak.leakGate, {
    soakMs: soak.soakMs,
    sampleIntervalMs: soak.sampleIntervalMs,
    path: composeUp ? "compose" : "in_process_fallback",
  }),
);

if (!soak.leakGate.ok) {
  process.exitCode = 1;
}
