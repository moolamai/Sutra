/**
 * Edge harness integration: inject whisper.cpp-class SpeechInterface into
 * CognitiveBindings / EdgeAgent, prove offline STT under network deny.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  collectTranscriptSegments,
  hasPartialBeforeFinal,
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
import type { SpeechInterface } from "@moolam/contracts";
import type { FrictionSample, HLCTimestamp } from "@moolam/sync-protocol";
import {
  indicFixtureAsAudioStream,
  loadIndicUtteranceFixture,
  loadWhisperCppSpeech,
  type LoadWhisperCppSpeechOptions,
  type WhisperCppSpeechBinding,
  type WhisperCppSttTelemetryEvent,
} from "./stt_binding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/** Repo-relative from packages/bindings-speech (src or dist). */
export const OFFLINE_EDGE_GOLDEN_RELPATH =
  "../../examples/offline-edge/golden-turn.json";

export type OfflineEdgeSttTelemetry = {
  event: "bindings_speech.offline_edge_stt";
  outcome:
    | "start"
    | "pass"
    | "fail"
    | "egress_fail"
    | "bindings_ok"
    | "partials_ok"
    | "core_ok"
    | "subject_isolation_ok";
  subjectId: string;
  deviceId: string;
  fixtureId?: string;
  detail?: string;
};

export type ProveOfflineEdgeSttOptions = {
  subjectId?: string;
  deviceId?: string;
  /** Indic fixture id (default: hi-en-codeswitch). */
  fixtureId?: string;
  speechOptions?: Omit<LoadWhisperCppSpeechOptions, "subjectId" | "deviceId">;
  onTelemetry?: (event: OfflineEdgeSttTelemetry) => void;
};

export type ProveOfflineEdgeSttResult = {
  ok: boolean;
  subjectId: string;
  deviceId: string;
  fixtureId: string;
  speechBound: boolean;
  supportedLanguages: string[];
  partialBeforeFinal: boolean;
  finalText: string;
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
      modelId: "mock-phi-speech-edge",
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
  options: ProveOfflineEdgeSttOptions,
  partial: Omit<OfflineEdgeSttTelemetry, "event">,
): void {
  options.onTelemetry?.({
    event: "bindings_speech.offline_edge_stt",
    ...partial,
  });
}

/**
 * Assemble edge CognitiveBindings with an injected SpeechInterface
 * (same override pattern as tools/knowledge).
 */
export function createEdgeBindingsWithSpeech(args: {
  subjectId: string;
  deviceId: string;
  speech: SpeechInterface;
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
    speech: args.speech,
  });
}

/**
 * Prove: local STT on Indic fixture → edge binding set → CognitiveCore /
 * EdgeAgent turn with network denied (no sync transport).
 */
