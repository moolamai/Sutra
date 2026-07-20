/**
 * Speech certification: CK-05 against STT + TTS factories in one job,
 * plus Indic utterance fixture partial-streaming gate.
 *
 * Failures print SPEECH CERT FAIL DIFF with obligation id / fixture id —
 * never raw utterance or synthesis text.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectTranscriptSegments,
  createFinalOnlySpeechHarnessFactory,
  createNoFallbackSpeechHarnessFactory,
  createSpeechObligationsRegistry,
  formatHumanReport,
  hasPartialBeforeFinal,
  runConformance,
  type ConformanceRunReport,
  type SpeechConformanceHarness,
} from "@moolam/contract-conformance";
import {
  WHISPER_CPP_CLASS_ENGINE,
  createWhisperCppSpeechHarnessFactory,
  indicFixtureAsAudioStream,
  loadIndicUtteranceFixture,
  loadWhisperCppSpeech,
} from "./stt_binding.js";
import {
  LOCAL_TTS_ENGINE,
  createLocalTtsSpeechHarnessFactory,
} from "./tts_binding.js";
import {
  DEFAULT_VOICE_RTT_BASELINE,
  DEFAULT_VOICE_RTT_DEVICE_PROFILE,
  runVoiceRttProof,
  type VoiceRttProofResult,
} from "./voice_rtt_proof.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SPEECH_PACKAGE_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_SPEECH_CERT_PROFILE = path.join(
  SPEECH_PACKAGE_ROOT,
  "certification",
  "profile.json",
);
export const DEFAULT_SPEECH_CERT_REPORT = path.join(
  SPEECH_PACKAGE_ROOT,
  "certification",
  "reports",
  "speech.cert.json",
);
export const SPEECH_CERT_REPORT_SCHEMA_VERSION =
  "bindings-speech.speech-cert.report.v1" as const;

export const SPEECH_CERT_OBLIGATION_IDS = ["CK-05.1", "CK-05.2"] as const;

export type SpeechCertBindingId = "stt" | "tts";

export type SpeechCertProfile = {
  schemaVersion: string;
  profileId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  obligationIds: string[];
  bindings: SpeechCertBindingId[];
  indicFixtures: {
    requiredUtteranceIds: string[];
    requirePartialBeforeFinal: boolean;
  };
  voiceRtt?: {
    enabled: boolean;
    nfrId: "NFR-07";
    deviceProfileRelpath: string;
    baselineRelpath: string;
    utteranceId: string;
    language: string;
  };
  reportArtifact: {
    schemaVersion: string;
    defaultRelpath: string;
  };
  description?: string;
};

export type SpeechCertBindingResult = {
  binding: SpeechCertBindingId;
  engine: string;
  outcome: "pass" | "fail";
  exitCode: 0 | 1;
  passed: number;
  failed: number;
  verdicts: Array<{
    obligationId: string;
    outcome: string;
    mustText: string;
    message?: string;
  }>;
};

export type SpeechCertReport = {
  schemaVersion: typeof SPEECH_CERT_REPORT_SCHEMA_VERSION;
  profileId: string;
  outcome: "pass" | "fail";
  subjectId: string;
  deviceId: string;
  exitCode: 0 | 1;
  bindings: SpeechCertBindingResult[];
  indicFixtures: {
    outcome: "pass" | "fail";
    utteranceCount: number;
    failures: string[];
  };
  voiceRtt: VoiceRttProofResult | null;
  failures: string[];
  telemetry: {
    event: "bindings_speech.speech_cert";
    subjectId: string;
    deviceId: string;
    outcome: "pass" | "fail";
    bindingCount: number;
    fixtureCount: number;
    voiceRttOk?: boolean;
  };
};

export type SpeechCertIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

export type RunSpeechCertificationOptions = {
  profilePath?: string;
  reportOutPath?: string;
  /** Inject factories (prove / unit tests). */
  sttFactory?: (
    ctx?: { subjectId?: string; deviceId?: string },
  ) => SpeechConformanceHarness | Promise<SpeechConformanceHarness>;
  ttsFactory?: (
    ctx?: { subjectId?: string; deviceId?: string },
  ) => SpeechConformanceHarness | Promise<SpeechConformanceHarness>;
  /** Skip Indic PCM gate (prove seeded binding-only failures). */
  skipIndicFixtures?: boolean;
  /** Skip NFR-07 voice RTT (CK-05-only prove). */
  skipVoiceRtt?: boolean;
  /** Inject real first-audio delay for NFR-07 seeded red. */
  voiceRttInjectFirstAudioDelayMs?: number;
  /** Override NFR-07 absolute budget (tests). */
  voiceRttBudgetP95Ms?: number;
};

