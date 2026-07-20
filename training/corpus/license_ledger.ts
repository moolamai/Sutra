/**
 * Per-shard provenance and license ledger schema.
 *
 * Provenance is authoritative per shard — corpus aggregates are derived.
 * Unknown licenseClass or unresolvable licenseId is excluded (never defaulted).
 * syntheticFlag / governmentFlag must align with consentClass.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SHARD_PROVENANCE_SCHEMA_VERSION =
  "training.shard-provenance.v1" as const;
export const LICENSE_LEDGER_SCHEMA_VERSION =
  "training.license-ledger.v1" as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Package root whether running from source or compiled `dist/`. */
export const LICENSE_LEDGER_PACKAGE_ROOT =
  path.basename(HERE) === "dist" ? path.resolve(HERE, "..") : HERE;

export const PROVENANCE_JSON_SCHEMA_PATH = path.join(
  LICENSE_LEDGER_PACKAGE_ROOT,
  "provenance_schema.json",
);

/** Soft caps (NFR — bounded scans). */
export const LICENSE_CATALOG_LIMIT = 512;
export const SHARD_PROVENANCE_LEDGER_LIMIT = 8192;
export const PROVENANCE_ID_MAX = 128;
export const PROVENANCE_PATH_MAX = 512;

export const PROVENANCE_CONSENT_CLASSES = Object.freeze([
  "consented",
  "public",
  "synthetic",
  "government",
] as const);
export type ProvenanceConsentClass =
  (typeof PROVENANCE_CONSENT_CLASSES)[number];

/**
 * Resolved license classes. `unknown` is intentionally absent —
 * unknown licenses are excluded at validation, never recorded.
 */
export const PROVENANCE_LICENSE_CLASSES = Object.freeze([
  "open",
  "restricted",
  "government",
  "proprietary",
] as const);
export type ProvenanceLicenseClass =
  (typeof PROVENANCE_LICENSE_CLASSES)[number];

export const PROVENANCE_LOCALITIES = Object.freeze([
  "on-device",
  "self-hosted",
] as const);
export type ProvenanceLocality = (typeof PROVENANCE_LOCALITIES)[number];

export type LicenseLedgerFailureClass =
  | "schema"
  | "license"
  | "consent"
  | "flag_mismatch"
  | "duplicate"
  | "size"
  | "config";

export type LicenseLedgerTelemetry = {
  event: "training.license_ledger";
  op:
    | "parse"
    | "validate"
    | "resolve"
    | "write"
    | "canonical_bytes"
    | "emit"
    | "audit";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  failureClass?: LicenseLedgerFailureClass;
  detail?: string;
  shardId?: string;
  sourceId?: string;
  licenseId?: string;
  entryCount?: number;
};

const idSchema = z
  .string()
  .min(1)
  .max(PROVENANCE_ID_MAX)
  .regex(/^[A-Za-z0-9._:-]+$/);

const pathSchema = z.string().min(1).max(PROVENANCE_PATH_MAX);

const laneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const licenseCatalogEntrySchema = z.object({
  licenseId: idSchema,
  licenseClass: z.enum(PROVENANCE_LICENSE_CLASSES),
  spdxOrLabel: z.string().min(1).max(128),
  uri: pathSchema.optional(),
});

export const shardProvenanceSchema = z.object({
  schemaVersion: z.literal(SHARD_PROVENANCE_SCHEMA_VERSION),
  shardId: idSchema,
  sourceId: idSchema,
  licenseId: idSchema,
  licenseClass: z.enum(PROVENANCE_LICENSE_CLASSES),
  consentClass: z.enum(PROVENANCE_CONSENT_CLASSES),
  syntheticFlag: z.boolean(),
  governmentFlag: z.boolean(),
  locality: z.enum(PROVENANCE_LOCALITIES).optional(),
  laneCode: laneSchema.optional(),
});

export const licenseLedgerDocumentSchema = z.object({
  schemaVersion: z.literal(LICENSE_LEDGER_SCHEMA_VERSION),
  manifestId: idSchema.optional(),
  catalog: z
    .array(licenseCatalogEntrySchema)
    .min(1)
    .max(LICENSE_CATALOG_LIMIT),
  entries: z
    .array(shardProvenanceSchema)
    .max(SHARD_PROVENANCE_LEDGER_LIMIT),
});

