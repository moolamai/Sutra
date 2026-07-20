/**
 * CAST-05 cold-start obligations (diagnostic probing until roots assessed).
 *
 * CAST-05.1 — While any task-graph root lacks an assessed posterior seed
 *             (≥3 friction samples / mastery evidence units), the router
 *             MUST NOT emit `advance`; new subjects MUST remain in
 *             `diagnostic` mode until every root is assessed.
 *
 * Production routers (TaskRouter, edge coldstart seam, route_core) derive
 * sample counts from mastery Σα+Σβ — same threshold as this obligation's
 * ``frictionSampleCounts`` probe field.
 *
 * Probe only through ColdStartRouterInterface.route (public contract surface).
 */

import {
  CAST_05_MIN_ROOT_FRICTION_SAMPLES,
  MUST_COLD_START_ADVANCE_BLOCKED,
  type ColdStartRouteInput,
  type ColdStartRouterInterface,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

export {
  CAST_05_MIN_ROOT_FRICTION_SAMPLES,
  MUST_COLD_START_ADVANCE_BLOCKED,
};

export const CAST_OBLIGATION_IDS = {
  coldStartAdvanceBlocked: "CAST-05.1",
} as const;

/** Max roots / counts inspected per probe (NFR). */
export const CAST_ROOT_SCAN_LIMIT = 64;

/**
 * Conformance surface for cold-start routers.
 * Probe only through `router.route`.
 */
export interface CastConformanceHarness {
  router: ColdStartRouterInterface;
}

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

/** Subject-scoped probe pack: two roots, one downstream concept. */
export function buildColdStartProbeInput(
  ctx: ObligationContext,
  overrides: Partial<ColdStartRouteInput> = {},
): ColdStartRouteInput {
  const tok = subjectToken(ctx.subjectId);
  const rootA = `probe.cast05.root.a.${tok}`;
  const rootB = `probe.cast05.root.b.${tok}`;
  const active = `probe.cast05.downstream.${tok}`;
  return {
    subjectId: ctx.subjectId,
    activeConceptId: active,
    rootConceptIds: [rootA, rootB],
    frictionSampleCounts: {
      [rootA]: 0,
      [rootB]: 0,
      [active]: 0,
    },
    masteryMeanByConcept: {
      [active]: 0.95,
    },
    ...overrides,
  };
}

export function defineColdStartAdvanceBlockedObligation(): Obligation<CastConformanceHarness> {
  return defineObligation({
    id: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
    contract: "ColdStartRouterInterface",
    mustText: MUST_COLD_START_ADVANCE_BLOCKED,
    specIds: ["CAST-05"],
    async check(impl, ctx) {
      // Edge 1: high-confidence first turn before root probe — must not advance.
      const cold = buildColdStartProbeInput(ctx);
      let result;
      try {
        result = await impl.router.route(cold);
      } catch (err) {
        throw new ObligationViolation({
          obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
          mustText: MUST_COLD_START_ADVANCE_BLOCKED,
          contract: "ColdStartRouterInterface",
          message: `route() threw under cold-start: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      if (result.subjectId !== ctx.subjectId) {
        throw new ObligationViolation({
          obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
          mustText: MUST_COLD_START_ADVANCE_BLOCKED,
          contract: "ColdStartRouterInterface",
          message: `route() subjectId '${result.subjectId}' !== scoped '${ctx.subjectId}'`,
        });
      }
      if (result.routeAction === "advance") {
        throw new ObligationViolation({
          obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
          mustText: MUST_COLD_START_ADVANCE_BLOCKED,
          contract: "ColdStartRouterInterface",
          message:
            "route() emitted advance while root concepts lack assessed posterior seeds",
        });
      }
      if (result.mode !== "diagnostic") {
        throw new ObligationViolation({
          obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
          mustText: MUST_COLD_START_ADVANCE_BLOCKED,
          contract: "ColdStartRouterInterface",
          message: `route() mode '${result.mode}' MUST be diagnostic while roots are unassessed`,
        });
      }
      if (
        !Array.isArray(result.unassessedRootConceptIds) ||
        result.unassessedRootConceptIds.length === 0
      ) {
        throw new ObligationViolation({
          obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
          mustText: MUST_COLD_START_ADVANCE_BLOCKED,
          contract: "ColdStartRouterInterface",
          message:
            "route() MUST list unassessedRootConceptIds while roots lack evidence",
        });
      }

      // Edge 2: partial root assessment — still no advance.
      const [rootA, rootB] = cold.rootConceptIds;
      const partial = buildColdStartProbeInput(ctx, {
        frictionSampleCounts: {
          [rootA!]: CAST_05_MIN_ROOT_FRICTION_SAMPLES,
          [rootB!]: 0,
          [cold.activeConceptId]: 0,
        },
      });
      const partialResult = await impl.router.route(partial);
      if (partialResult.routeAction === "advance") {
        throw new ObligationViolation({
          obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
          mustText: MUST_COLD_START_ADVANCE_BLOCKED,
          contract: "ColdStartRouterInterface",
          message:
            "route() emitted advance while a root still lacks an assessed posterior seed",
        });
      }
      if (partialResult.mode !== "diagnostic") {
        throw new ObligationViolation({
          obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
          mustText: MUST_COLD_START_ADVANCE_BLOCKED,
          contract: "ColdStartRouterInterface",
          message:
            "partial root assessment MUST keep mode diagnostic until every root is assessed",
        });
      }

      // All roots assessed — unassessed list must be empty (advance optional).
      const assessed = buildColdStartProbeInput(ctx, {
        frictionSampleCounts: {
          [rootA!]: CAST_05_MIN_ROOT_FRICTION_SAMPLES,
          [rootB!]: CAST_05_MIN_ROOT_FRICTION_SAMPLES,
          [cold.activeConceptId]: CAST_05_MIN_ROOT_FRICTION_SAMPLES,
        },
      });
      const assessedResult = await impl.router.route(assessed);
      if (
        Array.isArray(assessedResult.unassessedRootConceptIds) &&
        assessedResult.unassessedRootConceptIds.length > 0
      ) {
        throw new ObligationViolation({
          obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
          mustText: MUST_COLD_START_ADVANCE_BLOCKED,
          contract: "ColdStartRouterInterface",
          message:
            "after all roots assessed, unassessedRootConceptIds MUST be empty",
        });
      }

      ctx.emit({
        event: "conformance.obligation",
        obligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
        outcome: "pass",
        subjectId: ctx.subjectId,
        ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
        contract: "ColdStartRouterInterface",
      });
    },
  });
}

export function registerColdStartAdvanceBlockedObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineColdStartAdvanceBlockedObligation());
  return registry;
}

export function createCastObligationsRegistry(): ObligationRegistry {
  const registry = new ObligationRegistry();
  registerColdStartAdvanceBlockedObligation(registry);
  return registry;
}

export function createColdStartAdvanceBlockedObligationRegistry(): ObligationRegistry {
  return createCastObligationsRegistry();
}

type CastFactoryOptions = {
  /** Violation: advance prematurely while roots unassessed. */
  prematureAdvance?: boolean;
};

function createCastFactory(
  options: CastFactoryOptions,
): () => CastConformanceHarness {
  return () => {
    const router: ColdStartRouterInterface = {
      route(input) {
        const roots = input.rootConceptIds.slice(0, CAST_ROOT_SCAN_LIMIT);
        const unassessed = roots.filter(
          (id) =>
            (input.frictionSampleCounts[id] ?? 0) <
            CAST_05_MIN_ROOT_FRICTION_SAMPLES,
        );
        if (options.prematureAdvance && unassessed.length > 0) {
          // Violation fixture: ignore cold-start and advance on high mastery.
          return {
            subjectId: input.subjectId,
            routeAction: "advance",
            mode: "exploratory",
            unassessedRootConceptIds: unassessed,
          };
        }
        if (unassessed.length > 0) {
          return {
            subjectId: input.subjectId,
            routeAction: "diagnostic-probe",
            mode: "diagnostic",
            unassessedRootConceptIds: unassessed,
          };
        }
        const mean = input.masteryMeanByConcept?.[input.activeConceptId] ?? 0.5;
        return {
          subjectId: input.subjectId,
          routeAction: mean >= 0.85 ? "advance" : "hold",
          mode: "exploratory",
          unassessedRootConceptIds: [],
        };
      },
    };
    return { router };
  };
}

/** Known-good reference: blocks advance until all roots assessed. */
export function createCompliantCastHarnessFactory(): () => CastConformanceHarness {
  return createCastFactory({ prematureAdvance: false });
}

/** Violation for CAST-05.1: advances while roots lack assessed seeds. */
export function createPrematureAdvanceCastHarnessFactory(): () => CastConformanceHarness {
  return createCastFactory({ prematureAdvance: true });
}

export interface CastViolationFixture {
  fixtureId: string;
  targetObligationId: (typeof CAST_OBLIGATION_IDS)[keyof typeof CAST_OBLIGATION_IDS];
  mustText: string;
  summary: string;
  createFactory: () => () => CastConformanceHarness;
}

/**
 * Named CAST fixtures — premature-advance router fails CAST-05.1.
 */
export const CAST_VIOLATION_FIXTURES = {
  prematureAdvance: {
    fixtureId: "cast.violation.premature-advance",
    targetObligationId: CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
    mustText: MUST_COLD_START_ADVANCE_BLOCKED,
    summary:
      "router emits advance while root concepts lack assessed posterior seeds",
    createFactory: createPrematureAdvanceCastHarnessFactory,
  },
} as const satisfies Record<string, CastViolationFixture>;

export function listCastViolationFixtures(): readonly CastViolationFixture[] {
  return [CAST_VIOLATION_FIXTURES.prematureAdvance];
}

/**
 * Shared cold-start parity goldens (domain-loader fixtures) — edge + cloud
 * hosts must agree on route sequences for these cases.
 */
export const CAST_COLDSTART_GOLDENS_SCHEMA =
  "teacher-cbse-slice.coldstart-goldens.v1";

export const CAST_COLDSTART_GOLDENS_RELPATH =
  "packages/domain-loader/fixtures/packs/teacher-cbse-slice.coldstart-goldens.json";
