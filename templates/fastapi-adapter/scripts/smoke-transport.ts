import type { HLCTimestamp, SyncRequest } from "sutra-sdk";
import { PROTOCOL_VERSION } from "sutra-sdk";
import { createHttpSyncTransport } from "../transport/http_sync_transport.ts";

const subjectId = process.env.SUTRA_SUBJECT_ID ?? "transport-smoke-subject";
const deviceId = process.env.SUTRA_DEVICE_ID ?? "transport-smoke-device";
const HLC = "000000000000001:000001:dev01" as HLCTimestamp;

function emit(event: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({ event: "integration_templates.fastapi_adapter.transport.smoke", ...event })}\n`,
  );
}

/** Offline unit smoke: transport rejects cross-subject payloads without network. */
try {
  const transport = createHttpSyncTransport({
    subjectId,
    baseUrl: "http://127.0.0.1:9", // unused when subject mismatches
  });

  const foreign: SyncRequest = {
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    edgeState: {
      protocolVersion: PROTOCOL_VERSION,
      subjectId: "other-subject",
      deviceIds: [deviceId],
      activeConceptId: null,
      mode: "exploratory",
      mastery: {},
      frictionLog: [],
      profile: {
        ageBand: "adult",
        track: "cbse-class-7-maths",
        language: "en-IN",
        updatedAt: HLC,
      },
      stateVector: { root: HLC },
    },
    lastKnownCloudVector: {},
    syncAttemptId: "transport-attempt-1",
  };

  const rejected = await transport.postSync(foreign);
  if (rejected.kind !== "http-error" || rejected.status !== 403) {
    throw new Error("transport must reject cross-subject SyncRequest at boundary");
  }

  let emptyRejected = false;
  try {
    createHttpSyncTransport({ subjectId: "  " });
  } catch {
    emptyRejected = true;
  }
  if (!emptyRejected) {
    throw new Error("empty subjectId must be rejected");
  }

  emit({
    outcome: "ok",
    subjectId,
    deviceId,
    phase: "transport-boundary",
  });
  process.stdout.write("smoke OK: SyncTransport subject boundary\n");
} catch (err) {
  emit({
    outcome: "fail",
    subjectId,
    deviceId,
    phase: "transport-boundary",
    obligation: "integration_templates.fastapi_adapter.transport.smoke.failed",
  });
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
}
