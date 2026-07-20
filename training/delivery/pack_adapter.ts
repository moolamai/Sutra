/**
 * Adapter delta packaging — schema boundary + GRPO→content-addressed packer.
 *
 * Validates manifests against the committed JSON schema, packs LoRA delta
 * bytes from the GRPO trainer into a content-addressed blob, binds to the
 * base checkpoint + complete C4 lineageRef, and emits a manifest + blob pair
 * consumed by the SlmRuntime loud-fail loader (verify hashes, then apply).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION =
  "adapter.delta.manifest.v1" as const;

export const CHECKPOINT_LINEAGE_SCHEMA_VERSION =
  "checkpoint.lineage.v1" as const;

/** Soft bound on adapter blob refs / opaque ids (NFR — no unbounded scans). */
export const ADAPTER_MANIFEST_ID_LIMIT = 128;
export const ADAPTER_MANIFEST_BLOB_REF_LIMIT = 512;
export const ADAPTER_MANIFEST_CRITIC_PIN_LIMIT = 16;

/** Soft cap on packed adapter blob bytes (MB-scale; mirrors trainer bound). */
export const ADAPTER_PACK_BYTE_LIMIT = 4 * 1024 * 1024;

/** Bound on in-process pack cache entries per process (no unbounded growth). */
export const ADAPTER_PACK_CACHE_LIMIT = 64;

export const ADAPTER_PRECISION_FORMATS = Object.freeze([
  "fp32",
  "fp16",
  "bf16",
  "int8",
  "int4",
  "nf4",
] as const);

export type AdapterPrecisionFormat =
  (typeof ADAPTER_PRECISION_FORMATS)[number];

export const ADAPTER_MANIFEST_LOCALITIES = Object.freeze([
  "on-device",
  "self-hosted",
] as const);

export type AdapterManifestLocality =
  (typeof ADAPTER_MANIFEST_LOCALITIES)[number];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ADAPTER_FORMAT_JSON_SCHEMA_PATH = path.join(
  __dirname,
  "adapter_format.json",
);

export type AdapterDeltaLineageRef = {
  schemaVersion: typeof CHECKPOINT_LINEAGE_SCHEMA_VERSION;
  runId: string;
  checkpointHash: string;
  corpusManifestHash: string;
  criticVersions: ReadonlyArray<{
    rubricId: string;
    rubricVersion: string;
    contentHash: string;
  }>;
};

export type AdapterDeltaManifest = {
  schemaVersion: typeof ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION;
  contentHash: string;
  baseModelHash: string;
  precisionFormat: AdapterPrecisionFormat;
  loraRank: number;
  loraAlpha: number;
  lineageRef: AdapterDeltaLineageRef;
  adapterBlobRef: string;
  subjectId: string;
  deviceId: string;
  locality: AdapterManifestLocality;
};

export type AdapterManifestFailureClass =
  | "adapter.manifest.schema_missing"
  | "adapter.manifest.schema_mismatch"
  | "adapter.manifest.invalid"
  | "adapter.manifest.floating_checkpoint"
  | "adapter.manifest.lineage_incomplete"
  | "adapter.manifest.subject_scope"
  | "adapter.manifest.locality_forbidden"
  | "adapter.manifest.hash_format"
  | "adapter.pack.empty_delta"
  | "adapter.pack.byte_limit"
  | "adapter.pack.base_mismatch"
  | "adapter.pack.trainer_hash_mismatch"
  | "adapter.pack.idempotent_conflict";

export type AdapterManifestTelemetryEvent = {
  event:
    | "training.adapter.manifest_validate"
    | "training.adapter.pack_emit";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  schemaVersion?: string;
  contentHash?: string;
  baseModelHash?: string;
  precisionFormat?: string;
  byteLength?: number;
  idempotentReplay?: boolean;
  failureClass?: AdapterManifestFailureClass;
};

