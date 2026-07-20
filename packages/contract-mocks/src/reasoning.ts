/**
 * Reference ReasoningInterface — non-empty descriptive traces; unverifiable
 * constraints surface in unresolvedConstraints (CK-04).
 *
 * Ported from examples/_shared/mocks.mjs with obligation-grade honesty.
 *
 * @module reasoning
 */

import type {
  ReasoningInterface,
  ReasoningRequest,
  ReasoningResult,
  ReasoningStep,
} from "@moolam/contracts";

import type { ContractMockEmit } from "./events.js";

export const REASONING_CONSTRAINT_LIMIT = 64;
export const REASONING_STEP_LIMIT = 32;

export type ReasoningMockOptions = {
  deviceId?: string;
  subjectId?: string;
  emit?: ContractMockEmit;
  /**
   * When true (default for {@link createReasoningMock}), echo constraints as
   * unresolved (CK-04.2). Example loops set false via {@link makeReasoning}
   * so profile.refusals do not force every turn onto the decline path.
   */
  surfaceUnresolved?: boolean;
};

export type ReasoningMockHarness = {
  reasoning: ReasoningInterface;
};

/**
 * Honest reasoner: always emits a reconstructable trace; never silently drops
 * constraints when {@link ReasoningMockOptions.surfaceUnresolved} is true
 * (default — echoes them as unresolved when not verified from evidence).
 */
export function createReasoningMock(
  options: ReasoningMockOptions = {},
): ReasoningInterface {
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  const surfaceUnresolved = options.surfaceUnresolved !== false;

  return {
    async deliberate(request: ReasoningRequest): Promise<ReasoningResult> {
      try {
        const evidence = (request.evidence ?? []).slice(0, 16);
        const constraints = (request.constraints ?? []).slice(
          0,
          REASONING_CONSTRAINT_LIMIT,
        );
        const steps: ReasoningStep[] = [
          {
            kind: "assumption",
            statement: request.proposition.trim()
              ? `Framed the proposition against the declared evidence set (${request.proposition.slice(0, 80)})`
              : "Framed an empty proposition against the declared evidence set",
            evidenceRefs: [],
          },
          {
            kind: "inference",
            statement: evidence.length
              ? `Weighted ${evidence.length} evidence item(s) into a reconstructable conclusion`
              : "No evidence retrieved; answering from general knowledge with low confidence",
            evidenceRefs: evidence.length ? [0] : [],
          },
        ];
        if (surfaceUnresolved && constraints.length > 0) {
          steps.push({
            kind: "verification",
            statement:
              "Could not verify declared constraints from available evidence; surfacing unresolved",
            evidenceRefs: [],
          });
        }
        const boundedSteps = steps.slice(0, REASONING_STEP_LIMIT);
        const conclusion = evidence.length
          ? `Based on ${evidence.length} evidence item(s): ${evidence[0]!.content.slice(0, 80)}`
          : "No evidence retrieved; answering from general knowledge with low confidence.";
        const result: ReasoningResult = {
          conclusion,
          confidence: evidence.length ? 0.8 : 0.3,
          steps: boundedSteps,
          unresolvedConstraints: surfaceUnresolved ? constraints : [],
        };
        emit?.({
          event: "contract_mocks.reasoning",
          op: "deliberate",
          subjectId,
          deviceId,
          outcome: "ok",
          stepCount: result.steps.length,
          unresolvedCount: result.unresolvedConstraints.length,
        });
        return result;
      } catch (err) {
        emit?.({
          event: "contract_mocks.reasoning",
          op: "deliberate",
          subjectId,
          deviceId,
          outcome: "error",
          stepCount: 0,
          unresolvedCount: 0,
        });
        throw err;
      }
    },
  };
}

export function createReasoningMockHarnessFactory(
  options: ReasoningMockOptions = {},
): () => ReasoningMockHarness {
  return () => ({
    reasoning: createReasoningMock({
      ...options,
      surfaceUnresolved: options.surfaceUnresolved !== false,
    }),
  });
}

/**
 * Example / Playground alias: keeps a non-empty descriptive trace but clears
 * unresolved lists so CognitiveCore demos complete (not decline) on in-scope
 * utterances. Conformance uses {@link createReasoningMock} / harness factory.
 */
export function makeReasoning(): ReasoningInterface {
  return createReasoningMock({ surfaceUnresolved: false });
}
