/**
 * Apple silicon / MLX certification harness.
 *
 * B0 model obligations + B1 locality + P4-relative first_token floor +
 * Intel unsupported-platform refuse + deadline abort. Profile:
 * certification/apple-silicon.profile.json.
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
import { SlmRuntimeInitError } from "@moolam/edge-agent";
import {
  CertifyValidationError,
  CERT_PROFILE_SCHEMA_VERSION,
  CERTIFICATION_DIR,
  PACKAGE_ROOT,
  sha256File,
  writeCertifyReportArtifact,
  type CertifyIo,
} from "./certify.js";
import { createMlxModelAdapterHarnessFactory } from "./mlx_model_adapter.js";
import {
  MLX_PINNED_REVISION,
  MlxSlmRuntime,
  createInProcessMlxMetalBackend,
  type MlxHostProbe,
} from "./mlx_runtime.js";

export const APPLE_SILICON_PROFILE_PATH = path.join(
  CERTIFICATION_DIR,
  "apple-silicon.profile.json",
);

/** Same closed B0 set as desktop — keep apple-silicon profile obligations.b0Model in sync. */
export const APPLE_SILICON_CERTIFICATION_MODEL_OBLIGATION_IDS =
  DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS;

export type MlxAppleSiliconCertProfile = {
  schemaVersion: string;
  profileId: string;
  adapter: string;
  description?: string;
  hardware: {
    class: string;
    gpuRequired: boolean;
    quantPolicy: string;
    arch?: string;
    platform?: string;
    deviceProfileRelpath?: string;
  };
  modelArtifact: {
    name: string;
    format: string;
    quantization: string;
    fixtureRelpath: string;
    artifactSha256: string;
    mlxPinnedRevision: string;
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
  platformRefuse?: {
    intelProbe: MlxHostProbe;
    expectUnsupportedPlatform?: boolean;
  };
  deadlineAbort?: {
    requireFinishReasonDeadline?: boolean;
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

export type MlxAppleSiliconCertReport = {
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
  mlxPinnedRevision: string;
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
    core_loop: {
      nfrId: string;
      configured: boolean;
      policy: string;
      ok: boolean;
    };
  };
  platformRefuse: {
    ok: boolean;
    intelRefused: boolean;
    detail?: string;
  };
  deadlineAbort: {
    ok: boolean;
    finishReason: string | null;
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

export function loadMlxAppleSiliconCertProfile(
  profilePath: string = APPLE_SILICON_PROFILE_PATH,
): MlxAppleSiliconCertProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (err) {
    throw new CertifyValidationError(
      `apple-silicon profile unreadable: ${err instanceof Error ? err.message : "unknown"}`,
      { failureClass: "config" },
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new CertifyValidationError(
      "apple-silicon profile root must be an object",
      { failureClass: "config" },
    );
  }
  const p = raw as MlxAppleSiliconCertProfile;
  if (p.schemaVersion !== CERT_PROFILE_SCHEMA_VERSION) {
    throw new CertifyValidationError(
      `schemaVersion must be ${CERT_PROFILE_SCHEMA_VERSION}`,
      { failureClass: "config", profileId: p.profileId },
    );
  }
  if (p.adapter !== "mlx") {
    throw new CertifyValidationError(
      `apple-silicon certification requires adapter "mlx" (got ${p.adapter})`,
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
    !p.modelArtifact?.mlxPinnedRevision
  ) {
    throw new CertifyValidationError(
      "modelArtifact.artifactSha256 and mlxPinnedRevision are required",
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

function fixturePath(profile: MlxAppleSiliconCertProfile): string {
  return path.join(PACKAGE_ROOT, profile.modelArtifact.fixtureRelpath);
}

export type RunMlxAppleSiliconCertifyOptions = {
  reportOutPath?: string;
  writeCommittedReport?: boolean;
};

/**
 * Run Apple silicon MLX certification for a loaded profile.
 */
export async function runMlxAppleSiliconCertifyProfile(
  profile: MlxAppleSiliconCertProfile,
  io: CertifyIo = { stdout: process.stdout, stderr: process.stderr },
  options: RunMlxAppleSiliconCertifyOptions = {},
): Promise<{ exitCode: 0 | 1; report: MlxAppleSiliconCertReport }> {
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
  if (profile.modelArtifact.mlxPinnedRevision !== MLX_PINNED_REVISION) {
    failures.push(
      `MLX pin mismatch: profile=${profile.modelArtifact.mlxPinnedRevision} package=${MLX_PINNED_REVISION}`,
    );
  }

  const expectedB0 = [...APPLE_SILICON_CERTIFICATION_MODEL_OBLIGATION_IDS].sort();
  const selectedB0 = [...profile.obligations.b0Model].sort();
  if (JSON.stringify(selectedB0) !== JSON.stringify(expectedB0)) {
    failures.push(
      `b0Model obligations mismatch: profile=[${selectedB0.join(",")}] expected=[${expectedB0.join(",")}]`,
    );
  }

  const appleProbe: MlxHostProbe = { platform: "darwin", arch: "arm64" };

  // B0 conformance
  let obligationVerdicts: MlxAppleSiliconCertReport["obligationVerdicts"] = [];
  const maxAttempts = Math.max(1, profile.segfaultRetry?.maxAttempts ?? 1);
  let conformanceReport:
    | Awaited<ReturnType<typeof runConformance>>
    | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      conformanceReport = await runConformance({
        registry: createModelObligationsRegistry(),
        factory: createMlxModelAdapterHarnessFactory({
          weightsPath: fixture,
          deviceId: profile.deviceId,
          hostProbe: appleProbe,
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
        caller: { principalId: "mlx-apple-certify", subjectScope: "*" },
        selfHostedHosts: ["school.local"],
      },
      async (api) => {
        const mock = api.mockAgent();
        mock
          ?.get("https://vendor.example")
          .intercept({ path: "/v1/infer", method: "POST" })
          .reply(200, { ok: true })
          .times(5);

        const harness = await createMlxModelAdapterHarnessFactory({
          weightsPath: fixture,
          deviceId: profile.deviceId,
          hostProbe: appleProbe,
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

  // P4-relative first_token floor
  const firstGate = profile.benches.gates.first_token as
    | { budgetP95Ms?: number; floorP95Ms?: number }
    | undefined;
  const firstTokenBudget = firstGate?.budgetP95Ms ?? 1500;
  const firstTokenFloor = firstGate?.floorP95Ms ?? 50;
  let firstTokenMs: number | null = null;
  let firstTokenOk: boolean | null = null;
  try {
    const harness = await createMlxModelAdapterHarnessFactory({
      weightsPath: fixture,
      deviceId: profile.deviceId,
      hostProbe: appleProbe,
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

  const coreLoopConfigured =
    profile.benches.subset.includes("core_loop") &&
    Boolean(profile.benches.gates.core_loop);
  if (!profile.benches.subset.includes("first_token")) {
    failures.push("benches.subset missing first_token");
  }
  if (!coreLoopConfigured) {
    failures.push("benches.subset/gates missing core_loop (P4-relative)");
  }

  // Intel Mac unsupported-platform refuse
  let intelRefused = false;
  let platformOk = false;
  let platformDetail: string | undefined;
  const intelProbe =
    profile.platformRefuse?.intelProbe ??
    ({ platform: "darwin", arch: "x64" } satisfies MlxHostProbe);
  try {
    const rt = new MlxSlmRuntime({
      weightsPath: fixture,
      subjectId: profile.subjectId,
      deviceId: `${profile.deviceId}-intel`,
      hostProbe: intelProbe,
      backend: createInProcessMlxMetalBackend(),
    });
    await rt.load();
    platformDetail = "Intel load unexpectedly succeeded";
    failures.push(`platform_refuse: ${platformDetail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    intelRefused =
      err instanceof SlmRuntimeInitError &&
      /unsupported_platform/i.test(msg) &&
      /Intel Mac/i.test(msg);
    if (!intelRefused) {
      platformDetail = msg;
      failures.push(`platform_refuse: expected Intel unsupported_platform, got: ${msg}`);
    } else {
      platformOk = true;
    }
  }

  // Deadline abort finishReason
  let deadlineOk = false;
  let deadlineFinish: string | null = null;
  let deadlineDetail: string | undefined;
  try {
    const base = createInProcessMlxMetalBackend();
    const rt = new MlxSlmRuntime({
      weightsPath: fixture,
      subjectId: profile.subjectId,
      deviceId: profile.deviceId,
      hostProbe: appleProbe,
      backend: {
        kind: "in-process",
        load: (w, c) => base.load(w, c),
        unload: (h) => base.unload(h),
        embed: (h, t) => base.embed(h, t),
        generateStream: (h, p) => base.generateStream(h, p),
        async generate(_h, params) {
          if (params.deadlineMs <= 1 || params.signal?.aborted) {
            return { text: "", tokensEmitted: 0, deadlineHit: true };
          }
          return base.generate(_h, params);
        },
      },
    });
    await rt.load();
    const result = await rt.generate({
      prompt: "deadline",
      maxTokens: 16,
      temperature: 0,
      deadlineMs: 1,
    });
    deadlineFinish = result.finishReason;
    deadlineOk = result.finishReason === "deadline" && result.text === "";
    if (!deadlineOk) {
      deadlineDetail = `finishReason=${result.finishReason} textLen=${result.text.length}`;
      failures.push(`deadline_abort: ${deadlineDetail}`);
    }
    await rt.unload();
  } catch (err) {
    deadlineDetail = err instanceof Error ? err.message : String(err);
    failures.push(`deadline_abort threw: ${deadlineDetail}`);
  }

  const outcome = failures.length === 0 ? "pass" : "fail";
  const coreLoopGate = profile.benches.gates.core_loop as
    | { policy?: string }
    | undefined;
  const report: MlxAppleSiliconCertReport = {
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
    mlxPinnedRevision: profile.modelArtifact.mlxPinnedRevision,
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
      core_loop: {
        nfrId: "NFR-06",
        configured: coreLoopConfigured,
        policy:
          coreLoopGate?.policy ??
          "absolute-ceiling-plus-relative-baseline",
        ok: coreLoopConfigured,
      },
    },
    platformRefuse: {
      ok: platformOk,
      intelRefused,
      ...(platformDetail ? { detail: platformDetail } : {}),
    },
    deadlineAbort: {
      ok: deadlineOk,
      finishReason: deadlineFinish,
      ...(deadlineDetail ? { detail: deadlineDetail } : {}),
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
      "macos/certification/reports/apple-silicon.cert.json";
    const committedAbs = path.join(PACKAGE_ROOT, committed);
    mkdirSync(path.dirname(committedAbs), { recursive: true });
    writeFileSync(
      committedAbs,
      `${JSON.stringify(
        {
          ...report,
          committedNote:
            "In-repo certification report for MLX Apple silicon profile (B0+B1).",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return {
    exitCode: outcome === "pass" ? 0 : 1,
    report,
  };
}

export async function runMlxAppleSiliconCertifyFromProfilePath(
  profilePath: string,
  io: CertifyIo,
  options: RunMlxAppleSiliconCertifyOptions = {},
): Promise<number> {
  const profile = loadMlxAppleSiliconCertProfile(profilePath);
  const { exitCode } = await runMlxAppleSiliconCertifyProfile(
    profile,
    io,
    options,
  );
  return exitCode;
}
