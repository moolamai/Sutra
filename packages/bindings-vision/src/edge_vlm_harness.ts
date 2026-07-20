/**
 * Edge harness integration: inject local VisionInterface into
 * CognitiveBindings / EdgeAgent, prove offline vision turn under network deny.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import { CognitiveCore } from "@moolam/cognitive-core";
import {
  EdgeAgent,
  createEdgeCognitiveBindings,
  createLocalVectorMemoryDriver,
  LocalVectorDb,
  type AgentReply,
} from "@moolam/edge-agent";
import type { VisionInterface } from "@moolam/contracts";
import type { FrictionSample, HLCTimestamp } from "@moolam/sync-protocol";
import {
  loadLocalVlm,
  type LoadLocalVlmOptions,
  type LocalVlmBinding,
  type LocalVlmTelemetryEvent,
} from "./vlm_binding.js";
import { loadCk06Fixture } from "./vision_fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/** Repo-relative from packages/bindings-vision (src or dist). */
export const OFFLINE_EDGE_GOLDEN_RELPATH =
  "../../examples/offline-edge/golden-turn.json";

/** Default committed fixture: within-limit image for a multimodal turn. */
export const DEFAULT_OFFLINE_VISION_FIXTURE_ID = "valid-schema-answer";

export type OfflineEdgeVisionTelemetry = {
  event: "bindings_vision.offline_edge_vlm";
  outcome:
    | "start"
    | "pass"
    | "fail"
    | "egress_fail"
    | "bindings_ok"
    | "analyze_ok"
    | "core_ok"
    | "subject_isolation_ok";
  subjectId: string;
  deviceId: string;
  fixtureId?: string;
  detail?: string;
};

export type ProveOfflineEdgeVisionOptions = {
  subjectId?: string;
  deviceId?: string;
  /** CK-06 fixture id (default: valid-schema-answer). */
  fixtureId?: string;
  vlmOptions?: Omit<LoadLocalVlmOptions, "subjectId" | "deviceId">;
  onTelemetry?: (event: OfflineEdgeVisionTelemetry) => void;
};

export type ProveOfflineEdgeVisionResult = {
  ok: boolean;
  subjectId: string;
  deviceId: string;
  fixtureId: string;
  visionBound: boolean;
  analyzeAnswerChars: number;
  maxInputBytes: number;
  servedLocally: boolean;
  syncStatus: string | null;
  egressAttemptCount: number;
  localityOk: boolean;
  cognitiveCoreOk: boolean;
  subjectIsolationOk: boolean;
  reply: AgentReply | null;
  failures: string[];
};

function loadGolden(): {
  utterance: string;
  friction: {
    conceptId: string;
    hesitationMs: number;
    inputVelocity: number;
    revisionCount: number;
    assistanceRequested: boolean;
    outcome: string;
    capturedAt: string;
  };
  profile: {
    ageBand: "child" | "adolescent" | "adult";
    track: string;
    language: string;
  };
  expect: { conceptId: string; syncStatus: string };
} {
  const goldenPath = path.resolve(PACKAGE_ROOT, OFFLINE_EDGE_GOLDEN_RELPATH);
  if (!existsSync(goldenPath)) {
    throw new Error(`offline-edge golden missing at ${goldenPath}`);
  }
  return JSON.parse(readFileSync(goldenPath, "utf8"));
}

function mockRuntime() {
  return {
    card: {
      modelId: "mock-phi-vision-edge",
      contextWindow: 4096,
      quantization: "q4",
      memoryFootprintMiB: 64,
      languages: ["en-IN", "hi-IN"],
    },
    load: async () => {},
    unload: async () => {},
    generate: async ({ prompt }: { prompt: string }) => ({
      text: `On-device reply grounded in prompt of ${prompt.length} chars.`,
      tokensPerSecond: 40,
      finishReason: "stop" as const,
    }),
    generateStream: async function* ({ prompt }: { prompt: string }) {
      const t = `On-device reply grounded in prompt of ${prompt.length} chars.`;
      yield t.slice(0, 8);
      yield t.slice(8);
    },
    embed: async (text: string) => {
      const out = new Float32Array(8);
      out[0] = (text.length % 97) / 97;
      return out;
    },
  };
}

function emit(
  options: ProveOfflineEdgeVisionOptions,
  partial: Omit<OfflineEdgeVisionTelemetry, "event">,
): void {
  options.onTelemetry?.({
    event: "bindings_vision.offline_edge_vlm",
    ...partial,
  });
}

/**
 * Assemble edge CognitiveBindings with an injected VisionInterface
 * (same override pattern as speech/tools/knowledge).
 */
