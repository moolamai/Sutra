/**
 * Baseline registry — decontamination source of truth for frozen eval sets.
 *
 * Versioned format: set id, content hash, source path, slice tags, pinned seed.
 * Loader validates the content hash of each source file on read.
 *
 * Append-only: hash changes require a new version row — never silent overwrite.
 * Telemetry is metadata-only (never raw learner / eval utterance bodies).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Registry document schema id — bump MINOR for additive field additions only. */
export const BASELINE_REGISTRY_SCHEMA_VERSION =
  "baseline-registry.v1" as const;

/** Repo-relative committed registry path. */
export const BASELINE_REGISTRY_RELPATH =
  "training/eval/baseline_registry.json" as const;

/** Soft caps (NFR — bounded scans). */
export const BASELINE_REGISTRY_ENTRY_LIMIT = 512;
export const BASELINE_SET_ID_LIMIT = 128;
export const BASELINE_SOURCE_PATH_LIMIT = 512;
export const BASELINE_SLICE_TAG_LIMIT = 64;

export const BASELINE_KINDS = Object.freeze([
  "golden_turns",
  "conformance",
  "guidance",
  "nfr",
] as const);

export type BaselineKind = (typeof BASELINE_KINDS)[number];

export const BASELINE_LOCALITIES = Object.freeze([
  "on-device",
  "self-hosted",
] as const);

export type BaselineLocality = (typeof BASELINE_LOCALITIES)[number];

export type BaselineSliceTags = {
  /** Domain pack lane (e.g. teacher, lawyer, smoke). */
  domainPack: string;
  /** BCP-47-ish language tag — never utterance text. */
  language: string;
  /** Binding lane (edge / cloud / pack id). */
  binding: string;
};

export type BaselineRegistryEntry = {
  setId: string;
  /** Monotonic version for this setId — append-only. */
  version: number;
  kind: BaselineKind;
  /** sha256:<hex> of the source file bytes. */
  contentHash: string;
  /** Repo-relative path to the frozen eval artifact. */
  sourcePath: string;
  sliceTags: BaselineSliceTags;
  /** Pinned RNG / runner seed — gates must not float. */
  pinnedSeed: number;
  locality: BaselineLocality;
};

export type BaselineRegistryDocument = {
  schemaVersion: typeof BASELINE_REGISTRY_SCHEMA_VERSION;
  entries: BaselineRegistryEntry[];
};

export type BaselineRegistryFailureClass =
  | "schema_violation"
  | "hash_mismatch"
  | "source_missing"
  | "append_only_violation"
  | "section_limit"
  | "missing_baseline"
  | "path_escape"
  /** Gate that trains on its own eval set is void. */
  | "train_on_eval_void"
  /** Candidate changes more than one surgery class — unattributable. */
  | "attribution_void"
  /** Champion/challenger score gate rejected a sliced regression. */
  | "slice_regression";

export type BaselineRegistryTelemetryEvent = {
  event: "learning.baseline_registry";
  outcome: "ok" | "rejected";
  subjectId: null;
  deviceId?: string;
  action?:
    | "load"
    | "validate"
    | "hash"
    | "append_check"
    | "gate_lookup"
    | "ingest"
    | "decontam_check"
    | "near_dup_check"
    | "export"
    | "completeness_check"
    | "promote_gate";
  setId?: string;
  version?: number;
  kind?: BaselineKind;
  failureClass?: BaselineRegistryFailureClass;
  entryCount?: number;
  /** Named failing slice lane when a gate/lookup rejects. */
  failingSlice?: string;
};

/** Deterministic hash index export for C1 decontam + C3 critic calibration. */
export const BASELINE_HASH_EXPORT_SCHEMA_VERSION =
  "baseline-hash-export.v1" as const;

export type BaselineHashExportEntry = {
  setId: string;
  version: number;
  kind: BaselineKind;
  contentHash: string;
  sourcePath: string;
  sliceTags: BaselineSliceTags;
  pinnedSeed: number;
  locality: BaselineLocality;
};

export type BaselineHashExportDocument = {
  schemaVersion: typeof BASELINE_HASH_EXPORT_SCHEMA_VERSION;
  /** Stable purpose tag — consumers must not invent ad-hoc indexes. */
  purpose: "corpus_decontamination_and_critic_calibration";
  /** Latest version row per setId, sorted by setId. */
  entries: BaselineHashExportEntry[];
  /** Deduped sorted content hashes for exact-hash decontamination. */
  contentHashes: string[];
  /** Deduped sorted source paths for path decontamination. */
  sourcePaths: string[];
};

/**
 * Known eval directories CI must find reflected in the registry (bounded walk).
 * Nested dirs listed separately so shallow fixture roots do not double-count.
 */
export const KNOWN_EVAL_DIRECTORIES = Object.freeze([
  {
    relPath: "packages/sync-protocol/fixtures/golden-turns",
    kind: "golden_turns" as const,
    shallow: false,
  },
  {
    relPath: "packages/contract-conformance/fixtures/wire",
    kind: "conformance" as const,
    shallow: false,
  },
  {
    relPath: "training/eval/fixtures/b8-guidance",
    kind: "guidance" as const,
    shallow: false,
  },
  {
    relPath: "training/eval/fixtures/nfr",
    kind: "nfr" as const,
    shallow: false,
  },
  {
    /** smoke-baseline.json only — nested packs are listed above. */
    relPath: "training/eval/fixtures",
    kind: "nfr" as const,
    shallow: true,
  },
] as const);

/**
 * Representative setIds every promotion / corpus gate must find after A P6 + B8 ingest.
 * Individual turn/scenario rows are also registered; these are the hard gate keys.
 */
export const REQUIRED_PROMOTE_BASELINE_SET_IDS = Object.freeze([
  "a-p6.golden-turns.manifest",
  "conformance.wire.bundle",
  "b8.guidance.manifest",
  "smoke.eval.v1",
  "nfr.core-loop.bench.v1",
] as const);

/** Soft cap on sources scanned during a single ingest (NFR — bounded). */
export const BASELINE_INGEST_SOURCE_LIMIT = 256;

const contentHashSchema = z
  .string()
  .regex(
    /^sha256:[a-f0-9]{64}$/,
    "contentHash must be sha256:<64 lowercase hex>",
  );

const sliceTagsSchema = z
  .object({
    domainPack: z.string().min(1).max(BASELINE_SLICE_TAG_LIMIT),
    language: z.string().min(1).max(BASELINE_SLICE_TAG_LIMIT),
    binding: z.string().min(1).max(BASELINE_SLICE_TAG_LIMIT),
  })
  .strict();

export const baselineRegistryEntrySchema = z
  .object({
    setId: z.string().min(1).max(BASELINE_SET_ID_LIMIT),
    version: z.number().int().min(1).max(1_000_000),
    kind: z.enum(BASELINE_KINDS),
    contentHash: contentHashSchema,
    sourcePath: z.string().min(1).max(BASELINE_SOURCE_PATH_LIMIT),
    sliceTags: sliceTagsSchema,
    pinnedSeed: z.number().int().min(0).max(2_147_483_647),
    locality: z.enum(BASELINE_LOCALITIES),
  })
  .strict();

