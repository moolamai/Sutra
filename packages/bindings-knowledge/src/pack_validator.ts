/**
 * Pack-level validator + validate-pack CLI.
 *
 * Scans every passage in a pack directory: fails on missing/empty citations,
 * unresolvable sourceIds, duplicate citationIds across shards, untruthful asOf,
 * and orphan vector id-map rows. Exit code 1 for CI.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PACK_VECTOR_EMBEDDINGS_RELPATH,
  PACK_VECTOR_ID_MAP_RELPATH,
  isFullVectorIndexLayer,
  loadContentShardFile,
  loadPackManifestFile,
  parseVectorIdMap,
  validateShardAgainstManifest,
  validateVectorIndexIntegrity,
  type PackContentShard,
  type PackFailureClass,
  type PackFormatTelemetry,
  type PackManifest,
  type PackParseFail,
  type PackParseOk,
  type PackVectorIdMap,
  type PackVectorIndex,
} from "./pack_format.js";

export type ValidatePackOk = {
  ok: true;
  value: {
    packRoot: string;
    manifest: PackManifest;
    shards: PackContentShard[];
    passageCount: number;
    vectorMap: PackVectorIdMap | null;
    /** Present when id-map declares dimensions/dtype and embeddings.bin passes integrity. */
    vectorIndex: PackVectorIndex | null;
  };
};

export type ValidatePackResult = ValidatePackOk | PackParseFail;

function emit(
  onTelemetry: ((e: PackFormatTelemetry) => void) | undefined,
  partial: Omit<PackFormatTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "bindings_knowledge.pack_format",
    ...partial,
  });
}

function isUnsafeRelpath(relpath: string): boolean {
  if (path.isAbsolute(relpath)) return true;
  const normalized = path.normalize(relpath);
  return (
    normalized.startsWith("..") ||
    normalized.includes(`${path.sep}..${path.sep}`) ||
    normalized === ".."
  );
}

/**
 * Validate a pack directory (manifest.json + content shards + optional
 * vectors/id-map.json + optional vectors/embeddings.bin).
 */
