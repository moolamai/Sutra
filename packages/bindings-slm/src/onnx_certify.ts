/**
 * Android / ONNX mobile certification harness.
 *
 * B0 model obligations + B1 locality + NFR-01 first_token floor + memory-ceiling
 * refuse-before-materialize. Profile: certification/android.profile.json.
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS,
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  createModelObligationsRegistry,
  runConformance,
  withEgressRecordingTurn,
  type ConformanceObligationEvent,
  type ConformanceRunnerEvent,
} from "@moolam/contract-conformance";
import {
  CertifyValidationError,
  CERT_PROFILE_SCHEMA_VERSION,
  CERTIFICATION_DIR,
  PACKAGE_ROOT,
  sha256File,
  writeCertifyReportArtifact,
  type CertifyIo,
} from "./certify.js";
import { createOnnxModelAdapterHarnessFactory } from "./onnx_model_adapter.js";
import {
  ONNX_MOBILE_SUPPORTED_QUANT_FORMATS,
  ONNX_RUNTIME_MOBILE_PINNED_VERSION,
  OnnxSlmRuntime,
  createInProcessOnnxMobileBackend,
  loadMidRangeDeviceProfile,
} from "./onnx_mobile_runtime.js";

export const ANDROID_PROFILE_PATH = path.join(
  CERTIFICATION_DIR,
  "android.profile.json",
);

/** Same closed B0 set as desktop — keep ANDROID profile obligations.b0Model in sync. */
export const ANDROID_CERTIFICATION_MODEL_OBLIGATION_IDS =
  DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS;

export type OnnxAndroidCertProfile = {
  schemaVersion: string;
  profileId: string;
  adapter: string;
  description?: string;
  hardware: {
    class: string;
    gpuRequired: boolean;
    quantPolicy: string;
    emulatorOk?: boolean;
    deviceProfileRelpath?: string;
  };
  modelArtifact: {
    name: string;
    format: string;
    quantization: string;
    fixtureRelpath: string;
    artifactSha256: string;
    onnxRuntimePinnedVersion: string;
    supportedQuantFormatsRelpath?: string;
  };
  obligations: {
    b0Model: string[];
    b1Locality: {
      harness: string;
      zeroEgressOps: string[];
      obligationId: string;
      policyId?: string;
    };
  };
  benches: {
    subset: string[];
    gates: Record<string, Record<string, unknown>>;
  };
  memoryCeiling?: {
    maxMemoryMiBFromDeviceProfile?: boolean;
    overBudgetFixtureRelpath?: string;
    requireRefuseBeforeMaterialize?: boolean;
  };
  subjectId: string;
  deviceId: string;
  segfaultRetry?: { maxAttempts: number; matchClasses: string[] };
  observability?: { event: string; emitContentBodies: boolean };
  reportArtifact?: {
    schemaVersion: string;
    ciRelpath: string;
    committedRelpath?: string;
    contains: string[];
  };
};

export type OnnxAndroidCertReport = {
  schemaVersion: "bindings-slm.cert-report.v1";
  recordedAt: string;
  event: "bindings_slm.certify";
  outcome: "pass" | "fail";
  profileId: string;
  adapter: string;
  subjectId: string;
  deviceId: string;
  modelArtifactSha256: string;
  measuredArtifactSha256: string;
  onnxRuntimePinnedVersion: string;
  supportedQuantFormats: string[];
  obligationVerdicts: Array<{
    obligationId: string;
    outcome: string;
    message?: string;
  }>;
  egressRecord: {
    ok: boolean;
    attemptCount: number;
    zeroEgressOps: string[];
    obligationId: string;
    detail?: string;
  };
  p95Benches: {
    first_token: {
      nfrId: string;
      measuredMs: number | null;
      budgetP95Ms: number;
      floorP95Ms: number;
      ok: boolean | null;
    };
  };
  memoryCeiling: {
    ok: boolean;
    maxMemoryMiB: number;
    overBudgetRefused: boolean;
    materializeCountOnReject: number;
    detail?: string;
  };
  failures: string[];
};

