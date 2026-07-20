/**
 * whisper.cpp-class local STT behind SpeechInterface.
 *
 * Model load declares BCP-47 languages from the Indic fixture manifest —
 * only languages the acoustic+language models actually support.
 * `transcribe` always emits ≥1 isFinal:false partial before isFinal:true.
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
import {
  createInProcessWhisperCppBackend,
  type WhisperCppNativeBackend,
  type WhisperCppNativeHandle,
} from "./whisper_ffi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_INDIC_LANGUAGES_MANIFEST = path.join(
  PACKAGE_ROOT,
  "fixtures",
  "indic",
  "supported-languages.json",
);

export const DEFAULT_INDIC_UTTERANCE_CATALOG = path.join(
  PACKAGE_ROOT,
  "fixtures",
  "indic",
  "catalog.json",
);

export const INDIC_FIXTURES_DIR = path.join(PACKAGE_ROOT, "fixtures", "indic");

export const WHISPER_CPP_CLASS_ENGINE = "whisper.cpp-class";
export const SPEECH_STREAM_CHUNK_LIMIT = 64;
export const SPEECH_SAMPLE_RATE_HZ = 16_000;

export type IndicLanguagesManifest = {
  schemaVersion: string;
  engine: string;
  pinnedRevision?: string;
  languages: string[];
  fallbackLanguage: string;
};

export type IndicUtteranceKind =
  | "indic-mono"
  | "english-mono"
  | "code-switched"
  | "short-utterance";

export type IndicUtteranceFixtureMeta = {
  id: string;
  kind: IndicUtteranceKind | string;
  language: string;
  durationMs: number;
  sampleRateHz: number;
  pcmRelpath: string;
  byteLength: number;
  containsCodeSwitch: boolean;
  expectedLanguage: string;
  /** Classroom ambient-noise fixture (FP-002). */
  ambientNoise?: boolean;
};

export type IndicUtteranceCatalog = {
  schemaVersion: string;
  sampleRateHz: number;
  pcmEncoding: string;
  description?: string;
  utterances: IndicUtteranceFixtureMeta[];
};

export type IndicUtteranceFixture = IndicUtteranceFixtureMeta & {
  /** Absolute path to the committed PCM file. */
  pcmPath: string;
  /** Raw s16le mono PCM bytes. */
  pcm: Uint8Array;
};

export type WhisperCppSttTelemetryOp = "load" | "unload" | "transcribe" | "synthesize";

/** Metadata-only telemetry — never raw audio or transcript bodies. */
export type WhisperCppSttTelemetryEvent = {
  event: "bindings_speech.stt";
  op: WhisperCppSttTelemetryOp;
  outcome: "ok" | "error" | "fallback";
  subjectId: string;
  deviceId: string;
  engine: typeof WHISPER_CPP_CLASS_ENGINE;
  languageCount?: number;
  segmentCount?: number;
  durationMs?: number;
  failureClass?: "config" | "not_loaded" | "aborted" | "native";
  detail?: string;
};

export type LoadWhisperCppSpeechOptions = {
  subjectId: string;
  deviceId: string;
  /** Absolute path to languages manifest (defaults to fixtures/indic). */
  languagesManifestPath?: string;
  backend?: WhisperCppNativeBackend;
  onTelemetry?: (event: WhisperCppSttTelemetryEvent) => void;
  languageHint?: string;
  /** Override wall clock (tests). */
  nowMs?: () => number;
};

export class WhisperCppSpeechError extends Error {
  readonly failureClass: NonNullable<WhisperCppSttTelemetryEvent["failureClass"]>;

  constructor(
    message: string,
    failureClass: NonNullable<WhisperCppSttTelemetryEvent["failureClass"]>,
  ) {
    super(message);
    this.name = "WhisperCppSpeechError";
    this.failureClass = failureClass;
  }
}