export function validatePack(
  packRoot: string,
  options: {
    subjectId?: string;
    deviceId?: string;
    nowMs?: number;
    /** Override vector id-map relative path; pass null to skip even if present. */
    vectorIdMapRelpath?: string | null;
    onTelemetry?: (e: PackFormatTelemetry) => void;
  } = {},
): ValidatePackResult {
  const subjectId = options.subjectId?.trim() || "subj.pack.validate_pack";
  const deviceId = options.deviceId?.trim() || "dev-pack";
  const root = path.resolve(packRoot);

  if (!existsSync(root)) {
    const fail: PackParseFail = {
      ok: false,
      message: `pack root missing: ${root}`,
      failureClass: "config",
    };
    emit(options.onTelemetry, {
      op: "validate_pack",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail: fail.message,
    });
    return fail;
  }

  const manifestPath = path.join(root, "manifest.json");
  const tel =
    options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {};
  const nowOpt =
    options.nowMs !== undefined ? { nowMs: options.nowMs } : {};
  const manifestResult = loadPackManifestFile(manifestPath, {
    subjectId,
    deviceId,
    ...nowOpt,
    ...tel,
  });
  if (!manifestResult.ok) {
    emit(options.onTelemetry, {
      op: "validate_pack",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: manifestResult.failureClass,
      detail: manifestResult.message,
    });
    return manifestResult;
  }
  const manifest = manifestResult.value;

  const shards: PackContentShard[] = [];
  const citationOwners = new Map<string, string>();
  const passageIds = new Set<string>();
  let passageCount = 0;

  for (const entry of manifest.contentShards) {
    if (isUnsafeRelpath(entry.relpath)) {
      const fail: PackParseFail = {
        ok: false,
        message: `unsafe content shard relpath '${entry.relpath}'`,
        failureClass: "config",
        path: "contentShards.relpath",
      };
      emit(options.onTelemetry, {
        op: "validate_pack",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        shardId: entry.shardId,
        failureClass: "config",
        detail: fail.message,
      });
      return fail;
    }
    const shardPath = path.join(root, entry.relpath);
    const shardResult = loadContentShardFile(shardPath, {
      subjectId,
      deviceId,
      ...tel,
    });
    if (!shardResult.ok) {
      emit(options.onTelemetry, {
        op: "validate_pack",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        shardId: entry.shardId,
        failureClass: shardResult.failureClass,
        detail: shardResult.message,
      });
      return shardResult;
    }
    if (shardResult.value.shardId !== entry.shardId) {
      const fail: PackParseFail = {
        ok: false,
        message: `shard file shardId '${shardResult.value.shardId}' !== manifest '${entry.shardId}'`,
        failureClass: "schema",
        path: "shardId",
      };
      emit(options.onTelemetry, {
        op: "validate_pack",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        shardId: entry.shardId,
        failureClass: "schema",
        detail: fail.message,
      });
      return fail;
    }

    const cross = validateShardAgainstManifest(manifest, shardResult.value, {
      subjectId,
      deviceId,
      ...nowOpt,
      ...tel,
    });
    if (!cross.ok) {
      emit(options.onTelemetry, {
        op: "validate_pack",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        shardId: entry.shardId,
        failureClass: cross.failureClass,
        detail: cross.message,
      });
      return cross;
    }

    for (const passage of shardResult.value.passages) {
      // Explicit empty-citation guard (Zod already rejects empty strings; belt+suspenders).
      const cite = passage.citation;
      if (
        !cite ||
        !cite.citationId?.trim() ||
        !cite.sourceId?.trim() ||
        !cite.locator?.trim()
      ) {
        const fail: PackParseFail = {
          ok: false,
          message: `passage '${passage.passageId}' missing/empty citation`,
          failureClass: "citation",
          path: "citation",
        };
        emit(options.onTelemetry, {
          op: "validate_pack",
          outcome: "error",
          subjectId,
          deviceId,
          packId: manifest.packId,
          shardId: entry.shardId,
          failureClass: "citation",
          detail: fail.message,
        });
        return fail;
      }

      if (passageIds.has(passage.passageId)) {
        const fail: PackParseFail = {
          ok: false,
          message: `duplicate passageId '${passage.passageId}' across pack shards`,
          failureClass: "duplicate",
          path: "passages.passageId",
        };
        emit(options.onTelemetry, {
          op: "validate_pack",
          outcome: "error",
          subjectId,
          deviceId,
          packId: manifest.packId,
          shardId: entry.shardId,
          failureClass: "duplicate",
          detail: fail.message,
        });
        return fail;
      }
      passageIds.add(passage.passageId);

      const prior = citationOwners.get(cite.citationId);
      if (prior !== undefined && prior !== entry.shardId) {
        const fail: PackParseFail = {
          ok: false,
          message: `duplicate citationId '${cite.citationId}' across shards '${prior}' and '${entry.shardId}'`,
          failureClass: "duplicate",
          path: "passages.citation.citationId",
        };
        emit(options.onTelemetry, {
          op: "validate_pack",
          outcome: "error",
          subjectId,
          deviceId,
          packId: manifest.packId,
          shardId: entry.shardId,
          failureClass: "duplicate",
          detail: fail.message,
        });
        return fail;
      }
      citationOwners.set(cite.citationId, entry.shardId);
      passageCount += 1;
    }

    shards.push(shardResult.value);
  }

  let vectorMap: PackVectorIdMap | null = null;
  let vectorIndex: PackVectorIndex | null = null;
  const vectorRel =
    options.vectorIdMapRelpath === null
      ? null
      : (options.vectorIdMapRelpath ?? PACK_VECTOR_ID_MAP_RELPATH);

  const defaultEmbeddingsPath = path.join(root, PACK_VECTOR_EMBEDDINGS_RELPATH);
  const embeddingsPresentAtDefault = existsSync(defaultEmbeddingsPath);

  if (vectorRel !== null) {
    if (isUnsafeRelpath(vectorRel)) {
      const fail: PackParseFail = {
        ok: false,
        message: `unsafe vector id-map relpath '${vectorRel}'`,
        failureClass: "config",
      };
      emit(options.onTelemetry, {
        op: "validate_pack",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        failureClass: "config",
        detail: fail.message,
      });
      return fail;
    }
    const vectorPath = path.join(root, vectorRel);
    const idMapPresent = existsSync(vectorPath);

    if (!idMapPresent && embeddingsPresentAtDefault) {
      const fail: PackParseFail = {
        ok: false,
        message: `embeddings.bin present but id-map missing at ${vectorRel}`,
        failureClass: "vector",
        path: PACK_VECTOR_EMBEDDINGS_RELPATH,
      };
      emit(options.onTelemetry, {
        op: "validate_pack",
        outcome: "error",
        subjectId,
        deviceId,
        packId: manifest.packId,
        failureClass: "vector",
        detail: fail.message,
      });
      return fail;
    }

    if (idMapPresent) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(vectorPath, "utf8"));
      } catch (err) {
        const fail: PackParseFail = {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          failureClass: "schema",
        };
        emit(options.onTelemetry, {
          op: "validate_pack",
          outcome: "error",
          subjectId,
          deviceId,
          packId: manifest.packId,
          failureClass: "schema",
          detail: fail.message,
        });
        return fail;
      }
      const parsed = parseVectorIdMap(raw, {
        subjectId,
        deviceId,
        ...tel,
      });
      if (!parsed.ok) {
        emit(options.onTelemetry, {
          op: "validate_pack",
          outcome: "error",
          subjectId,
          deviceId,
          packId: manifest.packId,
          failureClass: parsed.failureClass,
          detail: parsed.message,
        });
        return parsed;
      }
      for (const entry of parsed.value.entries) {
        if (!passageIds.has(entry.passageId)) {
          const fail: PackParseFail = {
            ok: false,
            message: `orphan vector row: passageId '${entry.passageId}' missing from content`,
            failureClass: "vector",
            path: "vectors.entries.passageId",
          };
          emit(options.onTelemetry, {
            op: "validate_pack",
            outcome: "error",
            subjectId,
            deviceId,
            packId: manifest.packId,
            failureClass: "vector",
            detail: fail.message,
          });
          return fail;
        }
      }
      vectorMap = parsed.value;

      if (isFullVectorIndexLayer(parsed.value)) {
        const embRel =
          parsed.value.embeddingsRelpath ?? PACK_VECTOR_EMBEDDINGS_RELPATH;
        if (isUnsafeRelpath(embRel)) {
          const fail: PackParseFail = {
            ok: false,
            message: `unsafe embeddings relpath '${embRel}'`,
            failureClass: "config",
          };
          emit(options.onTelemetry, {
            op: "validate_pack",
            outcome: "error",
            subjectId,
            deviceId,
            packId: manifest.packId,
            failureClass: "config",
            detail: fail.message,
          });
          return fail;
        }
        const embPath = path.join(root, embRel);
        if (!existsSync(embPath)) {
          const fail: PackParseFail = {
            ok: false,
            message: `vector index layer declared but embeddings missing at ${embRel}`,
            failureClass: "vector",
            path: embRel,
          };
          emit(options.onTelemetry, {
            op: "validate_pack",
            outcome: "error",
            subjectId,
            deviceId,
            packId: manifest.packId,
            failureClass: "vector",
            detail: fail.message,
          });
          return fail;
        }
        const embeddingsBytes = new Uint8Array(readFileSync(embPath));
        const integrity = validateVectorIndexIntegrity(parsed.value, embeddingsBytes, {
          subjectId,
          deviceId,
          packId: manifest.packId,
          ...tel,
        });
        if (!integrity.ok) {
          emit(options.onTelemetry, {
            op: "validate_pack",
            outcome: "error",
            subjectId,
            deviceId,
            packId: manifest.packId,
            failureClass: integrity.failureClass,
            detail: integrity.message,
          });
          return integrity;
        }
        vectorIndex = integrity.value;
      } else if (embeddingsPresentAtDefault) {
        const fail: PackParseFail = {
          ok: false,
          message:
            "embeddings.bin present but id-map lacks dimensions/dtype (incomplete vector index layer)",
          failureClass: "vector",
          path: "vectors/id-map.json",
        };
        emit(options.onTelemetry, {
          op: "validate_pack",
          outcome: "error",
          subjectId,
          deviceId,
          packId: manifest.packId,
          failureClass: "vector",
          detail: fail.message,
        });
        return fail;
      }
    }
  }

  emit(options.onTelemetry, {
    op: "validate_pack",
    outcome: "ok",
    subjectId,
    deviceId,
    packId: manifest.packId,
    passageCount,
    shardCount: shards.length,
    ...(vectorIndex
      ? {
          vectorRowCount: vectorIndex.rowCount,
          dimensions: vectorIndex.dimensions,
        }
      : {}),
  });

  return {
    ok: true,
    value: {
      packRoot: root,
      manifest,
      shards,
      passageCount,
      vectorMap,
      vectorIndex,
    },
  };
}