export class AdapterManifestContractError extends Error {
  readonly obligation: AdapterManifestFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: AdapterManifestFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "AdapterManifestContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

function emitTelemetry(
  onTelemetry: ((e: AdapterManifestTelemetryEvent) => void) | undefined,
  event: AdapterManifestTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertId(
  value: unknown,
  field: string,
  meta: { subjectId?: string; deviceId?: string },
  max = ADAPTER_MANIFEST_ID_LIMIT,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > max
  ) {
    throw new AdapterManifestContractError(`${field} required`, {
      obligation: "adapter.manifest.invalid",
      ...meta,
      failingSlice: field,
    });
  }
  return value.trim();
}

function assertSha256(
  value: unknown,
  field: string,
  meta: { subjectId?: string; deviceId?: string },
): string {
  const s = assertId(value, field, meta, 128);
  if (!SHA256_RE.test(s)) {
    throw new AdapterManifestContractError(`${field} must be sha256:<64 hex>`, {
      obligation: "adapter.manifest.hash_format",
      ...meta,
      failingSlice: field,
    });
  }
  return s;
}

function assertOpaqueHash(
  value: unknown,
  field: string,
  meta: { subjectId?: string; deviceId?: string },
): string {
  const s = assertId(value, field, meta, 128);
  if (s.toLowerCase() === "latest") {
    throw new AdapterManifestContractError(
      `floating checkpoint 'latest' forbidden on ${field}`,
      {
        obligation: "adapter.manifest.floating_checkpoint",
        ...meta,
        failingSlice: field,
      },
    );
  }
  if (s.length < 8) {
    throw new AdapterManifestContractError(`${field} too short`, {
      obligation: "adapter.manifest.invalid",
      ...meta,
      failingSlice: field,
    });
  }
  return s;
}

/**
 * Assert the committed JSON schema file is present and version-locked.
 */
export function assertCommittedAdapterFormatSchemaPresent(): void {
  if (!existsSync(ADAPTER_FORMAT_JSON_SCHEMA_PATH)) {
    throw new AdapterManifestContractError(
      `committed JSON schema missing: ${ADAPTER_FORMAT_JSON_SCHEMA_PATH}`,
      { obligation: "adapter.manifest.schema_missing" },
    );
  }
  const raw = JSON.parse(
    readFileSync(ADAPTER_FORMAT_JSON_SCHEMA_PATH, "utf8"),
  ) as {
    schemaVersion?: string;
    properties?: { schemaVersion?: { const?: string } };
  };
  const constVersion = raw.properties?.schemaVersion?.const;
  if (
    raw.schemaVersion !== ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION ||
    constVersion !== ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION
  ) {
    throw new AdapterManifestContractError(
      "adapter_format.json schemaVersion mismatch",
      {
        obligation: "adapter.manifest.schema_mismatch",
        failingSlice: String(constVersion ?? raw.schemaVersion),
      },
    );
  }
}

function parseLineageRef(
  raw: unknown,
  meta: { subjectId?: string; deviceId?: string },
): AdapterDeltaLineageRef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterManifestContractError("lineageRef required", {
      obligation: "adapter.manifest.lineage_incomplete",
      ...meta,
      failingSlice: "lineageRef",
    });
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== CHECKPOINT_LINEAGE_SCHEMA_VERSION) {
    throw new AdapterManifestContractError(
      "lineageRef.schemaVersion must be checkpoint.lineage.v1",
      {
        obligation: "adapter.manifest.lineage_incomplete",
        ...meta,
        failingSlice: "lineageRef.schemaVersion",
      },
    );
  }
  const runId = assertId(obj.runId, "lineageRef.runId", meta);
  const checkpointHash = assertOpaqueHash(
    obj.checkpointHash,
    "lineageRef.checkpointHash",
    meta,
  );
  const corpusManifestHash = assertSha256(
    obj.corpusManifestHash,
    "lineageRef.corpusManifestHash",
    meta,
  );
  if (!Array.isArray(obj.criticVersions) || obj.criticVersions.length < 1) {
    throw new AdapterManifestContractError(
      "lineageRef.criticVersions must be non-empty (complete C4 row)",
      {
        obligation: "adapter.manifest.lineage_incomplete",
        ...meta,
        failingSlice: "lineageRef.criticVersions",
      },
    );
  }
  if (obj.criticVersions.length > ADAPTER_MANIFEST_CRITIC_PIN_LIMIT) {
    throw new AdapterManifestContractError(
      "lineageRef.criticVersions exceeds pin limit",
      {
        obligation: "adapter.manifest.invalid",
        ...meta,
        failingSlice: "lineageRef.criticVersions",
      },
    );
  }
  const criticVersions = obj.criticVersions.map((pin, i) => {
    if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
      throw new AdapterManifestContractError("critic pin invalid", {
        obligation: "adapter.manifest.lineage_incomplete",
        ...meta,
        failingSlice: `lineageRef.criticVersions[${i}]`,
      });
    }
    const p = pin as Record<string, unknown>;
    return {
      rubricId: assertId(p.rubricId, `critic[${i}].rubricId`, meta),
      rubricVersion: assertId(
        p.rubricVersion,
        `critic[${i}].rubricVersion`,
        meta,
      ),
      contentHash: assertSha256(
        p.contentHash,
        `critic[${i}].contentHash`,
        meta,
      ),
    };
  });
  return {
    schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
    runId,
    checkpointHash,
    corpusManifestHash,
    criticVersions,
  };
}