export const baselineRegistryDocumentSchema = z
  .object({
    schemaVersion: z.literal(BASELINE_REGISTRY_SCHEMA_VERSION),
    entries: z
      .array(baselineRegistryEntrySchema)
      .max(BASELINE_REGISTRY_ENTRY_LIMIT),
  })
  .strict()
  .superRefine((doc, ctx) => {
    /** setId → version → hash — detect silent overwrite / dup versions. */
    const bySet = new Map<string, Map<number, string>>();
    for (let i = 0; i < doc.entries.length; i += 1) {
      const entry = doc.entries[i]!;
      if (
        entry.sourcePath.includes("..") ||
        path.isAbsolute(entry.sourcePath) ||
        entry.sourcePath.startsWith("/") ||
        entry.sourcePath.includes("\\")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "sourcePath"],
          message:
            "sourcePath must be a repo-relative POSIX path without '..' or escapes",
        });
      }
      let versions = bySet.get(entry.setId);
      if (!versions) {
        versions = new Map();
        bySet.set(entry.setId, versions);
      }
      const priorHash = versions.get(entry.version);
      if (priorHash !== undefined) {
        if (priorHash !== entry.contentHash) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", i],
            message:
              `append-only violation: setId=${entry.setId} version=${entry.version} ` +
              `hash changed — add a new version row instead of overwriting`,
          });
        } else {
          ctx.addIssue({
            code: "custom",
            path: ["entries", i],
            message:
              `append-only violation: duplicate setId=${entry.setId} version=${entry.version}`,
          });
        }
      } else {
        versions.set(entry.version, entry.contentHash);
      }
    }
  });

/** sha256 hex digest prefixed for registry contentHash fields. */
export function computeBaselineContentHash(bytes: Buffer | string): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

function emit(
  onTelemetry: ((e: BaselineRegistryTelemetryEvent) => void) | undefined,
  event: BaselineRegistryTelemetryEvent,
): void {
  onTelemetry?.(event);
}

/** exactOptionalPropertyTypes — omit keys rather than pass explicit undefined. */
function optionalDeviceTelemetry(options: {
  deviceId?: string;
  onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
}): {
  deviceId?: string;
  onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
} {
  return {
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  };
}

function classifyZodMessage(message: string): BaselineRegistryFailureClass {
  if (message.includes("append-only")) return "append_only_violation";
  if (message.includes("sourcePath") || message.includes("escape")) {
    return "path_escape";
  }
  if (message.includes("exceed") || message.includes("too_big")) {
    return "section_limit";
  }
  return "schema_violation";
}

/**
 * Parse + append-only check for an in-memory registry document.
 */
export function parseBaselineRegistryDocument(input: unknown):
  | { ok: true; document: BaselineRegistryDocument }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      issuePath?: string;
    } {
  const parsed = baselineRegistryDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const message = first?.message ?? "baseline registry schema_violation";
    const issuePath = first
      ? first.path.map(String).join(".") || "(root)"
      : "(root)";
    return {
      ok: false,
      failureClass: classifyZodMessage(message),
      detail: message,
      issuePath,
    };
  }
  return { ok: true, document: parsed.data };
}

/**
 * Resolve a repo-relative source path under repoRoot (no escapes).
 */
export function resolveBaselineSourcePath(
  repoRoot: string,
  sourcePath: string,
):
  | { ok: true; absolutePath: string }
  | { ok: false; failureClass: "path_escape"; detail: string } {
  if (
    !sourcePath ||
    sourcePath.includes("..") ||
    path.isAbsolute(sourcePath) ||
    sourcePath.startsWith("/") ||
    sourcePath.includes("\\")
  ) {
    return {
      ok: false,
      failureClass: "path_escape",
      detail: "sourcePath must be repo-relative POSIX without '..'",
    };
  }
  const absolutePath = path.resolve(repoRoot, ...sourcePath.split("/"));
  const rootResolved = path.resolve(repoRoot);
  if (
    absolutePath !== rootResolved &&
    !absolutePath.startsWith(rootResolved + path.sep)
  ) {
    return {
      ok: false,
      failureClass: "path_escape",
      detail: "sourcePath escapes repo root",
    };
  }
  return { ok: true, absolutePath };
}

/**
 * Verify one entry's contentHash against the bytes at sourcePath.
 */
export async function verifyBaselineEntryHash(input: {
  repoRoot: string;
  entry: BaselineRegistryEntry;
}): Promise<
  | { ok: true; contentHash: string }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      setId: string;
      failingSlice: string;
    }
> {
  const resolved = resolveBaselineSourcePath(
    input.repoRoot,
    input.entry.sourcePath,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      failureClass: resolved.failureClass,
      detail: resolved.detail,
      setId: input.entry.setId,
      failingSlice: input.entry.sliceTags.domainPack,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved.absolutePath);
  } catch {
    return {
      ok: false,
      failureClass: "source_missing",
      detail: `source missing at ${input.entry.sourcePath}`,
      setId: input.entry.setId,
      failingSlice: input.entry.sliceTags.domainPack,
    };
  }
  const actual = computeBaselineContentHash(bytes);
  if (actual !== input.entry.contentHash) {
    return {
      ok: false,
      failureClass: "hash_mismatch",
      detail:
        `content hash mismatch for setId=${input.entry.setId} ` +
        `version=${input.entry.version} (frozen eval drifted)`,
      setId: input.entry.setId,
      failingSlice: input.entry.sliceTags.domainPack,
    };
  }
  return { ok: true, contentHash: actual };
}

export type LoadBaselineRegistryResult =
  | {
      ok: true;
      document: BaselineRegistryDocument;
      registryPath: string;
    }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      setId?: string;
      failingSlice?: string;
      issuePath?: string;
    };

/**
 * Load the committed registry and validate every entry hash on read.
 */
export async function loadBaselineRegistry(options: {
  repoRoot: string;
  /** Override path (defaults to training/eval/baseline_registry.json). */
  registryPath?: string;
  deviceId?: string;
  onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
}): Promise<LoadBaselineRegistryResult> {
  const rel = options.registryPath ?? BASELINE_REGISTRY_RELPATH;
  const resolved = resolveBaselineSourcePath(options.repoRoot, rel);
  if (!resolved.ok) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "load",
      failureClass: resolved.failureClass,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: resolved.failureClass,
      detail: resolved.detail,
    };
  }

  let raw: string;
  try {
    raw = await readFile(resolved.absolutePath, "utf8");
  } catch {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "load",
      failureClass: "source_missing",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "source_missing",
      detail: `registry missing at ${rel}`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "load",
      failureClass: "schema_violation",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "registry JSON parse failed",
    };
  }

  const parsed = parseBaselineRegistryDocument(json);
  if (!parsed.ok) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "validate",
      failureClass: parsed.failureClass,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return parsed;
  }

  for (const entry of parsed.document.entries) {
    const verified = await verifyBaselineEntryHash({
      repoRoot: options.repoRoot,
      entry,
    });
    if (!verified.ok) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "hash",
        setId: verified.setId,
        version: entry.version,
        kind: entry.kind,
        failureClass: verified.failureClass,
        failingSlice: verified.failingSlice,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: verified.failureClass,
        detail: verified.detail,
        setId: verified.setId,
        failingSlice: verified.failingSlice,
      };
    }
  }

  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "load",
    entryCount: parsed.document.entries.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });

  return {
    ok: true,
    document: parsed.document,
    registryPath: rel,
  };
}