export type ValidatePackCliIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

export type ParsedValidatePackCli = {
  help: boolean;
  packRoot?: string;
  subjectId?: string;
  deviceId?: string;
  errors: string[];
};

export function parseValidatePackArgv(
  argv: readonly string[],
): ParsedValidatePackCli {
  const out: ParsedValidatePackCli = { help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--pack" || a === "--pack-root") {
      const v = argv[++i];
      if (!v) out.errors.push(`${a} requires a path`);
      else out.packRoot = v;
      continue;
    }
    if (a === "--subject-id") {
      const v = argv[++i];
      if (!v) out.errors.push("--subject-id requires a value");
      else out.subjectId = v;
      continue;
    }
    if (a === "--device-id") {
      const v = argv[++i];
      if (!v) out.errors.push("--device-id requires a value");
      else out.deviceId = v;
      continue;
    }
    if (!a.startsWith("-") && out.packRoot === undefined) {
      out.packRoot = a;
      continue;
    }
    out.errors.push(`unknown argument: ${a}`);
  }
  return out;
}

const VALIDATE_PACK_HELP = `Usage: validate-pack <pack-root> | --pack <pack-root>

Scan all passages in a knowledge pack. Fail (exit 1) on:
  - missing/empty citations
  - citations that do not resolve via the manifest source table
  - duplicate citationIds across shards
  - orphan vector id-map rows (vectors/id-map.json)
  - embeddings.bin size / vectorIndex integrity (when dimensions+dtype declared)

Options:
  --pack, --pack-root <path>   Pack directory containing manifest.json
  --subject-id <id>            Telemetry subject scope
  --device-id <id>             Telemetry device scope
  -h, --help                   Show help
`;