function emit(
  io: CertifyIo,
  partial: Record<string, unknown> & { outcome: string },
): void {
  io.stdout.write(
    `${JSON.stringify({
      event: "bindings_slm.certify",
      ...partial,
    })}\n`,
  );
}

export function loadOnnxAndroidCertProfile(
  profilePath: string = ANDROID_PROFILE_PATH,
): OnnxAndroidCertProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (err) {
    throw new CertifyValidationError(
      `android profile unreadable: ${err instanceof Error ? err.message : "unknown"}`,
      { failureClass: "config" },
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new CertifyValidationError("android profile root must be an object", {
      failureClass: "config",
    });
  }
  const p = raw as OnnxAndroidCertProfile;
  if (p.schemaVersion !== CERT_PROFILE_SCHEMA_VERSION) {
    throw new CertifyValidationError(
      `schemaVersion must be ${CERT_PROFILE_SCHEMA_VERSION}`,
      { failureClass: "config", profileId: p.profileId },
    );
  }
  if (p.adapter !== "onnx") {
    throw new CertifyValidationError(
      `android certification requires adapter "onnx" (got ${p.adapter})`,
      { failureClass: "config", profileId: p.profileId },
    );
  }
  if (!p.subjectId?.trim() || !p.deviceId?.trim()) {
    throw new CertifyValidationError("subjectId and deviceId are required", {
      failureClass: "config",
      profileId: p.profileId,
    });
  }
  if (
    !p.modelArtifact?.artifactSha256 ||
    !p.modelArtifact?.onnxRuntimePinnedVersion
  ) {
    throw new CertifyValidationError(
      "modelArtifact.artifactSha256 and onnxRuntimePinnedVersion are required",
      { failureClass: "config", profileId: p.profileId },
    );
  }
  if (!Array.isArray(p.obligations?.b0Model) || p.obligations.b0Model.length === 0) {
    throw new CertifyValidationError("obligations.b0Model must be non-empty", {
      failureClass: "config",
      profileId: p.profileId,
    });
  }
  return p;
}

function fixturePath(profile: OnnxAndroidCertProfile): string {
  return path.join(PACKAGE_ROOT, profile.modelArtifact.fixtureRelpath);
}

function loadSupportedQuants(profile: OnnxAndroidCertProfile): string[] {
  const rel =
    profile.modelArtifact.supportedQuantFormatsRelpath ??
    "android/SUPPORTED_QUANT_FORMATS.json";
  const abs = path.join(PACKAGE_ROOT, rel);
  if (!existsSync(abs)) {
    return [...ONNX_MOBILE_SUPPORTED_QUANT_FORMATS];
  }
  const doc = JSON.parse(readFileSync(abs, "utf8")) as {
    supportedQuantFormats?: Array<{ id: string; certified?: boolean }>;
  };
  const ids = (doc.supportedQuantFormats ?? [])
    .filter((q) => q.certified !== false)
    .map((q) => q.id);
  return ids.length > 0 ? ids : [...ONNX_MOBILE_SUPPORTED_QUANT_FORMATS];
}

export type RunOnnxAndroidCertifyOptions = {
  reportOutPath?: string;
  /** Also write the committed in-repo report when profile names committedRelpath. */
  writeCommittedReport?: boolean;
};

/**
 * Run Android ONNX mobile certification for a loaded profile.
 */