export async function proveOfflineEdgeSttBinding(
  options: ProveOfflineEdgeSttOptions = {},
): Promise<ProveOfflineEdgeSttResult> {
  const golden = loadGolden();
  const subjectId = (options.subjectId ?? "subj.speech.offline").trim();
  const deviceId = (options.deviceId ?? "dev-speech-offline").trim();
  const fixtureId = options.fixtureId ?? "hi-en-codeswitch";
  const failures: string[] = [];

  emit(options, {
    outcome: "start",
    subjectId,
    deviceId,
    fixtureId,
  });

  let speech: WhisperCppSpeechBinding | null = null;
  let finalText = "";
  let partialBeforeFinal = false;
  let speechBound = false;
  let supportedLanguages: string[] = [];
  let reply: AgentReply | null = null;
  let servedLocally = false;
  let syncStatus: string | null = null;
  let egressAttemptCount = 0;
  let localityOk = false;
  let cognitiveCoreOk = false;
  let subjectIsolationOk = false;

  try {
    const sttEvents: WhisperCppSttTelemetryEvent[] = [];
    speech = await loadWhisperCppSpeech({
      subjectId,
      deviceId,
      ...(options.speechOptions ?? {}),
      onTelemetry: (e) => {
        sttEvents.push(e);
        options.speechOptions?.onTelemetry?.(e);
      },
    });
    supportedLanguages = speech.supportedLanguages;

    const fixture = loadIndicUtteranceFixture(fixtureId);
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
        caller: { principalId: "offline-edge-stt", subjectScope: "*" },
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
          const segs = await collectTranscriptSegments(
            speech!.transcribe(indicFixtureAsAudioStream(fixture)),
          );
          const partialOk = hasPartialBeforeFinal(segs);
          const last = segs.filter((s) => s.isFinal).at(-1);
          const transcript = last?.text?.trim() ?? "";

          const db = new LocalVectorDb(createLocalVectorMemoryDriver());
          await db.initialize();
          const { bindings, profile } = createEdgeBindingsWithSpeech({
            subjectId,
            deviceId,
            speech: speech!,
            vectorDb: db,
            track: golden.profile.track,
            language: golden.profile.language,
            activeConceptId: golden.friction.conceptId,
          });
          const bound = bindings.speech === speech;

          const core = new CognitiveCore(profile, bindings);
          const coreOut = await core.turn({
            subjectId,
            sessionId: `sess.speech.${deviceId}`,
            utterance: transcript || golden.utterance,
          });
          const coreOk =
            typeof coreOut.reply === "string" && coreOut.reply.length > 0;

          const agent = new EdgeAgent({
            subjectId,
            deviceId,
            runtime: mockRuntime(),
            storage: createLocalVectorMemoryDriver(),
            speech: speech!,
            profile: golden.profile,
            attachEventBusSpans: false,
          });
          await agent.initialize();
          const agentReply = await agent.agentTurn(
            transcript || golden.utterance,
            friction,
          );
          const sync = await agent.syncNow();

          const peerSpeech = await loadWhisperCppSpeech({
            subjectId: `${subjectId}::peer`,
            deviceId: `${deviceId}-peer`,
          });
          const peerDb = new LocalVectorDb(createLocalVectorMemoryDriver());
          await peerDb.initialize();
          const peerBundle = createEdgeBindingsWithSpeech({
            subjectId: `${subjectId}::peer`,
            deviceId: `${deviceId}-peer`,
            speech: peerSpeech,
            vectorDb: peerDb,
          });
          const isolationOk =
            peerBundle.bindings.speech === peerSpeech &&
            bindings.speech === speech &&
            peerBundle.bindings.speech !== bindings.speech;
          await peerSpeech.unload();

          return {
            segs,
            partialOk,
            transcript,
            bound,
            coreOk,
            agentReply,
            syncStatus: sync.status,
            isolationOk,
            sttEvents,
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

    partialBeforeFinal = value.partialOk;
    finalText = value.transcript;
    speechBound = value.bound;
    cognitiveCoreOk = value.coreOk;
    reply = value.agentReply;
    servedLocally = Boolean(reply?.servedLocally);
    syncStatus = value.syncStatus;
    subjectIsolationOk = value.isolationOk;

    if (!partialBeforeFinal) {
      failures.push("STT must emit isFinal:false before isFinal:true on fixture");
    }
    if (!finalText) failures.push("STT final transcript empty");
    if (!speechBound) {
      failures.push("bindings.speech was not the injected SpeechInterface");
    }
    if (!cognitiveCoreOk) {
      failures.push("CognitiveCore.turn with speech-bound bindings failed");
    }
    if (!servedLocally) failures.push("agentTurn not servedLocally");
    if (syncStatus !== "offline-mode") {
      failures.push(`expected offline-mode sync, got ${syncStatus}`);
    }
    if (!subjectIsolationOk) {
      failures.push("concurrent speech bindings cross-contaminated");
    }
    if (
      value.sttEvents.some(
        (e) =>
          finalText.length > 8 && JSON.stringify(e).includes(finalText),
      )
    ) {
      failures.push("STT telemetry leaked transcript body");
    }

    emit(options, {
      outcome: partialBeforeFinal ? "partials_ok" : "fail",
      subjectId,
      deviceId,
      fixtureId,
    });
    emit(options, {
      outcome: speechBound ? "bindings_ok" : "fail",
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

    await speech.unload();
    speech = null;
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
    if (speech) {
      try {
        await speech.unload();
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
    speechBound,
    supportedLanguages,
    partialBeforeFinal,
    finalText,
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