/**
 * CLI entry for CI: exit 0 on valid pack, exit 1 on any validation failure.
 */
export function runValidatePackCli(
  argv: readonly string[],
  io: ValidatePackCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
  options: {
    nowMs?: number;
    onTelemetry?: (e: PackFormatTelemetry) => void;
  } = {},
): number {
  const args = parseValidatePackArgv(argv);
  if (args.help) {
    io.stdout.write(VALIDATE_PACK_HELP);
    return 0;
  }
  if (args.errors.length) {
    io.stderr.write(`${args.errors.join("\n")}\n`);
    return 1;
  }
  if (!args.packRoot) {
    io.stderr.write("validate-pack: pack root required (--pack <path>)\n");
    return 1;
  }

  const events: PackFormatTelemetry[] = [];
  const result = validatePack(args.packRoot, {
    subjectId: args.subjectId ?? "subj.pack.cli",
    deviceId: args.deviceId ?? "dev-pack-cli",
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    onTelemetry: (e) => {
      events.push(e);
      options.onTelemetry?.(e);
    },
  });

  if (!result.ok) {
    const failureClass: PackFailureClass = result.failureClass;
    io.stderr.write(
      JSON.stringify({
        event: "bindings_knowledge.validate_pack",
        outcome: "error",
        failureClass,
        message: result.message,
        ...(result.path ? { path: result.path } : {}),
        subjectId: args.subjectId ?? "subj.pack.cli",
        deviceId: args.deviceId ?? "dev-pack-cli",
      }) + "\n",
    );
    return 1;
  }

  io.stdout.write(
    JSON.stringify({
      event: "bindings_knowledge.validate_pack",
      outcome: "ok",
      packId: result.value.manifest.packId,
      version: result.value.manifest.version,
      asOf: result.value.manifest.asOf,
      locality: result.value.manifest.locality,
      passageCount: result.value.passageCount,
      shardCount: result.value.shards.length,
      hasVectorMap: result.value.vectorMap !== null,
      hasVectorIndex: result.value.vectorIndex !== null,
      ...(result.value.vectorIndex
        ? {
            vectorRowCount: result.value.vectorIndex.rowCount,
            dimensions: result.value.vectorIndex.dimensions,
          }
        : {}),
      subjectId: args.subjectId ?? "subj.pack.cli",
      deviceId: args.deviceId ?? "dev-pack-cli",
    }) + "\n",
  );
  return 0;
}

/** Re-export for callers that only import the validator module. */
export type { PackParseOk };

