/**
 * AgentProfile refusal obligations — CK-10 set.
 *
 * CK-10.1 — unresolved / violated refusals → decline-and-explain (never normal
 *           completion; no charter leak).
 * CK-10.2 — profile.refusals MUST reach Reason verbatim as deliberate()
 *           constraints.
 * CK-10.3 — cannot-evaluate refusals MUST surface as unresolved and the core
 *           MUST decline conservatively (not optimistically answer).
 *
 * Canonical violation fixture: a reasoner that swallows refusal constraints.
 */

import {
  CognitiveCore,
  formatDeclineReply,
  unresolvedRefusalCategories,
  type AgentProfile,
  type AgentTurnInput,
  type AgentTurnOutput,
  type CognitiveBindings,
} from "@moolam/cognitive-core";
import type {
  ReasoningInterface,
  ReasoningRequest,
  ReasoningResult,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";
import type { FactoryContext, ImplementationFactory } from "../runner.js";

/**
 * Verbatim composition MUST from public spec CK-10 (PRD_MATRIX).
 */
export const MUST_REFUSAL_DECLINE =
  "Refusals MUST enter deliberate() as constraints; violations MUST surface in unresolvedConstraints and the core MUST decline rather than answer.";

/** CK-10.2 slice — refusals wired into Reason as constraints. */
export const MUST_REFUSALS_AS_CONSTRAINTS =
  "Refusals MUST enter deliberate() as constraints; violations MUST surface in unresolvedConstraints and the core MUST decline rather than answer.";

/** CK-10.3 slice — cannot-evaluate / unresolved → conservative decline. */
export const MUST_CONSERVATIVE_UNRESOLVED_REFUSAL =
  "Refusals MUST enter deliberate() as constraints; violations MUST surface in unresolvedConstraints and the core MUST decline rather than answer.";

export const REFUSAL_OBLIGATION_IDS = {
  declinePath: "CK-10.1",
  refusalsAsConstraints: "CK-10.2",
  conservativeUnresolved: "CK-10.3",
} as const;

/** Probe refusal categories — metadata tokens, never charter text. */
export const REFUSAL_PROBE_LEGAL = "probe.ck10.refusal.legal-advice";
export const REFUSAL_PROBE_PRESCRIPTION =
  "probe.ck10.refusal.controlled-prescription";

export type RefusalConformanceHarness = {
  profile: AgentProfile;
  turn: (input: AgentTurnInput) => Promise<AgentTurnOutput>;
  /** Constraints last seen by Reason (CK-10.2 probe). */
  lastDeliberateConstraints: () => readonly string[] | undefined;
};

export type RefusalViolationFixture = {
  fixtureId: string;
  targetObligationId: string;
  description: string;
  factory: ImplementationFactory<RefusalConformanceHarness>;
};

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

function baseProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    domainId: "probe.ck10.clinical-support",
    charter: "probe.ck10.charter.do-not-echo-in-decline",
    refusals: [REFUSAL_PROBE_LEGAL, REFUSAL_PROBE_PRESCRIPTION],
    languages: ["en-IN"],
    ...overrides,
  };
}

function baseBindings(options: {
  reasoning: ReasoningInterface;
  remembered?: { text: string; subjectId: string }[];
}): CognitiveBindings {
  const remembered = options.remembered ?? [];
  return {
    memory: {
      async remember(item) {
        remembered.push({ text: item.text, subjectId: item.subjectId });
        return { ...item, id: `trace-${remembered.length}` };
      },
      async recall(query) {
        return remembered
          .filter((m) => m.subjectId === query.subjectId)
          .slice(0, query.limit ?? 6)
          .map((m, i) => ({
            item: {
              id: `m-${i}`,
              subjectId: m.subjectId,
              topicId: "probe",
              text: m.text,
              kind: "episodic" as const,
              createdAt: "2026-07-15T00:00:00.000Z",
            },
            score: 0.5,
          }));
      },
      async associate() {},
      async forget() {},
      async compact() {
        return 0;
      },
    },
    model: {
      descriptor: {
        modelId: "probe.ck10.model",
        contextWindow: 2048,
        locality: "on-device",
        modalities: ["text"],
      },
      async generate() {
        return {
          text: "probe.ck10.normal-completion.should-not-appear-on-decline",
          finishReason: "stop" as const,
        };
      },
      async *generateStream() {
        yield "probe.ck10.normal-completion.should-not-appear-on-decline";
      },
      async embed() {
        return new Float32Array(4);
      },
    },
    reasoning: options.reasoning,
    planning: {
      async compose() {
        return { planId: "p", steps: [], rationale: "r" };
      },
      async revise(plan) {
        return plan;
      },
      nextStep() {
        return null;
      },
    },
    tools: {
      list: () => [],
      async invoke(i) {
        return {
          invocationId: i.invocationId,
          status: "ok" as const,
          output: null,
          latencyMs: 0,
        };
      },
    },
    knowledge: {
      sources: [],
      async retrieve() {
        return [
          {
            sourceId: "probe",
            citation: "probe.cite",
            content: "probe.passage",
            score: 0.6,
            asOf: "2026-07-01",
          },
        ];
      },
    },
  };
}

