/**
 * @module edge_agent
 *
 * The Edge Harness façade — the one class an app developer instantiates to
 * get a fully offline autonomous cognitive agent on-device.
 *
 * Composition:
 *   SlmRuntime                 → local brain (Phi-3 / Gemma / quantized)
 *   LocalVectorDb              → offline long-term memory (MCE mirror)
 *   CognitiveTelemetryCollector→ friction sensing (edge half of assessment)
 *   SyncEngine                 → CRDT reconciliation on connectivity
 *   EventBusInterface          → domain lifecycle / turn / sync events
 *
 * The edge deliberately runs a *simplified* routing policy (greedy
 * lowest-mastery-prerequisite-first). The full cyclical task router lives
 * in the cloud engine; on reconnect the cloud's routing decisions win the
 * LWW session registers, seamlessly upgrading guidance quality.
 *
 * {@link buildCognitiveBindings} assembles CognitiveBindings
 * from SlmRuntime + LocalVectorDb adapters.
 * {@link agentTurn} delegates to CognitiveCore.turn (no
 * legacy embed→vector→SlmRuntime.generate bypass in this file).
 */

import { CognitiveCore } from "@moolam/cognitive-core";
import type {
  EventBusInterface,
  SpeechInterface,
  VisionInterface,
} from "@moolam/contracts";
import {
  HlcClock,
  SyncEngine,
  type FrictionSample,
  type CognitiveState,
  type SyncOutcome,
  type SyncTransport,
  PROTOCOL_VERSION,
} from "@moolam/sync-protocol";
import { CognitiveTelemetryCollector } from "@moolam/telemetry";
import {
  EDGE_LIFECYCLE_READY,
  getObservability,
  publishSyncOutcome,
  publishTurnCompleted,
  wireEdgeAgentEventBus,
  type WireEdgeAgentEventBusOptions,
} from "@moolam/observability";
import {
  createEdgeCognitiveBindings,
  type CreateEdgeCognitiveBindingsOptions,
  type EdgeCognitiveBindingsBundle,
} from "./cognitive_bindings.js";
import { LocalVectorDb, type StorageDriver } from "./local_vector_db.js";
import type { SlmRuntime } from "./slm_runtime.js";
import type { EdgeTrajectoryCaptureWriter } from "./trajectory_capture.js";

export interface EdgeAgentConfig {
  subjectId: string;
  deviceId: string;
  runtime: SlmRuntime;
  storage: StorageDriver;
  /** Optional: absent transport = permanently-offline sovereign mode. */
  transport?: SyncTransport;
  profile: Omit<CognitiveState["profile"], "updatedAt">;
  /**
   * Optional local STT/TTS binding. When set, {@link buildCognitiveBindings}
   * and {@link agentTurn} inject it into the CognitiveBindings set.
   */
  speech?: SpeechInterface;
  /**
   * Optional local VLM binding. When set, {@link buildCognitiveBindings}
   * and {@link agentTurn} inject it into the CognitiveBindings set.
   */
  vision?: VisionInterface;
  /**
   * Optional EventBus . Defaults to an in-process bus via
   * {@link wireEdgeAgentEventBus}. Inject a validating bus when hosts want
   * Catalog-strict turn/sync publishes (+).
   */
  eventBus?: EventBusInterface;
  /**
   * When true (default), subscribe turn/tool bus events onto active OTel spans.
   */
  attachEventBusSpans?: boolean;
  /**
   * Injectable wall clock (ms since epoch). Defaults to `Date.now`.
   * Shared by HLC physical ticks, CognitiveTelemetryCollector, and
   * LocalVectorDb episodic decay so offline-horizon proofs can advance
   * simulated days without waiting on wall time.
   */
  nowMs?: () => number;
  /**
   * Hard cap on LocalVectorDb working-set scans (MCE-02). Defaults inside
   * LocalVectorDb (50k). Horizon proofs lower this to exercise pin/prune.
   */
  maxResidentVectors?: number;
  /**
   * Optional subject-bound trajectory hook. Absence means capture is disabled;
   * the hook itself resolves active consent and skips when none exists.
   */
  trajectoryCaptureWriter?: EdgeTrajectoryCaptureWriter;
  /**
   * Default SLM generate deadline (ms) for cognitive turns. Defaults to 30s in
   * the model adapter; live local backends (Ollama cold start) may need more.
   */
  modelDefaultDeadlineMs?: number;
}

