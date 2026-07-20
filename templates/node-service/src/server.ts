/**
 * Minimal HTTP host (node:http) with CognitiveCore.
 * Swap the listener for Express/Fastify without changing turn wiring.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runServiceTurn } from "./companion.ts";

export type NodeServiceOptions = {
  host?: string;
  port?: number;
  deviceId?: string;
};

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const limit = 64 * 1024;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ event: "integration_templates.node_service", ...event })}\n`,
  );
}

export function createNodeServiceHandler(opts: NodeServiceOptions = {}) {
  const defaultDeviceId = opts.deviceId ?? "node-service";

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/v1/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/turn") {
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        emit({
          outcome: "fail",
          subjectId: null,
          deviceId: defaultDeviceId,
          phase: "parse",
          obligation: "integration_templates.node_service.invalid_json",
        });
        return;
      }

      const subjectId = String(body.subjectId ?? "").trim();
      const sessionId = String(body.sessionId ?? "").trim();
      const utterance = String(body.utterance ?? "");
      const deviceId = String(body.deviceId ?? defaultDeviceId).trim() || defaultDeviceId;
      const requestId =
        typeof body.requestId === "string" ? body.requestId.trim() : undefined;

      if (!subjectId || !sessionId) {
        sendJson(res, 400, { error: "subjectId_and_sessionId_required" });
        emit({
          outcome: "fail",
          subjectId: subjectId || null,
          deviceId,
          phase: "validate",
          obligation: "integration_templates.node_service.subject_required",
        });
        return;
      }

      try {
        const out = await runServiceTurn({
          subjectId,
          sessionId,
          utterance,
          deviceId,
          requestId,
        });
        emit({
          outcome: "ok",
          subjectId,
          deviceId,
          phase: "turn",
          replyLength: out.reply.length,
          citationCount: out.citationCount,
        });
        sendJson(res, 200, {
          subjectId: out.subjectId,
          deviceId: out.deviceId,
          replyLength: out.reply.length,
          traceRef: out.traceRef,
          citationCount: out.citationCount,
        });
      } catch (err) {
        emit({
          outcome: "fail",
          subjectId,
          deviceId,
          phase: "turn",
          obligation: "integration_templates.node_service.turn_failed",
        });
        sendJson(res, 500, {
          error: "turn_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  };
}

export function startNodeService(opts: NodeServiceOptions = {}) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  const server = createServer((req, res) => {
    void createNodeServiceHandler(opts)(req, res);
  });
  server.listen(port, host);
  return server;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));

if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  startNodeService({ port });
  process.stdout.write(`node-service listening on :${port}\n`);
}
