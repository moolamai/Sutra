/**
 * Knowledge pack v1 format: manifest + content shards.
 *
 * Schemas live under packages/bindings-knowledge/schemas/pack-v1.json.
 * Zod validators parse shapes; cross-field checks enforce resolvable
 * citations (via the manifest source table) and truthful asOf
 * (must not postdate builtAt / the check clock).
 *
 * Packs are DATA artifacts — this package never imports domains/.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const KNOWLEDGE_PACKAGE_ROOT = path.resolve(__dirname, "..");

export const PACK_V1_SCHEMA_VERSION = "bindings-knowledge.pack-v1" as const;
export const PACK_V1_JSON_SCHEMA_PATH = path.join(
  KNOWLEDGE_PACKAGE_ROOT,
  "schemas",
  "pack-v1.json",
);

/** Scalability bounds (NFR / bounded scans). */
export const PACK_PASSAGE_CONTENT_MAX_CHARS = 32_000;
export const PACK_SHARD_PASSAGE_LIMIT = 512;
export const PACK_SOURCES_LIMIT = 64;
export const PACK_LANGUAGES_LIMIT = 32;
export const PACK_SHARDS_LIMIT = 64;
export const PACK_CITATION_LOCATOR_MAX = 512;
export const PACK_VECTOR_ENTRIES_LIMIT = 8192;
/** Default relative path for optional vector id map (orphan checks). */
export const PACK_VECTOR_ID_MAP_RELPATH = "vectors/id-map.json";
/** Default relative path for optional float32 embeddings blob. */
export const PACK_VECTOR_EMBEDDINGS_RELPATH = "vectors/embeddings.bin";
export const PACK_VECTOR_DIM_MIN = 8;
export const PACK_VECTOR_DIM_MAX = 4096;
export const PACK_VECTOR_DTYPE_BYTES = {
  float32: 4,
} as const;
export type PackVectorDtype = keyof typeof PACK_VECTOR_DTYPE_BYTES;

export type PackFailureClass =
  | "schema"
  | "citation"
  | "asOf"
  | "size"
  | "config"
  | "duplicate"
  | "vector";

export type PackFormatTelemetry = {
  event: "bindings_knowledge.pack_format";
  op:
    | "parse_manifest"
    | "parse_shard"
    | "validate_shard"
    | "validate_pack"
    | "parse_vector_map"
    | "validate_vector_index"
    | "load_schema";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  packId?: string;
  shardId?: string;
  failureClass?: PackFailureClass;
  detail?: string;
  passageCount?: number;
  shardCount?: number;
  vectorRowCount?: number;
  dimensions?: number;
};

export class PackFormatError extends Error {
  readonly failureClass: PackFailureClass;
  readonly code: string;
  readonly path?: string;

  constructor(
    message: string,
    failureClass: PackFailureClass,
    extras?: { code?: string; path?: string },
  ) {
    super(message);
    this.name = "PackFormatError";
    this.failureClass = failureClass;
    this.code = extras?.code ?? failureClass;
    if (extras?.path !== undefined) this.path = extras.path;
  }
}

const isoStamp = z.string().min(4).max(64);

export const packSourceSchema = z.object({
  sourceId: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  domain: z.string().min(1).max(128),
  locality: z.enum(["bundled-offline", "self-hosted", "external-api"]),
  coverage: z.object({
    from: isoStamp,
    to: isoStamp,
  }),
});

export const packCitationSchema = z.object({
  citationId: z.string().min(1).max(128),
  sourceId: z.string().min(1).max(128),
  locator: z.string().min(1).max(PACK_CITATION_LOCATOR_MAX),
});

export const packPassageSchema = z.object({
  passageId: z.string().min(1).max(128),
  content: z.string().min(1).max(PACK_PASSAGE_CONTENT_MAX_CHARS),
  citation: packCitationSchema,
  asOf: isoStamp,
});

