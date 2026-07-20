import type { StorageDriver } from "sutra-sdk";

export interface StorageDriverOptions {
  subjectId: string;
}

/**
 * Expo SQLite seam for React Native / Expo hosts.
 * Compiles without manual edits; throws until expo-sqlite is wired.
 */
export function createStorageDriver(opts: StorageDriverOptions): StorageDriver {
  void opts;
  throw new Error(
    "expo-sqlite StorageDriver stub: install expo-sqlite and implement execute/query",
  );
}
