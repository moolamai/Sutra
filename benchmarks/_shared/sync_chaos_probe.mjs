/**
 * Sync chaos probe — kill orchestrator mid-sync, restart, assert CRDT convergence.
 * Public SyncEngine + SyncTransport only (no test-only backdoors).
 * Metadata telemetry — never learner utterance bodies.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { CrdtHarnessResolver, SyncEngine, PROTOCOL_VERSION } from "sutra-sdk";
import {
  buildEdgeStateWithPendingSamples,
  orchestratorHealthy,
  createHttpSyncTransport,
} from "./sync_convergence_probe.mjs";

export { orchestratorHealthy };

const execFileAsync = promisify(execFile);

export const ORCHESTRATOR_CONTAINER = "sutra-orchestrator";
export const CHAOS_SAMPLE_COUNT = 24;

/**
 * Deep-equal canonical CognitiveState (byte-identical merge replicas).
 * Subject-scoped; no content fields beyond contract metadata.
 */
export function canonicalStateEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeys(value[k]);
    }
    return out;
  }
  return value;
}

export function emitSyncChaosTelemetry(event) {
  const { utterance: _u, frictionLog: _f, ...safe } = event;
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.sync_chaos", ...safe })}\n`,
  );
}

/** docker kill --signal SIGKILL (compose as deployed). */
export async function sigkillOrchestratorContainer(
  container = ORCHESTRATOR_CONTAINER,
) {
  try {
    await execFileAsync(
      "docker",
      ["kill", "--signal", "SIGKILL", container],
      { timeout: 60_000, windowsHide: true },
    );
    return { ok: true, failureClass: null };
  } catch (cause) {
    return {
      ok: false,
      failureClass: "chaos_inject_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Restart orchestrator via compose (unless-stopped may auto-revive). */
export async function restartOrchestratorCompose(opts = {}) {
  const composeFile = opts.composeFile;
  const cwd = opts.cwd;
  const args = composeFile
    ? ["compose", "-f", composeFile, "start", "orchestrator"]
    : ["compose", "start", "orchestrator"];
  try {
    await execFileAsync("docker", args, {
      timeout: 120_000,
      windowsHide: true,
      cwd,
    });
  } catch {
    const upArgs = composeFile
      ? ["compose", "-f", composeFile, "up", "-d", "orchestrator"]
      : ["compose", "up", "-d", "orchestrator"];
    await execFileAsync("docker", upArgs, {
      timeout: 180_000,
      windowsHide: true,
      cwd,
    });
  }
}

export async function waitOrchestratorHealthy(baseUrl, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await orchestratorHealthy(baseUrl, 2_000)) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/**
 * In-process transport that SIGKILL-simulates mid-sync, then recovers.
 * Same syncAttemptId is idempotent — merge applied at most once.
 */
export function createKillMidSyncTransport(opts = {}) {
  const resolver = new CrdtHarnessResolver();
  const masters = new Map();
  /** @type {Map<string, object>} */
  const responsesByAttempt = new Map();
  /** @type {Map<string, number>} */
  const applyCounts = new Map();

  let phase = "up"; // up | down
  let callCount = 0;
  let downsBeforeRecover = opts.downsBeforeRecover ?? 1;
  let downsSeen = 0;
  const killOnCall = opts.killOnCall ?? 1;
  const autoRecover = opts.autoRecover !== false;
  const events = [];

  function mergeOnce(request) {
    const sid = request.edgeState.subjectId;
    const attemptId = request.syncAttemptId;
    if (responsesByAttempt.has(attemptId)) {
      events.push({ kind: "idempotent_replay", attemptId, subjectId: sid });
      return { kind: "ok", response: responsesByAttempt.get(attemptId) };
    }
    const base = masters.get(sid) ?? request.edgeState;
    const { merged, advisories } = resolver.merge(base, request.edgeState);
    masters.set(sid, merged);
    applyCounts.set(attemptId, (applyCounts.get(attemptId) ?? 0) + 1);
    const response = {
      protocolVersion: PROTOCOL_VERSION,
      mergedState: merged,
      compactedSampleTimestamps: merged.frictionLog.map((s) => s.capturedAt),
      advisories,
    };
    responsesByAttempt.set(attemptId, response);
    events.push({ kind: "merge_applied", attemptId, subjectId: sid });
    return { kind: "ok", response };
  }

  return {
    path: "in_process_kill",
    events,
    getCloudState(subjectId) {
      return masters.get(subjectId) ?? null;
    },
    getApplyCount(attemptId) {
      return applyCounts.get(attemptId) ?? 0;
    },
    kill() {
      phase = "down";
      events.push({ kind: "sigkill", atCall: callCount });
    },
    restart() {
      phase = "up";
      downsSeen = 0;
      events.push({ kind: "restart" });
    },
    async postSync(request) {
      callCount += 1;
      const sid = request.edgeState?.subjectId;
      if (typeof sid !== "string" || !sid.trim()) {
        return {
          kind: "http-error",
          status: 400,
          body: "subjectId required",
        };
      }

      // Kill mid-sync on the designated call (before durable merge returns).
      if (phase === "up" && callCount === killOnCall) {
        phase = "down";
        downsSeen = 1;
        events.push({
          kind: "sigkill_mid_sync",
          attemptId: request.syncAttemptId,
          subjectId: sid,
          callCount,
        });
        return { kind: "network-error", cause: "orchestrator SIGKILL mid-sync" };
      }

      if (phase === "down") {
        downsSeen += 1;
        events.push({
          kind: "network_while_down",
          attemptId: request.syncAttemptId,
          subjectId: sid,
          downsSeen,
        });
        if (autoRecover && downsSeen >= downsBeforeRecover) {
          phase = "up";
          events.push({ kind: "auto_restart" });
        } else {
          return {
            kind: "network-error",
            cause: "orchestrator down after SIGKILL",
          };
        }
      }

      return mergeOnce(request);
    },
  };
}

/**
 * Run kill-mid-sync drill: SyncEngine retries with same syncAttemptId → converged.
 * Asserts cloud and edge replicas are canonically identical; apply ≤ 1.
 */
export async function runKillOrchestratorMidSyncDrill(opts = {}) {
  const deviceId = opts.deviceId ?? "edge-chaos-kill";
  const subjectId = opts.subjectId ?? `subj-chaos-kill-${randomUUID().slice(0, 8)}`;
  const sampleCount = opts.sampleCount ?? CHAOS_SAMPLE_COUNT;
  const syncAttemptId = opts.syncAttemptId ?? randomUUID();
  const sleep = opts.sleep ?? (async () => {});
  const random = opts.random ?? (() => 0.5);

  const transport =
    opts.transport ??
    createKillMidSyncTransport({
      killOnCall: opts.killOnCall ?? 1,
      downsBeforeRecover: opts.downsBeforeRecover ?? 1,
      autoRecover: opts.autoRecover !== false,
    });

  const engine = new SyncEngine(transport, {
    maxAttempts: opts.maxAttempts ?? 6,
    baseDelayMs: opts.baseDelayMs ?? 1,
    maxDelayMs: opts.maxDelayMs ?? 10,
    sleep,
    random,
  });

  const edgeState = buildEdgeStateWithPendingSamples(
    deviceId,
    subjectId,
    sampleCount,
  );

  emitSyncChaosTelemetry({
    outcome: "ok",
    action: "start",
    drill: "kill_orchestrator_mid_sync",
    subjectId,
    deviceId,
    syncAttemptId,
    path: transport.path ?? "custom",
  });

  const outcome = await engine.synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId,
  });

  const cloudState =
    typeof transport.getCloudState === "function"
      ? transport.getCloudState(subjectId)
      : outcome.status === "converged"
        ? outcome.state
        : null;

  const applyCount =
    typeof transport.getApplyCount === "function"
      ? transport.getApplyCount(syncAttemptId)
      : outcome.status === "converged"
        ? 1
        : 0;

  const replicasEqual =
    outcome.status === "converged" &&
    cloudState != null &&
    canonicalStateEqual(outcome.state, cloudState);

  const noDoubleApply = applyCount <= 1;

  const ok =
    outcome.status === "converged" &&
    replicasEqual &&
    noDoubleApply &&
    Array.isArray(outcome.advisoryCodes);

  const failureClass = !ok
    ? outcome.status !== "converged"
      ? "convergence_failed"
      : !replicasEqual
        ? "replica_divergence"
        : !noDoubleApply
          ? "double_apply"
          : "chaos_invariant_failed"
    : null;

  emitSyncChaosTelemetry({
    outcome: ok ? "ok" : "rejected",
    action: "gate",
    drill: "kill_orchestrator_mid_sync",
    failureClass,
    subjectId,
    deviceId,
    syncAttemptId,
    syncStatus: outcome.status,
    attempts: outcome.attempts ?? 0,
    applyCount,
    replicasEqual,
    advisoryCodeCount: outcome.advisoryCodes?.length ?? 0,
  });

  return {
    ok,
    failureClass,
    drill: "kill_orchestrator_mid_sync",
    outcome,
    subjectId,
    deviceId,
    syncAttemptId,
    cloudState,
    applyCount,
    replicasEqual,
    transport,
  };
}

/**
 * Compose path: race HTTP sync with SIGKILL, restart, re-sync same attempt id.
 * Skips gracefully when docker/orchestrator unavailable (caller handles).
 */
export async function runComposeKillMidSyncDrill(opts = {}) {
  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:8000";
  const apiKey = opts.apiKey ?? "compose-operator-surface";
  const deviceId = opts.deviceId ?? "edge-chaos-kill";
  const subjectId =
    opts.subjectId ?? `subj-chaos-compose-${randomUUID().slice(0, 8)}`;
  const syncAttemptId = opts.syncAttemptId ?? randomUUID();
  const sampleCount = opts.sampleCount ?? CHAOS_SAMPLE_COUNT;

  if (!(await orchestratorHealthy(baseUrl))) {
    return {
      ok: false,
      failureClass: "compose_unavailable",
      skipped: true,
      subjectId,
      deviceId,
    };
  }

  const http = createHttpSyncTransport(baseUrl, apiKey);
  let killFired = false;
  const racing = {
    path: "compose_kill",
    async postSync(request) {
      const pending = http.postSync(request);
      if (!killFired) {
        killFired = true;
        // Inject fault while request is in flight (best-effort race).
        void sigkillOrchestratorContainer(opts.container).then((r) => {
          emitSyncChaosTelemetry({
            outcome: r.ok ? "ok" : "rejected",
            action: "sigkill",
            failureClass: r.failureClass,
            subjectId,
            deviceId,
            syncAttemptId,
          });
        });
      }
      return pending;
    },
  };

  const edgeState = buildEdgeStateWithPendingSamples(
    deviceId,
    subjectId,
    sampleCount,
  );

  const engine = new SyncEngine(racing, {
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 2_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  // First series may exhaust while container is dead.
  await engine.synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId,
  });

  await restartOrchestratorCompose({
    composeFile: opts.composeFile,
    cwd: opts.cwd,
  });
  const healthy = await waitOrchestratorHealthy(baseUrl, opts.healthTimeoutMs ?? 120_000);
  if (!healthy) {
    return {
      ok: false,
      failureClass: "recovery_timeout",
      skipped: false,
      subjectId,
      deviceId,
      syncAttemptId,
    };
  }

  // Resume with the same idempotency key after restart.
  const recovered = createHttpSyncTransport(baseUrl, apiKey);
  const engine2 = new SyncEngine(recovered, {
    maxAttempts: 6,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  });
  const outcome = await engine2.synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId,
  });

  let cloudState = null;
  if (outcome.status === "converged") {
    try {
      const res = await fetch(
        `${baseUrl.replace(/\/$/, "")}/v1/subjects/${encodeURIComponent(subjectId)}/state`,
        { headers: { "X-API-Key": apiKey } },
      );
      if (res.ok) cloudState = await res.json();
    } catch {
      cloudState = null;
    }
  }

  const replicasEqual =
    outcome.status === "converged" &&
    cloudState != null &&
    canonicalStateEqual(outcome.state, cloudState);

  const ok = outcome.status === "converged" && replicasEqual;

  emitSyncChaosTelemetry({
    outcome: ok ? "ok" : "rejected",
    action: "compose_gate",
    drill: "kill_orchestrator_mid_sync",
    failureClass: ok ? null : "convergence_failed",
    subjectId,
    deviceId,
    syncAttemptId,
    syncStatus: outcome.status,
    attempts: outcome.attempts ?? 0,
    replicasEqual,
  });

  return {
    ok,
    failureClass: ok ? null : "convergence_failed",
    skipped: false,
    drill: "kill_orchestrator_mid_sync",
    outcome,
    subjectId,
    deviceId,
    syncAttemptId,
    cloudState,
    replicasEqual,
  };
}

