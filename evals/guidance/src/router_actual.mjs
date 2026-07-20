/**
 * Produce RouterActual for a guidance scenario via domain-loader hydrate +
 * playground route_core (same bytes / logic as cloud TaskRouter parity path).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateTaskGraphFromPackObject } from "@moolam/domain-loader";
import { routeTurnOnGraph, HESITATION_SPIKE_MS } from "../../../playground/app/console/route_core.mjs";
import {
  actualFromDecision,
  isFrictionSpike,
} from "./score.mjs";
import { GUIDANCE_EVAL_ROOT } from "./validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PACK = path.join(
  GUIDANCE_EVAL_ROOT,
  "..",
  "..",
  "packages",
  "domain-loader",
  "fixtures",
  "packs",
  "teacher-cbse-slice.json",
);

/** @type {ReturnType<typeof buildGraph> | null} */
let _cachedGraph = null;
/** @type {string | null} */
let _cachedPackPath = null;

function buildGraph(packPath) {
  const raw = JSON.parse(readFileSync(packPath, "utf8"));
  const loaded = hydrateTaskGraphFromPackObject(raw, {
    subjectId: "guidance-eval-pack",
    deviceId: "scorer",
    onTelemetry: () => {},
  });
  const orderedConcepts = loaded.concepts.map((c) => ({
    conceptId: c.conceptId,
    title: c.title,
    prerequisites: [...c.prerequisites],
  }));
  const nodes = new Map(orderedConcepts.map((c) => [c.conceptId, c]));
  return {
    packId: loaded.packId,
    versionStamp: loaded.versionStamp,
    graph: {
      nodes,
      orderedConcepts,
      advanceThreshold: loaded.thresholds.advanceThreshold,
      remediateThreshold: loaded.thresholds.remediateThreshold,
      hesitationSpikeMs: HESITATION_SPIKE_MS,
    },
  };
}

/**
 * @param {string} [packPath]
 */
export function getRouteGraph(packPath = DEFAULT_PACK) {
  const resolved = path.resolve(packPath);
  if (!_cachedGraph || _cachedPackPath !== resolved) {
    _cachedGraph = buildGraph(resolved);
    _cachedPackPath = resolved;
  }
  return _cachedGraph;
}

/**
 * @param {object} scenario guidance-eval.scenario.v1
 * @param {{ packPath?: string }} [opts]
 */
export function routerActualFromScenario(scenario, opts = {}) {
  const { graph } = getRouteGraph(opts.packPath);
  const mastery = {};
  for (const [cid, m] of Object.entries(scenario.masterySeed ?? {})) {
    mastery[cid] = {
      conceptId: cid,
      alpha: { ...m.alpha },
      beta: { ...m.beta },
      lastExercisedAt: m.lastExercisedAt,
    };
  }
  const state = { mode: scenario.mode, mastery };
  const friction = scenario.turnFriction;
  const decision = routeTurnOnGraph(graph, state, friction);
  const spiked = isFrictionSpike(friction, graph.hesitationSpikeMs);
  const rationale = [
    ...decision.rationale,
    // Align keyword surface with Python guidance_directive (GUIDE concept=…).
    `GUIDE concept='${graph.nodes.get(decision.nextConceptId)?.title ?? decision.nextConceptId}' mode=${decision.mode}`,
  ];
  return actualFromDecision(
    {
      nextConceptId: decision.nextConceptId,
      mode: decision.mode,
      rationale,
    },
    scenario.activeConceptId,
    spiked,
  );
}

void __dirname;
