/**
 * Deep clone helpers — structuredClone when available; JSON fallback.
 * Never returns shared object graphs with the source.
 */

import type {
  CognitiveRolloutSnapshot,
  SnapshotKnowledgeState,
  SnapshotMasteryState,
  SnapshotMemoryState,
} from "./types.js";
import {
  SNAPSHOT_FRICTION_LIMIT,
  SNAPSHOT_KNOWLEDGE_ID_LIMIT,
  SNAPSHOT_MASTERY_CONCEPT_LIMIT,
  SNAPSHOT_STATE_VECTOR_KEY_LIMIT,
} from "./types.js";

const GENESIS_HLC = "000000000000000:000000:genesis";
const PROTOCOL_VERSION = "1.0.0";

export function deepCloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyKnowledge(): SnapshotKnowledgeState {
  return { connectorIds: [], orderedIds: [] };
}

export function emptyMastery(): SnapshotMasteryState {
  return {};
}

export function emptyMemory(subjectHint?: {
  ageBand?: "child" | "adolescent" | "adult";
  track?: string;
  language?: string;
}): SnapshotMemoryState {
  return {
    frictionLog: [],
    activeConceptId: null,
    mode: "diagnostic",
    profile: {
      ageBand: subjectHint?.ageBand ?? "adult",
      track: subjectHint?.track ?? "gym-rollout",
      language: subjectHint?.language ?? "en",
      updatedAt: GENESIS_HLC,
    },
  };
}

/**
 * Genesis snapshot for a subject at reset when no template is supplied.
 */
export function genesisCognitiveSnapshot(input: {
  subjectId: string;
  deviceId: string;
  episodeId: string;
}): CognitiveRolloutSnapshot {
  return {
    subjectId: input.subjectId,
    deviceIds: [input.deviceId],
    episodeId: input.episodeId,
    protocolVersion: PROTOCOL_VERSION,
    memory: emptyMemory(),
    mastery: emptyMastery(),
    knowledge: emptyKnowledge(),
    stateVector: { session: GENESIS_HLC },
  };
}

export function isSnapshotEmpty(snapshot: CognitiveRolloutSnapshot): boolean {
  return (
    snapshot.memory.frictionLog.length === 0 &&
    Object.keys(snapshot.mastery).length === 0 &&
    snapshot.knowledge.connectorIds.length === 0 &&
    snapshot.knowledge.orderedIds.length === 0
  );
}

export function assertSnapshotBounds(snapshot: CognitiveRolloutSnapshot): {
  ok: true;
} | { ok: false; detail: string } {
  if (snapshot.memory.frictionLog.length > SNAPSHOT_FRICTION_LIMIT) {
    return {
      ok: false,
      detail: `frictionLog exceeds ${SNAPSHOT_FRICTION_LIMIT}`,
    };
  }
  if (Object.keys(snapshot.mastery).length > SNAPSHOT_MASTERY_CONCEPT_LIMIT) {
    return {
      ok: false,
      detail: `mastery concepts exceed ${SNAPSHOT_MASTERY_CONCEPT_LIMIT}`,
    };
  }
  if (
    snapshot.knowledge.connectorIds.length > SNAPSHOT_KNOWLEDGE_ID_LIMIT ||
    snapshot.knowledge.orderedIds.length > SNAPSHOT_KNOWLEDGE_ID_LIMIT
  ) {
    return {
      ok: false,
      detail: `knowledge ids exceed ${SNAPSHOT_KNOWLEDGE_ID_LIMIT}`,
    };
  }
  if (Object.keys(snapshot.stateVector).length > SNAPSHOT_STATE_VECTOR_KEY_LIMIT) {
    return {
      ok: false,
      detail: `stateVector keys exceed ${SNAPSHOT_STATE_VECTOR_KEY_LIMIT}`,
    };
  }
  return { ok: true };
}

/**
 * Deep-clone a template into a new episode-scoped snapshot (no shared refs).
 */
export function cloneCognitiveSnapshot(
  template: CognitiveRolloutSnapshot,
  bind: { subjectId: string; deviceId: string; episodeId: string },
): CognitiveRolloutSnapshot {
  const cloned = deepCloneValue(template);
  return {
    ...cloned,
    subjectId: bind.subjectId,
    deviceIds: Array.from(
      new Set([...(cloned.deviceIds ?? []), bind.deviceId].filter(Boolean)),
    ),
    episodeId: bind.episodeId,
    memory: deepCloneValue(cloned.memory),
    mastery: deepCloneValue(cloned.mastery),
    knowledge: deepCloneValue(cloned.knowledge),
    stateVector: deepCloneValue(cloned.stateVector),
  };
}

export function stateVectorsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i += 1) {
    if (ak[i] !== bk[i]) return false;
    if (a[ak[i]!] !== b[bk[i]!]) return false;
  }
  return true;
}