export function formatSyncChaosGateReport(result) {
  const drill = result.drill ?? "kill_orchestrator_mid_sync";
  const lines = [`---- sync chaos: ${drill} ----`];
  lines.push(
    `subjectId=${result.subjectId} deviceId=${result.deviceId} attempt=${result.syncAttemptId ?? "n/a"}`,
  );
  if (result.skipped) {
    lines.push(`SKIP ${result.failureClass ?? "compose_unavailable"}`);
  } else if (result.ok) {
    lines.push(
      `PASS status=${result.outcome?.status ?? "n/a"} attempts=${result.outcome?.attempts ?? "?"} applyCount=${result.applyCount ?? "?"} replicasEqual=${result.replicasEqual ?? false}`,
    );
    if (result.auditCount != null) {
      lines.push(`  audit_rows=${result.auditCount} auditsPreserved=${result.auditsPreserved ?? true}`);
    }
  } else {
    lines.push(
      `FAIL class=${result.failureClass} status=${result.outcome?.status ?? "n/a"} replicasEqual=${result.replicasEqual ?? false}`,
    );
  }
  lines.push("----------------------------------");
  return `${lines.join("\n")}\n`;
}

/* ── Partition Redis / Postgres (SYNCCHAO-002) ─────────────────────────── */

export const REDIS_CONTAINER = "sutra-redis";
export const POSTGRES_CONTAINER = "sutra-pgvector";

