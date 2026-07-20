/**
 * Per-slice production drift scorer against pinned C0 frozen baselines.
 *
 * State is fixed-cycle sufficient statistics only (n/sum/sumSquares). It
 * never retains sample bodies and never replaces the C0 baseline with a
 * rolling production average.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  loadBaselineRegistry,
  resolveBaselineSourcePath,
} from "./baseline_registry.js";
import {
  loadEvalSliceTaxonomy,
  mapRegistryToEvalSlices,
  parseSliceId,
} from "./eval_slices.js";

export const SLICE_DRIFT_BASELINE_SCHEMA_VERSION =
  "slice-drift-baselines.v1" as const;
export const SLICE_DRIFT_BASELINE_RELPATH =
  "training/eval/drift/frozen-baselines.json" as const;
export const SLICE_DRIFT_MONITOR_SCHEMA_VERSION =
  "learning.slice-drift-monitor.v1" as const;

export const SLICE_DRIFT_SUBJECT_LIMIT = 1 as const;
export const SLICE_DRIFT_CYCLE_LIMIT = 32 as const;
export const SLICE_DRIFT_OPERATION_LIMIT = 4_096 as const;
export const SLICE_DRIFT_ALERT_TIMEOUT_MS = 5_000 as const;
export const SLICE_DRIFT_ALERT_MAX_ATTEMPTS = 3 as const;
export const SLICE_DRIFT_CHANNELS = Object.freeze([
  "production",
  "synthetic-canary",
] as const);

export type SliceDriftChannel = (typeof SLICE_DRIFT_CHANNELS)[number];
export type SliceDriftLocality = "on-device" | "self-hosted";

export type SliceDriftBaseline = {
  sliceId: string;
  baselineScore: number;
  tolerance: number;
};

export type SliceDriftBaselineDocument = {
  schemaVersion: typeof SLICE_DRIFT_BASELINE_SCHEMA_VERSION;
  baselineRegistryHash: string;
  confidenceAlpha: number;
  notes?: string;
  slices: SliceDriftBaseline[];
};

export type SliceDriftFailureClass =
  | "drift_monitor.invalid_input"
  | "drift_monitor.source_missing"
  | "drift_monitor.baseline_hash_mismatch"
  | "drift_monitor.coverage_incomplete"
  | "drift_monitor.unregistered_slice"
  | "drift_monitor.cross_subject_denied"
  | "drift_monitor.locality_forbidden"
  | "drift_monitor.raw_content_forbidden"
  | "drift_monitor.idempotent_conflict"
  | "drift_monitor.capacity"
  | "drift_monitor.alert_sink_missing"
  | "drift_monitor.downstream_timeout"
  | "drift_monitor.route_failed"
  | "drift_monitor.route_attempts_exhausted";

export class SliceDriftContractError extends Error {
  readonly obligation: SliceDriftFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: SliceDriftFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "SliceDriftContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

export type SliceDriftScore = {
  schemaVersion: typeof SLICE_DRIFT_MONITOR_SCHEMA_VERSION;
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  channel: SliceDriftChannel;
  cycleId: string;
  sliceId: string;
  baselineRegistryHash: string;
  baselineScore: number;
  tolerance: number;
  floor: number;
  sampleCount: number;
  mean: number;
  variance: number;
  delta: number;
  confidenceLower: number;
  confidenceUpper: number;
  /** Low traffic widens confidence bounds; it never suppresses breach. */
  lowTraffic: boolean;
  breached: boolean;
  confirmedBreach: boolean;
};

export type SliceDriftTelemetryEvent = {
  event:
    | "learning.slice_drift.metric"
    | "learning.slice_drift.breach"
    | "learning.slice_drift.alert_routing";
  outcome:
    | "ok"
    | "breach"
    | "rejected"
    | "idempotent_replay"
    | "routed";
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  channel: SliceDriftChannel;
  cycleId: string;
  sliceId: string;
  baselineRegistryHash: string;
  baselineScore?: number;
  floor?: number;
  sampleCount?: number;
  mean?: number;
  delta?: number;
  confidenceLower?: number;
  confidenceUpper?: number;
  lowTraffic?: boolean;
  failureClass?: SliceDriftFailureClass;
  alertId?: string;
};

export const SLICE_DRIFT_ALERT_SCHEMA_VERSION =
  "learning.slice-drift-alert.v1" as const;

/**
 * Metadata-only per-slice alert. Aggregate dashboards may derive from these
 * rows; an aggregate-only alert is deliberately not representable.
 */
export type SliceDriftAlertPayload = {
  schemaVersion: typeof SLICE_DRIFT_ALERT_SCHEMA_VERSION;
  alertId: string;
  operationId: string;
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  channel: SliceDriftChannel;
  cycleId: string;
  sliceId: string;
  metricDelta: number;
  baselineHash: string;
  baselineScore: number;
  floor: number;
  sampleCount: number;
  confidenceLower: number;
  confidenceUpper: number;
};

export type SliceDriftAlertSink = {
  /** Must deduplicate retries by payload.alertId after ambiguous timeouts. */
  route(payload: SliceDriftAlertPayload): Promise<void>;
};

export type SliceDriftRouteResult = {
  score: SliceDriftScore;
  routed: boolean;
  alert?: SliceDriftAlertPayload;
};