export type ParseAdapterManifestOptions = {
  subjectId: string;
  deviceId: string;
  onTelemetry?: (e: AdapterManifestTelemetryEvent) => void;
};

export type ParseAdapterManifestResult =
  | { ok: true; value: AdapterDeltaManifest }
  | { ok: false; error: AdapterManifestContractError };

/**
 * Parse and validate an adapter delta manifest at the packaging boundary.
 * Untrusted wire payloads must pass here before pack/load.
 */
export function parseAdapterDeltaManifest(
  raw: unknown,
  options: ParseAdapterManifestOptions,
): ParseAdapterManifestResult {
  const subjectId = assertId(options.subjectId, "subjectId", {});
  const deviceId = assertId(options.deviceId, "deviceId", { subjectId });
  const meta = { subjectId, deviceId };

  try {
    assertCommittedAdapterFormatSchemaPresent();

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AdapterManifestContractError("manifest must be an object", {
        obligation: "adapter.manifest.invalid",
        ...meta,
      });
    }
    const obj = raw as Record<string, unknown>;

    if (obj.schemaVersion !== ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION) {
      throw new AdapterManifestContractError(
        "schemaVersion must be adapter.delta.manifest.v1",
        {
          obligation: "adapter.manifest.schema_mismatch",
          ...meta,
          failingSlice: String(obj.schemaVersion),
        },
      );
    }

    const manifestSubject = assertId(obj.subjectId, "subjectId", meta);
    const manifestDevice = assertId(obj.deviceId, "deviceId", meta);
    if (manifestSubject !== subjectId) {
      throw new AdapterManifestContractError(
        "cross-subject adapter manifest access denied",
        {
          obligation: "adapter.manifest.subject_scope",
          subjectId,
          deviceId,
          failingSlice: manifestSubject,
        },
      );
    }

    const locality = obj.locality;
    if (locality !== "on-device" && locality !== "self-hosted") {
      throw new AdapterManifestContractError(
        "locality must be on-device or self-hosted",
        {
          obligation: "adapter.manifest.locality_forbidden",
          ...meta,
          failingSlice: String(locality),
        },
      );
    }

    const precisionFormat = obj.precisionFormat;
    if (
      typeof precisionFormat !== "string" ||
      !(ADAPTER_PRECISION_FORMATS as readonly string[]).includes(precisionFormat)
    ) {
      throw new AdapterManifestContractError("precisionFormat invalid", {
        obligation: "adapter.manifest.invalid",
        ...meta,
        failingSlice: "precisionFormat",
      });
    }

    const loraRank = obj.loraRank;
    const loraAlpha = obj.loraAlpha;
    if (
      !Number.isInteger(loraRank) ||
      (loraRank as number) < 1 ||
      (loraRank as number) > 256 ||
      !Number.isInteger(loraAlpha) ||
      (loraAlpha as number) < 1 ||
      (loraAlpha as number) > 1024
    ) {
      throw new AdapterManifestContractError(
        "loraRank/loraAlpha out of bounds",
        {
          obligation: "adapter.manifest.invalid",
          ...meta,
          failingSlice: "loraRank",
        },
      );
    }

    const contentHash = assertSha256(obj.contentHash, "contentHash", meta);
    const baseModelHash = assertOpaqueHash(
      obj.baseModelHash,
      "baseModelHash",
      meta,
    );
    const adapterBlobRef = assertId(
      obj.adapterBlobRef,
      "adapterBlobRef",
      meta,
      ADAPTER_MANIFEST_BLOB_REF_LIMIT,
    );
    const lineageRef = parseLineageRef(obj.lineageRef, meta);

    const value: AdapterDeltaManifest = {
      schemaVersion: ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
      contentHash,
      baseModelHash,
      precisionFormat: precisionFormat as AdapterPrecisionFormat,
      loraRank: loraRank as number,
      loraAlpha: loraAlpha as number,
      lineageRef,
      adapterBlobRef,
      subjectId: manifestSubject,
      deviceId: manifestDevice,
      locality,
    };

    emitTelemetry(options.onTelemetry, {
      event: "training.adapter.manifest_validate",
      outcome: "ok",
      subjectId,
      deviceId,
      schemaVersion: value.schemaVersion,
      contentHash: value.contentHash,
      baseModelHash: value.baseModelHash,
      precisionFormat: value.precisionFormat,
    });

    return { ok: true, value };
  } catch (err) {
    const error =
      err instanceof AdapterManifestContractError
        ? err
        : new AdapterManifestContractError(
            err instanceof Error ? err.message : "manifest validate failed",
            {
              obligation: "adapter.manifest.invalid",
              ...meta,
            },
          );
    emitTelemetry(options.onTelemetry, {
      event: "training.adapter.manifest_validate",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: error.obligation,
    });
    return { ok: false, error };
  }
}

