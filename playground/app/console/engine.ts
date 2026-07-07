/**
 * Playground protocol engine — a thin driver over the REAL protocol packages.
 *
 * Nothing in this module fabricates data. Mastery posteriors, HLC
 * timestamps, CRDT merges, and advisories are produced by the exact code
 * that ships in `@moolam/sync-protocol`; the routing rules mirror the
 * reference cloud task router (`task_router.py`) constant-for-constant so
 * the console demonstrates true protocol behavior end to end.
 */

import {
  CrdtHarnessResolver,
  HlcClock,
  PROTOCOL_VERSION,
  type FrictionSample,
  type GuidanceMode,
  type CognitiveState,
  type SyncAdvisory,
} from "@moolam/sync-protocol";

/* Constants mirrored from sutra_orchestrator/task_router.py.
 * A CI conformance check keeps the two in lockstep. */
export const ADVANCE_THRESHOLD = 0.85;
export const REMEDIATE_THRESHOLD = 0.4;
export const HESITATION_SPIKE_MS = 15_000;
export const MAX_REMEDIATION_DEPTH = 4;

export interface ConceptNode {
  conceptId: string;
  title: string;
  prerequisites: string[];
  track: "school-mathematics" | "system-design";
}

/** Reference task graph spanning two very different domain tracks. */
export const TASK_GRAPH: ConceptNode[] = [
  { conceptId: "math.fractions", title: "Fractions", prerequisites: [], track: "school-mathematics" },
  { conceptId: "math.ratios", title: "Ratios & Proportion", prerequisites: ["math.fractions"], track: "school-mathematics" },
  { conceptId: "math.percentages", title: "Percentages", prerequisites: ["math.ratios"], track: "school-mathematics" },
  { conceptId: "sd.networking", title: "Networking Basics", prerequisites: [], track: "system-design" },
  { conceptId: "sd.load-balancing", title: "Load Balancing", prerequisites: ["sd.networking"], track: "system-design" },
  { conceptId: "sd.consistent-hashing", title: "Consistent Hashing", prerequisites: ["sd.load-balancing"], track: "system-design" },
];

const conceptById = new Map(TASK_GRAPH.map((c) => [c.conceptId, c]));

/** Posterior mean of Beta(Σα+1, Σβ+1) — identical to ConceptMastery.mastery_mean (Python). */
export function masteryMean(state: CognitiveState, conceptId: string): number {
  const m = state.mastery[conceptId];
  if (!m) return 0.5; // maximally uncertain, per CAST-05
  const a = Object.values(m.alpha).reduce((s, v) => s + v, 0) + 1;
  const b = Object.values(m.beta).reduce((s, v) => s + v, 0) + 1;
  return a / (a + b);
}

export function evidenceCount(state: CognitiveState, conceptId: string): number {
  const m = state.mastery[conceptId];
  if (!m) return 0;
  return (
    Object.values(m.alpha).reduce((s, v) => s + v, 0) +
    Object.values(m.beta).reduce((s, v) => s + v, 0)
  );
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
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId,
    deviceIds: [deviceId],
    activeConceptId: "math.fractions",
    mode: "diagnostic",
    mastery: {},
    frictionLog: [],
    profile: {
      ageBand: "adolescent",
      track: "cbse-class-7-maths",
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

/* ── Task router: cyclical routing (mirrors task_router.py) ─────────────── */

export interface RoutingDecision {
  nextConceptId: string;
  mode: GuidanceMode;
  rationale: string[];
}

function weakestPrerequisite(state: CognitiveState, conceptId: string): ConceptNode | null {
  const node = conceptById.get(conceptId);
  if (!node) return null;
  const below = node.prerequisites
    .map((p) => ({ node: conceptById.get(p)!, mean: masteryMean(state, p) }))
    .filter((x) => x.node && x.mean < REMEDIATE_THRESHOLD);
  if (below.length === 0) return null;
  below.sort((a, b) => a.mean - b.mean);
  return below[0]!.node;
}

export function routeTurn(state: CognitiveState, sample: FrictionSample): RoutingDecision {
  const rationale: string[] = [];
  let active = sample.conceptId;
  let mode: GuidanceMode = state.mode;
  let depth = 0;

  const spike =
    sample.hesitationMs > HESITATION_SPIKE_MS ||
    sample.assistanceRequested ||
    sample.outcome === "incorrect";
  rationale.push(
    `assess_friction: hesitation=${sample.hesitationMs}ms revisions=${sample.revisionCount} ` +
      `outcome=${sample.outcome} assisted=${sample.assistanceRequested} → ${spike ? "SPIKE" : "nominal"}`,
  );

  // Cyclical remediation: loop back through weak prerequisites, bounded.
  while (spike) {
    const weak = weakestPrerequisite(state, active);
    if (!weak) break;
    if (depth >= MAX_REMEDIATION_DEPTH) {
      rationale.push(
        `remediation depth limit (${MAX_REMEDIATION_DEPTH}) reached → pinning guided mode`,
      );
      mode = "guided";
      break;
    }
    depth += 1;
    active = weak.conceptId;
    mode = "prerequisite-remediation";
    rationale.push(
      `remediate_prereq: posterior(${weak.conceptId})=${masteryMean(state, weak.conceptId).toFixed(2)} < τ_r=${REMEDIATE_THRESHOLD} ` +
        `→ loop back (depth ${depth})`,
    );
  }

  if (!spike && depth === 0) {
    const mean = masteryMean(state, active);
    if (mean >= ADVANCE_THRESHOLD) {
      const successor = TASK_GRAPH.find((n) => n.prerequisites.includes(active));
      if (successor) {
        rationale.push(
          `advance_concept: posterior=${mean.toFixed(2)} ≥ τ_a=${ADVANCE_THRESHOLD} → advance to '${successor.conceptId}'`,
        );
        active = successor.conceptId;
        mode = "exploratory";
      } else {
        rationale.push(`posterior=${mean.toFixed(2)} ≥ τ_a but no successor — track complete`);
        mode = "reinforcement";
      }
    } else {
      rationale.push(
        `hold: τ_r=${REMEDIATE_THRESHOLD} ≤ posterior=${mean.toFixed(2)} < τ_a=${ADVANCE_THRESHOLD} (hysteretic dead band)`,
      );
      if (mode === "diagnostic" && evidenceCount(state, active) >= 3) mode = "exploratory";
    }
  }

  rationale.push(`generate_lesson: TEACH concept='${conceptById.get(active)?.title ?? active}' mode=${mode} depth=${depth}`);
  return { nextConceptId: active, mode, rationale };
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
