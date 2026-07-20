/**
 * Per-domain-pack SFT manifest lane assembly.
 *
 * Builds one corpus-compatible manifest lane per knowledge pack from
 * domains/ specs (filesystem paths only — never imported as code),
 * B8-guidance-derived scenario stubs, critic-gated distilled traces,
 * and C0-gated consented trajectories. Each pack lane carries its own
 * decontamination proof. Consented and public/synthetic sources never
 * share a manifest.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  includeExportedTrajectoryInCorpus,
  loadBaselineRegistryDocumentFromFile,
  parseTurnTrajectoryRecord,
  type TurnTrajectoryRecord,
} from "@moolam/learning";
import {
  CORPUS_CURRICULUM_STAGES,
  CORPUS_MANIFEST_SCHEMA_VERSION,
  CORPUS_PACKAGE_ROOT,
  canonicalManifestBytes,
  canonicalManifestSha256,
  parseCorpusManifest,
  writeCorpusManifest,
  type CorpusConsentClass,
  type CorpusCurriculum,
  type CorpusCurriculumStage,
  type CorpusManifest,
  type CorpusManifestFailureClass,
  type CorpusManifestTelemetry,
} from "../build.js";
import {
  defaultBaselineRegistryRelpath,
  exactHashCheckDocuments,
  resolveCorpusRepoRoot,
  type DecontamProof,
} from "../decontaminate.js";
import {
  PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT,
  buildPackSftCurriculumMetadata,
} from "./curriculum_order.js";
import {
  PACK_SFT_QUALITY_CRITIC_FLOOR,
  PACK_SFT_SLM_MAX_LANE_SOURCES,
  assertPackSftSlmSizeGate,
  buildPackSftLaneSizeReport,
  type PackSftLaneSizeReport,
  type PackSftSizeGateMode,
} from "./size_quality_gate.js";

export {
  PACK_SFT_CURRICULUM_SCHEMA_VERSION,
  PACK_SFT_CURRICULUM_STAGE_ORDER,
  PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT,
  assertCurriculumOrdering,
  buildPackSftCurriculumMetadata,
  computeRepairHeavyStageWeights,
  orderSourcesByCurriculum,
} from "./curriculum_order.js";

export {
  PACK_SFT_LANE_SIZE_REPORT_SCHEMA_VERSION,
  PACK_SFT_QUALITY_CRITIC_FLOOR,
  PACK_SFT_SLM_MAX_LANE_SOURCES,
  PACK_SFT_SLM_MIN_FIRST_JOB_SOURCES,
  PACK_SFT_SLM_THOUSANDS_REJECT_AT,
  applyPackSftQualityFilter,
  assertPackSftSlmSizeGate,
  buildPackSftLaneSizeReport,
  gatePackSftLaneForFirstTrainingJob,
  laneSizeReportFromManifest,
  reportPackSftLaneSizes,
} from "./size_quality_gate.js";

export const DOMAIN_PACKS_ROOT = path.join(
  CORPUS_PACKAGE_ROOT,
  "domain_packs",
);
export const PACK_SFT_DEFAULT_MIN_CRITIC_SCORE = PACK_SFT_QUALITY_CRITIC_FLOOR;

export const PACK_SFT_SOURCE_KINDS = Object.freeze([
  "domain_spec",
  "b8_guidance_derived",
  "distilled_trace",
  "consented_trajectory",
  "knowledge_pack",
] as const);
export type PackSftSourceKind = (typeof PACK_SFT_SOURCE_KINDS)[number];

export type KnownDomainPack = {
  packId: string;
  domainCode: string;
  knowledgePackRelpath: string;
  domainSpecRelpath: string;
  domainDataRelpaths: readonly string[];
};

/** Flagship packs — paths are repo-relative filesystem data, not code imports. */
export const KNOWN_DOMAIN_PACKS: readonly KnownDomainPack[] = Object.freeze([
  {
    packId: "pack.teacher.cbse-slice",
    domainCode: "teacher",
    knowledgePackRelpath: "knowledge-packs/teacher-cbse-slice",
    domainSpecRelpath: "domains/teacher/README.md",
    domainDataRelpaths: Object.freeze([
      "domains/teacher/data/cbse-syllabus-slice.md",
    ]),
  },
  {
    packId: "pack.doctor.formulary-sketch",
    domainCode: "doctor",
    knowledgePackRelpath: "knowledge-packs/doctor-formulary-sketch",
    domainSpecRelpath: "domains/doctor/README.md",
    domainDataRelpaths: Object.freeze([
      "domains/doctor/data/formulary-sketch.md",
    ]),
  },
]);

