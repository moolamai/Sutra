/**
 * Local TTS behind SpeechInterface.synthesize.
 *
 * supportedLanguages lists only languages with loaded voice models.
 * Unsupported BCP-47 codes route to the declared fallback language and
 * surface `outcome: "fallback"` telemetry — never throw, never silent
 * English substitution without that signal.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AudioChunk,
  SpeechInterface,
  SpeechSynthesisOptions,
  TranscriptSegment,
} from "@moolam/contracts";
import type { SpeechConformanceHarness } from "@moolam/contract-conformance";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TTS_PACKAGE_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_TTS_VOICES_MANIFEST = path.join(
  TTS_PACKAGE_ROOT,
  "fixtures",
  "tts",
  "voices.json",
);

/** Human+machine Indic TTS coverage card (language → voice + fallback policy). */
export const DEFAULT_TTS_MODEL_CARD = path.join(
  TTS_PACKAGE_ROOT,
  "fixtures",
  "tts",
  "tts-voices.model-card.json",
);

export const LOCAL_TTS_ENGINE = "local-tts-v1";
export const TTS_SAMPLE_RATE_HZ = 16_000;
export const TTS_STREAM_CHUNK_LIMIT = 64;
/** Max UTF-16 code units accepted per synthesize call (NFR / scalability). */
export const TTS_TEXT_CHAR_LIMIT = 4_096;
/** PCM samples per streamed audio chunk (~40ms @ 16kHz). */
export const TTS_SAMPLES_PER_CHUNK = 640;

export type TtsVoiceCard = {
  voiceId: string;
  language: string;
  sampleRateHz: number;
};

export type TtsVoicesManifest = {
  schemaVersion: string;
  engine: string;
  fallbackLanguage: string;
  voices: TtsVoiceCard[];
  mixedScriptPolicy?: string;
  description?: string;
};

export type TtsLanguageVoiceCoverageRow = {
  language: string;
  voiceId: string;
  sampleRateHz: number;
  script: string;
  role: string;
};

export type TtsVoiceModelCard = {
  schemaVersion: string;
  engine: string;
  locality: "on-device" | "self-hosted";
  description: string;
  fallbackLanguage: string;
  fallbackPolicy: {
    unsupportedBcp47: string;
    emptyText: string;
    mixedScript: string;
  };
  coverage: TtsLanguageVoiceCoverageRow[];
  observability: {
    event: string;
    neverEmit: string;
    requiredFields: string[];
  };
  voicesManifestRelpath: string;
};

export type LocalTtsTelemetryOp = "load" | "unload" | "synthesize" | "transcribe";

/** Metadata-only telemetry — never raw synthesis text bodies. */
export type LocalTtsTelemetryEvent = {
  event: "bindings_speech.tts";
  op: LocalTtsTelemetryOp;
  outcome: "ok" | "error" | "fallback";
  subjectId: string;
  deviceId: string;
  engine: typeof LOCAL_TTS_ENGINE;
  languageCount?: number;
  chunkCount?: number;
  /** Effective BCP-47 after fallback resolution. */
  effectiveLanguage?: string;
  /** Requested BCP-47 (may differ when fallback fired). */
  requestedLanguage?: string;
  voiceId?: string;
  usedFallback?: boolean;
  failureClass?: "config" | "validation" | "not_loaded" | "native";
  detail?: string;
};

export type LoadLocalTtsOptions = {
  subjectId: string;
  deviceId: string;
  voicesManifestPath?: string;
  onTelemetry?: (event: LocalTtsTelemetryEvent) => void;
  backend?: LocalTtsNativeBackend;
};

export class LocalTtsError extends Error {
  readonly failureClass: NonNullable<LocalTtsTelemetryEvent["failureClass"]>;

  constructor(
    message: string,
    failureClass: NonNullable<LocalTtsTelemetryEvent["failureClass"]>,
  ) {
    super(message);
    this.name = "LocalTtsError";
    this.failureClass = failureClass;
  }
}

export type LocalTtsNativeHandle = { readonly id: string };

export type LocalTtsSynthesizeNativeParams = {
  text: string;
  language: string;
  voiceId: string;
  sampleRateHz: number;
  speakingRate: number;
  signal?: AbortSignal;
};

export type LocalTtsSynthesizeNativeResult = {
  /** Streamed PCM chunks (s16le mono). */
  chunks: Uint8Array[];
  sampleRateHz: number;
};

