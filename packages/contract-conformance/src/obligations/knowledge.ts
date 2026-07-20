/**
 * KnowledgeConnectorInterface obligations and violation
 * fixtures (003).
 *
 * CK-09.1 — every retrieved passage MUST carry a non-empty resolvable
 * `citation` whose `sourceId` resolves through the connector's own
 * describe surface (`sources`).
 * CK-09.2 — connectors declaring `bundled-offline` MUST answer `retrieve`
 * when the harness denies network access.
 * CK-09.3 — `asOf` MUST be truthful (must not postdate the check clock).
 *
 * Fixtures (each fails exactly one MUST)
 *   uncited-passage → CK-09.1
 *   offline-liar    → CK-09.2
 */

import type {
  KnowledgeConnectorInterface,
  KnowledgePassage,
  KnowledgeQuery,
  KnowledgeSourceDescriptor,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

/**
 * Verbatim MUST sentence from `packages/contracts/src/knowledge.ts`
 * (contract requirement #1).
 */
export const MUST_CITATION_RESOLVABLE =
  "Every passage MUST carry a resolvable `citation` - uncited knowledge is inadmissible to the ReasoningInterface by core policy.";

/**
 * Contract requirement #2 (bundled-offline offline retrieve).
 */
export const MUST_BUNDLED_OFFLINE =
  'Connectors MUST answer `retrieve` from bundled indexes when offline if their locality is "bundled-offline"; degraded results beat none.';

/**
 * Contract requirement #3 (truthful asOf).
 */
export const MUST_ASOF_TRUTHFUL =
  "`asOf` MUST be truthful; the reasoning layer weighs staleness.";

export const KNOWLEDGE_OBLIGATION_IDS = {
  citationPresence: "CK-09.1",
  bundledOffline: "CK-09.2",
  truthfulAsOf: "CK-09.3",
} as const;

/** Max passages / sources inspected per probe (NFR / scalability). */
export const KNOWLEDGE_PASSAGE_SCAN_LIMIT = 64;

/** Fixed probe instant for CK-09.3 (UTC). */
export const KNOWLEDGE_CHECK_CLOCK_MS = Date.parse("2025-01-15T12:00:00.000Z");

/**
 * Conformance surface for knowledge connectors.
 * Probe only through `sources` + `retrieve` — never via internals.
 * Network deny + injectable clock drive CK-09.2 / CK-09.3.
 */
export interface KnowledgeConformanceHarness {
  knowledge: KnowledgeConnectorInterface;
  /** When false, network-backed retrieve paths must not be required. */
  isNetworkAllowed(): boolean;
  setNetworkAllowed(allowed: boolean): void;
  /** Wall clock (ms) used to judge truthful asOf. */
  nowMs(): number;
  setNowMs(ms: number): void;
}

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

function withHarnessControls(
  knowledge: KnowledgeConnectorInterface,
  initialNowMs: number = KNOWLEDGE_CHECK_CLOCK_MS,
): KnowledgeConformanceHarness {
  let networkAllowed = true;
  let now = initialNowMs;
  return {
    knowledge,
    isNetworkAllowed: () => networkAllowed,
    setNetworkAllowed: (allowed) => {
      networkAllowed = allowed;
    },
    nowMs: () => now,
    setNowMs: (ms) => {
      now = ms;
    },
  };
}

/** Metadata-only probe query — never embeds raw learner/user content. */
export function buildCitationProbeQuery(ctx: ObligationContext): KnowledgeQuery {
  const token = subjectToken(ctx.subjectId);
  return {
    query: `probe.ck09.1.citation.${token}`,
    limit: 8,
  };
}

export function buildOfflineProbeQuery(ctx: ObligationContext): KnowledgeQuery {
  const token = subjectToken(ctx.subjectId);
  return {
    query: `probe.ck09.2.offline.${token}`,
    limit: 8,
  };
}

export function buildAsOfProbeQuery(ctx: ObligationContext): KnowledgeQuery {
  const token = subjectToken(ctx.subjectId);
  return {
    query: `probe.ck09.3.asof.${token}`,
    limit: 8,
  };
}

function describeSourceIds(
  sources: readonly KnowledgeSourceDescriptor[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(sources)) return ids;
  const limit = Math.min(sources.length, KNOWLEDGE_PASSAGE_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const row = sources[i];
    if (row && typeof row.sourceId === "string" && row.sourceId.trim()) {
      ids.add(row.sourceId);
    }
  }
  return ids;
}

function bundledOfflineSources(
  sources: readonly KnowledgeSourceDescriptor[] | undefined,
): KnowledgeSourceDescriptor[] {
  if (!Array.isArray(sources)) return [];
  const out: KnowledgeSourceDescriptor[] = [];
  const limit = Math.min(sources.length, KNOWLEDGE_PASSAGE_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const row = sources[i];
    if (row?.locality === "bundled-offline") out.push(row);
  }
  return out;
}

function assertCitedAndResolvable(
  passages: KnowledgePassage[] | undefined,
  knownSourceIds: Set<string>,
): void {
  if (!Array.isArray(passages) || passages.length === 0) {
    throw new ObligationViolation({
      obligationId: KNOWLEDGE_OBLIGATION_IDS.citationPresence,
      mustText: MUST_CITATION_RESOLVABLE,
      contract: "KnowledgeConnectorInterface",
      message:
        "retrieve() returned no passages for the citation probe (expected cited hits)",
    });
  }

  const limit = Math.min(passages.length, KNOWLEDGE_PASSAGE_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const passage = passages[i];
    if (!passage) {
      throw new ObligationViolation({
        obligationId: KNOWLEDGE_OBLIGATION_IDS.citationPresence,
        mustText: MUST_CITATION_RESOLVABLE,
        contract: "KnowledgeConnectorInterface",
        message: `passages[${i}] missing`,
      });
    }
    if (typeof passage.citation !== "string" || !passage.citation.trim()) {
      throw new ObligationViolation({
        obligationId: KNOWLEDGE_OBLIGATION_IDS.citationPresence,
        mustText: MUST_CITATION_RESOLVABLE,
        contract: "KnowledgeConnectorInterface",
        message: `passages[${i}] has empty citation (uncited knowledge)`,
      });
    }
    if (typeof passage.sourceId !== "string" || !passage.sourceId.trim()) {
      throw new ObligationViolation({
        obligationId: KNOWLEDGE_OBLIGATION_IDS.citationPresence,
        mustText: MUST_CITATION_RESOLVABLE,
        contract: "KnowledgeConnectorInterface",
        message: `passages[${i}] missing sourceId`,
      });
    }
    if (!knownSourceIds.has(passage.sourceId)) {
      throw new ObligationViolation({
        obligationId: KNOWLEDGE_OBLIGATION_IDS.citationPresence,
        mustText: MUST_CITATION_RESOLVABLE,
        contract: "KnowledgeConnectorInterface",
        message: `passages[${i}] sourceId "${passage.sourceId}" does not resolve through sources describe surface`,
      });
    }
  }
}

/** Parse passage asOf for clock comparison (ISO-8601 preferred). */
export function parseAsOfMs(asOf: string): number {
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) {
    throw new Error(`unparseable asOf: ${asOf}`);
  }
  return ms;
}

