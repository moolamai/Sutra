/**
 * Exact-hash + SimHash near-dup decontamination against the C0 baseline registry,
 * and within-corpus fuzzy dedup (sha256 + SimHash) with per-lane thresholds.
 *
 * Contamination against eval baselines = build failure.
 * Within-corpus near-dups are dropped and recorded in the dedup report.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BASELINE_NEAR_DUP_DEFAULT_THRESHOLD,
  BASELINE_NEAR_DUP_DOC_SCAN_LIMIT,
  BASELINE_REGISTRY_RELPATH,
  assertCorpusBuildDecontamProof,
  assertCorpusDocumentsExactHashDecontaminated,
  assertCorpusDocumentsNearDupDecontaminated,
  computeSimHash64Hex,
  exportRegisteredBaselineHashes,
  loadBaselineRegistryDocumentFromFile,
  simHashSimilarityHex,
  type BaselineRegistryDocument,
  type BaselineRegistryTelemetryEvent,
  type CorpusDocumentHashCandidate,
  type CorpusNearDupCandidate,
} from "@moolam/learning";

export const DECONTAM_METHOD_EXACT_HASH = "exact_hash" as const;
export const DECONTAM_METHOD_EXACT_AND_NEAR_DUP =
  "exact_hash+simhash_near_dup" as const;
export const DEDUP_ALGORITHM_SHA256 = "sha256" as const;
export const DEDUP_ALGORITHM_SHA256_FUZZY = "sha256+fuzzy" as const;

export const CORPUS_FUZZY_DEDUP_DOC_LIMIT = BASELINE_NEAR_DUP_DOC_SCAN_LIMIT;
export const CORPUS_DEFAULT_FUZZY_THRESHOLD =
  BASELINE_NEAR_DUP_DEFAULT_THRESHOLD;

export {
  computeSimHash64Hex,
  simHashSimilarityHex,
  BASELINE_NEAR_DUP_DEFAULT_THRESHOLD,
};

export type DecontamDocument = CorpusDocumentHashCandidate;

export type DecontamProof = {
  status: "skipped" | "passed" | "failed";
  method:
    | typeof DECONTAM_METHOD_EXACT_HASH
    | typeof DECONTAM_METHOD_EXACT_AND_NEAR_DUP;
  baselineRegistryRelpath?: string;
  checkedHashCount: number;
  registryHashCount: number;
  nearDupCheckedDocCount?: number;
  nearDupBaselineFingerprintCount?: number;
  offendingDocIds?: string[];
  collidingSetId?: string;
};

export type ExactHashDecontamOptions = {
  /** Absolute or package-relative path to baseline_registry.json. */
  registryPath: string;
  /** Repo-relative path recorded in the proof / report. */
  baselineRegistryRelpath?: string;
  documents: readonly DecontamDocument[];
  deviceId?: string;
  onRegistryTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
};

export type ExactHashDecontamResult =
  | { ok: true; proof: DecontamProof; document: BaselineRegistryDocument }
  | {
      ok: false;
      proof: DecontamProof;
      message: string;
      failureClass: "contamination" | "config" | "schema";
      offendingDocIds: string[];
    };

/**
 * Resolve the baseline registry path from a manifest pin + package/repo roots.
 */
export function resolveCorpusBaselineRegistryPath(
  baselineRegistryRelpath: string,
  packageRoot: string,
): string {
  if (path.isAbsolute(baselineRegistryRelpath)) {
    return baselineRegistryRelpath;
  }
  const fromRepo = path.resolve(
    packageRoot,
    "..",
    "..",
    baselineRegistryRelpath,
  );
  if (existsSync(fromRepo)) return fromRepo;
  const fromPackage = path.resolve(packageRoot, baselineRegistryRelpath);
  if (existsSync(fromPackage)) return fromPackage;
  // Prefer repo-layout path even when missing (clearer failure).
  return fromRepo;
}

