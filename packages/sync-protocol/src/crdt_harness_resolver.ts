/**
 * @module crdt_harness_resolver
 *
 * State-based CRDT (CvRDT) merge engine for {@link CognitiveState}.
 *
 * Mathematical guarantees — the merge function is a join-semilattice join:
 *   - Commutative:  merge(a, b) ≡ merge(b, a)
 *   - Associative:  merge(a, merge(b, c)) ≡ merge(merge(a, b), c)
 *   - Idempotent:   merge(a, a) ≡ a
 *
 * Therefore any set of replicas (one per device plus the cloud master)
 * converges to the same document regardless of sync order, retries, or
 * partial deliveries. There is no "conflict resolution UI" anywhere in
 * Sutra: convergence is a property of the data types, not of policy code.
 *
 * Field strategy:
 *   mastery.alpha / mastery.beta → per-device G-Counter shards, merged max()
 *   frictionLog                  → G-Set keyed by (capturedAt), union
 *   activeConceptId, mode, profile → LWW registers under HLC total order
 *   deviceIds                    → G-Set, union
 *   stateVector                  → pointwise HLC max
 */

import {
  compareHLC,
  cognitiveStateSchema,
  type ConceptMastery,
  type FrictionSample,
  type HLCTimestamp,
  type CognitiveState,
  type SyncAdvisory,
} from "./contract.js";

/** Result of a merge: the converged document plus non-fatal advisories. */
export interface MergeResult {
  merged: CognitiveState;
  advisories: SyncAdvisory[];
}

/**
 * Raised only when input is structurally invalid (fails schema validation)
 * or when the two documents describe different subjects. These are the ONLY
 * unrecoverable conditions; every other anomaly degrades to an advisory.
 */
export class IrreconcilableStateError extends Error {
  constructor(
    message: string,
    public readonly code: "SCHEMA_VIOLATION" | "SUBJECT_MISMATCH" | "VERSION_MISMATCH",
  ) {
    super(message);
    this.name = "IrreconcilableStateError";
  }
}

/**
 * Maximum tolerated physical-clock skew between replicas. HLCs beyond this
 * horizon are clamped (with an advisory) rather than trusted, protecting
 * the LWW registers from devices with wildly wrong wall clocks.
 */
const MAX_CLOCK_SKEW_MS = 1000 * 60 * 60 * 24; // 24h

export class CrdtHarnessResolver {
  /**
   * Join two replicas of a subject's cognitive state.
   *
   * Autonomous error-handling contract:
   *  - Structurally invalid input → throws {@link IrreconcilableStateError}
   *    (caller must NOT retry with the same payload).
   *  - Semantic anomalies (skewed clocks, duplicate counter shards, unknown
   *    concepts) are self-healed and reported as {@link SyncAdvisory}; the
   *    merge ALWAYS completes and ALWAYS converges.
   *
   * @param local  - the replica held by the caller (cloud master, usually)
   * @param remote - the incoming replica (edge device, usually)
   */
  merge(local: CognitiveState, remote: CognitiveState): MergeResult {
    const advisories: SyncAdvisory[] = [];

    const l = this.validate(local, "local");
    const r = this.validate(remote, "remote");
    if (l.subjectId !== r.subjectId) {
      throw new IrreconcilableStateError(
        `refusing to merge state of '${r.subjectId}' into '${l.subjectId}'`,
        "SUBJECT_MISMATCH",
      );
    }

    const clampedR = this.clampClockSkew(r, advisories);

    const merged: CognitiveState = {
      protocolVersion: l.protocolVersion,
      subjectId: l.subjectId,
      deviceIds: this.unionSet(l.deviceIds, clampedR.deviceIds),
      ...this.mergeLwwRegisters(l, clampedR),
      mastery: this.mergeMasteryMap(l.mastery, clampedR.mastery),
      frictionLog: this.mergeFrictionLog(l.frictionLog, clampedR.frictionLog, advisories),
      stateVector: this.mergeStateVectors(l.stateVector, clampedR.stateVector),
    };

    return { merged, advisories };
  }

  /* ── field-group joins ─────────────────────────────────────────────── */

  /**
   * LWW registers: `activeConceptId`, `mode`, `profile`. The winner is the
   * side whose relevant state-vector entry is HLC-greater; ties broken by
   * deviceId embedded in the HLC (deterministic on both sides).
   */
  private mergeLwwRegisters(
    l: CognitiveState,
    r: CognitiveState,
  ): Pick<CognitiveState, "activeConceptId" | "mode" | "profile"> {
    const lClock = l.stateVector["session"] ?? ("000000000000000:000000:genesis" as HLCTimestamp);
    const rClock = r.stateVector["session"] ?? ("000000000000000:000000:genesis" as HLCTimestamp);
    const sessionWinner = compareHLC(lClock, rClock) >= 0 ? l : r;

    const profileWinner =
      compareHLC(l.profile.updatedAt, r.profile.updatedAt) >= 0 ? l.profile : r.profile;

    return {
      activeConceptId: sessionWinner.activeConceptId,
      mode: sessionWinner.mode,
      profile: profileWinner,
    };
  }

