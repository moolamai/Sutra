/**
 * NFR-07 voice RTT proof: final transcript timestamp → first TTS audio chunk.
 *
 * Uses real performance.now() wall clocks on the measurement path (not mocked
 * clocks alone). Absolute ceiling from PRD_MATRIX (≤2500ms p95) plus relative
 * regression vs a recorded device-profile baseline.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTranscriptSegments } from "@moolam/contract-conformance";
import {
  indicFixtureAsAudioStream,
  loadIndicUtteranceFixture,
  loadWhisperCppSpeech,
} from "./stt_binding.js";
import {
  createInProcessLocalTtsBackend,
  loadLocalTts,
  type LocalTtsNativeBackend,
} from "./tts_binding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

export const NFR_07_ID = "NFR-07" as const;
export const NFR_07_BUDGET_P95_MS = 2500;
export const DEFAULT_VOICE_RTT_DEVICE_PROFILE = path.join(
  PACKAGE_ROOT,
  "certification",
  "device-profiles",
  "mid-range-android.json",
);
export const DEFAULT_VOICE_RTT_BASELINE = path.join(
  PACKAGE_ROOT,
  "certification",
  "voice-rtt.baseline.json",
);

export type VoiceRttDeviceProfile = {
  schemaVersion: string;
  profileId: string;
  platform: string;
  hardwareClass: string;
  nfr: {
    nfrId: typeof NFR_07_ID;
    metric: "final_transcript_to_first_audio";
    voiceRttP95Ms: number;
  };
  description?: string;
};

export type VoiceRttBaseline = {
  schemaVersion: string;
  nfrId: typeof NFR_07_ID;
  metric: "final_transcript_to_first_audio";
  deviceProfileId: string;
  p95Ms: number;
  tolerancePercent: number;
  sampleCount: number;
  warmupCount: number;
  notes?: string;
  recordedAt?: string;
};

export type VoiceRttSample = {
  latencyMs: number;
  utteranceId: string;
};

export type VoiceRttProofResult = {
  nfrId: typeof NFR_07_ID;
  metric: "final_transcript_to_first_audio";
  outcome: "pass" | "fail";
  ok: boolean;
  measuredP95Ms: number;
  budgetP95Ms: number;
  baselineP95Ms: number;
  allowedRelativeP95Ms: number;
  absoluteOk: boolean;
  relativeOk: boolean;
  sampleCount: number;
  samplesMs: number[];
  deviceProfileId: string;
  subjectId: string;
  deviceId: string;
  clock: "performance.now";
  failures: string[];
  policy: "absolute-ceiling-plus-relative-baseline";
};

export type RunVoiceRttProofOptions = {
  subjectId: string;
  deviceId: string;
  deviceProfilePath?: string;
  baselinePath?: string;
  utteranceId?: string;
  sampleCount?: number;
  warmupCount?: number;
  /** Real delay before first TTS chunk (seeded red / prove). */
  injectFirstAudioDelayMs?: number;
  /** Override absolute budget (tests). */
  budgetP95Ms?: number;
  /** Override baseline p95 (tests). */
  baselineP95Ms?: number;
  tolerancePercent?: number;
  language?: string;
};