/**
 * Append-only check: propose a new entry against an existing document.
 * Same setId+version with a different hash is rejected (named setId).
 */
export function assertAppendOnlyEntry(
  document: BaselineRegistryDocument,
  candidate: BaselineRegistryEntry,
):
  | { ok: true }
  | {
      ok: false;
      failureClass: "append_only_violation" | "section_limit";
      detail: string;
      setId: string;
      failingSlice: string;
    } {
  if (document.entries.length >= BASELINE_REGISTRY_ENTRY_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `entries exceed ${BASELINE_REGISTRY_ENTRY_LIMIT}`,
      setId: candidate.setId,
      failingSlice: candidate.sliceTags.domainPack,
    };
  }
  for (const existing of document.entries) {
    if (
      existing.setId === candidate.setId &&
      existing.version === candidate.version
    ) {
      if (existing.contentHash !== candidate.contentHash) {
        return {
          ok: false,
          failureClass: "append_only_violation",
          detail:
            `silent overwrite forbidden for setId=${candidate.setId} ` +
            `version=${candidate.version} — bump version for new hash`,
          setId: candidate.setId,
          failingSlice: candidate.sliceTags.domainPack,
        };
      }
      return {
        ok: false,
        failureClass: "append_only_violation",
        detail: `duplicate setId=${candidate.setId} version=${candidate.version}`,
        setId: candidate.setId,
        failingSlice: candidate.sliceTags.domainPack,
      };
    }
  }
  return { ok: true };
}

/**
 * Gate lookup: every required setId must appear (any version) with a hash.
 * Missing sets are rejected with the failing slice / setId named.
 */
export function assertRequiredBaselinesPresent(
  document: BaselineRegistryDocument,
  requiredSetIds: readonly string[],
  options: {
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      failureClass: "missing_baseline";
      detail: string;
      setId: string;
      failingSlice: string;
    } {
  const present = new Set(document.entries.map((e) => e.setId));
  for (const setId of requiredSetIds) {
    if (!present.has(setId)) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "gate_lookup",
        setId,
        failureClass: "missing_baseline",
        failingSlice: setId,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "missing_baseline",
        detail: `promotion gate requires baseline setId=${setId} in registry`,
        setId,
        failingSlice: setId,
      };
    }
  }
  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "gate_lookup",
    entryCount: requiredSetIds.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  return { ok: true };
}

/**
 * Lookup latest version row for a setId (highest version number).
 */
export function lookupLatestBaseline(
  document: BaselineRegistryDocument,
  setId: string,
): BaselineRegistryEntry | undefined {
  let best: BaselineRegistryEntry | undefined;
  for (const entry of document.entries) {
    if (entry.setId !== setId) continue;
    if (!best || entry.version > best.version) best = entry;
  }
  return best;
}

function normalizeRepoRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function exactEntryPresent(
  document: BaselineRegistryDocument,
  candidate: BaselineRegistryEntry,
): boolean {
  return document.entries.some(
    (e) =>
      e.setId === candidate.setId &&
      e.version === candidate.version &&
      e.contentHash === candidate.contentHash &&
      e.sourcePath === candidate.sourcePath,
  );
}

type BaselineIngestDraft = Omit<BaselineRegistryEntry, "contentHash">;

/**
 * Canonical frozen eval artifacts to register (A P6 golden turns, conformance,
 * B8 guidance, NFR). Manifests expand to per-file rows with pinned seeds.
 */
export async function listCanonicalBaselineDrafts(repoRoot: string): Promise<
  | { ok: true; drafts: BaselineIngestDraft[] }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      setId?: string;
      failingSlice?: string;
    }