export const packManifestSchema = z.object({
  schemaVersion: z.literal(PACK_V1_SCHEMA_VERSION),
  packId: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  title: z.string().max(256).optional(),
  asOf: isoStamp,
  builtAt: isoStamp,
  locality: z.enum(["bundled-offline", "self-hosted"]),
  languages: z
    .array(z.string().min(2).max(32))
    .min(1)
    .max(PACK_LANGUAGES_LIMIT),
  sources: z.array(packSourceSchema).min(1).max(PACK_SOURCES_LIMIT),
  contentShards: z
    .array(
      z.object({
        shardId: z.string().min(1).max(128),
        relpath: z.string().min(1).max(256),
      }),
    )
    .min(1)
    .max(PACK_SHARDS_LIMIT),
});

export const packContentShardSchema = z.object({
  schemaVersion: z.literal(PACK_V1_SCHEMA_VERSION),
  shardId: z.string().min(1).max(128),
  passages: z
    .array(packPassageSchema)
    .min(1)
    .max(PACK_SHARD_PASSAGE_LIMIT),
});

export const packVectorIdMapEntrySchema = z.object({
  passageId: z.string().min(1).max(128),
  vectorIndex: z
    .number()
    .int()
    .min(0)
    .max(PACK_VECTOR_ENTRIES_LIMIT - 1)
    .optional(),
});

export const packVectorIdMapSchema = z.object({
  schemaVersion: z.literal(PACK_V1_SCHEMA_VERSION),
  /** When set with dtype, activates the full vector index layer (embeddings.bin required). */
  dimensions: z
    .number()
    .int()
    .min(PACK_VECTOR_DIM_MIN)
    .max(PACK_VECTOR_DIM_MAX)
    .optional(),
  dtype: z.enum(["float32"]).optional(),
  embeddingsRelpath: z.string().min(1).max(256).optional(),
  entries: z
    .array(packVectorIdMapEntrySchema)
    .min(1)
    .max(PACK_VECTOR_ENTRIES_LIMIT),
});

export type PackSource = z.infer<typeof packSourceSchema>;
export type PackCitation = z.infer<typeof packCitationSchema>;
export type PackPassage = z.infer<typeof packPassageSchema>;
export type PackManifest = z.infer<typeof packManifestSchema>;
export type PackContentShard = z.infer<typeof packContentShardSchema>;
export type PackVectorIdMap = z.infer<typeof packVectorIdMapSchema>;
export type PackVectorIdMapEntry = z.infer<typeof packVectorIdMapEntrySchema>;

/** Resolved vector index layer (id map + embeddings blob metadata). */
export type PackVectorIndex = {
  idMap: PackVectorIdMap;
  dimensions: number;
  dtype: PackVectorDtype;
  embeddingsRelpath: string;
  embeddingsByteLength: number;
  rowCount: number;
};

export type PackParseOk<T> = { ok: true; value: T };
export type PackParseFail = {
  ok: false;
  message: string;
  failureClass: PackFailureClass;
  path?: string;
};

function emit(
  onTelemetry: ((e: PackFormatTelemetry) => void) | undefined,
  partial: Omit<PackFormatTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "bindings_knowledge.pack_format",
    ...partial,
  });
}

/** Parse ISO-8601 asOf / builtAt to ms; throws PackFormatError on failure. */
export function parsePackStampMs(stamp: string): number {
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) {
    throw new PackFormatError(`unparseable stamp: ${stamp}`, "asOf", {
      code: "unparseable_stamp",
    });
  }
  return ms;
}