export function defineCitationPresenceObligation(): Obligation<KnowledgeConformanceHarness> {
  return defineObligation({
    id: KNOWLEDGE_OBLIGATION_IDS.citationPresence,
    contract: "KnowledgeConnectorInterface",
    mustText: MUST_CITATION_RESOLVABLE,
    specIds: ["CK-09"],
    async check(impl, ctx) {
      const known = describeSourceIds(impl.knowledge.sources);
      if (known.size === 0) {
        throw new ObligationViolation({
          obligationId: KNOWLEDGE_OBLIGATION_IDS.citationPresence,
          mustText: MUST_CITATION_RESOLVABLE,
          contract: "KnowledgeConnectorInterface",
          message: "connector.sources describe surface is empty",
        });
      }
      const query = buildCitationProbeQuery(ctx);
      const passages = await impl.knowledge.retrieve(query);
      assertCitedAndResolvable(passages, known);
    },
  });
}

export function defineBundledOfflineObligation(): Obligation<KnowledgeConformanceHarness> {
  return defineObligation({
    id: KNOWLEDGE_OBLIGATION_IDS.bundledOffline,
    contract: "KnowledgeConnectorInterface",
    mustText: MUST_BUNDLED_OFFLINE,
    specIds: ["CK-09"],
    async check(impl, ctx) {
      const offline = bundledOfflineSources(impl.knowledge.sources);
      if (offline.length === 0) {
        // Vacuous: connector does not declare bundled-offline.
        return;
      }

      impl.setNetworkAllowed(false);
      try {
        const base = buildOfflineProbeQuery(ctx);
        const passages = await impl.knowledge.retrieve({
          ...base,
          sourceIds: offline
            .map((s) => s.sourceId)
            .slice(0, KNOWLEDGE_PASSAGE_SCAN_LIMIT),
        });
        if (!Array.isArray(passages) || passages.length === 0) {
          throw new ObligationViolation({
            obligationId: KNOWLEDGE_OBLIGATION_IDS.bundledOffline,
            mustText: MUST_BUNDLED_OFFLINE,
            contract: "KnowledgeConnectorInterface",
            message:
              "bundled-offline source returned no passages while network was denied",
          });
        }
      } finally {
        impl.setNetworkAllowed(true);
      }
    },
  });
}

