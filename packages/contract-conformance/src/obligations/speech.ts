/**
 * SpeechInterface obligations ( / CK-05).
 *
 * CK-05.1 — `transcribe` MUST stream partial segments (`isFinal: false`)
 *           before a final so the agent can begin reasoning early.
 * CK-05.2 — Implementations MUST declare supported languages; unsupported
 *           languages are routed to fallback rather than failing.
 *
 * Vision (CK-06) lands in — out of scope here.
 */

import type {
  AudioChunk,
  SpeechInterface,
  SpeechSynthesisOptions,
  TranscriptSegment,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

/**
 * Verbatim MUST sentences from `packages/contracts/src/speech.ts`.
 */
export const MUST_TRANSCRIBE_PARTIALS =
  "`transcribe` MUST stream partial segments (`isFinal: false`) so the agent can begin reasoning before the utterance completes.";

export const MUST_LANGUAGE_FALLBACK =
  "Implementations MUST declare supported languages; the core routes unsupported languages to fallback providers rather than failing.";

export const SPEECH_OBLIGATION_IDS = {
  transcribePartials: "CK-05.1",
  languageFallback: "CK-05.2",
} as const;

/** Max transcript / audio chunks drained per probe (NFR / scalability). */
export const SPEECH_STREAM_CHUNK_LIMIT = 64;

/** Probe sample rate for synthetic PCM chunks. */
export const SPEECH_PROBE_SAMPLE_RATE_HZ = 16_000;

/** Language tag that is never in a conforming supportedLanguages list. */
export const SPEECH_UNSUPPORTED_LANGUAGE = "xx-PROBE-UNSUPPORTED";

/**
 * Conformance surface for speech providers.
 * Probe only through `supportedLanguages` + `transcribe` / `synthesize`.
 */
export interface SpeechConformanceHarness {
  speech: SpeechInterface;
}

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

/** Subject-scoped PCM token bytes — metadata only, never learner audio content. */
export function buildSpeechProbeAudioChunk(ctx: ObligationContext): AudioChunk {
  const token = `probe.ck05.audio.${subjectToken(ctx.subjectId)}`;
  return {
    data: new TextEncoder().encode(token),
    sampleRateHz: SPEECH_PROBE_SAMPLE_RATE_HZ,
  };
}

export async function* speechProbeAudioStream(
  ctx: ObligationContext,
): AsyncIterable<AudioChunk> {
  yield buildSpeechProbeAudioChunk(ctx);
}

export async function collectTranscriptSegments(
  stream: AsyncIterable<TranscriptSegment>,
  limit: number = SPEECH_STREAM_CHUNK_LIMIT,
): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = [];
  for await (const seg of stream) {
    out.push(seg);
    if (out.length >= limit) break;
  }
  return out;
}

export async function collectAudioChunks(
  stream: AsyncIterable<AudioChunk>,
  limit: number = SPEECH_STREAM_CHUNK_LIMIT,
): Promise<AudioChunk[]> {
  const out: AudioChunk[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
    if (out.length >= limit) break;
  }
  return out;
}

/** True when segments include ≥1 partial before a final (CK-05.1). */
export function hasPartialBeforeFinal(
  segments: readonly TranscriptSegment[],
): boolean {
  let sawPartial = false;
  for (const seg of segments) {
    if (!seg.isFinal) {
      sawPartial = true;
      continue;
    }
    if (sawPartial) return true;
  }
  return false;
}