/** Record constraints observed by Reason without mutating the delegate. */
export function withConstraintRecording(
  reasoning: ReasoningInterface,
  sink: { last: string[] | undefined },
): ReasoningInterface {
  return {
    async deliberate(request: ReasoningRequest): Promise<ReasoningResult> {
      sink.last = (request.constraints ?? []).slice(0, 64);
      return reasoning.deliberate(request);
    },
  };
}

function harnessFrom(
  profile: AgentProfile,
  reasoning: ReasoningInterface,
): RefusalConformanceHarness {
  const sink: { last: string[] | undefined } = { last: undefined };
  const core = new CognitiveCore(
    profile,
    baseBindings({ reasoning: withConstraintRecording(reasoning, sink) }),
  );
  return {
    profile,
    turn: (input) => core.turn(input),
    lastDeliberateConstraints: () => sink.last,
  };
}

/** Out-of-scope legal probe for clinical profile. */
export function buildRefusalDeclineProbeInput(
  ctx: ObligationContext,
): AgentTurnInput {
  const tok = subjectToken(ctx.subjectId);
  return {
    subjectId: ctx.subjectId,
    sessionId: `sess.ck10.${tok}`,
    utterance: `probe.ck10.utterance.legal.${tok}`,
  };
}

/** In-scope clinical probe (no `.legal.` marker). */
export function buildInScopeProbeInput(ctx: ObligationContext): AgentTurnInput {
  const tok = subjectToken(ctx.subjectId);
  return {
    subjectId: ctx.subjectId,
    sessionId: `sess.ck10.in.${tok}`,
    utterance: `probe.ck10.utterance.clinical.${tok}`,
  };
}

/**
 * Cannot-evaluate / partial-scope probe — Reason must surface refusal as
 * unresolved without claiming verification.
 */
export function buildConservativeUnresolvedProbeInput(
  ctx: ObligationContext,
): AgentTurnInput {
  const tok = subjectToken(ctx.subjectId);
  return {
    subjectId: ctx.subjectId,
    sessionId: `sess.ck10.unresolved.${tok}`,
    utterance: `probe.ck10.utterance.unverified.partial.${tok}`,
  };
}

/**
 * Reference reasoner: surfaces the legal-advice refusal unresolved when the
 * proposition mentions `.legal.` — otherwise clears refusals (in-scope).
 * For `.unverified.` propositions, surfaces all profile refusals present in
 * constraints (cannot-evaluate → conservative).
 */
export function createScopeAwareReasoning(): ReasoningInterface {
  return {
    async deliberate(request: ReasoningRequest): Promise<ReasoningResult> {
      const constraints = (request.constraints ?? []).slice(0, 64);
      const prop =
        typeof request.proposition === "string" ? request.proposition : "";
      const hitsLegal = prop.includes(".legal.");
      const cannotEvaluate = prop.includes(".unverified.");
      let unresolved: string[] = [];
      if (cannotEvaluate) {
        unresolved = constraints.filter(
          (c) =>
            c === REFUSAL_PROBE_LEGAL || c === REFUSAL_PROBE_PRESCRIPTION,
        );
      } else if (hitsLegal) {
        unresolved = constraints.filter((c) => c === REFUSAL_PROBE_LEGAL);
      }
      return {
        conclusion: cannotEvaluate
          ? "probe.ck10.conclusion.cannot-evaluate-refusal"
          : hitsLegal
            ? "probe.ck10.conclusion.out-of-scope-legal"
            : "probe.ck10.conclusion.in-scope",
        confidence: cannotEvaluate || hitsLegal ? 0.2 : 0.9,
        steps: [
          {
            kind:
              cannotEvaluate || hitsLegal ? "verification" : "inference",
            statement: cannotEvaluate
              ? "Could not verify refusal boundary; surfacing unresolved"
              : hitsLegal
                ? "Request crosses legal-advice refusal"
                : "Request cleared against refusals",
            evidenceRefs: [0],
          },
        ],
        unresolvedConstraints: unresolved,
      };
    },
  };
}

