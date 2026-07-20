/**
 * whisper.cpp-class FFI / native addon seam.
 *
 * Production hosts inject a real whisper.cpp (or compatible) addon.
 * CI uses {@link createInProcessWhisperCppBackend} so SpeechInterface
 * stays tested without linking libwhisper on every runner.
 */

export type WhisperCppNativeHandle = { readonly id: string };

export type WhisperCppTranscribeNativeParams = {
  /** Concatenated PCM (or metadata probe bytes) for the utterance. */
  pcm: Uint8Array;
  sampleRateHz: number;
  /** Duration estimate in ms (from PCM length or caller). */
  durationMs: number;
  /** BCP-47 hint; backend may ignore when auto-detecting. */
  languageHint?: string;
  /** Languages the loaded model actually supports. */
  supportedLanguages: readonly string[];
  signal?: AbortSignal;
};

export type WhisperCppTranscribeNativeResult = {
  /** Interim hypothesis text (may equal final for short utterances). */
  partialText: string;
  finalText: string;
  language: string;
  confidence: number;
  startMs: number;
  endMs: number;
};

export type WhisperCppNativeBackend = {
  readonly kind: "in-process" | "native-addon";
  load(modelId: string): Promise<WhisperCppNativeHandle>;
  unload(handle: WhisperCppNativeHandle): Promise<void>;
  transcribe(
    handle: WhisperCppNativeHandle,
    params: WhisperCppTranscribeNativeParams,
  ): Promise<WhisperCppTranscribeNativeResult>;
};

const DEVANAGARI =
  /[\u0900-\u097F]/u;
const TAMIL = /[\u0B80-\u0BFF]/u;
const LATIN_WORD = /[A-Za-z]{2,}/;

function decodeProbeText(pcm: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(pcm);
  } catch {
    return "";
  }
}

/**
 * In-process whisper.cpp-class stand-in for CI / unit tests.
 * Emits non-empty hypotheses for code-switched and short probes without
 * crashing segmentation.
 */
export function createInProcessWhisperCppBackend(): WhisperCppNativeBackend {
  let seq = 0;
  return {
    kind: "in-process",
    async load(modelId: string) {
      if (!modelId.trim()) {
        throw new Error("whisper model id is required");
      }
      seq += 1;
      return { id: `whisper-inproc-${seq}` };
    },
    async unload(_handle: WhisperCppNativeHandle) {
      /* no-op */
    },
    async transcribe(
      _handle: WhisperCppNativeHandle,
      params: WhisperCppTranscribeNativeParams,
    ): Promise<WhisperCppTranscribeNativeResult> {
      if (params.signal?.aborted) {
        throw new Error("whisper transcribe aborted");
      }
      const langs = params.supportedLanguages.filter((l) => l.trim().length > 0);
      if (langs.length === 0) {
        throw new Error("supportedLanguages empty at native seam");
      }
      const fallback = langs[0]!;
      const hint =
        params.languageHint && langs.includes(params.languageHint)
          ? params.languageHint
          : fallback;

      const probe = decodeProbeText(params.pcm);
      const noisyClassroom = /NOISE:classroom/i.test(probe);
      const hasIndic = DEVANAGARI.test(probe);
      const hasTamil = TAMIL.test(probe);
      const hasLatin = LATIN_WORD.test(probe);
      const codeSwitched = (hasIndic || hasTamil) && hasLatin;

      let language = hint;
      if (codeSwitched) {
        language = langs.includes("hi-IN")
          ? "hi-IN"
          : langs.find((l) => l.startsWith("hi")) ?? hint;
      } else if (hasTamil) {
        language =
          langs.find((l) => l.startsWith("ta")) ?? hint;
      } else if (hasIndic) {
        language =
          langs.find((l) => l.startsWith("hi")) ?? hint;
      } else if (hasLatin) {
        language =
          langs.find((l) => l.startsWith("en")) ?? hint;
      }

      const durationMs = Math.max(0, params.durationMs);
      const endMs = Math.max(durationMs, 1);
      // Short utterances still get a hypothesis; never empty final.
      // Strip noise marker from hypothesis text — never treat marker as learner content.
      const cleaned = probe.replace(/NOISE:classroom\s*/gi, "").trim();
      const base =
        cleaned.length > 0
          ? cleaned.slice(0, 120)
          : durationMs < 200
            ? "…"
            : "utterance";

      const partialText = codeSwitched
        ? `${base.slice(0, Math.max(1, Math.floor(base.length / 2)))}…`
        : `${base.slice(0, Math.max(1, Math.min(base.length, 24)))}`;
      const finalText = codeSwitched ? `${base} [code-switched]` : base;

      // Classroom ambient noise → confidence spike-down (FP-002 regression lock).
      let confidence = codeSwitched ? 0.72 : 0.9;
      if (noisyClassroom) {
        confidence = Math.min(confidence, 0.35);
      }

      return {
        partialText: partialText.length > 0 ? partialText : "…",
        finalText: finalText.length > 0 ? finalText : "…",
        language,
        confidence,
        startMs: 0,
        endMs,
      };
    },
  };
}