function nowMs(): number {
  return performance.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Percentile (nearest-rank) over ascending samples. */
export function percentileMs(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[rank]!;
}

export function loadVoiceRttDeviceProfile(
  profilePath: string = DEFAULT_VOICE_RTT_DEVICE_PROFILE,
): VoiceRttDeviceProfile {
  if (!existsSync(profilePath)) {
    throw new Error(`voice RTT device profile missing at ${profilePath}`);
  }
  const raw = JSON.parse(
    readFileSync(profilePath, "utf8"),
  ) as Partial<VoiceRttDeviceProfile>;
  if (
    typeof raw.schemaVersion !== "string" ||
    typeof raw.profileId !== "string" ||
    raw.nfr?.nfrId !== NFR_07_ID ||
    raw.nfr.metric !== "final_transcript_to_first_audio" ||
    typeof raw.nfr.voiceRttP95Ms !== "number" ||
    !(raw.nfr.voiceRttP95Ms > 0)
  ) {
    throw new Error(
      "voice RTT device profile must declare NFR-07 final_transcript_to_first_audio budget",
    );
  }
  return {
    schemaVersion: raw.schemaVersion,
    profileId: raw.profileId,
    platform: typeof raw.platform === "string" ? raw.platform : "android",
    hardwareClass:
      typeof raw.hardwareClass === "string" ? raw.hardwareClass : "mid-range",
    nfr: {
      nfrId: NFR_07_ID,
      metric: "final_transcript_to_first_audio",
      voiceRttP95Ms: raw.nfr.voiceRttP95Ms,
    },
    ...(typeof raw.description === "string"
      ? { description: raw.description }
      : {}),
  };
}

export function loadVoiceRttBaseline(
  baselinePath: string = DEFAULT_VOICE_RTT_BASELINE,
): VoiceRttBaseline {
  if (!existsSync(baselinePath)) {
    throw new Error(`voice RTT baseline missing at ${baselinePath}`);
  }
  const raw = JSON.parse(
    readFileSync(baselinePath, "utf8"),
  ) as Partial<VoiceRttBaseline>;
  if (
    typeof raw.schemaVersion !== "string" ||
    raw.nfrId !== NFR_07_ID ||
    raw.metric !== "final_transcript_to_first_audio" ||
    typeof raw.deviceProfileId !== "string" ||
    typeof raw.p95Ms !== "number" ||
    !(raw.p95Ms > 0) ||
    typeof raw.tolerancePercent !== "number" ||
    !(raw.tolerancePercent >= 0) ||
    typeof raw.sampleCount !== "number" ||
    !(raw.sampleCount > 0)
  ) {
    throw new Error(
      "voice RTT baseline must declare NFR-07 p95Ms, tolerancePercent, sampleCount",
    );
  }
  return {
    schemaVersion: raw.schemaVersion,
    nfrId: NFR_07_ID,
    metric: "final_transcript_to_first_audio",
    deviceProfileId: raw.deviceProfileId,
    p95Ms: raw.p95Ms,
    tolerancePercent: raw.tolerancePercent,
    sampleCount: Math.min(64, Math.floor(raw.sampleCount)),
    warmupCount:
      typeof raw.warmupCount === "number" && raw.warmupCount >= 0
        ? Math.min(16, Math.floor(raw.warmupCount))
        : 2,
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
    ...(typeof raw.recordedAt === "string" ? { recordedAt: raw.recordedAt } : {}),
  };
}

/**
 * Wrap a TTS backend to delay the first audio chunk with a real timer
 * (seeded red for NFR-07). Uses setTimeout — not a mocked clock.
 */
export function createDelayedFirstAudioTtsBackend(
  delayMs: number,
  inner: LocalTtsNativeBackend = createInProcessLocalTtsBackend(),
): LocalTtsNativeBackend {
  const ms = Math.max(0, delayMs);
  return {
    kind: inner.kind,
    load: (modelId) => inner.load(modelId),
    unload: (handle) => inner.unload(handle),
    async synthesize(handle, params) {
      if (ms > 0) await sleep(ms);
      return inner.synthesize(handle, params);
    },
  };
}

export function evaluateVoiceRttGates(args: {
  measuredP95Ms: number;
  budgetP95Ms: number;
  baselineP95Ms: number;
  tolerancePercent: number;
}): {
  absoluteOk: boolean;
  relativeOk: boolean;
  allowedRelativeP95Ms: number;
  failures: string[];
} {
  const failures: string[] = [];
  const absoluteOk =
    Number.isFinite(args.measuredP95Ms) &&
    args.measuredP95Ms <= args.budgetP95Ms;
  if (!absoluteOk) {
    failures.push(
      `NFR-07 absolute: p95 ${args.measuredP95Ms.toFixed(3)}ms > budget ${args.budgetP95Ms}ms`,
    );
  }
  const allowedRelativeP95Ms =
    args.baselineP95Ms * (1 + args.tolerancePercent / 100);
  const relativeOk =
    Number.isFinite(args.measuredP95Ms) &&
    args.measuredP95Ms <= allowedRelativeP95Ms;
  if (!relativeOk) {
    failures.push(
      `NFR-07 relative: p95 ${args.measuredP95Ms.toFixed(3)}ms > allowed ${allowedRelativeP95Ms.toFixed(3)}ms (baseline ${args.baselineP95Ms}ms + ${args.tolerancePercent}%)`,
    );
  }
  return { absoluteOk, relativeOk, allowedRelativeP95Ms, failures };
}

/**
 * One sample: STT until final → clock → TTS until first audio chunk → clock.
 */
export async function measureOneVoiceRttSample(args: {
  subjectId: string;
  deviceId: string;
  utteranceId: string;
  language: string;
  injectFirstAudioDelayMs?: number;
}): Promise<VoiceRttSample> {
  const fixture = loadIndicUtteranceFixture(args.utteranceId);
  const stt = await loadWhisperCppSpeech({
    subjectId: args.subjectId,
    deviceId: args.deviceId,
  });
  const tts = await loadLocalTts({
    subjectId: args.subjectId,
    deviceId: args.deviceId,
    ...(args.injectFirstAudioDelayMs && args.injectFirstAudioDelayMs > 0
      ? {
          backend: createDelayedFirstAudioTtsBackend(
            args.injectFirstAudioDelayMs,
          ),
        }
      : {}),
  });

  try {
    let tFinal: number | undefined;
    let finalText = "";
    for await (const seg of stt.transcribe(
      indicFixtureAsAudioStream(fixture),
    )) {
      if (!seg.isFinal) continue;
      tFinal = nowMs();
      finalText = seg.text.trim() || "voice.rtt.probe";
      break;
    }
    if (tFinal === undefined) {
      // Fallback collect if stream ended without early break
      const segs = await collectTranscriptSegments(
        stt.transcribe(indicFixtureAsAudioStream(fixture)),
      );
      const final = [...segs].reverse().find((s) => s.isFinal);
      if (!final) {
        throw new Error(`voice RTT: no final transcript for ${args.utteranceId}`);
      }
      tFinal = nowMs();
      finalText = final.text.trim() || "voice.rtt.probe";
    }

    let tFirst: number | undefined;
    for await (const chunk of tts.synthesize(finalText, {
      language: args.language,
    })) {
      if (chunk.data.byteLength > 0) {
        tFirst = nowMs();
        break;
      }
    }
    if (tFirst === undefined) {
      throw new Error("voice RTT: synthesize yielded no audio chunks");
    }
    const latencyMs = Math.max(0, tFirst - tFinal);
    return { latencyMs, utteranceId: args.utteranceId };
  } finally {
    await Promise.all([stt.unload(), tts.unload()]);
  }
}

/**
 * Run NFR-07 voice RTT proof on the recorded mid-range device profile.
 */
export async function runVoiceRttProof(
  options: RunVoiceRttProofOptions,
): Promise<VoiceRttProofResult> {
  const deviceProfile = loadVoiceRttDeviceProfile(
    options.deviceProfilePath ?? DEFAULT_VOICE_RTT_DEVICE_PROFILE,
  );
  const baseline = loadVoiceRttBaseline(
    options.baselinePath ?? DEFAULT_VOICE_RTT_BASELINE,
  );
  const budgetP95Ms =
    options.budgetP95Ms ?? deviceProfile.nfr.voiceRttP95Ms ?? NFR_07_BUDGET_P95_MS;
  const baselineP95Ms = options.baselineP95Ms ?? baseline.p95Ms;
  const tolerancePercent =
    options.tolerancePercent ?? baseline.tolerancePercent;
  const sampleCount = Math.min(
    64,
    Math.max(1, options.sampleCount ?? baseline.sampleCount),
  );
  const warmupCount = Math.min(
    16,
    Math.max(0, options.warmupCount ?? baseline.warmupCount),
  );
  const utteranceId = options.utteranceId ?? "hi-greeting";
  const language = options.language ?? "hi-IN";

  const measured: number[] = [];
  const total = warmupCount + sampleCount;
  for (let i = 0; i < total; i++) {
    const sample = await measureOneVoiceRttSample({
      subjectId: `${options.subjectId}.rtt.${i}`,
      deviceId: options.deviceId,
      utteranceId,
      language,
      ...(options.injectFirstAudioDelayMs !== undefined
        ? { injectFirstAudioDelayMs: options.injectFirstAudioDelayMs }
        : {}),
    });
    if (i >= warmupCount) {
      measured.push(sample.latencyMs);
    }
  }

  const measuredP95Ms = percentileMs(measured, 95);
  const gates = evaluateVoiceRttGates({
    measuredP95Ms,
    budgetP95Ms,
    baselineP95Ms,
    tolerancePercent,
  });
  const ok = gates.absoluteOk && gates.relativeOk;

  return {
    nfrId: NFR_07_ID,
    metric: "final_transcript_to_first_audio",
    outcome: ok ? "pass" : "fail",
    ok,
    measuredP95Ms,
    budgetP95Ms,
    baselineP95Ms,
    allowedRelativeP95Ms: gates.allowedRelativeP95Ms,
    absoluteOk: gates.absoluteOk,
    relativeOk: gates.relativeOk,
    sampleCount: measured.length,
    samplesMs: measured.map((m) => Number(m.toFixed(3))),
    deviceProfileId: deviceProfile.profileId,
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    clock: "performance.now",
    failures: gates.failures,
    policy: "absolute-ceiling-plus-relative-baseline",
  };
}