> {
  const drafts: BaselineIngestDraft[] = [];

  const push = (draft: BaselineIngestDraft): void => {
    drafts.push(draft);
  };

  push({
    setId: "smoke.eval.v1",
    version: 1,
    kind: "nfr",
    sourcePath: "training/eval/fixtures/smoke-baseline.json",
    sliceTags: {
      domainPack: "smoke",
      language: "en",
      binding: "edge",
    },
    pinnedSeed: 42,
    locality: "on-device",
  });

  push({
    setId: "nfr.core-loop.bench.v1",
    version: 1,
    kind: "nfr",
    sourcePath: "training/eval/fixtures/nfr/core-loop-bench-inputs.json",
    sliceTags: {
      domainPack: "nfr",
      language: "en",
      binding: "edge",
    },
    pinnedSeed: 3001,
    locality: "on-device",
  });

  push({
    setId: "conformance.wire.bundle",
    version: 1,
    kind: "conformance",
    sourcePath: "packages/contract-conformance/fixtures/wire/bundle.json",
    sliceTags: {
      domainPack: "wire",
      language: "en",
      binding: "protocol",
    },
    pinnedSeed: 1501,
    locality: "self-hosted",
  });

  const goldenManifestRel =
    "packages/sync-protocol/fixtures/golden-turns/manifest.json";
  push({
    setId: "a-p6.golden-turns.manifest",
    version: 1,
    kind: "golden_turns",
    sourcePath: goldenManifestRel,
    sliceTags: {
      domainPack: "protocol",
      language: "en",
      binding: "a-p6",
    },
    pinnedSeed: 1000,
    locality: "self-hosted",
  });

  const goldenResolved = resolveBaselineSourcePath(repoRoot, goldenManifestRel);
  if (!goldenResolved.ok) {
    return {
      ok: false,
      failureClass: goldenResolved.failureClass,
      detail: goldenResolved.detail,
      setId: "a-p6.golden-turns.manifest",
      failingSlice: "protocol",
    };
  }
  let goldenRaw: string;
  try {
    goldenRaw = await readFile(goldenResolved.absolutePath, "utf8");
  } catch {
    return {
      ok: false,
      failureClass: "source_missing",
      detail: `source missing at ${goldenManifestRel}`,
      setId: "a-p6.golden-turns.manifest",
      failingSlice: "protocol",
    };
  }
  let goldenJson: { turns?: Array<{ id?: string; file?: string }> };
  try {
    goldenJson = JSON.parse(goldenRaw) as typeof goldenJson;
  } catch {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "A P6 golden-turns manifest JSON parse failed",
      setId: "a-p6.golden-turns.manifest",
      failingSlice: "protocol",
    };
  }
  const turns = Array.isArray(goldenJson.turns) ? goldenJson.turns : [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    if (!turn?.id || !turn.file) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `A P6 golden-turns manifest entry ${i} missing id/file`,
        setId: "a-p6.golden-turns.manifest",
        failingSlice: "protocol",
      };
    }
    push({
      setId: `a-p6.golden-turns.${turn.id}`,
      version: 1,
      kind: "golden_turns",
      sourcePath: `packages/sync-protocol/fixtures/golden-turns/${turn.file}`,
      sliceTags: {
        domainPack: "protocol",
        language: "en",
        binding: "a-p6",
      },
      pinnedSeed: 1001 + i,
      locality: "self-hosted",
    });
  }

  const guidanceManifestRel = "training/eval/fixtures/b8-guidance/manifest.json";
  push({
    setId: "b8.guidance.manifest",
    version: 1,
    kind: "guidance",
    sourcePath: guidanceManifestRel,
    sliceTags: {
      domainPack: "guidance",
      language: "en",
      binding: "b8",
    },
    pinnedSeed: 2000,
    locality: "on-device",
  });

  const guidanceResolved = resolveBaselineSourcePath(
    repoRoot,
    guidanceManifestRel,
  );
  if (!guidanceResolved.ok) {
    return {
      ok: false,
      failureClass: guidanceResolved.failureClass,
      detail: guidanceResolved.detail,
      setId: "b8.guidance.manifest",
      failingSlice: "guidance",
    };
  }
  let guidanceRaw: string;
  try {
    guidanceRaw = await readFile(guidanceResolved.absolutePath, "utf8");
  } catch {
    return {
      ok: false,
      failureClass: "source_missing",
      detail: `source missing at ${guidanceManifestRel}`,
      setId: "b8.guidance.manifest",
      failingSlice: "guidance",
    };
  }
  let guidanceJson: {
    scenarios?: Array<{ id?: string; file?: string }>;
  };
  try {
    guidanceJson = JSON.parse(guidanceRaw) as typeof guidanceJson;
  } catch {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "B8 guidance manifest JSON parse failed",
      setId: "b8.guidance.manifest",
      failingSlice: "guidance",
    };
  }
  const scenarios = Array.isArray(guidanceJson.scenarios)
    ? guidanceJson.scenarios
    : [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i]!;
    if (!scenario?.id || !scenario.file) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `B8 guidance manifest entry ${i} missing id/file`,
        setId: "b8.guidance.manifest",
        failingSlice: "guidance",
      };
    }
    const domainPack =
      scenario.id.startsWith("teacher")
        ? "teacher"
        : scenario.id.startsWith("lawyer")
          ? "lawyer"
          : "guidance";
    push({
      setId: `b8.guidance.${scenario.id}`,
      version: 1,
      kind: "guidance",
      sourcePath: `training/eval/fixtures/b8-guidance/${scenario.file}`,
      sliceTags: {
        domainPack,
        language: "en",
        binding: "b8",
      },
      pinnedSeed: 2001 + i,
      locality: "on-device",
    });
  }

  if (drafts.length > BASELINE_INGEST_SOURCE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `ingest sources exceed ${BASELINE_INGEST_SOURCE_LIMIT}`,
    };
  }

  return { ok: true, drafts };
}

export type IngestCanonicalBaselinesResult =
  | {
      ok: true;
      document: BaselineRegistryDocument;
      appended: number;
      skippedIdentical: number;
    }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      setId?: string;
      failingSlice?: string;
    };

/**
 * Hash canonical A P6 / B8 / conformance / NFR artifacts and append rows.
 * Idempotent: identical setId+version+hash already present is skipped.
 * Hash drift at the same version is an append-only violation (bump version).
 */
export async function ingestCanonicalBaselines(options: {
  repoRoot: string;
  /** Existing document to append onto (defaults to empty v1). */
  existing?: BaselineRegistryDocument;
  deviceId?: string;
  onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
}): Promise<IngestCanonicalBaselinesResult> {
  const listed = await listCanonicalBaselineDrafts(options.repoRoot);
  if (!listed.ok) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "ingest",
      failureClass: listed.failureClass,
      ...(listed.setId !== undefined ? { setId: listed.setId } : {}),
      ...(listed.failingSlice !== undefined
        ? { failingSlice: listed.failingSlice }
        : {}),
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return listed;
  }

  let document: BaselineRegistryDocument = options.existing ?? {
    schemaVersion: BASELINE_REGISTRY_SCHEMA_VERSION,
    entries: [],
  };
  let appended = 0;
  let skippedIdentical = 0;

  for (const draft of listed.drafts) {
    const resolved = resolveBaselineSourcePath(
      options.repoRoot,
      draft.sourcePath,
    );
    if (!resolved.ok) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "ingest",
        setId: draft.setId,
        failureClass: resolved.failureClass,
        failingSlice: draft.sliceTags.domainPack,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: resolved.failureClass,
        detail: resolved.detail,
        setId: draft.setId,
        failingSlice: draft.sliceTags.domainPack,
      };
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(resolved.absolutePath);
    } catch {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "ingest",
        setId: draft.setId,
        failureClass: "source_missing",
        failingSlice: draft.sliceTags.domainPack,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "source_missing",
        detail: `source missing at ${draft.sourcePath}`,
        setId: draft.setId,
        failingSlice: draft.sliceTags.domainPack,
      };
    }
    const candidate: BaselineRegistryEntry = {
      ...draft,
      contentHash: computeBaselineContentHash(bytes),
    };
    if (exactEntryPresent(document, candidate)) {
      skippedIdentical += 1;
      continue;
    }
    const appendCheck = assertAppendOnlyEntry(document, candidate);
    if (!appendCheck.ok) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "append_check",
        setId: appendCheck.setId,
        version: candidate.version,
        kind: candidate.kind,
        failureClass: appendCheck.failureClass,
        failingSlice: appendCheck.failingSlice,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: appendCheck.failureClass,
        detail: appendCheck.detail,
        setId: appendCheck.setId,
        failingSlice: appendCheck.failingSlice,
      };
    }
    document = {
      schemaVersion: document.schemaVersion,
      entries: [...document.entries, candidate],
    };
    appended += 1;
  }

  const parsed = parseBaselineRegistryDocument(document);
  if (!parsed.ok) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "ingest",
      failureClass: parsed.failureClass,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: parsed.failureClass,
      detail: parsed.detail,
    };
  }

  const kinds = new Set(parsed.document.entries.map((e) => e.kind));
  for (const kind of BASELINE_KINDS) {
    if (!kinds.has(kind)) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "ingest",
        failureClass: "missing_baseline",
        failingSlice: kind,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "missing_baseline",
        detail: `ingest incomplete — missing kind=${kind}`,
        setId: kind,
        failingSlice: kind,
      };
    }
  }

  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "ingest",
    entryCount: parsed.document.entries.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });

  return {
    ok: true,
    document: parsed.document,
    appended,
    skippedIdentical,
  };
}