export function defineTranscribePartialsObligation(): Obligation<SpeechConformanceHarness> {
  return defineObligation({
    id: SPEECH_OBLIGATION_IDS.transcribePartials,
    contract: "SpeechInterface",
    mustText: MUST_TRANSCRIBE_PARTIALS,
    specIds: ["CK-05"],
    async check(impl, ctx) {
      let segments: TranscriptSegment[];
      try {
        segments = await collectTranscriptSegments(
          impl.speech.transcribe(speechProbeAudioStream(ctx)),
        );
      } catch (err) {
        throw new ObligationViolation({
          obligationId: SPEECH_OBLIGATION_IDS.transcribePartials,
          mustText: MUST_TRANSCRIBE_PARTIALS,
          contract: "SpeechInterface",
          message: `transcribe() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (segments.length === 0) {
        throw new ObligationViolation({
          obligationId: SPEECH_OBLIGATION_IDS.transcribePartials,
          mustText: MUST_TRANSCRIBE_PARTIALS,
          contract: "SpeechInterface",
          message: "transcribe() yielded no segments",
        });
      }
      if (!hasPartialBeforeFinal(segments)) {
        throw new ObligationViolation({
          obligationId: SPEECH_OBLIGATION_IDS.transcribePartials,
          mustText: MUST_TRANSCRIBE_PARTIALS,
          contract: "SpeechInterface",
          message:
            "transcribe() must emit at least one isFinal:false partial before a final segment",
        });
      }
    },
  });
}

export function defineLanguageFallbackObligation(): Obligation<SpeechConformanceHarness> {
  return defineObligation({
    id: SPEECH_OBLIGATION_IDS.languageFallback,
    contract: "SpeechInterface",
    mustText: MUST_LANGUAGE_FALLBACK,
    specIds: ["CK-05"],
    async check(impl, ctx) {
      const declared = impl.speech.supportedLanguages;
      if (!Array.isArray(declared) || declared.length === 0) {
        throw new ObligationViolation({
          obligationId: SPEECH_OBLIGATION_IDS.languageFallback,
          mustText: MUST_LANGUAGE_FALLBACK,
          contract: "SpeechInterface",
          message: "supportedLanguages must be a non-empty declaration",
        });
      }
      for (const tag of declared.slice(0, SPEECH_STREAM_CHUNK_LIMIT)) {
        if (typeof tag !== "string" || tag.trim().length === 0) {
          throw new ObligationViolation({
            obligationId: SPEECH_OBLIGATION_IDS.languageFallback,
            mustText: MUST_LANGUAGE_FALLBACK,
            contract: "SpeechInterface",
            message: "supportedLanguages entries must be non-empty strings",
          });
        }
      }
      if (declared.includes(SPEECH_UNSUPPORTED_LANGUAGE)) {
        throw new ObligationViolation({
          obligationId: SPEECH_OBLIGATION_IDS.languageFallback,
          mustText: MUST_LANGUAGE_FALLBACK,
          contract: "SpeechInterface",
          message:
            "probe unsupported language unexpectedly present in supportedLanguages",
        });
      }

      const text = `probe.ck05.synth.${subjectToken(ctx.subjectId)}`;
      const options: SpeechSynthesisOptions = {
        language: SPEECH_UNSUPPORTED_LANGUAGE,
      };

      let chunks: AudioChunk[];
      try {
        chunks = await collectAudioChunks(
          impl.speech.synthesize(text, options),
        );
      } catch (err) {
        throw new ObligationViolation({
          obligationId: SPEECH_OBLIGATION_IDS.languageFallback,
          mustText: MUST_LANGUAGE_FALLBACK,
          contract: "SpeechInterface",
          message: `unsupported language must fallback, not fail: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (chunks.length === 0) {
        throw new ObligationViolation({
          obligationId: SPEECH_OBLIGATION_IDS.languageFallback,
          mustText: MUST_LANGUAGE_FALLBACK,
          contract: "SpeechInterface",
          message:
            "unsupported language fallback yielded no audio (treated as failure)",
        });
      }
      for (const chunk of chunks.slice(0, SPEECH_STREAM_CHUNK_LIMIT)) {
        if (!(chunk.data instanceof Uint8Array) || chunk.data.length === 0) {
          throw new ObligationViolation({
            obligationId: SPEECH_OBLIGATION_IDS.languageFallback,
            mustText: MUST_LANGUAGE_FALLBACK,
            contract: "SpeechInterface",
            message: "fallback synthesize chunks must carry non-empty PCM data",
          });
        }
        if (
          !Number.isFinite(chunk.sampleRateHz) ||
          chunk.sampleRateHz <= 0
        ) {
          throw new ObligationViolation({
            obligationId: SPEECH_OBLIGATION_IDS.languageFallback,
            mustText: MUST_LANGUAGE_FALLBACK,
            contract: "SpeechInterface",
            message: "fallback synthesize chunks must declare a positive sampleRateHz",
          });
        }
      }
    },
  });
}

export function registerTranscribePartialsObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineTranscribePartialsObligation());
  return registry;
}

export function registerLanguageFallbackObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineLanguageFallbackObligation());
  return registry;
}