export function parseAdapterDeltaManifestOrThrow(
  raw: unknown,
  options: ParseAdapterManifestOptions,
): AdapterDeltaManifest {
  const result = parseAdapterDeltaManifest(raw, options);
  if (!result.ok) throw result.error;
  return result.value;
}

/** Canonical UTF-8 bytes for stable content addressing of manifests. */
export function canonicalAdapterManifestBytes(
  manifest: AdapterDeltaManifest,
): Buffer {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    contentHash: manifest.contentHash,
    baseModelHash: manifest.baseModelHash,
    precisionFormat: manifest.precisionFormat,
    loraRank: manifest.loraRank,
    loraAlpha: manifest.loraAlpha,
    lineageRef: {
      schemaVersion: manifest.lineageRef.schemaVersion,
      runId: manifest.lineageRef.runId,
      checkpointHash: manifest.lineageRef.checkpointHash,
      corpusManifestHash: manifest.lineageRef.corpusManifestHash,
      criticVersions: [...manifest.lineageRef.criticVersions].map((c) => ({
        rubricId: c.rubricId,
        rubricVersion: c.rubricVersion,
        contentHash: c.contentHash,
      })),
    },
    adapterBlobRef: manifest.adapterBlobRef,
    subjectId: manifest.subjectId,
    deviceId: manifest.deviceId,
    locality: manifest.locality,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function fixtureAdapterDeltaManifest(overrides?: {
  subjectId?: string;
  deviceId?: string;
  contentHash?: string;
  baseModelHash?: string;
  precisionFormat?: AdapterPrecisionFormat;
  locality?: AdapterManifestLocality;
  lineageRef?: Partial<AdapterDeltaLineageRef>;
}): AdapterDeltaManifest {
  const subjectId = overrides?.subjectId ?? "subj.adapter.manifest.01";
  const deviceId = overrides?.deviceId ?? "dev.adapter.manifest.01";
  const contentHash =
    overrides?.contentHash ??
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return {
    schemaVersion: ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
    contentHash,
    baseModelHash: overrides?.baseModelHash ?? "ckpt:sha256:baseadapter0001",
    precisionFormat: overrides?.precisionFormat ?? "int4",
    loraRank: 16,
    loraAlpha: 32,
    lineageRef: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: overrides?.lineageRef?.runId ?? "run.grpo.adapter.01",
      checkpointHash:
        overrides?.lineageRef?.checkpointHash ?? "ckpt:sha256:lineageckpt0001",
      corpusManifestHash:
        overrides?.lineageRef?.corpusManifestHash ??
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      criticVersions: overrides?.lineageRef?.criticVersions ?? [
        {
          rubricId: "core.format",
          rubricVersion: "1.0.0",
          contentHash:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        },
      ],
    },
    adapterBlobRef: `cas://${contentHash}`,
    subjectId,
    deviceId,
    locality: overrides?.locality ?? "on-device",
  };
}