/** Swallows refusals — never unresolved, produces a confident answer. */
export function createRefusalSwallowingReasoning(): ReasoningInterface {
  return {
    async deliberate(request: ReasoningRequest): Promise<ReasoningResult> {
      // Receive constraints but drop them (CK-10 violation fixture).
      void request.constraints;
      return {
        conclusion: "probe.ck10.conclusion.swallowed-refusal",
        confidence: 0.95,
        steps: [
          {
            kind: "inference",
            statement: "Answered while ignoring refusal constraints",
            evidenceRefs: [],
          },
        ],
        unresolvedConstraints: [],
      };
    },
  };
}

export function defineRefusalDeclinePathObligation(): Obligation<RefusalConformanceHarness> {
  return defineObligation({
    id: REFUSAL_OBLIGATION_IDS.declinePath,
    contract: "CognitiveCore",
    mustText: MUST_REFUSAL_DECLINE,
    specIds: ["CK-10"],
    async check(impl, ctx) {
      const input = buildRefusalDeclineProbeInput(ctx);
      const out = await impl.turn(input);

      if (!out.declined) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.declinePath,
          mustText: MUST_REFUSAL_DECLINE,
          contract: "CognitiveCore",
          message:
            "turn completed normally despite out-of-scope probe (expected decline)",
        });
      }
      if (!out.refusalCategories.includes(REFUSAL_PROBE_LEGAL)) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.declinePath,
          mustText: MUST_REFUSAL_DECLINE,
          contract: "CognitiveCore",
          message: "decline missing legal-advice refusal category",
        });
      }
      if (
        out.reply.includes(impl.profile.charter) ||
        out.reply.includes("do-not-echo-in-decline")
      ) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.declinePath,
          mustText: MUST_REFUSAL_DECLINE,
          contract: "CognitiveCore",
          message: "decline reply leaked charter / system-prompt internals",
        });
      }
      if (
        out.reply.includes(
          "probe.ck10.normal-completion.should-not-appear-on-decline",
        )
      ) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.declinePath,
          mustText: MUST_REFUSAL_DECLINE,
          contract: "CognitiveCore",
          message: "decline path invoked model.generate (normal completion text)",
        });
      }
      if (!/decline|scope of practice/i.test(out.reply)) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.declinePath,
          mustText: MUST_REFUSAL_DECLINE,
          contract: "CognitiveCore",
          message: "decline reply missing decline-and-explain language",
        });
      }
      if (out.refusalCategories.some((c) => c.includes("charter"))) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.declinePath,
          mustText: MUST_REFUSAL_DECLINE,
          contract: "CognitiveCore",
          message: "refusalCategories must not carry charter text",
        });
      }
    },
  });
}

export function defineRefusalsAsConstraintsObligation(): Obligation<RefusalConformanceHarness> {
  return defineObligation({
    id: REFUSAL_OBLIGATION_IDS.refusalsAsConstraints,
    contract: "CognitiveCore",
    mustText: MUST_REFUSALS_AS_CONSTRAINTS,
    specIds: ["CK-10"],
    async check(impl, ctx) {
      const input = buildInScopeProbeInput(ctx);
      await impl.turn(input);
      const seen = impl.lastDeliberateConstraints();
      if (!Array.isArray(seen)) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.refusalsAsConstraints,
          mustText: MUST_REFUSALS_AS_CONSTRAINTS,
          contract: "CognitiveCore",
          message: "Reason never observed constraints (deliberate not reached)",
        });
      }
      const expected = impl.profile.refusals.slice(0, 64);
      for (const refusal of expected) {
        if (!seen.includes(refusal)) {
          throw new ObligationViolation({
            obligationId: REFUSAL_OBLIGATION_IDS.refusalsAsConstraints,
            mustText: MUST_REFUSALS_AS_CONSTRAINTS,
            contract: "CognitiveCore",
            message: `profile refusal missing from deliberate() constraints: ${refusal}`,
          });
        }
      }
    },
  });
}

