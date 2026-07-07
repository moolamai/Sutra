/**
 * @module local_vector_db
 *
 * Offline vector memory of the Edge Harness — the on-device mirror of the
 * cloud Memory & Context Engine (MCE).
 *
 * Storage strategy: a `StorageDriver` abstraction over SQLite so the same
 * logic runs on expo-sqlite (mobile), better-sqlite3 (desktop/CI), and
 * wa-sqlite/OPFS (web). Vectors are packed Float32 BLOBs; similarity search
 * is brute-force cosine over a working set bounded by `maxResidentVectors`,
 * which is the right trade-off below ~50k vectors on mobile silicon (no
 * ANN index maintenance cost, exact recall, zero native deps).
 */

import type { StorageDriver } from "@moolam/contracts";
import type { ConceptId, HLCTimestamp } from "@moolam/sync-protocol";

export type { StorageDriver };

/** A single retrievable memory: a moment worth remembering about the subject. */
export interface MemoryRecord {
  /** ULID-style unique id, generated on-device. */
  id: string;
  subjectId: string;
  conceptId: ConceptId;
  /** Natural-language content, e.g. "confused derivative with slope of chord". */
  text: string;
  /** Embedding produced by the active SlmRuntime. Dimension is store-wide. */
  vector: Float32Array;
  /** Memory class drives decay: corrections never decay, episodics do. */
  kind: "correction" | "milestone" | "preference" | "episodic";
  createdAt: HLCTimestamp;
}

export interface ScoredMemory {
  record: MemoryRecord;
  /** Cosine similarity in [-1, 1], already decay-weighted. */
  score: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_records (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL,
  concept_id  TEXT NOT NULL,
  text        TEXT NOT NULL,
  vector      BLOB NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('correction','milestone','preference','episodic')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_subject_concept
  ON memory_records (subject_id, concept_id);
`;

/**
 * Brute-force-exact, decay-aware local vector store.
 *
 * All writes are durable before `upsert` resolves; the friction telemetry
 * and sync layers rely on this store never losing an acknowledged record.
 */
export class LocalVectorDb {
  private dimension: number | null = null;

  constructor(
    private readonly driver: StorageDriver,
    private readonly options: {
      /** Hard cap on rows scanned per query; oldest episodics evicted first. */
      maxResidentVectors?: number;
      /** Half-life (days) applied to episodic memories during scoring. */
      episodicHalfLifeDays?: number;
    } = {},
  ) {}

  /** Create tables/indexes. Safe to call on every app launch. */
  async initialize(): Promise<void> {
    for (const statement of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
      await this.driver.execute(statement);
    }
  }

  /** Insert or replace a memory. Dimension is locked by the first write. */
  async upsert(record: MemoryRecord): Promise<void> {
    if (this.dimension === null) this.dimension = record.vector.length;
    if (record.vector.length !== this.dimension) {
      throw new Error(
        `vector dimension ${record.vector.length} does not match store dimension ${this.dimension}; ` +
          "re-embed the corpus before switching embedding models",
      );
    }
    await this.driver.execute(
      `INSERT OR REPLACE INTO memory_records (id, subject_id, concept_id, text, vector, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.subjectId,
        record.conceptId,
        record.text,
        new Uint8Array(record.vector.buffer.slice(0)),
        record.kind,
        record.createdAt,
      ],
    );
  }

  /**
   * Retrieve the memories most relevant to `queryVector`, optionally scoped
   * to a concept. Scores are cosine similarity multiplied by an exponential
   * recency decay for episodic memories — corrections never decay, since
   * a dormant correction is precisely what the agent must not forget.
   */
  async search(
    subjectId: string,
    queryVector: Float32Array,
    opts: { conceptId?: ConceptId; limit?: number } = {},
  ): Promise<ScoredMemory[]> {
    const limit = opts.limit ?? 8;
    const cap = this.options.maxResidentVectors ?? 50_000;
    const rows = await this.driver.query<{
      id: string;
      subject_id: string;
      concept_id: string;
      text: string;
      vector: Uint8Array;
      kind: MemoryRecord["kind"];
      created_at: string;
    }>(
      opts.conceptId
        ? `SELECT * FROM memory_records WHERE subject_id = ? AND concept_id = ? LIMIT ?`
        : `SELECT * FROM memory_records WHERE subject_id = ? LIMIT ?`,
      opts.conceptId ? [subjectId, opts.conceptId, cap] : [subjectId, cap],
    );

    const halfLifeMs = (this.options.episodicHalfLifeDays ?? 30) * 86_400_000;
    const nowMs = Date.now();

    const scored: ScoredMemory[] = rows.map((row) => {
      const vector = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
      const similarity = cosine(queryVector, vector);
      const ageMs = Math.max(0, nowMs - Number(row.created_at.slice(0, 15)));
      const decay = row.kind === "episodic" ? Math.exp((-Math.LN2 * ageMs) / halfLifeMs) : 1;
      return {
        record: {
          id: row.id,
          subjectId: row.subject_id,
          conceptId: row.concept_id,
          text: row.text,
          vector,
          kind: row.kind,
          createdAt: row.created_at as HLCTimestamp,
        },
        score: similarity * decay,
      };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Remove records already merged into the cloud MCE and past retention. */
  async pruneEpisodicOlderThan(cutoff: HLCTimestamp): Promise<number> {
    const before = await this.driver.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_records WHERE kind = 'episodic' AND created_at < ?`,
      [cutoff],
    );
    await this.driver.execute(
      `DELETE FROM memory_records WHERE kind = 'episodic' AND created_at < ?`,
      [cutoff],
    );
    return before[0]?.n ?? 0;
  }
}

/** Cosine similarity; returns 0 for degenerate zero vectors. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