export type LocalTtsNativeBackend = {
  readonly kind: "in-process" | "native-addon";
  load(modelId: string): Promise<LocalTtsNativeHandle>;
  unload(handle: LocalTtsNativeHandle): Promise<void>;
  synthesize(
    handle: LocalTtsNativeHandle,
    params: LocalTtsSynthesizeNativeParams,
  ): Promise<LocalTtsSynthesizeNativeResult>;
};

const DEVANAGARI = /[\u0900-\u097F]/u;
const LATIN = /[A-Za-z]/u;

/**
 * In-process local TTS stand-in: streams PCM chunks; mixed-script text
 * does not crash. Production injects a real on-device TTS addon.
 */
export function createInProcessLocalTtsBackend(): LocalTtsNativeBackend {
  let seq = 0;
  return {
    kind: "in-process",
    async load(modelId: string) {
      if (!modelId.trim()) throw new Error("tts model id is required");
      seq += 1;
      return { id: `tts-inproc-${seq}` };
    },
    async unload() {
      /* no-op */
    },
    async synthesize(
      _handle: LocalTtsNativeHandle,
      params: LocalTtsSynthesizeNativeParams,
    ): Promise<LocalTtsSynthesizeNativeResult> {
      if (params.signal?.aborted) {
        throw new Error("tts synthesize aborted");
      }
      const rate = Math.min(2, Math.max(0.5, params.speakingRate));
      // Duration scales with text length; mixed-script is fine.
      const mixed = DEVANAGARI.test(params.text) && LATIN.test(params.text);
      const baseMs = Math.max(
        80,
        Math.min(8_000, Math.ceil(params.text.length * 40 * (1 / rate))),
      );
      const durationMs = mixed ? baseMs + 40 : baseMs;
      const sampleRate = params.sampleRateHz;
      const totalSamples = Math.max(
        TTS_SAMPLES_PER_CHUNK,
        Math.floor((sampleRate * durationMs) / 1000),
      );

      // Prefix carries voice/language metadata for debug seams — not learner text.
      const marker = new TextEncoder().encode(
        `tts.${params.language}.${params.voiceId}`,
      );
      const pcm = new Uint8Array(totalSamples * 2);
      pcm.set(marker.slice(0, Math.min(marker.length, pcm.length)));
      const freq =
        params.language.startsWith("hi")
          ? 196
          : params.language.startsWith("ta")
            ? 220
            : 247;
      for (let i = Math.ceil(marker.length / 2); i < totalSamples; i++) {
        const t = i / sampleRate;
        const v = Math.floor(Math.sin(2 * Math.PI * freq * t) * 1200);
        pcm[i * 2] = v & 0xff;
        pcm[i * 2 + 1] = (v >> 8) & 0xff;
      }

      const chunks: Uint8Array[] = [];
      const bytesPerChunk = TTS_SAMPLES_PER_CHUNK * 2;
      for (
        let offset = 0;
        offset < pcm.byteLength && chunks.length < TTS_STREAM_CHUNK_LIMIT;
        offset += bytesPerChunk
      ) {
        chunks.push(pcm.subarray(offset, Math.min(offset + bytesPerChunk, pcm.byteLength)));
      }
      if (chunks.length === 0) {
        chunks.push(pcm);
      }
      return { chunks, sampleRateHz: sampleRate };
    },
  };
}

