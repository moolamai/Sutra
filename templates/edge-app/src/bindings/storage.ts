import type { StorageDriver } from "sutra-sdk";

export type StorageBackend = "memory" | "expo-sqlite";

export type StorageDriverOptions = {
  /** Sovereign scope — every durable row is keyed under this subject. */
  subjectId: string;
  /**
   * `memory` — Node smoke / local typecheck (no native modules).
   * `expo-sqlite` — on-device seam; throws until expo-sqlite is wired.
   */
  backend?: StorageBackend;
  /** Bounded scan of durable rows (NFR — no unbounded walks). */
  scanLimit?: number;
};

const DEFAULT_SCAN_LIMIT = 64;

/**
 * Subject-scoped in-memory StorageDriver for smoke and local development.
 * Keys are namespaced as `${subjectId}::${logicalKey}` so cross-subject
 * reads never observe another subject's rows.
 */
export function createMemoryStorageDriver(
  opts: StorageDriverOptions,
): StorageDriver {
  const subjectId = opts.subjectId.trim();
  if (!subjectId) {
    throw new Error("subjectId is required for StorageDriver");
  }
  const scanLimit = Math.min(
    Math.max(1, opts.scanLimit ?? DEFAULT_SCAN_LIMIT),
    DEFAULT_SCAN_LIMIT,
  );
  const prefix = `${subjectId}::`;
  const rows = new Map<string, string>();

  return {
    async execute(sql: string, params?: unknown[]): Promise<void> {
      const logicalKey = String(params?.[0] ?? "");
      const value = String(params?.[1] ?? "");
      const key = `${prefix}${logicalKey}`;
      if (sql === "UPSERT" || sql === "PENDING") {
        rows.set(key, value);
        return;
      }
      if (sql === "DELETE") {
        rows.delete(key);
        return;
      }
      if (sql === "FLUSH") {
        return;
      }
      // Unknown statements are no-ops for the memory stub (typed contract only).
    },

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      void sql;
      const logicalKey = String(params?.[0] ?? "");
      const key = `${prefix}${logicalKey}`;
      const value = rows.get(key);
      if (value === undefined) return [];
      return [{ key: logicalKey, value }].slice(0, scanLimit) as T[];
    },
  };
}

/**
 * Expo SQLite StorageDriver seam for React Native / Expo hosts.
 * Compiles without manual edits; throws until expo-sqlite is installed
 * and `execute`/`query` are wired to a subject-scoped schema.
 */
export function createExpoSqliteStorageDriver(
  opts: StorageDriverOptions,
): StorageDriver {
  const subjectId = opts.subjectId.trim();
  if (!subjectId) {
    throw new Error("subjectId is required for expo-sqlite StorageDriver");
  }
  return {
    async execute(_sql: string, _params?: unknown[]): Promise<void> {
      throw new Error(
        "expo-sqlite StorageDriver stub: install expo-sqlite and implement subject-scoped execute/query",
      );
    },
    async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
      throw new Error(
        "expo-sqlite StorageDriver stub: install expo-sqlite and implement subject-scoped execute/query",
      );
    },
  };
}

/** Select StorageDriver backend — default memory for Node smoke. */
export function createStorageDriver(opts: StorageDriverOptions): StorageDriver {
  const backend = opts.backend ?? "memory";
  if (backend === "expo-sqlite") {
    return createExpoSqliteStorageDriver(opts);
  }
  return createMemoryStorageDriver(opts);
}