export type SliceDriftSample = {
  operationId: string;
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  channel: SliceDriftChannel;
  cycleId: string;
  sliceId: string;
  /** Bounded deterministic critic/eval score; higher is better. */
  score: number;
};

type SliceStats = {
  count: number;
  sum: number;
  sumSquares: number;
};

type OperationReceipt = {
  fingerprint: string;
  score: SliceDriftScore;
};

export type SliceDriftSnapshot = {
  subjectId: string;
  channel: SliceDriftChannel;
  cycleId: string;
  baselineRegistryHash: string;
  slices: SliceDriftScore[];
};

export type SliceDriftMonitor = {
  readonly subjectId: string;
  readonly deviceId: string;
  readonly locality: SliceDriftLocality;
  readonly baselineRegistryHash: string;
  readonly registeredSliceIds: readonly string[];
  record(sample: SliceDriftSample): SliceDriftScore;
  recordAndRoute(sample: SliceDriftSample): Promise<SliceDriftRouteResult>;
  snapshot(input: {
    subjectId: string;
    deviceId: string;
    locality: SliceDriftLocality;
    channel: SliceDriftChannel;
    cycleId: string;
  }): SliceDriftSnapshot;
};

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const LOW_TRAFFIC_SAMPLE_FLOOR = 30;
const ALLOWED_SAMPLE_KEYS = new Set([
  "operationId",
  "subjectId",
  "deviceId",
  "locality",
  "channel",
  "cycleId",
  "sliceId",
  "score",
]);

function sha256(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function assertId(
  value: unknown,
  label: string,
  meta: { subjectId?: string; deviceId?: string } = {},
): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new SliceDriftContractError(
      `${label} must be a stable id (1..128)`,
      {
        obligation: "drift_monitor.invalid_input",
        ...(meta.subjectId !== undefined ? { subjectId: meta.subjectId } : {}),
        ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
      },
    );
  }
}

function validateBaselineDocument(
  raw: unknown,
): SliceDriftBaselineDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SliceDriftContractError("drift baseline must be an object", {
      obligation: "drift_monitor.invalid_input",
    });
  }
  const doc = raw as Record<string, unknown>;
  if (
    doc.schemaVersion !== SLICE_DRIFT_BASELINE_SCHEMA_VERSION ||
    typeof doc.baselineRegistryHash !== "string" ||
    !HASH_RE.test(doc.baselineRegistryHash) ||
    typeof doc.confidenceAlpha !== "number" ||
    !Number.isFinite(doc.confidenceAlpha) ||
    doc.confidenceAlpha <= 0 ||
    doc.confidenceAlpha >= 1 ||
    !Array.isArray(doc.slices) ||
    doc.slices.length < 1 ||
    doc.slices.length > 256
  ) {
    throw new SliceDriftContractError(
      "drift baseline document is invalid",
      { obligation: "drift_monitor.invalid_input" },
    );
  }
  const seen = new Set<string>();
  const slices: SliceDriftBaseline[] = [];
  for (const rawRow of doc.slices) {
    if (
      rawRow === null ||
      typeof rawRow !== "object" ||
      Array.isArray(rawRow)
    ) {
      throw new SliceDriftContractError("drift baseline row is invalid", {
        obligation: "drift_monitor.invalid_input",
      });
    }
    const row = rawRow as Record<string, unknown>;
    if (
      typeof row.sliceId !== "string" ||
      !parseSliceId(row.sliceId).ok ||
      seen.has(row.sliceId) ||
      typeof row.baselineScore !== "number" ||
      !Number.isFinite(row.baselineScore) ||
      row.baselineScore < 0 ||
      row.baselineScore > 1 ||
      typeof row.tolerance !== "number" ||
      !Number.isFinite(row.tolerance) ||
      row.tolerance < 0 ||
      row.tolerance > 1
    ) {
      throw new SliceDriftContractError(
        `invalid drift baseline row ${String(row.sliceId)}`,
        { obligation: "drift_monitor.invalid_input" },
      );
    }
    seen.add(row.sliceId);
    slices.push({
      sliceId: row.sliceId,
      baselineScore: row.baselineScore,
      tolerance: row.tolerance,
    });
  }
  return {
    schemaVersion: SLICE_DRIFT_BASELINE_SCHEMA_VERSION,
    baselineRegistryHash: doc.baselineRegistryHash,
    confidenceAlpha: doc.confidenceAlpha,
    ...(typeof doc.notes === "string" ? { notes: doc.notes.slice(0, 512) } : {}),
    slices: slices.sort((a, b) => a.sliceId.localeCompare(b.sliceId)),
  };
}

function emptyScore(input: {
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  channel: SliceDriftChannel;
  cycleId: string;
  baselineRegistryHash: string;
  baseline: SliceDriftBaseline;
}): SliceDriftScore {
  const floor = Math.max(
    0,
    input.baseline.baselineScore - input.baseline.tolerance,
  );
  return {
    schemaVersion: SLICE_DRIFT_MONITOR_SCHEMA_VERSION,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality,
    channel: input.channel,
    cycleId: input.cycleId,
    sliceId: input.baseline.sliceId,
    baselineRegistryHash: input.baselineRegistryHash,
    baselineScore: input.baseline.baselineScore,
    tolerance: input.baseline.tolerance,
    floor,
    sampleCount: 0,
    mean: 0,
    variance: 0,
    delta: -input.baseline.baselineScore,
    confidenceLower: 0,
    confidenceUpper: 1,
    lowTraffic: true,
    breached: false,
    confirmedBreach: false,
  };
}