/**
 * Micro-run proving schema commitment + validate-on-read for packaging.
 */
export function proveAdapterDeltaManifestSchemaMicroRun(opts?: {
  onTelemetry?: (e: AdapterManifestTelemetryEvent) => void;
}): {
  ok: true;
  schemaPath: string;
  manifest: AdapterDeltaManifest;
} {
  assertCommittedAdapterFormatSchemaPresent();
  const subjectId = "subj.adapter.manifest.prove";
  const deviceId = "dev.adapter.manifest.prove";
  const fixture = fixtureAdapterDeltaManifest({ subjectId, deviceId });
  const parsed = parseAdapterDeltaManifestOrThrow(fixture, {
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  return {
    ok: true,
    schemaPath: ADAPTER_FORMAT_JSON_SCHEMA_PATH,
    manifest: parsed,
  };
}

// ─── GRPO trainer → content-addressed packer ───────────────────────────────

export type GrpoTrainerDeltaOutput = {
  subjectId: string;
  deviceId: string;
  locality: AdapterManifestLocality;
  /** Exact base model / checkpoint the LoRA delta was trained against. */
  baseModelHash: string;
  precisionFormat: AdapterPrecisionFormat;
  loraRank: number;
  loraAlpha: number;
  /** Adapter-only LoRA delta bytes from the GRPO / LoRA trainer path. */
  deltaBytes: Uint8Array | Buffer;
  /** Complete C4 checkpoint.lineage.v1 row pointer. */
  lineageRef: AdapterDeltaLineageRef;
  /**
   * Optional trainer-emitted content hash. When present must equal the
   * content-address of deltaBytes (loud fail on mismatch).
   */
  trainerDeltaHash?: string;
  /**
   * Optional pack identity for idempotent replay. Same packId + same bytes
   * replays; same packId + different bytes is an idempotent conflict.
   */
  packId?: string;
};

export type PackedAdapterDelta = {
  ok: true;
  manifest: AdapterDeltaManifest;
  /** Content-addressed adapter blob bytes (byte-identical for rollback). */
  blob: Buffer;
  contentHash: string;
  byteLength: number;
  idempotentReplay: boolean;
};

type PackCacheEntry = {
  packed: PackedAdapterDelta;
  packId: string | undefined;
};

const packByContentKey = new Map<string, PackCacheEntry>();
const packByPackId = new Map<string, PackCacheEntry>();

function packCacheKey(subjectId: string, contentHash: string): string {
  return `${subjectId}::${contentHash}`;
}

function packIdKey(subjectId: string, packId: string): string {
  return `${subjectId}::pack:${packId}`;
}

function trimPackCache(): void {
  while (packByContentKey.size > ADAPTER_PACK_CACHE_LIMIT) {
    const first = packByContentKey.keys().next().value;
    if (first === undefined) break;
    const entry = packByContentKey.get(first);
    packByContentKey.delete(first);
    if (entry?.packId) {
      packByPackId.delete(packIdKey(entry.packed.manifest.subjectId, entry.packId));
    }
  }
}

/**
 * Content-address adapter delta bytes (sha256:<64 hex>).
 * Empty / oversize blobs fail before any manifest emit.
 */
export function contentAddressAdapterPackBlob(
  bytes: Uint8Array | Buffer,
  meta?: { subjectId?: string; deviceId?: string },
): string {
  if (!bytes || bytes.byteLength === 0) {
    throw new AdapterManifestContractError("adapter delta bytes empty / truncated", {
      obligation: "adapter.pack.empty_delta",
      ...meta,
      failingSlice: "deltaBytes",
    });
  }
  if (bytes.byteLength > ADAPTER_PACK_BYTE_LIMIT) {
    throw new AdapterManifestContractError(
      `adapter delta exceeds ${ADAPTER_PACK_BYTE_LIMIT} bytes`,
      {
        obligation: "adapter.pack.byte_limit",
        ...meta,
        failingSlice: "byteLength",
      },
    );
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Reset in-process pack cache (tests / kill-switch drills).
 */
export function resetAdapterPackCache(): void {
  packByContentKey.clear();
  packByPackId.clear();
}

/**
 * Pack LoRA weights from GRPO trainer output into a content-addressed
 * manifest + blob pair bound to baseModelHash and a complete lineageRef.
 *
 * Validation completes before any durable cache write. Replayed packId or
 * identical content is idempotent (never double-applies a divergent blob).
 */
export function packAdapterFromGrpoTrainerOutput(
  input: GrpoTrainerDeltaOutput,
  opts?: {
    onTelemetry?: (e: AdapterManifestTelemetryEvent) => void;
  },
): PackedAdapterDelta {
  const subjectId = assertId(input.subjectId, "subjectId", {});
  const deviceId = assertId(input.deviceId, "deviceId", { subjectId });
  const meta = { subjectId, deviceId };

  const failEmit = (error: AdapterManifestContractError): never => {
    emitTelemetry(opts?.onTelemetry, {
      event: "training.adapter.pack_emit",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: error.obligation,
    });
    throw error;
  };

  try {
    if (input.locality !== "on-device" && input.locality !== "self-hosted") {
      throw new AdapterManifestContractError(
        "locality must be on-device or self-hosted",
        {
          obligation: "adapter.manifest.locality_forbidden",
          ...meta,
          failingSlice: String(input.locality),
        },
      );
    }

    if (
      !(ADAPTER_PRECISION_FORMATS as readonly string[]).includes(
        input.precisionFormat,
      )
    ) {
      throw new AdapterManifestContractError("precisionFormat invalid", {
        obligation: "adapter.manifest.invalid",
        ...meta,
        failingSlice: "precisionFormat",
      });
    }

    if (
      !Number.isInteger(input.loraRank) ||
      input.loraRank < 1 ||
      input.loraRank > 256 ||
      !Number.isInteger(input.loraAlpha) ||
      input.loraAlpha < 1 ||
      input.loraAlpha > 1024
    ) {
      throw new AdapterManifestContractError("loraRank/loraAlpha out of bounds", {
        obligation: "adapter.manifest.invalid",
        ...meta,
        failingSlice: "loraRank",
      });
    }

    const baseModelHash = assertOpaqueHash(
      input.baseModelHash,
      "baseModelHash",
      meta,
    );
    const lineageRef = parseLineageRef(input.lineageRef, meta);

    const blob = Buffer.from(input.deltaBytes);
    const contentHash = contentAddressAdapterPackBlob(blob, meta);

    if (
      input.trainerDeltaHash !== undefined &&
      input.trainerDeltaHash !== contentHash
    ) {
      throw new AdapterManifestContractError(
        "trainerDeltaHash does not match content-address of deltaBytes",
        {
          obligation: "adapter.pack.trainer_hash_mismatch",
          ...meta,
          failingSlice: input.trainerDeltaHash,
        },
      );
    }

    if (input.packId !== undefined) {
      const idKey = packIdKey(subjectId, assertId(input.packId, "packId", meta));
      const prior = packByPackId.get(idKey);
      if (prior) {
        if (prior.packed.contentHash !== contentHash) {
          throw new AdapterManifestContractError(
            "packId replay with divergent blob — refuse double-apply",
            {
              obligation: "adapter.pack.idempotent_conflict",
              ...meta,
              failingSlice: input.packId,
            },
          );
        }
        emitTelemetry(opts?.onTelemetry, {
          event: "training.adapter.pack_emit",
          outcome: "ok",
          subjectId,
          deviceId,
          contentHash: prior.packed.contentHash,
          baseModelHash: prior.packed.manifest.baseModelHash,
          precisionFormat: prior.packed.manifest.precisionFormat,
          byteLength: prior.packed.byteLength,
          idempotentReplay: true,
        });
        return { ...prior.packed, idempotentReplay: true };
      }
    }

    const contentKey = packCacheKey(subjectId, contentHash);
    const cached = packByContentKey.get(contentKey);
    if (cached) {
      emitTelemetry(opts?.onTelemetry, {
        event: "training.adapter.pack_emit",
        outcome: "ok",
        subjectId,
        deviceId,
        contentHash: cached.packed.contentHash,
        baseModelHash: cached.packed.manifest.baseModelHash,
        precisionFormat: cached.packed.manifest.precisionFormat,
        byteLength: cached.packed.byteLength,
        idempotentReplay: true,
      });
      return { ...cached.packed, idempotentReplay: true };
    }

    const draft: AdapterDeltaManifest = {
      schemaVersion: ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
      contentHash,
      baseModelHash,
      precisionFormat: input.precisionFormat,
      loraRank: input.loraRank,
      loraAlpha: input.loraAlpha,
      lineageRef,
      adapterBlobRef: `cas://${contentHash}`,
      subjectId,
      deviceId,
      locality: input.locality,
    };

    // Validate fully before durable cache write (no partial emit).
    const manifest = parseAdapterDeltaManifestOrThrow(draft, {
      subjectId,
      deviceId,
      ...(opts?.onTelemetry !== undefined
        ? { onTelemetry: opts.onTelemetry }
        : {}),
    });

    // Cross-subject cache key already scopes by subjectId; refuse if draft
    // somehow drifted (defense in depth).
    if (manifest.subjectId !== subjectId) {
      throw new AdapterManifestContractError(
        "cross-subject adapter pack denied",
        {
          obligation: "adapter.manifest.subject_scope",
          ...meta,
          failingSlice: manifest.subjectId,
        },
      );
    }

    const packed: PackedAdapterDelta = {
      ok: true,
      manifest,
      blob,
      contentHash,
      byteLength: blob.byteLength,
      idempotentReplay: false,
    };

    const entry: PackCacheEntry = {
      packed,
      packId: input.packId,
    };
    packByContentKey.set(contentKey, entry);
    if (input.packId !== undefined) {
      packByPackId.set(packIdKey(subjectId, input.packId), entry);
    }
    trimPackCache();

    emitTelemetry(opts?.onTelemetry, {
      event: "training.adapter.pack_emit",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash,
      baseModelHash,
      precisionFormat: manifest.precisionFormat,
      byteLength: packed.byteLength,
      idempotentReplay: false,
    });

    return packed;
  } catch (err) {
    if (err instanceof AdapterManifestContractError) {
      failEmit(err);
    }
    const wrapped = new AdapterManifestContractError(
      err instanceof Error ? err.message : "adapter pack failed",
      {
        obligation: "adapter.manifest.invalid",
        ...meta,
      },
    );
    failEmit(wrapped);
  }
}

/**
 * Deterministic synthetic GRPO LoRA delta bytes for CI micro-runs.
 * No learner content — header + seeded floats only.
 */
export function synthesizeGrpoPackDeltaBytes(input: {
  baseModelHash: string;
  rank: number;
  alpha: number;
  loss: number;
  step: number;
}): Buffer {
  const base = assertOpaqueHash(input.baseModelHash, "baseModelHash", {});
  const header = Buffer.from(
    JSON.stringify({
      v: ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
      base,
      rank: input.rank,
      alpha: input.alpha,
      step: input.step,
      scope: "adapter_only",
    }),
    "utf8",
  );
  const seed = createHash("sha256")
    .update(header)
    .update(`|loss:${input.loss}`)
    .digest();
  const elemCount = input.rank * 64;
  const floats = Buffer.alloc(elemCount * 4);
  for (let i = 0; i < elemCount; i++) {
    const b0 = seed[i % seed.length]!;
    const b1 = seed[(i * 7 + 3) % seed.length]!;
    const unit = ((b0 << 8) | b1) / 0xffff;
    const w =
      (unit * 2 - 1) *
      1e-3 *
      (input.loss === 0 ? 1 : Math.sign(input.loss) || 1);
    floats.writeFloatLE(w, i * 4);
  }
  const out = Buffer.concat([header, floats]);
  if (out.length > ADAPTER_PACK_BYTE_LIMIT) {
    throw new AdapterManifestContractError(
      `adapter delta exceeds ${ADAPTER_PACK_BYTE_LIMIT} bytes`,
      { obligation: "adapter.pack.byte_limit" },
    );
  }
  return out;
}

/**
 * Micro-run: pack GRPO synthetic delta → validated manifest+blob; prove
 * idempotent replay and named refuse classes.
 */
export function proveAdapterPackFromGrpoMicroRun(opts?: {
  onTelemetry?: (e: AdapterManifestTelemetryEvent) => void;
}): {
  ok: true;
  packed: PackedAdapterDelta;
  replay: PackedAdapterDelta;
  refused: ReadonlyArray<AdapterManifestFailureClass>;
} {
  resetAdapterPackCache();
  const subjectId = "subj.adapter.pack.prove";
  const deviceId = "dev.adapter.pack.prove";
  const baseModelHash = "ckpt:sha256:packbase00000001";
  const deltaBytes = synthesizeGrpoPackDeltaBytes({
    baseModelHash,
    rank: 16,
    alpha: 32,
    loss: -0.31,
    step: 0,
  });
  const lineageRef: AdapterDeltaLineageRef = {
    schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
    runId: "run.grpo.pack.prove.01",
    checkpointHash: "ckpt:sha256:packlineage00001",
    corpusManifestHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    criticVersions: [
      {
        rubricId: "core.format",
        rubricVersion: "1.0.0",
        contentHash:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    ],
  };

  const packed = packAdapterFromGrpoTrainerOutput(
    {
      subjectId,
      deviceId,
      locality: "on-device",
      baseModelHash,
      precisionFormat: "int4",
      loraRank: 16,
      loraAlpha: 32,
      deltaBytes,
      lineageRef,
      packId: "pack.prove.01",
      trainerDeltaHash: contentAddressAdapterPackBlob(deltaBytes),
    },
    opts,
  );

  const replay = packAdapterFromGrpoTrainerOutput(
    {
      subjectId,
      deviceId,
      locality: "on-device",
      baseModelHash,
      precisionFormat: "int4",
      loraRank: 16,
      loraAlpha: 32,
      deltaBytes,
      lineageRef,
      packId: "pack.prove.01",
    },
    opts,
  );

  const refused: AdapterManifestFailureClass[] = [];
  const tryRefuse = (
    patch: Partial<GrpoTrainerDeltaOutput>,
    expected: AdapterManifestFailureClass,
  ): void => {
    try {
      packAdapterFromGrpoTrainerOutput({
        subjectId,
        deviceId,
        locality: "on-device",
        baseModelHash,
        precisionFormat: "int4",
        loraRank: 16,
        loraAlpha: 32,
        deltaBytes,
        lineageRef,
        ...patch,
      });
    } catch (err) {
      if (
        err instanceof AdapterManifestContractError &&
        err.obligation === expected
      ) {
        refused.push(expected);
        return;
      }
      throw err;
    }
    throw new Error(`expected refuse ${expected}`);
  };

  tryRefuse({ deltaBytes: new Uint8Array(0) }, "adapter.pack.empty_delta");
  tryRefuse(
    {
      lineageRef: { ...lineageRef, criticVersions: [] },
      packId: "pack.incomplete",
    },
    "adapter.manifest.lineage_incomplete",
  );
  tryRefuse(
    {
      trainerDeltaHash:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      packId: "pack.badhash",
    },
    "adapter.pack.trainer_hash_mismatch",
  );

  const otherBytes = synthesizeGrpoPackDeltaBytes({
    baseModelHash,
    rank: 16,
    alpha: 32,
    loss: 0.99,
    step: 1,
  });
  tryRefuse(
    {
      deltaBytes: otherBytes,
      packId: "pack.prove.01",
    },
    "adapter.pack.idempotent_conflict",
  );

  const cross = parseAdapterDeltaManifest(packed.manifest, {
    subjectId: "subj.other",
    deviceId,
  });
  if (
    !cross.ok &&
    cross.error.obligation === "adapter.manifest.subject_scope"
  ) {
    refused.push("adapter.manifest.subject_scope");
  } else {
    throw new Error("expected cross-subject parse refuse");
  }

  return { ok: true, packed, replay, refused };
}