export function assertCommittedPackV1Schema(
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: PackFormatTelemetry) => void;
  } = {},
): { path: string; schemaVersion: string } {
  const subjectId = options.subjectId?.trim() || "subj.pack.schema";
  const deviceId = options.deviceId?.trim() || "dev-pack";
  if (!existsSync(PACK_V1_JSON_SCHEMA_PATH)) {
    emit(options.onTelemetry, {
      op: "load_schema",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail: "pack-v1.json missing",
    });
    throw new PackFormatError(
      `pack-v1 JSON schema missing at ${PACK_V1_JSON_SCHEMA_PATH}`,
      "config",
    );
  }
  const raw = JSON.parse(readFileSync(PACK_V1_JSON_SCHEMA_PATH, "utf8")) as {
    schemaVersion?: string;
  };
  if (raw.schemaVersion !== PACK_V1_SCHEMA_VERSION) {
    emit(options.onTelemetry, {
      op: "load_schema",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail: "schemaVersion mismatch",
    });
    throw new PackFormatError(
      `pack-v1 schemaVersion mismatch: expected ${PACK_V1_SCHEMA_VERSION}`,
      "config",
    );
  }
  emit(options.onTelemetry, {
    op: "load_schema",
    outcome: "ok",
    subjectId,
    deviceId,
  });
  return { path: PACK_V1_JSON_SCHEMA_PATH, schemaVersion: PACK_V1_SCHEMA_VERSION };
}

function zodFail(
  err: z.ZodError,
  failureClass: PackFailureClass = "schema",
): PackParseFail {
  const issue = err.issues[0];
  const pathLabel = issue?.path?.length
    ? issue.path.map(String).join(".")
    : undefined;
  return {
    ok: false,
    message: issue?.message ?? "schema validation failed",
    failureClass,
    ...(pathLabel ? { path: pathLabel } : {}),
  };
}

/**
 * Parse a pack v1 manifest. Rejects asOf that postdates builtAt.
 */
export function parsePackManifest(
  input: unknown,
  options: {
    subjectId?: string;
    deviceId?: string;
    /** Override check clock (ms); defaults to Date.now(). */
    nowMs?: number;
    onTelemetry?: (e: PackFormatTelemetry) => void;
  } = {},
): PackParseOk<PackManifest> | PackParseFail {
  const subjectId = options.subjectId?.trim() || "subj.pack.manifest";
  const deviceId = options.deviceId?.trim() || "dev-pack";
  const parsed = packManifestSchema.safeParse(input);
  if (!parsed.success) {
    const fail = zodFail(parsed.error);
    emit(options.onTelemetry, {
      op: "parse_manifest",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: fail.failureClass,
      detail: fail.message,
    });
    return fail;
  }
  const value = parsed.data;

  const sourceIds = new Set<string>();
  for (const src of value.sources) {
    if (sourceIds.has(src.sourceId)) {
      const fail: PackParseFail = {
        ok: false,
        message: `duplicate sourceId '${src.sourceId}' in manifest`,
        failureClass: "duplicate",
        path: "sources",
      };
      emit(options.onTelemetry, {
        op: "parse_manifest",
        outcome: "error",
        subjectId,
        deviceId,
        packId: value.packId,
        failureClass: "duplicate",
        detail: fail.message,
      });
      return fail;
    }
    sourceIds.add(src.sourceId);
  }

  const shardIds = new Set<string>();
  for (const shard of value.contentShards) {
    if (shardIds.has(shard.shardId)) {
      const fail: PackParseFail = {
        ok: false,
        message: `duplicate shardId '${shard.shardId}' in manifest`,
        failureClass: "duplicate",
        path: "contentShards",
      };
      emit(options.onTelemetry, {
        op: "parse_manifest",
        outcome: "error",
        subjectId,
        deviceId,
        packId: value.packId,
        failureClass: "duplicate",
        detail: fail.message,
      });
      return fail;
    }
    shardIds.add(shard.shardId);
  }

  try {
    const asOfMs = parsePackStampMs(value.asOf);
    const builtAtMs = parsePackStampMs(value.builtAt);
    const nowMs = options.nowMs ?? Date.now();
    if (asOfMs > builtAtMs) {
      const fail: PackParseFail = {
        ok: false,
        message: "manifest asOf postdates builtAt (untruthful)",
        failureClass: "asOf",
        path: "asOf",
      };
      emit(options.onTelemetry, {
        op: "parse_manifest",
        outcome: "error",
        subjectId,
        deviceId,
        packId: value.packId,
        failureClass: "asOf",
        detail: fail.message,
      });
      return fail;
    }
    if (asOfMs > nowMs || builtAtMs > nowMs) {
      const fail: PackParseFail = {
        ok: false,
        message: "manifest asOf/builtAt postdates the check clock (untruthful)",
        failureClass: "asOf",
        path: "asOf",
      };
      emit(options.onTelemetry, {
        op: "parse_manifest",
        outcome: "error",
        subjectId,
        deviceId,
        packId: value.packId,
        failureClass: "asOf",
        detail: fail.message,
      });
      return fail;
    }
  } catch (err) {
    const fail: PackParseFail = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      failureClass: "asOf",
    };
    emit(options.onTelemetry, {
      op: "parse_manifest",
      outcome: "error",
      subjectId,
      deviceId,
      packId: value.packId,
      failureClass: "asOf",
      detail: fail.message,
    });
    return fail;
  }

  emit(options.onTelemetry, {
    op: "parse_manifest",
    outcome: "ok",
    subjectId,
    deviceId,
    packId: value.packId,
  });
  return { ok: true, value };
}