/**
 * Decontamination: a training corpus path that collides with a registered
 * eval baseline source makes the gate void (train-on-eval).
 */
export function assertEvalBaselinesExcludedFromTrainingCorpus(
  document: BaselineRegistryDocument,
  trainingCorpusSourcePaths: readonly string[],
  options: {
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      failureClass: "train_on_eval_void" | "section_limit";
      detail: string;
      setId: string;
      failingSlice: string;
    } {
  if (trainingCorpusSourcePaths.length > BASELINE_INGEST_SOURCE_LIMIT) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "decontam_check",
      failureClass: "section_limit",
      failingSlice: "(section_limit)",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `training corpus path list exceeds ${BASELINE_INGEST_SOURCE_LIMIT}`,
      setId: "(section_limit)",
      failingSlice: "(section_limit)",
    };
  }
  const corpus = new Set(
    trainingCorpusSourcePaths.map((p) => normalizeRepoRelPath(p)),
  );
  for (const entry of document.entries) {
    const src = normalizeRepoRelPath(entry.sourcePath);
    if (corpus.has(src)) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "decontam_check",
        setId: entry.setId,
        kind: entry.kind,
        failureClass: "train_on_eval_void",
        failingSlice: entry.sliceTags.domainPack,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "train_on_eval_void",
        detail:
          `train-on-eval void: corpus path ${src} collides with ` +
          `baseline setId=${entry.setId}`,
        setId: entry.setId,
        failingSlice: entry.sliceTags.domainPack,
      };
    }
  }
  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "decontam_check",
    entryCount: document.entries.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  return { ok: true };
}

/**
 * Known-good promotion lookup: every required promote setId is present.
 */
export function assertPromotionBaselinesPresent(
  document: BaselineRegistryDocument,
  options: {
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  } = {},
): ReturnType<typeof assertRequiredBaselinesPresent> {
  return assertRequiredBaselinesPresent(
    document,
    REQUIRED_PROMOTE_BASELINE_SET_IDS,
    options,
  );
}

function latestEntriesBySetId(
  document: BaselineRegistryDocument,
): BaselineRegistryEntry[] {
  const best = new Map<string, BaselineRegistryEntry>();
  for (const entry of document.entries) {
    const prior = best.get(entry.setId);
    if (!prior || entry.version > prior.version) {
      best.set(entry.setId, entry);
    }
  }
  return [...best.values()].sort((a, b) => a.setId.localeCompare(b.setId));
}

/**
 * Programmatic export of registered hashes for C1 decontamination and C3
 * critic calibration. Deterministic: same document → same key order / indexes.
 * Metadata only — never includes raw utterance / learner bodies.
 */
export function exportRegisteredBaselineHashes(
  document: BaselineRegistryDocument,
  options: {
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  } = {},
):
  | { ok: true; export: BaselineHashExportDocument }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
    } {
  if (document.entries.length > BASELINE_REGISTRY_ENTRY_LIMIT) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "export",
      failureClass: "section_limit",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `entries exceed ${BASELINE_REGISTRY_ENTRY_LIMIT}`,
    };
  }

  const latest = latestEntriesBySetId(document);
  const contentHashes = [
    ...new Set(latest.map((e) => e.contentHash)),
  ].sort((a, b) => a.localeCompare(b));
  const sourcePaths = [
    ...new Set(latest.map((e) => normalizeRepoRelPath(e.sourcePath))),
  ].sort((a, b) => a.localeCompare(b));

  const exported: BaselineHashExportDocument = {
    schemaVersion: BASELINE_HASH_EXPORT_SCHEMA_VERSION,
    purpose: "corpus_decontamination_and_critic_calibration",
    entries: latest.map((e) => ({
      setId: e.setId,
      version: e.version,
      kind: e.kind,
      contentHash: e.contentHash,
      sourcePath: e.sourcePath,
      sliceTags: { ...e.sliceTags },
      pinnedSeed: e.pinnedSeed,
      locality: e.locality,
    })),
    contentHashes,
    sourcePaths,
  };

  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "export",
    entryCount: exported.entries.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });

  return { ok: true, export: exported };
}

/** Default near-dup similarity threshold (SLM-scale corpora). */
export const BASELINE_NEAR_DUP_DEFAULT_THRESHOLD = 0.92;

/** Soft cap on corpus docs scanned in a single near-dup decontam pass. */
export const BASELINE_NEAR_DUP_DOC_SCAN_LIMIT = 4096;

/**
 * Deterministic 64-bit SimHash fingerprint (Charikar) as 16 lowercase hex chars.
 * Uses character 3-grams over NFKC-normalized lowercase text — no wall clock.
 */
export function computeSimHash64Hex(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const weights = new Int32Array(64);
  if (normalized.length === 0) {
    return "0000000000000000";
  }
  const n = Math.max(1, Math.min(3, normalized.length));
  for (let i = 0; i <= normalized.length - n; i++) {
    const gram = normalized.slice(i, i + n);
    const digest = createHash("sha256").update(gram, "utf8").digest();
    let h = 0n;
    for (let b = 0; b < 8; b++) {
      h |= BigInt(digest[b]!) << BigInt(8 * b);
    }
    for (let bit = 0; bit < 64; bit++) {
      weights[bit]! += (h >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit]! >= 0) out |= 1n << BigInt(bit);
  }
  return out.toString(16).padStart(16, "0");
}

/** Similarity in [0, 1] from Hamming distance of two SimHash hex fingerprints. */
export function simHashSimilarityHex(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) {
    return 0;
  }
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let dist = 0;
  while (x > 0n) {
    dist += 1;
    x &= x - 1n;
  }
  return 1 - dist / 64;
}

export type CorpusNearDupCandidate = {
  docId: string;
  text: string;
  laneCode?: string;
};

export type NearDupDecontamOk = {
  ok: true;
  checkedDocCount: number;
  baselineFingerprintCount: number;
};

export type NearDupDecontamFail = {
  ok: false;
  failureClass: "train_on_eval_void" | "section_limit" | "source_missing";
  detail: string;
  setId: string;
  failingSlice: string;
  offendingDocIds: string[];
  similarity?: number;
};

/**
 * Near-duplicate (SimHash) decontamination against registered eval artifacts.
 * Any corpus document whose SimHash similarity to a baseline source exceeds
 * the lane/default threshold voids the gate (train-on-eval).
 */
