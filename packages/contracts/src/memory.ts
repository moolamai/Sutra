/**
 * @module memory
 *
 * Memory contract - the agent's long-term adaptation substrate.
 *
 * Implementations may bind ANY store: pgvector, SQLite (the edge mirror),
 * Qdrant, Milvus, a property graph (Neo4j/NebulaGraph), or a hybrid
 * vector+graph store. The core never assumes a storage topology; it
 * assumes only the contract below.
 *
 * Memory kinds are domain-neutral:
 *   - "correction"  : a misconception/error the companion must not forget
 *                     (a misread precedent, a misdiagnosed pattern)
 *   - "milestone"   : a breakthrough/decision worth anchoring to
 *   - "preference"  : how this principal likes to work
 *   - "episodic"    : raw interaction traces, decay-eligible
 *   - "semantic"    : distilled domain facts about the principal's context
 */

export type MemoryKind = "correction" | "milestone" | "preference" | "episodic" | "semantic";

/** One retrievable memory item. `subjectId` is the principal the agent serves. */
export interface MemoryItem {
  id: string;
  subjectId: string;
  /** Domain-defined topic key (concept id, matter id, case id, ticker…). */
  topicId: string;
  text: string;
  kind: MemoryKind;
  /** Optional relations to other memories — lets graph stores shine; vector stores may ignore. */
  relatedIds?: string[];
  /** HLC or ISO-8601; must be totally ordered within a subject. */
  createdAt: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface MemoryQuery {
  subjectId: string;
  /** Natural-language query; the store embeds it via its bound ModelInterface. */
  query: string;
  topicId?: string;
  kinds?: MemoryKind[];
  limit?: number;
}

export interface ScoredMemoryItem {
  item: MemoryItem;
  /** Relevance in [0,1] after the store's own decay/weighting policy. */
  score: number;
}

/**
 * The contract every memory backend implements.
 *
 * Contract requirements:
 *  1. `remember` MUST be durable before resolving.
 *  2. `recall` MUST apply kind-aware decay: "correction" items never decay.
 *  3. Implementations MUST be safe under concurrent subjects (multi-tenant).
 */
export interface MemoryInterface {
  remember(item: Omit<MemoryItem, "id">): Promise<MemoryItem>;
  recall(query: MemoryQuery): Promise<ScoredMemoryItem[]>;
  /** Link two memories (no-op for pure vector stores; edges for graph stores). */
  associate(fromId: string, toId: string, relation: string): Promise<void>;
  forget(id: string): Promise<void>;
  /** Compact decayed episodic memories past the retention horizon. */
  compact(subjectId: string, olderThanDays: number): Promise<number>;
}