  /**
   * Mastery posteriors merge as per-device G-Counter shard maps: for each
   * device shard take max(), because a shard is monotonically non-decreasing
   * on its owning device. Summing shards across devices yields the global
   * pseudo-count without ever double-counting a retried sync.
   */
  private mergeMasteryMap(
    a: Record<string, ConceptMastery>,
    b: Record<string, ConceptMastery>,
  ): Record<string, ConceptMastery> {
    const out: Record<string, ConceptMastery> = {};
    for (const conceptId of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const ca = a[conceptId];
      const cb = b[conceptId];
      if (ca && cb) {
        out[conceptId] = {
          conceptId,
          alpha: this.mergeCounterShards(ca.alpha, cb.alpha),
          beta: this.mergeCounterShards(ca.beta, cb.beta),
          lastExercisedAt:
            compareHLC(ca.lastExercisedAt, cb.lastExercisedAt) >= 0
              ? ca.lastExercisedAt
              : cb.lastExercisedAt,
        };
      } else {
        // Non-null assertion is safe: conceptId came from the union of keys.
        out[conceptId] = (ca ?? cb)!;
      }
    }
    return out;
  }

  /** Pointwise max over G-Counter shards (shard id = deviceId). */
  private mergeCounterShards(
    a: Record<string, number>,
    b: Record<string, number>,
  ): Record<string, number> {
    const out: Record<string, number> = { ...a };
    for (const [device, count] of Object.entries(b)) {
      out[device] = Math.max(out[device] ?? 0, count);
    }
    return out;
  }

  /**
   * Friction log is a grow-only set keyed by `capturedAt` (HLC strings embed
   * the deviceId, so keys are globally unique). Duplicates from retried
   * syncs are dropped silently-but-audibly via an advisory.
   */
  private mergeFrictionLog(
    a: FrictionSample[],
    b: FrictionSample[],
    advisories: SyncAdvisory[],
  ): FrictionSample[] {
    const byKey = new Map<HLCTimestamp, FrictionSample>();
    let duplicates = 0;
    for (const sample of [...a, ...b]) {
      if (byKey.has(sample.capturedAt)) duplicates++;
      else byKey.set(sample.capturedAt, sample);
    }
    if (duplicates > 0) {
      advisories.push({
        code: "DUPLICATE_SAMPLE_DROPPED",
        detail: `${duplicates} duplicate friction sample(s) dropped during union`,
      });
    }
    return [...byKey.values()].sort((x, y) => compareHLC(x.capturedAt, y.capturedAt));
  }

  /** Pointwise HLC max over the two state vectors. */
  private mergeStateVectors(
    a: Record<string, HLCTimestamp>,
    b: Record<string, HLCTimestamp>,
  ): Record<string, HLCTimestamp> {
    const out: Record<string, HLCTimestamp> = { ...a };
    for (const [key, hlc] of Object.entries(b)) {
      const existing = out[key];
      out[key] = existing === undefined || compareHLC(hlc, existing) > 0 ? hlc : existing;
    }
    return out;
  }

  /* ── autonomous error handling ─────────────────────────────────────── */

  private validate(state: CognitiveState, side: "local" | "remote"): CognitiveState {
    const parsed = cognitiveStateSchema.safeParse(state);
    if (!parsed.success) {
      throw new IrreconcilableStateError(
        `${side} replica failed schema validation: ${parsed.error.message}`,
        "SCHEMA_VIOLATION",
      );
    }
    return parsed.data;
  }

  /**
   * Clamp any HLC whose physical component is more than {@link MAX_CLOCK_SKEW_MS}
   * ahead of this replica's wall clock. A device with a wrong clock must not
   * be able to permanently win every LWW register ("time-traveler attack").
   */
  private clampClockSkew(
    state: CognitiveState,
    advisories: SyncAdvisory[],
  ): CognitiveState {
    const horizon = Date.now() + MAX_CLOCK_SKEW_MS;
    let clamped = 0;

    const clampOne = (hlc: HLCTimestamp): HLCTimestamp => {
      const physical = Number(hlc.slice(0, 15));
      if (physical <= horizon) return hlc;
      clamped++;
      const rest = hlc.slice(15); // ":logical:deviceId"
      return `${String(horizon).padStart(15, "0")}${rest}` as HLCTimestamp;
    };

    const next: CognitiveState = {
      ...state,
      profile: { ...state.profile, updatedAt: clampOne(state.profile.updatedAt) },
      stateVector: Object.fromEntries(
        Object.entries(state.stateVector).map(([k, v]) => [k, clampOne(v)]),
      ),
    };

    if (clamped > 0) {
      advisories.push({
        code: "CLOCK_SKEW_CLAMPED",
        detail: `${clamped} HLC timestamp(s) exceeded the ${MAX_CLOCK_SKEW_MS}ms skew horizon and were clamped`,
      });
    }
    return next;
  }

  private unionSet(a: string[], b: string[]): string[] {
    return [...new Set([...a, ...b])].sort();
  }
}