export interface AgentReply {
  text: string;
  conceptId: string;
  /** True when generated fully on-device (always true while offline). */
  servedLocally: boolean;
}

/**
 * EventBus type for NFR-02 offline-horizon proof summaries (metadata only).
 * Mirrors {@link EDGE_LIFECYCLE_READY}: host-visible, not a Zod catalog type.
 */
export const EDGE_NFR02_PROOF = "edge.nfr02.proof" as const;

/**
 * Committed expected ranges for the NFR-02 offline-horizon proof gate.
 * Integration harness asserts measured summaries stay within these ceilings.
 */
export const NFR02_PROOF_THRESHOLDS = Object.freeze({
  nfrId: "NFR-02" as const,
  nfrTitle: "Offline operation horizon with zero degradation of CAST capture",
  foldP95MsMax: 2,
  castPersistP95MsMax: 5,
  turnP95MsMax: 40,
  storeBytesPerSampleMax: 512,
  wallMsMax: 120_000,
  turnsPerDayMin: 1,
});

/** Input metrics from a completed offline-horizon simulation (no raw content). */
export type Nfr02ProofMetricsInput = {
  turns: number;
  days: number;
  turnsPerDay: number;
  foldP95Ms: number;
  castPersistP95Ms: number;
  turnP95Ms: number;
  storeBytes: number;
  durableSampleCount: number;
  wallMs: number;
};

export type Nfr02ProofRecord = Nfr02ProofMetricsInput & {
  subjectId: string;
  deviceId: string;
  nfrId: "NFR-02";
  outcome: "ok" | "budget_breached" | "validation_failed";
  breachCodes: readonly string[];
  locality: "on-device";
};

export class EdgeAgent {
  private readonly clock: HlcClock;
  private readonly memory: LocalVectorDb;
  private readonly telemetry: CognitiveTelemetryCollector;
  private readonly syncEngine: SyncEngine | null;
  private readonly eventBus: EventBusInterface;
  private readonly disposeEventBus: () => void;
  private readonly wallNow: () => number;
  private state: CognitiveState;
  private lifecycleReadyPublished = false;
  /** Serializes agentTurn RMW on mastery for one subject (this instance). */
  private turnChain: Promise<unknown> = Promise.resolve();
  /** Wall time of the most recent foldFriction call (ms). */
  private lastFoldMs = 0;

  constructor(private readonly config: EdgeAgentConfig) {
    this.wallNow = config.nowMs ?? Date.now;
    this.clock = new HlcClock(config.deviceId, this.wallNow);
    const vectorOpts: { nowMs: () => number; maxResidentVectors?: number } = {
      nowMs: this.wallNow,
    };
    if (config.maxResidentVectors !== undefined) {
      vectorOpts.maxResidentVectors = config.maxResidentVectors;
    }
    this.memory = new LocalVectorDb(config.storage, vectorOpts);
    this.telemetry = new CognitiveTelemetryCollector(config.storage, this.clock, {
      nowMs: this.wallNow,
    });
    this.syncEngine = config.transport ? new SyncEngine(config.transport) : null;
    this.state = this.genesisState();

    const wireOpts: WireEdgeAgentEventBusOptions = {};
    if (config.eventBus !== undefined) wireOpts.eventBus = config.eventBus;
    if (config.attachEventBusSpans !== undefined) {
      wireOpts.attachToSpans = config.attachEventBusSpans;
    }
    const wired = wireEdgeAgentEventBus(wireOpts);
    this.eventBus = wired.bus;
    this.disposeEventBus = wired.dispose;
  }

  /** Runtime EventBus used for lifecycle / turn / sync domain events. */
  get bus(): EventBusInterface {
    return this.eventBus;
  }

  /** Prepare storage and warm the local model. Call once at app start. */
  async initialize(): Promise<void> {
    await this.memory.initialize();
    await this.telemetry.initialize();
    if (this.config.trajectoryCaptureWriter) {
      await this.config.trajectoryCaptureWriter.initialize();
    }
    // SlmRuntime.load may throw SlmRuntimeInitError (missing/corrupt weights).
    // Surfaced to the host — no ready event, no harness-level retry loop.
    await this.config.runtime.load();
    // Lifecycle event after durable side effects — never before acknowledgment.
    this.publishLifecycleReady();
  }