export type LicenseCatalogEntry = z.infer<typeof licenseCatalogEntrySchema>;
export type ShardProvenance = z.infer<typeof shardProvenanceSchema>;
export type LicenseLedgerDocument = z.infer<typeof licenseLedgerDocumentSchema>;

export type LicenseLedgerOk<T> = { ok: true; value: T };
export type LicenseLedgerFail = {
  ok: false;
  message: string;
  failureClass: LicenseLedgerFailureClass;
  path?: string;
};
export type LicenseLedgerResult<T> = LicenseLedgerOk<T> | LicenseLedgerFail;

function emit(
  onTelemetry: ((e: LicenseLedgerTelemetry) => void) | undefined,
  partial: Omit<LicenseLedgerTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "training.license_ledger",
    ...partial,
  });
}

function uniqueBy<T>(items: readonly T[], key: (v: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}

function sortedCopy<T>(values: readonly T[], key: (v: T) => string): T[] {
  return [...values].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Flags must mirror consentClass — no silent drift. */
export function flagsMatchConsentClass(
  consentClass: ProvenanceConsentClass,
  syntheticFlag: boolean,
  governmentFlag: boolean,
): boolean {
  const expectSynthetic = consentClass === "synthetic";
  const expectGovernment = consentClass === "government";
  return (
    syntheticFlag === expectSynthetic && governmentFlag === expectGovernment
  );
}

/**
 * Derive synthetic/government flags from consentClass (canonical mapping).
 */
export function flagsForConsentClass(consentClass: ProvenanceConsentClass): {
  syntheticFlag: boolean;
  governmentFlag: boolean;
} {
  return {
    syntheticFlag: consentClass === "synthetic",
    governmentFlag: consentClass === "government",
  };
}

/**
 * Cross-field validation for a single shard provenance record.
 * Does not resolve licenseId against a catalog (use validateShardProvenanceAgainstCatalog).
 */
export function validateShardProvenance(
  record: ShardProvenance,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LicenseLedgerTelemetry) => void;
  } = {},
): LicenseLedgerResult<ShardProvenance> {
  const subjectId = options.subjectId?.trim() || "subj.corpus.provenance";
  const deviceId = options.deviceId?.trim() || "dev-corpus-provenance";

  if (
    !flagsMatchConsentClass(
      record.consentClass,
      record.syntheticFlag,
      record.governmentFlag,
    )
  ) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message:
        `flag_mismatch: syntheticFlag=${record.syntheticFlag} governmentFlag=${record.governmentFlag} ` +
        `incompatible with consentClass=${record.consentClass}`,
      failureClass: "flag_mismatch",
      path: "syntheticFlag|governmentFlag",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "flag_mismatch",
      detail: fail.message,
      shardId: record.shardId,
      sourceId: record.sourceId,
    });
    return fail;
  }

  // Consented subject data and public corpora never share a shard identity —
  // consentClass is singular; this is a documentation-level invariant check.
  if (
    record.consentClass === "consented" &&
    (record.syntheticFlag || record.governmentFlag)
  ) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message: "consented shards cannot carry synthetic or government flags",
      failureClass: "consent",
      path: "consentClass",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "consent",
      detail: fail.message,
      shardId: record.shardId,
    });
    return fail;
  }

  emit(options.onTelemetry, {
    op: "validate",
    outcome: "ok",
    subjectId,
    deviceId,
    shardId: record.shardId,
    sourceId: record.sourceId,
    licenseId: record.licenseId,
  });
  return { ok: true, value: record };
}

/**
 * Resolve licenseId against a catalog. Unknown → exclude (license failure).
 * licenseClass on the shard must match the catalog entry.
 */