/**
 * Parse a content shard. Enforces unique passageId / citationId within the shard
 * and content size bounds (via Zod max).
 */
export function parseContentShard(
  input: unknown,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: PackFormatTelemetry) => void;
  } = {},
): PackParseOk<PackContentShard> | PackParseFail {
  const subjectId = options.subjectId?.trim() || "subj.pack.shard";
  const deviceId = options.deviceId?.trim() || "dev-pack";
  const parsed = packContentShardSchema.safeParse(input);
  if (!parsed.success) {
    const sizeIssue = parsed.error.issues.some(
      (i) =>
        i.code === "too_big" ||
        String(i.message).toLowerCase().includes("too big"),
    );
    const fail = zodFail(parsed.error, sizeIssue ? "size" : "schema");
    emit(options.onTelemetry, {
      op: "parse_shard",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: fail.failureClass,
      detail: fail.message,
    });
    return fail;
  }
  const value = parsed.data;
  const passageIds = new Set<string>();
  const citationIds = new Set<string>();
  for (const p of value.passages) {
    if (passageIds.has(p.passageId)) {
      const fail: PackParseFail = {
        ok: false,
        message: `duplicate passageId '${p.passageId}' in shard`,
        failureClass: "duplicate",
        path: "passages",
      };
      emit(options.onTelemetry, {
        op: "parse_shard",
        outcome: "error",
        subjectId,
        deviceId,
        shardId: value.shardId,
        failureClass: "duplicate",
        detail: fail.message,
      });
      return fail;
    }
    passageIds.add(p.passageId);
    if (citationIds.has(p.citation.citationId)) {
      const fail: PackParseFail = {
        ok: false,
        message: `duplicate citationId '${p.citation.citationId}' in shard`,
        failureClass: "duplicate",
        path: "passages.citation",
      };
      emit(options.onTelemetry, {
        op: "parse_shard",
        outcome: "error",
        subjectId,
        deviceId,
        shardId: value.shardId,
        failureClass: "duplicate",
        detail: fail.message,
      });
      return fail;
    }
    citationIds.add(p.citation.citationId);
  }

  emit(options.onTelemetry, {
    op: "parse_shard",
    outcome: "ok",
    subjectId,
    deviceId,
    shardId: value.shardId,
  });
  return { ok: true, value };
}

/**
 * Cross-check a content shard against its manifest: every citation.sourceId
 * must appear in the source table; passage asOf must not postdate pack builtAt.
 */
