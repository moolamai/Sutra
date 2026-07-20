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
 * Maximum tolerated physical-clock skew between replicas (SYNC-02).
 * Shared named constant — mirrored by Python `MAX_CLOCK_SKEW_MS` and the
 * skew-clamp fixture. HLCs beyond Date.now()+this horizon are clamped.
 */
export const MAX_CLOCK_SKEW_MS = 1000 * 60 * 60 * 24; // 24h

/**
 * Deterministic preference when two friction samples share `capturedAt`.
 * Lexicographic max of a key-sorted JSON form — independent of merge order.
 */
function preferFrictionSample(a: FrictionSample, b: FrictionSample): FrictionSample {
  const canon = (s: FrictionSample): string => {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(s).sort()) {
      ordered[key] = s[key as keyof FrictionSample];
    }
    return JSON.stringify(ordered);
  };
  return canon(a) >= canon(b) ? a : b;
}

/** Optional harness configuration for semantic advisory paths (SYNC-06 / SYNC-02). */
export interface CrdtHarnessResolverOptions {
  /**
   * When provided, mastery keys absent from this set emit
   * {@link SyncAdvisory} `UNKNOWN_CONCEPT_QUARANTINED`. Shard bytes stay in
   * the merged document for later adoption — advisories never abort a merge.
   * When omitted, concept-graph checks are skipped (backward compatible).
   */
  knownConceptIds?: Iterable<string>;
  /**
   * Wall-clock "now" in ms for SYNC-02 skew clamp (injectable for fixtures).
   * Defaults to `Date.now()`.
   */
  nowMs?: number;
}

export class CrdtHarnessResolver {
  /** `null` = no graph check (default). */
  private readonly knownConceptIds: ReadonlySet<string> | null;
  private readonly nowMs: number | undefined;

  constructor(options: CrdtHarnessResolverOptions = {}) {
    this.knownConceptIds =
      options.knownConceptIds === undefined
        ? null
        : new Set(options.knownConceptIds);
    this.nowMs = options.nowMs;
  }

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
    const mastery = this.mergeMasteryMap(l.mastery, clampedR.mastery);
    this.quarantineUnknownConcepts(mastery, advisories);
    this.detectStateVectorRegression(l.stateVector, clampedR.stateVector, advisories);

    const merged: CognitiveState = {
      protocolVersion: l.protocolVersion,
      subjectId: l.subjectId,
      deviceIds: this.unionSet(l.deviceIds, clampedR.deviceIds),
      ...this.mergeLwwRegisters(l, clampedR),
      mastery,
      frictionLog: this.mergeFrictionLog(l.frictionLog, clampedR.frictionLog, advisories),
      stateVector: this.mergeStateVectors(l.stateVector, clampedR.stateVector),
    };