export function loadIndicLanguagesManifest(
  manifestPath: string = DEFAULT_INDIC_LANGUAGES_MANIFEST,
): IndicLanguagesManifest {
  if (!existsSync(manifestPath)) {
    throw new WhisperCppSpeechError(
      `languages manifest missing at ${manifestPath}`,
      "config",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new WhisperCppSpeechError(
      `languages manifest unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "config",
    );
  }
  const m = raw as Partial<IndicLanguagesManifest>;
  if (
    typeof m.schemaVersion !== "string" ||
    !Array.isArray(m.languages) ||
    m.languages.length === 0 ||
    typeof m.fallbackLanguage !== "string" ||
    !m.fallbackLanguage.trim()
  ) {
    throw new WhisperCppSpeechError(
      "languages manifest must declare schemaVersion, non-empty languages[], fallbackLanguage",
      "config",
    );
  }
  const languages = m.languages
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter((l) => l.length > 0)
    .slice(0, SPEECH_STREAM_CHUNK_LIMIT);
  if (languages.length === 0) {
    throw new WhisperCppSpeechError(
      "languages manifest languages[] empty after normalize",
      "config",
    );
  }
  if (!languages.includes(m.fallbackLanguage.trim())) {
    throw new WhisperCppSpeechError(
      `fallbackLanguage ${m.fallbackLanguage} not in languages[]`,
      "config",
    );
  }
  // Truthfulness: only list languages the fixture models actually support.
  return {
    schemaVersion: m.schemaVersion,
    engine: typeof m.engine === "string" ? m.engine : WHISPER_CPP_CLASS_ENGINE,
    ...(typeof m.pinnedRevision === "string"
      ? { pinnedRevision: m.pinnedRevision }
      : {}),
    languages,
    fallbackLanguage: m.fallbackLanguage.trim(),
  };
}

/**
 * Load the committed Indic utterance catalog (hi / en / ta / code-switch / short).
 */
export function loadIndicUtteranceCatalog(
  catalogPath: string = DEFAULT_INDIC_UTTERANCE_CATALOG,
): IndicUtteranceCatalog {
  if (!existsSync(catalogPath)) {
    throw new WhisperCppSpeechError(
      `utterance catalog missing at ${catalogPath}`,
      "config",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch (err) {
    throw new WhisperCppSpeechError(
      `utterance catalog unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "config",
    );
  }
  const c = raw as Partial<IndicUtteranceCatalog>;
  if (
    typeof c.schemaVersion !== "string" ||
    !Number.isFinite(c.sampleRateHz) ||
    typeof c.pcmEncoding !== "string" ||
    !Array.isArray(c.utterances) ||
    c.utterances.length === 0
  ) {
    throw new WhisperCppSpeechError(
      "utterance catalog must declare schemaVersion, sampleRateHz, pcmEncoding, non-empty utterances[]",
      "config",
    );
  }
  const utterances: IndicUtteranceFixtureMeta[] = [];
  for (const u of c.utterances.slice(0, SPEECH_STREAM_CHUNK_LIMIT)) {
    if (
      typeof u?.id !== "string" ||
      !u.id.trim() ||
      typeof u.pcmRelpath !== "string" ||
      typeof u.language !== "string" ||
      typeof u.expectedLanguage !== "string" ||
      !Number.isFinite(u.durationMs) ||
      !Number.isFinite(u.sampleRateHz) ||
      !Number.isFinite(u.byteLength)
    ) {
      throw new WhisperCppSpeechError(
        "utterance catalog entry missing required fields (id, language, pcmRelpath, durations)",
        "config",
      );
    }
    utterances.push({
      id: u.id.trim(),
      kind: typeof u.kind === "string" ? u.kind : "indic-mono",
      language: u.language.trim(),
      durationMs: u.durationMs,
      sampleRateHz: u.sampleRateHz,
      pcmRelpath: u.pcmRelpath.replace(/\\/g, "/"),
      byteLength: u.byteLength,
      containsCodeSwitch: Boolean(u.containsCodeSwitch),
      expectedLanguage: u.expectedLanguage.trim(),
      ...(u.ambientNoise === true ? { ambientNoise: true } : {}),
    });
  }
  return {
    schemaVersion: c.schemaVersion,
    sampleRateHz: c.sampleRateHz!,
    pcmEncoding: c.pcmEncoding,
    ...(typeof c.description === "string" ? { description: c.description } : {}),
    utterances,
  };
}

/** List committed utterance ids from the Indic catalog. */
export function listIndicUtteranceIds(
  catalogPath: string = DEFAULT_INDIC_UTTERANCE_CATALOG,
): string[] {
  return loadIndicUtteranceCatalog(catalogPath).utterances.map((u) => u.id);
}

/**
 * Load one committed audio fixture (PCM + metadata) by id.
 */
export function loadIndicUtteranceFixture(
  id: string,
  options: {
    catalogPath?: string;
    fixturesDir?: string;
  } = {},
): IndicUtteranceFixture {
  const catalog = loadIndicUtteranceCatalog(
    options.catalogPath ?? DEFAULT_INDIC_UTTERANCE_CATALOG,
  );
  const meta = catalog.utterances.find((u) => u.id === id);
  if (!meta) {
    throw new WhisperCppSpeechError(
      `unknown Indic utterance fixture "${id}"`,
      "config",
    );
  }
  const fixturesDir = options.fixturesDir ?? INDIC_FIXTURES_DIR;
  const pcmPath = path.join(fixturesDir, meta.pcmRelpath);
  if (!existsSync(pcmPath)) {
    throw new WhisperCppSpeechError(
      `PCM fixture missing at ${pcmPath}`,
      "config",
    );
  }
  const pcm = new Uint8Array(readFileSync(pcmPath));
  if (pcm.byteLength === 0) {
    throw new WhisperCppSpeechError(
      `PCM fixture empty at ${pcmPath}`,
      "config",
    );
  }
  if (pcm.byteLength !== meta.byteLength) {
    throw new WhisperCppSpeechError(
      `PCM byteLength mismatch for ${id}: catalog=${meta.byteLength} disk=${pcm.byteLength}`,
      "config",
    );
  }
  return { ...meta, pcmPath, pcm };
}

/** Load every committed Indic utterance fixture (bounded by catalog size). */
export function loadAllIndicUtteranceFixtures(
  options: {
    catalogPath?: string;
    fixturesDir?: string;
  } = {},
): IndicUtteranceFixture[] {
  const catalog = loadIndicUtteranceCatalog(
    options.catalogPath ?? DEFAULT_INDIC_UTTERANCE_CATALOG,
  );
  return catalog.utterances.map((u) =>
    loadIndicUtteranceFixture(u.id, options),
  );
}

/**
 * Convert a loaded PCM fixture into an AudioChunk async iterable for transcribe().
 */
export async function* indicFixtureAsAudioStream(
  fixture: IndicUtteranceFixture,
): AsyncIterable<AudioChunk> {
  yield {
    data: fixture.pcm,
    sampleRateHz: fixture.sampleRateHz,
  };
}

function estimateDurationMs(chunks: readonly AudioChunk[]): number {
  let totalBytes = 0;
  let sampleRate = SPEECH_SAMPLE_RATE_HZ;
  for (const c of chunks) {
    totalBytes += c.data.byteLength;
    if (Number.isFinite(c.sampleRateHz) && c.sampleRateHz > 0) {
      sampleRate = c.sampleRateHz;
    }
  }
  // PCM 16-bit mono → 2 bytes/sample
  const samples = totalBytes / 2;
  return Math.max(0, Math.round((samples / sampleRate) * 1000));
}

export class WhisperCppSpeechBinding implements SpeechInterface {
  readonly #subjectId: string;
  readonly #deviceId: string;
  readonly #languages: readonly string[];
  readonly #fallbackLanguage: string;
  readonly #backend: WhisperCppNativeBackend;
  readonly #handle: WhisperCppNativeHandle;
  readonly #onTelemetry?: (event: WhisperCppSttTelemetryEvent) => void;
  readonly #languageHint?: string;
  #unloaded = false;

  constructor(args: {
    subjectId: string;
    deviceId: string;
    languages: readonly string[];
    fallbackLanguage: string;
    backend: WhisperCppNativeBackend;
    handle: WhisperCppNativeHandle;
    onTelemetry?: (event: WhisperCppSttTelemetryEvent) => void;
    languageHint?: string;
  }) {
    this.#subjectId = args.subjectId;
    this.#deviceId = args.deviceId;
    this.#languages = [...args.languages];
    this.#fallbackLanguage = args.fallbackLanguage;
    this.#backend = args.backend;
    this.#handle = args.handle;
    if (args.onTelemetry) this.#onTelemetry = args.onTelemetry;
    if (args.languageHint) this.#languageHint = args.languageHint;
  }

  get supportedLanguages(): string[] {
    return [...this.#languages];
  }

  get subjectId(): string {
    return this.#subjectId;
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  get engine(): typeof WHISPER_CPP_CLASS_ENGINE {
    return WHISPER_CPP_CLASS_ENGINE;
  }

  #emit(
    partial: Omit<WhisperCppSttTelemetryEvent, "event" | "subjectId" | "deviceId" | "engine">,
  ): void {
    this.#onTelemetry?.({
      event: "bindings_speech.stt",
      subjectId: this.#subjectId,
      deviceId: this.#deviceId,
      engine: WHISPER_CPP_CLASS_ENGINE,
      ...partial,
    });
  }

  #assertLoaded(): void {
    if (this.#unloaded) {
      throw new WhisperCppSpeechError(
        "whisper STT binding unloaded",
        "not_loaded",
      );
    }
  }

  async unload(): Promise<void> {
    if (this.#unloaded) return;
    this.#unloaded = true;
    await this.#backend.unload(this.#handle);
    this.#emit({ op: "unload", outcome: "ok" });
  }

  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
  ): AsyncIterable<TranscriptSegment> {
    this.#assertLoaded();
    const chunks: AudioChunk[] = [];
    try {
      for await (const chunk of audio) {
        chunks.push(chunk);
        if (chunks.length >= SPEECH_STREAM_CHUNK_LIMIT) break;
      }

      const durationMs = estimateDurationMs(chunks);
      const pcm =
        chunks.length === 0
          ? new Uint8Array(0)
          : concatBytes(chunks.map((c) => c.data));
      const sampleRateHz =
        chunks.find((c) => c.sampleRateHz > 0)?.sampleRateHz ??
        SPEECH_SAMPLE_RATE_HZ;

      const native = await this.#backend.transcribe(this.#handle, {
        pcm,
        sampleRateHz,
        durationMs,
        supportedLanguages: this.#languages,
        ...(this.#languageHint ? { languageHint: this.#languageHint } : {}),
      });

      // Invariant: ≥1 partial before final on every utterance (including <200ms).
      yield {
        text: native.partialText,
        language: native.language,
        startMs: native.startMs,
        endMs: Math.max(native.startMs, Math.min(native.endMs, native.startMs + 1)),
        confidence: Math.min(native.confidence, 0.85),
        isFinal: false,
      };
      yield {
        text: native.finalText,
        language: native.language,
        startMs: native.startMs,
        endMs: native.endMs,
        confidence: native.confidence,
        isFinal: true,
      };

      this.#emit({
        op: "transcribe",
        outcome: "ok",
        segmentCount: 2,
        durationMs,
        languageCount: this.#languages.length,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#emit({
        op: "transcribe",
        outcome: "error",
        failureClass:
          err instanceof WhisperCppSpeechError ? err.failureClass : "native",
        detail: detail.slice(0, 160),
      });
      throw err;
    }
  }

  /**
   * Minimal on-device synthesize so SpeechInterface is complete for CK-05.2.
   * Full TTS engines land in the TTS binding submodule; unsupported languages
   * fall back to the declared fallbackLanguage — never throw.
   */
  async *synthesize(
    text: string,
    options: SpeechSynthesisOptions,
  ): AsyncIterable<AudioChunk> {
    this.#assertLoaded();
    const requested = options.language?.trim() ?? "";
    const supported = this.#languages.includes(requested);
    const effective = supported ? requested : this.#fallbackLanguage;
    const payload = new TextEncoder().encode(
      `bindings_speech.pcm.${effective}.${this.#subjectId}.${text.slice(0, 32)}`,
    );
    yield {
      data: payload,
      sampleRateHz: SPEECH_SAMPLE_RATE_HZ,
    };
    this.#emit({
      op: "synthesize",
      outcome: supported ? "ok" : "fallback",
      languageCount: this.#languages.length,
      ...(supported ? {} : { detail: "unsupported_language_fallback" }),
    });
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * Load whisper.cpp-class STT: read truthful BCP-47 set from the Indic
 * languages manifest, then open the native/FFI seam.
 */
