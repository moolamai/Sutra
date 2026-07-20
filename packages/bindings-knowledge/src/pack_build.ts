/**
 * Flagship pack authoring: read domains/ markdown as filesystem input,
 * emit validated knowledge-packs/ data + provenance.json.
 *
 * Never import domain TypeScript modules — path reads only.
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
  KNOWLEDGE_PACKAGE_ROOT,
  PACK_V1_SCHEMA_VERSION,
  PackFormatError,
  type PackContentShard,
  type PackManifest,
  type PackPassage,
  type PackSource,
} from "./pack_format.js";
import { validatePack } from "./pack_validator.js";

export const PACK_PROVENANCE_SCHEMA_VERSION =
  "bindings-knowledge.pack-provenance-v1" as const;

export const TEACHER_CBSE_SLICE_SOURCE_RELPATH = path.join(
  "domains",
  "teacher",
  "data",
  "cbse-syllabus-slice.md",
);

export const TEACHER_CBSE_SLICE_OUT_RELPATH = path.join(
  "knowledge-packs",
  "teacher-cbse-slice",
);

export const DOCTOR_FORMULARY_SKETCH_SOURCE_RELPATH = path.join(
  "domains",
  "doctor",
  "data",
  "formulary-sketch.md",
);

export const DOCTOR_FORMULARY_SKETCH_OUT_RELPATH = path.join(
  "knowledge-packs",
  "doctor-formulary-sketch",
);

const PACK_BUILD_MARKER_START = "<!-- pack-build:v1 -->";
const PACK_BUILD_MARKER_END = "<!-- /pack-build:v1 -->";

export type FlagshipPackId =
  | "teacher-cbse-slice"
  | "doctor-formulary-sketch";

export type FlagshipPackSpec = {
  id: FlagshipPackId;
  domain: string;
  sliceId: string;
  sourceRelpath: string;
  outRelpath: string;
  missingLabel: string;
};

export const FLAGSHIP_PACK_SPECS: Record<FlagshipPackId, FlagshipPackSpec> = {
  "teacher-cbse-slice": {
    id: "teacher-cbse-slice",
    domain: "teacher",
    sliceId: "cbse-syllabus-slice",
    sourceRelpath: TEACHER_CBSE_SLICE_SOURCE_RELPATH,
    outRelpath: TEACHER_CBSE_SLICE_OUT_RELPATH,
    missingLabel: "teacher syllabus slice",
  },
  "doctor-formulary-sketch": {
    id: "doctor-formulary-sketch",
    domain: "doctor",
    sliceId: "formulary-sketch",
    sourceRelpath: DOCTOR_FORMULARY_SKETCH_SOURCE_RELPATH,
    outRelpath: DOCTOR_FORMULARY_SKETCH_OUT_RELPATH,
    missingLabel: "doctor formulary sketch",
  },
};

export type PackProvenance = {
  schemaVersion: typeof PACK_PROVENANCE_SCHEMA_VERSION;
  packId: string;
  packVersion: string;
  builtAt: string;
  domain: string;
  sliceId: string;
  sourcePaths: string[];
  /** SHA-256 hex of domain source file bytes (freshness gate). */
  sourceFingerprint: string;
  /** SHA-256 hex of stable pack payload (manifest sans builtAt + shards). */
  contentHash: string;
};

export type PackBuildTelemetry = {
  event: "bindings_knowledge.pack_build";
  op: "build" | "check_freshness" | "parse_source" | "validate";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  packId?: string;
  failureClass?: string;
  detail?: string;
  sourcePathCount?: number;
};

type AuthoringPayload = {
  packId: string;
  version: string;
  title?: string;
  asOf: string;
  locality: "bundled-offline" | "self-hosted";
  languages: string[];
  sources: PackSource[];
  shard: {
    shardId: string;
    relpath: string;
    passages: PackPassage[];
  };
};

export type BuildFlagshipPackOptions = {
  repoRoot?: string;
  /** ISO stamp written to manifest.builtAt and provenance.builtAt. */
  builtAt?: string;
  nowMs?: number;
  subjectId?: string;
  deviceId?: string;
  /** When true, do not write files. */
  dryRun?: boolean;
  onTelemetry?: (e: PackBuildTelemetry) => void;
};

export type BuildFlagshipPackResult = {
  ok: true;
  packRoot: string;
  manifest: PackManifest;
  shard: PackContentShard;
  provenance: PackProvenance;
  sourceFingerprint: string;
  contentHash: string;
};