export function registerSpeechObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerTranscribePartialsObligation(registry);
  registerLanguageFallbackObligation(registry);
  return registry;
}

export function createTranscribePartialsObligationRegistry(): ObligationRegistry {
  return registerTranscribePartialsObligation(new ObligationRegistry());
}

export function createLanguageFallbackObligationRegistry(): ObligationRegistry {
  return registerLanguageFallbackObligation(new ObligationRegistry());
}

export function createSpeechObligationsRegistry(): ObligationRegistry {
  return registerSpeechObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories ── */

type SpeechFactoryOptions = {
  /** Skip isFinal:false partials (violate CK-05.1). */
  finalOnly: boolean;
  /** Throw on unsupported synthesize language (violate CK-05.2). */
  failUnsupportedLanguage: boolean;
  supportedLanguages: string[];
};

function createSpeechFactory(
  options: SpeechFactoryOptions,
): () => SpeechConformanceHarness {
  const langs = [...options.supportedLanguages];
  const fallbackLang = langs[0] ?? "en-US";

  return () => ({
    speech: {
      get supportedLanguages() {
        return [...langs];
      },
      async *transcribe(_audio: AsyncIterable<AudioChunk>) {
        if (!options.finalOnly) {
          yield {
            text: "probe.ck05.partial",
            language: fallbackLang,
            startMs: 0,
            endMs: 100,
            confidence: 0.7,
            isFinal: false,
          };
        }
        yield {
          text: "probe.ck05.final",
          language: fallbackLang,
          startMs: 0,
          endMs: 200,
          confidence: 0.95,
          isFinal: true,
        };
      },
      async *synthesize(text: string, synthOptions: SpeechSynthesisOptions) {
        const requested = synthOptions.language;
        if (
          options.failUnsupportedLanguage &&
          !langs.includes(requested)
        ) {
          throw new Error(`unsupported language: ${requested}`);
        }
        // Fallback: use first declared language when unsupported.
        const effective = langs.includes(requested) ? requested : fallbackLang;
        const payload = new TextEncoder().encode(
          `probe.ck05.pcm.${effective}.${text.slice(0, 48)}`,
        );
        yield {
          data: payload,
          sampleRateHz: SPEECH_PROBE_SAMPLE_RATE_HZ,
        };
      },
    },
  });
}

/**
 * Known-good reference: partial-then-final transcribe; unsupported languages
 * synthesize via declared fallback.
 */
export function createStreamingSpeechHarnessFactory(): () => SpeechConformanceHarness {
  return createSpeechFactory({
    finalOnly: false,
    failUnsupportedLanguage: false,
    supportedLanguages: ["en-US", "hi-IN"],
  });
}

/** Violation for CK-05.1: only emits a final transcript segment. */
export function createFinalOnlySpeechHarnessFactory(): () => SpeechConformanceHarness {
  return createSpeechFactory({
    finalOnly: true,
    failUnsupportedLanguage: false,
    supportedLanguages: ["en-US", "hi-IN"],
  });
}

/** Violation for CK-05.2: throws on unsupported synthesize language. */
export function createNoFallbackSpeechHarnessFactory(): () => SpeechConformanceHarness {
  return createSpeechFactory({
    finalOnly: false,
    failUnsupportedLanguage: true,
    supportedLanguages: ["en-US", "hi-IN"],
  });
}

/** Violation for CK-05.2: empty supportedLanguages declaration. */
export function createUndeclaredLanguagesSpeechHarnessFactory(): () => SpeechConformanceHarness {
  return createSpeechFactory({
    finalOnly: false,
    failUnsupportedLanguage: false,
    supportedLanguages: [],
  });
}
