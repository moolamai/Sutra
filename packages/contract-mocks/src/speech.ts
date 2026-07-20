/**
 * Reference SpeechInterface — streaming partials + language fallback (CK-05).
 * Ported from examples/voice with obligation-grade semantics.
 *
 * @module speech
 */

import type {
  AudioChunk,
  SpeechInterface,
  SpeechSynthesisOptions,
  TranscriptSegment,
} from "@moolam/contracts";

import type { ContractMockEmit } from "./events.js";

export const SPEECH_STREAM_CHUNK_LIMIT = 64;
export const SPEECH_SAMPLE_RATE_HZ = 16_000;

export type SpeechMockOptions = {
  supportedLanguages?: readonly string[];
  deviceId?: string;
  subjectId?: string;
  emit?: ContractMockEmit;
};

export type SpeechMockHarness = {
  speech: SpeechInterface;
};

/**
 * Streams isFinal:false partials before a final; unsupported synthesize
 * languages fall back to the first declared language (never throw).
 */
export function createSpeechMock(
  options: SpeechMockOptions = {},
): SpeechInterface {
  const langs = [
    ...(options.supportedLanguages ?? ["en-US", "hi-IN"]),
  ].slice(0, SPEECH_STREAM_CHUNK_LIMIT);
  if (langs.length === 0) {
    throw new Error("supportedLanguages must be non-empty");
  }
  const fallbackLang = langs[0]!;
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;

  return {
    get supportedLanguages() {
      return [...langs];
    },

    async *transcribe(
      audio: AsyncIterable<AudioChunk>,
    ): AsyncIterable<TranscriptSegment> {
      let segmentCount = 0;
      try {
        // Drain audio (bounded) so callers' streams complete.
        let chunks = 0;
        for await (const _chunk of audio) {
          chunks += 1;
          if (chunks >= SPEECH_STREAM_CHUNK_LIMIT) break;
        }
        yield {
          text: "probe.ck05.partial",
          language: fallbackLang,
          startMs: 0,
          endMs: 100,
          confidence: 0.7,
          isFinal: false,
        };
        segmentCount += 1;
        yield {
          text: "probe.ck05.final",
          language: fallbackLang,
          startMs: 0,
          endMs: 200,
          confidence: 0.95,
          isFinal: true,
        };
        segmentCount += 1;
        emit?.({
          event: "contract_mocks.speech",
          op: "transcribe",
          subjectId,
          deviceId,
          outcome: "ok",
          segmentCount,
          language: fallbackLang,
        });
      } catch (err) {
        emit?.({
          event: "contract_mocks.speech",
          op: "transcribe",
          subjectId,
          deviceId,
          outcome: "error",
          segmentCount,
        });
        throw err;
      }
    },

    async *synthesize(
      text: string,
      synthOptions: SpeechSynthesisOptions,
    ): AsyncIterable<AudioChunk> {
      try {
        const requested = synthOptions.language;
        const effective = langs.includes(requested) ? requested : fallbackLang;
        const payload = new TextEncoder().encode(
          `probe.ck05.pcm.${effective}.${text.slice(0, 48)}`,
        );
        yield {
          data: payload,
          sampleRateHz: SPEECH_SAMPLE_RATE_HZ,
        };
        emit?.({
          event: "contract_mocks.speech",
          op: "synthesize",
          subjectId,
          deviceId,
          outcome: "ok",
          segmentCount: 1,
          language: effective,
        });
      } catch (err) {
        emit?.({
          event: "contract_mocks.speech",
          op: "synthesize",
          subjectId,
          deviceId,
          outcome: "error",
        });
        throw err;
      }
    },
  };
}

export function createSpeechMockHarnessFactory(
  options: SpeechMockOptions = {},
): () => SpeechMockHarness {
  return () => ({
    speech: createSpeechMock(options),
  });
}

export const makeSpeech = createSpeechMock;