  /**
   * Detach OTel bus subscription. Safe to call multiple times. Does not
   * dispose host-injected buses.
   */
  dispose(): void {
    this.disposeEventBus();
  }

  get telemetryCollector(): CognitiveTelemetryCollector {
    return this.telemetry;
  }

  get vectorDb(): LocalVectorDb {
    return this.memory;
  }

  get cognitiveState(): Readonly<CognitiveState> {
    return this.state;
  }

  /** Wall clock shared by HLC / telemetry / vector decay (injected or `Date.now`). */
  wallNowMs(): number {
    return this.wallNow();
  }

  /** HLC authority for this device (physical ticks follow {@link wallNowMs}). */
  get hlcClock(): HlcClock {
    return this.clock;
  }

  /**
   * Latency of the most recent Bayesian friction fold into mastery (ms).
   * Zero until the first successful agentTurn; used by offline-horizon proofs.
   */
  lastFrictionFoldLatencyMs(): number {
    return this.lastFoldMs;
  }

  /**
   * Mastery G-Counter shard summary for offline-horizon integrity checks.
   * Structured fields only — never includes learner utterance / sample bodies.
   */
  masteryShardSummary(): {
    subjectId: string;
    deviceId: string;
    conceptCount: number;
    totalAlpha: number;
    totalBeta: number;
    /** True when any shard is negative or non-finite (posterior corruption). */
    corrupt: boolean;
    /** False when any defined posterior mean falls outside [0, 1]. */
    meansInRange: boolean;
  } {
    const deviceId = this.config.deviceId;
    let totalAlpha = 0;
    let totalBeta = 0;
    let corrupt = false;
    let meansInRange = true;
    const mastery = this.state.mastery;
    for (const entry of Object.values(mastery)) {
      const a = entry.alpha[deviceId] ?? 0;
      const b = entry.beta[deviceId] ?? 0;
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
        corrupt = true;
      }
      totalAlpha += a;
      totalBeta += b;
      const den = a + b;
      if (den > 0) {
        const mean = a / den;
        if (!(mean >= 0 && mean <= 1)) meansInRange = false;
      }
      for (const v of Object.values(entry.alpha)) {
        if (!Number.isFinite(v) || v < 0) corrupt = true;
      }
      for (const v of Object.values(entry.beta)) {
        if (!Number.isFinite(v) || v < 0) corrupt = true;
      }
    }
    return {
      subjectId: this.config.subjectId,
      deviceId,
      conceptCount: Object.keys(mastery).length,
      totalAlpha,
      totalBeta,
      corrupt,
      meansInRange,
    };
  }

  /**
   * Emit NFR-02 offline-horizon proof summary via EventBus + OTel (when inited).
   * Metadata only — never utterance / reply bodies. Exporter failures never
   * block the proof path (drop counter / no-op when observability is absent).
   */
  recordNfr02ProofMetrics(input: Nfr02ProofMetricsInput): Nfr02ProofRecord {
    const breachCodes: string[] = [];
    const finiteNonNeg = (n: unknown): n is number =>
      typeof n === "number" && Number.isFinite(n) && n >= 0;

    if (
      !finiteNonNeg(input.turns) ||
      !finiteNonNeg(input.days) ||
      !finiteNonNeg(input.turnsPerDay) ||
      !finiteNonNeg(input.foldP95Ms) ||
      !finiteNonNeg(input.castPersistP95Ms) ||
      !finiteNonNeg(input.turnP95Ms) ||
      !finiteNonNeg(input.storeBytes) ||
      !finiteNonNeg(input.durableSampleCount) ||
      !finiteNonNeg(input.wallMs) ||
      input.turns < 1 ||
      input.days < 1
    ) {
      const err = new Error(
        "NFR-02 proof metrics validation failed: require finite non-negative fields",
      );
      (err as Error & { failureClass?: string }).failureClass =
        "validation_failed";
      throw err;
    }

    const t = NFR02_PROOF_THRESHOLDS;
    if (input.foldP95Ms > t.foldP95MsMax) breachCodes.push("fold_p95");
    if (input.castPersistP95Ms > t.castPersistP95MsMax) {
      breachCodes.push("cast_persist_p95");
    }
    if (input.turnP95Ms > t.turnP95MsMax) breachCodes.push("turn_p95");
    if (input.wallMs > t.wallMsMax) breachCodes.push("wall_ms");
    if (input.turnsPerDay < t.turnsPerDayMin) breachCodes.push("turns_per_day");
    if (
      input.durableSampleCount > 0 &&
      input.storeBytes / input.durableSampleCount > t.storeBytesPerSampleMax
    ) {
      breachCodes.push("store_bytes_per_sample");
    }
    if (input.durableSampleCount !== input.turns) {
      breachCodes.push("cast_capture_drop");
    }

    const outcome: Nfr02ProofRecord["outcome"] =
      breachCodes.length === 0 ? "ok" : "budget_breached";

    const record: Nfr02ProofRecord = {
      ...input,
      subjectId: this.config.subjectId,
      deviceId: this.config.deviceId,
      nfrId: "NFR-02",
      outcome,
      breachCodes,
      locality: "on-device",
    };

    this.eventBus.publish({
      type: EDGE_NFR02_PROOF,
      at: new Date().toISOString(),
      payload: {
        subjectId: record.subjectId,
        deviceId: record.deviceId,
        nfrId: record.nfrId,
        outcome: record.outcome,
        locality: record.locality,
        turns: record.turns,
        days: record.days,
        turnsPerDay: record.turnsPerDay,
        foldP95Ms: record.foldP95Ms,
        castPersistP95Ms: record.castPersistP95Ms,
        turnP95Ms: record.turnP95Ms,
        storeBytes: record.storeBytes,
        durableSampleCount: record.durableSampleCount,
        wallMs: record.wallMs,
        breachCodes: [...record.breachCodes],
      },
    });

    this.emitNfr02Otel(record);
    return record;
  }

  /** Best-effort OTel span + histograms; never throws into the proof path. */
  private emitNfr02Otel(record: Nfr02ProofRecord): void {
    try {
      const obs = getObservability();
      if (!obs) return;

      const attrs = {
        "sutra.subject_id": record.subjectId,
        "sutra.device_id": record.deviceId,
        "sutra.nfr_id": record.nfrId,
        "sutra.outcome": record.outcome,
        "sutra.locality": record.locality,
        "sutra.turns": record.turns,
        "sutra.days": record.days,
        "sutra.turns_per_day": record.turnsPerDay,
        "sutra.fold_p95_ms": record.foldP95Ms,
        "sutra.cast_persist_p95_ms": record.castPersistP95Ms,
        "sutra.turn_p95_ms": record.turnP95Ms,
        "sutra.store_bytes": record.storeBytes,
        "sutra.durable_sample_count": record.durableSampleCount,
        "sutra.wall_ms": record.wallMs,
        "sutra.breach_codes": record.breachCodes.join(",") || "none",
      };

      const span = obs.tracer.startSpan("sutra.nfr02.proof", {
        attributes: attrs,
      });
      try {
        const foldHist = obs.meter.createHistogram(
          "sutra.nfr02.fold_p95_ms",
          { description: "NFR-02 friction fold p95 (ms)" },
        );
        const storeHist = obs.meter.createHistogram(
          "sutra.nfr02.store_bytes",
          { description: "NFR-02 durable friction store bytes" },
        );
        const turnsHist = obs.meter.createHistogram(
          "sutra.nfr02.turns_per_day",
          { description: "NFR-02 simulated turns per day" },
        );
        const meterAttrs = {
          "sutra.subject_id": record.subjectId,
          "sutra.device_id": record.deviceId,
          "sutra.nfr_id": record.nfrId,
        };
        foldHist.record(record.foldP95Ms, meterAttrs);
        storeHist.record(record.storeBytes, meterAttrs);
        turnsHist.record(record.turnsPerDay, meterAttrs);
        span.setAttribute(
          "sutra.outcome",
          record.outcome === "ok" ? "ok" : "budget_breached",
        );
      } finally {
        span.end();
      }
    } catch {
      // Exporter / meter failure must never block NFR proofs or turns.
    }
  }

  /**
   * Assemble CognitiveBindings from this agent's edge
   * config + adapters. Does not invoke CognitiveCore.turn (002).
   */
  buildCognitiveBindings(
    overrides: Partial<
      Omit<
        CreateEdgeCognitiveBindingsOptions,
        "subjectId" | "deviceId" | "runtime" | "vectorDb"
      >
    > = {},
  ): EdgeCognitiveBindingsBundle {
    return createEdgeCognitiveBindings({
      subjectId: this.config.subjectId,
      deviceId: this.config.deviceId,
      runtime: this.config.runtime,
      vectorDb: this.memory,
      track: this.state.profile.track,
      language: this.state.profile.language,
      activeConceptId: this.state.activeConceptId,
      locality: "on-device",
      ...(this.config.modelDefaultDeadlineMs !== undefined
        ? { defaultDeadlineMs: this.config.modelDefaultDeadlineMs }
        : {}),
      ...(this.config.speech ? { speech: this.config.speech } : {}),
      ...(this.config.vision ? { vision: this.config.vision } : {}),
      ...overrides,
    });
  }

  /**
   * Run one agent turn entirely on-device via CognitiveCore .
   * Fold friction only after a successful core turn; mid-turn throws emit
   * nothing (CAST-01 discard). Public AgentReply shape is unchanged —
   * never put reply text on the bus.
   */
  async agentTurn(
    utterance: string,
    friction: FrictionSample,
  ): Promise<AgentReply> {
    const prior = this.turnChain;
    let release!: () => void;
    this.turnChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior.catch(() => {});
    try {
      return await this.runCognitiveAgentTurn(utterance, friction);
    } finally {
      release();
    }
  }

  private async runCognitiveAgentTurn(
    utterance: string,
    friction: FrictionSample,
  ): Promise<AgentReply> {
    const startedMs = performance.now();
    const turnId = crypto.randomUUID();
    const conceptId = this.state.activeConceptId ?? friction.conceptId;
    const sessionId = `edge.${this.config.deviceId}.${this.config.subjectId}`;

    const { bindings, profile } = this.buildCognitiveBindings({
      activeConceptId: conceptId,
    });
    const core = new CognitiveCore(profile, bindings, {
      eventBus: this.eventBus,
    });

    let out;
    try {
      out = await core.turn({
        subjectId: this.config.subjectId,
        sessionId,
        utterance,
      });
    } catch (err) {
      // Friction not folded; no turn.completed.
      throw err;
    }

    // Durable side effect first — bus event never precedes acknowledgment.
    const foldStarted = performance.now();
    this.foldFriction(friction);
    this.lastFoldMs = performance.now() - foldStarted;

    const reply: AgentReply = {
      text: out.reply,
      conceptId,
      servedLocally: true,
    };
    if (this.config.trajectoryCaptureWriter) {
      try {
        this.config.trajectoryCaptureWriter.captureAfterReflect({
          turnId,
          subjectId: this.config.subjectId,
          deviceId: this.config.deviceId,
          sessionId,
          capturedAt: friction.capturedAt,
          utterance,
          reply: out.reply,
          modelId: this.config.runtime.card.modelId,
          declined: out.declined,
        });
      } catch (error: unknown) {
        console.error(
          JSON.stringify({
            event: "edge_agent.trajectory_capture",
            outcome: "rejected",
            subjectId: this.config.subjectId,
            deviceId: this.config.deviceId,
            failureClass:
              error instanceof Error
                ? error.name.slice(0, 64)
                : "capture_hook_failed",
          }),
        );
      }
    }
    publishTurnCompleted(this.eventBus, {
      subjectId: this.config.subjectId,
      deviceId: this.config.deviceId,
      conceptId,
      latencyMs: performance.now() - startedMs,
      servedLocally: reply.servedLocally,
      turnId,
    });
    return reply;
  }

  /**
   * Reconcile with the cloud master. Never throws; the terminal outcome is
   * a value (see SyncEngine's autonomous error-handling doctrine).
   *
   * After durable apply (converged) or terminal non-apply, publishes
   * Catalog-valid `sync.outcome` — never CognitiveState.
   * Permanently offline (no transport) still emits `skipped-offline`.
   */
  async syncNow(): Promise<SyncOutcome | { status: "offline-mode" }> {
    const startedMs = performance.now();
    const syncAttemptId = crypto.randomUUID();

    if (!this.syncEngine) {
      publishSyncOutcome(this.eventBus, {
        subjectId: this.config.subjectId,
        deviceId: this.config.deviceId,
        syncAttemptId,
        outcome: "skipped-offline",
        attempts: 0,
        durationMs: performance.now() - startedMs,
        advisoryCodes: [],
      });
      return { status: "offline-mode" };
    }

    const unsynced = await this.telemetry.unsynced();
    const outcome = await this.syncEngine.synchronize({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.config.deviceId,
      edgeState: { ...this.state, frictionLog: unsynced },
      lastKnownCloudVector: this.state.stateVector,
      syncAttemptId,
    });

    if (outcome.status === "converged") {
      this.state = outcome.state;
      this.clock.observe(this.state.profile.updatedAt);
      await this.telemetry.markSynced(unsynced.map((s) => s.capturedAt));
    }

    // Bus event after durable write (converged) or after terminal non-apply.
    const publishArgs: {
      subjectId: string;
      deviceId: string;
      syncAttemptId: string;
      outcome: "converged" | "quarantined" | "exhausted" | "skipped-offline";
      attempts: number;
      durationMs: number;
      advisoryCodes: readonly string[];
      quarantineCode?: string;
      exhaustedCode?: string;
      httpStatus?: number;
    } = {
      subjectId: this.config.subjectId,
      deviceId: this.config.deviceId,
      syncAttemptId,
      outcome: outcome.status,
      attempts: outcome.attempts,
      durationMs: performance.now() - startedMs,
      advisoryCodes: outcome.advisoryCodes,
    };
    if (outcome.status === "quarantined") {
      publishArgs.quarantineCode = outcome.reasonCode;
      publishArgs.httpStatus = outcome.httpStatus;
    } else if (outcome.status === "exhausted") {
      publishArgs.exhaustedCode = outcome.reasonCode;
    }
    publishSyncOutcome(this.eventBus, publishArgs);
    return outcome;
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  private publishLifecycleReady(): void {
    if (this.lifecycleReadyPublished) return;
    this.lifecycleReadyPublished = true;
    this.eventBus.publish({
      type: EDGE_LIFECYCLE_READY,
      at: new Date().toISOString(),
      payload: {
        subjectId: this.config.subjectId,
        deviceId: this.config.deviceId,
        outcome: "ok",
        // Operator visibility: permanently offline vs transport-attached.
        connectivity: this.syncEngine ? "online-capable" : "offline-mode",
      },
    });
  }

  /** Bayesian update: fold one friction sample into the mastery G-Counters. */
  private foldFriction(sample: FrictionSample): void {
    const device = this.config.deviceId;
    const entry = (this.state.mastery[sample.conceptId] ??= {
      conceptId: sample.conceptId,
      alpha: {},
      beta: {},
      lastExercisedAt: sample.capturedAt,
    });

    // Evidence weighting: a slow, hint-assisted correct answer is weaker
    // mastery evidence than a fluent one. Friction modulates the increment.
    const fluency = sample.hesitationMs < 3000 && sample.revisionCount <= 1 ? 1.0 : 0.5;
    if (sample.outcome === "correct") {
      entry.alpha[device] = (entry.alpha[device] ?? 0) + fluency;
    } else if (sample.outcome === "incorrect") {
      entry.beta[device] = (entry.beta[device] ?? 0) + 1;
    } else if (sample.outcome === "partial") {
      entry.alpha[device] = (entry.alpha[device] ?? 0) + 0.5 * fluency;
      entry.beta[device] = (entry.beta[device] ?? 0) + 0.5;
    }
    entry.lastExercisedAt = sample.capturedAt;
    this.state.stateVector["session"] = this.clock.tick();
  }

  private genesisState(): CognitiveState {
    const now = this.clock.tick();
    return {
      protocolVersion: PROTOCOL_VERSION,
      subjectId: this.config.subjectId,
      deviceIds: [this.config.deviceId],
      activeConceptId: null,
      mode: "diagnostic",
      mastery: {},
      frictionLog: [],
      profile: { ...this.config.profile, updatedAt: now },
      stateVector: { session: now },
    };
  }
}