    return { merged, advisories };
  }

  /**
   * SYNC-06 / UNKNOWN_CONCEPT_QUARANTINED — report concepts absent from the
   * known task graph without dropping mastery shard evidence.
   */
  private quarantineUnknownConcepts(
    mastery: Record<string, ConceptMastery>,
    advisories: SyncAdvisory[],
  ): void {
    if (this.knownConceptIds === null) return;
    const quarantined = Object.keys(mastery)
      .filter((id) => !this.knownConceptIds!.has(id))
      .sort();
    if (quarantined.length === 0) return;
    advisories.push({
      code: "UNKNOWN_CONCEPT_QUARANTINED",
      detail: `${quarantined.length} unknown conceptId(s) quarantined (evidence preserved): ${quarantined.join(", ")}`,
    });
  }

  /**
   * SYNC-06 / STATE_VECTOR_REGRESSION — submitted vector is strictly dominated
   * by the stored one (≤ on every key, < on at least one). Merge still joins
   * via pointwise HLC max; advisory names the regressed entries.
   */
  private detectStateVectorRegression(
    stored: Record<string, HLCTimestamp>,
    submitted: Record<string, HLCTimestamp>,
    advisories: SyncAdvisory[],
  ): void {
    const genesis = "000000000000000:000000:genesis" as HLCTimestamp;
    const keys = new Set([...Object.keys(stored), ...Object.keys(submitted)]);
    const regressed: string[] = [];
    let submittedAhead = false;
    for (const key of keys) {
      const s = stored[key] ?? genesis;
      const u = submitted[key] ?? genesis;
      const cmp = compareHLC(u, s);
      if (cmp > 0) submittedAhead = true;
      else if (cmp < 0) regressed.push(key);
    }
    if (submittedAhead || regressed.length === 0) return;
    regressed.sort();
    advisories.push({
      code: "STATE_VECTOR_REGRESSION",
      detail: `submitted stateVector strictly dominated by stored; regressed entries: ${regressed.join(", ")}`,
    });
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
    // Use a null-prototype map — shard ids like "toString" must not resolve
    // to Object.prototype methods (breaks commutativity via Math.max(fn, n)).
    const out: Record<string, number> = Object.create(null);
    for (const [device, count] of Object.entries(a)) {
      out[device] = count;
    }
    for (const [device, count] of Object.entries(b)) {
      const existing: number = Object.prototype.hasOwnProperty.call(out, device)
        ? Number(out[device])
        : 0;
      out[device] = Math.max(existing, count);
    }
    return { ...out };
  }

  /**
   * Friction log is a grow-only set keyed by `capturedAt` (HLC strings embed
   * the deviceId, so keys are globally unique under well-formed clocks).
   * Duplicate keys (retried syncs, or adversarial equal-key injection) must
   * resolve deterministically — first-wins over concat order is NOT
   * commutative. We keep the lexicographically greater canonical sample.
   */
  private mergeFrictionLog(
    a: FrictionSample[],
    b: FrictionSample[],
    advisories: SyncAdvisory[],
  ): FrictionSample[] {
    const byKey = new Map<HLCTimestamp, FrictionSample>();
    let duplicates = 0;
    const consider = (sample: FrictionSample) => {
      const existing = byKey.get(sample.capturedAt);
      if (!existing) {
        byKey.set(sample.capturedAt, sample);
        return;
      }
      duplicates++;
      byKey.set(sample.capturedAt, preferFrictionSample(existing, sample));
    };
    for (const sample of a) consider(sample);
    for (const sample of b) consider(sample);
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
   * Advisory detail lists original→clamped pairs (SYNC-02 regression surface).
   */
  private clampClockSkew(
    state: CognitiveState,
    advisories: SyncAdvisory[],
  ): CognitiveState {
    const now = this.nowMs ?? Date.now();
    const horizon = now + MAX_CLOCK_SKEW_MS;
    const pairs: string[] = [];

    const clampOne = (hlc: HLCTimestamp): HLCTimestamp => {
      const physical = Number(hlc.slice(0, 15));
      if (physical <= horizon) return hlc;
      const rest = hlc.slice(15); // ":logical:deviceId"
      const clampedHlc = `${String(horizon).padStart(15, "0")}${rest}` as HLCTimestamp;
      pairs.push(`${hlc}→${clampedHlc}`);
      return clampedHlc;
    };

    const next: CognitiveState = {
      ...state,
      profile: { ...state.profile, updatedAt: clampOne(state.profile.updatedAt) },
      stateVector: Object.fromEntries(
        Object.entries(state.stateVector).map(([k, v]) => [k, clampOne(v)]),
      ),
    };

    if (pairs.length > 0) {
      advisories.push({
        code: "CLOCK_SKEW_CLAMPED",
        detail:
          `${pairs.length} HLC timestamp(s) exceeded the ${MAX_CLOCK_SKEW_MS}ms skew horizon ` +
          `and were clamped; original→clamped: ${pairs.join("; ")}`,
      });
    }
    return next;
  }

  private unionSet(a: string[], b: string[]): string[] {
    return [...new Set([...a, ...b])].sort();
  }
}
