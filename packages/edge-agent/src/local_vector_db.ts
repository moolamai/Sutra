/**
 * @module local_vector_db
 *
 * Offline vector memory of the Edge Harness — the on-device mirror of the
 * cloud Memory & Context Engine (MCE).
 *
 * Storage strategy: a `StorageDriver` abstraction over SQLite so the same
 * logic runs on expo-sqlite (mobile), better-sqlite3 (desktop/CI), and
 * wa-sqlite/OPFS (web). Vectors are packed Float32 BLOBs; similarity search
 * is brute-force cosine over a working set bounded by `maxResidentVectors`.
 *
 * `semantic` kind, `deleteById`, query-dimension hard error,
 * injectable `nowMs` for decay probes.
 * Kind-aware decay factor + correction pinning under scan
 * caps; recall ordering prefers pinned kinds when scores tie.
 */

import type { StorageDriver } from "@moolam/contracts";
import type { ConceptId, HLCTimestamp } from "@moolam/sync-protocol";

export type { StorageDriver };

/** Memory class shared with MemoryInterface kinds (incl. semantic). */
export type VectorMemoryKind =
  | "correction"
  | "milestone"
  | "preference"
  | "episodic"
  | "semantic";

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
  /** Memory class drives decay: corrections/semantic never decay; episodics do. */
  kind: VectorMemoryKind;
  createdAt: HLCTimestamp;
}

export interface ScoredMemory {
  record: MemoryRecord;
  /** Cosine similarity in [-1, 1], already decay-weighted. */
  score: number;
}

export type LocalVectorDbOptions = {
  /** Hard cap on rows scanned per query; oldest episodics evicted first. */
  maxResidentVectors?: number;
  /** Half-life (days) applied to episodic memories during scoring. */
  episodicHalfLifeDays?: number;
  /** Injected clock for decay (MEMOADAP / CK-02.2). Defaults to Date.now. */
  nowMs?: () => number;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_records (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL,
  concept_id  TEXT NOT NULL,
  text        TEXT NOT NULL,
  vector      BLOB NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('correction','milestone','preference','episodic','semantic')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_subject_concept
  ON memory_records (subject_id, concept_id);
`;

/** MCE-03 / CK-02.2 default episodic half-life (30 days). */
export const EPISODIC_HALF_LIFE_DAYS = 30;
export const EPISODIC_HALF_LIFE_MS = EPISODIC_HALF_LIFE_DAYS * 86_400_000;

/** Accept ISO-8601 or HLC physical prefix for age computation. */
export function parseMemoryCreatedAtMs(createdAt: string): number {
  const iso = Date.parse(createdAt);
  if (!Number.isNaN(iso)) return iso;
  const physical = Number(createdAt.slice(0, 15));
  if (!Number.isFinite(physical)) {
    throw new Error(`unparseable createdAt: ${createdAt}`);
  }
  return physical;
}

/**
 * Kind-aware decay (CK-02.2): only `episodic` decays; correction /
 * milestone / preference / semantic stay at 1.0 (never forget corrections).
 */
export function kindAwareDecayFactor(
  kind: VectorMemoryKind,
  createdAt: string,
  nowMs: number,
  halfLifeMs: number = EPISODIC_HALF_LIFE_MS,
): number {
  if (kind !== "episodic") return 1;
  const ageMs = Math.max(0, nowMs - parseMemoryCreatedAtMs(createdAt));
  if (ageMs === 0) return 1;
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

/**
 * Pin priority for tie-breaks and working-set retention (lower = stronger).
 * Corrections are pinned above all other kinds.
 */
export function memoryKindPinRank(kind: VectorMemoryKind): number {
  switch (kind) {
    case "correction":
      return 0;
    case "milestone":
      return 1;
    case "preference":
      return 2;
    case "semantic":
      return 3;
    case "episodic":
      return 4;
    default:
      return 5;
  }
}

/**
 * Working-set selection under `maxResidentVectors`: keep every correction,
 * then fill remaining slots (oldest episodics drop first when over cap).
 */
export function pinCorrectionsInWorkingSet<
  T extends { kind: VectorMemoryKind; created_at: string },
>(rows: readonly T[], cap: number): T[] {
  if (rows.length <= cap) return [...rows];
  const corrections = rows.filter((r) => r.kind === "correction");
  const others = rows
    .filter((r) => r.kind !== "correction")
    .sort((a, b) => {
      // Prefer newer non-corrections when space is scarce.
      return b.created_at.localeCompare(a.created_at);
    });
  if (corrections.length >= cap) {
    // Still never drop a correction below another correction by age — keep all
    // corrections even if over cap (pin invariant beats soft NFR scan cap).
    return corrections;
  }
  const room = cap - corrections.length;
  return [...corrections, ...others.slice(0, room)];
}

/** Score desc, then pin-rank asc (correction before episodic on ties). */
export function compareScoredMemories(a: ScoredMemory, b: ScoredMemory): number {
  if (b.score !== a.score) return b.score - a.score;
  return (
    memoryKindPinRank(a.record.kind) - memoryKindPinRank(b.record.kind)
  );
}

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
    private readonly options: LocalVectorDbOptions = {},
  ) {}

  /** Locked embedding width after first upsert; null until then. */
  get embeddingDimension(): number | null {
    return this.dimension;
  }

  /** Create tables/indexes. Safe to call on every app launch. */
  async initialize(): Promise<void> {
    for (const statement of SCHEMA_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
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
   * to a concept. Scores are cosine × {@link kindAwareDecayFactor}; corrections
   * never decay and are pinned in the working set under scan caps.
   */
  async search(
    subjectId: string,
    queryVector: Float32Array,
    opts: { conceptId?: ConceptId; limit?: number } = {},
  ): Promise<ScoredMemory[]> {
    if (this.dimension !== null && queryVector.length !== this.dimension) {
      throw new Error(
        `query vector dimension ${queryVector.length} does not match store dimension ${this.dimension}; ` +
          "re-embed before switching embedding models",
      );
    }

    const limit = opts.limit ?? 8;
    const cap = this.options.maxResidentVectors ?? 50_000;
    // Fetch the full subject/topic slice, then pin corrections before cap —
    // SQL LIMIT alone could drop corrections underneath episodic noise.
    const fetched = await this.driver.query<{
      id: string;
      subject_id: string;
      concept_id: string;
      text: string;
      vector: Uint8Array;
      kind: VectorMemoryKind;
      created_at: string;
    }>(
      opts.conceptId
        ? `SELECT * FROM memory_records WHERE subject_id = ? AND concept_id = ?`
        : `SELECT * FROM memory_records WHERE subject_id = ?`,
      opts.conceptId ? [subjectId, opts.conceptId] : [subjectId],
    );
    const rows = pinCorrectionsInWorkingSet(fetched, cap);

    const halfLifeMs =
      (this.options.episodicHalfLifeDays ?? EPISODIC_HALF_LIFE_DAYS) *
      86_400_000;
    const nowMs = this.options.nowMs?.() ?? Date.now();

    const scored: ScoredMemory[] = rows.map((row) => {
      const vector = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4,
      );
      const similarity = cosine(queryVector, vector);
      const decay = kindAwareDecayFactor(
        row.kind,
        row.created_at,
        nowMs,
        halfLifeMs,
      );
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

    return scored.sort(compareScoredMemories).slice(0, limit);
  }

  /** Delete one row by id (MemoryInterface.forget). */
  async deleteById(id: string): Promise<void> {
    await this.driver.execute(`DELETE FROM memory_records WHERE id = ?`, [id]);
  }

  /**
   * Remove episodic records past retention. When `subjectId` is set, only that
   * subject's rows are pruned (subject isolation).
   */
  async pruneEpisodicOlderThan(
    cutoff: HLCTimestamp,
    subjectId?: string,
  ): Promise<number> {
    if (subjectId !== undefined && subjectId.trim().length > 0) {
      const sid = subjectId.trim();
      const before = await this.driver.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memory_records WHERE kind = 'episodic' AND created_at < ? AND subject_id = ?`,
        [cutoff, sid],
      );
      await this.driver.execute(
        `DELETE FROM memory_records WHERE kind = 'episodic' AND created_at < ? AND subject_id = ?`,
        [cutoff, sid],
      );
      return before[0]?.n ?? 0;
    }
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

