/**
 * Canonicalization + merge-safe HLC rewrite helpers for the TS merge law suite.
 * Kept separate from merge_laws.test.mjs so helpers can be imported without
 * registering node:test cases.
 */

/** Keep generated HLCs inside the resolver's 24h skew horizon. */
export const MERGE_SAFE_PHYSICAL_MAX = () => Date.now() + 60 * 60 * 1000; // +1h

/**
 * Canonical JSON for join-semilattice equality (not object identity):
 * deep key sort + sorted deviceIds + frictionLog ordered by capturedAt.
 */
export function canonicalizeState(state) {
  const sortedFriction = [...(state.frictionLog ?? [])].sort((a, b) =>
    a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0,
  );
  const normalized = {
    ...state,
    deviceIds: [...(state.deviceIds ?? [])].sort(),
    frictionLog: sortedFriction,
  };
  return JSON.stringify(sortKeysDeep(normalized));
}

export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/** Rewrite every HLC string's physical component into the merge-safe window. */
export function makeMergeSafe(state, maxPhysical = MERGE_SAFE_PHYSICAL_MAX()) {
  const rewrite = (hlc) => {
    if (typeof hlc !== "string" || hlc.length < 22) return hlc;
    const physical = Number(hlc.slice(0, 15));
    if (!Number.isFinite(physical) || physical <= maxPhysical) return hlc;
    return `${String(maxPhysical).padStart(15, "0")}${hlc.slice(15)}`;
  };

  return {
    ...state,
    profile: {
      ...state.profile,
      updatedAt: rewrite(state.profile.updatedAt),
    },
    mastery: Object.fromEntries(
      Object.entries(state.mastery).map(([k, m]) => [
        k,
        { ...m, lastExercisedAt: rewrite(m.lastExercisedAt) },
      ]),
    ),
    frictionLog: state.frictionLog.map((s) => ({
      ...s,
      capturedAt: rewrite(s.capturedAt),
    })),
    stateVector: Object.fromEntries(
      Object.entries(state.stateVector).map(([k, v]) => [k, rewrite(v)]),
    ),
  };
}

/**
 * Left-fold pairwise merges over a replica array (identity = first replica).
 * @param {{ merge: (a: object, b: object) => { merged: object } }} resolver
 * @param {object[]} replicas — length ≥ 1, same subjectId
 */
export function foldMerge(resolver, replicas) {
  if (replicas.length === 0) {
    throw new Error("FOLD_MERGE_EMPTY: need at least one replica");
  }
  let acc = replicas[0];
  for (let i = 1; i < replicas.length; i++) {
    acc = resolver.merge(acc, replicas[i]).merged;
  }
  return acc;
}

/**
 * Apply the SyncResponse compactedSampleTimestamps handshake: edge may drop
 * those friction samples from its local log once the merged document is adopted.
 * @param {object} state
 * @param {string[]} compactedSampleTimestamps
 */
export function applyCompactionHandshake(state, compactedSampleTimestamps) {
  const drop = new Set(compactedSampleTimestamps);
  return {
    ...state,
    frictionLog: (state.frictionLog ?? []).filter((s) => !drop.has(s.capturedAt)),
  };
}

/**
 * Fold with mid-stream compaction handshake: after the first `splitAt` replicas
 * are merged, announce their friction timestamps as compacted and prune those
 * keys from the remaining replicas before continuing the fold.
 *
 * @param {{ merge: (a: object, b: object) => { merged: object } }} resolver
 * @param {object[]} replicas
 * @param {number} [splitAt]
 */
export function foldMergeWithCompactionHandshake(resolver, replicas, splitAt = 1) {
  if (replicas.length === 0) {
    throw new Error("FOLD_MERGE_EMPTY: need at least one replica");
  }
  const cut = Math.min(Math.max(1, splitAt), replicas.length - 1);
  let mid = foldMerge(resolver, replicas.slice(0, cut + 1));
  const compactedSampleTimestamps = mid.frictionLog.map((s) => s.capturedAt);
  const remaining = replicas
    .slice(cut + 1)
    .map((r) => applyCompactionHandshake(r, compactedSampleTimestamps));
  for (const next of remaining) {
    mid = resolver.merge(mid, next).merged;
  }
  return { merged: mid, compactedSampleTimestamps };
}

/**
 * Deterministic Fisher–Yates from a uint32 seed (avoids uniqueArray rejection
 * sampling on index permutations).
 */
export function permuteFromSeed(n, seed) {
  const arr = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Apply an index permutation to a replica array. */
export function permuteReplicas(replicas, order) {
  return order.map((i) => replicas[i]);
}