export function loadTtsVoicesManifest(
  manifestPath: string = DEFAULT_TTS_VOICES_MANIFEST,
): TtsVoicesManifest {
  if (!existsSync(manifestPath)) {
    throw new LocalTtsError(
      `TTS voices manifest missing at ${manifestPath}`,
      "config",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new LocalTtsError(
      `TTS voices manifest unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "config",
    );
  }
  const m = raw as Partial<TtsVoicesManifest>;
  if (
    typeof m.schemaVersion !== "string" ||
    typeof m.fallbackLanguage !== "string" ||
    !m.fallbackLanguage.trim() ||
    !Array.isArray(m.voices) ||
    m.voices.length === 0
  ) {
    throw new LocalTtsError(
      "TTS voices manifest must declare schemaVersion, fallbackLanguage, non-empty voices[]",
      "config",
    );
  }
  const voices: TtsVoiceCard[] = [];
  for (const v of m.voices.slice(0, TTS_STREAM_CHUNK_LIMIT)) {
    if (
      typeof v?.voiceId !== "string" ||
      !v.voiceId.trim() ||
      typeof v.language !== "string" ||
      !v.language.trim() ||
      !Number.isFinite(v.sampleRateHz) ||
      v.sampleRateHz <= 0
    ) {
      throw new LocalTtsError(
        "TTS voice card requires voiceId, language, positive sampleRateHz",
        "config",
      );
    }
    voices.push({
      voiceId: v.voiceId.trim(),
      language: v.language.trim(),
      sampleRateHz: v.sampleRateHz,
    });
  }
  const langs = new Set(voices.map((v) => v.language));
  if (!langs.has(m.fallbackLanguage.trim())) {
    throw new LocalTtsError(
      `fallbackLanguage ${m.fallbackLanguage} has no loaded voice model`,
      "config",
    );
  }
  return {
    schemaVersion: m.schemaVersion,
    engine: typeof m.engine === "string" ? m.engine : LOCAL_TTS_ENGINE,
    fallbackLanguage: m.fallbackLanguage.trim(),
    voices,
    ...(typeof m.mixedScriptPolicy === "string"
      ? { mixedScriptPolicy: m.mixedScriptPolicy }
      : {}),
    ...(typeof m.description === "string" ? { description: m.description } : {}),
  };
}

/** Languages actually backed by a loaded voice model (truthful declaration). */
export function languagesFromVoices(
  voices: readonly TtsVoiceCard[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of voices) {
    if (!seen.has(v.language)) {
      seen.add(v.language);
      out.push(v.language);
    }
  }
  return out.slice(0, TTS_STREAM_CHUNK_LIMIT);
}

/**
 * Load the TTS voice model card and require parity with the voices manifest
 * (language set, voiceIds, fallbackLanguage). Coverage is never aspirational.
 */
export function loadTtsVoiceModelCard(
  cardPath: string = DEFAULT_TTS_MODEL_CARD,
  voicesManifestPath: string = DEFAULT_TTS_VOICES_MANIFEST,
): TtsVoiceModelCard {
  if (!existsSync(cardPath)) {
    throw new LocalTtsError(
      `TTS voice model card missing at ${cardPath}`,
      "config",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cardPath, "utf8"));
  } catch (err) {
    throw new LocalTtsError(
      `TTS voice model card unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "config",
    );
  }
  const c = raw as Partial<TtsVoiceModelCard>;
  if (
    typeof c.schemaVersion !== "string" ||
    typeof c.engine !== "string" ||
    (c.locality !== "on-device" && c.locality !== "self-hosted") ||
    typeof c.description !== "string" ||
    typeof c.fallbackLanguage !== "string" ||
    !c.fallbackLanguage.trim() ||
    typeof c.fallbackPolicy?.unsupportedBcp47 !== "string" ||
    typeof c.fallbackPolicy?.emptyText !== "string" ||
    typeof c.fallbackPolicy?.mixedScript !== "string" ||
    !Array.isArray(c.coverage) ||
    c.coverage.length === 0 ||
    typeof c.observability?.event !== "string" ||
    typeof c.observability?.neverEmit !== "string" ||
    !Array.isArray(c.observability?.requiredFields) ||
    typeof c.voicesManifestRelpath !== "string"
  ) {
    throw new LocalTtsError(
      "TTS voice model card missing required coverage / fallback policy fields",
      "config",
    );
  }

  const coverage: TtsLanguageVoiceCoverageRow[] = [];
  for (const row of c.coverage.slice(0, TTS_STREAM_CHUNK_LIMIT)) {
    if (
      typeof row?.language !== "string" ||
      !row.language.trim() ||
      typeof row.voiceId !== "string" ||
      !row.voiceId.trim() ||
      !Number.isFinite(row.sampleRateHz) ||
      row.sampleRateHz <= 0 ||
      typeof row.script !== "string" ||
      !row.script.trim() ||
      typeof row.role !== "string" ||
      !row.role.trim()
    ) {
      throw new LocalTtsError(
        "TTS model card coverage row requires language, voiceId, sampleRateHz, script, role",
        "config",
      );
    }
    coverage.push({
      language: row.language.trim(),
      voiceId: row.voiceId.trim(),
      sampleRateHz: row.sampleRateHz,
      script: row.script.trim(),
      role: row.role.trim(),
    });
  }

  const card: TtsVoiceModelCard = {
    schemaVersion: c.schemaVersion,
    engine: c.engine,
    locality: c.locality,
    description: c.description,
    fallbackLanguage: c.fallbackLanguage.trim(),
    fallbackPolicy: {
      unsupportedBcp47: c.fallbackPolicy.unsupportedBcp47,
      emptyText: c.fallbackPolicy.emptyText,
      mixedScript: c.fallbackPolicy.mixedScript,
    },
    coverage,
    observability: {
      event: c.observability.event,
      neverEmit: c.observability.neverEmit,
      requiredFields: c.observability.requiredFields.map(String),
    },
    voicesManifestRelpath: c.voicesManifestRelpath,
  };

  const manifest = loadTtsVoicesManifest(voicesManifestPath);
  assertTtsModelCardMatchesVoices(card, manifest);
  return card;
}

/** Language → voiceId rows for README / hosts (order matches model card). */
export function languageVoiceCoverageTable(
  card: TtsVoiceModelCard = loadTtsVoiceModelCard(),
): ReadonlyArray<{ language: string; voiceId: string; role: string }> {
  return card.coverage.map((row) => ({
    language: row.language,
    voiceId: row.voiceId,
    role: row.role,
  }));
}

export function assertTtsModelCardMatchesVoices(
  card: TtsVoiceModelCard,
  manifest: TtsVoicesManifest,
): void {
  if (card.engine !== manifest.engine) {
    throw new LocalTtsError(
      `model card engine ${card.engine} ≠ voices manifest ${manifest.engine}`,
      "config",
    );
  }
  if (card.fallbackLanguage !== manifest.fallbackLanguage) {
    throw new LocalTtsError(
      `model card fallbackLanguage ${card.fallbackLanguage} ≠ voices ${manifest.fallbackLanguage}`,
      "config",
    );
  }
  const cardLangs = card.coverage.map((r) => r.language).sort().join(",");
  const voiceLangs = languagesFromVoices(manifest.voices).slice().sort().join(",");
  if (cardLangs !== voiceLangs) {
    throw new LocalTtsError(
      `model card languages [${cardLangs}] ≠ voices [${voiceLangs}]`,
      "config",
    );
  }
  for (const row of card.coverage) {
    const voice = manifest.voices.find((v) => v.language === row.language);
    if (!voice || voice.voiceId !== row.voiceId) {
      throw new LocalTtsError(
        `model card ${row.language}→${row.voiceId} missing or mismatched in voices manifest`,
        "config",
      );
    }
    if (voice.sampleRateHz !== row.sampleRateHz) {
      throw new LocalTtsError(
        `model card sampleRateHz for ${row.language} mismatches voices manifest`,
        "config",
      );
    }
  }
  if (!card.coverage.some((r) => r.language === card.fallbackLanguage)) {
    throw new LocalTtsError(
      "model card fallbackLanguage must appear in coverage",
      "config",
    );
  }
}

export function resolveTtsVoice(args: {
  voices: readonly TtsVoiceCard[];
  fallbackLanguage: string;
  requestedLanguage: string;
  voiceId?: string;
}): {
  voice: TtsVoiceCard;
  effectiveLanguage: string;
  usedFallback: boolean;
} {
  const requested = args.requestedLanguage.trim();
  const byId = args.voiceId?.trim()
    ? args.voices.find((v) => v.voiceId === args.voiceId!.trim())
    : undefined;
  if (byId && byId.language === requested) {
    return {
      voice: byId,
      effectiveLanguage: byId.language,
      usedFallback: false,
    };
  }
  const match = args.voices.find((v) => v.language === requested);
  if (match) {
    return {
      voice: match,
      effectiveLanguage: match.language,
      usedFallback: false,
    };
  }
  const fallback =
    args.voices.find((v) => v.language === args.fallbackLanguage) ??
    args.voices[0];
  if (!fallback) {
    throw new LocalTtsError("no TTS voices loaded", "config");
  }
  return {
    voice: fallback,
    effectiveLanguage: fallback.language,
    usedFallback: true,
  };
}

export class LocalTtsBinding implements SpeechInterface {
  readonly #subjectId: string;
  readonly #deviceId: string;
  readonly #voices: readonly TtsVoiceCard[];
  readonly #languages: readonly string[];
  readonly #fallbackLanguage: string;
  readonly #backend: LocalTtsNativeBackend;
  readonly #handle: LocalTtsNativeHandle;
  readonly #onTelemetry?: (event: LocalTtsTelemetryEvent) => void;
  readonly #mixedScriptPolicy?: string;
  #unloaded = false;

  constructor(args: {
    subjectId: string;
    deviceId: string;
    voices: readonly TtsVoiceCard[];
    fallbackLanguage: string;
    backend: LocalTtsNativeBackend;
    handle: LocalTtsNativeHandle;
    onTelemetry?: (event: LocalTtsTelemetryEvent) => void;
    mixedScriptPolicy?: string;
  }) {
    this.#subjectId = args.subjectId;
    this.#deviceId = args.deviceId;
    this.#voices = [...args.voices];
    this.#languages = languagesFromVoices(this.#voices);
    this.#fallbackLanguage = args.fallbackLanguage;
    this.#backend = args.backend;
    this.#handle = args.handle;
    if (args.onTelemetry) this.#onTelemetry = args.onTelemetry;
    if (args.mixedScriptPolicy) this.#mixedScriptPolicy = args.mixedScriptPolicy;
  }

  get supportedLanguages(): string[] {
    return [...this.#languages];
  }

  get fallbackLanguage(): string {
    return this.#fallbackLanguage;
  }

  get voices(): TtsVoiceCard[] {
    return this.#voices.map((v) => ({ ...v }));
  }

  get subjectId(): string {
    return this.#subjectId;
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  get engine(): typeof LOCAL_TTS_ENGINE {
    return LOCAL_TTS_ENGINE;
  }

  get mixedScriptPolicy(): string | undefined {
    return this.#mixedScriptPolicy;
  }

  #emit(
    partial: Omit<
      LocalTtsTelemetryEvent,
      "event" | "subjectId" | "deviceId" | "engine"
    >,
  ): void {
    this.#onTelemetry?.({
      event: "bindings_speech.tts",
      subjectId: this.#subjectId,
      deviceId: this.#deviceId,
      engine: LOCAL_TTS_ENGINE,
      ...partial,
    });
  }

  #assertLoaded(): void {
    if (this.#unloaded) {
      throw new LocalTtsError("local TTS binding unloaded", "not_loaded");
    }
  }

  async unload(): Promise<void> {
    if (this.#unloaded) return;
    this.#unloaded = true;
    await this.#backend.unload(this.#handle);
    this.#emit({ op: "unload", outcome: "ok" });
  }

  /**
   * STT stub so SpeechInterface is complete for CK-05.1 when using TTS-first
   * hosts. Full STT is {@link WhisperCppSpeechBinding}.
   */
  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
  ): AsyncIterable<TranscriptSegment> {
    this.#assertLoaded();
    let chunks = 0;
    for await (const _ of audio) {
      chunks += 1;
      if (chunks >= TTS_STREAM_CHUNK_LIMIT) break;
    }
    const lang = this.#fallbackLanguage;
    yield {
      text: "…",
      language: lang,
      startMs: 0,
      endMs: 1,
      confidence: 0.5,
      isFinal: false,
    };
    yield {
      text: "…",
      language: lang,
      startMs: 0,
      endMs: Math.max(1, chunks),
      confidence: 0.7,
      isFinal: true,
    };
    this.#emit({
      op: "transcribe",
      outcome: "ok",
      chunkCount: 2,
      languageCount: this.#languages.length,
      detail: "tts_binding_stt_stub",
    });
  }

  async *synthesize(
    text: string,
    options: SpeechSynthesisOptions,
  ): AsyncIterable<AudioChunk> {
    this.#assertLoaded();
    if (typeof text !== "string" || text.trim().length === 0) {
      this.#emit({
        op: "synthesize",
        outcome: "error",
        failureClass: "validation",
        detail: "empty_text",
      });
      throw new LocalTtsError(
        "synthesize requires non-empty text",
        "validation",
      );
    }
    if (text.length > TTS_TEXT_CHAR_LIMIT) {
      this.#emit({
        op: "synthesize",
        outcome: "error",
        failureClass: "validation",
        detail: "text_too_long",
      });
      throw new LocalTtsError(
        `synthesize text exceeds ${TTS_TEXT_CHAR_LIMIT} characters`,
        "validation",
      );
    }

    const requested = options.language?.trim() ?? "";
    if (!requested) {
      this.#emit({
        op: "synthesize",
        outcome: "error",
        failureClass: "validation",
        detail: "language_required",
      });
      throw new LocalTtsError(
        "synthesize options.language is required (BCP-47)",
        "validation",
      );
    }

    try {
      const resolved = resolveTtsVoice({
        voices: this.#voices,
        fallbackLanguage: this.#fallbackLanguage,
        requestedLanguage: requested,
        ...(options.voiceId ? { voiceId: options.voiceId } : {}),
      });
      const speakingRate =
        typeof options.speakingRate === "number" &&
        Number.isFinite(options.speakingRate)
          ? options.speakingRate
          : 1;

      const native = await this.#backend.synthesize(this.#handle, {
        text,
        language: resolved.effectiveLanguage,
        voiceId: resolved.voice.voiceId,
        sampleRateHz: resolved.voice.sampleRateHz,
        speakingRate,
      });

      let chunkCount = 0;
      for (const data of native.chunks) {
        if (data.byteLength === 0) continue;
        chunkCount += 1;
        yield {
          data,
          sampleRateHz: native.sampleRateHz,
        };
        if (chunkCount >= TTS_STREAM_CHUNK_LIMIT) break;
      }
      if (chunkCount === 0) {
        throw new LocalTtsError("TTS backend yielded no audio", "native");
      }

      this.#emit({
        op: "synthesize",
        outcome: resolved.usedFallback ? "fallback" : "ok",
        languageCount: this.#languages.length,
        chunkCount,
        effectiveLanguage: resolved.effectiveLanguage,
        requestedLanguage: requested,
        voiceId: resolved.voice.voiceId,
        usedFallback: resolved.usedFallback,
        ...(resolved.usedFallback
          ? { detail: "unsupported_language_fallback" }
          : {}),
      });
    } catch (err) {
      if (err instanceof LocalTtsError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      this.#emit({
        op: "synthesize",
        outcome: "error",
        failureClass: "native",
        detail: detail.slice(0, 160),
      });
      throw err;
    }
  }
}

