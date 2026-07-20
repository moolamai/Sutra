export interface SyncTransportOptions {
  subjectId: string;
  /** Ignored in offline mode — accepted so bootstrap can pass a uniform options shape. */
  baseUrl?: string;
}

/** Offline sovereign mode — no SyncTransport; EdgeAgent runs without cloud sync. */
export type OfflineSyncTransport = null;

export function createSyncTransport(_opts: SyncTransportOptions): OfflineSyncTransport {
  return null;
}

export function isOfflineTransport(transport: OfflineSyncTransport): boolean {
  return transport === null;
}