const PACK_BY_ID = new Map(KNOWN_DOMAIN_PACKS.map((p) => [p.packId, p]));

export type PackSftFailureClass =
  | CorpusManifestFailureClass
  | "contamination"
  | "critic_threshold"
  | "source_missing"
  | "empty_lane"
  | "consent_mix"
  | "unknown_pack"
  | "curriculum_order"
  | "size_gate"
  | "quality_filter";

export type PackSftTelemetry = {
  event: "training.pack_sft_lane";
  op:
    | "assemble"
    | "discover"
    | "consent_gate"
    | "critic_gate"
    | "curriculum_order"
    | "size_gate"
    | "quality_filter"
    | "decontam"
    | "write";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  packId?: string;
  manifestId?: string;
  laneCode?: string;
  sourceCount?: number;
  excludedCount?: number;
  failureClass?: PackSftFailureClass;
  detail?: string;
};

export type PackSftCandidate = {
  sourceId: string;
  kind: PackSftSourceKind;
  knowledgeMode: "MEM" | "UND";
  licenseId: string;
  curriculumStage: CorpusCurriculumStage;
  /** Absolute path to bytes, or inline bytes via `inlineBytes`. */
  absPath?: string;
  /** When set, written under outDir/relpath before hashing. */
  inlineBytes?: Buffer;
  relpath: string;
  contentHash?: string;
  criticScore?: number;
  /** Raw trajectory JSON for consented_trajectory kind. */
  trajectory?: unknown;
};

export type AssemblePackSftLaneInput = {
  packId: string;
  manifestId: string;
  version: string;
  title?: string;
  /** When omitted, discover from known pack paths + B8 + optional candidates. */
  candidates?: readonly PackSftCandidate[];
  /** Extra candidates merged after discovery (or sole set when discover=false). */
  extraCandidates?: readonly PackSftCandidate[];
  discover?: boolean;
  consentClass?: CorpusConsentClass;
  licenseLedger?: {
    licenseId: string;
    spdxOrLabel: string;
    licenseClass?: "open" | "restricted" | "government" | "proprietary";
  }[];
  minCriticScore?: number;
  /**
   * SLM size gate mode. `max_only` (default) enforces hundreds ceiling.
   * `first_job` also requires hundreds-class floor for training readiness.
   */
  sizeGateMode?: PackSftSizeGateMode;
  repoRoot?: string;
  packageRoot?: string;
  outDir: string;
  baselineRegistryRelpath?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: PackSftTelemetry) => void;
  onCorpusTelemetry?: (e: CorpusManifestTelemetry) => void;
};

export type AssemblePackSftLaneOk = {
  ok: true;
  packId: string;
  laneCode: string;
  manifest: CorpusManifest;
  manifestPath: string;
  bytes: Buffer;
  contentSha256: string;
  decontamProof: DecontamProof;
  decontamProofPath: string;
  curriculum: CorpusCurriculum;
  curriculumTags: Record<string, CorpusCurriculumStage>;
  laneSizeReport: PackSftLaneSizeReport;
  laneSizeReportPath: string;
  excluded: { sourceId: string; reason: PackSftFailureClass; detail: string }[];
  subjectId: string;
  deviceId: string;
};

export type AssemblePackSftLaneFail = {
  ok: false;
  failureClass: PackSftFailureClass;
  detail: string;
  subjectId: string;
  deviceId: string;
  packId?: string;
};

function emit(
  onTelemetry: ((e: PackSftTelemetry) => void) | undefined,
  partial: Omit<PackSftTelemetry, "event">,
): void {
  onTelemetry?.({ event: "training.pack_sft_lane", ...partial });
}

