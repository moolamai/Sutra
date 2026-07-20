/**
 * Pure cyclical route decision — shared by playground engine and parity tests.
 * Mirrors packages/cloud-orchestrator TaskRouter assess → remediate/advance/hold.
 * Graph + thresholds are injected (pack-owned); no hardcoded τ or concept list.
 */

export const HESITATION_SPIKE_MS = 15_000;
export const MAX_REMEDIATION_DEPTH = 4;
/** CAST-05.1 — min mastery evidence (Σα+Σβ) before a root is assessed. */
export const CAST_05_MIN_ROOT_FRICTION_SAMPLES = 3;
export const CAST_05_1_OBLIGATION_ID = "CAST-05.1";
export const COLD_START_ROOT_SCAN_LIMIT = 64;

/**
 * @typedef {{ conceptId: string, title?: string, prerequisites: string[] }} RouteConcept
 * @typedef {{
 *   nodes: Map<string, RouteConcept> | Record<string, RouteConcept>,
 *   advanceThreshold: number,
 *   remediateThreshold: number,
 *   hesitationSpikeMs?: number,
 *   maxRemediationDepth?: number,
 *   orderedConcepts?: RouteConcept[],
 * }} RouteGraph
 * @typedef {{
 *   mode: string,
 *   mastery: Record<string, { alpha: Record<string, number>, beta: Record<string, number> }>,
 * }} RouteStateSlice
 * @typedef {{
 *   conceptId: string,
 *   hesitationMs: number,
 *   revisionCount: number,
 *   assistanceRequested: boolean,
 *   outcome: string,
 * }} RouteFriction
 * @typedef {{ nextConceptId: string, mode: string, rationale: string[] }} RoutingDecision
 */

/**
 * @param {RouteStateSlice} state
 * @param {string} conceptId
 */
export function masteryMean(state, conceptId) {
  const m = state.mastery[conceptId];
  if (!m) return 0.5;
  const a = Object.values(m.alpha).reduce((s, v) => s + v, 0) + 1;
  const b = Object.values(m.beta).reduce((s, v) => s + v, 0) + 1;
  return a / (a + b);
}

/**
 * @param {RouteStateSlice} state
 * @param {string} conceptId
 */
export function evidenceCount(state, conceptId) {
  const m = state.mastery[conceptId];
  if (!m) return 0;
  return (
    Object.values(m.alpha).reduce((s, v) => s + v, 0) +
    Object.values(m.beta).reduce((s, v) => s + v, 0)
  );
}

/**
 * @param {RouteGraph} graph
 * @returns {string[]}
 */
export function rootConceptIds(graph) {
  const ordered =
    graph.orderedConcepts ??
    (graph.nodes instanceof Map
      ? [...graph.nodes.values()]
      : Object.values(graph.nodes));
  const roots = [];
  for (const n of ordered.slice(0, COLD_START_ROOT_SCAN_LIMIT * 4)) {
    if (!n.prerequisites || n.prerequisites.length === 0) {
      roots.push(n.conceptId);
      if (roots.length >= COLD_START_ROOT_SCAN_LIMIT) break;
    }
  }
  return roots;
}

/**
 * @param {RouteStateSlice} state
 * @param {string[]} rootIds
 */
export function listUnassessedRoots(state, rootIds) {
  const unassessed = [];
  for (const id of rootIds.slice(0, COLD_START_ROOT_SCAN_LIMIT)) {
    if (evidenceCount(state, id) < CAST_05_MIN_ROOT_FRICTION_SAMPLES) {
      unassessed.push(id);
    }
  }
  return unassessed;
}

/**
 * @param {RouteGraph} graph
 * @param {string} conceptId
 * @returns {RouteConcept | undefined}
 */
function getNode(graph, conceptId) {
  if (graph.nodes instanceof Map) return graph.nodes.get(conceptId);
  return graph.nodes[conceptId];
}

/**
 * @param {RouteGraph} graph
 * @param {RouteStateSlice} state
 * @param {string} conceptId
 * @returns {RouteConcept | null}
 */
