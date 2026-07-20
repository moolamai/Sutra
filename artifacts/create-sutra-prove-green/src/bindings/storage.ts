import type { StorageDriver } from "sutra-sdk";

export interface StorageDriverOptions {
  /** Sovereign scope — all durable rows are keyed by subject. */
  subjectId: string;
}

/** In-memory StorageDriver for local development and smoke tests. */
export function createStorageDriver(_opts: StorageDriverOptions): StorageDriver {
  return {
    async execute(_sql: string, _params?: unknown[]): Promise<void> {},
    async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
      return [];
    },
  };
}
