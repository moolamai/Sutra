/**
 * Task-router probe — mirrors cloud TaskRouter assess_friction → route
 * decision (demo graph + remediation depth breaker). No LLM / model I/O.
 * Used by router.bench.mjs for NFR-04 routing-overhead measurement.
 */

export const ADVANCE_THRESHOLD = 0.85;
export const REMEDIATE_THRESHOLD = 0.4;
export const HESITATION_SPIKE_MS = 15_000;
export const MAX_REMEDIATION_DEPTH = 4;

/** Demo prerequisite DAG (same shape as cloud `demo_task_graph`). */
export function demoTaskGraph() {
  const nodes = [
    { conceptId: "math.fractions", title: "Fractions", prerequisites: [] },
    {
      conceptId: "math.ratios",
      title: "Ratios & Proportion",
      prerequisites: ["math.fractions"],
    },
    {
      conceptId: "math.percentages",
      title: "Percentages",
      prerequisites: ["math.ratios"],
    },
    { conceptId: "sd.networking", title: "Networking Basics", prerequisites: [] },
    {
      conceptId: "sd.load-balancing",
      title: "Load Balancing",
      prerequisites: ["sd.networking"],
    },
    {
      conceptId: "sd.consistent-hashing",
      title: "Consistent Hashing",
      prerequisites: ["sd.load-balancing"],
    },
  ];
  return { nodes: Object.fromEntries(nodes.map((n) => [n.conceptId, n])) };
}

export function masteryMean(entry) {
  if (!entry) return 0.5;
  const alphas = Object.values(entry.alpha ?? {});
  const betas = Object.values(entry.beta ?? {});
  const a = alphas.reduce((s, v) => s + v, 0) + 1;
  const b = betas.reduce((s, v) => s + v, 0) + 1;
  return a / (a + b);
}

function prerequisitesOf(graph, conceptId) {
  const node = graph.nodes[conceptId];
  if (!node) return [];
  return node.prerequisites
    .map((id) => graph.nodes[id])
    .filter(Boolean);
}

function weakestPrerequisite(graph, conceptId, mastery) {
  const candidates = prerequisitesOf(graph, conceptId).map((p) => ({
    mean: masteryMean(mastery[p.conceptId]),
    node: p,
  }));
  const below = candidates.filter((c) => c.mean < REMEDIATE_THRESHOLD);
  if (!below.length) return null;
  below.sort((a, b) => a.mean - b.mean);
  return below[0].node;
}

function assessFriction(friction) {
  const spiking =
    friction.hesitationMs > HESITATION_SPIKE_MS ||
    friction.assistanceRequested === true ||
    friction.outcome === "incorrect";
  return {
    routingRationale: `friction(hesitation=${friction.hesitationMs}ms, revisions=${friction.revisionCount}, outcome=${friction.outcome}, assisted=${friction.assistanceRequested}) → ${spiking ? "SPIKE" : "nominal"}`,
    spiking,
  };
}

/**
 * One assess_friction → route decision pass (may remediate up to depth breaker).
 * Returns terminal routing state; never invokes a model.
 */
export function routeTurn(input) {
  const graph = input.graph ?? demoTaskGraph();
  const subjectId = input.subjectId;
  if (typeof subjectId !== "string" || !subjectId) {
    const err = new Error("routeTurn: subjectId required");
    err.failureClass = "validation_failed";
    throw err;
  }

  let activeConceptId = input.activeConceptId;
  let mode = input.mode ?? "exploratory";
  let remediationDepth = 0;
  const mastery = input.mastery ?? {};
  const assessed = assessFriction(input.friction);
  let routingRationale = assessed.routingRationale;
  let nextConceptId = activeConceptId;

  // Bound the remediation↔reassess cycle (matches MAX_REMEDIATION_DEPTH).
  for (let step = 0; step < MAX_REMEDIATION_DEPTH + 2; step++) {
    const mean = masteryMean(mastery[activeConceptId]);
    const weak = weakestPrerequisite(graph, activeConceptId, mastery);
    const frictionSpike = routingRationale.includes("SPIKE");

    let decision = "continue";
    if (frictionSpike && weak != null) {
      decision =
        remediationDepth >= MAX_REMEDIATION_DEPTH ? "continue" : "remediate";
    } else if (mean >= ADVANCE_THRESHOLD && !frictionSpike) {
      decision = "advance";
    }

    if (decision === "remediate") {
      remediationDepth += 1;
      activeConceptId = weak.conceptId;
      nextConceptId = weak.conceptId;
      mode = "prerequisite-remediation";
      routingRationale += ` | looped back to prerequisite '${weak.conceptId}' (depth ${remediationDepth})`;
      const deeper = weakestPrerequisite(graph, activeConceptId, mastery);
      if (deeper != null && remediationDepth < MAX_REMEDIATION_DEPTH) {
        // Re-enter assess_friction on the remediation target (cycle).
        continue;
      }
      break;
    }

    if (decision === "advance") {
      const successors = Object.values(graph.nodes).filter((n) =>
        n.prerequisites.includes(activeConceptId),
      );
      nextConceptId = successors[0]?.conceptId ?? activeConceptId;
      mode = "exploratory";
      routingRationale += ` | mastery ≥ ${ADVANCE_THRESHOLD}; advancing to '${nextConceptId}'`;
      break;
    }

    nextConceptId = activeConceptId;
    break;
  }

  const node = graph.nodes[nextConceptId];
  const title = node?.title ?? nextConceptId;
  return {
    subjectId,
    activeConceptId,
    nextConceptId,
    mode,
    remediationDepth,
    routingRationale,
    guidanceDirective: `GUIDE concept='${title}' mode=${mode} remediation_depth=${remediationDepth}`,
  };
}

/** Mocked nominal friction (no spike) — continue / advance paths. */
export function mockFrictionNominal(conceptId = "math.ratios") {
  return {
    conceptId,
    hesitationMs: 500,
    inputVelocity: 2,
    revisionCount: 0,
    assistanceRequested: false,
    outcome: "correct",
    capturedAt: "000000001000000:000000:bench-device",
  };
}

/** Mocked spike friction — drives remediate when prerequisites are weak. */
export function mockFrictionSpike(conceptId = "math.ratios") {
  return {
    conceptId,
    hesitationMs: 20_000,
    inputVelocity: 0.5,
    revisionCount: 3,
    assistanceRequested: true,
    outcome: "incorrect",
    capturedAt: "000000001000000:000000:bench-device",
  };
}

/**
 * Mastery map with weak math.fractions so spike → remediation depth path.
 */
export function mockMasteryWeakPrereq() {
  return {
    "math.ratios": {
      conceptId: "math.ratios",
      alpha: { "bench-device": 2 },
      beta: { "bench-device": 1 },
    },
    "math.fractions": {
      conceptId: "math.fractions",
      alpha: { "bench-device": 0.2 },
      beta: { "bench-device": 1 },
    },
  };
}

/** High mastery, no weak prereqs — advance / continue without remediation. */
export function mockMasteryStrong() {
  return {
    "math.ratios": {
      conceptId: "math.ratios",
      alpha: { "bench-device": 20 },
      beta: { "bench-device": 1 },
    },
    "math.fractions": {
      conceptId: "math.fractions",
      alpha: { "bench-device": 20 },
      beta: { "bench-device": 1 },
    },
    "math.percentages": {
      conceptId: "math.percentages",
      alpha: { "bench-device": 1 },
      beta: { "bench-device": 1 },
    },
  };
}
