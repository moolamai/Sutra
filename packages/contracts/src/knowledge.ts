/**
 * @module knowledge
 *
 * Knowledge connector contract - the agent's bridge to authoritative
 * domain corpora and systems of record.
 *
 * Memory (see memory.ts) is what the agent learned about its principal;
 * knowledge is what the world already knows: statutes and case law, drug
 * formularies and clinical guidelines, filings and market data, standards
 * and datasheets, textbooks and reference material. Connectors bind those
 * sources - search APIs, RAG indexes, EHR/FHIR endpoints, internal wikis -
 * behind a single citation-bearing contract.
 */

export interface KnowledgeSourceDescriptor {
  sourceId: string;
  title: string;
  /** e.g. "case-law", "clinical-guideline", "skill-track", "market-data". */
  domain: string;
  /** Data-residency class; sovereign deployments gate external sources. */
  locality: "bundled-offline" | "self-hosted" | "external-api";
  /** Content date coverage — staleness is a first-class property. */
  coverage: { from: string; to: string };
}

export interface KnowledgeQuery {
  query: string;
  /** Restrict to specific sources; empty = connector's default policy. */
  sourceIds?: string[];
  limit?: number;
}

export interface KnowledgePassage {
  sourceId: string;
  /** Stable citation locator (URL, ECLI, PMID, ISBN+page, FHIR ref…). */
  citation: string;
  content: string;
  /** Relevance in [0,1]. */
  score: number;
  /** Publication/effective date of the passage — surfaces staleness. */
  asOf: string;
}

/**
 * Connector metadata surface (locality + truthful asOf + source table).
 * Pack loaders MUST implement `describe()`; citations from `retrieve()`
 * MUST resolve via `describe().sources` (equivalently `sources`).
 */
export interface KnowledgeConnectorDescribe {
  /** Dominant locality class for this connector (sovereign gate). */
  locality: KnowledgeSourceDescriptor["locality"];
  /** Connector/pack-level asOf stamp — truthful staleness. */
  asOf: string;
  sources: readonly KnowledgeSourceDescriptor[];
  /** Present for pack-backed connectors. */
  packId?: string;
  version?: string;
  languages?: readonly string[];
}

/**
 * Contract requirements:
 *  1. Every passage MUST carry a resolvable `citation` - uncited knowledge
 *     is inadmissible to the ReasoningInterface by core policy.
 *  2. Connectors MUST answer `retrieve` from bundled indexes when offline
 *     if their locality is "bundled-offline"; degraded results beat none.
 *  3. `asOf` MUST be truthful; the reasoning layer weighs staleness.
 */
export interface KnowledgeConnectorInterface {
  readonly sources: KnowledgeSourceDescriptor[];
  retrieve(query: KnowledgeQuery): Promise<KnowledgePassage[]>;
  /**
   * Optional describe surface. Pack-backed connectors MUST implement and
   * return bundled-offline (or declared locality) plus truthful asOf.
   */
  describe?(): KnowledgeConnectorDescribe;
}
