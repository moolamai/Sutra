/**
 * Gym → production harness bridge.
 *
 * This module may ONLY re-export @moolam/runtime-harness. It must not
 * re-implement parser, sandbox, correction loop, or frame assembly.
 * See training/gym/charter.md.
 */

export {
  canonicalizeFramesJson,
  createDefaultGymToolRegistry,
  HARNESS_FRAME_TYPES,
  loadGoldenTurnCorpus,
  replayGoldenTurn,
  replayGoldenTurnCorpus,
  runProductionTurnLoop,
  unifiedDiff,
} from "@moolam/runtime-harness";