export function defaultBaselineRegistryRelpath(): string {
  return BASELINE_REGISTRY_RELPATH;
}

export function resolveCorpusRepoRoot(packageRoot: string): string {
  return path.resolve(packageRoot, "..", "..");
}

/**
 * Exact-hash check against an already-loaded registry document.
 * Builds the decontamination proof for the corpus build report.
 */
export function exactHashCheckDocuments(
  document: BaselineRegistryDocument,
  documents: readonly DecontamDocument[],
  meta: {
    baselineRegistryRelpath: string;
    deviceId?: string;
    onRegistryTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  },
): ExactHashDecontamResult {
  const exported = exportRegisteredBaselineHashes(document, {
    ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
    ...(meta.onRegistryTelemetry !== undefined
      ? { onTelemetry: meta.onRegistryTelemetry }
      : {}),
  });
  if (!exported.ok) {
    return {
      ok: false,
      message: exported.detail,
      failureClass: "schema",
      offendingDocIds: [],
      proof: {
        status: "failed",
        method: DECONTAM_METHOD_EXACT_HASH,
        baselineRegistryRelpath: meta.baselineRegistryRelpath,
        checkedHashCount: 0,
        registryHashCount: 0,
      },
    };
  }

  const check = assertCorpusDocumentsExactHashDecontaminated(
    document,
    documents,
    {
      ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
      ...(meta.onRegistryTelemetry !== undefined
        ? { onTelemetry: meta.onRegistryTelemetry }
        : {}),
    },
  );

  if (!check.ok) {
    return {
      ok: false,
      message: check.detail,
      failureClass: "contamination",
      offendingDocIds: check.offendingDocIds,
      proof: {
        status: "failed",
        method: DECONTAM_METHOD_EXACT_HASH,
        baselineRegistryRelpath: meta.baselineRegistryRelpath,
        checkedHashCount: documents.length,
        registryHashCount: exported.export.contentHashes.length,
        offendingDocIds: check.offendingDocIds,
        collidingSetId: check.setId,
      },
    };
  }

  return {
    ok: true,
    document,
    proof: {
      status: "passed",
      method: DECONTAM_METHOD_EXACT_HASH,
      baselineRegistryRelpath: meta.baselineRegistryRelpath,
      checkedHashCount: check.checkedHashCount,
      registryHashCount: check.registryHashCount,
    },
  };
}

/**
 * Run exact-hash decontamination: every registered C0 eval hash is checked;
 * any document collision fails with offending doc ids.
 */