function weakestPrerequisite(graph, state, conceptId) {
  const node = getNode(graph, conceptId);
  if (!node) return null; // unknown concept — quarantine, do not crash
  const τr = graph.remediateThreshold;
  const below = node.prerequisites
    .map((p) => ({ node: getNode(graph, p), mean: masteryMean(state, p) }))
    .filter((x) => !!x.node && x.mean < τr);
  if (below.length === 0) return null;
  below.sort((a, b) => a.mean - b.mean);
  return below[0].node;
}

/**
 * @param {RouteGraph} graph
 * @param {RouteStateSlice} state
 * @param {RouteFriction} sample
 * @returns {RoutingDecision}
 */
export function routeTurnOnGraph(graph, state, sample) {
  const rationale = [];
  let active = sample.conceptId;
  let mode = state.mode;
  let depth = 0;
  const spikeMs = graph.hesitationSpikeMs ?? HESITATION_SPIKE_MS;
  const maxDepth = graph.maxRemediationDepth ?? MAX_REMEDIATION_DEPTH;
  const τa = graph.advanceThreshold;
  const τr = graph.remediateThreshold;

  const spike =
    sample.hesitationMs > spikeMs ||
    sample.assistanceRequested ||
    sample.outcome === "incorrect";
  rationale.push(
    `assess_friction: hesitation=${sample.hesitationMs}ms revisions=${sample.revisionCount} ` +
      `outcome=${sample.outcome} assisted=${sample.assistanceRequested} → ${spike ? "SPIKE" : "nominal"}`,
  );

  while (spike) {
    const weak = weakestPrerequisite(graph, state, active);
    if (!weak) break;
    if (depth >= maxDepth) {
      rationale.push(
        `remediation depth limit (${maxDepth}) reached → pinning guided mode`,
      );
      mode = "guided";
      break;
    }
    depth += 1;
    active = weak.conceptId;
    mode = "prerequisite-remediation";
    rationale.push(
      `remediate_prereq: posterior(${weak.conceptId})=${masteryMean(state, weak.conceptId).toFixed(2)} < τ_r=${τr} ` +
        `→ loop back (depth ${depth})`,
    );
  }

  if (!spike && depth === 0) {
    const mean = masteryMean(state, active);
    const unassessed = listUnassessedRoots(state, rootConceptIds(graph));
    const activeInPack = !!getNode(graph, active);
    if (mean >= τa) {
      if (unassessed.length > 0) {
        rationale.push(
          `${CAST_05_1_OBLIGATION_ID} cold-start: unassessed_roots=${unassessed.join(",")}` +
            `; advance quarantined; diagnostic probe '${unassessed[0]}'`,
        );
        if (activeInPack) {
          active = unassessed[0];
        }
        mode = "diagnostic";
      } else {
        const ordered =
          graph.orderedConcepts ??
          (graph.nodes instanceof Map
            ? [...graph.nodes.values()]
            : Object.values(graph.nodes));
        const successor = ordered.find((n) => n.prerequisites.includes(active));
        if (successor) {
          rationale.push(
            `advance_concept: posterior=${mean.toFixed(2)} ≥ τ_a=${τa} → advance to '${successor.conceptId}'`,
          );
          active = successor.conceptId;
          mode = "exploratory";
        } else {
          rationale.push(`posterior=${mean.toFixed(2)} ≥ τ_a but no successor — track complete`);
          mode = "reinforcement";
        }
      }
    } else {
      rationale.push(
        `hold: τ_r=${τr} ≤ posterior=${mean.toFixed(2)} < τ_a=${τa} (hysteretic dead band)`,
      );
      if (unassessed.length > 0 && mode !== "prerequisite-remediation") {
        rationale.push(
          `${CAST_05_1_OBLIGATION_ID} cold-start: unassessed_roots=${unassessed.join(",")}` +
            (activeInPack
              ? `; diagnostic probe '${unassessed[0]}'`
              : "; advance quarantined (unknown concept held)"),
        );
        if (activeInPack) {
          active = unassessed[0];
        }
        mode = "diagnostic";
      } else if (mode === "diagnostic" && evidenceCount(state, active) >= 3) {
        mode = "exploratory";
      }
    }
  }

  const title = getNode(graph, active)?.title ?? active;
  rationale.push(`generate_lesson: TEACH concept='${title}' mode=${mode} depth=${depth}`);
  return { nextConceptId: active, mode, rationale };
}