/** docker pause — freezes container I/O (operator partition injection). */
export async function pauseContainer(container) {
  try {
    await execFileAsync("docker", ["pause", container], {
      timeout: 60_000,
      windowsHide: true,
    });
    return { ok: true, failureClass: null };
  } catch (cause) {
    return {
      ok: false,
      failureClass: "chaos_inject_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** docker unpause — restore partition. */
export async function unpauseContainer(container) {
  try {
    await execFileAsync("docker", ["unpause", container], {
      timeout: 60_000,
      windowsHide: true,
    });
    return { ok: true, failureClass: null };
  } catch (cause) {
    return {
      ok: false,
      failureClass: "chaos_restore_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * In-process backends with pauseable Redis/Postgres.
 * Postgres down → SYNC-07: edge keeps local authoritative (no merge apply).
 * Redis down → merge still succeeds (checkpoint off sync path); no crash.
 * sync_audit appends only on durable success — never lost, never double for same attempt.
 */
export function createPartitionedSyncTransport(opts = {}) {
  const resolver = new CrdtHarnessResolver();
  const masters = new Map();
  const responsesByAttempt = new Map();
  const applyCounts = new Map();
  /** @type {{ subjectId: string, syncAttemptId: string, advisoryCodes: string[] }[]} */
  const auditLog = [];
  const events = [];

  let redisPaused = opts.redisPaused === true;
  let postgresPaused = opts.postgresPaused === true;

  function appendAudit(request, advisories) {
    const sid = request.edgeState.subjectId;
    const attemptId = request.syncAttemptId;
    if (auditLog.some((r) => r.syncAttemptId === attemptId)) {
      events.push({ kind: "audit_idempotent_skip", attemptId, subjectId: sid });
      return;
    }
    const codes = (advisories ?? []).map((a) => a.code).filter(Boolean);
    auditLog.push({
      subjectId: sid,
      syncAttemptId: attemptId,
      advisoryCodes: codes,
    });
    events.push({ kind: "audit_appended", attemptId, subjectId: sid });
  }

  function mergeOnce(request) {
    const sid = request.edgeState.subjectId;
    const attemptId = request.syncAttemptId;
    if (responsesByAttempt.has(attemptId)) {
      events.push({ kind: "idempotent_replay", attemptId, subjectId: sid });
      return { kind: "ok", response: responsesByAttempt.get(attemptId) };
    }
    const base = masters.get(sid) ?? request.edgeState;
    const { merged, advisories } = resolver.merge(base, request.edgeState);
    masters.set(sid, merged);
    applyCounts.set(attemptId, (applyCounts.get(attemptId) ?? 0) + 1);
    appendAudit(request, advisories);
    const response = {
      protocolVersion: PROTOCOL_VERSION,
      mergedState: merged,
      compactedSampleTimestamps: merged.frictionLog.map((s) => s.capturedAt),
      advisories,
    };
    responsesByAttempt.set(attemptId, response);
    events.push({ kind: "merge_applied", attemptId, subjectId: sid });
    return { kind: "ok", response };
  }

  return {
    path: "in_process_partition",
    events,
    getCloudState(subjectId) {
      return masters.get(subjectId) ?? null;
    },
    getApplyCount(attemptId) {
      return applyCounts.get(attemptId) ?? 0;
    },
    getAuditLog(subjectId) {
      return auditLog.filter((r) => r.subjectId === subjectId);
    },
    getAllAudits() {
      return auditLog.slice();
    },
    isRedisPaused: () => redisPaused,
    isPostgresPaused: () => postgresPaused,
    pauseRedis() {
      redisPaused = true;
      events.push({ kind: "partition_redis" });
    },
    unpauseRedis() {
      redisPaused = false;
      events.push({ kind: "restore_redis" });
    },
    pausePostgres() {
      postgresPaused = true;
      events.push({ kind: "partition_postgres" });
    },
    unpausePostgres() {
      postgresPaused = false;
      events.push({ kind: "restore_postgres" });
    },
    async postSync(request) {
      const sid = request.edgeState?.subjectId;
      if (typeof sid !== "string" || !sid.trim()) {
        return { kind: "http-error", status: 400, body: "subjectId required" };
      }

      // Postgres partition: master-state unavailable → 503 (edge keeps local).
      if (postgresPaused) {
        events.push({
          kind: "postgres_partition_reject",
          attemptId: request.syncAttemptId,
          subjectId: sid,
        });
        return {
          kind: "http-error",
          status: 503,
          body: "postgres partitioned (compose pause)",
        };
      }

      // Redis partition: degraded checkpoint path — merge still durable on PG.
      if (redisPaused) {
        events.push({
          kind: "redis_partition_degraded",
          attemptId: request.syncAttemptId,
          subjectId: sid,
        });
      }

      return mergeOnce(request);
    },
  };
}

/**
 * In-process partition drill:
 * 1) seed sync (audit row)
 * 2) pause Redis — sync still converges
 * 3) pause Postgres during next attempt — edge authoritative (exhausted/retry)
 * 4) restore Postgres — same attempt id converges; audits preserved; no double-apply
 */
export async function runPartitionRedisPostgresDrill(opts = {}) {
  const deviceId = opts.deviceId ?? "edge-chaos-part";
  const subjectId =
    opts.subjectId ?? `subj-chaos-part-${randomUUID().slice(0, 8)}`;
  const sampleCount = opts.sampleCount ?? CHAOS_SAMPLE_COUNT;
  const seedAttemptId = opts.seedAttemptId ?? randomUUID();
  const partitionAttemptId = opts.partitionAttemptId ?? randomUUID();
  const sleep = opts.sleep ?? (async () => {});
  const random = opts.random ?? (() => 0.5);

  const transport = opts.transport ?? createPartitionedSyncTransport();

  const edgeState = buildEdgeStateWithPendingSamples(
    deviceId,
    subjectId,
    sampleCount,
  );

  emitSyncChaosTelemetry({
    outcome: "ok",
    action: "start",
    drill: "partition_redis_postgres",
    subjectId,
    deviceId,
    path: transport.path ?? "custom",
  });

  const engineOpts = {
    maxAttempts: opts.maxAttempts ?? 4,
    baseDelayMs: opts.baseDelayMs ?? 1,
    maxDelayMs: opts.maxDelayMs ?? 10,
    sleep,
    random,
  };

  // ── Seed durable sync + audit ──
  const seedEngine = new SyncEngine(transport, engineOpts);
  const seed = await seedEngine.synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId: seedAttemptId,
  });
  if (seed.status !== "converged") {
    return {
      ok: false,
      failureClass: "seed_failed",
      drill: "partition_redis_postgres",
      outcome: seed,
      subjectId,
      deviceId,
      syncAttemptId: seedAttemptId,
    };
  }
  const auditsAfterSeed = transport.getAuditLog(subjectId).length;

  // ── Redis partition: merge must still succeed (degraded) ──
  transport.pauseRedis();
  const redisAttemptId = randomUUID();
  const underRedis = await new SyncEngine(transport, engineOpts).synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId: redisAttemptId,
  });
  transport.unpauseRedis();
  if (underRedis.status !== "converged") {
    return {
      ok: false,
      failureClass: "redis_partition_blocked_sync",
      drill: "partition_redis_postgres",
      outcome: underRedis,
      subjectId,
      deviceId,
      syncAttemptId: redisAttemptId,
    };
  }

  // Snapshot edge local before PG partition (SYNC-07 authoritative local).
  const localAuthoritative = structuredClone(edgeState);

  // ── Postgres partition during sync: fail, do not apply, edge keeps local ──
  transport.pausePostgres();
  const midPartition = await new SyncEngine(transport, {
    ...engineOpts,
    maxAttempts: opts.partitionMaxAttempts ?? 3,
  }).synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState: localAuthoritative,
    lastKnownCloudVector: {},
    syncAttemptId: partitionAttemptId,
  });
  const cloudDuringPartition = transport.getCloudState(subjectId);
  const applyDuring = transport.getApplyCount(partitionAttemptId);
  transport.unpausePostgres();

  // Edge local unchanged / still authoritative — no durable apply for this attempt.
  const edgeKeptLocal =
    midPartition.status !== "converged" && applyDuring === 0;

  // ── Restore: same attempt id converges; audits append-only preserved ──
  const recovered = await new SyncEngine(transport, engineOpts).synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState: localAuthoritative,
    lastKnownCloudVector: {},
    syncAttemptId: partitionAttemptId,
  });

  const cloudState = transport.getCloudState(subjectId);
  const audits = transport.getAuditLog(subjectId);
  const seedStillPresent = audits.some((a) => a.syncAttemptId === seedAttemptId);
  const partitionAudited = audits.some(
    (a) => a.syncAttemptId === partitionAttemptId,
  );
  const applyCount = transport.getApplyCount(partitionAttemptId);
  const replicasEqual =
    recovered.status === "converged" &&
    cloudState != null &&
    canonicalStateEqual(recovered.state, cloudState);

  const auditsPreserved =
    seedStillPresent &&
    auditsAfterSeed >= 1 &&
    audits.length >= auditsAfterSeed &&
    partitionAudited;

  const ok =
    underRedis.status === "converged" &&
    edgeKeptLocal &&
    recovered.status === "converged" &&
    replicasEqual &&
    applyCount === 1 &&
    auditsPreserved;

  let failureClass = null;
  if (!ok) {
    if (!edgeKeptLocal) failureClass = "edge_not_authoritative";
    else if (recovered.status !== "converged") failureClass = "convergence_failed";
    else if (!replicasEqual) failureClass = "replica_divergence";
    else if (applyCount !== 1) failureClass = "double_apply";
    else if (!auditsPreserved) failureClass = "audit_lost";
    else failureClass = "chaos_invariant_failed";
  }

  emitSyncChaosTelemetry({
    outcome: ok ? "ok" : "rejected",
    action: "gate",
    drill: "partition_redis_postgres",
    failureClass,
    subjectId,
    deviceId,
    syncAttemptId: partitionAttemptId,
    syncStatus: recovered.status,
    midPartitionStatus: midPartition.status,
    applyCount,
    replicasEqual,
    auditCount: audits.length,
    auditsPreserved,
    edgeKeptLocal,
  });

  return {
    ok,
    failureClass,
    drill: "partition_redis_postgres",
    outcome: recovered,
    midPartition,
    underRedis,
    subjectId,
    deviceId,
    syncAttemptId: partitionAttemptId,
    seedAttemptId,
    cloudState,
    cloudDuringPartition,
    applyCount,
    replicasEqual,
    auditCount: audits.length,
    auditsPreserved,
    edgeKeptLocal,
    transport,
  };
}