/** @deprecated Prefer BuildFlagshipPackOptions — kept for teacher call sites. */
export type BuildTeacherCbseSliceOptions = BuildFlagshipPackOptions;
/** @deprecated Prefer BuildFlagshipPackResult. */
export type BuildTeacherCbseSliceResult = BuildFlagshipPackResult;

export type CheckPackFreshnessResult =
  | {
      ok: true;
      packRoot: string;
      sourceFingerprint: string;
      provenanceFingerprint: string;
    }
  | {
      ok: false;
      message: string;
      failureClass: "freshness" | "config" | "schema";
      packRoot?: string;
    };

function emit(
  onTelemetry: ((e: PackBuildTelemetry) => void) | undefined,
  partial: Omit<PackBuildTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "bindings_knowledge.pack_build",
    ...partial,
  });
}

export function resolveRepoRoot(
  fromPackageRoot: string = KNOWLEDGE_PACKAGE_ROOT,
): string {
  return path.resolve(fromPackageRoot, "..", "..");
}

export function resolveFlagshipPackSpec(
  id: FlagshipPackId | string,
): FlagshipPackSpec {
  const spec = FLAGSHIP_PACK_SPECS[id as FlagshipPackId];
  if (!spec) {
    throw new PackFormatError(
      `unknown flagship pack id: ${id}`,
      "config",
      { code: "unknown_pack_id" },
    );
  }
  return spec;
}

