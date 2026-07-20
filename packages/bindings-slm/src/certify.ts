/**
 * Unified certification harness + `bindings-slm certify` CLI entry.
 *
 * Orchestrates (deterministic order): artifact pin → B0 model obligations →
 * B1 egress locality → P4 bench subset. Accepts an adapter factory + profile
 * JSON; aggregate exit code is non-zero on any failure. Emits
 * certification.report.json (versioned) with per-check verdicts.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CERTIFICATION_CHECK_DEADLINE_MS,
  DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS,
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  createModelObligationsRegistry,
  runConformance,
  withEgressRecordingTurn,
  type ConformanceObligationEvent,
  type ConformanceRunnerEvent,
} from "@moolam/contract-conformance";
import type { SlmModelAdapterHarness } from "@moolam/edge-agent";
import { LLAMA_CPP_PINNED_REVISION } from "./gguf_metadata.js";
import { createLlamaCppModelAdapterHarnessFactory } from "./model_adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, "..");
export const CERTIFICATION_DIR = path.join(PACKAGE_ROOT, "certification");
export const DESKTOP_PROFILE_PATH = path.join(
  CERTIFICATION_DIR,
  "desktop.profile.json",
);

export const CERT_PROFILE_SCHEMA_VERSION = "bindings-slm.cert-profile.v1";

/** Versioned unified certification report (orchestration artifact). */
export const CERTIFICATION_REPORT_SCHEMA_VERSION =
  "bindings-slm.certification.report.v1";

/** Default durable report filename emitted by the unified harness. */
export const CERTIFICATION_REPORT_FILENAME = "certification.report.json";

/** Deterministic phase order for the unified certify orchestrator. */
export const CERTIFY_PHASE_ORDER = ["artifact", "b0", "b1", "p4"] as const;

export type CertifyPhaseId = (typeof CERTIFY_PHASE_ORDER)[number];

/** Profile registry schema (committed at certification/registry.json). */
export const CERT_PROFILE_REGISTRY_SCHEMA_VERSION =
  "bindings-slm.cert-profile-registry.v1";

export const CERT_PROFILE_REGISTRY_RELPATH = "registry.json";

export const CERTIFICATION_REPORT_SCHEMA_RELPATH =
  "schemas/certification.report.schema.json";

/** Canonical registry profile ids (CLI --profile). */
export const CERT_REGISTRY_PROFILE_IDS = [
  "desktop",
  "android-mid",
  "apple-silicon",
] as const;

export type CertRegistryProfileId =
  (typeof CERT_REGISTRY_PROFILE_IDS)[number];

export type CertProfileRegistryEntry = {
  id: string;
  aliases: string[];
  adapter: string;
  hardwareClass: string;
  displayName: string;
  profileRelpath: string;
  committedReportRelpath?: string;
};

export type CertProfileRegistry = {
  schemaVersion: string;
  description?: string;
  reportSchemaRelpath: string;
  reportSchemaVersion: string;
  profiles: CertProfileRegistryEntry[];
};

export type CertProfileHardware = {
  class: string;
  gpuRequired: boolean;
  quantPolicy: string;
};

export type CertProfileModelArtifact = {
  name: string;
  format: string;
  quantization: string;
  fixtureRelpath: string;
  artifactSha256: string;
  llamaCppPinnedRevision: string;
};

export type CertProfile = {
  schemaVersion: string;
  profileId: string;
  adapter: string;
  description?: string;
  hardware: CertProfileHardware;
  modelArtifact: CertProfileModelArtifact;
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
  subjectId: string;
  deviceId: string;
  segfaultRetry?: {
    maxAttempts: number;
    matchClasses: string[];
  };
  observability?: {
    event: string;
    emitContentBodies: boolean;
  };
  reportArtifact?: {
    schemaVersion: string;
    ciRelpath: string;
    contains: string[];
  };
};

export type CertifyIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

export type CertifyResult = {
  exitCode: 0 | 1;
  report: CertifyReport;
};

export type CertifyReport = {
  /** Durable CI artifact schema (uploaded by llama-cpp-desktop-cert job). */
  schemaVersion: "bindings-slm.cert-report.v1";
  recordedAt: string;
  event: "bindings_slm.certify";
  outcome: "pass" | "fail";
  profileId: string;
  adapter: string;
  subjectId: string;
  deviceId: string;
  /** Pinned model artifact hash from the profile. */
  modelArtifactSha256: string;
  /** Pinned llama.cpp revision from the profile. */
  llamaCppPinnedRevision: string;
  /** Measured hash of the on-disk fixture (must match profile). */
  measuredArtifactSha256: string;
  obligationVerdicts: Array<{
    obligationId: string;
    outcome: string;
    message?: string;
  }>;
  /** B1 locality egress record (metadata only — no utterance bodies). */
  egressRecord: {
    ok: boolean;
    attemptCount: number;
    zeroEgressOps: string[];
    obligationId: string;
    detail?: string;
  };
  /** P4 desktop p95 / first-token measurements vs budget. */
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
      budgetP95Ms: number | null;
      policy: string;
      ok: boolean;
    };
  };
  /** Full offline EdgeAgent / CognitiveCore turn under network deny. */
  offlineTurn: {
    ok: boolean;
    servedLocally: boolean;
    frictionFolded: boolean;
    syncStatus: string | null;
    turnCompletedEmitted: boolean;
    egressAttemptCount: number;
    localityOk: boolean;
    restartSurvived: boolean;
    subjectIsolationOk: boolean;
    failures: string[];
  };
  /** @deprecated Prefer egressRecord / p95Benches — retained for CERT-001 callers. */
  locality: {
    ok: boolean;
    egressAttempts: number;
    detail?: string;
  };
  benches: {
    subset: string[];
    firstTokenMs?: number;
    firstTokenBudgetP95Ms?: number;
    firstTokenOk?: boolean;
    coreLoopConfigured: boolean;
    mismatches: string[];
  };
  failures: string[];
};