export function validateShardProvenanceAgainstCatalog(
  record: ShardProvenance,
  catalog: readonly LicenseCatalogEntry[],
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LicenseLedgerTelemetry) => void;
  } = {},
): LicenseLedgerResult<ShardProvenance> {
  const subjectId = options.subjectId?.trim() || "subj.corpus.provenance";
  const deviceId = options.deviceId?.trim() || "dev-corpus-provenance";

  const base = validateShardProvenance(record, options);
  if (!base.ok) return base;

  if (catalog.length > LICENSE_CATALOG_LIMIT) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message: `license catalog exceeds ${LICENSE_CATALOG_LIMIT}`,
      failureClass: "size",
      path: "catalog",
    };
    emit(options.onTelemetry, {
      op: "resolve",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "size",
      detail: fail.message,
    });
    return fail;
  }

  const entry = catalog.find((c) => c.licenseId === record.licenseId);
  if (!entry) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message: `unknown licenseId (exclude): ${record.licenseId}`,
      failureClass: "license",
      path: "licenseId",
    };
    emit(options.onTelemetry, {
      op: "resolve",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "license",
      detail: fail.message,
      shardId: record.shardId,
      sourceId: record.sourceId,
      licenseId: record.licenseId,
    });
    return fail;
  }

  if (entry.licenseClass !== record.licenseClass) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message:
        `licenseClass mismatch for ${record.licenseId}: ` +
        `shard=${record.licenseClass} catalog=${entry.licenseClass}`,
      failureClass: "license",
      path: "licenseClass",
    };
    emit(options.onTelemetry, {
      op: "resolve",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "license",
      detail: fail.message,
      shardId: record.shardId,
      licenseId: record.licenseId,
    });
    return fail;
  }

  emit(options.onTelemetry, {
    op: "resolve",
    outcome: "ok",
    subjectId,
    deviceId,
    shardId: record.shardId,
    licenseId: record.licenseId,
  });
  return { ok: true, value: record };
}

export function parseShardProvenance(
  input: unknown,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LicenseLedgerTelemetry) => void;
  } = {},
): LicenseLedgerResult<ShardProvenance> {
  const subjectId = options.subjectId?.trim() || "subj.corpus.provenance";
  const deviceId = options.deviceId?.trim() || "dev-corpus-provenance";

  const parsed = shardProvenanceSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue?.message ?? "shard provenance schema validation failed";
    // Explicit rejection of unknown as a license class string.
    const rawClass =
      input &&
      typeof input === "object" &&
      typeof (input as { licenseClass?: unknown }).licenseClass === "string"
        ? (input as { licenseClass: string }).licenseClass
        : undefined;
    const failureClass: LicenseLedgerFailureClass =
      rawClass === "unknown" || /unknown/i.test(message)
        ? "license"
        : "schema";
    const fail: LicenseLedgerFail = {
      ok: false,
      message:
        rawClass === "unknown"
          ? "unknown licenseClass is excluded (never recorded)"
          : message,
      failureClass,
      ...(issue?.path?.length
        ? { path: issue.path.map(String).join(".") }
        : {}),
    };
    emit(options.onTelemetry, {
      op: "parse",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass,
      detail: fail.message,
    });
    return fail;
  }

  return validateShardProvenance(parsed.data, options);
}

/**
 * Validate a full per-shard license ledger document (catalog + entries).
 */
export function parseLicenseLedgerDocument(
  input: unknown,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LicenseLedgerTelemetry) => void;
  } = {},
): LicenseLedgerResult<LicenseLedgerDocument> {
  const subjectId = options.subjectId?.trim() || "subj.corpus.provenance";
  const deviceId = options.deviceId?.trim() || "dev-corpus-provenance";

  const parsed = licenseLedgerDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const fail: LicenseLedgerFail = {
      ok: false,
      message: issue?.message ?? "license ledger schema validation failed",
      failureClass: "schema",
      ...(issue?.path?.length
        ? { path: issue.path.map(String).join(".") }
        : {}),
    };
    emit(options.onTelemetry, {
      op: "parse",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }

  const doc = parsed.data;
  if (!uniqueBy(doc.catalog, (c) => c.licenseId)) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message: "catalog.licenseId values must be unique",
      failureClass: "duplicate",
      path: "catalog",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "duplicate",
      detail: fail.message,
    });
    return fail;
  }
  if (!uniqueBy(doc.entries, (e) => e.shardId)) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message: "entries.shardId values must be unique (per-shard authority)",
      failureClass: "duplicate",
      path: "entries",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "duplicate",
      detail: fail.message,
    });
    return fail;
  }

  // One ledger = one consent class. Consented subject data and public corpora
  // never mix in the same ledger (corpus field is singular / first-class).
  if (doc.entries.length >= 2) {
    const classes = new Set(doc.entries.map((e) => e.consentClass));
    if (classes.size > 1) {
      const fail: LicenseLedgerFail = {
        ok: false,
        message:
          `consent class mismatch across ledger entries: ${[...classes].sort().join(",")}` +
          " (consented vs public mix blocked)",
        failureClass: "consent",
        path: "entries.consentClass",
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        failureClass: "consent",
        detail: fail.message,
      });
      return fail;
    }
  }

  for (let i = 0; i < doc.entries.length; i++) {
    const entry = doc.entries[i]!;
    const checked = validateShardProvenanceAgainstCatalog(
      entry,
      doc.catalog,
      options,
    );
    if (!checked.ok) {
      return {
        ...checked,
        path: checked.path
          ? `entries[${i}].${checked.path}`
          : `entries[${i}]`,
      };
    }
  }

  const normalized: LicenseLedgerDocument = {
    ...doc,
    catalog: sortedCopy(doc.catalog, (c) => c.licenseId),
    entries: sortedCopy(doc.entries, (e) => e.shardId),
  };

  emit(options.onTelemetry, {
    op: "validate",
    outcome: "ok",
    subjectId,
    deviceId,
    entryCount: normalized.entries.length,
    ...(normalized.manifestId !== undefined
      ? { detail: `manifestId=${normalized.manifestId}` }
      : {}),
  });
  return { ok: true, value: normalized };
}

