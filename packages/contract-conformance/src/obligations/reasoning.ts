/**
 * ReasoningInterface obligations and violation fixtures (003).
 *
 * CK-04.1 — every `deliberate()` result MUST carry a non-empty `steps` trace;
 * each step statement MUST be non-trivially descriptive (not empty / filler).
 * CK-04.2 — unverifiable constraints MUST surface verbatim in
 * `unresolvedConstraints` (silent dropping fails).
 *
 * Fixtures (each fails exactly one MUST)
 *   empty-trace            → CK-04.1
 *   constraint-swallowing  → CK-04.2
 */

import type {
  ReasoningInterface,
  ReasoningRequest,
  ReasoningResult,
  ReasoningStep,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

/**
 * Verbatim MUST sentence from `packages/contracts/src/reasoning.ts`
 * (contract requirement #1).
 */
export const MUST_TRACE_NON_EMPTY =
  "Every conclusion MUST carry its trace; an empty `steps` array is a contract violation, not a valid fast path.";

/**
 * Contract requirement #2 restated with the registry-required MUST keyword
 * (source: `reasoning.ts` — unverifiable constraints → `unresolvedConstraints`).
 */
export const MUST_CONSTRAINTS_SURFACE =
  "Unverifiable constraints MUST go to `unresolvedConstraints` — the engine never pretends to have checked what it has not.";

export const REASONING_OBLIGATION_IDS = {
  mandatoryTrace: "CK-04.1",
  constraintSurfacing: "CK-04.2",
} as const;

/** Prefix identifying conformance-injected unverifiable constraint probes. */
export const UNVERIFIABLE_CONSTRAINT_PREFIX =
  "probe.ck04.2.constraint.unverified.";

/**
 * Conformance surface for reasoning backends.
 * Probe only through `ReasoningInterface.deliberate` — never via internals.
 */
export interface ReasoningConformanceHarness {
  reasoning: ReasoningInterface;
}

/** Statements rejected as non-descriptive filler (trimmed, case-insensitive). */
const FILLER_STATEMENTS = new Set([
  ".",
  "..",
  "...",
  "-",
  "—",
  "n/a",
  "na",
  "none",
  "todo",
  "tbd",
  "step",
  "trace",
  "ok",
  "yes",
  "no",
]);

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

/** Metadata-only probe request — never embeds raw learner/user content. */
export function buildTraceProbeRequest(
  ctx: ObligationContext,
): ReasoningRequest {
  const token = subjectToken(ctx.subjectId);
  return {
    proposition: `probe.ck04.1.proposition.${token}`,
    evidence: [
      {
        sourceRef: `probe.ck04.1.evidence.${token}`,
        content: "probe.ck04.1.evidence.token",
        confidence: 1,
      },
    ],
    effort: "fast",
  };
}

/** Subject-scoped unverifiable constraint token (metadata only). */
export function unverifiableConstraintToken(subjectId: string): string {
  return `${UNVERIFIABLE_CONSTRAINT_PREFIX}${subjectToken(subjectId)}`;
}

/**
 * Probe that injects one unverifiable constraint the backend cannot honestly
 * claim to have verified from the metadata-only evidence set.
 */
export function buildConstraintSurfacingProbeRequest(
  ctx: ObligationContext,
): ReasoningRequest {
  const token = subjectToken(ctx.subjectId);
  return {
    proposition: `probe.ck04.2.proposition.${token}`,
    evidence: [
      {
        sourceRef: `probe.ck04.2.evidence.${token}`,
        content: "probe.ck04.2.evidence.token",
        confidence: 1,
      },
    ],
    constraints: [unverifiableConstraintToken(ctx.subjectId)],
    effort: "fast",
  };
}

export function isFillerStepStatement(statement: string): boolean {
  const trimmed = statement.trim();
  if (!trimmed) return true;
  if (FILLER_STATEMENTS.has(trimmed.toLowerCase())) return true;
  // Single-token punctuation / digit-only stubs are not reconstructable traces.
  if (/^[\p{P}\p{S}\d\s]+$/u.test(trimmed)) return true;
  return false;
}

function assertDescriptiveSteps(steps: ReasoningStep[] | undefined): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ObligationViolation({
      obligationId: REASONING_OBLIGATION_IDS.mandatoryTrace,
      mustText: MUST_TRACE_NON_EMPTY,
      contract: "ReasoningInterface",
      message: "deliberate() returned empty steps (no auditable trace)",
    });
  }

  // Bound: never scan unbounded step lists (NFR / scalability).
  const limit = Math.min(steps.length, 64);
  for (let i = 0; i < limit; i++) {
    const step = steps[i];
    if (!step || typeof step.statement !== "string") {
      throw new ObligationViolation({
        obligationId: REASONING_OBLIGATION_IDS.mandatoryTrace,
        mustText: MUST_TRACE_NON_EMPTY,
        contract: "ReasoningInterface",
        message: `steps[${i}] missing statement string`,
      });
    }
    if (isFillerStepStatement(step.statement)) {
      throw new ObligationViolation({
        obligationId: REASONING_OBLIGATION_IDS.mandatoryTrace,
        mustText: MUST_TRACE_NON_EMPTY,
        contract: "ReasoningInterface",
        message: `steps[${i}] statement is empty or filler (not reconstructable)`,
      });
    }
  }
}