export function validateShardAgainstManifest(
  manifest: PackManifest,
  shard: PackContentShard,
  options: {
    subjectId?: string;
    deviceId?: string;
    nowMs?: number;
    onTelemetry?: (e: PackFormatTelemetry) => void;
  } = {},
): PackParseOk<{ manifest: PackManifest; shard: PackContentShard }> | PackParseFail {
  const subjectId = options.subjectId?.trim() || "subj.pack.validate";
  const deviceId = options.deviceId?.trim() || "dev-pack";
  const sourceIds = new Set(manifest.sources.map((s) => s.sourceId));
  const listed = manifest.contentShards.some((s) => s.shardId === shard.shardId);
  if (!listed) {
    const fail: PackParseFail = {
      ok: false,
      message: `shardId '${shard.shardId}' not listed in manifest contentShards`,
      failureClass: "schema",
      path: "shardId",
    };
    emit(options.onTelemetry, {
      op: "validate_shard",
      outcome: "error",
      subjectId,
      deviceId,
      packId: manifest.packId,
      shardId: shard.shardId,
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }

  let builtAtMs: number;
  try {
    builtAtMs = parsePackStampMs(manifest.builtAt);
  } catch (err) {
    const fail: PackParseFail = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      failureClass: "asOf",
    };
    emit(options.onTelemetry, {
      op: "validate_shard",
      outcome: "error",
      subjectId,
      deviceId,
      packId: manifest.packId,
      shardId: shard.shardId,
      failureClass: "asOf",
      detail: fail.message,
    });
    return fail;
  }
  const nowMs = options.nowMs ?? Date.now();

  for (let i = 0; i < shard.passages.length; i++) {
    const passage = shard.passages[i]!;
    if (!sourceIds.has(passage.citation.sourceId)) {
      const fail: PackParseFail = {
        ok: false,
        message: `passages[${i}] citation.sourceId '${passage.citation.sourceId}' not in manifest sources`,
        failureClass: "citation",
        path: `passages[${i}].citation.sourceId`,
      };
      emit(options.onTelemetry, {
        op: "validate_shard",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        shardId: shard.shardId,
        failureClass: "citation",
        detail: fail.message,
      });
      return fail;
    }
    if (!passage.citation.locator.trim() || !passage.citation.citationId.trim()) {
      const fail: PackParseFail = {
        ok: false,
        message: `passages[${i}] missing resolvable citation`,
        failureClass: "citation",
        path: `passages[${i}].citation`,
      };
      emit(options.onTelemetry, {
        op: "validate_shard",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        shardId: shard.shardId,
        failureClass: "citation",
        detail: fail.message,
      });
      return fail;
    }
    try {
      const asOfMs = parsePackStampMs(passage.asOf);
      if (asOfMs > builtAtMs || asOfMs > nowMs) {
        const fail: PackParseFail = {
          ok: false,
          message: `passages[${i}] asOf postdates pack builtAt / check clock`,
          failureClass: "asOf",
          path: `passages[${i}].asOf`,
        };
        emit(options.onTelemetry, {
          op: "validate_shard",
          outcome: "error",
          subjectId,
          deviceId,
          packId: manifest.packId,
          shardId: shard.shardId,
          failureClass: "asOf",
          detail: fail.message,
        });
        return fail;
      }
    } catch (err) {
      const fail: PackParseFail = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        failureClass: "asOf",
        path: `passages[${i}].asOf`,
      };
      emit(options.onTelemetry, {
        op: "validate_shard",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        shardId: shard.shardId,
        failureClass: "asOf",
        detail: fail.message,
      });
      return fail;
    }
  }

  emit(options.onTelemetry, {
    op: "validate_shard",
    outcome: "ok",
    subjectId,
    deviceId,
    packId: manifest.packId,
    shardId: shard.shardId,
  });
  return { ok: true, value: { manifest, shard } };
}

/**
 * Parse optional vector id map. Orphan passageIds are checked by validatePack
 * against the content passage set (not here).
 */
