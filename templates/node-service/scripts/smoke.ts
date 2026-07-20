import {
  createNodeServiceHandler,
  resetServiceTurnState,
  runServiceTurn,
} from "../src/index.ts";
import { createServer } from "node:http";

const subjectId = process.env.SUTRA_SUBJECT_ID ?? "node-smoke-subject";
const deviceId = process.env.SUTRA_DEVICE_ID ?? "node-smoke-device";
const otherSubjectId = "node-smoke-other-subject";

function emit(event: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({ event: "integration_templates.node_service.smoke", ...event })}\n`,
  );
}

try {
  resetServiceTurnState();

  // Sovereignty: cores reject empty subjectId.
  let rejected = false;
  try {
    await runServiceTurn({
      subjectId: "  ",
      sessionId: "s",
      utterance: "x",
    });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("empty subjectId must be rejected");
  }

  // Idempotent replay with same requestId must not double-apply side effects
  // (cached reply length stable).
  const first = await runServiceTurn({
    subjectId,
    deviceId,
    sessionId: "smoke-session",
    utterance: "Hello node-service — mocked turn.",
    requestId: "req-smoke-1",
  });
  const replay = await runServiceTurn({
    subjectId,
    deviceId,
    sessionId: "smoke-session",
    utterance: "DIFFERENT TEXT SHOULD BE IGNORED ON REPLAY",
    requestId: "req-smoke-1",
  });
  if (first.reply !== replay.reply) {
    throw new Error("idempotent replay must return cached reply");
  }

  // Cross-subject turns remain isolated (distinct subjectIds).
  const other = await runServiceTurn({
    subjectId: otherSubjectId,
    deviceId,
    sessionId: "smoke-session-b",
    utterance: "Other subject turn.",
    requestId: "req-smoke-other",
  });
  if (other.subjectId === subjectId) {
    throw new Error("cross-subject isolation violated");
  }

  // HTTP handler smoke via in-process server.
  const server = createServer((req, res) => {
    void createNodeServiceHandler({ deviceId })(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind smoke server");
  }
  const base = `http://127.0.0.1:${addr.port}`;
  const res = await fetch(`${base}/v1/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subjectId,
      sessionId: "http-smoke",
      utterance: "HTTP path turn",
      deviceId,
      requestId: "req-http-1",
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP turn failed: ${res.status}`);
  }
  const body = (await res.json()) as { replyLength: number; subjectId: string };
  if (!body.replyLength || body.subjectId !== subjectId) {
    throw new Error("HTTP turn response missing subject scope");
  }
  server.close();

  emit({
    outcome: "ok",
    subjectId,
    deviceId,
    phase: "smoke",
    replyLength: first.reply.length,
  });
  process.stdout.write(`smoke OK: reply length=${first.reply.length}\n`);
} catch (err) {
  emit({
    outcome: "fail",
    subjectId,
    deviceId,
    phase: "smoke",
    obligation: "integration_templates.node_service.smoke.failed",
  });
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
}