/** Options for {@link runCertifyProfile}. */
export type RunCertifyProfileOptions = {
  /** When set, write the durable JSON report artifact (CI upload path). */
  reportOutPath?: string;
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

/**
 * Absolute path to the committed profile registry.
 */
export function certProfileRegistryPath(
  certificationDir: string = CERTIFICATION_DIR,
): string {
  return path.join(certificationDir, CERT_PROFILE_REGISTRY_RELPATH);
}

/**
 * Absolute path to the committed certification.report JSON Schema.
 */
export function certificationReportSchemaPath(
  certificationDir: string = CERTIFICATION_DIR,
): string {
  return path.join(certificationDir, CERTIFICATION_REPORT_SCHEMA_RELPATH);
}

/**
 * Load and validate certification/registry.json (desktop, android-mid, apple-silicon).
 */
export function loadCertProfileRegistry(
  opts: { certificationDir?: string; registryPath?: string } = {},
): CertProfileRegistry {
  const dir = opts.certificationDir ?? CERTIFICATION_DIR;
  const registryPath = opts.registryPath ?? certProfileRegistryPath(dir);
  if (!existsSync(registryPath)) {
    throw new CertifyValidationError(
      `certification profile registry missing at ${registryPath}`,
      { failureClass: "config" },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (err) {
    throw new CertifyValidationError(
      `registry unreadable: ${err instanceof Error ? err.message : "parse"}`,
      { failureClass: "config" },
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new CertifyValidationError("registry root must be an object", {
      failureClass: "config",
    });
  }
  const reg = raw as CertProfileRegistry;
  if (reg.schemaVersion !== CERT_PROFILE_REGISTRY_SCHEMA_VERSION) {
    throw new CertifyValidationError(
      `registry schemaVersion must be ${CERT_PROFILE_REGISTRY_SCHEMA_VERSION} (got ${String(reg.schemaVersion)})`,
      { failureClass: "config" },
    );
  }
  if (reg.reportSchemaVersion !== CERTIFICATION_REPORT_SCHEMA_VERSION) {
    throw new CertifyValidationError(
      `registry reportSchemaVersion must be ${CERTIFICATION_REPORT_SCHEMA_VERSION} (got ${String(reg.reportSchemaVersion)})`,
      { failureClass: "config" },
    );
  }
  if (!Array.isArray(reg.profiles) || reg.profiles.length === 0) {
    throw new CertifyValidationError("registry.profiles must be non-empty", {
      failureClass: "config",
    });
  }

  const ids = new Set<string>();
  for (const p of reg.profiles) {
    if (!p.id?.trim() || !p.adapter?.trim() || !p.profileRelpath?.trim()) {
      throw new CertifyValidationError(
        "registry profile requires id, adapter, profileRelpath",
        { failureClass: "config", profileId: p.id },
      );
    }
    const key = p.id.trim().toLowerCase();
    if (ids.has(key)) {
      throw new CertifyValidationError(`duplicate registry profile id ${p.id}`, {
        failureClass: "config",
        profileId: p.id,
      });
    }
    ids.add(key);
    for (const alias of p.aliases ?? []) {
      const a = alias.trim().toLowerCase();
      if (!a) continue;
      if (ids.has(a)) {
        throw new CertifyValidationError(
          `duplicate registry alias ${alias} (conflicts with id/alias)`,
          { failureClass: "config", profileId: p.id },
        );
      }
      ids.add(a);
    }
    const abs = path.join(dir, p.profileRelpath);
    if (!existsSync(abs)) {
      throw new CertifyValidationError(
        `registry profile ${p.id} missing file ${abs}`,
        { failureClass: "config", profileId: p.id },
      );
    }
  }

  for (const required of CERT_REGISTRY_PROFILE_IDS) {
    if (![...reg.profiles].some((p) => p.id === required)) {
      throw new CertifyValidationError(
        `registry missing required profile id "${required}"`,
        { failureClass: "config", profileId: required },
      );
    }
  }

  const schemaAbs = path.join(
    dir,
    reg.reportSchemaRelpath || CERTIFICATION_REPORT_SCHEMA_RELPATH,
  );
  if (!existsSync(schemaAbs)) {
    throw new CertifyValidationError(
      `certification report schema missing at ${schemaAbs}`,
      { failureClass: "config" },
    );
  }

  return reg;
}

/**
 * Look up a registry entry by id or alias (e.g. android → android-mid).
 */
export function lookupCertProfileRegistryEntry(
  profileId: string,
  opts: { certificationDir?: string; registry?: CertProfileRegistry } = {},
): CertProfileRegistryEntry {
  const id = profileId.trim().toLowerCase();
  if (!id) {
    throw new CertifyValidationError("profile id is required", {
      failureClass: "config",
    });
  }
  const registry =
    opts.registry ??
    loadCertProfileRegistry({
      ...(opts.certificationDir !== undefined
        ? { certificationDir: opts.certificationDir }
        : {}),
    });
  for (const entry of registry.profiles) {
    if (entry.id.toLowerCase() === id) return entry;
    if ((entry.aliases ?? []).some((a) => a.toLowerCase() === id)) return entry;
  }
  const known = registry.profiles
    .flatMap((p) => [p.id, ...(p.aliases ?? [])])
    .join(", ");
  throw new CertifyValidationError(
    `unknown certification profile "${profileId}" (registry: ${known})`,
    { failureClass: "config", profileId: id },
  );
}

/**
 * Resolve a named profile to an absolute path via the profile registry
 * (falls back to certification/<id>.profile.json for forward-compat).
 */
export function resolveProfilePath(
  profileId: string,
  opts: { certificationDir?: string } = {},
): string {
  const id = profileId.trim().toLowerCase();
  if (!id) {
    throw new CertifyValidationError("profile id is required", {
      failureClass: "config",
    });
  }
  const dir = opts.certificationDir ?? CERTIFICATION_DIR;
  const registryPath = certProfileRegistryPath(dir);
  if (existsSync(registryPath)) {
    const entry = lookupCertProfileRegistryEntry(id, {
      certificationDir: dir,
    });
    return path.join(dir, entry.profileRelpath);
  }
  const candidate = path.join(dir, `${id}.profile.json`);
  if (!existsSync(candidate)) {
    throw new CertifyValidationError(
      `unknown certification profile "${profileId}" (expected ${candidate})`,
      { failureClass: "config", profileId: id },
    );
  }
  return candidate;
}

/**
 * Structural validation of a certification.report.json document against the
 * committed schema contract (adapter, model hash, verdicts, egress, p95).
 * Returns DIFF strings; empty array means valid. Never requires utterance bodies.
 */
export function validateCertificationReport(
  report: unknown,
  opts: { schemaPath?: string } = {},
): string[] {
  const diffs: string[] = [];
  const schemaPath = opts.schemaPath ?? certificationReportSchemaPath();
  if (!existsSync(schemaPath)) {
    return [`report schema missing at ${schemaPath}`];
  }
  // Confirm schema file is parseable (version pin checked against const).
  try {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties?: { schemaVersion?: { const?: string } };
    };
    const schemaConst = schema.properties?.schemaVersion?.const;
    if (
      schemaConst &&
      schemaConst !== CERTIFICATION_REPORT_SCHEMA_VERSION
    ) {
      diffs.push(
        `schema file const ${schemaConst} != package ${CERTIFICATION_REPORT_SCHEMA_VERSION}`,
      );
    }
  } catch (err) {
    return [
      `report schema unreadable: ${err instanceof Error ? err.message : "parse"}`,
    ];
  }

  if (!report || typeof report !== "object") {
    return ["report root must be an object"];
  }
  const r = report as Record<string, unknown>;

  const requireString = (key: string): void => {
    const v = r[key];
    if (typeof v !== "string" || !v.trim()) {
      diffs.push(`missing/invalid string field: ${key}`);
    }
  };

  if (r.schemaVersion !== CERTIFICATION_REPORT_SCHEMA_VERSION) {
    diffs.push(
      `schemaVersion DIFF: got ${String(r.schemaVersion)} want ${CERTIFICATION_REPORT_SCHEMA_VERSION}`,
    );
  }
  if (r.event !== "bindings_slm.certify") {
    diffs.push(`event DIFF: got ${String(r.event)} want bindings_slm.certify`);
  }
  if (r.outcome !== "pass" && r.outcome !== "fail") {
    diffs.push(`outcome DIFF: got ${String(r.outcome)} want pass|fail`);
  }
  for (const key of [
    "recordedAt",
    "profileId",
    "adapter",
    "subjectId",
    "deviceId",
    "modelArtifactSha256",
  ]) {
    requireString(key);
  }
  if (
    typeof r.measuredArtifactSha256 !== "string"
  ) {
    diffs.push("missing/invalid string field: measuredArtifactSha256");
  }
  if (
    typeof r.modelArtifactSha256 === "string" &&
    r.modelArtifactSha256.length > 0 &&
    !/^[a-fA-F0-9]{64}$/.test(r.modelArtifactSha256)
  ) {
    diffs.push(
      `modelArtifactSha256 DIFF: expected 64-hex, got len=${r.modelArtifactSha256.length}`,
    );
  }
  if (!Array.isArray(r.obligationVerdicts)) {
    diffs.push("obligationVerdicts must be an array");
  } else {
    for (const [i, v] of r.obligationVerdicts.entries()) {
      if (!v || typeof v !== "object") {
        diffs.push(`obligationVerdicts[${i}] must be an object`);
        continue;
      }
      const row = v as Record<string, unknown>;
      if (typeof row.obligationId !== "string" || !row.obligationId.trim()) {
        diffs.push(`obligationVerdicts[${i}].obligationId missing`);
      }
      if (typeof row.outcome !== "string" || !row.outcome.trim()) {
        diffs.push(`obligationVerdicts[${i}].outcome missing`);
      }
    }
  }
  if (!r.egressRecord || typeof r.egressRecord !== "object") {
    diffs.push("egressRecord missing");
  } else {
    const e = r.egressRecord as Record<string, unknown>;
    if (typeof e.ok !== "boolean") diffs.push("egressRecord.ok must be boolean");
    if (typeof e.attemptCount !== "number" || e.attemptCount < 0) {
      diffs.push("egressRecord.attemptCount must be a non-negative number");
    }
    if (!Array.isArray(e.zeroEgressOps)) {
      diffs.push("egressRecord.zeroEgressOps must be an array");
    }
    if (typeof e.obligationId !== "string" || !e.obligationId.trim()) {
      diffs.push("egressRecord.obligationId missing");
    }
  }
  if (!r.p95Benches || typeof r.p95Benches !== "object") {
    diffs.push("p95Benches missing");
  } else {
    const p = r.p95Benches as Record<string, unknown>;
    if (!p.first_token || typeof p.first_token !== "object") {
      diffs.push("p95Benches.first_token missing");
    }
    if (!p.core_loop || typeof p.core_loop !== "object") {
      diffs.push("p95Benches.core_loop missing");
    }
  }
  if (!Array.isArray(r.failures)) {
    diffs.push("failures must be an array");
  }

  // Sovereignty: report must not embed obvious content-body keys.
  for (const banned of ["prompt", "utterance", "contentBody", "rawText"]) {
    if (banned in r) {
      diffs.push(`sovereignty: report must not include field ${banned}`);
    }
  }

  return diffs;
}

/**
 * Validate and throw {@link CertifyValidationError} with DIFF detail on failure.
 */
export function assertCertificationReportValid(
  report: unknown,
  opts: { schemaPath?: string; profileId?: string } = {},
): void {
  const diffs = validateCertificationReport(report, {
    ...(opts.schemaPath !== undefined ? { schemaPath: opts.schemaPath } : {}),
  });
  if (diffs.length > 0) {
    throw new CertifyValidationError(
      `certification report schema breach: ${diffs.join("; ")}`,
      { failureClass: "config", ...(opts.profileId ? { profileId: opts.profileId } : {}) },
    );
  }
}

export class CertifyValidationError extends Error {
  readonly failureClass: "config" | "hash_mismatch" | "obligation" | "locality" | "bench";
  readonly profileId?: string;

  constructor(
    message: string,
    opts: {
      failureClass: CertifyValidationError["failureClass"];
      profileId?: string;
    },
  ) {
    super(message);
    this.name = "CertifyValidationError";
    this.failureClass = opts.failureClass;
    if (opts.profileId !== undefined) this.profileId = opts.profileId;
  }
}

/**
 * Load and validate a desktop certification profile JSON.
 */
export function loadCertProfile(profilePath: string): CertProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (err) {
    throw new CertifyValidationError(
      `profile unreadable/invalid JSON: ${err instanceof Error ? err.message : "unknown"}`,
      { failureClass: "config" },
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new CertifyValidationError("profile root must be an object", {
      failureClass: "config",
    });
  }
  const p = raw as CertProfile;
  if (p.schemaVersion !== CERT_PROFILE_SCHEMA_VERSION) {
    throw new CertifyValidationError(
      `schemaVersion must be ${CERT_PROFILE_SCHEMA_VERSION} (got ${String(p.schemaVersion)})`,
      { failureClass: "config", profileId: p.profileId },
    );
  }
  if (!p.profileId?.trim() || !p.adapter?.trim()) {
    throw new CertifyValidationError("profileId and adapter are required", {
      failureClass: "config",
    });
  }
  if (!p.subjectId?.trim() || !p.deviceId?.trim()) {
    throw new CertifyValidationError(
      "subjectId and deviceId are required (subject isolation)",
      { failureClass: "config", profileId: p.profileId },
    );
  }
  if (!p.modelArtifact?.artifactSha256 || !p.modelArtifact?.llamaCppPinnedRevision) {
    throw new CertifyValidationError(
      "modelArtifact.artifactSha256 and llamaCppPinnedRevision are required",
      { failureClass: "config", profileId: p.profileId },
    );
  }
  if (!Array.isArray(p.obligations?.b0Model) || p.obligations.b0Model.length === 0) {
    throw new CertifyValidationError("obligations.b0Model must be a non-empty array", {
      failureClass: "config",
      profileId: p.profileId,
    });
  }
  if (!Array.isArray(p.benches?.subset) || p.benches.subset.length === 0) {
    throw new CertifyValidationError("benches.subset must be a non-empty array", {
      failureClass: "config",
      profileId: p.profileId,
    });
  }
  return p;
}

export function sha256File(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureAbsolutePath(profile: CertProfile): string {
  return path.join(PACKAGE_ROOT, profile.modelArtifact.fixtureRelpath);
}

function assertPinnedHashes(profile: CertProfile): {
  measuredSha256: string;
  mismatches: string[];
} {
  const fixturePath = fixtureAbsolutePath(profile);
  if (!existsSync(fixturePath)) {
    throw new CertifyValidationError(
      `model fixture missing at ${fixturePath}`,
      { failureClass: "config", profileId: profile.profileId },
    );
  }
  const measuredSha256 = sha256File(fixturePath);
  const mismatches: string[] = [];
  if (measuredSha256 !== profile.modelArtifact.artifactSha256.toLowerCase()) {
    mismatches.push(
      `artifact hash mismatch: profile=${profile.modelArtifact.artifactSha256} measured=${measuredSha256}`,
    );
  }
  if (
    profile.modelArtifact.llamaCppPinnedRevision !== LLAMA_CPP_PINNED_REVISION
  ) {
    mismatches.push(
      `llama.cpp revision mismatch: profile=${profile.modelArtifact.llamaCppPinnedRevision} package=${LLAMA_CPP_PINNED_REVISION}`,
    );
  }
  // Package pin must match DESKTOP profile declaration (invariant).
  if (profile.modelArtifact.llamaCppPinnedRevision !== "b5750") {
    mismatches.push(
      `unexpected llama.cpp pin ${profile.modelArtifact.llamaCppPinnedRevision}`,
    );
  }
  return { measuredSha256, mismatches };
}

function assertB0Selection(profile: CertProfile): string[] {
  const failures: string[] = [];
  const expected = [...DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS].sort();
  const selected = [...profile.obligations.b0Model].sort();
  if (JSON.stringify(selected) !== JSON.stringify(expected)) {
    failures.push(
      `b0Model obligations mismatch: profile=[${selected.join(",")}] expected=[${expected.join(",")}] (DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS)`,
    );
  }
  return failures;
}

/**
 * Persist the certification JSON report for CI artifact upload.
 * Creates parent directories. Never writes utterance content.
 */
export function writeCertifyReportArtifact(
  reportOutPath: string,
  report: CertifyReport | UnifiedCertificationReport,
): void {
  // Unified certification.report.v1 — enforce committed schema before write.
  if (
    report &&
    typeof report === "object" &&
    "schemaVersion" in report &&
    report.schemaVersion === CERTIFICATION_REPORT_SCHEMA_VERSION
  ) {
    assertCertificationReportValid(report, {
      profileId: (report as UnifiedCertificationReport).profileId,
    });
  }
  const abs = path.resolve(reportOutPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** Default path: packages/bindings-slm/certification/reports/certification.report.json */
export function defaultCertificationReportPath(
  packageRoot: string = PACKAGE_ROOT,
): string {
  return path.join(
    packageRoot,
    "certification",
    "reports",
    CERTIFICATION_REPORT_FILENAME,
  );
}

/**
 * Profile fields required by the unified orchestrator (adapter-agnostic).
 */
export type UnifiedCertProfileInput = {
  profileId: string;
  adapter: string;
  subjectId: string;
  deviceId: string;
  modelArtifact: {
    fixtureRelpath: string;
    artifactSha256: string;
  };
  obligations: CertProfile["obligations"];
  benches: CertProfile["benches"];
};

/**
 * Fresh ModelInterface harness factory — one instance per obligation / phase.
 * Must not share mutable state across invocations (subject isolation).
 */
export type CertifyAdapterFactory = (ctx?: {
  subjectId?: string;
}) => Promise<SlmModelAdapterHarness>;

export type UnifiedCertPhaseResult = {
  phase: CertifyPhaseId;
  ok: boolean;
  detail?: string;
  durationMs: number;
};

export type UnifiedCertificationReport = {
  schemaVersion: typeof CERTIFICATION_REPORT_SCHEMA_VERSION;
  recordedAt: string;
  event: "bindings_slm.certify";
  outcome: "pass" | "fail";
  profileId: string;
  adapter: string;
  subjectId: string;
  deviceId: string;
  modelArtifactSha256: string;
  measuredArtifactSha256: string;
  deadlineMs: number;
  phaseOrder: CertifyPhaseId[];
  phases: UnifiedCertPhaseResult[];
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
  failures: string[];
};

export type RunUnifiedCertifyOptions = {
  profile: UnifiedCertProfileInput;
  factory: CertifyAdapterFactory;
  io?: CertifyIo;
  /** Defaults to {@link defaultCertificationReportPath}. */
  reportOutPath?: string;
  /** Per-check deadline; defaults to CERTIFICATION_CHECK_DEADLINE_MS. */
  deadlineMs?: number;
  packageRoot?: string;
  /** When false, skip writing certification.report.json (tests). */
  writeReport?: boolean;
};

/**
 * Unified certify orchestrator: load profile fields + adapter factory, then
 * run artifact → B0 → B1 → P4 in order. Aggregate exit 1 on any failure.
 * Always emits DIFF lines on stderr for breaches.
 */
export async function runUnifiedCertifyOrchestration(
  options: RunUnifiedCertifyOptions,
): Promise<{ exitCode: 0 | 1; report: UnifiedCertificationReport }> {
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const deadlineMs = options.deadlineMs ?? CERTIFICATION_CHECK_DEADLINE_MS;
  const profile = options.profile;
  const failures: string[] = [];
  const phases: UnifiedCertPhaseResult[] = [];
  const events: Array<
    ConformanceObligationEvent | ConformanceRunnerEvent | Record<string, unknown>
  > = [];

  if (!profile.subjectId?.trim() || !profile.deviceId?.trim()) {
    throw new CertifyValidationError(
      "subjectId and deviceId are required (subject isolation)",
      { failureClass: "config", profileId: profile.profileId },
    );
  }
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new CertifyValidationError("deadlineMs must be a positive number", {
      failureClass: "config",
      profileId: profile.profileId,
    });
  }

  emit(io, {
    outcome: "start",
    profileId: profile.profileId,
    adapter: profile.adapter,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    phaseOrder: [...CERTIFY_PHASE_ORDER],
    deadlineMs,
  });

  // --- phase: artifact (fail fast before obligation loop) ---
  const artifactStarted = performance.now();
  const fixturePath = path.join(
    packageRoot,
    profile.modelArtifact.fixtureRelpath,
  );
  let measuredSha256 = "";
  if (!existsSync(fixturePath)) {
    const detail = `missing-artifact: model fixture missing at ${fixturePath}`;
    failures.push(detail);
    phases.push({
      phase: "artifact",
      ok: false,
      detail,
      durationMs: performance.now() - artifactStarted,
    });
    io.stderr.write(`CERT FAIL: ${detail}\n`);
    emit(io, {
      outcome: "phase_fail",
      phase: "artifact",
      subjectId: profile.subjectId,
      deviceId: profile.deviceId,
      detail,
    });
    const report = buildUnifiedReport({
      profile,
      measuredSha256: "",
      deadlineMs,
      phases,
      obligationVerdicts: [],
      egressRecord: {
        ok: false,
        attemptCount: 0,
        zeroEgressOps: [...(profile.obligations.b1Locality.zeroEgressOps ?? [])],
        obligationId: profile.obligations.b1Locality.obligationId,
        detail: "skipped: missing artifact",
      },
      p95Benches: emptyP95Benches(profile),
      failures,
    });
    return finalizeUnified(io, report, options);
  }

  measuredSha256 = sha256File(fixturePath);
  if (
    measuredSha256 !== profile.modelArtifact.artifactSha256.toLowerCase()
  ) {
    const detail = `artifact hash mismatch: profile=${profile.modelArtifact.artifactSha256} measured=${measuredSha256}`;
    failures.push(detail);
    phases.push({
      phase: "artifact",
      ok: false,
      detail,
      durationMs: performance.now() - artifactStarted,
    });
    io.stderr.write(`CERT FAIL: ${detail}\n`);
  } else {
    phases.push({
      phase: "artifact",
      ok: true,
      durationMs: performance.now() - artifactStarted,
    });
    emit(io, {
      outcome: "phase_pass",
      phase: "artifact",
      subjectId: profile.subjectId,
      deviceId: profile.deviceId,
    });
  }

  // --- phase: b0 ---
  const b0Started = performance.now();
  let obligationVerdicts: UnifiedCertificationReport["obligationVerdicts"] = [];
  if (failures.some((f) => f.startsWith("missing-artifact:"))) {
    phases.push({
      phase: "b0",
      ok: false,
      detail: "skipped: missing artifact",
      durationMs: 0,
    });
  } else {
    try {
      const conformanceReport = await runConformance({
        registry: createModelObligationsRegistry(),
        factory: options.factory,
        subjectId: profile.subjectId,
        deviceId: profile.deviceId,
        obligationIds: [...profile.obligations.b0Model],
        deadlineMs,
        emit: (e) => {
          events.push(e);
          if (e.event === "conformance.obligation") {
            emit(io, {
              outcome:
                e.outcome === "pass" ? "obligation_pass" : "obligation_fail",
              subjectId: profile.subjectId,
              deviceId: profile.deviceId,
              obligationId: e.obligationId,
              phase: "b0",
            });
          }
        },
      });
      obligationVerdicts = conformanceReport.verdicts.map((v) => ({
        obligationId: v.obligationId,
        outcome: v.outcome,
        ...(v.message ? { message: v.message } : {}),
      }));
      if (conformanceReport.exitCode !== 0) {
        for (const v of conformanceReport.verdicts) {
          if (v.outcome !== "pass") {
            const detail = `obligation ${v.obligationId} ${v.outcome}${v.message ? `: ${v.message}` : ""}`;
            failures.push(detail);
            io.stderr.write(`CERT FAIL: ${detail}\n`);
          }
        }
      }
      phases.push({
        phase: "b0",
        ok: conformanceReport.exitCode === 0,
        durationMs: performance.now() - b0Started,
      });
      emit(io, {
        outcome: conformanceReport.exitCode === 0 ? "phase_pass" : "phase_fail",
        phase: "b0",
        subjectId: profile.subjectId,
        deviceId: profile.deviceId,
      });
    } catch (err) {
      const detail = `conformance threw: ${err instanceof Error ? err.message : String(err)}`;
      failures.push(detail);
      io.stderr.write(`CERT FAIL: ${detail}\n`);
      phases.push({
        phase: "b0",
        ok: false,
        detail,
        durationMs: performance.now() - b0Started,
      });
    }
  }

  // --- phase: b1 ---
  const b1Started = performance.now();
  let localityOk = false;
  let egressAttempts = 0;
  let localityDetail: string | undefined;
  try {
    const { turn } = await withEgressRecordingTurn(
      {
        subjectId: profile.subjectId,
        deviceId: profile.deviceId,
        caller: { principalId: "bindings-slm-certify", subjectScope: "*" },
        selfHostedHosts: ["school.local"],
      },
      async (api) => {
        api
          .mockAgent()
          ?.get("https://vendor.example")
          .intercept({ path: "/v1/infer", method: "POST" })
          .reply(200, { ok: true })
          .times(5);

        const harness = await options.factory({
          subjectId: profile.subjectId,
        });

        return api.withPayloadClass("model-prompt", async () => {
          harness.setNetworkAllowed(false);
          await harness.model.generate(
            [{ role: "user", content: "cert.locality.generate" }],
            { deadlineMs, maxTokens: 16 },
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
      const detail = `locality ${profile.obligations.b1Locality.obligationId} fail: ${localityDetail}`;
      failures.push(detail);
      io.stderr.write(`CERT FAIL: ${detail}\n`);
    }
  } catch (err) {
    localityDetail = err instanceof Error ? err.message : String(err);
    const detail = `locality harness error: ${localityDetail}`;
    failures.push(detail);
    io.stderr.write(`CERT FAIL: ${detail}\n`);
  }
  phases.push({
    phase: "b1",
    ok: localityOk,
    ...(localityDetail ? { detail: localityDetail } : {}),
    durationMs: performance.now() - b1Started,
  });
  emit(io, {
    outcome: localityOk ? "phase_pass" : "phase_fail",
    phase: "b1",
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
  });

  // --- phase: p4 ---
  const p4Started = performance.now();
  const firstGate = profile.benches.gates.first_token as
    | { budgetP95Ms?: number; floorP95Ms?: number }
    | undefined;
  const firstTokenBudget = firstGate?.budgetP95Ms ?? 1500;
  const firstTokenFloor = firstGate?.floorP95Ms ?? 50;
  let firstTokenMs: number | null = null;
  let firstTokenOk: boolean | null = null;
  const benchMismatches: string[] = [];

  if (!profile.benches.subset.includes("core_loop")) {
    benchMismatches.push("benches.subset missing core_loop");
  }
  if (!profile.benches.subset.includes("first_token")) {
    benchMismatches.push("benches.subset missing first_token");
  }
  const coreLoopConfigured = Boolean(profile.benches.gates.core_loop);
  if (!coreLoopConfigured) {
    benchMismatches.push("benches.gates.core_loop missing");
  }

  try {
    const harness = await options.factory({ subjectId: profile.subjectId });
    const started = performance.now();
    let gotDelta = false;
    for await (const delta of harness.model.generateStream(
      [{ role: "user", content: "cert.first_token" }],
      { deadlineMs, maxTokens: 16 },
    )) {
      if (typeof delta === "string" && delta.length > 0) {
        firstTokenMs = performance.now() - started;
        gotDelta = true;
        break;
      }
    }
    if (!gotDelta || firstTokenMs === null) {
      benchMismatches.push("first_token: no stream delta emitted");
      firstTokenOk = false;
    } else {
      firstTokenOk = firstTokenMs <= firstTokenFloor;
      if (!firstTokenOk) {
        benchMismatches.push(
          `first_token measured ${firstTokenMs.toFixed(3)}ms > floor ${firstTokenFloor}ms (budget ${firstTokenBudget}ms)`,
        );
      }
    }
  } catch (err) {
    benchMismatches.push(
      `first_token probe error: ${err instanceof Error ? err.message : String(err)}`,
    );
    firstTokenOk = false;
  }

  for (const m of benchMismatches) {
    failures.push(`bench: ${m}`);
    io.stderr.write(`CERT FAIL: bench: ${m}\n`);
  }
  const p4Ok = benchMismatches.length === 0;
  phases.push({
    phase: "p4",
    ok: p4Ok,
    durationMs: performance.now() - p4Started,
  });
  emit(io, {
    outcome: p4Ok ? "phase_pass" : "phase_fail",
    phase: "p4",
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
  });

  const report = buildUnifiedReport({
    profile,
    measuredSha256,
    deadlineMs,
    phases,
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
        policy: String(
          (profile.benches.gates.core_loop as { policy?: string } | undefined)
            ?.policy ?? "absolute-ceiling-plus-relative-baseline",
        ),
        ok: coreLoopConfigured && profile.benches.subset.includes("core_loop"),
      },
    },
    failures,
  });

  return finalizeUnified(io, report, options);
}

function emptyP95Benches(
  profile: UnifiedCertProfileInput,
): UnifiedCertificationReport["p95Benches"] {
  const firstGate = profile.benches.gates.first_token as
    | { budgetP95Ms?: number; floorP95Ms?: number }
    | undefined;
  return {
    first_token: {
      nfrId: "NFR-01",
      measuredMs: null,
      budgetP95Ms: firstGate?.budgetP95Ms ?? 1500,
      floorP95Ms: firstGate?.floorP95Ms ?? 50,
      ok: null,
    },
    core_loop: {
      nfrId: "NFR-06",
      configured: Boolean(profile.benches.gates.core_loop),
      policy: "absolute-ceiling-plus-relative-baseline",
      ok: false,
    },
  };
}

function buildUnifiedReport(input: {
  profile: UnifiedCertProfileInput;
  measuredSha256: string;
  deadlineMs: number;
  phases: UnifiedCertPhaseResult[];
  obligationVerdicts: UnifiedCertificationReport["obligationVerdicts"];
  egressRecord: UnifiedCertificationReport["egressRecord"];
  p95Benches: UnifiedCertificationReport["p95Benches"];
  failures: string[];
}): UnifiedCertificationReport {
  return {
    schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    event: "bindings_slm.certify",
    outcome: input.failures.length === 0 ? "pass" : "fail",
    profileId: input.profile.profileId,
    adapter: input.profile.adapter,
    subjectId: input.profile.subjectId,
    deviceId: input.profile.deviceId,
    modelArtifactSha256: input.profile.modelArtifact.artifactSha256,
    measuredArtifactSha256: input.measuredSha256,
    deadlineMs: input.deadlineMs,
    phaseOrder: [...CERTIFY_PHASE_ORDER],
    phases: input.phases,
    obligationVerdicts: input.obligationVerdicts,
    egressRecord: input.egressRecord,
    p95Benches: input.p95Benches,
    failures: [...input.failures],
  };
}

function finalizeUnified(
  io: CertifyIo,
  report: UnifiedCertificationReport,
  options: RunUnifiedCertifyOptions,
): { exitCode: 0 | 1; report: UnifiedCertificationReport } {
  emit(io, {
    outcome: report.outcome,
    profileId: report.profileId,
    adapter: report.adapter,
    subjectId: report.subjectId,
    deviceId: report.deviceId,
    failureCount: report.failures.length,
  });
  io.stdout.write(`${JSON.stringify({ report })}\n`);

  if (options.writeReport !== false) {
    const out =
      options.reportOutPath?.trim() ||
      defaultCertificationReportPath(options.packageRoot);
    try {
      writeCertifyReportArtifact(out, report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr.write(`CERT FAIL: ${msg}\n`);
      emit(io, {
        outcome: "fail",
        subjectId: report.subjectId,
        deviceId: report.deviceId,
        failureClass: "config",
        detail: msg,
      });
      return {
        exitCode: 1,
        report: {
          ...report,
          outcome: "fail",
          failures: [...report.failures, msg],
        },
      };
    }
    emit(io, {
      outcome: "report_written",
      subjectId: report.subjectId,
      deviceId: report.deviceId,
      reportOutPath: path.resolve(out),
      reportFile: CERTIFICATION_REPORT_FILENAME,
      schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION,
    });
  }

  return { exitCode: report.outcome === "pass" ? 0 : 1, report };
}

/**
 * Map a loaded desktop CertProfile into the unified orchestrator input.
 */
export function toUnifiedCertProfileInput(
  profile: CertProfile,
): UnifiedCertProfileInput {
  return {
    profileId: profile.profileId,
    adapter: profile.adapter,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    modelArtifact: {
      fixtureRelpath: profile.modelArtifact.fixtureRelpath,
      artifactSha256: profile.modelArtifact.artifactSha256,
    },
    obligations: profile.obligations,
    benches: profile.benches,
  };
}

function readCoreLoopBudgetP95Ms(): number | null {
  try {
    const thresholdsPath = path.resolve(
      PACKAGE_ROOT,
      "../../benchmarks/gates/thresholds.json",
    );
    if (!existsSync(thresholdsPath)) return null;
    const doc = JSON.parse(readFileSync(thresholdsPath, "utf8")) as {
      benches?: { core_loop?: { p95Ms?: number } };
    };
    const v = doc.benches?.core_loop?.p95Ms;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Run desktop certification for a loaded profile.
 * Delegates B0 + B1 + P4 to {@link runUnifiedCertifyOrchestration}, then proves
 * the offline EdgeAgent turn (desktop-specific).
 */
export async function runCertifyProfile(
  profile: CertProfile,
  io: CertifyIo = { stdout: process.stdout, stderr: process.stderr },
  options: RunCertifyProfileOptions = {},
): Promise<CertifyResult> {
  const failures: string[] = [];

  emit(io, {
    outcome: "start",
    profileId: profile.profileId,
    adapter: profile.adapter,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
  });

  const hashCheck = assertPinnedHashes(profile);
  failures.push(...hashCheck.mismatches.map((m) => `hash: ${m}`));
  failures.push(...assertB0Selection(profile));
  for (const f of failures) {
    io.stderr.write(`CERT FAIL: ${f}\n`);
  }

  const fixturePath = fixtureAbsolutePath(profile);
  const factory = createLlamaCppModelAdapterHarnessFactory({
    weightsPath: fixturePath,
    deviceId: profile.deviceId,
  });

  const unified = await runUnifiedCertifyOrchestration({
    profile: toUnifiedCertProfileInput(profile),
    factory,
    io,
    deadlineMs: CERTIFICATION_CHECK_DEADLINE_MS,
    // When writing to an explicit reportOutPath, skip the default committed report
    // so prove/concurrent harnesses cannot clobber certification/reports/.
    writeReport: !options.reportOutPath?.trim(),
  });
  // Unified already printed CERT FAIL DIFF lines for its failures.
  failures.push(...unified.report.failures);

  const firstTokenMs = unified.report.p95Benches.first_token.measuredMs;
  const firstTokenOk = unified.report.p95Benches.first_token.ok;
  const firstTokenBudget = unified.report.p95Benches.first_token.budgetP95Ms;
  const localityOk = unified.report.egressRecord.ok;
  const egressAttempts = unified.report.egressRecord.attemptCount;
  const localityDetail = unified.report.egressRecord.detail;
  const obligationVerdicts = unified.report.obligationVerdicts;
  const coreLoopBudget = readCoreLoopBudgetP95Ms();
  const coreLoopConfigured = unified.report.p95Benches.core_loop.configured;
  const coreLoopOk = unified.report.p95Benches.core_loop.ok;
  const benchMismatches = unified.report.failures
    .filter((f) => f.startsWith("bench:"))
    .map((f) => f.replace(/^bench:\s*/, ""));

  // Full offline EdgeAgent / CognitiveCore turn (network denied).
  const { proveLlamaCppOfflineDesktopTurn } = await import(
    "./offline_turn_proof.js"
  );
  const offlineProof = await proveLlamaCppOfflineDesktopTurn({
    profile,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    onTelemetry: (e) => {
      emit(io, {
        outcome: e.outcome,
        subjectId: e.subjectId,
        deviceId: e.deviceId,
        ...(e.detail ? { detail: e.detail } : {}),
      });
    },
  });
  if (!offlineProof.ok) {
    for (const f of offlineProof.failures) {
      failures.push(`offline_turn: ${f}`);
      io.stderr.write(`CERT FAIL: offline_turn: ${f}\n`);
    }
  }

  const uniqueFailures = [...new Set(failures)];
  const outcome = uniqueFailures.length === 0 ? "pass" : "fail";
  const report: CertifyReport = {
    schemaVersion: "bindings-slm.cert-report.v1",
    recordedAt: new Date().toISOString(),
    event: "bindings_slm.certify",
    outcome,
    profileId: profile.profileId,
    adapter: profile.adapter,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    modelArtifactSha256: profile.modelArtifact.artifactSha256,
    llamaCppPinnedRevision: profile.modelArtifact.llamaCppPinnedRevision,
    measuredArtifactSha256:
      unified.report.measuredArtifactSha256 || hashCheck.measuredSha256,
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
        floorP95Ms: unified.report.p95Benches.first_token.floorP95Ms,
        ok: firstTokenOk,
      },
      core_loop: {
        nfrId: "NFR-06",
        configured: coreLoopConfigured,
        budgetP95Ms: coreLoopBudget,
        policy: unified.report.p95Benches.core_loop.policy,
        ok: coreLoopOk,
      },
    },
    offlineTurn: {
      ok: offlineProof.ok,
      servedLocally: offlineProof.servedLocally,
      frictionFolded: offlineProof.frictionFolded,
      syncStatus: offlineProof.syncStatus,
      turnCompletedEmitted: offlineProof.turnCompletedEmitted,
      egressAttemptCount: offlineProof.egressAttemptCount,
      localityOk: offlineProof.localityOk,
      restartSurvived: offlineProof.restartSurvived,
      subjectIsolationOk: offlineProof.subjectIsolationOk,
      failures: [...offlineProof.failures],
    },
    locality: {
      ok: localityOk,
      egressAttempts,
      ...(localityDetail ? { detail: localityDetail } : {}),
    },
    benches: {
      subset: [...profile.benches.subset],
      ...(firstTokenMs !== null ? { firstTokenMs } : {}),
      firstTokenBudgetP95Ms: firstTokenBudget,
      ...(firstTokenOk !== null ? { firstTokenOk } : {}),
      coreLoopConfigured,
      mismatches: benchMismatches,
    },
    failures: uniqueFailures,
  };

  emit(io, {
    outcome,
    profileId: profile.profileId,
    subjectId: profile.subjectId,
    deviceId: profile.deviceId,
    modelArtifactSha256: report.modelArtifactSha256,
    llamaCppPinnedRevision: report.llamaCppPinnedRevision,
    measuredArtifactSha256: report.measuredArtifactSha256,
    failureCount: uniqueFailures.length,
  });

  io.stdout.write(`${JSON.stringify({ report })}\n`);

  if (options.reportOutPath?.trim()) {
    writeCertifyReportArtifact(options.reportOutPath.trim(), report);
    emit(io, {
      outcome: "report_written",
      subjectId: profile.subjectId,
      deviceId: profile.deviceId,
      reportOutPath: path.resolve(options.reportOutPath.trim()),
    });
  }

  return { exitCode: outcome === "pass" ? 0 : 1, report };
}

export type ParsedCertifyArgv = {
  help: boolean;
  command: "certify" | null;
  profile: string | undefined;
  adapter: string | undefined;
  reportOut: string | undefined;
  errors: string[];
};

const HELP = `Usage: bindings-slm certify --profile <id> [--adapter llamacpp|onnx|mlx] [--report-out <path>]

Unified certification harness: adapter factory + profile JSON →
artifact pin → B0 model obligations → B1 locality → P4 benches (deterministic order).
Emits certification/reports/certification.report.json; aggregate exit 1 on any failure.

Options:
  certify               Run certification for a named profile
  --profile <id>        Registry id (desktop | android-mid | apple-silicon; alias: android)
  --adapter <name>      Adapter name (must match profile.adapter: llamacpp | onnx | mlx)
  --report-out <path>   Write durable adapter report (desktop shape / CI upload path)
  -h, --help            Show this help

Exit codes:
  0  all gates passed
  1  any obligation / locality / hash / bench breach (DIFF printed to stderr)
`;

export function parseBindingsSlmArgv(argv: readonly string[]): ParsedCertifyArgv {
  const out: ParsedCertifyArgv = {
    help: false,
    command: null,
    profile: undefined,
    adapter: undefined,
    reportOut: undefined,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "certify") {
      out.command = "certify";
      continue;
    }
    if (a === "--profile") {
      const v = argv[++i];
      if (!v) out.errors.push("--profile requires a value");
      else out.profile = v;
      continue;
    }
    if (a === "--adapter") {
      const v = argv[++i];
      if (!v) out.errors.push("--adapter requires a value");
      else out.adapter = v;
      continue;
    }
    if (a === "--report-out") {
      const v = argv[++i];
      if (!v) out.errors.push("--report-out requires a value");
      else out.reportOut = v;
      continue;
    }
    out.errors.push(`unknown argument: ${a}`);
  }
  return out;
}

/**
 * CLI entry for `bindings-slm certify --profile desktop`.
 */
export async function runBindingsSlmCli(
  argv: readonly string[],
  io: CertifyIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const args = parseBindingsSlmArgv(argv);
  if (args.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) io.stderr.write(`${e}\n`);
    io.stderr.write(HELP);
    return 1;
  }
  if (args.command !== "certify") {
    io.stderr.write("expected command: certify\n");
    io.stderr.write(HELP);
    return 1;
  }
  if (!args.profile?.trim()) {
    io.stderr.write("--profile is required\n");
    return 1;
  }

  try {
    const profilePath = resolveProfilePath(args.profile);
    const peek = JSON.parse(readFileSync(profilePath, "utf8")) as {
      adapter?: string;
    };
    if (peek.adapter === "onnx") {
      if (args.adapter && args.adapter !== "onnx") {
        io.stderr.write(
          `CERT FAIL: --adapter ${args.adapter} does not match profile.adapter onnx\n`,
        );
        return 1;
      }
      const { runOnnxAndroidCertifyFromProfilePath } = await import(
        "./onnx_certify.js"
      );
      return runOnnxAndroidCertifyFromProfilePath(profilePath, io, {
        ...(args.reportOut ? { reportOutPath: args.reportOut } : {}),
        writeCommittedReport: true,
      });
    }
    if (peek.adapter === "mlx") {
      if (args.adapter && args.adapter !== "mlx") {
        io.stderr.write(
          `CERT FAIL: --adapter ${args.adapter} does not match profile.adapter mlx\n`,
        );
        return 1;
      }
      const { runMlxAppleSiliconCertifyFromProfilePath } = await import(
        "./mlx_certify.js"
      );
      return runMlxAppleSiliconCertifyFromProfilePath(profilePath, io, {
        ...(args.reportOut ? { reportOutPath: args.reportOut } : {}),
        writeCommittedReport: true,
      });
    }
    const profile = loadCertProfile(profilePath);
    if (args.adapter && args.adapter !== profile.adapter) {
      io.stderr.write(
        `CERT FAIL: --adapter ${args.adapter} does not match profile.adapter ${profile.adapter}\n`,
      );
      return 1;
    }
    const { exitCode } = await runCertifyProfile(profile, io, {
      ...(args.reportOut ? { reportOutPath: args.reportOut } : {}),
    });
    return exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr.write(`CERT FAIL: ${msg}\n`);
    emit(io, {
      outcome: "fail",
      failureClass:
        err instanceof CertifyValidationError ? err.failureClass : "config",
      detail: msg,
    });
    return 1;
  }
}

/** Targets for the one-command certification proof (llama.cpp + one mobile). */
export const ONE_COMMAND_PROVE_TARGETS = [
  {
    profileId: "desktop",
    adapter: "llamacpp",
    label: "llama.cpp",
    reportBasename: "desktop.cert.json",
  },
  {
    profileId: "android-mid",
    adapter: "onnx",
    label: "onnx-mobile",
    reportBasename: "android-mid.cert.json",
  },
] as const;

export type OneCommandProveTarget =
  (typeof ONE_COMMAND_PROVE_TARGETS)[number];

export type OneCommandProveTargetResult = {
  profileId: string;
  adapter: string;
  label: string;
  exitCode: 0 | 1;
  reportPath: string;
  outcome: "pass" | "fail";
  subjectId: string;
  deviceId: string;
  /** Second identical CLI invocation (idempotent replay). */
  replayExitCode: 0 | 1;
};

export type OneCommandProveResult = {
  exitCode: 0 | 1;
  event: "bindings_slm.one_command_prove";
  recordedAt: string;
  deadlineMs: number;
  targets: OneCommandProveTargetResult[];
  /** Seeded hash violation on desktop — must fail the single CLI command. */
  seededRed: {
    ok: boolean;
    exitCode: number;
    detail: string;
  };
  failures: string[];
};

export type ProveOneCommandCertifyOptions = {
  io?: CertifyIo;
  /** Directory for per-adapter report artifacts (created if missing). */
  reportDir?: string;
  /** When set, also write the proof summary JSON. */
  proofOutPath?: string;
  packageRoot?: string;
  /** Skip writing proof summary (unit tests). */
  writeProof?: boolean;
};

/**
 * End-to-end proof: one CLI command per adapter (llama.cpp desktop + ONNX
 * android-mid). Seeded hash violation turns the command red; green runs write
 * committable reports. Re-invoking each green command is idempotent.
 */
export async function proveOneCommandCertifyFlow(
  options: ProveOneCommandCertifyOptions = {},
): Promise<OneCommandProveResult> {
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const reportDir =
    options.reportDir ??
    path.join(packageRoot, "certification", "proofs", "reports");
  mkdirSync(reportDir, { recursive: true });
  const failures: string[] = [];
  const deadlineMs = CERTIFICATION_CHECK_DEADLINE_MS;

  emit(io, {
    outcome: "start",
    event: "bindings_slm.one_command_prove",
    deadlineMs,
    targets: ONE_COMMAND_PROVE_TARGETS.map((t) => t.profileId),
  });

  // --- seeded red: single command must fail with DIFF ---
  const desktopPath = resolveProfilePath("desktop", {
    certificationDir: path.join(packageRoot, "certification"),
  });
  const desktopProfile = loadCertProfile(desktopPath);
  const seeded = structuredClone(desktopProfile);
  seeded.modelArtifact.artifactSha256 = "0".repeat(64);
  const seededPath = path.join(
    reportDir,
    "seeded-hash-violation.desktop.profile.json",
  );
  writeFileSync(seededPath, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");

  // Run certify against the seeded profile via temporary profile id file path:
  // invoke runCertifyProfile directly so the single-command surface fails red
  // without mutating the committed desktop.profile.json.
  const redCap: string[] = [];
  const redIo: CertifyIo = {
    stdout: { write(c) { io.stdout.write(c); } },
    stderr: {
      write(c) {
        redCap.push(String(c));
        io.stderr.write(c);
      },
    },
  };
  const red = await runCertifyProfile(seeded, redIo, {
    reportOutPath: path.join(reportDir, "seeded-red.cert.json"),
  });
  const redDetail = redCap.join("") || red.report.failures.join("; ");
  const seededOk =
    red.exitCode === 1 &&
    red.report.outcome === "fail" &&
    /hash mismatch|artifact hash/i.test(redDetail + red.report.failures.join(" "));
  if (!seededOk) {
    failures.push(
      `seeded red expected exit 1 + hash DIFF, got exit=${red.exitCode} outcome=${red.report.outcome}`,
    );
  }
  emit(io, {
    outcome: seededOk ? "seeded_red_ok" : "seeded_red_fail",
    subjectId: seeded.subjectId,
    deviceId: seeded.deviceId,
    exitCode: red.exitCode,
  });

  // --- green: one CLI command per target ---
  const targets: OneCommandProveTargetResult[] = [];
  for (const target of ONE_COMMAND_PROVE_TARGETS) {
    const reportPath = path.join(reportDir, target.reportBasename);
    const argv = [
      "certify",
      "--profile",
      target.profileId,
      "--adapter",
      target.adapter,
      "--report-out",
      reportPath,
    ];
    const code = (await runBindingsSlmCli(argv, io)) as 0 | 1;
    let outcome: "pass" | "fail" = code === 0 ? "pass" : "fail";
    let subjectId = "";
    let deviceId = "";
    if (existsSync(reportPath)) {
      try {
        const disk = JSON.parse(readFileSync(reportPath, "utf8")) as {
          outcome?: string;
          subjectId?: string;
          deviceId?: string;
        };
        if (disk.outcome === "pass" || disk.outcome === "fail") {
          outcome = disk.outcome;
        }
        subjectId = disk.subjectId ?? "";
        deviceId = disk.deviceId ?? "";
      } catch {
        failures.push(`${target.profileId}: report unreadable at ${reportPath}`);
      }
    } else {
      failures.push(`${target.profileId}: missing report at ${reportPath}`);
    }
    if (code !== 0 || outcome !== "pass") {
      failures.push(
        `${target.label} certify failed (exit=${code} outcome=${outcome})`,
      );
    }
    if (!subjectId.trim() || !deviceId.trim()) {
      failures.push(
        `${target.profileId}: report missing subjectId/deviceId (subject isolation)`,
      );
    }

    // Idempotent replay — second identical CLI invocation must stay green.
    const replayCode = (await runBindingsSlmCli(argv, io)) as 0 | 1;
    if (replayCode !== code) {
      failures.push(
        `${target.profileId}: replay exit ${replayCode} != first ${code}`,
      );
    }

    targets.push({
      profileId: target.profileId,
      adapter: target.adapter,
      label: target.label,
      exitCode: code,
      reportPath,
      outcome,
      subjectId,
      deviceId,
      replayExitCode: replayCode,
    });

    emit(io, {
      outcome: code === 0 ? "target_pass" : "target_fail",
      profileId: target.profileId,
      adapter: target.adapter,
      subjectId,
      deviceId,
      exitCode: code,
      replayExitCode: replayCode,
    });
  }

  // Concurrent subject isolation: two desktop certifies with distinct subjects
  // must not cross-contaminate report subjectIds (restart-safe: fresh CLI each).
  const concurrentDir = path.join(reportDir, "concurrent");
  mkdirSync(concurrentDir, { recursive: true });
  const aProfile = structuredClone(desktopProfile);
  const bProfile = structuredClone(desktopProfile);
  aProfile.subjectId = "cert.prove.concurrent.a";
  aProfile.deviceId = "dev-prove-a";
  bProfile.subjectId = "cert.prove.concurrent.b";
  bProfile.deviceId = "dev-prove-b";
  const [ra, rb] = await Promise.all([
    runCertifyProfile(aProfile, { stdout: { write() {} }, stderr: { write() {} } }, {
      reportOutPath: path.join(concurrentDir, "a.cert.json"),
    }),
    runCertifyProfile(bProfile, { stdout: { write() {} }, stderr: { write() {} } }, {
      reportOutPath: path.join(concurrentDir, "b.cert.json"),
    }),
  ]);
  if (ra.exitCode !== 0 || rb.exitCode !== 0) {
    failures.push("concurrent subject certify did not stay green");
  } else if (
    ra.report.subjectId !== "cert.prove.concurrent.a" ||
    rb.report.subjectId !== "cert.prove.concurrent.b" ||
    JSON.stringify(ra.report).includes("cert.prove.concurrent.b")
  ) {
    failures.push("concurrent subject isolation breach in certify reports");
  }

  const result: OneCommandProveResult = {
    exitCode: failures.length === 0 ? 0 : 1,
    event: "bindings_slm.one_command_prove",
    recordedAt: new Date().toISOString(),
    deadlineMs,
    targets,
    seededRed: {
      ok: seededOk,
      exitCode: red.exitCode,
      detail: seededOk
        ? "seeded hash violation failed single certify command as expected"
        : redDetail.slice(0, 500),
    },
    failures: [...failures],
  };

  if (result.exitCode !== 0) {
    for (const f of failures) {
      io.stderr.write(`CERT FAIL: ${f}\n`);
    }
  }

  emit(io, {
    outcome: result.exitCode === 0 ? "pass" : "fail",
    event: "bindings_slm.one_command_prove",
    failureCount: failures.length,
    targetCount: targets.length,
  });

  if (options.writeProof !== false) {
    const proofPath =
      options.proofOutPath ??
      path.join(
        packageRoot,
        "certification",
        "proofs",
        "one-command.proof.json",
      );
    mkdirSync(path.dirname(proofPath), { recursive: true });
    // Relativize report paths for a portable committed artifact.
    const portableTargets = result.targets.map((t) => ({
      ...t,
      reportPath: path
        .relative(packageRoot, t.reportPath)
        .split(path.sep)
        .join("/"),
    }));
    writeFileSync(
      proofPath,
      `${JSON.stringify(
        {
          ...result,
          targets: portableTargets,
          committedNote:
            "One-command certify proof: llama.cpp desktop + ONNX android-mid; seeded red then green.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    emit(io, {
      outcome: "proof_written",
      path: proofPath,
    });
  }

  io.stdout.write(`${JSON.stringify({ proof: result })}\n`);
  return result;
}
