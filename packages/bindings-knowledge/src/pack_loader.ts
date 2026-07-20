/**
 * PackKnowledgeConnector — KnowledgeConnectorInterface over a local pack directory.
 *
 * Loads via validatePack (citations + optional vector index). retrieve() supports
 * keyword scoring and optional vector cosine when embeddings.bin is present.
 * describe() surfaces bundled-offline locality + truthful pack asOf + sources.
 *
 * Packs are DATA — this module never imports domains/.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  KnowledgeConnectorDescribe,
  KnowledgeConnectorInterface,
  KnowledgePassage,
  KnowledgeQuery,
  KnowledgeSourceDescriptor,
} from "@moolam/contracts";
import {
  KNOWLEDGE_PACKAGE_ROOT,
  PACK_VECTOR_EMBEDDINGS_RELPATH,
  type PackFailureClass,
  type PackFormatTelemetry,
  type PackManifest,
  type PackPassage,
  type PackVectorIndex,
} from "./pack_format.js";
import { validatePack } from "./pack_validator.js";

/** Bounded retrieve result set (NFR / scalability). */
export const PACK_RETRIEVE_LIMIT_DEFAULT = 8;
export const PACK_RETRIEVE_LIMIT_MAX = 64;
/** Cap in-memory passage corpus scanned per retrieve. */
export const PACK_CORPUS_SCAN_LIMIT = 8192;

export type PackLoaderTelemetry = {
  event: "bindings_knowledge.pack_loader";
  op: "load" | "retrieve" | "describe";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  packId?: string;
  failureClass?: PackFailureClass | "query";
  detail?: string;
  passageCount?: number;
  hitCount?: number;
};

export class PackLoadError extends Error {
  readonly failureClass: PackFailureClass;
  readonly missingPath?: string;
  readonly code: string;

  constructor(
    message: string,
    failureClass: PackFailureClass,
    extras?: { missingPath?: string; code?: string },
  ) {
    super(message);
    this.name = "PackLoadError";
    this.failureClass = failureClass;
    this.code = extras?.code ?? failureClass;
    if (extras?.missingPath !== undefined) this.missingPath = extras.missingPath;
  }
}

type IndexedPassage = {
  passageId: string;
  sourceId: string;
  citation: string;
  content: string;
  asOf: string;
  /** Row into embeddings matrix when vector index is present. */
  vectorIndex?: number;
};

function emit(
  onTelemetry: ((e: PackLoaderTelemetry) => void) | undefined,
  partial: Omit<PackLoaderTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "bindings_knowledge.pack_loader",
    ...partial,
  });
}