export function defineMandatoryTraceObligation(): Obligation<ReasoningConformanceHarness> {
  return defineObligation({
    id: REASONING_OBLIGATION_IDS.mandatoryTrace,
    contract: "ReasoningInterface",
    mustText: MUST_TRACE_NON_EMPTY,
    specIds: ["CK-04"],
    async check(impl, ctx) {
      const request = buildTraceProbeRequest(ctx);
      const result: ReasoningResult = await impl.reasoning.deliberate(request);
      assertDescriptiveSteps(result.steps);
    },
  });
}

function assertUnresolvedConstraints(
  expected: string,
  unresolved: string[] | undefined,
): void {
  if (!Array.isArray(unresolved)) {
    throw new ObligationViolation({
      obligationId: REASONING_OBLIGATION_IDS.constraintSurfacing,
      mustText: MUST_CONSTRAINTS_SURFACE,
      contract: "ReasoningInterface",
      message: "unresolvedConstraints missing or not an array",
    });
  }

  // Bound: never scan unbounded unresolved lists (NFR / scalability).
  const limit = Math.min(unresolved.length, 64);
  for (let i = 0; i < limit; i++) {
    if (unresolved[i] === expected) return;
  }

  throw new ObligationViolation({
    obligationId: REASONING_OBLIGATION_IDS.constraintSurfacing,
    mustText: MUST_CONSTRAINTS_SURFACE,
    contract: "ReasoningInterface",
    message:
      "unverifiable constraint missing from unresolvedConstraints (silently dropped or paraphrased)",
  });
}

export function defineConstraintSurfacingObligation(): Obligation<ReasoningConformanceHarness> {
  return defineObligation({
    id: REASONING_OBLIGATION_IDS.constraintSurfacing,
    contract: "ReasoningInterface",
    mustText: MUST_CONSTRAINTS_SURFACE,
    specIds: ["CK-04"],
    async check(impl, ctx) {
      const request = buildConstraintSurfacingProbeRequest(ctx);
      const expected = request.constraints![0]!;
      const result: ReasoningResult = await impl.reasoning.deliberate(request);
      assertUnresolvedConstraints(expected, result.unresolvedConstraints);
    },
  });
}

export function registerMandatoryTraceObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineMandatoryTraceObligation());
  return registry;
}

export function registerConstraintSurfacingObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineConstraintSurfacingObligation());
  return registry;
}

/** CK-04.1 + CK-04.2 */
export function registerReasoningObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerMandatoryTraceObligation(registry);
  registerConstraintSurfacingObligation(registry);
  return registry;
}

export function createMandatoryTraceObligationRegistry(): ObligationRegistry {
  return registerMandatoryTraceObligation(new ObligationRegistry());
}

export function createConstraintSurfacingObligationRegistry(): ObligationRegistry {
  return registerConstraintSurfacingObligation(new ObligationRegistry());
}

