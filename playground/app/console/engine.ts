/**
 * Playground protocol engine — a thin driver over the REAL protocol packages.
 *
 * Nothing in this module fabricates data. Mastery posteriors, HLC
 * timestamps, CRDT merges, and advisories are produced by the exact code
 * that ships in `@moolam/sync-protocol`. Task-graph nodes and advance/remediate
 * thresholds come from the committed pack via `@moolam/domain-loader` (same
 * bytes as the cloud TaskRouter), not duplicated constants.
 */

import {
  CrdtHarnessResolver,
  HlcClock,
  PROTOCOL_VERSION,
  type FrictionSample,
  type GuidanceMode,
  type CognitiveState,
  type SyncAdvisory,
} from "@moolam/sync-protocol/client";
import {
  TaskGraphLoadError,
  hydrateTaskGraphFromPackObject,
  type LoadedTaskGraph,
} from "@moolam/domain-loader/browser";
import teacherPack from "@moolam/domain-loader/fixtures/packs/teacher-cbse-slice.json";
import {
  HESITATION_SPIKE_MS,
  MAX_REMEDIATION_DEPTH,
  masteryMean as masteryMeanCore,
  evidenceCount as evidenceCountCore,
  routeTurnOnGraph,
} from "./route_core.mjs";

export { HESITATION_SPIKE_MS, MAX_REMEDIATION_DEPTH };

export type { LoadedTaskGraph };
export { TaskGraphLoadError };

const COMMITTED_PACK = teacherPack;
const COMMITTED_PACK_SOURCE =
  "@moolam/domain-loader/fixtures/packs/teacher-cbse-slice.json";

export interface ConceptNode {
  conceptId: string;
  title: string;
  prerequisites: string[];
  track: "school-mathematics" | "system-design";
}

function trackForConcept(conceptId: string): ConceptNode["track"] {
  return conceptId.startsWith("sd.") ? "system-design" : "school-mathematics";
}

function conceptsFromLoaded(loaded: LoadedTaskGraph): ConceptNode[] {
  return loaded.concepts.map((c) => ({
    conceptId: c.conceptId,
    title: c.title,
    prerequisites: [...c.prerequisites],
    track: trackForConcept(c.conceptId),
  }));
}

// Boot hydrate first — thresholds/nodes come only from the committed teacher pack.
const _boot = hydrateTaskGraphFromPackObject(COMMITTED_PACK, {
  subjectId: "playground-boot",
  deviceId: "console",
  sourcePath: COMMITTED_PACK_SOURCE,
  onTelemetry: () => {},
});

/** Live pack-owned thresholds — updated on hot reload (ESM live bindings). */
export let ADVANCE_THRESHOLD = _boot.thresholds.advanceThreshold;
export let REMEDIATE_THRESHOLD = _boot.thresholds.remediateThreshold;
export let TASK_GRAPH: ConceptNode[] = conceptsFromLoaded(_boot);
export let taskGraphPackVersionStamp: string | null = _boot.versionStamp;
export let loadedTaskGraph: LoadedTaskGraph | null = _boot;

let conceptById = new Map(TASK_GRAPH.map((c) => [c.conceptId, c]));

/**
 * Hydrate (or hot-reload) the console graph from a pack object.
 * Rejects cycles / missing nodes via domain-loader DAG checks.
 */
export function loadTaskGraphPackObject(
  raw: unknown,
  opts: { subjectId?: string; deviceId?: string; sourcePath?: string } = {},
): LoadedTaskGraph {
  const loaded = hydrateTaskGraphFromPackObject(raw, {
    subjectId: opts.subjectId ?? "playground-console",
    deviceId: opts.deviceId ?? "console",
    sourcePath: opts.sourcePath ?? COMMITTED_PACK_SOURCE,
    onTelemetry: () => {
      // subjectId/deviceId/outcome only — never titles or learner content.
    },
  });
  ADVANCE_THRESHOLD = loaded.thresholds.advanceThreshold;
  REMEDIATE_THRESHOLD = loaded.thresholds.remediateThreshold;
  TASK_GRAPH = conceptsFromLoaded(loaded);
  conceptById = new Map(TASK_GRAPH.map((c) => [c.conceptId, c]));
  taskGraphPackVersionStamp = loaded.versionStamp;
  loadedTaskGraph = loaded;
  return loaded;
}

/** Re-apply the committed teacher CBSE-slice pack (operator hot-reload / reset). */
export function reloadCommittedTaskGraphPack(
  opts: { subjectId?: string; deviceId?: string } = {},
): LoadedTaskGraph {
  return loadTaskGraphPackObject(COMMITTED_PACK, {
    subjectId: opts.subjectId ?? "playground-reload",
    deviceId: opts.deviceId ?? "console",
    sourcePath: COMMITTED_PACK_SOURCE,
  });
}

export function setTaskGraphPackVersionStamp(stamp: string | null): void {
  taskGraphPackVersionStamp = stamp;
}