export function createEdgeBindingsWithVision(args: {
  subjectId: string;
  deviceId: string;
  vision: VisionInterface;
  runtime?: ReturnType<typeof mockRuntime>;
  vectorDb: LocalVectorDb;
  track?: string;
  language?: string;
  activeConceptId?: string | null;
}): ReturnType<typeof createEdgeCognitiveBindings> {
  return createEdgeCognitiveBindings({
    subjectId: args.subjectId,
    deviceId: args.deviceId,
    runtime: args.runtime ?? mockRuntime(),
    vectorDb: args.vectorDb,
    track: args.track ?? "system-design-l5",
    language: args.language ?? "en-IN",
    activeConceptId: args.activeConceptId ?? "sd.consistent-hashing",
    vision: args.vision,
  });
}

/**
 * Prove: local VLM on committed CK-06 fixture → edge binding set →
 * CognitiveCore attachment turn / EdgeAgent with network denied.
 */
export async function proveOfflineEdgeVisionBinding(
  options: ProveOfflineEdgeVisionOptions = {},
): Promise<ProveOfflineEdgeVisionResult> {
  const golden = loadGolden();
  const subjectId = (options.subjectId ?? "subj.vision.offline").trim();
  const deviceId = (options.deviceId ?? "dev-vision-offline").trim();
  const fixtureId = options.fixtureId ?? DEFAULT_OFFLINE_VISION_FIXTURE_ID;
  const failures: string[] = [];

  emit(options, {
    outcome: "start",
    subjectId,
    deviceId,
    fixtureId,
  });

  let vision: LocalVlmBinding | null = null;
  let analyzeAnswerChars = 0;
  let maxInputBytes = 0;
  let visionBound = false;
  let reply: AgentReply | null = null;
  let servedLocally = false;
  let syncStatus: string | null = null;
  let egressAttemptCount = 0;
  let localityOk = false;
  let cognitiveCoreOk = false;
  let subjectIsolationOk = false;

  try {
    const vlmEvents: LocalVlmTelemetryEvent[] = [];
    vision = await loadLocalVlm({
      subjectId,
      deviceId,
      ...(options.vlmOptions ?? {}),
      onTelemetry: (e) => {
        vlmEvents.push(e);
        options.vlmOptions?.onTelemetry?.(e);
      },
    });
    maxInputBytes = vision.maxInputBytes;

    const fixture = loadCk06Fixture(fixtureId);
    if (fixture.byteLength > fixture.maxInputBytes) {
      failures.push(
        `offline vision fixture must be within maxInputBytes (${fixture.id})`,
      );
    }

    const friction: FrictionSample = {
      conceptId: golden.friction.conceptId,
      hesitationMs: golden.friction.hesitationMs,
      inputVelocity: golden.friction.inputVelocity,
      revisionCount: golden.friction.revisionCount,
      assistanceRequested: golden.friction.assistanceRequested,
      outcome: (golden.friction.outcome === "correct" ||
      golden.friction.outcome === "partial" ||
      golden.friction.outcome === "incorrect"
        ? golden.friction.outcome
        : "ungraded") as FrictionSample["outcome"],
      capturedAt: golden.friction.capturedAt as HLCTimestamp,
    };

    const { turn, value } = await withEgressRecordingTurn(
      {
        subjectId,
        deviceId,
        caller: { principalId: "offline-edge-vlm", subjectScope: "*" },
        selfHostedHosts: ["school.local"],
      },
      async (api) => {
        const mock = api.mockAgent();
        mock
          ?.get("https://vendor.example")
          .intercept({ path: "/v1/infer", method: "POST" })
          .reply(200, { ok: true })
          .times(5);

        return api.withPayloadClass("model-prompt", async () => {
          const analyzed = await vision!.analyze({
            input: {
              data: fixture.imageBytes,
              mimeType: fixture.mimeType,
            },
            instruction: fixture.instruction,
            ...(fixture.schema ? { responseSchema: fixture.schema } : {}),
          });
          const answerChars = analyzed.answer.length;

          const db = new LocalVectorDb(createLocalVectorMemoryDriver());
          await db.initialize();
          const { bindings, profile } = createEdgeBindingsWithVision({
            subjectId,
            deviceId,
            vision: vision!,
            vectorDb: db,
            track: golden.profile.track,
            language: golden.profile.language,
            activeConceptId: golden.friction.conceptId,
          });
          const bound = bindings.vision === vision;

          const core = new CognitiveCore(profile, bindings);
          const coreOut = await core.turn({
            subjectId,
            sessionId: `sess.vision.${deviceId}`,
            utterance: golden.utterance,
            attachment: {
              data: fixture.imageBytes,
              mimeType: fixture.mimeType,
            },
          });
          const coreOk =
            typeof coreOut.reply === "string" && coreOut.reply.length > 0;

          const agent = new EdgeAgent({
            subjectId,
            deviceId,
            runtime: mockRuntime(),
            storage: createLocalVectorMemoryDriver(),
            vision: vision!,
            profile: golden.profile,
            attachEventBusSpans: false,
          });
          await agent.initialize();
          const agentReply = await agent.agentTurn(golden.utterance, friction);
          const sync = await agent.syncNow();

          const peerVision = await loadLocalVlm({
            subjectId: `${subjectId}::peer`,
            deviceId: `${deviceId}-peer`,
          });
          const peerDb = new LocalVectorDb(createLocalVectorMemoryDriver());
          await peerDb.initialize();
          const peerBundle = createEdgeBindingsWithVision({
            subjectId: `${subjectId}::peer`,
            deviceId: `${deviceId}-peer`,
            vision: peerVision,
            vectorDb: peerDb,
          });
          const isolationOk =
            peerBundle.bindings.vision === peerVision &&
            bindings.vision === vision &&
            peerBundle.bindings.vision !== bindings.vision;
          await peerVision.unload();

          return {
            answerChars,
            bound,
            coreOk,
            agentReply,
            syncStatus: sync.status,
            isolationOk,
            vlmEvents,
            analyzedAnswer: analyzed.answer,
          };
        });
      },
    );

    egressAttemptCount = turn.attempts.length;
    const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
    localityOk = asserted.ok === true && turn.noEgress === true;
    if (!localityOk) {
      failures.push(
        `locality breach: attempts=${egressAttemptCount} ok=${asserted.ok}`,
      );
      emit(options, {
        outcome: "egress_fail",
        subjectId,
        deviceId,
        fixtureId,
      });
    }

    analyzeAnswerChars = value.answerChars;
    visionBound = value.bound;
    cognitiveCoreOk = value.coreOk;
    reply = value.agentReply;
    servedLocally = Boolean(reply?.servedLocally);
    syncStatus = value.syncStatus;
    subjectIsolationOk = value.isolationOk;

    if (analyzeAnswerChars < 1) {
      failures.push("vision analyze returned empty answer");
    }
    if (!visionBound) {
      failures.push("bindings.vision was not the injected VisionInterface");
    }
    if (!cognitiveCoreOk) {
      failures.push(
        "CognitiveCore.turn with vision attachment / binding failed",
      );
    }
    if (!servedLocally) failures.push("agentTurn not servedLocally");
    if (syncStatus !== "offline-mode") {
      failures.push(`expected offline-mode sync, got ${syncStatus}`);
    }
    if (!subjectIsolationOk) {
      failures.push("concurrent vision bindings cross-contaminated");
    }
    if (
      value.analyzedAnswer.length > 8 &&
      value.vlmEvents.some((e) =>
        JSON.stringify(e).includes(value.analyzedAnswer),
      )
    ) {
      failures.push("VLM telemetry leaked answer body");
    }

    emit(options, {
      outcome: analyzeAnswerChars > 0 ? "analyze_ok" : "fail",
      subjectId,
      deviceId,
      fixtureId,
    });
    emit(options, {
      outcome: visionBound ? "bindings_ok" : "fail",
      subjectId,
      deviceId,
      fixtureId,
    });
    emit(options, {
      outcome: cognitiveCoreOk ? "core_ok" : "fail",
      subjectId,
      deviceId,
      fixtureId,
    });
    emit(options, {
      outcome: subjectIsolationOk ? "subject_isolation_ok" : "fail",
      subjectId,
      deviceId,
      fixtureId,
    });

    await vision.unload();
    vision = null;
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
    if (vision) {
      try {
        await vision.unload();
      } catch {
        /* ignore */
      }
    }
  }

  const ok = failures.length === 0;
  emit(options, {
    outcome: ok ? "pass" : "fail",
    subjectId,
    deviceId,
    fixtureId,
    ...(ok ? {} : { detail: failures[0] }),
  });

  return {
    ok,
    subjectId,
    deviceId,
    fixtureId,
    visionBound,
    analyzeAnswerChars,
    maxInputBytes,
    servedLocally,
    syncStatus,
    egressAttemptCount,
    localityOk,
    cognitiveCoreOk,
    subjectIsolationOk,
    reply,
    failures,
  };
}