function emitTelemetry(
  io: SpeechCertIo,
  event: Record<string, unknown>,
): void {
  io.stdout.write(
    `${JSON.stringify({ event: "bindings_speech.speech_cert", ...event })}\n`,
  );
}

export function loadSpeechCertProfile(
  profilePath: string = DEFAULT_SPEECH_CERT_PROFILE,
): SpeechCertProfile {
  if (!existsSync(profilePath)) {
    throw new Error(`speech cert profile missing at ${profilePath}`);
  }
  const raw = JSON.parse(readFileSync(profilePath, "utf8")) as Partial<SpeechCertProfile>;
  if (
    typeof raw.schemaVersion !== "string" ||
    typeof raw.profileId !== "string" ||
    typeof raw.subjectId !== "string" ||
    !raw.subjectId.trim() ||
    typeof raw.deviceId !== "string" ||
    !raw.deviceId.trim() ||
    (raw.locality !== "on-device" && raw.locality !== "self-hosted") ||
    !Array.isArray(raw.obligationIds) ||
    raw.obligationIds.length === 0 ||
    !Array.isArray(raw.bindings) ||
    raw.bindings.length === 0 ||
    !Array.isArray(raw.indicFixtures?.requiredUtteranceIds) ||
    raw.indicFixtures.requiredUtteranceIds.length === 0 ||
    typeof raw.reportArtifact?.schemaVersion !== "string"
  ) {
    throw new Error(
      "speech cert profile missing required fields (subjectId, obligationIds, bindings, indicFixtures)",
    );
  }
  for (const id of raw.obligationIds) {
    if (!SPEECH_CERT_OBLIGATION_IDS.includes(id as (typeof SPEECH_CERT_OBLIGATION_IDS)[number])) {
      throw new Error(`speech cert profile unknown obligationId: ${id}`);
    }
  }
  for (const b of raw.bindings) {
    if (b !== "stt" && b !== "tts") {
      throw new Error(`speech cert profile unknown binding: ${String(b)}`);
    }
  }
  return {
    schemaVersion: raw.schemaVersion,
    profileId: raw.profileId,
    subjectId: raw.subjectId.trim(),
    deviceId: raw.deviceId.trim(),
    locality: raw.locality,
    obligationIds: [...raw.obligationIds],
    bindings: [...raw.bindings],
    indicFixtures: {
      requiredUtteranceIds: [...raw.indicFixtures.requiredUtteranceIds],
      requirePartialBeforeFinal:
        raw.indicFixtures.requirePartialBeforeFinal !== false,
    },
    ...(raw.voiceRtt &&
    raw.voiceRtt.nfrId === "NFR-07" &&
    typeof raw.voiceRtt.deviceProfileRelpath === "string" &&
    typeof raw.voiceRtt.baselineRelpath === "string"
      ? {
          voiceRtt: {
            enabled: raw.voiceRtt.enabled !== false,
            nfrId: "NFR-07" as const,
            deviceProfileRelpath: raw.voiceRtt.deviceProfileRelpath,
            baselineRelpath: raw.voiceRtt.baselineRelpath,
            utteranceId:
              typeof raw.voiceRtt.utteranceId === "string" &&
              raw.voiceRtt.utteranceId.trim()
                ? raw.voiceRtt.utteranceId.trim()
                : "hi-greeting",
            language:
              typeof raw.voiceRtt.language === "string" &&
              raw.voiceRtt.language.trim()
                ? raw.voiceRtt.language.trim()
                : "hi-IN",
          },
        }
      : {}),
    reportArtifact: {
      schemaVersion: raw.reportArtifact.schemaVersion,
      defaultRelpath:
        typeof raw.reportArtifact.defaultRelpath === "string"
          ? raw.reportArtifact.defaultRelpath
          : "certification/reports/speech.cert.json",
    },
    ...(typeof raw.description === "string"
      ? { description: raw.description }
      : {}),
  };
}