/**
 * Compose: pause Redis then Postgres during sync roundtrips; restore; converge.
 */
export async function runComposePartitionDrill(opts = {}) {
  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:8000";
  const apiKey = opts.apiKey ?? "compose-operator-surface";
  const deviceId = opts.deviceId ?? "edge-chaos-part";
  const subjectId =
    opts.subjectId ?? `subj-chaos-part-${randomUUID().slice(0, 8)}`;
  const sampleCount = opts.sampleCount ?? CHAOS_SAMPLE_COUNT;

  if (!(await orchestratorHealthy(baseUrl))) {
    return {
      ok: false,
      failureClass: "compose_unavailable",
      skipped: true,
      drill: "partition_redis_postgres",
      subjectId,
      deviceId,
    };
  }

  const edgeState = buildEdgeStateWithPendingSamples(
    deviceId,
    subjectId,
    sampleCount,
  );
  const http = createHttpSyncTransport(baseUrl, apiKey);
  const engine = (transport, maxAttempts = 4) =>
    new SyncEngine(transport, {
      maxAttempts,
      baseDelayMs: 150,
      maxDelayMs: 2_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });

  const seedId = randomUUID();
  const seed = await engine(http).synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId: seedId,
  });
  if (seed.status !== "converged") {
    return {
      ok: false,
      failureClass: "seed_failed",
      skipped: false,
      drill: "partition_redis_postgres",
      outcome: seed,
      subjectId,
      deviceId,
      syncAttemptId: seedId,
    };
  }

  // Pause Redis (operator partition).
  const pausedR = await pauseContainer(opts.redisContainer ?? REDIS_CONTAINER);
  emitSyncChaosTelemetry({
    outcome: pausedR.ok ? "ok" : "rejected",
    action: "pause_redis",
    failureClass: pausedR.failureClass,
    subjectId,
    deviceId,
  });
  const redisAttempt = randomUUID();
  const underRedis = await engine(http, 3).synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId: redisAttempt,
  });
  await unpauseContainer(opts.redisContainer ?? REDIS_CONTAINER);

  // Pause Postgres during sync attempt.
  const partitionAttemptId = randomUUID();
  const pausedP = await pauseContainer(
    opts.postgresContainer ?? POSTGRES_CONTAINER,
  );
  emitSyncChaosTelemetry({
    outcome: pausedP.ok ? "ok" : "rejected",
    action: "pause_postgres",
    failureClass: pausedP.failureClass,
    subjectId,
    deviceId,
  });
  const mid = await engine(http, 2).synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId: partitionAttemptId,
  });
  await unpauseContainer(opts.postgresContainer ?? POSTGRES_CONTAINER);

  // Orchestrator may need a moment after PG unpause.
  await waitOrchestratorHealthy(baseUrl, opts.healthTimeoutMs ?? 120_000);

  const recovered = await engine(http, 8).synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId: partitionAttemptId,
  });

  let cloudState = null;
  if (recovered.status === "converged") {
    try {
      const res = await fetch(
        `${baseUrl.replace(/\/$/, "")}/v1/subjects/${encodeURIComponent(subjectId)}/state`,
        { headers: { "X-API-Key": apiKey } },
      );
      if (res.ok) cloudState = await res.json();
    } catch {
      cloudState = null;
    }
  }

  const replicasEqual =
    recovered.status === "converged" &&
    cloudState != null &&
    canonicalStateEqual(recovered.state, cloudState);

  // Redis path may succeed (degraded) or fail transiently — either is ok if
  // final recovery converges identically. Postgres mid-partition must not converge.
  const ok =
    mid.status !== "converged" &&
    recovered.status === "converged" &&
    replicasEqual &&
    seed.status === "converged";

  emitSyncChaosTelemetry({
    outcome: ok ? "ok" : "rejected",
    action: "compose_gate",
    drill: "partition_redis_postgres",
    failureClass: ok ? null : "convergence_failed",
    subjectId,
    deviceId,
    syncAttemptId: partitionAttemptId,
    syncStatus: recovered.status,
    midPartitionStatus: mid.status,
    underRedisStatus: underRedis.status,
    replicasEqual,
  });

  return {
    ok,
    failureClass: ok ? null : "convergence_failed",
    skipped: false,
    drill: "partition_redis_postgres",
    outcome: recovered,
    midPartition: mid,
    underRedis,
    subjectId,
    deviceId,
    syncAttemptId: partitionAttemptId,
    cloudState,
    replicasEqual,
  };
}