export function assertCorpusDocumentsNearDupDecontaminated(
  document: BaselineRegistryDocument,
  corpusDocuments: readonly CorpusNearDupCandidate[],
  options: {
    repoRoot: string;
    threshold?: number;
    laneThresholds?: Readonly<Record<string, number>>;
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  },
): NearDupDecontamOk | NearDupDecontamFail {
  if (corpusDocuments.length > BASELINE_NEAR_DUP_DOC_SCAN_LIMIT) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "near_dup_check",
      failureClass: "section_limit",
      failingSlice: "(section_limit)",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `corpus near-dup list exceeds ${BASELINE_NEAR_DUP_DOC_SCAN_LIMIT}`,
      setId: "(section_limit)",
      failingSlice: "(section_limit)",
      offendingDocIds: [],
    };
  }

  const defaultThreshold =
    options.threshold ?? BASELINE_NEAR_DUP_DEFAULT_THRESHOLD;
  const laneThresholds = options.laneThresholds ?? {};
  const latest = latestEntriesBySetId(document);
  const fingerprints: {
    setId: string;
    failingSlice: string;
    simHash: string;
  }[] = [];

  for (const entry of latest) {
    const resolved = resolveBaselineSourcePath(
      options.repoRoot,
      entry.sourcePath,
    );
    if (!resolved.ok) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "near_dup_check",
        setId: entry.setId,
        failureClass: "source_missing",
        failingSlice: entry.sliceTags.domainPack,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "source_missing",
        detail: resolved.detail,
        setId: entry.setId,
        failingSlice: entry.sliceTags.domainPack,
        offendingDocIds: [],
      };
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolved.absolutePath);
    } catch (err) {
      return {
        ok: false,
        failureClass: "source_missing",
        detail: `baseline source missing for setId=${entry.setId}: ${err instanceof Error ? err.message : String(err)}`,
        setId: entry.setId,
        failingSlice: entry.sliceTags.domainPack,
        offendingDocIds: [],
      };
    }
    fingerprints.push({
      setId: entry.setId,
      failingSlice: entry.sliceTags.domainPack,
      simHash: computeSimHash64Hex(bytes.toString("utf8")),
    });
  }

  const offenders: {
    docId: string;
    setId: string;
    failingSlice: string;
    similarity: number;
  }[] = [];

  for (const doc of corpusDocuments) {
    const threshold =
      doc.laneCode !== undefined &&
      typeof laneThresholds[doc.laneCode] === "number"
        ? laneThresholds[doc.laneCode]!
        : defaultThreshold;
    const docHash = computeSimHash64Hex(doc.text);
    for (const fp of fingerprints) {
      const sim = simHashSimilarityHex(docHash, fp.simHash);
      if (sim >= threshold) {
        offenders.push({
          docId: doc.docId,
          setId: fp.setId,
          failingSlice: fp.failingSlice,
          similarity: sim,
        });
        break;
      }
    }
  }

  if (offenders.length > 0) {
    const offendingDocIds = [
      ...new Set(offenders.map((o) => o.docId)),
    ].sort((a, b) => a.localeCompare(b));
    const first = offenders[0]!;
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "near_dup_check",
      setId: first.setId,
      failureClass: "train_on_eval_void",
      failingSlice: first.failingSlice,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "train_on_eval_void",
      detail:
        `train-on-eval near-dup void: offendingDocIds=[${offendingDocIds.join(",")}] ` +
        `similarity=${first.similarity.toFixed(4)} setId=${first.setId}`,
      setId: first.setId,
      failingSlice: first.failingSlice,
      offendingDocIds,
      similarity: first.similarity,
    };
  }

  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "near_dup_check",
    entryCount: fingerprints.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  return {
    ok: true,
    checkedDocCount: corpusDocuments.length,
    baselineFingerprintCount: fingerprints.length,
  };
}

/**
 * CI gate check: build-report decontamination proof must cover the registry
 * (status passed, method set, registryHashCount matches exported hashes).
 * Metadata only — never inspects raw corpus/eval utterance bodies.
 */
export function assertCorpusBuildDecontamProof(
  document: BaselineRegistryDocument,
  proof: {
    status: string;
    method?: string;
    checkedHashCount?: number;
    registryHashCount?: number;
    nearDupCheckedDocCount?: number;
  },
  options: {
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
    requireNearDup?: boolean;
  } = {},
):
  | { ok: true; registryHashCount: number }
  | {
      ok: false;
      failureClass: "train_on_eval_void" | "schema_violation" | "section_limit";
      detail: string;
    } {
  const exported = exportRegisteredBaselineHashes(document, {
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!exported.ok) {
    return {
      ok: false,
      failureClass:
        exported.failureClass === "section_limit"
          ? "section_limit"
          : "schema_violation",
      detail: exported.detail,
    };
  }
  const expected = exported.export.contentHashes.length;
  if (proof.status !== "passed") {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "decontam_check",
      failureClass: "train_on_eval_void",
      failingSlice: "(proof)",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "train_on_eval_void",
      detail: `decontamination proof status=${proof.status} (expected passed)`,
    };
  }
  if (proof.registryHashCount !== expected) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail:
        `decontamination proof registryHashCount=${proof.registryHashCount} ` +
        `!== exported ${expected}`,
    };
  }
  if (
    typeof proof.checkedHashCount !== "number" ||
    proof.checkedHashCount < 1
  ) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "decontamination proof missing checkedHashCount",
    };
  }
  if (options.requireNearDup) {
    if (
      proof.method !== "exact_hash+simhash_near_dup" ||
      typeof proof.nearDupCheckedDocCount !== "number"
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "decontamination proof missing near-dup coverage",
      };
    }
  }
  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "decontam_check",
    entryCount: expected,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  return { ok: true, registryHashCount: expected };
}

/** Corpus document candidate for exact-hash decontamination. */
export type CorpusDocumentHashCandidate = {
  docId: string;
  contentHash: string;
};

export type ExactHashDecontamOk = {
  ok: true;
  checkedHashCount: number;
  registryHashCount: number;
};

export type ExactHashDecontamFail = {
  ok: false;
  failureClass: "train_on_eval_void" | "section_limit" | "schema_violation";
  detail: string;
  setId: string;
  failingSlice: string;
  /** Sorted unique corpus document ids that collided with the registry. */
  offendingDocIds: string[];
};

/**
 * Exact-hash decontamination with offending document ids.
 * Any corpus document whose contentHash matches a registered eval entry
 * voids the gate (train-on-eval).
 */