export function runExactHashDecontamination(
  options: ExactHashDecontamOptions,
): ExactHashDecontamResult {
  const relpath =
    options.baselineRegistryRelpath ??
    (path.isAbsolute(options.registryPath)
      ? options.registryPath
      : BASELINE_REGISTRY_RELPATH);

  const loaded = loadBaselineRegistryDocumentFromFile(options.registryPath, {
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onRegistryTelemetry !== undefined
      ? { onTelemetry: options.onRegistryTelemetry }
      : {}),
  });

  if (!loaded.ok) {
    const failureClass =
      loaded.failureClass === "schema_violation" ||
      loaded.failureClass === "append_only_violation"
        ? "schema"
        : "config";
    return {
      ok: false,
      message: loaded.detail,
      failureClass,
      offendingDocIds: [],
      proof: {
        status: "failed",
        method: DECONTAM_METHOD_EXACT_HASH,
        baselineRegistryRelpath: relpath,
        checkedHashCount: 0,
        registryHashCount: 0,
      },
    };
  }

  return exactHashCheckDocuments(loaded.document, options.documents, {
    baselineRegistryRelpath: relpath,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onRegistryTelemetry !== undefined
      ? { onRegistryTelemetry: options.onRegistryTelemetry }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Within-corpus SimHash fuzzy dedup (drop near-dups; fill dedup report)
// ---------------------------------------------------------------------------

export type FuzzyDedupDocument = {
  docId: string;
  text: string;
  laneCode: string;
  contentHash: string;
};

export type FuzzyDedupDrop = {
  docId: string;
  laneCode: string;
  reason: "exact_hash" | "simhash_near_dup";
  keptDocId: string;
  similarity: number;
};

export type FuzzyDedupReport = {
  schemaVersion: "training.corpus-dedup-report.v1";
  status: "recorded";
  algorithm: typeof DEDUP_ALGORITHM_SHA256 | typeof DEDUP_ALGORITHM_SHA256_FUZZY;
  fuzzyThreshold: number;
  laneThresholds: Record<string, number>;
  inputDocCount: number;
  keptDocCount: number;
  droppedDocIds: string[];
  drops: FuzzyDedupDrop[];
};

export type FuzzyDedupResult =
  | {
      ok: true;
      kept: FuzzyDedupDocument[];
      report: FuzzyDedupReport;
    }
  | {
      ok: false;
      message: string;
      failureClass: "dedup" | "schema";
    };

export function resolveLaneFuzzyThreshold(
  laneCode: string,
  defaultThreshold: number,
  laneThresholds: Readonly<Record<string, number>> | undefined,
): number {
  const override = laneThresholds?.[laneCode];
  if (typeof override === "number" && override >= 0 && override <= 1) {
    return override;
  }
  return defaultThreshold;
}

/**
 * Deterministic within-corpus dedup: exact content hash, then SimHash near-dup
 * within each lane using that lane's threshold. Keeps the lowest docId.
 */
export function runFuzzyNearDupDedup(
  documents: readonly FuzzyDedupDocument[],
  options: {
    algorithm?:
      | typeof DEDUP_ALGORITHM_SHA256
      | typeof DEDUP_ALGORITHM_SHA256_FUZZY;
    fuzzyThreshold?: number;
    laneThresholds?: Readonly<Record<string, number>>;
  } = {},
): FuzzyDedupResult {
  if (documents.length > CORPUS_FUZZY_DEDUP_DOC_LIMIT) {
    return {
      ok: false,
      message: `fuzzy dedup exceeds ${CORPUS_FUZZY_DEDUP_DOC_LIMIT} documents`,
      failureClass: "dedup",
    };
  }

  const algorithm = options.algorithm ?? DEDUP_ALGORITHM_SHA256_FUZZY;
  const fuzzyThreshold =
    options.fuzzyThreshold ?? CORPUS_DEFAULT_FUZZY_THRESHOLD;
  if (fuzzyThreshold < 0 || fuzzyThreshold > 1) {
    return {
      ok: false,
      message: `fuzzyThreshold must be in [0,1], got ${fuzzyThreshold}`,
      failureClass: "schema",
    };
  }

  const laneThresholds: Record<string, number> = {
    ...(options.laneThresholds ?? {}),
  };
  const sorted = [...documents].sort((a, b) => {
    const lane = a.laneCode.localeCompare(b.laneCode);
    if (lane !== 0) return lane;
    return a.docId.localeCompare(b.docId);
  });

  const kept: FuzzyDedupDocument[] = [];
  const drops: FuzzyDedupDrop[] = [];
  const byLane = new Map<
    string,
    { doc: FuzzyDedupDocument; simHash: string }[]
  >();

  for (const doc of sorted) {
    const laneKept = byLane.get(doc.laneCode) ?? [];
    const exactHit = laneKept.find(
      (k) => k.doc.contentHash === doc.contentHash,
    );
    if (exactHit) {
      drops.push({
        docId: doc.docId,
        laneCode: doc.laneCode,
        reason: "exact_hash",
        keptDocId: exactHit.doc.docId,
        similarity: 1,
      });
      continue;
    }

    const simHash = computeSimHash64Hex(doc.text);
    if (algorithm === DEDUP_ALGORITHM_SHA256_FUZZY) {
      const threshold = resolveLaneFuzzyThreshold(
        doc.laneCode,
        fuzzyThreshold,
        laneThresholds,
      );
      let nearHit:
        | { doc: FuzzyDedupDocument; simHash: string; similarity: number }
        | undefined;
      for (const k of laneKept) {
        const similarity = simHashSimilarityHex(simHash, k.simHash);
        if (similarity >= threshold) {
          nearHit = { ...k, similarity };
          break;
        }
      }
      if (nearHit) {
        drops.push({
          docId: doc.docId,
          laneCode: doc.laneCode,
          reason: "simhash_near_dup",
          keptDocId: nearHit.doc.docId,
          similarity: nearHit.similarity,
        });
        continue;
      }
    }

    laneKept.push({ doc, simHash });
    byLane.set(doc.laneCode, laneKept);
    kept.push(doc);
  }

  const droppedDocIds = drops
    .map((d) => d.docId)
    .sort((a, b) => a.localeCompare(b));

  return {
    ok: true,
    kept,
    report: {
      schemaVersion: "training.corpus-dedup-report.v1",
      status: "recorded",
      algorithm,
      fuzzyThreshold,
      laneThresholds: Object.fromEntries(
        [...Object.keys(laneThresholds)]
          .sort((a, b) => a.localeCompare(b))
          .map((k) => [k, laneThresholds[k]!]),
      ),
      inputDocCount: documents.length,
      keptDocCount: kept.length,
      droppedDocIds,
      drops: [...drops].sort((a, b) => a.docId.localeCompare(b.docId)),
    },
  };
}

export type NearDupBaselineCheckOptions = {
  document: BaselineRegistryDocument;
  repoRoot: string;
  documents: readonly CorpusNearDupCandidate[];
  baselineRegistryRelpath: string;
  fuzzyThreshold?: number;
  laneThresholds?: Readonly<Record<string, number>>;
  deviceId?: string;
  onRegistryTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  /** Prior exact-hash proof to merge method/counts into. */
  exactProof?: DecontamProof;
};

/**
 * SimHash near-dup check against C0 baseline sources (build failure on hit).
 */
export function nearDupCheckAgainstBaselines(
  options: NearDupBaselineCheckOptions,
): ExactHashDecontamResult {
  const threshold = options.fuzzyThreshold ?? CORPUS_DEFAULT_FUZZY_THRESHOLD;
  const check = assertCorpusDocumentsNearDupDecontaminated(
    options.document,
    options.documents,
    {
      repoRoot: options.repoRoot,
      threshold,
      ...(options.laneThresholds !== undefined
        ? { laneThresholds: options.laneThresholds }
        : {}),
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(options.onRegistryTelemetry !== undefined
        ? { onTelemetry: options.onRegistryTelemetry }
        : {}),
    },
  );

  const baseProof: DecontamProof = options.exactProof ?? {
    status: "passed",
    method: DECONTAM_METHOD_EXACT_HASH,
    baselineRegistryRelpath: options.baselineRegistryRelpath,
    checkedHashCount: 0,
    registryHashCount: 0,
  };

  if (!check.ok) {
    return {
      ok: false,
      message: check.detail,
      failureClass: "contamination",
      offendingDocIds: check.offendingDocIds,
      proof: {
        ...baseProof,
        status: "failed",
        method: DECONTAM_METHOD_EXACT_AND_NEAR_DUP,
        nearDupCheckedDocCount: options.documents.length,
        offendingDocIds: check.offendingDocIds,
        collidingSetId: check.setId,
      },
    };
  }

  return {
    ok: true,
    document: options.document,
    proof: {
      ...baseProof,
      status: "passed",
      method: DECONTAM_METHOD_EXACT_AND_NEAR_DUP,
      nearDupCheckedDocCount: check.checkedDocCount,
      nearDupBaselineFingerprintCount: check.baselineFingerprintCount,
    },
  };
}

// ---------------------------------------------------------------------------
// CI gate: seeded contaminated fixture (red) + clean sample (green)
// ---------------------------------------------------------------------------

export type SeededContaminatedCorpus = {
  workspaceRoot: string;
  manifestPath: string;
  outDir: string;
  contaminatedSourceRelpath: string;
  contentHash: string;
};

/**
 * Materialize a temp corpus workspace whose source bytes exactly match a
 * registered eval artifact (seeded train-on-eval). Used only by the CI prove.
 */
export function seedContaminatedCorpusWorkspace(options: {
  workspaceRoot: string;
  /** Absolute path to a registered baseline source file (e.g. smoke-baseline.json). */
  evalArtifactAbsPath: string;
  baselineRegistryRelpath: string;
}): SeededContaminatedCorpus {
  const srcDir = path.join(options.workspaceRoot, "fixtures", "sources");
  mkdirSync(srcDir, { recursive: true });
  const contaminatedSourceRelpath = "fixtures/sources/contam-eval-overlap.jsonl";
  const contamAbs = path.join(
    options.workspaceRoot,
    ...contaminatedSourceRelpath.split("/"),
  );
  cpSync(options.evalArtifactAbsPath, contamAbs);
  const bytes = readFileSync(contamAbs);
  const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  const manifest = {
    schemaVersion: "training.corpus-manifest.v1",
    manifestId: "corpus.ci.decontam.contaminated",
    version: "1.0.0-ci-seed",
    title: "CI seeded eval-overlap (must fail decontam)",
    consentClass: "synthetic",
    laneCodes: ["smoke"],
    knowledgeModes: ["UND"],
    sources: [
      {
        sourceId: "src.ci.contam.smoke",
        relpath: contaminatedSourceRelpath,
        licenseId: "lic.cc-by-4.0",
        knowledgeMode: "UND",
        laneCode: "smoke",
        contentHash,
      },
    ],
    filters: [
      {
        filterId: "flt.exclude-unknown-license",
        kind: "exclude_unknown_license",
      },
      {
        filterId: "flt.exclude-eval-overlap",
        kind: "exclude_eval_overlap",
      },
    ],
    dedupReport: {
      status: "pending",
      algorithm: "sha256",
      fuzzyThreshold: 0.92,
    },
    licenseLedger: [
      { licenseId: "lic.cc-by-4.0", spdxOrLabel: "CC-BY-4.0", licenseClass: "open" },
    ],
    weightTrainingPolicy: {
      excludeKnowledgeModes: ["RET"],
      requireKnownLicense: true,
    },
    determinism: {
      canonicalSort: true,
      contentAddressedShards: true,
      forbidWallClockInShardBytes: true,
    },
    decontaminationProof: {
      status: "pending",
      baselineRegistryRelpath: options.baselineRegistryRelpath,
    },
  };

  const manifestPath = path.join(
    options.workspaceRoot,
    "fixtures",
    "contaminated.json",
  );
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const outDir = path.join(options.workspaceRoot, "out-contaminated");
  return {
    workspaceRoot: options.workspaceRoot,
    manifestPath,
    outDir,
    contaminatedSourceRelpath,
    contentHash,
  };
}

/**
 * Validate a green build's decontamination proof against the loaded registry.
 */
export function verifyDecontamProofInBuildReport(
  document: BaselineRegistryDocument,
  decontamination: {
    status: string;
    method?: string;
    checkedHashCount?: number;
    registryHashCount?: number;
    nearDupCheckedDocCount?: number;
  },
  options: {
    deviceId?: string;
    requireNearDup?: boolean;
  } = {},
):
  | { ok: true; registryHashCount: number }
  | { ok: false; message: string } {
  const checked = assertCorpusBuildDecontamProof(document, decontamination, {
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.requireNearDup !== undefined
      ? { requireNearDup: options.requireNearDup }
      : {}),
  });
  if (!checked.ok) {
    return { ok: false, message: checked.detail };
  }
  return { ok: true, registryHashCount: checked.registryHashCount };
}