/** Stable SHA-256 of one or more UTF-8 files (order = sourcePaths order). */
export function fingerprintSourceFiles(
  repoRoot: string,
  sourceRelPaths: readonly string[],
): string {
  const hash = createHash("sha256");
  for (const rel of sourceRelPaths) {
    const abs = path.resolve(repoRoot, rel);
    if (!existsSync(abs)) {
      throw new PackFormatError(
        `source missing: ${rel}`,
        "config",
        { code: "source_missing", path: rel },
      );
    }
    hash.update(rel.replace(/\\/g, "/"));
    hash.update("\0");
    // Canonical LF bytes so fingerprints match Linux CI when .gitattributes uses eol=lf.
    const raw = readFileSync(abs);
    const normalized =
      raw.includes(0x0d)
        ? Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
        : raw;
    hash.update(normalized);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function stableContentHash(
  manifest: Omit<PackManifest, "builtAt"> & { builtAt?: string },
  shards: PackContentShard[],
): string {
  const { builtAt: _b, ...rest } = manifest;
  const payload = JSON.stringify({
    manifest: rest,
    shards,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Extract the pack-build:v1 fenced JSON from domain markdown.
 */
export function parsePackAuthoringMarkdown(markdown: string): AuthoringPayload {
  const start = markdown.indexOf(PACK_BUILD_MARKER_START);
  const end = markdown.indexOf(PACK_BUILD_MARKER_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new PackFormatError(
      "pack-build:v1 markers missing in domain markdown",
      "schema",
      { code: "authoring_markers" },
    );
  }
  const block = markdown.slice(start + PACK_BUILD_MARKER_START.length, end);
  const fence = block.match(/```json\s*([\s\S]*?)```/);
  if (!fence?.[1]) {
    throw new PackFormatError(
      "pack-build:v1 JSON fence missing",
      "schema",
      { code: "authoring_fence" },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1].trim());
  } catch (err) {
    throw new PackFormatError(
      `pack-build:v1 JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      "schema",
      { code: "authoring_json" },
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PackFormatError("authoring payload must be an object", "schema");
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.packId !== "string" || typeof p.version !== "string") {
    throw new PackFormatError("packId and version required", "schema");
  }
  if (typeof p.asOf !== "string") {
    throw new PackFormatError("asOf required", "schema");
  }
  if (p.locality !== "bundled-offline" && p.locality !== "self-hosted") {
    throw new PackFormatError("locality must be bundled-offline|self-hosted", "schema");
  }
  if (!Array.isArray(p.languages) || !Array.isArray(p.sources)) {
    throw new PackFormatError("languages and sources arrays required", "schema");
  }
  if (!p.shard || typeof p.shard !== "object") {
    throw new PackFormatError("shard object required", "schema");
  }
  const shard = p.shard as Record<string, unknown>;
  if (
    typeof shard.shardId !== "string" ||
    typeof shard.relpath !== "string" ||
    !Array.isArray(shard.passages)
  ) {
    throw new PackFormatError("shard.shardId, relpath, passages required", "schema");
  }
  return {
    packId: p.packId,
    version: p.version,
    ...(typeof p.title === "string" ? { title: p.title } : {}),
    asOf: p.asOf,
    locality: p.locality,
    languages: p.languages as string[],
    sources: p.sources as PackSource[],
    shard: {
      shardId: shard.shardId,
      relpath: shard.relpath,
      passages: shard.passages as PackPassage[],
    },
  };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Build a flagship pack from domains/ markdown → knowledge-packs/.
 */
export function buildFlagshipPack(
  spec: FlagshipPackSpec,
  options: BuildFlagshipPackOptions = {},
): BuildFlagshipPackResult {
  const subjectId = options.subjectId?.trim() || "subj.pack.build";
  const deviceId = options.deviceId?.trim() || "dev-pack-build";
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const builtAt =
    options.builtAt ??
    new Date(options.nowMs ?? Date.now()).toISOString();
  const sourcePaths = [spec.sourceRelpath.replace(/\\/g, "/")];
  const packRoot = path.resolve(repoRoot, spec.outRelpath);

  try {
    const sourceAbs = path.resolve(repoRoot, spec.sourceRelpath);
    if (!existsSync(sourceAbs)) {
      throw new PackFormatError(
        `${spec.missingLabel} missing: ${spec.sourceRelpath}`,
        "config",
        { code: "source_missing", path: spec.sourceRelpath },
      );
    }

    const markdown = readFileSync(sourceAbs, "utf8");
    const authoring = parsePackAuthoringMarkdown(markdown);
    emit(options.onTelemetry, {
      op: "parse_source",
      outcome: "ok",
      subjectId,
      deviceId,
      packId: authoring.packId,
      sourcePathCount: sourcePaths.length,
    });

    const sourceFingerprint = fingerprintSourceFiles(repoRoot, sourcePaths);

    const manifest: PackManifest = {
      schemaVersion: PACK_V1_SCHEMA_VERSION,
      packId: authoring.packId,
      version: authoring.version,
      ...(authoring.title ? { title: authoring.title } : {}),
      asOf: authoring.asOf,
      builtAt,
      locality: authoring.locality,
      languages: authoring.languages,
      sources: authoring.sources,
      contentShards: [
        {
          shardId: authoring.shard.shardId,
          relpath: authoring.shard.relpath,
        },
      ],
    };

    const shard: PackContentShard = {
      schemaVersion: PACK_V1_SCHEMA_VERSION,
      shardId: authoring.shard.shardId,
      passages: authoring.shard.passages,
    };

    const contentHash = stableContentHash(manifest, [shard]);

    const provenance: PackProvenance = {
      schemaVersion: PACK_PROVENANCE_SCHEMA_VERSION,
      packId: authoring.packId,
      packVersion: authoring.version,
      builtAt,
      domain: spec.domain,
      sliceId: spec.sliceId,
      sourcePaths,
      sourceFingerprint,
      contentHash,
    };

    if (options.dryRun) {
      emit(options.onTelemetry, {
        op: "build",
        outcome: "ok",
        subjectId,
        deviceId,
        packId: authoring.packId,
        detail: "dry_run",
        sourcePathCount: sourcePaths.length,
      });
      return {
        ok: true,
        packRoot,
        manifest,
        shard,
        provenance,
        sourceFingerprint,
        contentHash,
      };
    }

    writeJson(path.join(packRoot, "manifest.json"), manifest);
    writeJson(path.join(packRoot, authoring.shard.relpath), shard);
    writeJson(path.join(packRoot, "provenance.json"), provenance);

    const validated = validatePack(packRoot, {
      subjectId,
      deviceId,
      nowMs: options.nowMs ?? Date.parse(builtAt),
    });

    if (!validated.ok) {
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        packId: authoring.packId,
        failureClass: validated.failureClass,
        detail: validated.message,
      });
      throw new PackFormatError(
        `built pack failed validatePack: ${validated.message}`,
        validated.failureClass,
        {
          code: "validate_pack",
          ...(validated.path !== undefined ? { path: validated.path } : {}),
        },
      );
    }

    emit(options.onTelemetry, {
      op: "validate",
      outcome: "ok",
      subjectId,
      deviceId,
      packId: authoring.packId,
    });
    emit(options.onTelemetry, {
      op: "build",
      outcome: "ok",
      subjectId,
      deviceId,
      packId: authoring.packId,
      sourcePathCount: sourcePaths.length,
    });

    return {
      ok: true,
      packRoot,
      manifest,
      shard,
      provenance,
      sourceFingerprint,
      contentHash,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureClass =
      err instanceof PackFormatError ? err.failureClass : "config";
    emit(options.onTelemetry, {
      op: "build",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass,
      detail: message,
    });
    throw err;
  }
}

/** Build teacher CBSE syllabus slice pack. */
export function buildTeacherCbseSlicePack(
  options: BuildFlagshipPackOptions = {},
): BuildFlagshipPackResult {
  return buildFlagshipPack(FLAGSHIP_PACK_SPECS["teacher-cbse-slice"], options);
}

/** Build doctor formulary sketch pack (disclaimers in citation metadata). */
export function buildDoctorFormularySketchPack(
  options: BuildFlagshipPackOptions = {},
): BuildFlagshipPackResult {
  return buildFlagshipPack(
    FLAGSHIP_PACK_SPECS["doctor-formulary-sketch"],
    options,
  );
}

/**
 * Fail when domains/ slice fingerprint no longer matches provenance.json.
 */
export function checkFlagshipPackFreshness(
  spec: FlagshipPackSpec,
  options: {
    repoRoot?: string;
    packRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: PackBuildTelemetry) => void;
  } = {},
): CheckPackFreshnessResult {
  const subjectId = options.subjectId?.trim() || "subj.pack.freshness";
  const deviceId = options.deviceId?.trim() || "dev-pack-freshness";
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const packRoot =
    options.packRoot ?? path.resolve(repoRoot, spec.outRelpath);
  const provenancePath = path.join(packRoot, "provenance.json");

  if (!existsSync(provenancePath)) {
    const fail: CheckPackFreshnessResult = {
      ok: false,
      message: `provenance.json missing under ${packRoot}`,
      failureClass: "config",
      packRoot,
    };
    emit(options.onTelemetry, {
      op: "check_freshness",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail: fail.message,
    });
    return fail;
  }

  let provenance: PackProvenance;
  try {
    provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as PackProvenance;
  } catch (err) {
    const fail: CheckPackFreshnessResult = {
      ok: false,
      message: `provenance.json parse failed: ${err instanceof Error ? err.message : String(err)}`,
      failureClass: "schema",
      packRoot,
    };
    emit(options.onTelemetry, {
      op: "check_freshness",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }

  if (provenance.schemaVersion !== PACK_PROVENANCE_SCHEMA_VERSION) {
    const fail: CheckPackFreshnessResult = {
      ok: false,
      message: `unsupported provenance schemaVersion: ${String(provenance.schemaVersion)}`,
      failureClass: "schema",
      packRoot,
    };
    emit(options.onTelemetry, {
      op: "check_freshness",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }

  if (!Array.isArray(provenance.sourcePaths) || !provenance.sourceFingerprint) {
    const fail: CheckPackFreshnessResult = {
      ok: false,
      message: "provenance missing sourcePaths or sourceFingerprint",
      failureClass: "schema",
      packRoot,
    };
    emit(options.onTelemetry, {
      op: "check_freshness",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }

  let current: string;
  try {
    current = fingerprintSourceFiles(repoRoot, provenance.sourcePaths);
  } catch (err) {
    const fail: CheckPackFreshnessResult = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      failureClass: "config",
      packRoot,
    };
    emit(options.onTelemetry, {
      op: "check_freshness",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail: fail.message,
    });
    return fail;
  }

  if (current !== provenance.sourceFingerprint) {
    const fail: CheckPackFreshnessResult = {
      ok: false,
      message:
        "stale pack: domains/ slice fingerprint does not match provenance.sourceFingerprint — rebuild with build_pack.mjs",
      failureClass: "freshness",
      packRoot,
    };
    emit(options.onTelemetry, {
      op: "check_freshness",
      outcome: "error",
      subjectId,
      deviceId,
      packId: provenance.packId,
      failureClass: "freshness",
      detail: fail.message,
    });
    return fail;
  }

  emit(options.onTelemetry, {
    op: "check_freshness",
    outcome: "ok",
    subjectId,
    deviceId,
    packId: provenance.packId,
    sourcePathCount: provenance.sourcePaths.length,
  });

  return {
    ok: true,
    packRoot,
    sourceFingerprint: current,
    provenanceFingerprint: provenance.sourceFingerprint,
  };
}

export function checkTeacherCbseSliceFreshness(
  options: {
    repoRoot?: string;
    packRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: PackBuildTelemetry) => void;
  } = {},
): CheckPackFreshnessResult {
  return checkFlagshipPackFreshness(
    FLAGSHIP_PACK_SPECS["teacher-cbse-slice"],
    options,
  );
}

export function checkDoctorFormularySketchFreshness(
  options: {
    repoRoot?: string;
    packRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: PackBuildTelemetry) => void;
  } = {},
): CheckPackFreshnessResult {
  return checkFlagshipPackFreshness(
    FLAGSHIP_PACK_SPECS["doctor-formulary-sketch"],
    options,
  );
}

export type BuildPackCliIo = {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

export type ParsedBuildPackCli = {
  help: boolean;
  check: boolean;
  packId?: FlagshipPackId;
  builtAt?: string;
  subjectId?: string;
  deviceId?: string;
  errors: string[];
};

export function parseBuildPackArgv(argv: readonly string[]): ParsedBuildPackCli {
  const out: ParsedBuildPackCli = {
    help: false,
    check: false,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--check") {
      out.check = true;
      continue;
    }
    if (a === "--pack") {
      const v = argv[++i];
      if (!v) {
        out.errors.push("--pack requires a value");
      } else if (
        v !== "teacher-cbse-slice" &&
        v !== "doctor-formulary-sketch"
      ) {
        out.errors.push(
          `--pack must be teacher-cbse-slice|doctor-formulary-sketch (got ${v})`,
        );
      } else {
        out.packId = v;
      }
      continue;
    }
    if (a === "--built-at") {
      const v = argv[++i];
      if (!v) out.errors.push("--built-at requires a value");
      else out.builtAt = v;
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
    out.errors.push(`unknown argument: ${a}`);
  }
  return out;
}

const BUILD_PACK_HELP = `Usage: build_pack.mjs [--pack <id>] [--check] [--built-at <iso>]

Build flagship knowledge packs from domains/ markdown into knowledge-packs/
(with provenance.json). Packages never import domains/.

Pack ids:
  teacher-cbse-slice         (default when --pack omitted on build)
  doctor-formulary-sketch

  --pack <id>      Which flagship pack to build or check
  --check          Verify provenance.sourceFingerprint matches domains/ slice
                   (checks all flagship packs when --pack omitted)
  --built-at <iso> Stamp manifest.builtAt / provenance.builtAt (deterministic CI)
  --subject-id     Telemetry subject scope
  --device-id      Telemetry device scope
  -h, --help       Show help
`;

/**
 * CLI: build a flagship pack or check freshness. Exit 0/1.
 */
export function runBuildPackCli(
  argv: readonly string[],
  io: BuildPackCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  const args = parseBuildPackArgv(argv);
  if (args.help) {
    io.stdout.write(BUILD_PACK_HELP);
    return 0;
  }
  if (args.errors.length) {
    io.stderr.write(`${args.errors.join("\n")}\n`);
    return 1;
  }

  const subjectId = args.subjectId ?? "subj.pack.build.cli";
  const deviceId = args.deviceId ?? "dev-pack-build-cli";

  if (args.check) {
    const ids: FlagshipPackId[] = args.packId
      ? [args.packId]
      : (Object.keys(FLAGSHIP_PACK_SPECS) as FlagshipPackId[]);
    for (const id of ids) {
      const result = checkFlagshipPackFreshness(FLAGSHIP_PACK_SPECS[id], {
        subjectId,
        deviceId,
      });
      if (!result.ok) {
        io.stderr.write(
          JSON.stringify({
            event: "bindings_knowledge.pack_build",
            op: "check_freshness",
            outcome: "error",
            pack: id,
            failureClass: result.failureClass,
            message: result.message,
            subjectId,
            deviceId,
          }) + "\n",
        );
        return 1;
      }
      io.stdout.write(
        JSON.stringify({
          event: "bindings_knowledge.pack_build",
          op: "check_freshness",
          outcome: "ok",
          pack: id,
          packRoot: result.packRoot,
          sourceFingerprint: result.sourceFingerprint,
          subjectId,
          deviceId,
        }) + "\n",
      );
    }
    return 0;
  }

  const packId = args.packId ?? "teacher-cbse-slice";
  try {
    const built = buildFlagshipPack(FLAGSHIP_PACK_SPECS[packId], {
      subjectId,
      deviceId,
      ...(args.builtAt !== undefined
        ? { builtAt: args.builtAt, nowMs: Date.parse(args.builtAt) }
        : {}),
    });
    io.stdout.write(
      JSON.stringify({
        event: "bindings_knowledge.pack_build",
        op: "build",
        outcome: "ok",
        pack: packId,
        packId: built.manifest.packId,
        packRoot: built.packRoot,
        sourceFingerprint: built.sourceFingerprint,
        contentHash: built.contentHash,
        passageCount: built.shard.passages.length,
        subjectId,
        deviceId,
      }) + "\n",
    );
    return 0;
  } catch (err) {
    io.stderr.write(
      JSON.stringify({
        event: "bindings_knowledge.pack_build",
        op: "build",
        outcome: "error",
        pack: packId,
        message: err instanceof Error ? err.message : String(err),
        subjectId,
        deviceId,
      }) + "\n",
    );
    return 1;
  }
}