function summarizeBinding(
  binding: SpeechCertBindingId,
  engine: string,
  report: ConformanceRunReport,
): SpeechCertBindingResult {
  return {
    binding,
    engine,
    outcome: report.exitCode === 0 ? "pass" : "fail",
    exitCode: report.exitCode,
    passed: report.passed,
    failed: report.failed + report.timedOut + report.errored,
    verdicts: report.verdicts.map((v) => ({
      obligationId: v.obligationId,
      outcome: v.outcome,
      mustText: v.mustText,
      ...(v.message ? { message: v.message.slice(0, 240) } : {}),
    })),
  };
}

function printBindingDiff(
  io: SpeechCertIo,
  result: SpeechCertBindingResult,
  human: string,
): void {
  if (result.outcome === "pass") return;
  io.stderr.write(
    `\nSPEECH CERT FAIL DIFF — binding=${result.binding} engine=${result.engine}\n`,
  );
  for (const v of result.verdicts) {
    if (v.outcome === "pass") continue;
    io.stderr.write(
      `  FAIL ${v.obligationId}: ${v.message ?? "obligation failed"}\n`,
    );
    io.stderr.write(`         MUST: ${v.mustText}\n`);
  }
  io.stderr.write(`${human}\n`);
}

export async function runIndicFixtureGate(args: {
  subjectId: string;
  deviceId: string;
  utteranceIds: readonly string[];
  requirePartialBeforeFinal: boolean;
}): Promise<{ outcome: "pass" | "fail"; utteranceCount: number; failures: string[] }> {
  const failures: string[] = [];
  const speech = await loadWhisperCppSpeech({
    subjectId: args.subjectId,
    deviceId: args.deviceId,
  });
  try {
    for (const id of args.utteranceIds) {
      let fixture;
      try {
        fixture = loadIndicUtteranceFixture(id);
      } catch (err) {
        failures.push(
          `fixture ${id}: load failed (${err instanceof Error ? err.message : String(err)})`,
        );
        continue;
      }
      try {
        const segs = await collectTranscriptSegments(
          speech.transcribe(indicFixtureAsAudioStream(fixture)),
        );
        if (segs.length === 0) {
          failures.push(`fixture ${id}: no transcript segments`);
          continue;
        }
        if (
          args.requirePartialBeforeFinal &&
          !hasPartialBeforeFinal(segs)
        ) {
          failures.push(
            `fixture ${id}: missing isFinal:false partial before final (CK-05.1)`,
          );
        }
        const finals = segs.filter((s) => s.isFinal);
        if (finals.length === 0) {
          failures.push(`fixture ${id}: missing final segment`);
        }
      } catch (err) {
        failures.push(
          `fixture ${id}: transcribe threw (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  } finally {
    await speech.unload();
  }
  return {
    outcome: failures.length === 0 ? "pass" : "fail",
    utteranceCount: args.utteranceIds.length,
    failures,
  };
}

/**
 * Run STT + TTS CK-05 and Indic fixture gate; write report; loud DIFF on fail.
 */
export async function runSpeechCertification(
  io: SpeechCertIo,
  options: RunSpeechCertificationOptions = {},
): Promise<{ exitCode: 0 | 1; report: SpeechCertReport }> {
  const profile = loadSpeechCertProfile(options.profilePath);
  const failures: string[] = [];
  const bindingResults: SpeechCertBindingResult[] = [];

  emitTelemetry(io, {
    op: "start",
    outcome: "ok",
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    profileId: profile.profileId,
  });

  const registry = createSpeechObligationsRegistry();

  if (profile.bindings.includes("stt")) {
    const factory =
      options.sttFactory ??
      createWhisperCppSpeechHarnessFactory({
        subjectId: profile.subjectId,
        deviceId: profile.deviceId,
      });
    const report = await runConformance({
      registry,
      factory,
      subjectId: `${profile.subjectId}.stt`,
      deviceId: profile.deviceId,
      obligationIds: profile.obligationIds,
    });
    const summarized = summarizeBinding("stt", WHISPER_CPP_CLASS_ENGINE, report);
    bindingResults.push(summarized);
    printBindingDiff(io, summarized, formatHumanReport(report));
    if (summarized.outcome === "fail") {
      failures.push(
        ...summarized.verdicts
          .filter((v) => v.outcome !== "pass")
          .map(
            (v) =>
              `stt ${v.obligationId}: ${v.message ?? v.outcome}`,
          ),
      );
    }
  }

  if (profile.bindings.includes("tts")) {
    const factory =
      options.ttsFactory ??
      createLocalTtsSpeechHarnessFactory({
        subjectId: profile.subjectId,
        deviceId: profile.deviceId,
      });
    const report = await runConformance({
      registry,
      factory,
      subjectId: `${profile.subjectId}.tts`,
      deviceId: profile.deviceId,
      obligationIds: profile.obligationIds,
    });
    const summarized = summarizeBinding("tts", LOCAL_TTS_ENGINE, report);
    bindingResults.push(summarized);
    printBindingDiff(io, summarized, formatHumanReport(report));
    if (summarized.outcome === "fail") {
      failures.push(
        ...summarized.verdicts
          .filter((v) => v.outcome !== "pass")
          .map(
            (v) =>
              `tts ${v.obligationId}: ${v.message ?? v.outcome}`,
          ),
      );
    }
  }

  let indicFixtures: SpeechCertReport["indicFixtures"] = {
    outcome: "pass",
    utteranceCount: 0,
    failures: [],
  };
  if (!options.skipIndicFixtures) {
    indicFixtures = await runIndicFixtureGate({
      subjectId: `${profile.subjectId}.fixtures`,
      deviceId: profile.deviceId,
      utteranceIds: profile.indicFixtures.requiredUtteranceIds,
      requirePartialBeforeFinal:
        profile.indicFixtures.requirePartialBeforeFinal,
    });
    if (indicFixtures.outcome === "fail") {
      io.stderr.write(
        `\nSPEECH CERT FAIL DIFF — indicFixtures utteranceCount=${indicFixtures.utteranceCount}\n`,
      );
      for (const f of indicFixtures.failures) {
        io.stderr.write(`  FAIL ${f}\n`);
      }
      failures.push(...indicFixtures.failures);
    }
  }

  let voiceRtt: VoiceRttProofResult | null = null;
  const voiceRttEnabled =
    !options.skipVoiceRtt && profile.voiceRtt?.enabled !== false;
  if (voiceRttEnabled && profile.voiceRtt) {
    const deviceProfilePath = path.join(
      SPEECH_PACKAGE_ROOT,
      profile.voiceRtt.deviceProfileRelpath,
    );
    const baselinePath = path.join(
      SPEECH_PACKAGE_ROOT,
      profile.voiceRtt.baselineRelpath,
    );
    voiceRtt = await runVoiceRttProof({
      subjectId: `${profile.subjectId}.voiceRtt`,
      deviceId: profile.deviceId,
      deviceProfilePath: existsSync(deviceProfilePath)
        ? deviceProfilePath
        : DEFAULT_VOICE_RTT_DEVICE_PROFILE,
      baselinePath: existsSync(baselinePath)
        ? baselinePath
        : DEFAULT_VOICE_RTT_BASELINE,
      utteranceId: profile.voiceRtt.utteranceId,
      language: profile.voiceRtt.language,
      ...(options.voiceRttInjectFirstAudioDelayMs !== undefined
        ? {
            injectFirstAudioDelayMs: options.voiceRttInjectFirstAudioDelayMs,
          }
        : {}),
      ...(options.voiceRttBudgetP95Ms !== undefined
        ? { budgetP95Ms: options.voiceRttBudgetP95Ms }
        : {}),
    });
    if (!voiceRtt.ok) {
      io.stderr.write(
        `\nSPEECH CERT FAIL DIFF — NFR-07 voiceRtt measuredP95=${voiceRtt.measuredP95Ms.toFixed(3)}ms budget=${voiceRtt.budgetP95Ms}ms allowedRelative=${voiceRtt.allowedRelativeP95Ms.toFixed(3)}ms clock=${voiceRtt.clock}\n`,
      );
      for (const f of voiceRtt.failures) {
        io.stderr.write(`  FAIL ${f}\n`);
      }
      failures.push(...voiceRtt.failures);
    } else {
      io.stdout.write(
        `SPEECH CERT NFR-07 PASS — p95 ${voiceRtt.measuredP95Ms.toFixed(3)}ms ≤ budget ${voiceRtt.budgetP95Ms}ms (relative ≤ ${voiceRtt.allowedRelativeP95Ms.toFixed(3)}ms)\n`,
      );
    }
  }

  const exitCode: 0 | 1 = failures.length === 0 ? 0 : 1;
  const outcome: "pass" | "fail" = exitCode === 0 ? "pass" : "fail";
  const report: SpeechCertReport = {
    schemaVersion: SPEECH_CERT_REPORT_SCHEMA_VERSION,
    profileId: profile.profileId,
    outcome,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    exitCode,
    bindings: bindingResults,
    indicFixtures,
    voiceRtt,
    failures,
    telemetry: {
      event: "bindings_speech.speech_cert",
      subjectId: profile.subjectId,
      deviceId: profile.deviceId,
      outcome,
      bindingCount: bindingResults.length,
      fixtureCount: indicFixtures.utteranceCount,
      ...(voiceRtt ? { voiceRttOk: voiceRtt.ok } : {}),
    },
  };

  const reportPath =
    options.reportOutPath ??
    path.join(SPEECH_PACKAGE_ROOT, profile.reportArtifact.defaultRelpath);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  emitTelemetry(io, {
    op: "complete",
    outcome,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    exitCode,
    bindingCount: bindingResults.length,
    fixtureCount: indicFixtures.utteranceCount,
    failureCount: failures.length,
    reportPath,
  });

  if (exitCode !== 0) {
    io.stderr.write(
      `SPEECH CERT FAIL — ${failures.length} failure(s); see DIFF above and ${reportPath}\n`,
    );
  } else {
    io.stdout.write(
      `SPEECH CERT PASS — STT+TTS CK-05 + ${indicFixtures.utteranceCount} Indic fixtures` +
        (voiceRtt ? ` + NFR-07 p95 ${voiceRtt.measuredP95Ms.toFixed(1)}ms` : "") +
        `\n`,
    );
  }

  return { exitCode, report };
}

export type ProveSpeechCertResult = {
  exitCode: 0 | 1;
  phases: Array<{ phase: string; status: number }>;
};

/**
 * Green → seeded CK-05 red → seeded NFR-07 red → green again.
 * Does not mutate the working tree.
 */
export async function proveSpeechCertificationGate(
  io: SpeechCertIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<ProveSpeechCertResult> {
  const phases: Array<{ phase: string; status: number }> = [];
  const tmpRoot = path.join(SPEECH_PACKAGE_ROOT, "certification", "reports");
  mkdirSync(tmpRoot, { recursive: true });

  const green1 = await runSpeechCertification(io, {
    reportOutPath: path.join(tmpRoot, "prove.green1.speech.cert.json"),
  });
  phases.push({ phase: "baseline.green", status: green1.exitCode });
  if (green1.exitCode !== 0) {
    throw new Error(
      `SPEECH_CERT_PROVE_BASELINE_RED:\n${JSON.stringify(green1.report.failures).slice(0, 2000)}`,
    );
  }
  if (!green1.report.voiceRtt?.ok) {
    throw new Error("SPEECH_CERT_PROVE_BASELINE_MISSING_NFR07: voice RTT must pass");
  }

  const seeded = await runSpeechCertification(io, {
    skipIndicFixtures: true,
    skipVoiceRtt: true,
    sttFactory: createFinalOnlySpeechHarnessFactory(),
    ttsFactory: createNoFallbackSpeechHarnessFactory(),
    reportOutPath: path.join(tmpRoot, "prove.seeded-red.speech.cert.json"),
  });
  phases.push({ phase: "seeded.red.ck05", status: seeded.exitCode });
  if (seeded.exitCode === 0) {
    throw new Error(
      "SPEECH_CERT_PROVE_SEED_UNEXPECTED_GREEN: final-only STT + no-fallback TTS must fail CK-05",
    );
  }
  const redText = JSON.stringify(seeded.report);
  if (!redText.includes("CK-05.1") && !redText.includes("CK-05.2")) {
    throw new Error(
      `SPEECH_CERT_PROVE_SEED_MISSING_OBLIGATION_ID:\n${redText.slice(0, 2000)}`,
    );
  }
  const hasMust =
    /MUST/i.test(redText) ||
    seeded.report.bindings.some((b) =>
      b.verdicts.some((v) => v.outcome !== "pass" && /MUST/i.test(v.mustText)),
    );
  if (!hasMust) {
    throw new Error(
      `SPEECH_CERT_PROVE_SEED_MISSING_MUST:\n${redText.slice(0, 2000)}`,
    );
  }
  io.stdout.write(
    `\n--- speech-cert seeded-red CK-05 (failures) ---\n${seeded.report.failures.join("\n")}\n---\n`,
  );

  // Real timer delay before first audio — breaches absolute NFR-07 (2500ms).
  const nfr07Red = await runVoiceRttProof({
    subjectId: "cert.speech.prove.nfr07",
    deviceId: "ci-speech-ubuntu",
    injectFirstAudioDelayMs: 3_200,
    sampleCount: 3,
    warmupCount: 0,
  });
  phases.push({
    phase: "seeded.red.nfr07",
    status: nfr07Red.ok ? 0 : 1,
  });
  if (nfr07Red.ok) {
    throw new Error(
      "SPEECH_CERT_PROVE_NFR07_UNEXPECTED_GREEN: 3200ms first-audio delay must fail NFR-07",
    );
  }
  if (!nfr07Red.failures.some((f) => /NFR-07/.test(f))) {
    throw new Error(
      `SPEECH_CERT_PROVE_NFR07_MISSING_DIFF:\n${nfr07Red.failures.join("\n")}`,
    );
  }
  io.stderr.write(
    `\nSPEECH CERT FAIL DIFF — NFR-07 seeded delay measuredP95=${nfr07Red.measuredP95Ms.toFixed(3)}ms budget=${nfr07Red.budgetP95Ms}ms\n`,
  );
  for (const f of nfr07Red.failures) {
    io.stderr.write(`  FAIL ${f}\n`);
  }
  io.stdout.write(
    `\n--- speech-cert seeded-red NFR-07 (failures) ---\n${nfr07Red.failures.join("\n")}\n---\n`,
  );

  const green2 = await runSpeechCertification(io, {
    reportOutPath: DEFAULT_SPEECH_CERT_REPORT,
  });
  phases.push({ phase: "restore.green", status: green2.exitCode });
  if (green2.exitCode !== 0) {
    throw new Error(
      `SPEECH_CERT_PROVE_RESTORE_STILL_RED:\n${JSON.stringify(green2.report.failures).slice(0, 2000)}`,
    );
  }
  if (!green2.report.voiceRtt?.ok) {
    throw new Error("SPEECH_CERT_PROVE_RESTORE_MISSING_NFR07: voice RTT must pass");
  }

  emitTelemetry(io, {
    op: "prove",
    outcome: "ok",
    subjectId: green2.report.subjectId,
    deviceId: green2.report.deviceId,
    phases: phases.map((p) => p.phase),
  });

  return { exitCode: 0, phases };
}

export type ParsedSpeechCertCli = {
  help: boolean;
  prove: boolean;
  reportOut?: string;
  profilePath?: string;
  errors: string[];
};

export function parseSpeechCertArgv(argv: readonly string[]): ParsedSpeechCertCli {
  const out: ParsedSpeechCertCli = { help: false, prove: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--prove") {
      out.prove = true;
      continue;
    }
    if (a === "--report-out") {
      const v = argv[++i];
      if (!v) out.errors.push("--report-out requires a value");
      else out.reportOut = v;
      continue;
    }
    if (a === "--profile") {
      const v = argv[++i];
      if (!v) out.errors.push("--profile requires a value");
      else out.profilePath = v;
      continue;
    }
    out.errors.push(`unknown argument: ${a}`);
  }
  return out;
}

const SPEECH_CERT_HELP = `Usage: speech-cert [options]

Indic speech certification (CK-05 STT+TTS + Indic fixtures).

Options:
  --prove               Green → seeded red → green (CI prove gate)
  --report-out <path>   Write speech.cert.json to path
  --profile <path>      Cert profile JSON (default: certification/profile.json)
  -h, --help            Show help
`;

export async function runSpeechCertCli(
  argv: readonly string[],
  io: SpeechCertIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  const args = parseSpeechCertArgv(argv);
  if (args.help) {
    io.stdout.write(SPEECH_CERT_HELP);
    return 0;
  }
  if (args.errors.length) {
    io.stderr.write(`${args.errors.join("\n")}\n`);
    return 1;
  }
  if (args.prove) {
    try {
      const result = await proveSpeechCertificationGate(io);
      return result.exitCode;
    } catch (err) {
      io.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  const { exitCode } = await runSpeechCertification(io, {
    ...(args.reportOut ? { reportOutPath: args.reportOut } : {}),
    ...(args.profilePath ? { profilePath: args.profilePath } : {}),
  });
  return exitCode;
}