export function assertCorpusDocumentsExactHashDecontaminated(
  document: BaselineRegistryDocument,
  corpusDocuments: readonly CorpusDocumentHashCandidate[],
  options: {
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  } = {},
): ExactHashDecontamOk | ExactHashDecontamFail {
  if (corpusDocuments.length > BASELINE_INGEST_SOURCE_LIMIT) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "decontam_check",
      failureClass: "section_limit",
      failingSlice: "(section_limit)",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `corpus document list exceeds ${BASELINE_INGEST_SOURCE_LIMIT}`,
      setId: "(section_limit)",
      failingSlice: "(section_limit)",
      offendingDocIds: [],
    };
  }

  const exported = exportRegisteredBaselineHashes(document);
  if (!exported.ok) {
    return {
      ok: false,
      failureClass:
        exported.failureClass === "section_limit"
          ? "section_limit"
          : "schema_violation",
      detail: exported.detail,
      setId: "(export)",
      failingSlice: "(export)",
      offendingDocIds: [],
    };
  }

  const indexed = new Set(exported.export.contentHashes);
  const hashToEntry = new Map(
    exported.export.entries.map((e) => [e.contentHash, e] as const),
  );
  const offenders: {
    docId: string;
    setId: string;
    failingSlice: string;
  }[] = [];

  for (const doc of corpusDocuments) {
    if (!/^sha256:[a-f0-9]{64}$/.test(doc.contentHash)) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "decontam_check",
        failureClass: "schema_violation",
        failingSlice: "(hash)",
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "corpus contentHash must be sha256:<64 lowercase hex>",
        setId: "(hash)",
        failingSlice: "(hash)",
        offendingDocIds: [doc.docId].sort((a, b) => a.localeCompare(b)),
      };
    }
    if (indexed.has(doc.contentHash)) {
      const hit = hashToEntry.get(doc.contentHash);
      const setId = hit?.setId ?? "(unknown)";
      const failingSlice = hit?.sliceTags.domainPack ?? setId;
      offenders.push({ docId: doc.docId, setId, failingSlice });
    }
  }

  if (offenders.length > 0) {
    const offendingDocIds = [
      ...new Set(offenders.map((o) => o.docId)),
    ].sort((a, b) => a.localeCompare(b));
    const first = offenders[0]!;
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "decontam_check",
      setId: first.setId,
      failureClass: "train_on_eval_void",
      failingSlice: first.failingSlice,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "train_on_eval_void",
      detail:
        `train-on-eval void: offendingDocIds=[${offendingDocIds.join(",")}] ` +
        `collide with setId=${first.setId}`,
      setId: first.setId,
      failingSlice: first.failingSlice,
      offendingDocIds,
    };
  }

  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "decontam_check",
    entryCount: exported.export.contentHashes.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  return {
    ok: true,
    checkedHashCount: corpusDocuments.length,
    registryHashCount: exported.export.contentHashes.length,
  };
}

/**
 * Exact-hash decontamination: any corpus content hash that appears in the
 * registry voids the gate (train-on-eval).
 */
export function assertCorpusContentHashesDecontaminated(
  document: BaselineRegistryDocument,
  corpusContentHashes: readonly string[],
  options: {
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      failureClass: "train_on_eval_void" | "section_limit" | "schema_violation";
      detail: string;
      setId: string;
      failingSlice: string;
      offendingDocIds?: string[];
    } {
  const docs: CorpusDocumentHashCandidate[] = corpusContentHashes.map(
    (contentHash, i) => ({
      docId: `(hash:${i})`,
      contentHash,
    }),
  );
  const result = assertCorpusDocumentsExactHashDecontaminated(
    document,
    docs,
    options,
  );
  if (result.ok) return { ok: true };
  return {
    ok: false,
    failureClass: result.failureClass,
    detail: result.detail,
    setId: result.setId,
    failingSlice: result.failingSlice,
    ...(result.offendingDocIds.length
      ? { offendingDocIds: result.offendingDocIds }
      : {}),
  };
}

/**
 * Sync parse of a committed registry JSON file (no per-source hash verify).
 * Corpus factory pins the registry document bytes for exact-hash decontam.
 */
export function loadBaselineRegistryDocumentFromFile(
  registryPath: string,
  options: {
    deviceId?: string;
    onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
  } = {},
):
  | { ok: true; document: BaselineRegistryDocument }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
    } {
  let rawText: string;
  try {
    // sync read — corpus builder is sync
    rawText = readFileSync(registryPath, "utf8");
  } catch (err) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "load",
      failureClass: "source_missing",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "source_missing",
      detail: `baseline registry missing: ${registryPath} (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "load",
      failureClass: "schema_violation",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `baseline registry parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parseBaselineRegistryDocument(json);
  if (!parsed.ok) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "validate",
      failureClass: parsed.failureClass,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: parsed.failureClass,
      detail: parsed.detail,
    };
  }
  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "load",
    entryCount: parsed.document.entries.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  return { ok: true, document: parsed.document };
}

async function listJsonArtifactsUnder(
  repoRoot: string,
  relDir: string,
  shallow: boolean,
): Promise<
  | { ok: true; sourcePaths: string[] }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      failingSlice: string;
    }
> {
  const resolved = resolveBaselineSourcePath(repoRoot, relDir);
  if (!resolved.ok) {
    return {
      ok: false,
      failureClass: resolved.failureClass,
      detail: resolved.detail,
      failingSlice: relDir,
    };
  }

  const found: string[] = [];

  async function walk(absDir: string, relPrefix: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const ent of entries) {
      if (found.length >= BASELINE_INGEST_SOURCE_LIMIT) return;
      const name = ent.name;
      if (name.startsWith(".")) continue;
      const childRel = `${relPrefix}/${name}`;
      const childAbs = path.join(absDir, name);
      if (ent.isDirectory()) {
        if (!shallow) await walk(childAbs, childRel);
        continue;
      }
      if (ent.isFile() && name.endsWith(".json")) {
        found.push(normalizeRepoRelPath(childRel));
      }
    }
  }

  try {
    await walk(resolved.absolutePath, relDir);
  } catch {
    return {
      ok: false,
      failureClass: "source_missing",
      detail: `eval directory missing at ${relDir}`,
      failingSlice: relDir,
    };
  }

  if (found.length >= BASELINE_INGEST_SOURCE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `eval directory scan exceeded ${BASELINE_INGEST_SOURCE_LIMIT}`,
      failingSlice: relDir,
    };
  }

  found.sort((a, b) => a.localeCompare(b));
  return { ok: true, sourcePaths: found };
}

/**
 * CI completeness: every JSON artifact under known eval directories must appear
 * in the registry with a content hash. Missing path → named failing slice.
 */
export async function assertRegistryCompleteAgainstKnownEvalDirectories(options: {
  repoRoot: string;
  document?: BaselineRegistryDocument;
  deviceId?: string;
  onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
}): Promise<
  | { ok: true; artifactCount: number; coveredCount: number }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      setId?: string;
      failingSlice: string;
    }
