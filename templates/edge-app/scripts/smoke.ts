import {
  createExpoSqliteStorageDriver,
  createMemoryStorageDriver,
  runEdgeTurn,
} from "../src/index.ts";

const subjectId = process.env.SUTRA_SUBJECT_ID ?? "edge-smoke-subject";
const deviceId = process.env.SUTRA_DEVICE_ID ?? "edge-smoke-device";
const otherSubjectId = "edge-smoke-other-subject";

function emit(event: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({ event: "integration_templates.edge_app.smoke", ...event })}\n`,
  );
}

try {
  // Sovereignty negative: cross-subject storage must not leak rows.
  const a = createMemoryStorageDriver({ subjectId });
  const b = createMemoryStorageDriver({ subjectId: otherSubjectId });
  await a.execute("UPSERT", ["secret", "subject-a-only"]);
  const leaked = await b.query<{ key: string; value: string }>("SELECT", ["secret"]);
  if (leaked.length > 0) {
    throw new Error("subject isolation violated: cross-subject storage leak");
  }

  // Expo seam must fail closed until expo-sqlite is wired.
  const expoStub = createExpoSqliteStorageDriver({ subjectId });
  let expoThrew = false;
  try {
    await expoStub.execute("UPSERT", ["k", "v"]);
  } catch {
    expoThrew = true;
  }
  if (!expoThrew) {
    throw new Error("expo-sqlite stub must throw until wired");
  }

  const out = await runEdgeTurn({
    subjectId,
    deviceId,
    sessionId: "edge-smoke-session",
    utterance: "Hello edge companion — run one mocked turn.",
    storageBackend: "memory",
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
    replyLength: out.reply.length,
  });

  process.stdout.write(`smoke OK: reply length=${out.reply.length}\n`);
} catch (err) {
  emit({
    outcome: "fail",
    subjectId,
    deviceId,
    phase: "turn",
    obligation: "integration_templates.edge_app.smoke.turn_failed",
  });
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
}