export function defineConservativeUnresolvedObligation(): Obligation<RefusalConformanceHarness> {
  return defineObligation({
    id: REFUSAL_OBLIGATION_IDS.conservativeUnresolved,
    contract: "CognitiveCore",
    mustText: MUST_CONSERVATIVE_UNRESOLVED_REFUSAL,
    specIds: ["CK-10"],
    async check(impl, ctx) {
      const input = buildConservativeUnresolvedProbeInput(ctx);
      const out = await impl.turn(input);
      if (!out.declined) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.conservativeUnresolved,
          mustText: MUST_CONSERVATIVE_UNRESOLVED_REFUSAL,
          contract: "CognitiveCore",
          message:
            "cannot-evaluate refusal probe completed normally (expected conservative decline)",
        });
      }
      const named = out.refusalCategories;
      if (
        !named.includes(REFUSAL_PROBE_LEGAL) &&
        !named.includes(REFUSAL_PROBE_PRESCRIPTION)
      ) {
        throw new ObligationViolation({
          obligationId: REFUSAL_OBLIGATION_IDS.conservativeUnresolved,
          mustText: MUST_CONSERVATIVE_UNRESOLVED_REFUSAL,
          contract: "CognitiveCore",
          message:
            "conservative decline must name at least one unresolved refusal category",
        });
      }
      // Partial-scope: explain the out-of-scope categories, not silent omit.
      for (const cat of named) {
        if (!out.reply.includes(cat)) {
          throw new ObligationViolation({
            obligationId: REFUSAL_OBLIGATION_IDS.conservativeUnresolved,
            mustText: MUST_CONSERVATIVE_UNRESOLVED_REFUSAL,
            contract: "CognitiveCore",
            message: `decline reply omitted named refusal category: ${cat}`,
          });
        }
      }
    },
  });
}

export function registerRefusalDeclinePathObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineRefusalDeclinePathObligation());
  return registry;
}

export function registerRefusalsAsConstraintsObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineRefusalsAsConstraintsObligation());
  return registry;
}

export function registerConservativeUnresolvedObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineConservativeUnresolvedObligation());
  return registry;
}

/** Full CK-10 refusal obligation set . */
export function registerRefusalObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerRefusalDeclinePathObligation(registry);
  registerRefusalsAsConstraintsObligation(registry);
  registerConservativeUnresolvedObligation(registry);
  return registry;
}

export function createRefusalDeclinePathObligationRegistry(): ObligationRegistry {
  return registerRefusalDeclinePathObligation(new ObligationRegistry());
}

export function createRefusalObligationsRegistry(): ObligationRegistry {
  return registerRefusalObligations(new ObligationRegistry());
}

/** Known-good: CognitiveCore + scope-aware reasoner (passes all CK-10.*). */
export function createCompliantRefusalHarnessFactory(): ImplementationFactory<RefusalConformanceHarness> {
  return (_ctx: FactoryContext) =>
    harnessFrom(baseProfile(), createScopeAwareReasoning());
}

/**
 * Violation for CK-10.1: ignores unresolved refusals and always completes
 * via model.generate (legacy Stage-0 loop).
 */
