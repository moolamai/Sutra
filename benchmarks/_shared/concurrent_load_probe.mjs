/**
 * Concurrent-subject load generator — alternates POST /v1/sync and /v1/agent/turn.
 * Contract-valid payloads only; metadata telemetry (never utterance bodies).
 */
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "sutra-sdk";
import { percentileFromSorted } from "./bench.mjs";
import {
  buildEdgeStateWithPendingSamples,
  orchestratorHealthy,
} from "./sync_convergence_probe.mjs";

export { orchestratorHealthy };

/** Default worker count (C). */
export const DEFAULT_CONCURRENCY = 8;

/** Distinct subjects (M) — load spreads across subjects, not one hot row. */
export const DEFAULT_SUBJECT_COUNT = 16;

/** Rounds per worker (sync → turn each round). */
export const DEFAULT_ROUNDS_PER_WORKER = 12;

/** Friction samples per sync under load (not the 1k NFR-03 proof). */
export const LOAD_SYNC_SAMPLE_COUNT = 8;

/** NFR-04 routing overhead ceiling (ms). */
export const NFR04_TURN_P95_MS = 50;

/** Concurrent sync op p95 under load (compose tolerance). */
export const LOAD_SYNC_P95_MS = 5_000;

/** Zero errors required after warmup. */
export const LOAD_MAX_ERROR_RATE = 0;

const hlc = (ms, logical, device) =>
  `${String(ms).padStart(15, "0")}:${String(logical).padStart(6, "0")}:${device}`;

/**
 * Contract-valid POST /v1/sync body (metadata friction only).
 */
export function buildSyncRequest(subjectId, deviceId, sampleCount = LOAD_SYNC_SAMPLE_COUNT) {
  if (typeof subjectId !== "string" || !subjectId.trim()) {
    const err = new Error("buildSyncRequest: subjectId required");
    err.failureClass = "validation_failed";
    throw err;
  }
  if (typeof deviceId !== "string" || deviceId.length < 4) {
    const err = new Error("buildSyncRequest: deviceId required");
    err.failureClass = "validation_failed";
    throw err;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState: buildEdgeStateWithPendingSamples(deviceId, subjectId, sampleCount),
    lastKnownCloudVector: {},
    syncAttemptId: randomUUID(),
  };
}

/**
 * Contract-valid POST /v1/agent/turn body (DeterministicFakeProvider on compose).
 */
export function buildAgentTurnRequest(subjectId, deviceId = "edge-load-bench") {
  if (typeof subjectId !== "string" || !subjectId.trim()) {
    const err = new Error("buildAgentTurnRequest: subjectId required");
    err.failureClass = "validation_failed";
    throw err;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId,
    sessionId: `sess-load-${subjectId}`,
    utterance: "ratio guidance probe",
    friction: {
      conceptId: "math.ratios",
      hesitationMs: 120,
      inputVelocity: 2.0,
      revisionCount: 0,
      assistanceRequested: false,
      outcome: "correct",
      capturedAt: hlc(1_700_000_300_000, 0, deviceId),
    },
  };
}

/** Spread M synthetic subject ids — one device id per worker. */
export function buildLoadSubjectIds(count = DEFAULT_SUBJECT_COUNT, prefix = "subj-load") {
  if (!Number.isInteger(count) || count < 1 || count > 256) {
    const err = new Error("subject count must be integer 1..256");
    err.failureClass = "validation_failed";
    throw err;
  }
  return Array.from({ length: count }, (_, i) =>
    `${prefix}-${String(i).padStart(4, "0")}`,
  );
}

function summarizeLatencies(samples) {
  if (!samples.length) {
    return { count: 0, p50: NaN, p95: NaN, p99: NaN, mean: NaN };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    count: sorted.length,
    p50: percentileFromSorted(sorted, 50),
    p95: percentileFromSorted(sorted, 95),
    p99: percentileFromSorted(sorted, 99),
    mean,
  };
}

/**
 * HTTP client for public /v1/sync and /v1/agent/turn (no test backdoors).
 */
