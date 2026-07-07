/**
 * @module speech
 *
 * Speech contract - voice in, voice out.
 *
 * Enables voice-only agents (feature phones, driving, accessibility,
 * low-literacy contexts) and voice+visual agents. Implementations may
 * bind Whisper.cpp on-device, cloud STT/TTS, or Indic-language engines
 * (critical for the sovereign deployment target: Hindi, Tamil, Telugu,
 * Bengali… are first-class, not afterthoughts).
 */

export interface AudioChunk {
  /** PCM 16-bit little-endian mono unless the descriptor says otherwise. */
  data: Uint8Array;
  sampleRateHz: number;
}

export interface TranscriptSegment {
  text: string;
  /** BCP-47 tag of the detected/declared language, e.g. "hi-IN". */
  language: string;
  startMs: number;
  endMs: number;
  /** Word-level confidence enables friction signals for voice interactions. */
  confidence: number;
  isFinal: boolean;
}

export interface SpeechSynthesisOptions {
  language: string;
  voiceId?: string;
  /** 0.5 to 2.0; agents slow down for novices, stay brief for experts. */
  speakingRate?: number;
}

/**
 * Contract requirements:
 *  1. `transcribe` MUST stream partial segments (`isFinal: false`) so the
 *     agent can begin reasoning before the utterance completes.
 *  2. Implementations MUST declare supported languages; the core routes
 *     unsupported languages to fallback providers rather than failing.
 */
export interface SpeechInterface {
  readonly supportedLanguages: string[];
  transcribe(audio: AsyncIterable<AudioChunk>): AsyncIterable<TranscriptSegment>;
  synthesize(text: string, options: SpeechSynthesisOptions): AsyncIterable<AudioChunk>;
}