export function defineTruthfulAsOfObligation(): Obligation<KnowledgeConformanceHarness> {
  return defineObligation({
    id: KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf,
    contract: "KnowledgeConnectorInterface",
    mustText: MUST_ASOF_TRUTHFUL,
    specIds: ["CK-09"],
    async check(impl, ctx) {
      impl.setNowMs(KNOWLEDGE_CHECK_CLOCK_MS);
      const query = buildAsOfProbeQuery(ctx);
      const passages = await impl.knowledge.retrieve(query);
      if (!Array.isArray(passages) || passages.length === 0) {
        throw new ObligationViolation({
          obligationId: KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf,
          mustText: MUST_ASOF_TRUTHFUL,
          contract: "KnowledgeConnectorInterface",
          message: "retrieve() returned no passages for the asOf probe",
        });
      }

      const now = impl.nowMs();
      const limit = Math.min(passages.length, KNOWLEDGE_PASSAGE_SCAN_LIMIT);
      for (let i = 0; i < limit; i++) {
        const passage = passages[i];
        if (!passage || typeof passage.asOf !== "string") {
          throw new ObligationViolation({
            obligationId: KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf,
            mustText: MUST_ASOF_TRUTHFUL,
            contract: "KnowledgeConnectorInterface",
            message: `passages[${i}] missing asOf`,
          });
        }
        let asOfMs: number;
        try {
          asOfMs = parseAsOfMs(passage.asOf);
        } catch {
          throw new ObligationViolation({
            obligationId: KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf,
            mustText: MUST_ASOF_TRUTHFUL,
            contract: "KnowledgeConnectorInterface",
            message: `passages[${i}] asOf is unparseable`,
          });
        }
        if (asOfMs > now) {
          throw new ObligationViolation({
            obligationId: KNOWLEDGE_OBLIGATION_IDS.truthfulAsOf,
            mustText: MUST_ASOF_TRUTHFUL,
            contract: "KnowledgeConnectorInterface",
            message: `passages[${i}] asOf postdates the check clock (untruthful)`,
          });
        }
      }
    },
  });
}

export function registerCitationPresenceObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineCitationPresenceObligation());
  return registry;
}

export function registerOfflineAndStalenessObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineBundledOfflineObligation());
  registry.register(defineTruthfulAsOfObligation());
  return registry;
}

/** CK-09.1 + CK-09.2 + CK-09.3 */
export function registerKnowledgeObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerCitationPresenceObligation(registry);
  registerOfflineAndStalenessObligations(registry);
  return registry;
}

export function createCitationPresenceObligationRegistry(): ObligationRegistry {
  return registerCitationPresenceObligation(new ObligationRegistry());
}

export function createOfflineStalenessObligationRegistry(): ObligationRegistry {
  return registerOfflineAndStalenessObligations(new ObligationRegistry());
}