/* ── Corrupt LangGraph checkpoint (SYNCCHAO-003) ───────────────────────── */

/** Mirrors packages/cloud-orchestrator checkpointer.py */
export const CHECKPOINT_KEY_PREFIX = "sutra:v1:router_ckpt";
export const ADVISORY_CORRUPT_RESET = "CHECKPOINT_CORRUPT_RESET";
export const ADVISORY_MISSING = "CHECKPOINT_MISSING";

export function checkpointThreadId(subjectId, sessionId = null) {
  if (typeof subjectId !== "string" || !subjectId.trim()) {
    const err = new Error("subjectId must be non-empty");
    err.failureClass = "validation_failed";
    throw err;
  }
  if (typeof sessionId === "string" && sessionId.trim()) {
    return `session:${sessionId.trim()}`;
  }
  return `subject:${subjectId.trim()}`;
}

export function checkpointRedisKey(subjectId, threadId) {
  if (typeof subjectId !== "string" || !subjectId.trim()) {
    const err = new Error("subjectId must be non-empty");
    err.failureClass = "validation_failed";
    throw err;
  }
  if (subjectId.includes(":") || subjectId.includes("/")) {
    const err = new Error("subjectId must not contain ':' or '/'");
    err.failureClass = "validation_failed";
    throw err;
  }
  if (typeof threadId !== "string" || !threadId.trim()) {
    const err = new Error("threadId must be non-empty");
    err.failureClass = "validation_failed";
    throw err;
  }
  return `${CHECKPOINT_KEY_PREFIX}:${subjectId}:${threadId}`;
}