export function parseVectorIdMap(
  input: unknown,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: PackFormatTelemetry) => void;
  } = {},
): PackParseOk<PackVectorIdMap> | PackParseFail {
  const subjectId = options.subjectId?.trim() || "subj.pack.vectors";
  const deviceId = options.deviceId?.trim() || "dev-pack";
  const parsed = packVectorIdMapSchema.safeParse(input);
  if (!parsed.success) {
    const fail = zodFail(parsed.error);
    emit(options.onTelemetry, {
      op: "parse_vector_map",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: fail.failureClass,
      detail: fail.message,
    });
    return fail;
  }
  const value = parsed.data;
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (seen.has(entry.passageId)) {
      const fail: PackParseFail = {
        ok: false,
        message: `duplicate passageId '${entry.passageId}' in vector id map`,
        failureClass: "duplicate",
        path: "entries",
      };
      emit(options.onTelemetry, {
        op: "parse_vector_map",
        outcome: "error",
        subjectId,
        deviceId,
        failureClass: "duplicate",
        detail: fail.message,
      });
      return fail;
    }
    seen.add(entry.passageId);
  }

  const hasDims = value.dimensions !== undefined;
  const hasDtype = value.dtype !== undefined;
  if (hasDims !== hasDtype) {
    const fail: PackParseFail = {
      ok: false,
      message: "vector id map must set both dimensions and dtype together (or neither)",
      failureClass: "vector",
      path: "dimensions",
    };
    emit(options.onTelemetry, {
      op: "parse_vector_map",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "vector",
      detail: fail.message,
    });
    return fail;
  }

  emit(options.onTelemetry, {
    op: "parse_vector_map",
    outcome: "ok",
    subjectId,
    deviceId,
    ...(hasDims && value.dimensions !== undefined
      ? { dimensions: value.dimensions, vectorRowCount: value.entries.length }
      : {}),
  });
  return { ok: true, value };
}

/** Expected embeddings.bin byte length for float32 (or declared dtype). */
export function expectedEmbeddingsByteLength(
  rowCount: number,
  dimensions: number,
  dtype: PackVectorDtype = "float32",
): number {
  return rowCount * dimensions * PACK_VECTOR_DTYPE_BYTES[dtype];
}

/**
 * Whether the id map declares the full optional vector index layer
 * (embeddings.bin + dimensions/dtype).
 */
export function isFullVectorIndexLayer(idMap: PackVectorIdMap): boolean {
  return idMap.dimensions !== undefined && idMap.dtype !== undefined;
}

/**
 * Integrity-check embeddings.bin against an id map that declares dimensions/dtype.
 * Every vectorIndex must resolve to a unique row; byte length must match.
 */