/** Canonical JSON bytes for deterministic ledger identity. */
export function canonicalLicenseLedgerBytes(
  document: LicenseLedgerDocument,
): Buffer {
  const normalized: LicenseLedgerDocument = {
    schemaVersion: document.schemaVersion,
    ...(document.manifestId !== undefined
      ? { manifestId: document.manifestId }
      : {}),
    catalog: sortedCopy(document.catalog, (c) => c.licenseId).map((c) => ({
      licenseId: c.licenseId,
      licenseClass: c.licenseClass,
      spdxOrLabel: c.spdxOrLabel,
      ...(c.uri !== undefined ? { uri: c.uri } : {}),
    })),
    entries: sortedCopy(document.entries, (e) => e.shardId).map((e) => ({
      schemaVersion: e.schemaVersion,
      shardId: e.shardId,
      sourceId: e.sourceId,
      licenseId: e.licenseId,
      licenseClass: e.licenseClass,
      consentClass: e.consentClass,
      syntheticFlag: e.syntheticFlag,
      governmentFlag: e.governmentFlag,
      ...(e.locality !== undefined ? { locality: e.locality } : {}),
      ...(e.laneCode !== undefined ? { laneCode: e.laneCode } : {}),
    })),
  };
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function sha256PrefixedLedger(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Validate-on-write: reject unknown licenses; write only after full validation.
 */
export function writeLicenseLedgerDocument(
  filePath: string,
  input: unknown,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LicenseLedgerTelemetry) => void;
  } = {},
): LicenseLedgerResult<LicenseLedgerDocument> {
  const subjectId = options.subjectId?.trim() || "subj.corpus.provenance";
  const deviceId = options.deviceId?.trim() || "dev-corpus-provenance";
  const validated = parseLicenseLedgerDocument(input, options);
  if (!validated.ok) {
    emit(options.onTelemetry, {
      op: "write",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: validated.failureClass,
      detail: validated.message,
    });
    return validated;
  }

  const bytes = canonicalLicenseLedgerBytes(validated.value);
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  writeFileSync(filePath, bytes);

  emit(options.onTelemetry, {
    op: "write",
    outcome: "ok",
    subjectId,
    deviceId,
    entryCount: validated.value.entries.length,
    detail: sha256PrefixedLedger(bytes),
  });
  return validated;
}

export function loadLicenseLedgerDocument(
  filePath: string,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LicenseLedgerTelemetry) => void;
  } = {},
): LicenseLedgerResult<LicenseLedgerDocument> {
  const subjectId = options.subjectId?.trim() || "subj.corpus.provenance";
  const deviceId = options.deviceId?.trim() || "dev-corpus-provenance";
  if (!existsSync(filePath)) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message: `license ledger missing: ${filePath}`,
      failureClass: "config",
      path: filePath,
    };
    emit(options.onTelemetry, {
      op: "parse",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail: fail.message,
    });
    return fail;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message: `license ledger parse failed: ${err instanceof Error ? err.message : String(err)}`,
      failureClass: "schema",
      path: filePath,
    };
    emit(options.onTelemetry, {
      op: "parse",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }
  return parseLicenseLedgerDocument(raw, options);
}

/**
 * Build a provenance record from source + consent, applying flag mapping.
 * Caller must supply a resolvable licenseId/licenseClass pair.
 */