/** Deterministic L2-normalized char-histogram embed (matches mock grade). */
export function packEmbedText(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  const bounded = text.slice(0, 4096);
  for (let i = 0; i < bounded.length; i++) {
    v[bounded.charCodeAt(i)! % dim]! += 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Simple keyword overlap in [0,1] when no vector index is available. */
export function keywordScore(query: string, content: string): number {
  const qTokens = tokenize(query);
  if (qTokens.size === 0) return 0;
  const cTokens = tokenize(content);
  let hit = 0;
  for (const t of qTokens) {
    if (cTokens.has(t)) hit += 1;
  }
  return hit / qTokens.size;
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().match(/[a-z0-9\u0900-\u097f]+/g) ?? []) {
    if (m.length >= 2) out.add(m);
  }
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export type PackKnowledgeConnectorOptions = {
  packRoot: string;
  subjectId?: string;
  deviceId?: string;
  nowMs?: number;
  onTelemetry?: (e: PackLoaderTelemetry | PackFormatTelemetry) => void;
};

/**
 * Local pack-backed knowledge connector.
 * Implements KnowledgeConnectorInterface; describe() is required on this class.
 */
export class PackKnowledgeConnector implements KnowledgeConnectorInterface {
  readonly sources: KnowledgeSourceDescriptor[];
  readonly packRoot: string;
  readonly packId: string;
  readonly version: string;
  readonly locality: KnowledgeSourceDescriptor["locality"];
  readonly asOf: string;
  readonly languages: readonly string[];

  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly onTelemetry?: (
    e: PackLoaderTelemetry | PackFormatTelemetry,
  ) => void;
  private readonly corpus: IndexedPassage[];
  private readonly embeddings: Float32Array[] | null;
  private readonly embedDim: number | null;
  private readonly sourceIdSet: Set<string>;

  private constructor(args: {
    packRoot: string;
    manifest: PackManifest;
    corpus: IndexedPassage[];
    embeddings: Float32Array[] | null;
    embedDim: number | null;
    subjectId: string;
    deviceId: string;
    onTelemetry?: (e: PackLoaderTelemetry | PackFormatTelemetry) => void;
  }) {
    this.packRoot = args.packRoot;
    this.packId = args.manifest.packId;
    this.version = args.manifest.version;
    this.locality = args.manifest.locality;
    this.asOf = args.manifest.asOf;
    this.languages = Object.freeze([...args.manifest.languages]);
    this.sources = Object.freeze(
      args.manifest.sources.map((s) => ({
        sourceId: s.sourceId,
        title: s.title,
        domain: s.domain,
        locality: s.locality,
        coverage: { from: s.coverage.from, to: s.coverage.to },
      })),
    ) as KnowledgeSourceDescriptor[];
    this.sourceIdSet = new Set(this.sources.map((s) => s.sourceId));
    this.corpus = args.corpus;
    this.embeddings = args.embeddings;
    this.embedDim = args.embedDim;
    this.subjectId = args.subjectId;
    this.deviceId = args.deviceId;
    if (args.onTelemetry !== undefined) this.onTelemetry = args.onTelemetry;
  }

  /**
   * Load and validate a pack directory. Throws PackLoadError naming missing
   * shards / validation failures — never returns a half-loaded connector.
   */
  static load(options: PackKnowledgeConnectorOptions): PackKnowledgeConnector {
    const subjectId = options.subjectId?.trim() || "subj.pack.loader";
    const deviceId = options.deviceId?.trim() || "dev-pack-loader";
    const tel =
      options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {};
    const nowOpt =
      options.nowMs !== undefined ? { nowMs: options.nowMs } : {};

    const validated = validatePack(options.packRoot, {
      subjectId,
      deviceId,
      ...nowOpt,
      ...tel,
    });

    if (!validated.ok) {
      const missing =
        validated.failureClass === "config" &&
        /missing/i.test(validated.message)
          ? validated.message
          : undefined;
      emit(options.onTelemetry as ((e: PackLoaderTelemetry) => void) | undefined, {
        op: "load",
        outcome: "error",
        subjectId,
        deviceId,
        failureClass: validated.failureClass,
        detail: validated.message,
      });
      throw new PackLoadError(validated.message, validated.failureClass, {
        ...(missing ? { missingPath: missing, code: "missing_shard" } : {}),
      });
    }

    const { manifest, shards, vectorIndex, packRoot } = validated.value;
    const corpus: IndexedPassage[] = [];
    const passageById = new Map<string, IndexedPassage>();

    for (const shard of shards) {
      for (const p of shard.passages) {
        const indexed = indexPassage(p);
        if (!manifest.sources.some((s) => s.sourceId === indexed.sourceId)) {
          emit(options.onTelemetry as ((e: PackLoaderTelemetry) => void) | undefined, {
            op: "load",
            outcome: "error",
            subjectId,
            deviceId,
            packId: manifest.packId,
            failureClass: "citation",
            detail: `uncited sourceId ${indexed.sourceId}`,
          });
          throw new PackLoadError(
            `passage '${indexed.passageId}' citation.sourceId not in manifest sources`,
            "citation",
          );
        }
        corpus.push(indexed);
        passageById.set(indexed.passageId, indexed);
        if (corpus.length >= PACK_CORPUS_SCAN_LIMIT) break;
      }
      if (corpus.length >= PACK_CORPUS_SCAN_LIMIT) break;
    }

    let embeddings: Float32Array[] | null = null;
    let embedDim: number | null = null;

    if (vectorIndex) {
      const loaded = loadEmbeddingRows(packRoot, vectorIndex, passageById);
      embeddings = loaded.rows;
      embedDim = loaded.dim;
      for (const entry of vectorIndex.idMap.entries) {
        const row = passageById.get(entry.passageId);
        if (row && entry.vectorIndex !== undefined) {
          row.vectorIndex = entry.vectorIndex;
        }
      }
    }

    const connector = new PackKnowledgeConnector({
      packRoot,
      manifest,
      corpus,
      embeddings,
      embedDim,
      subjectId,
      deviceId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });

    emit(options.onTelemetry as ((e: PackLoaderTelemetry) => void) | undefined, {
      op: "load",
      outcome: "ok",
      subjectId,
      deviceId,
      packId: manifest.packId,
      passageCount: corpus.length,
    });

    return connector;
  }

  describe(): KnowledgeConnectorDescribe {
    emit(this.onTelemetry as ((e: PackLoaderTelemetry) => void) | undefined, {
      op: "describe",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      packId: this.packId,
    });
    return {
      locality: this.locality,
      asOf: this.asOf,
      sources: this.sources,
      packId: this.packId,
      version: this.version,
      languages: this.languages,
    };
  }

  async retrieve(query: KnowledgeQuery): Promise<KnowledgePassage[]> {
    const q = typeof query.query === "string" ? query.query : "";
    const limit = Math.min(
      Math.max(1, query.limit ?? PACK_RETRIEVE_LIMIT_DEFAULT),
      PACK_RETRIEVE_LIMIT_MAX,
    );

    try {
      const allowedSources =
        query.sourceIds && query.sourceIds.length > 0
          ? new Set(query.sourceIds.filter((id) => this.sourceIdSet.has(id)))
          : null;

      if (allowedSources && allowedSources.size === 0) {
        emit(this.onTelemetry as ((e: PackLoaderTelemetry) => void) | undefined, {
          op: "retrieve",
          outcome: "ok",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          packId: this.packId,
          hitCount: 0,
          passageCount: this.corpus.length,
        });
        return [];
      }

      const scored: KnowledgePassage[] = [];
      const useVector =
        this.embeddings !== null &&
        this.embedDim !== null &&
        this.embedDim > 0;
      const qVec = useVector
        ? packEmbedText(q, this.embedDim!)
        : null;

      for (const row of this.corpus) {
        if (allowedSources && !allowedSources.has(row.sourceId)) continue;

        const kw = keywordScore(q, row.content);
        let score = kw;
        if (useVector && qVec && row.vectorIndex !== undefined) {
          const emb = this.embeddings![row.vectorIndex];
          if (emb) {
            const vs = clamp01(cosine(qVec, emb));
            // Keyword admits the hit; vector re-ranks. Near-duplicate vector
            // alone (vs ≥ 0.95) may admit without keyword tokens.
            if (kw > 0) score = Math.max(kw, vs);
            else if (vs >= 0.95) score = vs;
            else score = 0;
          }
        }

        if (score <= 0) continue;
        scored.push({
          sourceId: row.sourceId,
          citation: row.citation,
          content: row.content,
          score,
          asOf: row.asOf,
        });
      }

      scored.sort((a, b) => b.score - a.score || a.citation.localeCompare(b.citation));

      // CK-09.2: bundled-offline must answer from the local index when offline;
      // degraded cited hits beat an empty result (never fabricate new content).
      if (scored.length === 0 && this.locality === "bundled-offline") {
        for (const row of this.corpus) {
          if (allowedSources && !allowedSources.has(row.sourceId)) continue;
          scored.push({
            sourceId: row.sourceId,
            citation: row.citation,
            content: row.content,
            score: 0.05,
            asOf: row.asOf,
          });
        }
        scored.sort(
          (a, b) => b.score - a.score || a.citation.localeCompare(b.citation),
        );
      }

      const out = scored.slice(0, limit);

      emit(this.onTelemetry as ((e: PackLoaderTelemetry) => void) | undefined, {
        op: "retrieve",
        outcome: "ok",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        packId: this.packId,
        hitCount: out.length,
        passageCount: this.corpus.length,
      });
      return out;
    } catch (err) {
      emit(this.onTelemetry as ((e: PackLoaderTelemetry) => void) | undefined, {
        op: "retrieve",
        outcome: "error",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        packId: this.packId,
        failureClass: "query",
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

function indexPassage(p: PackPassage): IndexedPassage {
  return {
    passageId: p.passageId,
    sourceId: p.citation.sourceId,
    citation: p.citation.locator,
    content: p.content,
    asOf: p.asOf,
  };
}

function loadEmbeddingRows(
  packRoot: string,
  vectorIndex: PackVectorIndex,
  passageById: Map<string, IndexedPassage>,
): { rows: Float32Array[]; dim: number } {
  const embRel = vectorIndex.embeddingsRelpath || PACK_VECTOR_EMBEDDINGS_RELPATH;
  const embPath = path.join(packRoot, embRel);
  if (!existsSync(embPath)) {
    throw new PackLoadError(
      `embeddings missing at ${embRel}`,
      "vector",
      { missingPath: embPath, code: "missing_embeddings" },
    );
  }
  const buf = readFileSync(embPath);
  const dim = vectorIndex.dimensions;
  const rowCount = vectorIndex.rowCount;
  const expected = rowCount * dim * 4;
  if (buf.byteLength !== expected) {
    throw new PackLoadError(
      `embeddings.bin byte length ${buf.byteLength} !== expected ${expected}`,
      "vector",
    );
  }
  const rows: Float32Array[] = new Array(rowCount);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let r = 0; r < rowCount; r++) {
    const row = new Float32Array(dim);
    for (let d = 0; d < dim; d++) {
      row[d] = view.getFloat32((r * dim + d) * 4, true);
    }
    // L2-normalize for cosine with query embeds.
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += row[d]! * row[d]!;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) row[d] = row[d]! / norm;
    rows[r] = row;
  }
  // Ensure every vector row maps to a known passage (already validated at pack time).
  for (const entry of vectorIndex.idMap.entries) {
    if (!passageById.has(entry.passageId)) {
      throw new PackLoadError(
        `orphan vector passageId '${entry.passageId}'`,
        "vector",
      );
    }
  }
  return { rows, dim };
}

/** Convenience alias matching create* factory style used elsewhere. */
export function createPackKnowledgeConnector(
  options: PackKnowledgeConnectorOptions,
): PackKnowledgeConnector {
  return PackKnowledgeConnector.load(options);
}

/** Repo-relative pack directory for the teacher CBSE slice example. */
export const TEACHER_CBSE_SLICE_PACK_RELPATH = path.join(
  "knowledge-packs",
  "teacher-cbse-slice",
);

export const TEACHER_CBSE_SLICE_PACK_ID = "pack.teacher.cbse-slice";

/**
 * Resolve `knowledge-packs/teacher-cbse-slice/` from the monorepo root.
 * Packs are DATA — never import `domains/teacher`.
 */
export function resolveTeacherCbseSlicePackRoot(
  repoRoot: string = path.resolve(KNOWLEDGE_PACKAGE_ROOT, "..", ".."),
): string {
  return path.resolve(repoRoot, TEACHER_CBSE_SLICE_PACK_RELPATH);
}

/**
 * Load the teacher CBSE slice pack as a KnowledgeConnectorInterface.
 * Used by CognitiveCore examples (teacher-basic) and wiring proofs.
 */
export function loadTeacherCbseSliceConnector(
  options: Omit<PackKnowledgeConnectorOptions, "packRoot"> & {
    packRoot?: string;
    repoRoot?: string;
  } = {},
): PackKnowledgeConnector {
  const packRoot =
    options.packRoot ??
    resolveTeacherCbseSlicePackRoot(options.repoRoot);
  const { packRoot: _p, repoRoot: _r, ...rest } = options;
  return PackKnowledgeConnector.load({
    ...rest,
    packRoot,
  });
}

/** Repo-relative pack directory for the doctor formulary sketch. */
export const DOCTOR_FORMULARY_SKETCH_PACK_RELPATH = path.join(
  "knowledge-packs",
  "doctor-formulary-sketch",
);

export const DOCTOR_FORMULARY_SKETCH_PACK_ID =
  "pack.doctor.formulary-sketch";

/**
 * Resolve `knowledge-packs/doctor-formulary-sketch/` from the monorepo root.
 * Packs are DATA — never import `domains/doctor`.
 */
export function resolveDoctorFormularySketchPackRoot(
  repoRoot: string = path.resolve(KNOWLEDGE_PACKAGE_ROOT, "..", ".."),
): string {
  return path.resolve(repoRoot, DOCTOR_FORMULARY_SKETCH_PACK_RELPATH);
}

/**
 * Load the doctor formulary sketch pack as a KnowledgeConnectorInterface.
 */
export function loadDoctorFormularySketchConnector(
  options: Omit<PackKnowledgeConnectorOptions, "packRoot"> & {
    packRoot?: string;
    repoRoot?: string;
  } = {},
): PackKnowledgeConnector {
  const packRoot =
    options.packRoot ??
    resolveDoctorFormularySketchPackRoot(options.repoRoot);
  const { packRoot: _p, repoRoot: _r, ...rest } = options;
  return PackKnowledgeConnector.load({
    ...rest,
    packRoot,
  });
}