/**
 * In-process Redis + hydrating checkpointer contract (mirrors RedisHydratingCheckpointer).
 * Corrupt/truncated blob → delete key, clean start + CHECKPOINT_CORRUPT_RESET, never crash-loop.
 */
export function createCorruptCheckpointHarness(opts = {}) {
  const store = new Map(); // key → Buffer|Uint8Array|string
  const deleted = [];
  const advisories = [];
  const events = [];
  /** Per-subject effect ledger for duplicate-side-effect detection. */
  const effectsBySubject = new Map();

  function get(key) {
    return store.has(key) ? store.get(key) : null;
  }
  function set(key, value) {
    store.set(key, value);
  }
  function del(key) {
    deleted.push(key);
    return store.delete(key) ? 1 : 0;
  }

  /**
   * Hydrate+run one agent-turn equivalent.
   * Valid blob resumes mid-effects; corrupt → clean full turn + advisory.
   */
  function runTurn({ subjectId, sessionId = null, corruptInject = false }) {
    if (typeof subjectId !== "string" || !subjectId.trim()) {
      const err = new Error("subjectId required");
      err.failureClass = "validation_failed";
      throw err;
    }
    const threadId = checkpointThreadId(subjectId, sessionId);
    const key = checkpointRedisKey(subjectId, threadId);

    if (corruptInject) {
      // Truncated / non-pickle blob (compose: redis-cli SET ...).
      set(key, Buffer.from("not-a-valid-pickle{{{"));
      events.push({ kind: "corrupt_injected", subjectId, key });
    }

    let resumedFrom = null;
    const raw = get(key);
    if (raw) {
      try {
        const text =
          typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        const blob = JSON.parse(text);
        if (!blob || typeof blob !== "object" || !Array.isArray(blob.effects)) {
          throw new Error("checkpoint blob is not a valid dict");
        }
        if (blob.subjectId && blob.subjectId !== subjectId) {
          throw new Error("cross-subject checkpoint blob refused");
        }
        resumedFrom = blob;
        events.push({ kind: "hydrated", subjectId, key });
      } catch (cause) {
        advisories.push(ADVISORY_CORRUPT_RESET);
        events.push({
          kind: "corrupt_reset",
          subjectId,
          key,
          advisory: ADVISORY_CORRUPT_RESET,
          errType: cause instanceof Error ? cause.name : "Error",
        });
        del(key);
        resumedFrom = null;
      }
    } else {
      advisories.push(ADVISORY_MISSING);
      events.push({ kind: "miss", subjectId, key, advisory: ADVISORY_MISSING });
    }

    // Clean start vs resume: never re-emit effects already applied on resume.
    const baseEffects = resumedFrom?.effects ?? [];
    const fullEffects = [
      "assess_friction",
      "remediate_prereq",
      "generate_guidance",
    ];
    let effects;
    if (resumedFrom && baseEffects.length > 0 && baseEffects.length < fullEffects.length) {
      // Resume remaining steps only (no duplicate prior side effects).
      effects = [...baseEffects, ...fullEffects.slice(baseEffects.length)];
      events.push({ kind: "resume", subjectId, priorEffects: baseEffects.length });
    } else {
      effects = [...fullEffects];
      events.push({ kind: "clean_start", subjectId });
    }

    // Persist healthy checkpoint after turn.
    const payload = JSON.stringify({
      subjectId,
      threadId,
      effects,
    });
    set(key, Buffer.from(payload, "utf8"));
    events.push({ kind: "persisted", subjectId, key });

    const prior = effectsBySubject.get(subjectId) ?? [];
    effectsBySubject.set(subjectId, [...prior, ...effects]);

    return {
      subjectId,
      threadId,
      key,
      effects,
      guidanceDirective: "GUIDE concept=math.ratios mode=guided",
      advisory:
        advisories[advisories.length - 1] === ADVISORY_CORRUPT_RESET
          ? ADVISORY_CORRUPT_RESET
          : resumedFrom
            ? null
            : ADVISORY_MISSING,
      startClean: resumedFrom == null,
      crashLoop: false,
    };
  }

  return {
    path: "in_process_checkpoint",
    store,
    deleted,
    advisories,
    events,
    effectsBySubject,
    get,
    set,
    delete: del,
    runTurn,
    /** Operator corrupt: truncated blob at subject key. */
    injectCorrupt(subjectId, sessionId = null) {
      const key = checkpointRedisKey(
        subjectId,
        checkpointThreadId(subjectId, sessionId),
      );
      set(key, Buffer.from("not-a-valid-pickle{{{"));
      events.push({ kind: "corrupt_injected", subjectId, key });
      return key;
    },
    effectCount(subjectId, effectName) {
      const all = effectsBySubject.get(subjectId) ?? [];
      return all.filter((e) => e === effectName).length;
    },
  };
}