export function createReasoningObligationsRegistry(): ObligationRegistry {
  return registerReasoningObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories (contract-surface only) ── */

/**
 * Known-good reference: non-empty descriptive steps; every supplied constraint
 * is surfaced as unresolved (this mock never pretends to have verified them).
 */
export function createTracedReasoningHarnessFactory(): () => ReasoningConformanceHarness {
  return () => ({
    reasoning: {
      async deliberate(request) {
        const steps: ReasoningStep[] = [
          {
            kind: "assumption",
            statement: "Framed the proposition against the declared evidence set",
            evidenceRefs: [],
          },
          {
            kind: "inference",
            statement: request.evidence.length
              ? "Weighted available evidence tokens into a reconstructable conclusion"
              : "No evidence supplied; conclusion limited to general knowledge",
            evidenceRefs: request.evidence.length ? [0] : [],
          },
        ];
        const constraints = request.constraints ?? [];
        if (constraints.length > 0) {
          steps.push({
            kind: "verification",
            statement:
              "Could not verify declared constraints from available evidence; surfacing unresolved",
            evidenceRefs: [],
          });
        }
        return {
          conclusion: "probe.ck04.conclusion",
          confidence: request.evidence.length ? 0.75 : 0.35,
          steps,
          // Honest reference: no silent drop — echo constraints verbatim.
          unresolvedConstraints: constraints.slice(0, 64),
        };
      },
    },
  });
}

/**
 * Canonical CK-04.1 fixture : empty steps, but constraints still
 * surface so the fixture fails only its target obligation.
 */
export function createEmptyTraceReasoningHarnessFactory(): () => ReasoningConformanceHarness {
  return () => ({
    reasoning: {
      async deliberate(request) {
        return {
          conclusion: "probe.ck04.1.empty-trace",
          confidence: 0.5,
          steps: [],
          // Isolation: still surface constraints so CK-04.2 passes.
          unresolvedConstraints: (request.constraints ?? []).slice(0, 64),
        };
      },
    },
  });
}

/**
 * Violation for CK-04.1: steps present but statements are filler stubs.
 */
export function createFillerTraceReasoningHarnessFactory(): () => ReasoningConformanceHarness {
  return () => ({
    reasoning: {
      async deliberate(request) {
        return {
          conclusion: "probe.ck04.1.filler-trace",
          confidence: 0.5,
          steps: [
            { kind: "inference", statement: "...", evidenceRefs: [] },
            { kind: "verification", statement: "n/a", evidenceRefs: [] },
          ],
          unresolvedConstraints: (request.constraints ?? []).slice(0, 64),
        };
      },
    },
  });
}

/**
 * Canonical CK-04.2 fixture : returns a descriptive trace but
 * silently swallows constraints.
 */
export function createDroppedConstraintReasoningHarnessFactory(): () => ReasoningConformanceHarness {
  return () => ({
    reasoning: {
      async deliberate(request) {
        return {
          conclusion: "probe.ck04.2.dropped-constraint",
          confidence: 0.5,
          steps: [
            {
              kind: "inference",
              statement: "Drew a conclusion while dropping unverifiable constraints",
              evidenceRefs: request.evidence.length ? [0] : [],
            },
          ],
          unresolvedConstraints: [],
        };
      },
    },
  });
}

/** Alias — constraint-swallowing fixture. */
export const createConstraintSwallowingReasoningHarnessFactory =
  createDroppedConstraintReasoningHarnessFactory;

/**
 * Violation for CK-04.2: paraphrases the constraint instead of echoing verbatim.
 */
export function createParaphrasedConstraintReasoningHarnessFactory(): () => ReasoningConformanceHarness {
  return () => ({
    reasoning: {
      async deliberate(request) {
        const paraphrased = (request.constraints ?? []).map(
          (c) => `could-not-verify:${c.length}`,
        );
        return {
          conclusion: "probe.ck04.2.paraphrased-constraint",
          confidence: 0.5,
          steps: [
            {
              kind: "verification",
              statement: "Recorded constraint failure without preserving verbatim text",
              evidenceRefs: [],
            },
          ],
          unresolvedConstraints: paraphrased,
        };
      },
    },
  });
}

/** One deliberately-broken reasoner that fails exactly one CK-04.* MUST. */
export interface ReasoningViolationFixture {
  fixtureId: string;
  targetObligationId: (typeof REASONING_OBLIGATION_IDS)[keyof typeof REASONING_OBLIGATION_IDS];
  mustText: string;
  summary: string;
  createFactory: () => () => ReasoningConformanceHarness;
}

/**
 * Named catalog — each fixture fails its target and passes the other.
 */
export const REASONING_VIOLATION_FIXTURES = {
  emptyTrace: {
    fixtureId: "reasoning.violation.empty-trace",
    targetObligationId: REASONING_OBLIGATION_IDS.mandatoryTrace,
    mustText: MUST_TRACE_NON_EMPTY,
    summary: "deliberate() returns empty steps (latency fast-path skips the trace)",
    createFactory: createEmptyTraceReasoningHarnessFactory,
  },
  constraintSwallowing: {
    fixtureId: "reasoning.violation.constraint-swallowing",
    targetObligationId: REASONING_OBLIGATION_IDS.constraintSurfacing,
    mustText: MUST_CONSTRAINTS_SURFACE,
    summary:
      "deliberate() returns a trace but silently drops unverifiable constraints",
    createFactory: createConstraintSwallowingReasoningHarnessFactory,
  },
} as const satisfies Record<string, ReasoningViolationFixture>;

export function listReasoningViolationFixtures(): readonly ReasoningViolationFixture[] {
  return [
    REASONING_VIOLATION_FIXTURES.emptyTrace,
    REASONING_VIOLATION_FIXTURES.constraintSwallowing,
  ];
}
