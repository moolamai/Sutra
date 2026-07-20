/**
 * Remaining-contracts violation fixtures .
 *
 * Named executable documentation for the model / speech / vision / planning /
 * lifecycle MUST clauses called out by the remaining-contracts module:
 *   - cumulative-stream model
 *   - no-partial speech
 *   - silent-oversize vision
 *   - static-rationale planner
 *   - non-idempotent lifecycle
 *
 * Each fixture fails exactly its target obligation within its domain registry.
 */

import type { ObligationRegistry } from "../registry.js";

import {
  MODEL_OBLIGATION_IDS,
  MUST_STREAM_DELTAS,
  createCumulativeStreamModelHarnessFactory,
  createModelObligationsRegistry,
  type ModelConformanceHarness,
} from "./model.js";
import {
  MUST_REVISION_UPDATES_RATIONALE,
  PLANNING_OBLIGATION_IDS,
  PLANNING_VIOLATION_FIXTURES,
  createPlanningObligationsRegistry,
  type PlanningConformanceHarness,
} from "./planning.js";
import {
  MUST_INITIALIZE_IDEMPOTENT,
  RUNTIME_OBLIGATION_IDS,
  RUNTIME_VIOLATION_FIXTURES,
  createRuntimeObligationsRegistry,
  type RuntimeConformanceHarness,
} from "./runtime.js";
import {
  MUST_TRANSCRIBE_PARTIALS,
  SPEECH_OBLIGATION_IDS,
  createFinalOnlySpeechHarnessFactory,
  createSpeechObligationsRegistry,
  type SpeechConformanceHarness,
} from "./speech.js";
import {
  MUST_REJECT_OVERSIZED,
  VISION_OBLIGATION_IDS,
  createAcceptOversizedVisionHarnessFactory,
  createVisionObligationsRegistry,
  type VisionConformanceHarness,
} from "./vision.js";

export type RemainingDomain =
  | "model"
  | "speech"
  | "vision"
  | "planning"
  | "runtime";

export type RemainingHarness =
  | ModelConformanceHarness
  | SpeechConformanceHarness
  | VisionConformanceHarness
  | PlanningConformanceHarness
  | RuntimeConformanceHarness;

/** One remaining-contracts fixture that fails exactly one domain MUST. */
export interface RemainingViolationFixture {
  fixtureId: string;
  domain: RemainingDomain;
  targetObligationId: string;
  mustText: string;
  summary: string;
  createRegistry: () => ObligationRegistry;
  createFactory: () => () => RemainingHarness;
}

/**
 * Canonical catalog — the five fixtures named by the task.
 */
export const REMAINING_VIOLATION_FIXTURES = {
  cumulativeStream: {
    fixtureId: "remaining.violation.cumulative-stream",
    domain: "model",
    targetObligationId: MODEL_OBLIGATION_IDS.streamDeltas,
    mustText: MUST_STREAM_DELTAS,
    summary: "generateStream() yields cumulative frames instead of deltas",
    createRegistry: createModelObligationsRegistry,
    createFactory: createCumulativeStreamModelHarnessFactory,
  },
  noPartialSpeech: {
    fixtureId: "remaining.violation.no-partial-speech",
    domain: "speech",
    targetObligationId: SPEECH_OBLIGATION_IDS.transcribePartials,
    mustText: MUST_TRANSCRIBE_PARTIALS,
    summary: "transcribe() emits only an isFinal:true segment (no partial)",
    createRegistry: createSpeechObligationsRegistry,
    createFactory: createFinalOnlySpeechHarnessFactory,
  },
  silentOversizeVision: {
    fixtureId: "remaining.violation.silent-oversize",
    domain: "vision",
    targetObligationId: VISION_OBLIGATION_IDS.rejectOversized,
    mustText: MUST_REJECT_OVERSIZED,
    summary: "analyze() silently accepts inputs above maxInputBytes",
    createRegistry: createVisionObligationsRegistry,
    createFactory: createAcceptOversizedVisionHarnessFactory,
  },
  staticRationalePlanner: {
    fixtureId: PLANNING_VIOLATION_FIXTURES.staticRationale.fixtureId,
    domain: "planning",
    targetObligationId: PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
    mustText: MUST_REVISION_UPDATES_RATIONALE,
    summary: PLANNING_VIOLATION_FIXTURES.staticRationale.summary,
    createRegistry: createPlanningObligationsRegistry,
    createFactory: PLANNING_VIOLATION_FIXTURES.staticRationale.createFactory,
  },
  nonIdempotentLifecycle: {
    fixtureId: RUNTIME_VIOLATION_FIXTURES.nonIdempotentLifecycle.fixtureId,
    domain: "runtime",
    targetObligationId: RUNTIME_OBLIGATION_IDS.initializeIdempotent,
    mustText: MUST_INITIALIZE_IDEMPOTENT,
    summary: RUNTIME_VIOLATION_FIXTURES.nonIdempotentLifecycle.summary,
    createRegistry: createRuntimeObligationsRegistry,
    createFactory: RUNTIME_VIOLATION_FIXTURES.nonIdempotentLifecycle.createFactory,
  },
} as const satisfies Record<string, RemainingViolationFixture>;

export function listRemainingViolationFixtures(): readonly RemainingViolationFixture[] {
  return [
    REMAINING_VIOLATION_FIXTURES.cumulativeStream,
    REMAINING_VIOLATION_FIXTURES.noPartialSpeech,
    REMAINING_VIOLATION_FIXTURES.silentOversizeVision,
    REMAINING_VIOLATION_FIXTURES.staticRationalePlanner,
    REMAINING_VIOLATION_FIXTURES.nonIdempotentLifecycle,
  ];
}
