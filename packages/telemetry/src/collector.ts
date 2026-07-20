/**
 * @module collector
 *
 * Friction tracking — the sensory system of cognitive assessment (CAST).
 *
 * The collector observes raw interaction events (keystrokes, deletions,
 * assistance taps, submissions) and folds them into `FrictionSample`s — the
 * protocol-level unit of cognitive-friction evidence. Samples are written
 * to durable storage *before* being acknowledged (write-ahead discipline),
 * so a battery pull mid-session never loses cognitive evidence.
 *
 * Privacy stance: telemetry is behavioral metadata only — latencies,
 * velocities, revision counts. Raw subject keystrokes/content NEVER leave
 * the device through this module.
 */

import type { StorageDriver } from "@moolam/contracts";
import type { ConceptId, FrictionSample, HLCTimestamp } from "@moolam/sync-protocol";
import { HlcClock } from "@moolam/sync-protocol";

/** Raw interaction events the host app feeds the collector. */
export type InteractionEvent =
  | { type: "prompt-rendered"; conceptId: ConceptId; atMs: number }
  | { type: "input"; charsDelta: number; atMs: number }
  | { type: "deletion"; atMs: number }
  | { type: "assistance-requested"; atMs: number }
  | {
      type: "submitted";
      outcome: FrictionSample["outcome"];
      atMs: number;
    };

const TELEMETRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS friction_samples (
  captured_at          TEXT PRIMARY KEY,
  concept_id           TEXT NOT NULL,
  hesitation_ms        INTEGER NOT NULL,
  input_velocity       REAL NOT NULL,
  revision_count       INTEGER NOT NULL,
  assistance_requested INTEGER NOT NULL,
  outcome              TEXT NOT NULL,
  synced               INTEGER NOT NULL DEFAULT 0
)`;

/** Optional seams for deterministic offline-horizon / endurance tests. */
export type CognitiveTelemetryCollectorOptions = {
  /**
   * Injectable wall clock (ms since epoch). Defaults to `Date.now`.
   * Must be non-decreasing for a given collector when paired with
   * {@link HlcClock} — the HLC layer stays monotonic if the wall clock
   * briefly goes backwards (DST edge).
   */
  nowMs?: () => number;
};

/**
 * Per-session friction collector + durable sample log.
 *
 * Lifecycle per exercise:
 *   prompt-rendered → [input/deletion/assistance-requested]* → submitted
 * `submitted` finalizes a sample, persists it, and resets the accumulator.
 */
export class CognitiveTelemetryCollector {
  private current: {
    conceptId: ConceptId;
    renderedAtMs: number;
    firstInputAtMs: number | null;
    charsTyped: number;
    lastInputAtMs: number | null;
    revisionCount: number;
    assistanceRequested: boolean;
  } | null = null;

  private readonly wallNow: () => number;
  /** Cumulative approximate durable bytes (metadata columns only). */
  private approxStoreBytes = 0;
  /** Wall time of the most recent write-ahead persist (ms). */
  private lastPersistMs = 0;

  constructor(
    private readonly driver: StorageDriver,
    private readonly clock: HlcClock,
    options: CognitiveTelemetryCollectorOptions = {},
  ) {
    this.wallNow = options.nowMs ?? Date.now;
  }

  /**
   * Approximate on-disk size of one friction row (primary key + ints + enums).
   * Used by offline-horizon store-growth proofs — never includes utterance text.
   */
  static estimateSampleStoreBytes(sample: FrictionSample): number {
    return (
      String(sample.capturedAt).length +
      String(sample.conceptId).length +
      String(sample.outcome).length +
      48
    );
  }

  /** Current wall time from the injected seam (or `Date.now`). */
  nowMs(): number {
    return this.wallNow();
  }

  /** HLC authority used for `capturedAt` (write-ahead CAST samples). */
  get hlcClock(): HlcClock {
    return this.clock;
  }

  /** Cumulative approximate durable friction store size (bytes). */
  approxDurableStoreBytes(): number {
    return this.approxStoreBytes;
  }

  /** Latency of the most recent CAST write-ahead persist (ms). */
  lastPersistLatencyMs(): number {
    return this.lastPersistMs;
  }

  /** Create the telemetry table. Safe to call on every app launch. */
  async initialize(): Promise<void> {
    await this.driver.execute(TELEMETRY_SCHEMA_SQL);
  }

  /**
   * Ingest one raw event. Events arriving without an open exercise window
   * (e.g. stray input after submission) are dropped by design — partial
   * evidence is worse than no evidence for the Bayesian layer upstream.
   */
  observe(event: InteractionEvent): void {
    if (event.type === "prompt-rendered") {
      this.current = {
        conceptId: event.conceptId,
        renderedAtMs: event.atMs,
        firstInputAtMs: null,
        charsTyped: 0,
        lastInputAtMs: null,
        revisionCount: 0,
        assistanceRequested: false,
      };
      return;
    }
    if (!this.current) return;

    switch (event.type) {
      case "input":
        this.current.firstInputAtMs ??= event.atMs;
        this.current.charsTyped += Math.max(0, event.charsDelta);
        this.current.lastInputAtMs = event.atMs;
        break;
      case "deletion":
        this.current.revisionCount++;
        break;
      case "assistance-requested":
        this.current.assistanceRequested = true;
        break;
    }
  }

  /**
   * Finalize the open exercise into a durable FrictionSample.
   * Returns the sample so the caller can also feed it to the agent turn.
   */
  async submitted(outcome: FrictionSample["outcome"], atMs: number): Promise<FrictionSample | null> {
    const acc = this.current;
    this.current = null;
    if (!acc) return null;

    const activeMs =
      acc.firstInputAtMs !== null && acc.lastInputAtMs !== null
        ? Math.max(1, acc.lastInputAtMs - acc.firstInputAtMs)
        : Math.max(1, atMs - acc.renderedAtMs);

    const sample: FrictionSample = {
      conceptId: acc.conceptId,
      hesitationMs:
        acc.firstInputAtMs !== null
          ? acc.firstInputAtMs - acc.renderedAtMs
          : atMs - acc.renderedAtMs,
      inputVelocity: acc.charsTyped / (activeMs / 1000),
      revisionCount: acc.revisionCount,
      assistanceRequested: acc.assistanceRequested,
      outcome,
      capturedAt: this.clock.tick(),
    };

    await this.persist(sample);
    return sample;
  }

  /** Samples not yet acknowledged by a successful cloud sync. */
  async unsynced(): Promise<FrictionSample[]> {
    const rows = await this.driver.query<{
      captured_at: string;
      concept_id: string;
      hesitation_ms: number;
      input_velocity: number;
      revision_count: number;
      assistance_requested: number;
      outcome: FrictionSample["outcome"];
    }>(`SELECT * FROM friction_samples WHERE synced = 0 ORDER BY captured_at ASC`);

    return rows.map((r) => ({
      conceptId: r.concept_id,
      hesitationMs: r.hesitation_ms,
      inputVelocity: r.input_velocity,
      revisionCount: r.revision_count,
      assistanceRequested: r.assistance_requested === 1,
      outcome: r.outcome,
      capturedAt: r.captured_at as HLCTimestamp,
    }));
  }

  /** Mark samples the cloud has compacted (from SyncResponse) as synced. */
  async markSynced(timestamps: HLCTimestamp[]): Promise<void> {
    for (const ts of timestamps) {
      await this.driver.execute(`UPDATE friction_samples SET synced = 1 WHERE captured_at = ?`, [ts]);
    }
  }

  /**
   * Durable CAST sample count via a single aggregate query — never materializes
   * the friction log (keeps horizon / soak checks O(1) in result size).
   */
  async durableSampleCount(): Promise<number> {
    const rows = await this.driver.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM friction_samples`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Offline-horizon integrity probe: aggregates + HLC edge keys only.
   * Never `SELECT *` the friction table (no unbounded materialization).
   */
  async castIntegrityProbe(): Promise<{
    durableCount: number;
    unsyncedCount: number;
    earliestCapturedAt: HLCTimestamp | null;
    latestCapturedAt: HLCTimestamp | null;
  }> {
    const durableCount = await this.durableSampleCount();
    const unsyncedRows = await this.driver.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM friction_samples WHERE synced = 0`,
    );
    const earliest = await this.driver.query<{ captured_at: string }>(
      `SELECT captured_at FROM friction_samples ORDER BY captured_at ASC LIMIT 1`,
    );
    const latest = await this.driver.query<{ captured_at: string }>(
      `SELECT captured_at FROM friction_samples ORDER BY captured_at DESC LIMIT 1`,
    );
    return {
      durableCount,
      unsyncedCount: Number(unsyncedRows[0]?.n ?? 0),
      earliestCapturedAt: (earliest[0]?.captured_at as HLCTimestamp) ?? null,
      latestCapturedAt: (latest[0]?.captured_at as HLCTimestamp) ?? null,
    };
  }

  private async persist(sample: FrictionSample): Promise<void> {
    const started = performance.now();
    await this.driver.execute(
      `INSERT OR IGNORE INTO friction_samples
        (captured_at, concept_id, hesitation_ms, input_velocity, revision_count, assistance_requested, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        sample.capturedAt,
        sample.conceptId,
        sample.hesitationMs,
        sample.inputVelocity,
        sample.revisionCount,
        sample.assistanceRequested ? 1 : 0,
        sample.outcome,
      ],
    );
    this.lastPersistMs = performance.now() - started;
    // INSERT OR IGNORE is idempotent; still account once per successful submit call.
    this.approxStoreBytes += CognitiveTelemetryCollector.estimateSampleStoreBytes(
      sample,
    );
  }
}