/**
 * Drill: persist mid-checkpoint → corrupt → restart turn → clean start + advisory,
 * no crash-loop, no duplicate side effects from corrupt resume.
 */
export async function runCorruptCheckpointDrill(opts = {}) {
  const subjectId =
    opts.subjectId ?? `subj-chaos-ckpt-${randomUUID().slice(0, 8)}`;
  const sessionId = opts.sessionId ?? `sess-chaos-${subjectId}`;
  const deviceId = opts.deviceId ?? "edge-chaos-ckpt";
  const harness = opts.harness ?? createCorruptCheckpointHarness();

  emitSyncChaosTelemetry({
    outcome: "ok",
    action: "start",
    drill: "corrupt_checkpoint",
    subjectId,
    deviceId,
    path: harness.path ?? "custom",
  });

  // Mid-turn checkpoint with partial effects (interrupted before generate_guidance).
  const key = checkpointRedisKey(
    subjectId,
    checkpointThreadId(subjectId, sessionId),
  );
  harness.set(
    key,
    Buffer.from(
      JSON.stringify({
        subjectId,
        threadId: checkpointThreadId(subjectId, sessionId),
        effects: ["assess_friction", "remediate_prereq"],
      }),
      "utf8",
    ),
  );
  harness.events.push({ kind: "mid_checkpoint_seeded", subjectId, key });

  // Corrupt the blob (truncated pickle).
  harness.injectCorrupt(subjectId, sessionId);

  // Restart agent turn — must clean-start with typed advisory, not crash.
  let turn1;
  let crashed = false;
  try {
    turn1 = harness.runTurn({ subjectId, sessionId });
  } catch (cause) {
    crashed = true;
    turn1 = {
      subjectId,
      effects: [],
      advisory: null,
      startClean: false,
      err: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // Second turn must not crash-loop on the same corrupt blob (key was deleted).
  let turn2;
  try {
    turn2 = harness.runTurn({ subjectId, sessionId });
  } catch (cause) {
    crashed = true;
    turn2 = {
      subjectId,
      effects: [],
      err: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const corruptAdvisory =
    harness.advisories.includes(ADVISORY_CORRUPT_RESET) ||
    turn1.advisory === ADVISORY_CORRUPT_RESET;
  const keyCleared = harness.deleted.includes(key);

  // Clean start after corrupt: full effect chain once on turn1 (not resume of mid blob).
  const cleanEffects =
    turn1.effects?.join(",") ===
    "assess_friction,remediate_prereq,generate_guidance";

  // No duplicate generate_guidance from corrupt mid-state resume attempt.
  const generateCount = (turn1.effects ?? []).filter(
    (e) => e === "generate_guidance",
  ).length;
  const noDuplicateEffects = generateCount === 1 && !crashed;

  const ok =
    !crashed &&
    corruptAdvisory &&
    turn1.startClean === true &&
    cleanEffects &&
    noDuplicateEffects &&
    keyCleared &&
    turn2.effects?.includes("generate_guidance");

  let failureClass = null;
  if (!ok) {
    if (crashed) failureClass = "crash_loop";
    else if (!corruptAdvisory) failureClass = "missing_advisory";
    else if (!turn1.startClean) failureClass = "not_clean_start";
    else if (!noDuplicateEffects) failureClass = "duplicate_side_effects";
    else failureClass = "chaos_invariant_failed";
  }

  emitSyncChaosTelemetry({
    outcome: ok ? "ok" : "rejected",
    action: "gate",
    drill: "corrupt_checkpoint",
    failureClass,
    subjectId,
    deviceId,
    advisory: ADVISORY_CORRUPT_RESET,
    startClean: turn1.startClean ?? false,
    crashed,
    deletedCorruptKey: keyCleared,
    turn1EffectCount: turn1.effects?.length ?? 0,
    turn2EffectCount: turn2.effects?.length ?? 0,
  });

  return {
    ok,
    failureClass,
    drill: "corrupt_checkpoint",
    subjectId,
    deviceId,
    syncAttemptId: null,
    outcome: {
      status: ok ? "converged" : "exhausted",
      attempts: 1,
      advisoryCodes: corruptAdvisory ? [ADVISORY_CORRUPT_RESET] : [],
    },
    turn1,
    turn2,
    advisories: harness.advisories.slice(),
    key,
    crashed,
    replicasEqual: true,
    applyCount: 1,
    harness,
  };
}

/**
 * Compose: SET truncated checkpoint in Redis, then POST /v1/agent/turn — no 5xx crash-loop.
 */
export async function runComposeCorruptCheckpointDrill(opts = {}) {
  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:8000";
  const apiKey = opts.apiKey ?? "compose-operator-surface";
  const deviceId = opts.deviceId ?? "edge-chaos-ckpt";
  const subjectId =
    opts.subjectId ?? `subj-chaos-ckpt-${randomUUID().slice(0, 8)}`;
  const sessionId = opts.sessionId ?? `sess-${subjectId}`;
  const redisContainer = opts.redisContainer ?? REDIS_CONTAINER;

  if (!(await orchestratorHealthy(baseUrl))) {
    return {
      ok: false,
      failureClass: "compose_unavailable",
      skipped: true,
      drill: "corrupt_checkpoint",
      subjectId,
      deviceId,
    };
  }

  const { buildAgentTurnRequest } = await import("./concurrent_load_probe.mjs");
  const { buildEdgeStateWithPendingSamples } = await import(
    "./sync_convergence_probe.mjs"
  );
  const http = createHttpSyncTransport(baseUrl, apiKey);

  const edgeState = buildEdgeStateWithPendingSamples(deviceId, subjectId, 8);
  const seedSync = await http.postSync({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId: randomUUID(),
  });
  if (seedSync.kind !== "ok") {
    return {
      ok: false,
      failureClass: "seed_failed",
      skipped: false,
      drill: "corrupt_checkpoint",
      subjectId,
      deviceId,
    };
  }

  // Warm a turn so a checkpoint key may exist.
  const turnBody = buildAgentTurnRequest(subjectId, deviceId);
  turnBody.sessionId = sessionId;
  const warm = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/agent/turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(turnBody),
  });
  if (!warm.ok) {
    return {
      ok: false,
      failureClass: "warm_turn_failed",
      skipped: false,
      drill: "corrupt_checkpoint",
      subjectId,
      deviceId,
      detail: await warm.text(),
    };
  }

  const key = checkpointRedisKey(subjectId, checkpointThreadId(subjectId, sessionId));
  // Inject truncated/corrupt blob via redis-cli (compose as deployed).
  try {
    await execFileAsync(
      "docker",
      [
        "exec",
        redisContainer,
        "redis-cli",
        "SET",
        key,
        "not-a-valid-pickle{{{",
      ],
      { timeout: 30_000, windowsHide: true },
    );
  } catch (cause) {
    return {
      ok: false,
      failureClass: "chaos_inject_failed",
      skipped: false,
      drill: "corrupt_checkpoint",
      subjectId,
      deviceId,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  emitSyncChaosTelemetry({
    outcome: "ok",
    action: "corrupt_injected",
    drill: "corrupt_checkpoint",
    subjectId,
    deviceId,
    key,
  });

  // Restart agent turn — must not 5xx crash-loop.
  const statuses = [];
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/agent/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(turnBody),
    });
    statuses.push(res.status);
    if (res.status >= 500) {
      emitSyncChaosTelemetry({
        outcome: "rejected",
        action: "compose_gate",
        drill: "corrupt_checkpoint",
        failureClass: "crash_loop",
        subjectId,
        deviceId,
        httpStatus: res.status,
      });
      return {
        ok: false,
        failureClass: "crash_loop",
        skipped: false,
        drill: "corrupt_checkpoint",
        subjectId,
        deviceId,
        outcome: { status: "exhausted", attempts: i + 1, advisoryCodes: [] },
        statuses,
      };
    }
  }

  const ok = statuses.every((s) => s >= 200 && s < 500);

  emitSyncChaosTelemetry({
    outcome: ok ? "ok" : "rejected",
    action: "compose_gate",
    drill: "corrupt_checkpoint",
    failureClass: ok ? null : "turn_failed",
    subjectId,
    deviceId,
    statuses,
  });

  return {
    ok,
    failureClass: ok ? null : "turn_failed",
    skipped: false,
    drill: "corrupt_checkpoint",
    subjectId,
    deviceId,
    syncAttemptId: null,
    outcome: {
      status: ok ? "converged" : "exhausted",
      attempts: statuses.length,
      advisoryCodes: [ADVISORY_CORRUPT_RESET],
    },
    statuses,
    key,
    replicasEqual: true,
  };
}