export function buildShardProvenance(input: {
  shardId: string;
  sourceId: string;
  licenseId: string;
  licenseClass: ProvenanceLicenseClass;
  consentClass: ProvenanceConsentClass;
  locality?: ProvenanceLocality;
  laneCode?: string;
}): ShardProvenance {
  const flags = flagsForConsentClass(input.consentClass);
  return {
    schemaVersion: SHARD_PROVENANCE_SCHEMA_VERSION,
    shardId: input.shardId,
    sourceId: input.sourceId,
    licenseId: input.licenseId,
    licenseClass: input.licenseClass,
    consentClass: input.consentClass,
    syntheticFlag: flags.syntheticFlag,
    governmentFlag: flags.governmentFlag,
    ...(input.locality !== undefined ? { locality: input.locality } : {}),
    ...(input.laneCode !== undefined ? { laneCode: input.laneCode } : {}),
  };
}

/** Relative path for the ledger file emitted next to shards / build-report. */
export const LICENSE_LEDGER_BUILD_RELPATH = "license-ledger.json" as const;

export type CorpusExcludedShardReason =
  | "unknown_license"
  | "ret_excluded_from_weights"
  | "empty_after_dedup"
  | "unresolvable_license_class";

export type CorpusExcludedShard = {
  sourceId: string;
  reason: CorpusExcludedShardReason;
  licenseId?: string;
  detail?: string;
};

export type ManifestLicenseLedgerInput = {
  licenseId: string;
  spdxOrLabel: string;
  /** Present only when known; `undefined` allowed for Zod / exactOptionalPropertyTypes. */
  uri?: string | undefined;
  /** When omitted, inferred from spdxOrLabel — never defaults to a guess that invents rights. */
  licenseClass?: ProvenanceLicenseClass | undefined;
};

/**
 * Infer licenseClass from an SPDX / label string.
 * Returns null when inference is unsafe (caller must exclude — never invent rights).
 */
export function inferLicenseClassFromLabel(
  spdxOrLabel: string,
): ProvenanceLicenseClass | null {
  const u = spdxOrLabel.trim().toUpperCase();
  if (!u) return null;
  if (
    /\b(CC-BY|CC0|MIT|APACHE-2\.0|APACHE 2|BSD-2|BSD-3|ISC|0BSD|UNLICENSE)\b/.test(
      u,
    )
  ) {
    return "open";
  }
  if (/\b(GOV|GOVERNMENT|PUBLIC.?DOMAIN.?GOV)\b/.test(u)) {
    return "government";
  }
  if (/\b(PROPRIETARY|COMMERCIAL|ALL RIGHTS RESERVED)\b/.test(u)) {
    return "proprietary";
  }
  if (/\b(RESTRICTED|NDA|INTERNAL.?ONLY)\b/.test(u)) {
    return "restricted";
  }
  return null;
}

/**
 * Build a resolvable license catalog from manifest licenseLedger rows.
 * Missing licenseClass + non-inferable label → license failure (exclude path).
 */
export function catalogFromManifestLicenseLedger(
  entries: readonly ManifestLicenseLedgerInput[],
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LicenseLedgerTelemetry) => void;
  } = {},
): LicenseLedgerResult<LicenseCatalogEntry[]> {
  const subjectId = options.subjectId?.trim() || "subj.corpus.provenance";
  const deviceId = options.deviceId?.trim() || "dev-corpus-provenance";

  if (entries.length < 1) {
    const fail: LicenseLedgerFail = {
      ok: false,
      message: "license catalog empty",
      failureClass: "license",
      path: "catalog",
    };
    emit(options.onTelemetry, {
      op: "resolve",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "license",
      detail: fail.message,
    });
    return fail;
  }
  if (entries.length > LICENSE_CATALOG_LIMIT) {
    return {
      ok: false,
      message: `license catalog exceeds ${LICENSE_CATALOG_LIMIT}`,
      failureClass: "size",
      path: "catalog",
    };
  }

  const catalog: LicenseCatalogEntry[] = [];
  for (const row of entries) {
    const licenseClass =
      row.licenseClass ?? inferLicenseClassFromLabel(row.spdxOrLabel);
    if (!licenseClass) {
      const fail: LicenseLedgerFail = {
        ok: false,
        message: `unresolvable licenseClass for licenseId=${row.licenseId} (exclude)`,
        failureClass: "license",
        path: `licenseId:${row.licenseId}`,
      };
      emit(options.onTelemetry, {
        op: "resolve",
        outcome: "error",
        subjectId,
        deviceId,
        failureClass: "license",
        detail: fail.message,
        licenseId: row.licenseId,
      });
      return fail;
    }
    catalog.push({
      licenseId: row.licenseId,
      licenseClass,
      spdxOrLabel: row.spdxOrLabel,
      ...(row.uri !== undefined ? { uri: row.uri } : {}),
    });
  }

  if (!uniqueBy(catalog, (c) => c.licenseId)) {
    return {
      ok: false,
      message: "catalog.licenseId values must be unique",
      failureClass: "duplicate",
      path: "catalog",
    };
  }

  emit(options.onTelemetry, {
    op: "resolve",
    outcome: "ok",
    subjectId,
    deviceId,
    entryCount: catalog.length,
    detail: "manifest_catalog",
  });
  return { ok: true, value: sortedCopy(catalog, (c) => c.licenseId) };
}