export function createDeclineIgnoringHarnessFactory(): ImplementationFactory<RefusalConformanceHarness> {
  return (_ctx: FactoryContext) => {
    const profile = baseProfile();
    const sink: { last: string[] | undefined } = { last: undefined };
    const bindings = baseBindings({
      reasoning: withConstraintRecording(createScopeAwareReasoning(), sink),
    });
    return {
      profile,
      lastDeliberateConstraints: () => sink.last,
      async turn(input) {
        const memories = await bindings.memory.recall({
          subjectId: input.subjectId,
          query: input.utterance,
          limit: 6,
        });
        const passages = await bindings.knowledge.retrieve({
          query: input.utterance,
          limit: 6,
        });
        const reasoning = await bindings.reasoning.deliberate({
          proposition: input.utterance,
          evidence: [
            ...memories.map((m) => ({
              sourceRef: `memory:${m.item.id}`,
              content: m.item.text,
            })),
            ...passages.map((p) => ({
              sourceRef: p.citation,
              content: p.content,
              confidence: p.score,
            })),
          ],
          constraints: profile.refusals,
          effort: "standard",
        });
        void unresolvedRefusalCategories(
          profile.refusals,
          reasoning.unresolvedConstraints,
        );
        const generation = await bindings.model.generate([
          { role: "system", content: profile.charter },
          { role: "user", content: input.utterance },
        ]);
        const trace = await bindings.memory.remember({
          subjectId: input.subjectId,
          topicId: profile.domainId,
          text: `Q: ${input.utterance}\nConclusion: ${reasoning.conclusion}`,
          kind: "episodic",
          createdAt: new Date().toISOString(),
        });
        return {
          reply: generation.text,
          citations: passages.map((p) => p.citation),
          traceRef: trace.id,
          plan: null,
          declined: false,
          refusalCategories: [],
        };
      },
    };
  };
}

/**
 * Canonical violation fixture : Reason swallows refusal
 * constraints → no unresolved → normal completion (fails CK-10.1 / CK-10.3).
 */
export function createRefusalSwallowingHarnessFactory(): ImplementationFactory<RefusalConformanceHarness> {
  return (_ctx: FactoryContext) =>
    harnessFrom(baseProfile(), createRefusalSwallowingReasoning());
}

/**
 * Violation for CK-10.2: turn path never forwards profile.refusals into
 * deliberate() constraints.
 */
export function createConstraintsDroppedHarnessFactory(): ImplementationFactory<RefusalConformanceHarness> {
  return (_ctx: FactoryContext) => {
    const profile = baseProfile();
    const sink: { last: string[] | undefined } = { last: undefined };
    const bindings = baseBindings({
      reasoning: withConstraintRecording(createScopeAwareReasoning(), sink),
    });
    return {
      profile,
      lastDeliberateConstraints: () => sink.last,
      async turn(input) {
        const reasoning = await bindings.reasoning.deliberate({
          proposition: input.utterance,
          evidence: [
            {
              sourceRef: "probe",
              content: "probe",
              confidence: 1,
            },
          ],
          // Dropped — Stage-0 / buggy composition.
          constraints: [],
          effort: "standard",
        });
        const generation = await bindings.model.generate([
          { role: "user", content: input.utterance },
        ]);
        const trace = await bindings.memory.remember({
          subjectId: input.subjectId,
          topicId: profile.domainId,
          text: `Q: ${input.utterance}\n${reasoning.conclusion}`,
          kind: "episodic",
          createdAt: new Date().toISOString(),
        });
        return {
          reply: generation.text,
          citations: [],
          traceRef: trace.id,
          plan: null,
          declined: false,
          refusalCategories: [],
        };
      },
    };
  };
}

export const REFUSAL_VIOLATION_FIXTURES: RefusalViolationFixture[] = [
  {
    fixtureId: "refusal.violation.decline-ignoring",
    targetObligationId: REFUSAL_OBLIGATION_IDS.declinePath,
    description:
      "Loop ignores unresolved refusals and always returns a normal completion",
    factory: createDeclineIgnoringHarnessFactory(),
  },
  {
    fixtureId: "refusal.violation.constraint-swallowing",
    targetObligationId: REFUSAL_OBLIGATION_IDS.declinePath,
    description:
      "Reasoner swallows refusal constraints (empty unresolved) so core never declines",
    factory: createRefusalSwallowingHarnessFactory(),
  },
  {
    fixtureId: "refusal.violation.constraints-dropped",
    targetObligationId: REFUSAL_OBLIGATION_IDS.refusalsAsConstraints,
    description: "Composition drops profile.refusals before deliberate()",
    factory: createConstraintsDroppedHarnessFactory(),
  },
  {
    fixtureId: "refusal.violation.optimistic-swallow",
    targetObligationId: REFUSAL_OBLIGATION_IDS.conservativeUnresolved,
    description:
      "Swallowing reasoner clears unresolved on cannot-evaluate probes (optimistic answer)",
    factory: createRefusalSwallowingHarnessFactory(),
  },
];

export function listRefusalViolationFixtures(): RefusalViolationFixture[] {
  return REFUSAL_VIOLATION_FIXTURES.slice();
}

export { formatDeclineReply, unresolvedRefusalCategories };