> {
  let document = options.document;
  if (!document) {
    const loaded = await loadBaselineRegistry({
      repoRoot: options.repoRoot,
      ...optionalDeviceTelemetry(options),
    });
    if (!loaded.ok) {
      return {
        ok: false,
        failureClass: loaded.failureClass,
        detail: loaded.detail,
        ...(loaded.setId !== undefined ? { setId: loaded.setId } : {}),
        failingSlice: loaded.failingSlice ?? "(registry)",
      };
    }
    document = loaded.document;
  }

  const registeredPaths = new Set(
    document.entries.map((e) => normalizeRepoRelPath(e.sourcePath)),
  );
  let artifactCount = 0;

  for (const dir of KNOWN_EVAL_DIRECTORIES) {
    const listed = await listJsonArtifactsUnder(
      options.repoRoot,
      dir.relPath,
      dir.shallow,
    );
    if (!listed.ok) {
      emit(options.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "completeness_check",
        failureClass: listed.failureClass,
        failingSlice: listed.failingSlice,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: listed.failureClass,
        detail: listed.detail,
        failingSlice: listed.failingSlice,
      };
    }
    for (const sourcePath of listed.sourcePaths) {
      artifactCount += 1;
      if (!registeredPaths.has(sourcePath)) {
        emit(options.onTelemetry, {
          event: "learning.baseline_registry",
          outcome: "rejected",
          subjectId: null,
          action: "completeness_check",
          setId: sourcePath,
          kind: dir.kind,
          failureClass: "missing_baseline",
          failingSlice: dir.kind,
          ...(options.deviceId !== undefined
            ? { deviceId: options.deviceId }
            : {}),
        });
        return {
          ok: false,
          failureClass: "missing_baseline",
          detail:
            `registry incomplete: ${sourcePath} under ${dir.relPath} ` +
            `has no baseline row (kind=${dir.kind})`,
          setId: sourcePath,
          failingSlice: dir.kind,
        };
      }
    }
  }

  const promote = assertPromotionBaselinesPresent(
    document,
    optionalDeviceTelemetry(options),
  );
  if (!promote.ok) {
    emit(options.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "completeness_check",
      setId: promote.setId,
      failureClass: promote.failureClass,
      failingSlice: promote.failingSlice,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: promote.failureClass,
      detail: promote.detail,
      setId: promote.setId,
      failingSlice: promote.failingSlice,
    };
  }

  emit(options.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "completeness_check",
    entryCount: artifactCount,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });

  return {
    ok: true,
    artifactCount,
    coveredCount: artifactCount,
  };
}

export type PromotionGateScoreMap = Readonly<Record<string, number>>;

/**
 * Champion/challenger promotion gate over frozen, hashed baselines.
 * Known-good: challenger meets or beats champion on every required setId.
 * Known-regressed: first losing slice is named. Multi-surgery candidates void.
 */
export function evaluateChampionChallengerGate(input: {
  document: BaselineRegistryDocument;
  championScores: PromotionGateScoreMap;
  challengerScores: PromotionGateScoreMap;
  /** Defaults to REQUIRED_PROMOTE_BASELINE_SET_IDS. */
  requiredSetIds?: readonly string[];
  /**
   * Surgery component classes touched by the candidate.
   * More than one → attribution_void (one surgery type per stage).
   */
  surgeryClasses?: readonly string[];
  deviceId?: string;
  onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
}):
  | { ok: true; verdict: "promote" }
  | {
      ok: false;
      verdict: "reject";
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      setId: string;
      failingSlice: string;
    } {
  const required =
    input.requiredSetIds ?? REQUIRED_PROMOTE_BASELINE_SET_IDS;

  if (required.length > BASELINE_INGEST_SOURCE_LIMIT) {
    emit(input.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "promote_gate",
      failureClass: "section_limit",
      failingSlice: "(section_limit)",
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return {
      ok: false,
      verdict: "reject",
      failureClass: "section_limit",
      detail: `required setIds exceed ${BASELINE_INGEST_SOURCE_LIMIT}`,
      setId: "(section_limit)",
      failingSlice: "(section_limit)",
    };
  }

  if (input.surgeryClasses !== undefined && input.surgeryClasses.length > 1) {
    emit(input.onTelemetry, {
      event: "learning.baseline_registry",
      outcome: "rejected",
      subjectId: null,
      action: "promote_gate",
      failureClass: "attribution_void",
      failingSlice: input.surgeryClasses.join("+"),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return {
      ok: false,
      verdict: "reject",
      failureClass: "attribution_void",
      detail:
        "one surgery type per stage — candidate touches multiple component classes",
      setId: "(surgery)",
      failingSlice: input.surgeryClasses.join("+"),
    };
  }

  const present = assertRequiredBaselinesPresent(
    input.document,
    required,
    optionalDeviceTelemetry(input),
  );
  if (!present.ok) {
    return {
      ok: false,
      verdict: "reject",
      failureClass: present.failureClass,
      detail: present.detail,
      setId: present.setId,
      failingSlice: present.failingSlice,
    };
  }

  for (const setId of required) {
    const champion = input.championScores[setId];
    const challenger = input.challengerScores[setId];
    const entry = lookupLatestBaseline(input.document, setId);
    const failingSlice = entry?.sliceTags.domainPack ?? setId;

    if (
      typeof champion !== "number" ||
      typeof challenger !== "number" ||
      !Number.isFinite(champion) ||
      !Number.isFinite(challenger) ||
      champion < 0 ||
      champion > 1 ||
      challenger < 0 ||
      challenger > 1
    ) {
      emit(input.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "promote_gate",
        setId,
        failureClass: "schema_violation",
        failingSlice,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        verdict: "reject",
        failureClass: "schema_violation",
        detail: `scores for setId=${setId} must be finite numbers in [0,1]`,
        setId,
        failingSlice,
      };
    }

    if (challenger + Number.EPSILON < champion) {
      emit(input.onTelemetry, {
        event: "learning.baseline_registry",
        outcome: "rejected",
        subjectId: null,
        action: "promote_gate",
        setId,
        ...(entry !== undefined ? { kind: entry.kind } : {}),
        failureClass: "slice_regression",
        failingSlice,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        verdict: "reject",
        failureClass: "slice_regression",
        detail:
          `challenger regresses on setId=${setId} ` +
          `(challenger=${challenger} < champion=${champion})`,
        setId,
        failingSlice,
      };
    }
  }

  emit(input.onTelemetry, {
    event: "learning.baseline_registry",
    outcome: "ok",
    subjectId: null,
    action: "promote_gate",
    entryCount: required.length,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
  });

  return { ok: true, verdict: "promote" };
}

/**
 * Load registry, validate hashes, export decontam index, and assert CI
 * completeness against known eval directories — single entry for gates/scripts.
 */
export async function loadBaselineRegistryApi(options: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: BaselineRegistryTelemetryEvent) => void;
}): Promise<
  | {
      ok: true;
      document: BaselineRegistryDocument;
      export: BaselineHashExportDocument;
      completeness: { artifactCount: number; coveredCount: number };
    }
  | {
      ok: false;
      failureClass: BaselineRegistryFailureClass;
      detail: string;
      setId?: string;
      failingSlice?: string;
    }
> {
  const loaded = await loadBaselineRegistry({
    repoRoot: options.repoRoot,
    ...optionalDeviceTelemetry(options),
  });
  if (!loaded.ok) {
    return loaded;
  }

  const exported = exportRegisteredBaselineHashes(
    loaded.document,
    optionalDeviceTelemetry(options),
  );
  if (!exported.ok) {
    return exported;
  }

  const complete = await assertRegistryCompleteAgainstKnownEvalDirectories({
    repoRoot: options.repoRoot,
    document: loaded.document,
    ...optionalDeviceTelemetry(options),
  });
  if (!complete.ok) {
    return complete;
  }

  return {
    ok: true,
    document: loaded.document,
    export: exported.export,
    completeness: {
      artifactCount: complete.artifactCount,
      coveredCount: complete.coveredCount,
    },
  };
}