/**
 * Durable in-memory StorageDriver for the SQL LocalVectorDb issues.
 * execute flushes rows before resolve (CK-02.1 substrate).
 */
export function createLocalVectorMemoryDriver(): StorageDriver & {
  rowCount(): number;
} {
  const rows = new Map<
    string,
    {
      id: string;
      subject_id: string;
      concept_id: string;
      text: string;
      vector: Uint8Array;
      kind: VectorMemoryKind;
      created_at: string;
    }
  >();

  return {
    rowCount: () => rows.size,

    async execute(sql: string, params: unknown[] = []): Promise<void> {
      const s = sql.trim();
      if (s.startsWith("CREATE")) return;
      if (sql.includes("INSERT OR REPLACE INTO memory_records")) {
        const id = String(params[0]);
        const vector = params[4];
        const blob =
          vector instanceof Uint8Array
            ? vector
            : vector instanceof Float32Array
              ? new Uint8Array(vector.buffer.slice(0))
              : new Uint8Array(vector as ArrayBuffer);
        rows.set(id, {
          id,
          subject_id: String(params[1]),
          concept_id: String(params[2]),
          text: String(params[3]),
          vector: blob,
          kind: String(params[5]) as VectorMemoryKind,
          created_at: String(params[6]),
        });
        return;
      }
      if (sql.includes("DELETE FROM memory_records WHERE id = ?")) {
        rows.delete(String(params[0]));
        return;
      }
      if (sql.includes("DELETE FROM memory_records WHERE kind = 'episodic'")) {
        const cutoff = String(params[0]);
        const subjectScoped = sql.includes("subject_id = ?");
        const sid = subjectScoped ? String(params[1]) : null;
        for (const [id, r] of [...rows.entries()]) {
          if (
            r.kind === "episodic" &&
            r.created_at < cutoff &&
            (sid === null || r.subject_id === sid)
          ) {
            rows.delete(id);
          }
        }
      }
    },

    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes("COUNT(*)")) {
        const cutoff = String(params[0]);
        const subjectScoped = sql.includes("subject_id = ?");
        const sid = subjectScoped ? String(params[1]) : null;
        const n = [...rows.values()].filter(
          (r) =>
            r.kind === "episodic" &&
            r.created_at < cutoff &&
            (sid === null || r.subject_id === sid),
        ).length;
        return [{ n }] as T[];
      }
      const subjectId = String(params[0]);
      let bySubject = [...rows.values()].filter(
        (r) => r.subject_id === subjectId,
      );
      if (sql.includes("concept_id = ?")) {
        const conceptId = String(params[1]);
        bySubject = bySubject.filter((r) => r.concept_id === conceptId);
      }
      const limitIdx = sql.includes("concept_id = ?") ? 2 : 1;
      const limit =
        typeof params[limitIdx] === "number"
          ? (params[limitIdx] as number)
          : bySubject.length;
      return bySubject.slice(0, limit) as T[];
    },
  };
}
