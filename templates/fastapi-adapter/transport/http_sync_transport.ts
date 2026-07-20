import type { SyncRequest, SyncResponse, SyncTransport } from "sutra-sdk";

export type HttpSyncTransportOptions = {
  /** Sovereign scope enforced at the transport boundary. */
  subjectId: string;
  baseUrl?: string;
  /** Optional header echoed to FastAPI for subject-scope checks. */
  subjectScopeHeader?: boolean;
};

/**
 * SyncTransport posting to a FastAPI `/v1/sync` adapter.
 * Does not import sutra-orchestrator — wire-only HTTP client.
 */
export function createHttpSyncTransport(
  opts: HttpSyncTransportOptions,
): SyncTransport {
  const subjectId = opts.subjectId.trim();
  if (!subjectId) {
    throw new Error("subjectId is required for SyncTransport");
  }
  const baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/u, "");
  const sendScope = opts.subjectScopeHeader !== false;

  return {
    async postSync(request: SyncRequest) {
      if (request.edgeState.subjectId !== subjectId) {
        return {
          kind: "http-error",
          status: 403,
          body: "subjectId mismatch at transport boundary",
        };
      }

      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (sendScope) {
          headers["x-sutra-subject-id"] = subjectId;
        }

        const res = await fetch(`${baseUrl}/v1/sync`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
        });
        if (!res.ok) {
          return {
            kind: "http-error",
            status: res.status,
            body: await res.text(),
          };
        }
        return {
          kind: "ok",
          response: (await res.json()) as SyncResponse,
        };
      } catch (err) {
        return {
          kind: "network-error",
          cause: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