export function createKnowledgeObligationsRegistry(): ObligationRegistry {
  return registerKnowledgeObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories (contract-surface only) ── */

const REF_SOURCE_ID = "probe.ck09.source.ref";

function refSources(): KnowledgeSourceDescriptor[] {
  return [
    {
      sourceId: REF_SOURCE_ID,
      title: "CK-09 citation probe corpus",
      domain: "conformance",
      locality: "bundled-offline",
      coverage: { from: "2020-01-01", to: "2026-01-01" },
    },
  ];
}

function citedPassages(limit: number): KnowledgePassage[] {
  const n = Math.max(1, Math.min(limit, 2));
  return Array.from({ length: n }, (_, i) => ({
    sourceId: REF_SOURCE_ID,
    citation: `${REF_SOURCE_ID}#${i + 1}`,
    content: `probe.ck09.passage.${i + 1}.token`,
    score: 1 - i * 0.1,
    asOf: "2024-06-01",
  }));
}

/**
 * Known-good reference: cited passages from a bundled-offline corpus;
 * retrieve never requires network; asOf stays before the check clock.
 */
export function createCitedKnowledgeHarnessFactory(): () => KnowledgeConformanceHarness {
  return () => {
    const harness = withHarnessControls({
      sources: refSources(),
      async retrieve(query) {
        // Honest bundled-offline: ignore network deny.
        const limit = Math.min(query.limit ?? 8, KNOWLEDGE_PASSAGE_SCAN_LIMIT);
        return citedPassages(limit);
      },
    });
    return harness;
  };
}

/**
 * Canonical CK-09.1 fixture : passages emit with empty citations.
 * Still answers offline and keeps truthful asOf so isolation holds.
 */
export function createUncitedKnowledgeHarnessFactory(): () => KnowledgeConformanceHarness {
  return () =>
    withHarnessControls({
      sources: refSources(),
      async retrieve() {
        return [
          {
            sourceId: REF_SOURCE_ID,
            citation: "",
            content: "probe.ck09.1.uncited.token",
            score: 0.9,
            asOf: "2024-06-01",
          },
        ];
      },
    });
}

/** Alias — uncited-passage fixture. */
export const createUncitedPassageKnowledgeHarnessFactory =
  createUncitedKnowledgeHarnessFactory;

/**
 * Violation for CK-09.1: citation present but sourceId absent from describe.
 */
export function createUnresolvedSourceKnowledgeHarnessFactory(): () => KnowledgeConformanceHarness {
  return () =>
    withHarnessControls({
      sources: refSources(),
      async retrieve() {
        return [
          {
            sourceId: "probe.ck09.source.unknown",
            citation: "probe.ck09.source.unknown#1",
            content: "probe.ck09.1.unresolved.token",
            score: 0.9,
            asOf: "2024-06-01",
          },
        ];
      },
    });
}

/**
 * Canonical CK-09.2 fixture : declares bundled-offline but
 * requires network — returns empty under network deny.
 */
export function createOfflineLiarKnowledgeHarnessFactory(): () => KnowledgeConformanceHarness {
  return () => {
    const harness = withHarnessControls({
      sources: refSources(),
      async retrieve(query) {
        if (!harness.isNetworkAllowed()) {
          return [];
        }
        const limit = Math.min(query.limit ?? 8, KNOWLEDGE_PASSAGE_SCAN_LIMIT);
        return citedPassages(limit);
      },
    });
    return harness;
  };
}

/**
 * Violation for CK-09.3: asOf postdates the check clock.
 */
export function createFutureAsOfKnowledgeHarnessFactory(): () => KnowledgeConformanceHarness {
  return () =>
    withHarnessControls({
      sources: refSources(),
      async retrieve() {
        return [
          {
            sourceId: REF_SOURCE_ID,
            citation: `${REF_SOURCE_ID}#future`,
            content: "probe.ck09.3.future-asof.token",
            score: 0.9,
            asOf: "2099-01-01",
          },
        ];
      },
    });
}

/** One deliberately-broken knowledge connector that fails exactly one CK-09.* MUST. */
export interface KnowledgeViolationFixture {
  fixtureId: string;
  targetObligationId: (typeof KNOWLEDGE_OBLIGATION_IDS)[keyof typeof KNOWLEDGE_OBLIGATION_IDS];
  mustText: string;
  summary: string;
  createFactory: () => () => KnowledgeConformanceHarness;
}

/**
 * Named catalog — each fixture fails its target and passes the others.
 */
export const KNOWLEDGE_VIOLATION_FIXTURES = {
  uncitedPassage: {
    fixtureId: "knowledge.violation.uncited-passage",
    targetObligationId: KNOWLEDGE_OBLIGATION_IDS.citationPresence,
    mustText: MUST_CITATION_RESOLVABLE,
    summary: "retrieve() returns passages with empty citation strings",
    createFactory: createUncitedPassageKnowledgeHarnessFactory,
  },
  offlineLiar: {
    fixtureId: "knowledge.violation.offline-liar",
    targetObligationId: KNOWLEDGE_OBLIGATION_IDS.bundledOffline,
    mustText: MUST_BUNDLED_OFFLINE,
    summary:
      "declares bundled-offline but requires network (empty retrieve when denied)",
    createFactory: createOfflineLiarKnowledgeHarnessFactory,
  },
} as const satisfies Record<string, KnowledgeViolationFixture>;

export function listKnowledgeViolationFixtures(): readonly KnowledgeViolationFixture[] {
  return [
    KNOWLEDGE_VIOLATION_FIXTURES.uncitedPassage,
    KNOWLEDGE_VIOLATION_FIXTURES.offlineLiar,
  ];
}