/**
 * Load local TTS: voices manifest → truthful supportedLanguages → FFI seam.
 */
export async function loadLocalTts(
  options: LoadLocalTtsOptions,
): Promise<LocalTtsBinding> {
  const subjectId = options.subjectId?.trim();
  const deviceId = options.deviceId?.trim();
  if (!subjectId) {
    throw new LocalTtsError("subjectId is required", "config");
  }
  if (!deviceId) {
    throw new LocalTtsError("deviceId is required", "config");
  }

  const manifest = loadTtsVoicesManifest(
    options.voicesManifestPath ?? DEFAULT_TTS_VOICES_MANIFEST,
  );
  // Coverage card must match loaded voices (no aspirational languages).
  if (!options.voicesManifestPath) {
    loadTtsVoiceModelCard(DEFAULT_TTS_MODEL_CARD, DEFAULT_TTS_VOICES_MANIFEST);
  }
  const backend = options.backend ?? createInProcessLocalTtsBackend();
  const emit = options.onTelemetry;

  try {
    const handle = await backend.load(`${manifest.engine}:voices`);
    const binding = new LocalTtsBinding({
      subjectId,
      deviceId,
      voices: manifest.voices,
      fallbackLanguage: manifest.fallbackLanguage,
      backend,
      handle,
      ...(options.onTelemetry ? { onTelemetry: options.onTelemetry } : {}),
      ...(manifest.mixedScriptPolicy
        ? { mixedScriptPolicy: manifest.mixedScriptPolicy }
        : {}),
    });
    emit?.({
      event: "bindings_speech.tts",
      op: "load",
      outcome: "ok",
      subjectId,
      deviceId,
      engine: LOCAL_TTS_ENGINE,
      languageCount: binding.supportedLanguages.length,
    });
    return binding;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    emit?.({
      event: "bindings_speech.tts",
      op: "load",
      outcome: "error",
      subjectId,
      deviceId,
      engine: LOCAL_TTS_ENGINE,
      failureClass: err instanceof LocalTtsError ? err.failureClass : "native",
      detail: detail.slice(0, 160),
    });
    throw err;
  }
}

export type CreateLocalTtsSpeechHarnessOptions = {
  subjectId?: string;
  deviceId?: string;
  voicesManifestPath?: string;
  onTelemetry?: (event: LocalTtsTelemetryEvent) => void;
  backend?: LocalTtsNativeBackend;
};

/** Conformance factory for CK-05 against the local TTS binding. */
export function createLocalTtsSpeechHarnessFactory(
  options: CreateLocalTtsSpeechHarnessOptions = {},
): (ctx?: { subjectId?: string; deviceId?: string }) => Promise<SpeechConformanceHarness> {
  return async (ctx) => {
    const speech = await loadLocalTts({
      subjectId:
        ctx?.subjectId?.trim() ||
        options.subjectId?.trim() ||
        "cert.speech.tts",
      deviceId:
        ctx?.deviceId?.trim() ||
        options.deviceId?.trim() ||
        "ci-speech-tts",
      ...(options.voicesManifestPath
        ? { voicesManifestPath: options.voicesManifestPath }
        : {}),
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.onTelemetry ? { onTelemetry: options.onTelemetry } : {}),
    });
    return { speech };
  };
}
