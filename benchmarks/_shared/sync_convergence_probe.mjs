/**
 * NFR-03 sync convergence probe — 1k pending friction samples → converged.
 * Uses public SyncEngine + SyncTransport (HTTP to compose or in-process merge).
 * Metadata only — never learner utterance bodies on the wire.
 */
import { CrdtHarnessResolver, SyncEngine, PROTOCOL_VERSION } from "sutra-sdk";
import { randomUUID } from "node:crypto";

/** NFR-03 pending sample count for endurance proof. */
export const PENDING_SAMPLES = 1_000;

/** PRD_MATRIX NFR-03 end-to-end p95 ceiling (ms). */
export const NFR03_BUDGET_P95_MS = 10_000;

const hlc = (ms, logical, device) =>
  `${String(ms).padStart(15, "0")}:${String(logical).padStart(6, "0")}:${device}`;

/**
 * Build an edge replica with `sampleCount` unsynced friction samples (CAST G-Set).
 * Contract-valid CognitiveState — no raw learner content.
 */
export function buildEdgeStateWithPendingSamples(
  deviceId,
  subjectId,
  sampleCount = PENDING_SAMPLES,
) {
  if (
    typeof deviceId !== "string" ||
    deviceId.length < 4 ||
    typeof subjectId !== "string" ||
    !subjectId.trim()
  ) {
    const err = new Error(
      "buildEdgeStateWithPendingSamples requires deviceId and subjectId",
    );
    err.failureClass = "validation_failed";
    throw err;
  }
  if (
    typeof sampleCount !== "number" ||
    !Number.isFinite(sampleCount) ||
    sampleCount < 1 ||
    sampleCount > 10_000
  ) {
    const err = new Error(
      "sampleCount must be a finite integer in 1..10000",
    );
    err.failureClass = "validation_failed";
    throw err;
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId,
    deviceIds: [deviceId],
    activeConceptId: "math.ratios",
    mode: "guided",
    mastery: {
      "math.ratios": {
        conceptId: "math.ratios",
        alpha: { [deviceId]: 2 },
        beta: { [deviceId]: 1 },
        lastExercisedAt: hlc(1_700_000_000_000, 0, deviceId),
      },
    },
    frictionLog: Array.from({ length: sampleCount }, (_, i) => ({
      conceptId: "math.ratios",
      hesitationMs: 400 + (i % 50),
      inputVelocity: 2.5 + (i % 7) * 0.1,
      revisionCount: i % 3,
      assistanceRequested: i % 17 === 0,
      outcome: i % 5 === 0 ? "partial" : "correct",
      capturedAt: hlc(1_700_000_100_000 + i, 0, deviceId),
    })),
    profile: {
      ageBand: "adult",
      track: "bench-track",
      language: "en-IN",
      updatedAt: hlc(1_700_000_200_000, 0, deviceId),
    },
    stateVector: { session: hlc(1_700_000_200_000, 1, deviceId) },
  };
}

/** Poll compose orchestrator /v1/health — false when stack is down. */
export async function orchestratorHealthy(
  baseUrl,
  timeoutMs = 2_000,
) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Public wire transport: POST /v1/sync with contract JSON (no test backdoors).
 */
export function createHttpSyncTransport(baseUrl, apiKey, opts = {}) {
  const root = baseUrl.replace(/\/$/, "");
  const extraDelayMs = opts.extraDelayMs ?? 0;
  return {
    async postSync(request) {
      if (extraDelayMs > 0) {
        await new Promise((r) => setTimeout(r, extraDelayMs));
      }
      try {
        const res = await fetch(`${root}/v1/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          body: JSON.stringify(request),
        });
        const text = await res.text();
        if (!res.ok) {
          return { kind: "http-error", status: res.status, body: text };
        }
        return { kind: "ok", response: JSON.parse(text) };
      } catch (cause) {
        return {
          kind: "network-error",
          cause: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
  };
}

/**
 * In-process cloud merge (sync_roundtrip parity) — CI gate floor when compose
 * is absent. Still exercises SyncEngine → converged; not full network SLA.
 */
export function createInProcessSyncTransport(opts = {}) {
  const resolver = new CrdtHarnessResolver();
  const masters = new Map();
  const extraDelayMs = opts.extraDelayMs ?? 0;
  return {
    async postSync(request) {
      if (extraDelayMs > 0) {
        await new Promise((r) => setTimeout(r, extraDelayMs));
      }
      const sid = request.edgeState.subjectId;
      const base = masters.get(sid) ?? request.edgeState;
      const { merged, advisories } = resolver.merge(base, request.edgeState);
      masters.set(sid, merged);
      return {
        kind: "ok",
        response: {
          protocolVersion: PROTOCOL_VERSION,
          mergedState: merged,
          compactedSampleTimestamps: merged.frictionLog.map((s) => s.capturedAt),
          advisories,
        },
      };
    },
  };
}

/**
 * Measure ms from sync start until SyncEngine returns status converged.
 */
export async function measureSyncConvergenceMs(transport, opts = {}) {
  const deviceId = opts.deviceId ?? "edge-conv-bench";
  const subjectId = opts.subjectId ?? "subj-sync-convergence";
  const sampleCount = opts.sampleCount ?? PENDING_SAMPLES;
  const syncAttemptId = opts.syncAttemptId ?? randomUUID();

  const engine = new SyncEngine(transport, opts.engineOpts ?? {});
  const edgeState = buildEdgeStateWithPendingSamples(
    deviceId,
    subjectId,
    sampleCount,
  );

  const t0 = performance.now();
  const outcome = await engine.synchronize({
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState,
    lastKnownCloudVector: {},
    syncAttemptId,
  });
  const elapsedMs = performance.now() - t0;

  return {
    elapsedMs,
    outcome,
    subjectId,
    deviceId,
    sampleCount,
    syncAttemptId,
  };
}
