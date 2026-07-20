import type { SyncRequest, SyncResponse } from "sutra-sdk";

export interface SyncTransportOptions {
  subjectId: string;
  baseUrl?: string;
}

export type HttpSyncTransport = {
  postSync(request: SyncRequest): Promise<
    | { kind: "ok"; response: SyncResponse }
    | { kind: "http-error"; status: number; body: string }
    | { kind: "network-error"; cause: string }
  >;
};

/** HTTP SyncTransport posting to a cloud harness `/v1/sync` endpoint. */
export function createSyncTransport(opts: SyncTransportOptions): HttpSyncTransport {
  const baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/u, "");

  return {
    async postSync(request) {
      if (request.edgeState.subjectId !== opts.subjectId) {
        return {
          kind: "http-error",
          status: 403,
          body: "subjectId mismatch at transport boundary",
        };
      }

      try {
        const res = await fetch(`${baseUrl}/v1/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!res.ok) {
          return { kind: "http-error", status: res.status, body: await res.text() };
        }
        return { kind: "ok", response: (await res.json()) as SyncResponse };
      } catch (err) {
        return {
          kind: "network-error",
          cause: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export function isOfflineTransport(_transport: HttpSyncTransport): boolean {
  return false;
}
