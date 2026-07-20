import { CognitiveCore, type StorageDriver } from "sutra-sdk";
import { createStorageDriver, type StorageBackend } from "./bindings/storage.ts";
import { agentProfile } from "./config/domain.ts";
import {
  makeKnowledge,
  makeMemory,
  makeModel,
  makeNoTools,
  makePlanning,
  makeReasoning,
} from "./mocks/reference-bindings.ts";

export type EdgeTurnInput = {
  subjectId: string;
  sessionId: string;
  utterance: string;
  deviceId?: string;
  storageBackend?: StorageBackend;
};

export type EdgeBootstrap = {
  subjectId: string;
  deviceId: string;
  storage: StorageDriver;
  core: CognitiveCore;
};

/** Wire CognitiveCore + subject-scoped StorageDriver for the edge host. */
export function bootstrapEdge(opts: {
  subjectId: string;
  deviceId?: string;
  storageBackend?: StorageBackend;
}): EdgeBootstrap {
  const subjectId = opts.subjectId.trim();
  if (!subjectId) {
    throw new Error("subjectId is required for edge bootstrap");
  }
  const deviceId = (opts.deviceId ?? "edge-device").trim() || "edge-device";
  const storage = createStorageDriver({
    subjectId,
    backend: opts.storageBackend ?? "memory",
  });
  const bindingOpts = { subjectId, persona: "edge-companion" };
  const core = new CognitiveCore(agentProfile, {
    memory: makeMemory(bindingOpts),
    model: makeModel(bindingOpts),
    reasoning: makeReasoning(),
    planning: makePlanning(),
    tools: makeNoTools(),
    knowledge: makeKnowledge(bindingOpts),
  });
  return { subjectId, deviceId, storage, core };
}

/**
 * Run one mocked on-device turn. Durably stamps a session cursor via StorageDriver
 * before resolving (idempotent UPSERT keyed by subject + session).
 */
export async function runEdgeTurn(input: EdgeTurnInput) {
  const subjectId = input.subjectId.trim();
  if (!subjectId) {
    throw new Error("subjectId is required for edge turn");
  }
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error("sessionId is required for edge turn");
  }

  const { storage, core, deviceId } = bootstrapEdge({
    subjectId,
    deviceId: input.deviceId,
    storageBackend: input.storageBackend,
  });

  const cursorKey = `session:${sessionId}:cursor`;
  await storage.execute("UPSERT", [cursorKey, "pending"]);

  const out = await core.turn({
    subjectId,
    sessionId,
    utterance: input.utterance,
  });

  await storage.execute("UPSERT", [cursorKey, "complete"]);

  return { ...out, deviceId, subjectId };
}
