/**
 * Reference KnowledgeConnectorInterface — cited, bundled-offline, truthful asOf
 * (CK-09). Ported from examples/_shared/mocks.mjs with obligation-grade semantics.
 *
 * @module knowledge
 */

import type {
  KnowledgeConnectorInterface,
  KnowledgePassage,
  KnowledgeQuery,
  KnowledgeSourceDescriptor,
} from "@moolam/contracts";

import { cosineLike, embedText } from "./embed.js";
import type { ContractMockEmit } from "./events.js";

export const KNOWLEDGE_PASSAGE_LIMIT = 64;

/** Default corpus source for conformance / examples that omit overrides. */
export const DEFAULT_KNOWLEDGE_SOURCE_ID = "probe.ck09.source.ref";

/** asOf must not postdate the CK-09.3 check clock (2025-01-15). */
export const DEFAULT_KNOWLEDGE_AS_OF = "2024-06-01";

export type KnowledgePassageSeed = {
  content: string;
  asOf?: string;
  citation?: string;
};

export type KnowledgeMockOptions = {
  sourceId?: string;
  title?: string;
  domain?: string;
  locality?: KnowledgeSourceDescriptor["locality"];
  coverage?: KnowledgeSourceDescriptor["coverage"];
  passages?: readonly KnowledgePassageSeed[];
  deviceId?: string;
  subjectId?: string;
  emit?: ContractMockEmit;
};

export type KnowledgeMockHarness = {
  knowledge: KnowledgeConnectorInterface;
  isNetworkAllowed(): boolean;
  setNetworkAllowed(allowed: boolean): void;
  nowMs(): number;
  setNowMs(ms: number): void;
};

const DEFAULT_PASSAGES: readonly KnowledgePassageSeed[] = [
  { content: "probe.ck09.passage.1.token", asOf: DEFAULT_KNOWLEDGE_AS_OF },
  { content: "probe.ck09.passage.2.token", asOf: DEFAULT_KNOWLEDGE_AS_OF },
];

function buildSources(options: KnowledgeMockOptions): KnowledgeSourceDescriptor[] {
  const sourceId = options.sourceId?.trim() || DEFAULT_KNOWLEDGE_SOURCE_ID;
  return [
    {
      sourceId,
      title: options.title ?? sourceId,
      domain: options.domain ?? sourceId,
      locality: options.locality ?? "bundled-offline",
      coverage: options.coverage ?? { from: "2020-01-01", to: "2026-01-01" },
    },
  ];
}

/**
 * Citation-bearing, bundled-offline knowledge connector.
 * retrieve never requires network when locality is bundled-offline.
 */
export function createKnowledgeMock(
  options: KnowledgeMockOptions = {},
): KnowledgeConnectorInterface {
  const sources = buildSources(options);
  const sourceId = sources[0]!.sourceId;
  const seeds = (options.passages ?? DEFAULT_PASSAGES).slice(
    0,
    KNOWLEDGE_PASSAGE_LIMIT,
  );
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;

  const corpus: KnowledgePassage[] = seeds.map((p, i) => ({
    sourceId,
    citation: p.citation?.trim() || `${sourceId}#${i + 1}`,
    content: p.content,
    score: 1 - i * 0.1,
    asOf: p.asOf?.trim() || DEFAULT_KNOWLEDGE_AS_OF,
  }));

  return {
    get sources() {
      return sources;
    },

    async retrieve(query: KnowledgeQuery): Promise<KnowledgePassage[]> {
      try {
        const limit = Math.min(query.limit ?? 8, KNOWLEDGE_PASSAGE_LIMIT);
        const allowed =
          !query.sourceIds ||
          query.sourceIds.length === 0 ||
          query.sourceIds.includes(sourceId);
        if (!allowed) {
          emit?.({
            event: "contract_mocks.knowledge",
            op: "retrieve",
            subjectId,
            deviceId,
            outcome: "ok",
            passageCount: 0,
          });
          return [];
        }
        const qVec = embedText(query.query);
        const scored = corpus.map((row) => {
          const score = Math.max(
            0,
            Math.min(1, cosineLike(qVec, embedText(row.content))),
          );
          return { ...row, score: score > 0 ? score : row.score * 0.5 };
        });
        scored.sort((a, b) => b.score - a.score);
        // Always return cited hits for bundled-offline (degraded beats none).
        const out =
          scored.length > 0
            ? scored.slice(0, limit)
            : corpus.slice(0, Math.max(1, limit));
        emit?.({
          event: "contract_mocks.knowledge",
          op: "retrieve",
          subjectId,
          deviceId,
          outcome: "ok",
          passageCount: out.length,
        });
        return out;
      } catch (err) {
        emit?.({
          event: "contract_mocks.knowledge",
          op: "retrieve",
          subjectId,
          deviceId,
          outcome: "error",
          passageCount: 0,
        });
        throw err;
      }
    },
  };
}

/**
 * Conformance harness: network deny + injectable clock over the reference corpus.
 * Bundled-offline retrieve ignores network deny (CK-09.2).
 */
export function createKnowledgeMockHarnessFactory(
  options: KnowledgeMockOptions = {},
): () => KnowledgeMockHarness {
  return () => {
    let networkAllowed = true;
    let now = Date.parse("2025-01-15T12:00:00.000Z");
    const knowledge = createKnowledgeMock({
      ...options,
      locality: options.locality ?? "bundled-offline",
    });
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
  };
}

/** examples/_shared alias. */
export function makeKnowledge(
  sourceId: string,
  passages: readonly KnowledgePassageSeed[],
): KnowledgeConnectorInterface {
  return createKnowledgeMock({ sourceId, passages });
}
