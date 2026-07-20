import { runMockTurn } from "../src/companion.ts";

const subjectId = process.env.SUTRA_SUBJECT_ID ?? "smoke-subject";
const deviceId = process.env.SUTRA_DEVICE_ID ?? "smoke-device";

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ event: "create_sutra.smoke", ...event })}\n`);
}

try {
  const out = await runMockTurn({
    subjectId,
    sessionId: "smoke-session",
    utterance: "Hello companion — run one mocked turn.",
  });

  if (!out.reply?.trim()) {
    throw new Error("smoke turn produced empty reply");
  }

  emit({
    outcome: "ok",
    subjectId,
    deviceId,
    phase: "turn",
    traceRef: out.traceRef,
    citationCount: out.citations.length,
  });

  process.stdout.write(`smoke OK: reply length=${out.reply.length}\n`);
} catch (err) {
  emit({
    outcome: "fail",
    subjectId,
    deviceId,
    phase: "turn",
    obligation: "create_sutra.smoke.turn_failed",
  });
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
}
