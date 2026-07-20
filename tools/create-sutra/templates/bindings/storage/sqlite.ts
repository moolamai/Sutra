import type { StorageDriver } from "sutra-sdk";

export interface StorageDriverOptions {
  subjectId: string;
}

/**
 * SQLite seam — wire better-sqlite3 (desktop) or wa-sqlite/OPFS (web).
 * Compiles without manual edits; throws until you install the platform driver.
 */
export function createStorageDriver(opts: StorageDriverOptions): StorageDriver {
  void opts;
  throw new Error(
    "sqlite StorageDriver stub: install better-sqlite3 and implement execute/query",
  );
}