function computeScore(input: {
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  channel: SliceDriftChannel;
  cycleId: string;
  baselineRegistryHash: string;
  confidenceAlpha: number;
  baseline: SliceDriftBaseline;
  stats: SliceStats;
}): SliceDriftScore {
  const count = input.stats.count;
  const mean = input.stats.sum / count;
  const variance = Math.max(
    0,
    input.stats.sumSquares / count - mean * mean,
  );
  // Distribution-free interval for bounded [0,1] scores.
  const halfWidth = Math.sqrt(
    Math.log(2 / input.confidenceAlpha) / (2 * count),
  );
  const confidenceLower = Math.max(0, mean - halfWidth);
  const confidenceUpper = Math.min(1, mean + halfWidth);
  const floor = Math.max(
    0,
    input.baseline.baselineScore - input.baseline.tolerance,
  );
  const breached = mean + Number.EPSILON < floor;
  return {
    schemaVersion: SLICE_DRIFT_MONITOR_SCHEMA_VERSION,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality,
    channel: input.channel,
    cycleId: input.cycleId,
    sliceId: input.baseline.sliceId,
    baselineRegistryHash: input.baselineRegistryHash,
    baselineScore: input.baseline.baselineScore,
    tolerance: input.baseline.tolerance,
    floor,
    sampleCount: count,
    mean,
    variance,
    delta: mean - input.baseline.baselineScore,
    confidenceLower,
    confidenceUpper,
    lowTraffic: count < LOW_TRAFFIC_SAMPLE_FLOOR,
    breached,
    confirmedBreach: breached && confidenceUpper < floor,
  };
}

function eventFromScore(
  score: SliceDriftScore,
  event: SliceDriftTelemetryEvent["event"],
  outcome: SliceDriftTelemetryEvent["outcome"],
): SliceDriftTelemetryEvent {
  return {
    event,
    outcome,
    subjectId: score.subjectId,
    deviceId: score.deviceId,
    locality: score.locality,
    channel: score.channel,
    cycleId: score.cycleId,
    sliceId: score.sliceId,
    baselineRegistryHash: score.baselineRegistryHash,
    baselineScore: score.baselineScore,
    floor: score.floor,
    sampleCount: score.sampleCount,
    mean: score.mean,
    delta: score.delta,
    confidenceLower: score.confidenceLower,
    confidenceUpper: score.confidenceUpper,
    lowTraffic: score.lowTraffic,
  };
}

function alertFromScore(
  operationId: string,
  score: SliceDriftScore,
): SliceDriftAlertPayload {
  return {
    schemaVersion: SLICE_DRIFT_ALERT_SCHEMA_VERSION,
    alertId: `slice-drift:${operationId}`,
    operationId,
    subjectId: score.subjectId,
    deviceId: score.deviceId,
    locality: score.locality,
    channel: score.channel,
    cycleId: score.cycleId,
    sliceId: score.sliceId,
    metricDelta: score.delta,
    baselineHash: score.baselineRegistryHash,
    baselineScore: score.baselineScore,
    floor: score.floor,
    sampleCount: score.sampleCount,
    confidenceLower: score.confidenceLower,
    confidenceUpper: score.confidenceUpper,
  };
}