export async function runOnnxAndroidCertifyProfile(
  profile: OnnxAndroidCertProfile,
  io: CertifyIo = { stdout: process.stdout, stderr: process.stderr },
  options: RunOnnxAndroidCertifyOptions = {},
): Promise<{ exitCode: 0 | 1; report: OnnxAndroidCertReport }> {
  const failures: string[] = [];
  const events: Array<
    ConformanceObligationEvent | ConformanceRunnerEvent | Record<string, unknown>
  > = [];

  emit(io, {
    outcome: "start",
    profileId: profile.profileId,
    adapter: profile.adapter,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
  });

  const fixture = fixturePath(profile);
  if (!existsSync(fixture)) {
    failures.push(`model fixture missing: ${fixture}`);
  }
  const measuredSha256 = existsSync(fixture) ? sha256File(fixture) : "";
  if (
    measuredSha256 &&
    measuredSha256 !== profile.modelArtifact.artifactSha256.toLowerCase()
  ) {
    failures.push(
      `artifact hash mismatch: profile=${profile.modelArtifact.artifactSha256} measured=${measuredSha256}`,
    );
  }
  if (
    profile.modelArtifact.onnxRuntimePinnedVersion !==
    ONNX_RUNTIME_MOBILE_PINNED_VERSION
  ) {
    failures.push(
      `ORT pin mismatch: profile=${profile.modelArtifact.onnxRuntimePinnedVersion} package=${ONNX_RUNTIME_MOBILE_PINNED_VERSION}`,
    );
  }

  const expectedB0 = [...ANDROID_CERTIFICATION_MODEL_OBLIGATION_IDS].sort();
  const selectedB0 = [...profile.obligations.b0Model].sort();
  if (JSON.stringify(selectedB0) !== JSON.stringify(expectedB0)) {
    failures.push(
      `b0Model obligations mismatch: profile=[${selectedB0.join(",")}] expected=[${expectedB0.join(",")}]`,
    );
  }

  const quantFormats = loadSupportedQuants(profile);
  if (!quantFormats.includes(profile.modelArtifact.quantization)) {
    failures.push(
      `profile quantization ${profile.modelArtifact.quantization} not in supported set [${quantFormats.join(",")}]`,
    );
  }

  const deviceProfile = loadMidRangeDeviceProfile();
  const maxMemoryMiB = deviceProfile.maxMemoryMiB;

  // B0 conformance
  let obligationVerdicts: OnnxAndroidCertReport["obligationVerdicts"] = [];
  const maxAttempts = Math.max(1, profile.segfaultRetry?.maxAttempts ?? 1);
  let conformanceReport:
    | Awaited<ReturnType<typeof runConformance>>
    | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      conformanceReport = await runConformance({
        registry: createModelObligationsRegistry(),
        factory: createOnnxModelAdapterHarnessFactory({
          weightsPath: fixture,
          deviceId: profile.deviceId,
          emit: (e) => events.push(e),
        }),
        subjectId: profile.subjectId,
        deviceId: profile.deviceId,
        obligationIds: [...profile.obligations.b0Model],
        emit: (e) => {
          events.push(e);
          if (e.event === "conformance.obligation") {
            emit(io, {
              outcome:
                e.outcome === "pass" ? "obligation_pass" : "obligation_fail",
              subjectId: profile.subjectId,
              deviceId: profile.deviceId,
              obligationId: e.obligationId,
            });
          }
        },
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSegfault =
        profile.segfaultRetry?.matchClasses?.some((c) =>
          msg.toLowerCase().includes(c.toLowerCase()),
        ) ?? false;
      if (!isSegfault || attempt >= maxAttempts) {
        failures.push(`conformance threw: ${msg}`);
        break;
      }
      emit(io, {
        outcome: "retry",
        subjectId: profile.subjectId,
        deviceId: profile.deviceId,
        attempt,
        reason: "native-segfault-class",
      });
    }
  }

  if (conformanceReport) {
    obligationVerdicts = conformanceReport.verdicts.map((v) => ({
      obligationId: v.obligationId,
      outcome: v.outcome,
      ...(v.message ? { message: v.message } : {}),
    }));
    if (conformanceReport.exitCode !== 0) {
      for (const v of conformanceReport.verdicts) {
        if (v.outcome !== "pass") {
          failures.push(
            `obligation ${v.obligationId} ${v.outcome}${v.message ? `: ${v.message}` : ""}`,
          );
        }
      }
    }
  }

  // B1 locality
  let localityOk = false;
  let egressAttempts = 0;
  let localityDetail: string | undefined;
  try {
    const { turn } = await withEgressRecordingTurn(
      {
        subjectId: profile.subjectId,
        deviceId: profile.deviceId,
        caller: { principalId: "onnx-android-certify", subjectScope: "*" },
        selfHostedHosts: ["school.local"],
      },
      async (api) => {
        const mock = api.mockAgent();
        mock
          ?.get("https://vendor.example")
          .intercept({ path: "/v1/infer", method: "POST" })
          .reply(200, { ok: true })
          .times(5);

        const harness = await createOnnxModelAdapterHarnessFactory({
          weightsPath: fixture,
          deviceId: profile.deviceId,
        })({ subjectId: profile.subjectId });

        return api.withPayloadClass("model-prompt", async () => {
          harness.setNetworkAllowed(false);
          await harness.model.generate(
            [{ role: "user", content: "cert.locality.generate" }],
            { deadlineMs: 5_000, maxTokens: 16 },
          );
          await harness.model.embed("cert.locality.embed");
          return true;
        });
      },
    );
    egressAttempts = turn.attempts.length;
    const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY, {
      emit: (e) => events.push(e),
    });
    localityOk = asserted.ok === true && turn.noEgress === true;
    if (!localityOk) {
      localityDetail = `egressAttempts=${egressAttempts} noEgress=${String(turn.noEgress)}`;
      failures.push(
        `locality ${profile.obligations.b1Locality.obligationId} fail: ${localityDetail}`,
      );
    }
  } catch (err) {
    localityDetail = err instanceof Error ? err.message : String(err);
    failures.push(`locality harness error: ${localityDetail}`);
  }

  // first_token floor (NFR-01)
  const firstGate = profile.benches.gates.first_token as
    | { budgetP95Ms?: number; floorP95Ms?: number }
    | undefined;
  const firstTokenBudget = firstGate?.budgetP95Ms ?? 1500;
  const firstTokenFloor = firstGate?.floorP95Ms ?? 50;
  let firstTokenMs: number | null = null;
  let firstTokenOk: boolean | null = null;
  try {
    const harness = await createOnnxModelAdapterHarnessFactory({
      weightsPath: fixture,
      deviceId: profile.deviceId,
    })({ subjectId: profile.subjectId });
    const started = performance.now();
    let got = false;
    for await (const delta of harness.model.generateStream(
      [{ role: "user", content: "cert.first_token" }],
      { deadlineMs: 5_000, maxTokens: 16 },
    )) {
      if (typeof delta === "string" && delta.length > 0) {
        firstTokenMs = performance.now() - started;
        got = true;
        break;
      }
    }
    if (!got || firstTokenMs === null) {
      firstTokenOk = false;
      failures.push("bench: first_token produced no stream delta");
    } else {
      firstTokenOk = firstTokenMs <= firstTokenFloor;
      if (!firstTokenOk) {
        failures.push(
          `bench: first_token measuredMs=${firstTokenMs.toFixed(2)} > floorP95Ms=${firstTokenFloor} (budgetP95Ms=${firstTokenBudget})`,
        );
      }
    }
  } catch (err) {
    firstTokenOk = false;
    failures.push(
      `bench: first_token probe error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Memory ceiling refuse-before-materialize
  let overBudgetRefused = false;
  let materializeOnReject = 0;
  let memoryOk = false;
  let memoryDetail: string | undefined;
  const overRel =
    profile.memoryCeiling?.overBudgetFixtureRelpath ??
    "android/fixtures/over-budget.onnx";
  const overPath = path.join(PACKAGE_ROOT, overRel);
  try {
    const rt = new OnnxSlmRuntime({
      weightsPath: overPath,
      subjectId: profile.subjectId,
      deviceId: profile.deviceId,
      maxMemoryMiB,
      preferredExecutionProvider: "nnapi",
      backend: createInProcessOnnxMobileBackend({
        onMaterialize: () => {
          materializeOnReject += 1;
        },
      }),
    });
    await rt.load();
    memoryDetail = "over-budget load unexpectedly succeeded";
    failures.push(`memory_ceiling: ${memoryDetail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    overBudgetRefused = /exceeds device ceiling/i.test(msg);
    if (!overBudgetRefused) {
      memoryDetail = msg;
      failures.push(`memory_ceiling: expected ceiling reject, got: ${msg}`);
    } else if (materializeOnReject > 0) {
      memoryDetail = `materialized ${materializeOnReject} times before reject`;
      failures.push(`memory_ceiling: ${memoryDetail}`);
    } else {
      memoryOk = true;
    }
  }

  const outcome = failures.length === 0 ? "pass" : "fail";
  const report: OnnxAndroidCertReport = {
    schemaVersion: "bindings-slm.cert-report.v1",
    recordedAt: new Date().toISOString(),
    event: "bindings_slm.certify",
    outcome,
    profileId: profile.profileId,
    adapter: profile.adapter,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    modelArtifactSha256: profile.modelArtifact.artifactSha256,
    measuredArtifactSha256: measuredSha256,
    onnxRuntimePinnedVersion: profile.modelArtifact.onnxRuntimePinnedVersion,
    supportedQuantFormats: quantFormats,
    obligationVerdicts,
    egressRecord: {
      ok: localityOk,
      attemptCount: egressAttempts,
      zeroEgressOps: [...(profile.obligations.b1Locality.zeroEgressOps ?? [])],
      obligationId: profile.obligations.b1Locality.obligationId,
      ...(localityDetail ? { detail: localityDetail } : {}),
    },
    p95Benches: {
      first_token: {
        nfrId: "NFR-01",
        measuredMs: firstTokenMs,
        budgetP95Ms: firstTokenBudget,
        floorP95Ms: firstTokenFloor,
        ok: firstTokenOk,
      },
    },
    memoryCeiling: {
      ok: memoryOk,
      maxMemoryMiB,
      overBudgetRefused,
      materializeCountOnReject: materializeOnReject,
      ...(memoryDetail ? { detail: memoryDetail } : {}),
    },
    failures: [...failures],
  };

  if (outcome === "fail") {
    for (const f of failures) {
      io.stderr.write(`CERT FAIL: ${f}\n`);
    }
  }

  emit(io, {
    outcome,
    profileId: profile.profileId,
    adapter: profile.adapter,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    failureCount: failures.length,
  });

  if (options.reportOutPath) {
    writeCertifyReportArtifact(options.reportOutPath, report as never);
    emit(io, {
      outcome: "report_written",
      subjectId: profile.subjectId,
      deviceId: profile.deviceId,
      path: options.reportOutPath,
    });
  }

  if (options.writeCommittedReport !== false) {
    const committed =
      profile.reportArtifact?.committedRelpath ??
      "android/certification/reports/android.cert.json";
    const committedAbs = path.join(PACKAGE_ROOT, committed);
    mkdirSync(path.dirname(committedAbs), { recursive: true });
    // Stable committed report: strip volatile recordedAt for greppable golden.
    const committedDoc = {
      ...report,
      recordedAt: report.recordedAt,
      committedNote:
        "In-repo certification report for ONNX mobile Android profile (B0+B1).",
    };
    writeFileSync(
      committedAbs,
      `${JSON.stringify(committedDoc, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    exitCode: outcome === "pass" ? 0 : 1,
    report,
  };
}

/**
 * CLI path when profile.adapter === "onnx".
 */
export async function runOnnxAndroidCertifyFromProfilePath(
  profilePath: string,
  io: CertifyIo,
  options: RunOnnxAndroidCertifyOptions = {},
): Promise<number> {
  const profile = loadOnnxAndroidCertProfile(profilePath);
  const { exitCode } = await runOnnxAndroidCertifyProfile(profile, io, options);
  return exitCode;
}