export function validateVectorIndexIntegrity(
  idMap: PackVectorIdMap,
  embeddingsBytes: Uint8Array,
  options: {
    subjectId?: string;
    deviceId?: string;
    packId?: string;
    onTelemetry?: (e: PackFormatTelemetry) => void;
  } = {},
): PackParseOk<PackVectorIndex> | PackParseFail {
  const subjectId = options.subjectId?.trim() || "subj.pack.vector_index";
  const deviceId = options.deviceId?.trim() || "dev-pack";

  if (!isFullVectorIndexLayer(idMap)) {
    const fail: PackParseFail = {
      ok: false,
      message: "vector index integrity requires dimensions and dtype on the id map",
      failureClass: "vector",
    };
    emit(options.onTelemetry, {
      op: "validate_vector_index",
      outcome: "error",
      subjectId,
      deviceId,
      ...(options.packId ? { packId: options.packId } : {}),
      failureClass: "vector",
      detail: fail.message,
    });
    return fail;
  }

  const dimensions = idMap.dimensions!;
  const dtype = idMap.dtype!;
  const rowCount = idMap.entries.length;
  const embeddingsRelpath =
    idMap.embeddingsRelpath ?? PACK_VECTOR_EMBEDDINGS_RELPATH;

  const indexSeen = new Set<number>();
  for (let i = 0; i < idMap.entries.length; i++) {
    const entry = idMap.entries[i]!;
    if (entry.vectorIndex === undefined) {
      const fail: PackParseFail = {
        ok: false,
        message: `entries[${i}] missing vectorIndex (required for embeddings.bin layer)`,
        failureClass: "vector",
        path: `entries[${i}].vectorIndex`,
      };
      emit(options.onTelemetry, {
        op: "validate_vector_index",
        outcome: "error",
        subjectId,
        deviceId,
        ...(options.packId ? { packId: options.packId } : {}),
        failureClass: "vector",
        detail: fail.message,
      });
      return fail;
    }
    if (entry.vectorIndex >= rowCount) {
      const fail: PackParseFail = {
        ok: false,
        message: `entries[${i}] vectorIndex ${entry.vectorIndex} out of range for ${rowCount} rows`,
        failureClass: "vector",
        path: `entries[${i}].vectorIndex`,
      };
      emit(options.onTelemetry, {
        op: "validate_vector_index",
        outcome: "error",
        subjectId,
        deviceId,
        ...(options.packId ? { packId: options.packId } : {}),
        failureClass: "vector",
        detail: fail.message,
      });
      return fail;
    }
    if (indexSeen.has(entry.vectorIndex)) {
      const fail: PackParseFail = {
        ok: false,
        message: `duplicate vectorIndex ${entry.vectorIndex} in id map`,
        failureClass: "duplicate",
        path: `entries[${i}].vectorIndex`,
      };
      emit(options.onTelemetry, {
        op: "validate_vector_index",
        outcome: "error",
        subjectId,
        deviceId,
        ...(options.packId ? { packId: options.packId } : {}),
        failureClass: "duplicate",
        detail: fail.message,
      });
      return fail;
    }
    indexSeen.add(entry.vectorIndex);
  }

  for (let i = 0; i < rowCount; i++) {
    if (!indexSeen.has(i)) {
      const fail: PackParseFail = {
        ok: false,
        message: `vectorIndex ${i} missing from id map (embeddings rows must be fully addressed)`,
        failureClass: "vector",
        path: "entries.vectorIndex",
      };
      emit(options.onTelemetry, {
        op: "validate_vector_index",
        outcome: "error",
        subjectId,
        deviceId,
        ...(options.packId ? { packId: options.packId } : {}),
        failureClass: "vector",
        detail: fail.message,
      });
      return fail;
    }
  }

  const expected = expectedEmbeddingsByteLength(rowCount, dimensions, dtype);
  if (embeddingsBytes.byteLength !== expected) {
    const fail: PackParseFail = {
      ok: false,
      message: `embeddings.bin byte length ${embeddingsBytes.byteLength} !== expected ${expected} (${rowCount}×${dimensions}×${PACK_VECTOR_DTYPE_BYTES[dtype]} ${dtype})`,
      failureClass: "vector",
      path: "embeddings.bin",
    };
    emit(options.onTelemetry, {
      op: "validate_vector_index",
      outcome: "error",
      subjectId,
      deviceId,
      ...(options.packId ? { packId: options.packId } : {}),
      failureClass: "vector",
      detail: fail.message,
      vectorRowCount: rowCount,
      dimensions,
    });
    return fail;
  }

  const value: PackVectorIndex = {
    idMap,
    dimensions,
    dtype,
    embeddingsRelpath,
    embeddingsByteLength: embeddingsBytes.byteLength,
    rowCount,
  };
  emit(options.onTelemetry, {
    op: "validate_vector_index",
    outcome: "ok",
    subjectId,
    deviceId,
    ...(options.packId ? { packId: options.packId } : {}),
    vectorRowCount: rowCount,
    dimensions,
  });
  return { ok: true, value };
}

export function loadPackManifestFile(
  filePath: string,
  options: Parameters<typeof parsePackManifest>[1] = {},
): PackParseOk<PackManifest> | PackParseFail {
  if (!existsSync(filePath)) {
    return {
      ok: false,
      message: `manifest missing at ${filePath}`,
      failureClass: "config",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      failureClass: "schema",
    };
  }
  return parsePackManifest(raw, options);
}

export function loadContentShardFile(
  filePath: string,
  options: Parameters<typeof parseContentShard>[1] = {},
): PackParseOk<PackContentShard> | PackParseFail {
  if (!existsSync(filePath)) {
    return {
      ok: false,
      message: `content shard missing at ${filePath}`,
      failureClass: "config",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      failureClass: "schema",
    };
  }
  return parseContentShard(raw, options);
}