async function routeWithTimeout(
  sink: SliceDriftAlertSink,
  payload: SliceDriftAlertPayload,
  timeoutMs: number,
): Promise<"ok" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve()
    .then(() => sink.route(payload))
    .then(
      () => ({ kind: "ok" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
  try {
    const result = await Promise.race([
      guarded,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (result.kind === "timeout") return "timeout";
    if (result.kind === "error") throw result.error;
    return "ok";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createSliceDriftMonitor(options: {
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  baseline: SliceDriftBaselineDocument;
  cycleLimit?: number;
  operationLimit?: number;
  alertSink?: SliceDriftAlertSink;
  alertTimeoutMs?: number;
  alertMaxAttempts?: number;
  onTelemetry?: (event: SliceDriftTelemetryEvent) => void;
}): SliceDriftMonitor {
  assertId(options.subjectId, "subjectId", { deviceId: options.deviceId });
  assertId(options.deviceId, "deviceId", { subjectId: options.subjectId });
  if (
    options.locality !== "on-device" &&
    options.locality !== "self-hosted"
  ) {
    throw new SliceDriftContractError("invalid monitor locality", {
      obligation: "drift_monitor.locality_forbidden",
      subjectId: options.subjectId,
      deviceId: options.deviceId,
    });
  }
  const cycleLimit = options.cycleLimit ?? SLICE_DRIFT_CYCLE_LIMIT;
  const operationLimit =
    options.operationLimit ?? SLICE_DRIFT_OPERATION_LIMIT;
  const alertTimeoutMs =
    options.alertTimeoutMs ?? SLICE_DRIFT_ALERT_TIMEOUT_MS;
  const alertMaxAttempts =
    options.alertMaxAttempts ?? SLICE_DRIFT_ALERT_MAX_ATTEMPTS;
  if (
    !Number.isInteger(cycleLimit) ||
    cycleLimit < 1 ||
    cycleLimit > SLICE_DRIFT_CYCLE_LIMIT ||
    !Number.isInteger(operationLimit) ||
    operationLimit < 1 ||
    operationLimit > SLICE_DRIFT_OPERATION_LIMIT ||
    !Number.isInteger(alertTimeoutMs) ||
    alertTimeoutMs < 1 ||
    alertTimeoutMs > 30_000 ||
    !Number.isInteger(alertMaxAttempts) ||
    alertMaxAttempts < 1 ||
    alertMaxAttempts > SLICE_DRIFT_ALERT_MAX_ATTEMPTS
  ) {
    throw new SliceDriftContractError("invalid monitor capacity", {
      obligation: "drift_monitor.invalid_input",
      subjectId: options.subjectId,
      deviceId: options.deviceId,
    });
  }

  const baselines = new Map(
    options.baseline.slices.map((row) => [row.sliceId, row] as const),
  );
  const states = new Map<string, Map<string, SliceStats>>();
  const operations = new Map<string, OperationReceipt>();
  const routedAlerts = new Map<string, SliceDriftAlertPayload>();
  const alertAttempts = new Map<string, number>();
  const alertsInFlight = new Map<string, Promise<SliceDriftAlertPayload>>();

  const stateKey = (
    channel: SliceDriftChannel,
    cycleId: string,
  ): string => `${channel}:${cycleId}`;

  const reject = (
    message: string,
    obligation: SliceDriftFailureClass,
    input: {
      channel?: unknown;
      cycleId?: unknown;
      sliceId?: unknown;
    } = {},
  ): never => {
    const channel: SliceDriftChannel =
      typeof input.channel === "string" &&
      (SLICE_DRIFT_CHANNELS as readonly string[]).includes(input.channel)
        ? (input.channel as SliceDriftChannel)
        : "production";
    options.onTelemetry?.({
      event: "learning.slice_drift.metric",
      outcome: "rejected",
      subjectId: options.subjectId,
      deviceId: options.deviceId,
      locality: options.locality,
      channel,
      cycleId:
        typeof input.cycleId === "string" ? input.cycleId : "(invalid)",
      sliceId:
        typeof input.sliceId === "string" ? input.sliceId : "(invalid)",
      baselineRegistryHash: options.baseline.baselineRegistryHash,
      failureClass: obligation,
    });
    throw new SliceDriftContractError(message, {
      obligation,
      subjectId: options.subjectId,
      deviceId: options.deviceId,
    });
  };

  const ensureCycle = (
    channel: SliceDriftChannel,
    cycleId: string,
  ): Map<string, SliceStats> => {
    const key = stateKey(channel, cycleId);
    let state = states.get(key);
    if (state !== undefined) return state;
    let channelCycleCount = 0;
    for (const existingKey of states.keys()) {
      if (existingKey.startsWith(`${channel}:`)) channelCycleCount += 1;
    }
    if (channelCycleCount >= cycleLimit) {
      reject(
        "drift monitor cycle capacity exceeded",
        "drift_monitor.capacity",
        { channel, cycleId },
      );
    }
    // Every registered C0 slice gets active state immediately.
    state = new Map(
      options.baseline.slices.map((row) => [
        row.sliceId,
        { count: 0, sum: 0, sumSquares: 0 },
      ]),
    );
    states.set(key, state);
    return state;
  };

  const assertScope = (input: {
    subjectId: string;
    deviceId: string;
    locality?: SliceDriftLocality;
  }): void => {
    if (
      input.subjectId !== options.subjectId ||
      input.deviceId !== options.deviceId
    ) {
      reject(
        "cross-subject/device drift access denied",
        "drift_monitor.cross_subject_denied",
      );
    }
    if (
      input.locality !== undefined &&
      input.locality !== options.locality
    ) {
      reject(
        "cross-locality drift sample denied",
        "drift_monitor.locality_forbidden",
      );
    }
  };

  const emitRouting = (
    score: SliceDriftScore,
    alertId: string,
    outcome: "routed" | "idempotent_replay" | "rejected",
    failureClass?: SliceDriftFailureClass,
  ): void => {
    options.onTelemetry?.({
      ...eventFromScore(
        score,
        "learning.slice_drift.alert_routing",
        outcome,
      ),
      alertId,
      ...(failureClass !== undefined ? { failureClass } : {}),
    });
  };

  const routeAlert = (
    score: SliceDriftScore,
    payload: SliceDriftAlertPayload,
  ): Promise<SliceDriftAlertPayload> => {
    const completed = routedAlerts.get(payload.alertId);
    if (completed !== undefined) {
      emitRouting(
        score,
        payload.alertId,
        "idempotent_replay",
      );
      return Promise.resolve(completed);
    }
    const inFlight = alertsInFlight.get(payload.alertId);
    if (inFlight !== undefined) return inFlight;
    const attempt = (alertAttempts.get(payload.alertId) ?? 0) + 1;
    if (attempt > alertMaxAttempts) {
      emitRouting(
        score,
        payload.alertId,
        "rejected",
        "drift_monitor.route_attempts_exhausted",
      );
      throw new SliceDriftContractError(
        `drift alert attempts exhausted for slice ${payload.sliceId}`,
        {
          obligation: "drift_monitor.route_attempts_exhausted",
          subjectId: options.subjectId,
          deviceId: options.deviceId,
        },
      );
    }
    alertAttempts.set(payload.alertId, attempt);

    const pending = (async (): Promise<SliceDriftAlertPayload> => {
      try {
        const result = await routeWithTimeout(
          options.alertSink!,
          payload,
          alertTimeoutMs,
        );
        if (result === "timeout") {
          emitRouting(
            score,
            payload.alertId,
            "rejected",
            "drift_monitor.downstream_timeout",
          );
          throw new SliceDriftContractError(
            `drift alert routing timed out after ${alertTimeoutMs}ms`,
            {
              obligation: "drift_monitor.downstream_timeout",
              subjectId: options.subjectId,
              deviceId: options.deviceId,
            },
          );
        }
      } catch (error) {
        if (error instanceof SliceDriftContractError) throw error;
        emitRouting(
          score,
          payload.alertId,
          "rejected",
          "drift_monitor.route_failed",
        );
        throw new SliceDriftContractError(
          `drift alert routing failed: ${
            error instanceof Error ? error.message : "unknown failure"
          }`,
          {
            obligation: "drift_monitor.route_failed",
            subjectId: options.subjectId,
            deviceId: options.deviceId,
          },
        );
      }
      routedAlerts.set(payload.alertId, payload);
      emitRouting(score, payload.alertId, "routed");
      return payload;
    })().finally(() => {
      alertsInFlight.delete(payload.alertId);
    });
    alertsInFlight.set(payload.alertId, pending);
    return pending;
  };

  const monitor: SliceDriftMonitor = {
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    locality: options.locality,
    baselineRegistryHash: options.baseline.baselineRegistryHash,
    registeredSliceIds: Object.freeze(
      options.baseline.slices.map((row) => row.sliceId),
    ),

    record(sample) {
      for (const key of Object.keys(sample as unknown as Record<string, unknown>)) {
        if (
          !ALLOWED_SAMPLE_KEYS.has(key) ||
          /utterance|content|body|prompt|secret/i.test(key)
        ) {
          reject(
            `raw or unknown sample field ${key} is forbidden`,
            "drift_monitor.raw_content_forbidden",
            sample,
          );
        }
      }
      assertScope(sample);
      if (!ID_RE.test(sample.operationId) || !ID_RE.test(sample.cycleId)) {
        reject(
          "operationId and cycleId must be stable ids (1..128)",
          "drift_monitor.invalid_input",
          sample,
        );
      }
      if (
        !(SLICE_DRIFT_CHANNELS as readonly string[]).includes(sample.channel)
      ) {
        reject("invalid drift channel", "drift_monitor.invalid_input", sample);
      }
      if (!Number.isFinite(sample.score) || sample.score < 0 || sample.score > 1) {
        reject(
          "drift score must be finite in [0,1]",
          "drift_monitor.invalid_input",
          sample,
        );
      }
      const baseline =
        baselines.get(sample.sliceId) ??
        reject(
          `unregistered drift slice ${sample.sliceId}`,
          "drift_monitor.unregistered_slice",
          sample,
        );
      const fingerprint = [
        sample.subjectId,
        sample.deviceId,
        sample.locality,
        sample.channel,
        sample.cycleId,
        sample.sliceId,
        sample.score.toString(),
      ].join("|");
      const prior = operations.get(sample.operationId);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          reject(
            "drift operation idempotency conflict",
            "drift_monitor.idempotent_conflict",
            sample,
          );
        }
        options.onTelemetry?.(
          eventFromScore(
            prior.score,
            "learning.slice_drift.metric",
            "idempotent_replay",
          ),
        );
        return prior.score;
      }
      if (operations.size >= operationLimit) {
        reject(
          "drift operation capacity exceeded",
          "drift_monitor.capacity",
          sample,
        );
      }
      const state = ensureCycle(sample.channel, sample.cycleId);
      const stats = state.get(sample.sliceId)!;
      stats.count += 1;
      stats.sum += sample.score;
      stats.sumSquares += sample.score * sample.score;
      const score = computeScore({
        subjectId: options.subjectId,
        deviceId: options.deviceId,
        locality: options.locality,
        channel: sample.channel,
        cycleId: sample.cycleId,
        baselineRegistryHash: options.baseline.baselineRegistryHash,
        confidenceAlpha: options.baseline.confidenceAlpha,
        baseline,
        stats,
      });
      // Receipt precedes callbacks: callback failure can be replayed safely.
      operations.set(sample.operationId, { fingerprint, score });
      options.onTelemetry?.(
        eventFromScore(
          score,
          "learning.slice_drift.metric",
          score.breached ? "breach" : "ok",
        ),
      );
      if (score.breached) {
        options.onTelemetry?.(
          eventFromScore(
            score,
            "learning.slice_drift.breach",
            "breach",
          ),
        );
      }
      return score;
    },

    async recordAndRoute(sample) {
      const score = monitor.record(sample);
      if (!score.breached) return { score, routed: false };
      if (options.alertSink === undefined) {
        emitRouting(
          score,
          `slice-drift:${sample.operationId}`,
          "rejected",
          "drift_monitor.alert_sink_missing",
        );
        throw new SliceDriftContractError(
          "drift alert sink is required for a breached score",
          {
            obligation: "drift_monitor.alert_sink_missing",
            subjectId: options.subjectId,
            deviceId: options.deviceId,
          },
        );
      }
      const payload = alertFromScore(sample.operationId, score);
      const alert = await routeAlert(score, payload);
      return { score, routed: true, alert };
    },

    snapshot(input) {
      assertScope(input);
      if (!ID_RE.test(input.cycleId)) {
        reject(
          "cycleId must be a stable id (1..128)",
          "drift_monitor.invalid_input",
          input,
        );
      }
      if (
        !(SLICE_DRIFT_CHANNELS as readonly string[]).includes(input.channel)
      ) {
        reject("invalid drift channel", "drift_monitor.invalid_input", input);
      }
      const state = ensureCycle(input.channel, input.cycleId);
      return {
        subjectId: options.subjectId,
        channel: input.channel,
        cycleId: input.cycleId,
        baselineRegistryHash: options.baseline.baselineRegistryHash,
        slices: options.baseline.slices.map((baseline) => {
          const stats = state.get(baseline.sliceId)!;
          return stats.count === 0
            ? emptyScore({
                subjectId: options.subjectId,
                deviceId: options.deviceId,
                locality: options.locality,
                channel: input.channel,
                cycleId: input.cycleId,
                baselineRegistryHash:
                  options.baseline.baselineRegistryHash,
                baseline,
              })
            : computeScore({
                subjectId: options.subjectId,
                deviceId: options.deviceId,
                locality: options.locality,
                channel: input.channel,
                cycleId: input.cycleId,
                baselineRegistryHash:
                  options.baseline.baselineRegistryHash,
                confidenceAlpha: options.baseline.confidenceAlpha,
                baseline,
                stats,
              });
        }),
      };
    },
  };
  return monitor;
}

/**
 * Load and hash-verify the C0 registry, map its active slices, and require the
 * pinned drift policy to cover each active lane exactly once.
 */
export async function loadSliceDriftMonitor(options: {
  repoRoot: string;
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  baselinePath?: string;
  alertSink?: SliceDriftAlertSink;
  alertTimeoutMs?: number;
  alertMaxAttempts?: number;
  onTelemetry?: (event: SliceDriftTelemetryEvent) => void;
}): Promise<SliceDriftMonitor> {
  const registry = await loadBaselineRegistry({
    repoRoot: options.repoRoot,
    deviceId: options.deviceId,
  });
  if (!registry.ok) {
    throw new SliceDriftContractError(
      `C0 baseline registry rejected: ${registry.detail}`,
      {
        obligation:
          registry.failureClass === "source_missing"
            ? "drift_monitor.source_missing"
            : "drift_monitor.invalid_input",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }
  const taxonomy = await loadEvalSliceTaxonomy({
    repoRoot: options.repoRoot,
    deviceId: options.deviceId,
  });
  if (!taxonomy.ok) {
    throw new SliceDriftContractError(
      `C0 slice taxonomy rejected: ${taxonomy.detail}`,
      {
        obligation:
          taxonomy.failureClass === "source_missing"
            ? "drift_monitor.source_missing"
            : "drift_monitor.invalid_input",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }
  const mapped = mapRegistryToEvalSlices(
    registry.document,
    taxonomy.document,
  );
  if (!mapped.ok) {
    throw new SliceDriftContractError(
      `C0 slice mapping rejected: ${mapped.detail}`,
      {
        obligation: "drift_monitor.coverage_incomplete",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  const baselinePath =
    options.baselinePath ?? SLICE_DRIFT_BASELINE_RELPATH;
  const resolvedPolicy = resolveBaselineSourcePath(
    options.repoRoot,
    baselinePath,
  );
  const resolvedRegistry = resolveBaselineSourcePath(
    options.repoRoot,
    registry.registryPath,
  );
  if (!resolvedPolicy.ok || !resolvedRegistry.ok) {
    throw new SliceDriftContractError("drift baseline path is invalid", {
      obligation: "drift_monitor.source_missing",
      subjectId: options.subjectId,
      deviceId: options.deviceId,
    });
  }
  let policyText: string;
  let registryText: string;
  try {
    [policyText, registryText] = await Promise.all([
      readFile(resolvedPolicy.absolutePath, "utf8"),
      readFile(resolvedRegistry.absolutePath, "utf8"),
    ]);
  } catch {
    throw new SliceDriftContractError(
      "drift baseline or C0 registry is missing",
      {
        obligation: "drift_monitor.source_missing",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }
  let rawPolicy: unknown;
  try {
    rawPolicy = JSON.parse(policyText);
  } catch {
    throw new SliceDriftContractError(
      "drift baseline JSON parse failed",
      {
        obligation: "drift_monitor.invalid_input",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }
  const policy = validateBaselineDocument(rawPolicy);
  const actualRegistryHash = sha256(registryText);
  if (policy.baselineRegistryHash !== actualRegistryHash) {
    throw new SliceDriftContractError(
      "drift policy does not pin the current C0 baseline registry",
      {
        obligation: "drift_monitor.baseline_hash_mismatch",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  const activeSliceIds = mapped.mappings
    .filter(
      (slice) =>
        !slice.emptyMarker &&
        slice.baselineSetIds.length > 0 &&
        slice.pinnedSeeds.length > 0,
    )
    .map((slice) => slice.sliceId)
    .sort((a, b) => a.localeCompare(b));
  const policySliceIds = policy.slices
    .map((slice) => slice.sliceId)
    .sort((a, b) => a.localeCompare(b));
  if (
    activeSliceIds.length !== policySliceIds.length ||
    activeSliceIds.some((sliceId, index) => policySliceIds[index] !== sliceId)
  ) {
    throw new SliceDriftContractError(
      `drift policy coverage mismatch: active=[${activeSliceIds.join(",")}] policy=[${policySliceIds.join(",")}]`,
      {
        obligation: "drift_monitor.coverage_incomplete",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  return createSliceDriftMonitor({
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    locality: options.locality,
    baseline: policy,
    ...(options.alertSink !== undefined
      ? { alertSink: options.alertSink }
      : {}),
    ...(options.alertTimeoutMs !== undefined
      ? { alertTimeoutMs: options.alertTimeoutMs }
      : {}),
    ...(options.alertMaxAttempts !== undefined
      ? { alertMaxAttempts: options.alertMaxAttempts }
      : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}

export const SLICE_DRIFT_AGGREGATE_SCHEMA_VERSION =
  "learning.slice-drift-aggregate.v1" as const;

/**
 * Aggregate is always derived from per-slice scores — never the primary
 * alert source. Dashboards may display this; monitors alert per slice.
 */
export type SliceDriftAggregate = {
  schemaVersion: typeof SLICE_DRIFT_AGGREGATE_SCHEMA_VERSION;
  sliceCount: number;
  scoredCount: number;
  breachedCount: number;
  mean: number;
  min: number;
  max: number;
  /** True when mean stays within flatTolerance of the pinned baseline mean. */
  flat: boolean;
};

export type SliceDriftInjectionReport = {
  subjectId: string;
  deviceId: string;
  cycleId: string;
  injectedSliceId: string;
  baselineRegistryHash: string;
  production: SliceDriftSnapshot;
  syntheticCanary: SliceDriftSnapshot;
  aggregate: SliceDriftAggregate;
  routedAlerts: SliceDriftAlertPayload[];
};

export function deriveSliceDriftAggregate(
  slices: readonly SliceDriftScore[],
  options: { flatTolerance?: number } = {},
): SliceDriftAggregate {
  if (slices.length === 0) {
    throw new SliceDriftContractError(
      "aggregate requires per-slice scores",
      { obligation: "drift_monitor.invalid_input" },
    );
  }
  const flatTolerance = options.flatTolerance ?? 0.15;
  if (
    !Number.isFinite(flatTolerance) ||
    flatTolerance < 0 ||
    flatTolerance > 1
  ) {
    throw new SliceDriftContractError("invalid flatTolerance", {
      obligation: "drift_monitor.invalid_input",
    });
  }
  const scored = slices.filter((row) => row.sampleCount > 0);
  const means = scored.map((row) => row.mean);
  const baselineMeans = scored.map((row) => row.baselineScore);
  let sum = 0;
  let baselineSum = 0;
  let min = means[0] ?? 0;
  let max = means[0] ?? 0;
  for (let i = 0; i < means.length; i += 1) {
    const mean = means[i]!;
    sum += mean;
    baselineSum += baselineMeans[i]!;
    if (mean < min) min = mean;
    if (mean > max) max = mean;
  }
  const mean = scored.length === 0 ? 0 : sum / scored.length;
  const baselineMean =
    scored.length === 0 ? 0 : baselineSum / scored.length;
  return {
    schemaVersion: SLICE_DRIFT_AGGREGATE_SCHEMA_VERSION,
    sliceCount: slices.length,
    scoredCount: scored.length,
    breachedCount: scored.filter((row) => row.breached).length,
    mean,
    min: scored.length === 0 ? 0 : min,
    max: scored.length === 0 ? 0 : max,
    flat: Math.abs(mean - baselineMean) <= flatTolerance + Number.EPSILON,
  };
}

/**
 * CI injection prove: stable production traffic on every registered C0 slice,
 * single-slice regression trips the monitor and routes a metadata-only alert,
 * while the derived aggregate stays flat and other slices do not false-positive.
 * Synthetic-canary injections stay on a separate channel.
 */
export async function proveSliceDriftInjection(options: {
  repoRoot: string;
  subjectId: string;
  deviceId: string;
  locality: SliceDriftLocality;
  /** Defaults to teacher/en/b8 — one language/domain pack lane. */
  injectedSliceId?: string;
  /** Regressed score for the injected slice (must breach floor). */
  injectedScore?: number;
  /** Stable production score for non-injected slices. */
  stableScore?: number;
  flatTolerance?: number;
  onTelemetry?: (event: SliceDriftTelemetryEvent) => void;
}): Promise<SliceDriftInjectionReport> {
  const injectedSliceId = options.injectedSliceId ?? "teacher/en/b8";
  const injectedScore = options.injectedScore ?? 0.5;
  // Zero-tolerance C0 lanes require an exact baseline hit for "stable".
  const stableScore = options.stableScore ?? 1;
  const cycleId = "cycle.injection";
  const routedAlerts: SliceDriftAlertPayload[] = [];
  const events: SliceDriftTelemetryEvent[] = [];

  const monitor = await loadSliceDriftMonitor({
    repoRoot: options.repoRoot,
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    locality: options.locality,
    alertSink: {
      async route(payload) {
        routedAlerts.push(payload);
      },
    },
    onTelemetry(event) {
      events.push(event);
      options.onTelemetry?.(event);
    },
  });

  if (!monitor.registeredSliceIds.includes(injectedSliceId)) {
    throw new SliceDriftContractError(
      `injection target ${injectedSliceId} is not a registered C0 slice`,
      {
        obligation: "drift_monitor.unregistered_slice",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  // Stable production traffic on every registered lane.
  let op = 0;
  for (const sliceId of monitor.registeredSliceIds) {
    op += 1;
    const score = await monitor.recordAndRoute({
      operationId: `stable.${op}`,
      subjectId: options.subjectId,
      deviceId: options.deviceId,
      locality: options.locality,
      channel: "production",
      cycleId,
      sliceId,
      score: stableScore,
    });
    if (score.score.breached) {
      throw new SliceDriftContractError(
        `stable traffic false-positive on ${sliceId}`,
        {
          obligation: "drift_monitor.invalid_input",
          subjectId: options.subjectId,
          deviceId: options.deviceId,
        },
      );
    }
  }

  // Synthetic canary injection must not pollute production statistics.
  // Score-only on the canary channel — never merges into production.
  monitor.record({
    operationId: "canary.synthetic.1",
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    locality: options.locality,
    channel: "synthetic-canary",
    cycleId,
    sliceId: injectedSliceId,
    score: 0,
  });

  // Inject one-slice production regression.
  const injected = await monitor.recordAndRoute({
    operationId: "inject.regression.1",
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    locality: options.locality,
    channel: "production",
    cycleId,
    sliceId: injectedSliceId,
    score: injectedScore,
  });
  if (!injected.routed || !injected.score.breached || !injected.alert) {
    throw new SliceDriftContractError(
      `injected regression on ${injectedSliceId} did not trip/route`,
      {
        obligation: "drift_monitor.route_failed",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  // Idempotent replay of the injection must not double-route.
  const replay = await monitor.recordAndRoute({
    operationId: "inject.regression.1",
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    locality: options.locality,
    channel: "production",
    cycleId,
    sliceId: injectedSliceId,
    score: injectedScore,
  });
  const productionAlerts = routedAlerts.filter(
    (alert) => alert.channel === "production",
  );
  if (
    productionAlerts.length !== 1 ||
    replay.alert?.alertId !== injected.alert.alertId
  ) {
    throw new SliceDriftContractError(
      "injection replay must be idempotent (single alert)",
      {
        obligation: "drift_monitor.idempotent_conflict",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  const production = monitor.snapshot({
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    locality: options.locality,
    channel: "production",
    cycleId,
  });
  const syntheticCanary = monitor.snapshot({
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    locality: options.locality,
    channel: "synthetic-canary",
    cycleId,
  });

  const breachedSlices = production.slices.filter((row) => row.breached);
  if (
    breachedSlices.length !== 1 ||
    breachedSlices[0]?.sliceId !== injectedSliceId
  ) {
    throw new SliceDriftContractError(
      `expected sole breach on ${injectedSliceId}; got [${breachedSlices
        .map((row) => row.sliceId)
        .join(",")}]`,
      {
        obligation: "drift_monitor.invalid_input",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  const aggregate = deriveSliceDriftAggregate(production.slices, {
    ...(options.flatTolerance !== undefined
      ? { flatTolerance: options.flatTolerance }
      : {}),
  });
  if (!aggregate.flat) {
    throw new SliceDriftContractError(
      `derived aggregate is not flat (mean=${aggregate.mean})`,
      {
        obligation: "drift_monitor.invalid_input",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  // Production must not absorb the synthetic-canary zero sample.
  const productionInjected = production.slices.find(
    (row) => row.sliceId === injectedSliceId,
  );
  if (
    productionInjected === undefined ||
    productionInjected.sampleCount !== 2 ||
    syntheticCanary.slices.find((row) => row.sliceId === injectedSliceId)
      ?.sampleCount !== 1
  ) {
    throw new SliceDriftContractError(
      "synthetic-canary must not pollute production drift statistics",
      {
        obligation: "drift_monitor.invalid_input",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  if (
    !events.every(
      (event) =>
        event.subjectId === options.subjectId &&
        event.deviceId === options.deviceId &&
        !Object.keys(event).some((key) =>
          /utterance|content|body|prompt|secret/i.test(key),
        ),
    )
  ) {
    throw new SliceDriftContractError(
      "injection telemetry must stay metadata-only and subject-scoped",
      {
        obligation: "drift_monitor.raw_content_forbidden",
        subjectId: options.subjectId,
        deviceId: options.deviceId,
      },
    );
  }

  return {
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    cycleId,
    injectedSliceId,
    baselineRegistryHash: monitor.baselineRegistryHash,
    production,
    syntheticCanary,
    aggregate,
    routedAlerts: [...routedAlerts],
  };
}