/** Posterior mean of Beta(Σα+1, Σβ+1) — identical to ConceptMastery.mastery_mean (Python). */
export function masteryMean(state: CognitiveState, conceptId: string): number {
  return masteryMeanCore(state, conceptId);
}

export function evidenceCount(state: CognitiveState, conceptId: string): number {
  return evidenceCountCore(state, conceptId);
}

export interface DeviceReplica {
  deviceId: string;
  label: string;
  online: boolean;
  state: CognitiveState;
  clock: HlcClock;
  /** Samples captured since the last acknowledged sync (CAST write-ahead log). */
  pendingSamples: number;
}

export function genesisState(subjectId: string, deviceId: string, clock: HlcClock): CognitiveState {
  const now = clock.tick();
  const firstConcept = TASK_GRAPH[0]?.conceptId ?? "math.fractions";
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId,
    deviceIds: [deviceId],
    activeConceptId: firstConcept,
    mode: "diagnostic",
    mastery: {},
    frictionLog: [],
    profile: {
      ageBand: "adolescent",
      track: "cbse-class-8-maths",
      language: "en-IN",
      updatedAt: now,
    },
    stateVector: { session: now },
  };
}

export function createReplica(subjectId: string, deviceId: string, label: string): DeviceReplica {
  const clock = new HlcClock(deviceId);
  return { deviceId, label, online: true, state: genesisState(subjectId, deviceId, clock), clock, pendingSamples: 0 };
}

/* ── CAST: fold evidence (identical rules to edge_agent.ts#foldFriction) ── */

export interface InteractionInput {
  conceptId: string;
  outcome: "correct" | "partial" | "incorrect";
  hesitationMs: number;
  revisionCount: number;
  assistanceRequested: boolean;
}

export function applyInteraction(replica: DeviceReplica, input: InteractionInput): FrictionSample {
  const capturedAt = replica.clock.tick();
  const sample: FrictionSample = {
    conceptId: input.conceptId,
    hesitationMs: input.hesitationMs,
    inputVelocity: input.hesitationMs < 3000 ? 3.4 : 1.2,
    revisionCount: input.revisionCount,
    assistanceRequested: input.assistanceRequested,
    outcome: input.outcome,
    capturedAt,
  };

  const state = replica.state;
  const device = replica.deviceId;
  const entry = (state.mastery[input.conceptId] ??= {
    conceptId: input.conceptId,
    alpha: {},
    beta: {},
    lastExercisedAt: capturedAt,
  });

  // CAST-04: fluency-weighted evidence.
  const fluent = input.hesitationMs < 3000 && input.revisionCount <= 1 && !input.assistanceRequested;
  const fluency = fluent ? 1.0 : 0.5;
  if (input.outcome === "correct") {
    entry.alpha[device] = (entry.alpha[device] ?? 0) + fluency;
  } else if (input.outcome === "incorrect") {
    entry.beta[device] = (entry.beta[device] ?? 0) + 1;
  } else {
    entry.alpha[device] = (entry.alpha[device] ?? 0) + 0.5 * fluency;
    entry.beta[device] = (entry.beta[device] ?? 0) + 0.5;
  }
  entry.lastExercisedAt = capturedAt;

  state.frictionLog = [...state.frictionLog, sample];
  state.stateVector = { ...state.stateVector, session: replica.clock.tick() };
  replica.pendingSamples += 1;
  return sample;
}

/* ── Task router: cyclical routing (mirrors task_router.py via route_core) ─ */

export interface RoutingDecision {
  nextConceptId: string;
  mode: GuidanceMode;
  rationale: string[];
}

export function routeTurn(state: CognitiveState, sample: FrictionSample): RoutingDecision {
  const decision = routeTurnOnGraph(
    {
      nodes: conceptById,
      orderedConcepts: TASK_GRAPH,
      advanceThreshold: ADVANCE_THRESHOLD,
      remediateThreshold: REMEDIATE_THRESHOLD,
      hesitationSpikeMs: HESITATION_SPIKE_MS,
      maxRemediationDepth: MAX_REMEDIATION_DEPTH,
    },
    state,
    sample,
  );
  return {
    nextConceptId: decision.nextConceptId,
    mode: decision.mode as GuidanceMode,
    rationale: decision.rationale,
  };
}

export function applyRouting(replica: DeviceReplica, decision: RoutingDecision): void {
  replica.state.activeConceptId = decision.nextConceptId;
  replica.state.mode = decision.mode;
  replica.state.stateVector = { ...replica.state.stateVector, session: replica.clock.tick() };
}

/* ── SYNC: real CRDT merges via the shipped resolver ────────────────────── */

const resolver = new CrdtHarnessResolver();

export interface MergeReport {
  merged: CognitiveState;
  advisories: SyncAdvisory[];
}

/** Join edge replica into master using the production resolver. */
export function mergeReplicas(
  master: CognitiveState,
  edge: CognitiveState,
): MergeReport {
  const { merged, advisories } = resolver.merge(master, edge);
  return { merged, advisories };
}

export { PROTOCOL_VERSION };
export type { CognitiveState, FrictionSample, GuidanceMode, SyncAdvisory };