export type AssembleBuildLicenseLedgerInput = {
  manifestId: string;
  catalog: readonly LicenseCatalogEntry[];
  shards: readonly {
    shardId: string;
    sourceId: string;
    licenseId: string;
    laneCode?: string;
  }[];
  consentClass: ProvenanceConsentClass;
  locality?: ProvenanceLocality;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: LicenseLedgerTelemetry) => void;
};

export type AssembledBuildLicenseLedger = {
  document: LicenseLedgerDocument;
  bytes: Buffer;
  contentHash: string;
  relpath: typeof LICENSE_LEDGER_BUILD_RELPATH;
};

/**
 * Assemble the per-shard license ledger for a corpus build (deterministic bytes).
 * A shard whose licenseId is missing from the catalog is omitted from entries
 * and must be recorded as excluded by the builder — never defaulted in.
 */
export function assembleBuildLicenseLedger(
  input: AssembleBuildLicenseLedgerInput,
):
  | { ok: true; value: AssembledBuildLicenseLedger }
  | {
      ok: false;
      message: string;
      failureClass: LicenseLedgerFailureClass;
      unresolvedSourceIds: string[];
    } {
  const subjectId = input.subjectId?.trim() || "subj.corpus.provenance";
  const deviceId = input.deviceId?.trim() || "dev-corpus-provenance";
  const catalogById = new Map(
    input.catalog.map((c) => [c.licenseId, c] as const),
  );
  const unresolvedSourceIds: string[] = [];
  const entries: ShardProvenance[] = [];

  for (const shard of sortedCopy(input.shards, (s) => s.shardId)) {
    const cat = catalogById.get(shard.licenseId);
    if (!cat) {
      unresolvedSourceIds.push(shard.sourceId);
      continue;
    }
    const record = buildShardProvenance({
      shardId: shard.shardId,
      sourceId: shard.sourceId,
      licenseId: shard.licenseId,
      licenseClass: cat.licenseClass,
      consentClass: input.consentClass,
      ...(input.locality !== undefined ? { locality: input.locality } : {}),
      ...(shard.laneCode !== undefined ? { laneCode: shard.laneCode } : {}),
    });
    const checked = validateShardProvenanceAgainstCatalog(
      record,
      input.catalog,
      {
        subjectId,
        deviceId,
        ...(input.onTelemetry !== undefined
          ? { onTelemetry: input.onTelemetry }
          : {}),
      },
    );
    if (!checked.ok) {
      unresolvedSourceIds.push(shard.sourceId);
      continue;
    }
    entries.push(checked.value);
  }

  if (unresolvedSourceIds.length > 0) {
    emit(input.onTelemetry, {
      op: "emit",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "license",
      detail: `unresolved license for sources: ${unresolvedSourceIds.sort().join(",")}`,
    });
    return {
      ok: false,
      message: `shard without resolvable license excluded: ${unresolvedSourceIds.sort().join(",")}`,
      failureClass: "license",
      unresolvedSourceIds: [...unresolvedSourceIds].sort((a, b) =>
        a.localeCompare(b),
      ),
    };
  }

  const document: LicenseLedgerDocument = {
    schemaVersion: LICENSE_LEDGER_SCHEMA_VERSION,
    manifestId: input.manifestId,
    catalog: sortedCopy(input.catalog, (c) => c.licenseId),
    entries: sortedCopy(entries, (e) => e.shardId),
  };

  const parsed = parseLicenseLedgerDocument(document, {
    subjectId,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!parsed.ok) {
    return {
      ok: false,
      message: parsed.message,
      failureClass: parsed.failureClass,
      unresolvedSourceIds: [],
    };
  }

  const bytes = canonicalLicenseLedgerBytes(parsed.value);
  const contentHash = sha256PrefixedLedger(bytes);

  emit(input.onTelemetry, {
    op: "emit",
    outcome: "ok",
    subjectId,
    deviceId,
    entryCount: parsed.value.entries.length,
    detail: contentHash,
  });

  return {
    ok: true,
    value: {
      document: parsed.value,
      bytes,
      contentHash,
      relpath: LICENSE_LEDGER_BUILD_RELPATH,
    },
  };
}

/** Package-relative audit fixture directory (CI / prove). */
export const PROVENANCE_AUDIT_FIXTURE_DIR =
  "fixtures/provenance/audit" as const;

export const PROVENANCE_AUDIT_ACCEPTED_FIXTURE =
  "accepted-ledger.json" as const;
export const PROVENANCE_AUDIT_UNKNOWN_LICENSE_FIXTURE =
  "negative-unknown-license.json" as const;
export const PROVENANCE_AUDIT_CONSENT_MIX_FIXTURE =
  "negative-consent-mix.json" as const;
export const PROVENANCE_AUDIT_STABLE_HASH_FIXTURE =
  "stable-hash-inputs.json" as const;

export type ProvenanceStableHashInputs = {
  manifestId: string;
  consentClass: ProvenanceConsentClass;
  locality?: ProvenanceLocality;
  catalog: ManifestLicenseLedgerInput[];
  shards: {
    shardId: string;
    sourceId: string;
    licenseId: string;
    laneCode?: string;
  }[];
};

export type ProvenanceAuditProveOk = {
  ok: true;
  acceptedEntryCount: number;
  unknownLicenseExcluded: true;
  consentMixBlocked: true;
  ledgerHashStable: true;
  ledgerContentHash: string;
};

export type ProvenanceAuditProveFail = {
  ok: false;
  failureClass: LicenseLedgerFailureClass;
  detail: string;
};

/**
 * Provenance audit prove (read-only over committed fixtures):
 * 1) accepted ledger loads and validates
 * 2) unknown-license fixture is excluded (license failure)
 * 3) consented vs public mix fixture is blocked (consent failure)
 * 4) stable-hash inputs assemble to the same content hash twice
 *
 * Idempotent for CI — does not write under the package fixture tree.
 */
export function proveProvenanceAudit(
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LicenseLedgerTelemetry) => void;
  } = {},
): ProvenanceAuditProveOk | ProvenanceAuditProveFail {
  const packageRoot = options.packageRoot ?? LICENSE_LEDGER_PACKAGE_ROOT;
  const subjectId = options.subjectId?.trim() || "subj.corpus.provenance.audit";
  const deviceId = options.deviceId?.trim() || "dev-corpus-provenance-audit";
  const auditDir = path.join(packageRoot, PROVENANCE_AUDIT_FIXTURE_DIR);

  emit(options.onTelemetry, {
    op: "audit",
    outcome: "ok",
    subjectId,
    deviceId,
    detail: "prove_start",
  });

  const acceptedPath = path.join(auditDir, PROVENANCE_AUDIT_ACCEPTED_FIXTURE);
  const accepted = loadLicenseLedgerDocument(acceptedPath, {
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!accepted.ok) {
    emit(options.onTelemetry, {
      op: "audit",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: accepted.failureClass,
      detail: accepted.message,
    });
    return {
      ok: false,
      failureClass: accepted.failureClass,
      detail: `accepted ledger: ${accepted.message}`,
    };
  }

  const unknownPath = path.join(
    auditDir,
    PROVENANCE_AUDIT_UNKNOWN_LICENSE_FIXTURE,
  );
  const unknown = loadLicenseLedgerDocument(unknownPath, {
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (unknown.ok || unknown.failureClass !== "license") {
    const detail = unknown.ok
      ? "unknown-license fixture must be excluded (got ok)"
      : `unknown-license fixture expected failureClass=license got ${unknown.failureClass}: ${unknown.message}`;
    emit(options.onTelemetry, {
      op: "audit",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "license",
      detail,
    });
    return { ok: false, failureClass: "license", detail };
  }

  const mixPath = path.join(auditDir, PROVENANCE_AUDIT_CONSENT_MIX_FIXTURE);
  const mix = loadLicenseLedgerDocument(mixPath, {
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (mix.ok || mix.failureClass !== "consent") {
    const detail = mix.ok
      ? "consent-mix fixture must be blocked (got ok)"
      : `consent-mix fixture expected failureClass=consent got ${mix.failureClass}: ${mix.message}`;
    emit(options.onTelemetry, {
      op: "audit",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "consent",
      detail,
    });
    return { ok: false, failureClass: "consent", detail };
  }

  const stablePath = path.join(auditDir, PROVENANCE_AUDIT_STABLE_HASH_FIXTURE);
  if (!existsSync(stablePath)) {
    return {
      ok: false,
      failureClass: "config",
      detail: `stable-hash fixture missing: ${stablePath}`,
    };
  }
  let stableRaw: unknown;
  try {
    stableRaw = JSON.parse(readFileSync(stablePath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      failureClass: "schema",
      detail: `stable-hash fixture parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const stable = stableRaw as ProvenanceStableHashInputs;
  if (
    typeof stable?.manifestId !== "string" ||
    !Array.isArray(stable.catalog) ||
    !Array.isArray(stable.shards) ||
    typeof stable.consentClass !== "string"
  ) {
    return {
      ok: false,
      failureClass: "schema",
      detail: "stable-hash fixture missing required fields",
    };
  }

  const catalog = catalogFromManifestLicenseLedger(stable.catalog, {
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!catalog.ok) {
    return {
      ok: false,
      failureClass: catalog.failureClass,
      detail: `stable-hash catalog: ${catalog.message}`,
    };
  }

  const assembleOpts = {
    manifestId: stable.manifestId,
    catalog: catalog.value,
    shards: stable.shards,
    consentClass: stable.consentClass as ProvenanceConsentClass,
    ...(stable.locality !== undefined
      ? { locality: stable.locality as ProvenanceLocality }
      : {}),
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  };
  const first = assembleBuildLicenseLedger(assembleOpts);
  if (!first.ok) {
    return {
      ok: false,
      failureClass: first.failureClass,
      detail: `stable-hash assemble failed: ${first.message}`,
    };
  }
  const second = assembleBuildLicenseLedger({
    ...assembleOpts,
    shards: [...stable.shards].reverse(),
  });
  if (!second.ok) {
    return {
      ok: false,
      failureClass: second.failureClass,
      detail: `stable-hash assemble failed: ${second.message}`,
    };
  }
  if (first.value.contentHash !== second.value.contentHash) {
    emit(options.onTelemetry, {
      op: "audit",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "schema",
      detail: "ledger hash not stable across rebuild",
    });
    return {
      ok: false,
      failureClass: "schema",
      detail: "ledger hash not stable across rebuild",
    };
  }

  emit(options.onTelemetry, {
    op: "audit",
    outcome: "ok",
    subjectId,
    deviceId,
    entryCount: accepted.value.entries.length,
    detail: first.value.contentHash,
  });

  return {
    ok: true,
    acceptedEntryCount: accepted.value.entries.length,
    unknownLicenseExcluded: true,
    consentMixBlocked: true,
    ledgerHashStable: true,
    ledgerContentHash: first.value.contentHash,
  };
}

/**
 * CLI entry for provenance audit prove.
 */
export function runProveProvenanceAuditCli(
  argv: string[],
  io: {
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
  },
): number {
  void argv;
  const subjectId = "subj.corpus.prove.provenance.cli";
  const deviceId = "dev-corpus-prove-provenance-cli";
  const result = proveProvenanceAudit({
    packageRoot: LICENSE_LEDGER_PACKAGE_ROOT,
    subjectId,
    deviceId,
  });
  if (!result.ok) {
    io.stderr.write(
      `${JSON.stringify({
        outcome: "error",
        failureClass: result.failureClass,
        detail: result.detail,
        subjectId,
        deviceId,
      })}\n`,
    );
    return 1;
  }
  io.stdout.write(
    `${JSON.stringify({
      outcome: "ok",
      acceptedEntryCount: result.acceptedEntryCount,
      unknownLicenseExcluded: result.unknownLicenseExcluded,
      consentMixBlocked: result.consentMixBlocked,
      ledgerHashStable: result.ledgerHashStable,
      ledgerContentHash: result.ledgerContentHash,
      subjectId,
      deviceId,
    })}\n`,
  );
  return 0;
}