function sha256Prefixed(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isCurriculumStage(v: string): v is CorpusCurriculumStage {
  return (CORPUS_CURRICULUM_STAGES as readonly string[]).includes(v);
}

export function lookupKnownDomainPack(
  packId: string,
): KnownDomainPack | undefined {
  return PACK_BY_ID.get(packId);
}

export function listKnownDomainPackIds(): string[] {
  return KNOWN_DOMAIN_PACKS.map((p) => p.packId);
}

/**
 * Decontam proof path is unique per pack lane (separate proof artifact).
 */
export function packSftDecontamProofRelpath(packId: string): string {
  return `training/corpus/domain_packs/proofs/${packId}/decontam-proof.json`;
}

function defaultLicenseLedger(): NonNullable<
  AssemblePackSftLaneInput["licenseLedger"]
> {
  return [
    {
      licenseId: "lic.cc-by-4.0",
      spdxOrLabel: "CC-BY-4.0",
      licenseClass: "open",
    },
    {
      licenseId: "lic.internal-research",
      spdxOrLabel: "LicenseRef-Moolam-Internal-Research",
      licenseClass: "restricted",
    },
  ];
}

function readFileIfExists(abs: string): Buffer | null {
  if (!existsSync(abs)) return null;
  return readFileSync(abs);
}

/**
 * Discover filesystem candidates for a known pack.
 * B8 eval fixtures are never copied as training bytes — derived stubs only.
 */
export function discoverPackSftCandidates(
  packId: string,
  options: {
    repoRoot: string;
    licenseId?: string;
  },
): PackSftCandidate[] {
  const pack = lookupKnownDomainPack(packId);
  if (!pack) return [];
  const licenseId = options.licenseId ?? "lic.cc-by-4.0";
  const out: PackSftCandidate[] = [];

  const specAbs = path.resolve(options.repoRoot, pack.domainSpecRelpath);
  if (existsSync(specAbs)) {
    out.push({
      sourceId: `src.${pack.domainCode}.domain-spec`,
      kind: "domain_spec",
      knowledgeMode: "UND",
      licenseId,
      curriculumStage: "protocol",
      absPath: specAbs,
      relpath: pack.domainSpecRelpath.replace(/\\/g, "/"),
    });
  }

  for (const rel of pack.domainDataRelpaths) {
    const abs = path.resolve(options.repoRoot, rel);
    if (!existsSync(abs)) continue;
    out.push({
      sourceId: `src.${pack.domainCode}.domain-data.${path.basename(rel, path.extname(rel))}`,
      kind: "domain_spec",
      knowledgeMode: "UND",
      licenseId,
      curriculumStage: "domain_depth",
      absPath: abs,
      relpath: rel.replace(/\\/g, "/"),
    });
  }

  const packManifestRel = `${pack.knowledgePackRelpath}/manifest.json`;
  const packManifestAbs = path.resolve(options.repoRoot, packManifestRel);
  if (existsSync(packManifestAbs)) {
    out.push({
      sourceId: `src.${pack.domainCode}.knowledge-pack.manifest`,
      kind: "knowledge_pack",
      knowledgeMode: "UND",
      licenseId,
      curriculumStage: "domain_depth",
      absPath: packManifestAbs,
      relpath: packManifestRel.replace(/\\/g, "/"),
    });
  }

  // B8 guidance → derived stubs (eval fixture bytes stay out of training).
  const b8ManifestAbs = path.resolve(
    options.repoRoot,
    "training/eval/fixtures/b8-guidance/manifest.json",
  );
  if (existsSync(b8ManifestAbs)) {
    try {
      const b8Man = JSON.parse(readFileSync(b8ManifestAbs, "utf8")) as {
        scenarios?: { id: string; file: string }[];
      };
      for (const sc of b8Man.scenarios ?? []) {
        const scAbs = path.resolve(
          options.repoRoot,
          "training/eval/fixtures/b8-guidance",
          sc.file,
        );
        if (!existsSync(scAbs)) continue;
        const scDoc = JSON.parse(readFileSync(scAbs, "utf8")) as {
          id?: string;
          domainPack?: string;
          cases?: { caseId: string }[];
        };
        if (scDoc.domainPack !== pack.domainCode) continue;
        const derived = {
          schemaVersion: "training.pack-sft-scenario.v1",
          derivedFromScenarioId: scDoc.id ?? sc.id,
          domainCode: pack.domainCode,
          packId: pack.packId,
          curriculumStage: "protocol" as const,
          caseIds: (scDoc.cases ?? []).map((c) => c.caseId).sort(),
          // Training skeleton — deliberately not the eval fixture payload.
          promptTemplate:
            "Apply domain guidance for case {{caseId}}; refuse eval leakage.",
        };
        const inline = Buffer.from(`${JSON.stringify(derived, null, 2)}\n`, "utf8");
        out.push({
          sourceId: `src.${pack.domainCode}.b8-derived.${sc.id}`,
          kind: "b8_guidance_derived",
          knowledgeMode: "UND",
          licenseId,
          curriculumStage: "protocol",
          inlineBytes: inline,
          relpath: `derived/b8/${sc.id}.json`,
        });
      }
    } catch {
      // Discovery is best-effort; assemble emits typed errors on empty lane.
    }
  }

  return out;
}

function resolveCandidateBytes(
  candidate: PackSftCandidate,
  materializeDir: string,
):
  | { ok: true; bytes: Buffer; absWritePath?: string }
  | { ok: false; detail: string } {
  if (candidate.inlineBytes) {
    const absWritePath = path.resolve(materializeDir, candidate.relpath);
    return { ok: true, bytes: candidate.inlineBytes, absWritePath };
  }
  if (candidate.absPath) {
    const buf = readFileIfExists(candidate.absPath);
    if (!buf) {
      return { ok: false, detail: `source missing: ${candidate.absPath}` };
    }
    return { ok: true, bytes: buf };
  }
  return { ok: false, detail: `no bytes for sourceId=${candidate.sourceId}` };
}

/**
 * Assemble one per-pack SFT corpus manifest lane with curriculum tags,
 * consent gates, critic threshold, and a pack-scoped decontam proof.
 */
export function assemblePackSftManifestLane(
  input: AssemblePackSftLaneInput,
): AssemblePackSftLaneOk | AssemblePackSftLaneFail {
  const subjectId = input.subjectId?.trim() || "subj.pack-sft";
  const deviceId = input.deviceId?.trim() || "dev-pack-sft";
  const packId = input.packId?.trim() ?? "";
  const packageRoot = input.packageRoot ?? CORPUS_PACKAGE_ROOT;
  const repoRoot =
    input.repoRoot ?? resolveCorpusRepoRoot(packageRoot);
  const minCritic =
    input.minCriticScore ?? PACK_SFT_DEFAULT_MIN_CRITIC_SCORE;
  const baselineRegistryRelpath =
    input.baselineRegistryRelpath?.trim() || defaultBaselineRegistryRelpath();
  const licenseLedger = input.licenseLedger ?? defaultLicenseLedger();
  const licenseIds = new Set(licenseLedger.map((l) => l.licenseId));

  const fail = (
    failureClass: PackSftFailureClass,
    detail: string,
  ): AssemblePackSftLaneFail => {
    emit(input.onTelemetry, {
      op: "assemble",
      outcome: "error",
      subjectId,
      deviceId,
      ...(packId ? { packId } : {}),
      failureClass,
      detail,
    });
    return {
      ok: false,
      failureClass,
      detail,
      subjectId,
      deviceId,
      ...(packId ? { packId } : {}),
    };
  };

  if (!packId) return fail("config", "packId is required");
  if (!input.manifestId?.trim() || !input.version?.trim()) {
    return fail("config", "manifestId and version are required");
  }
  if (!input.outDir?.trim()) return fail("config", "outDir is required");

  const pack = lookupKnownDomainPack(packId);
  if (!pack && (input.discover !== false) && !input.candidates?.length) {
    return fail("unknown_pack", `unknown packId (no catalog entry): ${packId}`);
  }

  const laneCode = packId;
  const outDir = path.resolve(input.outDir);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(path.join(outDir, "derived", "b8"), { recursive: true });
  mkdirSync(path.join(outDir, "shards"), { recursive: true });

  const discover = input.discover !== false;
  let candidates: PackSftCandidate[] = [];
  if (input.candidates) {
    candidates = [...input.candidates];
  } else if (discover) {
    candidates = discoverPackSftCandidates(packId, { repoRoot });
    emit(input.onTelemetry, {
      op: "discover",
      outcome: "ok",
      subjectId,
      deviceId,
      packId,
      sourceCount: candidates.length,
      detail: `discovered=${candidates.length}`,
    });
  }
  if (input.extraCandidates?.length) {
    candidates = [...candidates, ...input.extraCandidates];
  }

  const excluded: AssemblePackSftLaneOk["excluded"] = [];
  const accepted: {
    sourceId: string;
    relpath: string;
    licenseId: string;
    knowledgeMode: "MEM" | "UND";
    laneCode: string;
    contentHash: string;
    curriculumStage: CorpusCurriculumStage;
    kind: PackSftSourceKind;
  }[] = [];

  let sawConsented = false;
  const sizeGateMode: PackSftSizeGateMode = input.sizeGateMode ?? "max_only";

  // Bound scan to SLM max + 1 so size gate can observe thousands-class overflow.
  const capped = candidates.slice(0, PACK_SFT_SLM_MAX_LANE_SOURCES + 1);

  // Intent-level mix guard: consented trajectories never share a manifest
  // with public/synthetic pack sources (domains/, B8-derived, distill, …).
  const hasConsentedKind = capped.some((c) => c.kind === "consented_trajectory");
  const hasNonConsentedKind = capped.some(
    (c) => c.kind !== "consented_trajectory",
  );
  if (hasConsentedKind && hasNonConsentedKind) {
    return fail(
      "consent_mix",
      "consented trajectories must not mix with public/synthetic sources in one pack SFT manifest",
    );
  }

  for (const cand of capped) {
    if (!licenseIds.has(cand.licenseId)) {
      excluded.push({
        sourceId: cand.sourceId,
        reason: "license",
        detail: `unknown licenseId=${cand.licenseId}`,
      });
      continue;
    }

    if (!isCurriculumStage(cand.curriculumStage)) {
      excluded.push({
        sourceId: cand.sourceId,
        reason: "schema",
        detail: `invalid curriculumStage=${String(cand.curriculumStage)}`,
      });
      continue;
    }

    if (cand.kind === "distilled_trace") {
      const score = cand.criticScore;
      if (typeof score !== "number" || Number.isNaN(score) || score < minCritic) {
        emit(input.onTelemetry, {
          op: "quality_filter",
          outcome: "error",
          subjectId,
          deviceId,
          packId,
          failureClass: "quality_filter",
          detail: `sourceId=${cand.sourceId};score=${String(score)};floor=${minCritic}`,
        });
        excluded.push({
          sourceId: cand.sourceId,
          reason: "quality_filter",
          detail: `criticScore ${String(score)} < floor ${minCritic}`,
        });
        continue;
      }
    }

    if (cand.kind === "consented_trajectory") {
      if (cand.trajectory === undefined) {
        excluded.push({
          sourceId: cand.sourceId,
          reason: "consent",
          detail: "trajectory payload required",
        });
        continue;
      }
      const parsed = parseTurnTrajectoryRecord(cand.trajectory);
      if (!parsed.ok) {
        emit(input.onTelemetry, {
          op: "consent_gate",
          outcome: "error",
          subjectId,
          deviceId,
          packId,
          failureClass: "consent",
          detail: parsed.detail,
        });
        excluded.push({
          sourceId: cand.sourceId,
          reason: "consent",
          detail: parsed.detail,
        });
        continue;
      }
      const record: TurnTrajectoryRecord = parsed.record;

      // Materialize shard bytes first (metadata only — no utterance bodies).
      let relpath = cand.relpath;
      let contentHash = cand.contentHash;
      if (cand.inlineBytes || cand.absPath) {
        const mat = resolveCandidateBytes(cand, outDir);
        if (!mat.ok) {
          excluded.push({
            sourceId: cand.sourceId,
            reason: "source_missing",
            detail: mat.detail,
          });
          continue;
        }
        if (mat.absWritePath) {
          mkdirSync(path.dirname(mat.absWritePath), { recursive: true });
          writeFileSync(mat.absWritePath, mat.bytes);
          relpath = path.relative(outDir, mat.absWritePath).replace(/\\/g, "/");
        }
        contentHash = contentHash ?? sha256Prefixed(mat.bytes);
      } else {
        const shardRel = `shards/${cand.sourceId}.json`;
        const shardAbs = path.join(outDir, shardRel);
        const body = Buffer.from(
          `${JSON.stringify(
            {
              schemaVersion: "training.pack-sft-trajectory.v1",
              sourceId: cand.sourceId,
              subjectId: record.subjectId,
              turnId: record.turnId,
              locality: record.locality,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        writeFileSync(shardAbs, body);
        contentHash = contentHash ?? sha256Prefixed(body);
        relpath = shardRel;
      }

      const inclusion = includeExportedTrajectoryInCorpus(record, {
        contentHash,
        shardId: cand.sourceId,
        deviceId,
        shardConsentClass: "consented",
      });
      if (!inclusion.ok) {
        emit(input.onTelemetry, {
          op: "consent_gate",
          outcome: "error",
          subjectId: record.subjectId,
          deviceId,
          packId,
          failureClass: "consent",
          detail: inclusion.detail ?? inclusion.failureClass,
        });
        excluded.push({
          sourceId: cand.sourceId,
          reason: "consent",
          detail: inclusion.detail ?? inclusion.failureClass,
        });
        continue;
      }
      emit(input.onTelemetry, {
        op: "consent_gate",
        outcome: "ok",
        subjectId: record.subjectId,
        deviceId,
        packId,
        detail: `included=${cand.sourceId}`,
      });
      sawConsented = true;

      accepted.push({
        sourceId: cand.sourceId,
        relpath,
        licenseId: cand.licenseId,
        knowledgeMode: cand.knowledgeMode,
        laneCode,
        contentHash,
        curriculumStage: cand.curriculumStage,
        kind: cand.kind,
      });
      continue;
    }

    // Non-trajectory sources (synthetic / public lane material).
    const mat = resolveCandidateBytes(cand, outDir);
    if (!mat.ok) {
      excluded.push({
        sourceId: cand.sourceId,
        reason: "source_missing",
        detail: mat.detail,
      });
      continue;
    }
    if (mat.absWritePath) {
      mkdirSync(path.dirname(mat.absWritePath), { recursive: true });
      writeFileSync(mat.absWritePath, mat.bytes);
    }
    const contentHash = cand.contentHash ?? sha256Prefixed(mat.bytes);
    const relpath = mat.absWritePath
      ? path.relative(outDir, mat.absWritePath).replace(/\\/g, "/")
      : cand.relpath;

    accepted.push({
      sourceId: cand.sourceId,
      relpath,
      licenseId: cand.licenseId,
      knowledgeMode: cand.knowledgeMode,
      laneCode,
      contentHash,
      curriculumStage: cand.curriculumStage,
      kind: cand.kind,
    });
  }

  if (accepted.length < 1) {
    return fail(
      "empty_lane",
      `no sources accepted for packId=${packId} (excluded=${excluded.length})`,
    );
  }

  const belowCriticFloorCount = excluded.filter(
    (e) => e.reason === "quality_filter" || e.reason === "critic_threshold",
  ).length;

  const sizeCheck = assertPackSftSlmSizeGate(accepted.length, {
    mode: sizeGateMode,
  });
  if (!sizeCheck.ok) {
    emit(input.onTelemetry, {
      op: "size_gate",
      outcome: "error",
      subjectId,
      deviceId,
      packId,
      sourceCount: accepted.length,
      failureClass: "size_gate",
      detail: sizeCheck.detail,
    });
    return fail("size_gate", sizeCheck.detail);
  }

  emit(input.onTelemetry, {
    op: "size_gate",
    outcome: "ok",
    subjectId,
    deviceId,
    packId,
    sourceCount: accepted.length,
    detail: `mode=${sizeGateMode};max=${PACK_SFT_SLM_MAX_LANE_SOURCES}`,
  });

  if (belowCriticFloorCount > 0) {
    emit(input.onTelemetry, {
      op: "quality_filter",
      outcome: "ok",
      subjectId,
      deviceId,
      packId,
      excludedCount: belowCriticFloorCount,
      detail: `excludedBelowFloor=${belowCriticFloorCount};floor=${minCritic}`,
    });
  }

  const consentClass: CorpusConsentClass =
    input.consentClass ?? (sawConsented ? "consented" : "synthetic");
  if (sawConsented && consentClass !== "consented") {
    return fail(
      "consent",
      `consented trajectories require consentClass=consented (got ${consentClass})`,
    );
  }
  if (!sawConsented && consentClass === "consented") {
    return fail(
      "consent",
      "consentClass=consented requires at least one gated consented trajectory",
    );
  }

  // Decontam against C0 baseline registry — hard failure on overlap.
  const registryPath = path.resolve(repoRoot, baselineRegistryRelpath);
  if (!existsSync(registryPath)) {
    return fail(
      "config",
      `baseline registry missing: ${baselineRegistryRelpath}`,
    );
  }
  const registry = loadBaselineRegistryDocumentFromFile(registryPath, {
    deviceId,
  });
  if (!registry.ok) {
    return fail("config", `baseline registry load failed: ${registry.detail}`);
  }

  const decontamDocs = accepted.map((s) => ({
    docId: s.sourceId,
    contentHash: s.contentHash,
  }));
  const decontam = exactHashCheckDocuments(registry.document, decontamDocs, {
    baselineRegistryRelpath,
    deviceId,
  });
  if (!decontam.ok) {
    emit(input.onTelemetry, {
      op: "decontam",
      outcome: "error",
      subjectId,
      deviceId,
      packId,
      failureClass: "contamination",
      detail: decontam.message,
    });
    return fail(
      "contamination",
      `eval overlap: ${decontam.message} (docs=${decontam.offendingDocIds.join(",")})`,
    );
  }

  // Logical report path is pack-scoped (unique per lane); bytes live under outDir.
  const proofRelpath = packSftDecontamProofRelpath(packId);
  const proofAbs = path.join(outDir, "decontam-proof.json");
  const proofDoc = {
    schemaVersion: "training.pack-sft-decontam-proof.v1",
    packId,
    laneCode,
    reportRelpath: proofRelpath,
    ...decontam.proof,
  };
  writeFileSync(proofAbs, `${JSON.stringify(proofDoc, null, 2)}\n`, "utf8");

  emit(input.onTelemetry, {
    op: "decontam",
    outcome: "ok",
    subjectId,
    deviceId,
    packId,
    detail: `checked=${decontam.proof.checkedHashCount}`,
  });

  const knowledgeModes = [
    ...new Set(accepted.map((s) => s.knowledgeMode)),
  ] as ("MEM" | "UND")[];

  const curriculumTags: Record<string, CorpusCurriculumStage> = {};
  for (const s of accepted) {
    curriculumTags[s.sourceId] = s.curriculumStage;
  }

  const curriculumBuilt = buildPackSftCurriculumMetadata(accepted, {
    repairHeavyTargetWeight: PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT,
  });
  if (!curriculumBuilt.ok) {
    emit(input.onTelemetry, {
      op: "curriculum_order",
      outcome: "error",
      subjectId,
      deviceId,
      packId,
      failureClass: "curriculum_order",
      detail: curriculumBuilt.detail,
    });
    return fail("curriculum_order", curriculumBuilt.detail);
  }

  emit(input.onTelemetry, {
    op: "curriculum_order",
    outcome: "ok",
    subjectId,
    deviceId,
    packId,
    sourceCount: curriculumBuilt.curriculum.orderedSourceIds.length,
    detail: `stages=${curriculumBuilt.curriculum.stageOrder.join("→")};repairTarget=${curriculumBuilt.curriculum.repairHeavyTargetWeight}`,
  });

  const manifestDraft = {
    schemaVersion: CORPUS_MANIFEST_SCHEMA_VERSION,
    manifestId: input.manifestId.trim(),
    version: input.version.trim(),
    ...(input.title !== undefined ? { title: input.title } : {}),
    consentClass,
    laneCodes: [laneCode],
    knowledgeModes,
    sources: accepted
      .map((s) => ({
        sourceId: s.sourceId,
        relpath: s.relpath,
        licenseId: s.licenseId,
        knowledgeMode: s.knowledgeMode,
        laneCode: s.laneCode,
        contentHash: s.contentHash,
        curriculumStage: s.curriculumStage,
      }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    filters: [
      {
        filterId: "flt.exclude-unknown-license",
        kind: "exclude_unknown_license",
      },
      {
        filterId: "flt.exclude-ret-weights",
        kind: "exclude_ret_from_weights",
      },
      {
        filterId: "flt.exclude-eval-overlap",
        kind: "exclude_eval_overlap",
      },
    ],
    dedupReport: {
      status: "pending" as const,
      algorithm: "sha256+fuzzy" as const,
      fuzzyThreshold: 0.92,
      laneThresholds: { [laneCode]: 0.92 },
    },
    licenseLedger,
    weightTrainingPolicy: {
      excludeKnowledgeModes: ["RET"] as const,
      requireKnownLicense: true as const,
    },
    determinism: {
      canonicalSort: true as const,
      contentAddressedShards: true as const,
      forbidWallClockInShardBytes: true as const,
    },
    decontaminationProof: {
      status: "recorded" as const,
      baselineRegistryRelpath,
      reportRelpath: proofRelpath,
    },
    curriculum: curriculumBuilt.curriculum,
  };

  const validated = parseCorpusManifest(manifestDraft, {
    subjectId,
    deviceId,
    ...(input.onCorpusTelemetry !== undefined
      ? { onTelemetry: input.onCorpusTelemetry }
      : {}),
  });
  if (!validated.ok) {
    return fail(validated.failureClass, validated.message);
  }

  const manifestPath = path.join(outDir, "corpus-manifest.json");
  const written = writeCorpusManifest(manifestPath, validated.value, {
    subjectId,
    deviceId,
    ...(input.onCorpusTelemetry !== undefined
      ? { onTelemetry: input.onCorpusTelemetry }
      : {}),
  });
  if (!written.ok) {
    return fail(written.failureClass, written.message);
  }

  const bytes = canonicalManifestBytes(written.value);
  const tagsPath = path.join(outDir, "curriculum-tags.json");
  writeFileSync(
    tagsPath,
    `${JSON.stringify(
      {
        schemaVersion: "training.pack-sft-curriculum-tags.v1",
        packId,
        laneCode,
        tags: curriculumTags,
        curriculum: curriculumBuilt.curriculum,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const laneSizeReport = buildPackSftLaneSizeReport({
    packId,
    laneCode,
    manifestId: written.value.manifestId,
    mode: sizeGateMode,
    criticFloor: minCritic,
    belowCriticFloorCount,
    sources: accepted.map((s) => ({
      sourceId: s.sourceId,
      kind: s.kind,
      curriculumStage: s.curriculumStage,
    })),
  });
  const laneSizeReportPath = path.join(outDir, "lane-size-report.json");
  writeFileSync(
    laneSizeReportPath,
    `${JSON.stringify(laneSizeReport, null, 2)}\n`,
    "utf8",
  );

  emit(input.onTelemetry, {
    op: "write",
    outcome: "ok",
    subjectId,
    deviceId,
    packId,
    manifestId: written.value.manifestId,
    laneCode,
    sourceCount: written.value.sources.length,
    excludedCount: excluded.length,
  });
  emit(input.onTelemetry, {
    op: "assemble",
    outcome: "ok",
    subjectId,
    deviceId,
    packId,
    manifestId: written.value.manifestId,
    laneCode,
    sourceCount: written.value.sources.length,
    detail: canonicalManifestSha256(written.value),
  });

  return {
    ok: true,
    packId,
    laneCode,
    manifest: written.value,
    manifestPath,
    bytes,
    contentSha256: canonicalManifestSha256(written.value),
    decontamProof: decontam.proof,
    decontamProofPath: proofAbs,
    curriculum: curriculumBuilt.curriculum,
    curriculumTags,
    laneSizeReport,
    laneSizeReportPath,
    excluded,
    subjectId,
    deviceId,
  };
}