export function createHttpLoadClient(baseUrl, apiKey, opts = {}) {
  const root = baseUrl.replace(/\/$/, "");
  const extraDelayMs = opts.extraDelayMs ?? 0;
  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };

  async function postJson(path, body) {
    const t0 = performance.now();
    if (extraDelayMs > 0) {
      await new Promise((r) => setTimeout(r, extraDelayMs));
    }
    try {
      const res = await fetch(`${root}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      const elapsedMs = performance.now() - t0;
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          elapsedMs,
          status: res.status,
          failureClass: "http_error",
          detail: text.slice(0, 200),
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          elapsedMs,
          status: res.status,
          failureClass: "invalid_response",
        };
      }
      return { ok: true, elapsedMs, status: res.status, body: parsed };
    } catch (cause) {
      return {
        ok: false,
        elapsedMs: performance.now() - t0,
        failureClass: "network_error",
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  return {
    path: "compose",
    async postSync(request) {
      return postJson("/v1/sync", request);
    },
    async postAgentTurn(request) {
      return postJson("/v1/agent/turn", request);
    },
  };
}

/**
 * In-process floor when compose is down — per-subject merge map + zero-sleep turn ack.
 */
export function createInProcessLoadClient(opts = {}) {
  const syncTransport = opts.syncTransport;
  const extraDelayMs = opts.extraDelayMs ?? 0;
  const importSync = !syncTransport;

  let transportPromise;
  if (importSync) {
    transportPromise = import("./sync_convergence_probe.mjs").then((m) =>
      m.createInProcessSyncTransport({ extraDelayMs }),
    );
  }

  return {
    path: "in_process_fallback",
    async postSync(request) {
      const transport = syncTransport ?? (await transportPromise);
      const t0 = performance.now();
      const result = await transport.postSync(request);
      const elapsedMs = performance.now() - t0;
      if (result.kind !== "ok") {
        return {
          ok: false,
          elapsedMs,
          failureClass: result.kind === "network-error" ? "network_error" : "sync_failed",
          detail: result.cause ?? result.body ?? "sync failed",
        };
      }
      return { ok: true, elapsedMs, status: 200, body: result.response };
    },
    async postAgentTurn(request) {
      const t0 = performance.now();
      if (extraDelayMs > 0) {
        await new Promise((r) => setTimeout(r, extraDelayMs));
      }
      if (!request?.subjectId?.trim()) {
        return {
          ok: false,
          elapsedMs: performance.now() - t0,
          failureClass: "validation_failed",
        };
      }
      return {
        ok: true,
        elapsedMs: performance.now() - t0,
        status: 200,
        body: {
          protocolVersion: PROTOCOL_VERSION,
          reply: "GUIDE concept=math.ratios mode=guided",
          nextConceptId: "math.ratios",
          mode: "guided",
          routingRationale: "in-process load floor",
          masteryEstimate: 0.75,
        },
      };
    },
  };
}

/**
 * Drive C workers across M subjects; each round sync then turn (same subject).
 */
export async function runConcurrentSubjectLoad(opts = {}) {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const subjectCount = opts.subjectCount ?? DEFAULT_SUBJECT_COUNT;
  const roundsPerWorker = opts.roundsPerWorker ?? DEFAULT_ROUNDS_PER_WORKER;
  const warmupRounds = opts.warmupRounds ?? 2;
  const client = opts.client;
  const deviceIdPrefix = opts.deviceIdPrefix ?? "edge-load";
  const subjectIds =
    opts.subjectIds ?? buildLoadSubjectIds(subjectCount, opts.subjectPrefix ?? "subj-load");

  if (!client || typeof client.postSync !== "function" || typeof client.postAgentTurn !== "function") {
    const err = new Error("runConcurrentSubjectLoad requires client with postSync/postAgentTurn");
    err.failureClass = "validation_failed";
    throw err;
  }
  if (concurrency < 1 || concurrency > 64) {
    const err = new Error("concurrency must be 1..64");
    err.failureClass = "validation_failed";
    throw err;
  }

  const syncLatencies = [];
  const turnLatencies = [];
  const errors = [];
  const subjectsTouched = new Set();

  async function workerRound(workerId, roundIndex, isWarmup) {
    const subjectId = subjectIds[(workerId + roundIndex) % subjectIds.length];
    const deviceId = `${deviceIdPrefix}-${String(workerId).padStart(2, "0")}`;
    subjectsTouched.add(subjectId);

    const syncReq = buildSyncRequest(subjectId, deviceId, opts.syncSampleCount ?? LOAD_SYNC_SAMPLE_COUNT);
    const syncRes = await client.postSync(syncReq);
    if (!syncRes.ok) {
      errors.push({
        op: "sync",
        subjectId,
        deviceId,
        failureClass: syncRes.failureClass ?? "sync_failed",
        warmup: isWarmup,
      });
    } else if (!isWarmup) {
      syncLatencies.push(syncRes.elapsedMs);
    }

    const turnReq = buildAgentTurnRequest(subjectId, deviceId);
    const turnRes = await client.postAgentTurn(turnReq);
    if (!turnRes.ok) {
      errors.push({
        op: "turn",
        subjectId,
        deviceId,
        failureClass: turnRes.failureClass ?? "turn_failed",
        warmup: isWarmup,
      });
    } else if (!isWarmup) {
      turnLatencies.push(turnRes.elapsedMs);
    }

    return { subjectId, deviceId, syncOk: syncRes.ok, turnOk: turnRes.ok };
  }

  async function runWorker(workerId) {
    for (let r = 0; r < warmupRounds; r++) {
      await workerRound(workerId, r, true);
    }
    for (let r = 0; r < roundsPerWorker; r++) {
      await workerRound(workerId, r + warmupRounds, false);
    }
  }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => runWorker(i)));
  const totalElapsedMs = performance.now() - t0;

  const measuredErrors = errors.filter((e) => !e.warmup);
  const totalOps = syncLatencies.length + turnLatencies.length;
  const errorRate =
    totalOps + measuredErrors.length === 0
      ? 0
      : measuredErrors.length / (totalOps + measuredErrors.length);

  return {
    path: client.path ?? "unknown",
    concurrency,
    subjectCount: subjectIds.length,
    subjectsTouched: [...subjectsTouched].sort(),
    roundsPerWorker,
    warmupRounds,
    totalElapsedMs,
    sync: summarizeLatencies(syncLatencies),
    turn: summarizeLatencies(turnLatencies),
    errorCount: measuredErrors.length,
    errorRate,
    errors: measuredErrors,
  };
}

/** Gate: p95 latencies within budget; error rate at or below ceiling. */
export function evaluateConcurrentLoadGate(result, opts = {}) {
  const turnBudget = opts.turnP95Ms ?? NFR04_TURN_P95_MS;
  const syncBudget = opts.syncP95Ms ?? LOAD_SYNC_P95_MS;
  const maxErrorRate = opts.maxErrorRate ?? LOAD_MAX_ERROR_RATE;
  const nfrTurn = opts.nfrTurnId ?? "NFR-04";
  const nfrSync = opts.nfrSyncId ?? "NFR-03";

  const breaches = [];

  if (result.errorRate > maxErrorRate) {
    breaches.push({
      ok: false,
      failureClass: "error_rate_breach",
      metric: "error_rate",
      measured: result.errorRate,
      budget: maxErrorRate,
      nfrId: null,
    });
  }

  if (Number.isFinite(result.turn.p95) && result.turn.p95 > turnBudget) {
    breaches.push({
      ok: false,
      failureClass: "p95_breach",
      metric: "turn_p95",
      measuredP95: result.turn.p95,
      budgetP95: turnBudget,
      nfrId: nfrTurn,
      headroomPercent: ((turnBudget - result.turn.p95) / turnBudget) * 100,
    });
  }

  if (Number.isFinite(result.sync.p95) && result.sync.p95 > syncBudget) {
    breaches.push({
      ok: false,
      failureClass: "p95_breach",
      metric: "sync_p95",
      measuredP95: result.sync.p95,
      budgetP95: syncBudget,
      nfrId: nfrSync,
      headroomPercent: ((syncBudget - result.sync.p95) / syncBudget) * 100,
    });
  }

  if (breaches.length === 0) {
    return {
      ok: true,
      turnBudget,
      syncBudget,
      maxErrorRate,
      measuredTurnP95: result.turn.p95,
      measuredSyncP95: result.sync.p95,
      measuredErrorRate: result.errorRate,
    };
  }

  return {
    ok: false,
    failureClass: breaches[0].failureClass,
    breaches,
    turnBudget,
    syncBudget,
    maxErrorRate,
    measuredTurnP95: result.turn.p95,
    measuredSyncP95: result.sync.p95,
    measuredErrorRate: result.errorRate,
  };
}

export function formatConcurrentLoadGateReport(gate, result) {
  const lines = ["---- concurrent load gate ----"];
  lines.push(
    `path=${result.path} concurrency=${result.concurrency} subjects=${result.subjectCount}`,
  );
  lines.push(
    `sync  p95=${result.sync.p95.toFixed(3)}ms budget=${gate.syncBudget}ms errors=${result.errorCount}`,
  );
  lines.push(
    `turn  p95=${result.turn.p95.toFixed(3)}ms budget=${gate.turnBudget}ms error_rate=${(result.errorRate * 100).toFixed(2)}%`,
  );
  if (!gate.ok) {
    lines.push("FAIL");
    for (const b of gate.breaches ?? []) {
      if (b.failureClass === "error_rate_breach") {
        lines.push(`  error_rate measured=${b.measured} budget=${b.budget}`);
      } else {
        lines.push(
          `  ${b.metric} measured_p95=${b.measuredP95?.toFixed(3)}ms budget_p95=${b.budgetP95}ms nfr=${b.nfrId}`,
        );
      }
    }
  } else {
    lines.push("PASS");
  }
  lines.push("-----------------------------");
  return `${lines.join("\n")}\n`;
}

export function emitConcurrentLoadTelemetry(event) {
  const { utterance: _u, ...safe } = event;
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.concurrent_load", ...safe })}\n`,
  );
}