export async function loadWhisperCppSpeech(
  options: LoadWhisperCppSpeechOptions,
): Promise<WhisperCppSpeechBinding> {
  const subjectId = options.subjectId?.trim();
  const deviceId = options.deviceId?.trim();
  if (!subjectId) {
    throw new WhisperCppSpeechError("subjectId is required", "config");
  }
  if (!deviceId) {
    throw new WhisperCppSpeechError("deviceId is required", "config");
  }

  const manifestPath =
    options.languagesManifestPath ?? DEFAULT_INDIC_LANGUAGES_MANIFEST;
  const manifest = loadIndicLanguagesManifest(manifestPath);
  const backend = options.backend ?? createInProcessWhisperCppBackend();

  const emit = options.onTelemetry;
  try {
    const handle = await backend.load(
      `whisper.cpp-class:${manifest.pinnedRevision ?? "v1"}`,
    );
    const binding = new WhisperCppSpeechBinding({
      subjectId,
      deviceId,
      languages: manifest.languages,
      fallbackLanguage: manifest.fallbackLanguage,
      backend,
      handle,
      ...(options.onTelemetry ? { onTelemetry: options.onTelemetry } : {}),
      ...(options.languageHint ? { languageHint: options.languageHint } : {}),
    });
    emit?.({
      event: "bindings_speech.stt",
      op: "load",
      outcome: "ok",
      subjectId,
      deviceId,
      engine: WHISPER_CPP_CLASS_ENGINE,
      languageCount: manifest.languages.length,
    });
    return binding;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    emit?.({
      event: "bindings_speech.stt",
      op: "load",
      outcome: "error",
      subjectId,
      deviceId,
      engine: WHISPER_CPP_CLASS_ENGINE,
      failureClass:
        err instanceof WhisperCppSpeechError ? err.failureClass : "native",
      detail: detail.slice(0, 160),
    });
    throw err;
  }
}

export type CreateWhisperCppSpeechHarnessOptions = {
  subjectId?: string;
  deviceId?: string;
  languagesManifestPath?: string;
  backend?: WhisperCppNativeBackend;
  onTelemetry?: (event: WhisperCppSttTelemetryEvent) => void;
  languageHint?: string;
};

/** Conformance factory: fresh loaded binding per obligation (subject-scoped). */
export function createWhisperCppSpeechHarnessFactory(
  options: CreateWhisperCppSpeechHarnessOptions = {},
): (ctx?: { subjectId?: string; deviceId?: string }) => Promise<SpeechConformanceHarness> {
  return async (ctx) => {
    const speech = await loadWhisperCppSpeech({
      subjectId:
        ctx?.subjectId?.trim() ||
        options.subjectId?.trim() ||
        "cert.speech.whisper",
      deviceId:
        ctx?.deviceId?.trim() ||
        options.deviceId?.trim() ||
        "ci-speech-stt",
      ...(options.languagesManifestPath
        ? { languagesManifestPath: options.languagesManifestPath }
        : {}),
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.onTelemetry ? { onTelemetry: options.onTelemetry } : {}),
      ...(options.languageHint ? { languageHint: options.languageHint } : {}),
    });
    return { speech };
  };
}
