/**
 * @moolam/domain-loader — task-graph pack schema, validation, and load paths.
 *
 * Cloud/playground production wiring (replace demo graphs) lands in later slices.
 */

export {
  DEFAULT_ADVANCE_THRESHOLD,
  DEFAULT_REMEDIATE_THRESHOLD,
  OBLIGATIONS,
  SCHEMA_VERSION,
  findCyclePath,
  fixturesRoot,
  goldenPacksRoot,
  loadGoldenPackFile,
  loadGoldenPackManifest,
  loadTaskGraphSchema,
  prerequisitesByConcept,
  runGoldenPackCase,
  runGoldenPackSuite,
  schemaPath,
  topologicalSort,
  validateGraph,
  validateTaskGraphPack,
  type AgeFloor,
  type GoldenPackCase,
  type GoldenPackCaseResult,
  type GoldenPackExpect,
  type GoldenPackManifest,
  type GraphFailureClass,
  type GraphViolation,
  type TaskGraphConceptV1,
  type TaskGraphEdgeV1,
  type TaskGraphPackV1,
  type TaskGraphThresholdsV1,
  type ValidateGraphInput,
  type ValidateGraphOptions,
  type ValidateGraphResult,
  type ValidateGraphTelemetry,
  type ValidatePackResult,
} from "./validate_graph.js";

export {
  TaskGraphLoadError,
  graphSemanticsFingerprint,
  hydrateTaskGraphFromPackObject,
  loadTaskGraph,
  loadTaskGraphFromObject,
  mapPackToLoadedGraph,
  resolveThresholds,
  type GraphSemanticsFingerprint,
  type LoadFromObjectOptions,
  type LoadTaskGraphOptions,
  type LoadTaskGraphTelemetry,
  type LoadedConceptNode,
  type LoadedTaskGraph,
} from "./load_graph.js";
