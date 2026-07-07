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
 *
 * The edge deliberately runs a *simplified* routing policy (greedy
 * lowest-mastery-prerequisite-first). The full cyclical task router lives
 * in the cloud engine; on reconnect the cloud's routing decisions win the
 * LWW session registers, seamlessly upgrading guidance quality.
 */

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
import { LocalVectorDb, type StorageDriver } from "./local_vector_db.js";
import type { SlmRuntime } from "./slm_runtime.js";

export interface EdgeAgentConfig {
  subjectId: string;
  deviceId: string;
  runtime: SlmRuntime;
  storage: StorageDriver;
  /** Optional: absent transport = permanently-offline sovereign mode. */
  transport?: SyncTransport;
  profile: Omit<CognitiveState["profile"], "updatedAt">;
}

export interface AgentReply {
  text: string;
  conceptId: string;
  /** True when generated fully on-device (always true while offline). */
  servedLocally: boolean;
}

export class EdgeAgent {
  private readonly clock: HlcClock;
  private readonly memory: LocalVectorDb;
  private readonly telemetry: CognitiveTelemetryCollector;
  private readonly syncEngine: SyncEngine | null;
  private state: CognitiveState;

  constructor(private readonly config: EdgeAgentConfig) {
    this.clock = new HlcClock(config.deviceId);
    this.memory = new LocalVectorDb(config.storage);
    this.telemetry = new CognitiveTelemetryCollector(config.storage, this.clock);
    this.syncEngine = config.transport ? new SyncEngine(config.transport) : null;
    this.state = this.genesisState();
  }

  /** Prepare storage and warm the local model. Call once at app start. */
  async initialize(): Promise<void> {
    await this.memory.initialize();
    await this.telemetry.initialize();
    await this.config.runtime.load();
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

  /**
   * Run one agent turn entirely on-device: retrieve relevant memories,
   * assemble the guidance prompt, generate with the local SLM, and fold
   * the accompanying friction sample into local mastery counters.
   */
  async agentTurn(utterance: string, friction: FrictionSample): Promise<AgentReply> {
    const conceptId = this.state.activeConceptId ?? friction.conceptId;

    const queryVector = await this.config.runtime.embed(utterance);
    const memories = await this.memory.search(this.config.subjectId, queryVector, {
      conceptId,
      limit: 4,
    });

    const prompt = this.buildPrompt(utterance, conceptId, memories.map((m) => m.record.text));
    const generation = await this.config.runtime.generate({
      prompt,
      maxTokens: 512,
      temperature: 0.4,
      deadlineMs: 20_000,
    });

    this.foldFriction(friction);

    return { text: generation.text, conceptId, servedLocally: true };
  }

  /**
   * Reconcile with the cloud master. Never throws; the terminal outcome is
   * a value (see SyncEngine's autonomous error-handling doctrine).
   */
  async syncNow(): Promise<SyncOutcome | { status: "offline-mode" }> {
    if (!this.syncEngine) return { status: "offline-mode" };

    const unsynced = await this.telemetry.unsynced();
    const outcome = await this.syncEngine.synchronize({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.config.deviceId,
      edgeState: { ...this.state, frictionLog: unsynced },
      lastKnownCloudVector: this.state.stateVector,
      syncAttemptId: crypto.randomUUID(),
    });

    if (outcome.status === "converged") {
      this.state = outcome.state;
      this.clock.observe(this.state.profile.updatedAt);
      await this.telemetry.markSynced(unsynced.map((s) => s.capturedAt));
    }
    return outcome;
  }

  /* ── internals ─────────────────────────────────────────────────────── */

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

  private buildPrompt(utterance: string, conceptId: string, memories: string[]): string {
    const { ageBand, track, language } = this.state.profile;
    return [
      `You are an autonomous cognitive agent. Subject profile: ${ageBand}, track ${track}, language ${language}.`,
      `Active concept: ${conceptId}. Mode: ${this.state.mode}.`,
      memories.length > 0 ? `Relevant subject history:\n- ${memories.join("\n- ")}` : "",
      `Subject: ${utterance}`,
      `Agent:`,
    ]
      .filter(Boolean)
      .join("\n\n");
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
