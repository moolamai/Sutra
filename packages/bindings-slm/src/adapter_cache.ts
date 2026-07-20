/**
 * Verified adapter artifact cache (C5 distribution channel).
 *
 * Only complete, checksum-verified artifacts are visible to the loader.
 * Partial / in-progress downloads never enter the served set. Provenance
 * signature failure must block writes — unsigned artifacts never load.
 *
 * Durable path: download to tmp/*.partial → checksum → atomic rename into
 * verified/. Resume continues from byte offset; corrupt partials restart.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
  openSync,
  closeSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

export const ADAPTER_CACHE_SCHEMA_VERSION = "adapter.cache.v1" as const;

/** Soft cap on cached blob bytes (MB-scale). */
export const ADAPTER_CACHE_BYTE_LIMIT = 4 * 1024 * 1024;

/** Bound on verified entries per subject (NFR — no unbounded growth). */
export const ADAPTER_CACHE_ENTRY_LIMIT = 64;

export type AdapterCacheFailureClass =
  | "adapter.cache.subject_scope"
  | "adapter.cache.hash_mismatch"
  | "adapter.cache.unsigned"
  | "adapter.cache.partial_invisible"
  | "adapter.cache.byte_limit"
  | "adapter.cache.empty"
  | "adapter.cache.not_found"
  | "adapter.cache.idempotent_conflict"
  | "adapter.cache.resume_corrupt"
  | "adapter.cache.io";

export type AdapterCacheTelemetryEvent = {
  event:
    | "bindings.adapter.cache_put"
    | "bindings.adapter.cache_get"
    | "bindings.adapter.cache_stage"
    | "bindings.adapter.cache_resume"
    | "bindings.adapter.cache_commit";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  contentHash?: string;
  verified?: boolean;
  resumeOffset?: number;
  failureClass?: AdapterCacheFailureClass;
};

export class AdapterCacheContractError extends Error {
  readonly obligation: AdapterCacheFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: AdapterCacheFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "AdapterCacheContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

export type VerifiedAdapterCacheEntry = {
  contentHash: string;
  blob: Buffer;
  byteLength: number;
  /** Provenance signature that authorized the cache write. */
  provenanceSignature: string;
  subjectId: string;
  deviceId: string;
  verifiedAt: string;
};

type StageEntry = {
  contentHash: string;
  subjectId: string;
  bytesReceived: number;
};

function contentAddress(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function cacheKey(subjectId: string, contentHash: string): string {
  return `${subjectId}::${contentHash}`;
}

/**
 * In-process verified adapter cache. Staging keys are never returned by get().
 */
export class VerifiedAdapterCache {
  private readonly verified = new Map<string, VerifiedAdapterCacheEntry>();
  private readonly staging = new Map<string, StageEntry>();

  constructor(
    private readonly opts: {
      subjectId: string;
      deviceId: string;
      onTelemetry?: (e: AdapterCacheTelemetryEvent) => void;
    },
  ) {
    if (!opts.subjectId?.trim()) {
      throw new AdapterCacheContractError("subjectId required", {
        obligation: "adapter.cache.subject_scope",
      });
    }
  }

  get size(): number {
    return this.verified.size;
  }

  /** Staging / partial downloads — invisible to loader. */
  get stagingCount(): number {
    return this.staging.size;
  }

  /**
   * Record an in-progress download. Never served by {@link get}.
   */
  stagePartial(input: {
    contentHash: string;
    bytesReceived: number;
  }): void {
    const contentHash = assertContentHash(input.contentHash, this.opts);
    if (input.bytesReceived < 0) {
      throw new AdapterCacheContractError("bytesReceived invalid", {
        obligation: "adapter.cache.partial_invisible",
        ...this.opts,
      });
    }
    this.staging.set(cacheKey(this.opts.subjectId, contentHash), {
      contentHash,
      subjectId: this.opts.subjectId,
      bytesReceived: input.bytesReceived,
    });
    this.opts.onTelemetry?.({
      event: "bindings.adapter.cache_stage",
      outcome: "ok",
      subjectId: this.opts.subjectId,
      deviceId: this.opts.deviceId,
      contentHash,
      verified: false,
    });
  }

  /**
   * Put a fully verified artifact. Requires non-empty provenance signature.
   * Checksum must match contentHash before the entry becomes visible.
   */
  putVerified(input: {
    contentHash: string;
    blob: Uint8Array;
    provenanceSignature: string;
    verifiedAt?: string;
  }): VerifiedAdapterCacheEntry {
    const subjectId = this.opts.subjectId;
    const deviceId = this.opts.deviceId;
    const contentHash = assertContentHash(input.contentHash, this.opts);

    if (
      typeof input.provenanceSignature !== "string" ||
      input.provenanceSignature.trim().length < 8
    ) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.cache_put",
        outcome: "fail",
        subjectId,
        deviceId,
        contentHash,
        failureClass: "adapter.cache.unsigned",
      });
      throw new AdapterCacheContractError(
        "A-P5 provenance signature required — unsigned artifacts never load",
        {
          obligation: "adapter.cache.unsigned",
          subjectId,
          deviceId,
          failingSlice: "provenanceSignature",
        },
      );
    }

    if (!input.blob || input.blob.byteLength === 0) {
      throw new AdapterCacheContractError("adapter blob empty", {
        obligation: "adapter.cache.empty",
        subjectId,
        deviceId,
      });
    }
    if (input.blob.byteLength > ADAPTER_CACHE_BYTE_LIMIT) {
      throw new AdapterCacheContractError(
        `adapter blob exceeds ${ADAPTER_CACHE_BYTE_LIMIT} bytes`,
        {
          obligation: "adapter.cache.byte_limit",
          subjectId,
          deviceId,
        },
      );
    }

    const actual = contentAddress(input.blob);
    if (actual !== contentHash) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.cache_put",
        outcome: "fail",
        subjectId,
        deviceId,
        contentHash,
        failureClass: "adapter.cache.hash_mismatch",
      });
      throw new AdapterCacheContractError(
        "contentHash mismatch — refuse cache write before verification completes",
        {
          obligation: "adapter.cache.hash_mismatch",
          subjectId,
          deviceId,
          failingSlice: actual,
        },
      );
    }

    const key = cacheKey(subjectId, contentHash);
    const existing = this.verified.get(key);
    if (existing) {
      if (!existing.blob.equals(Buffer.from(input.blob))) {
        throw new AdapterCacheContractError(
          "contentHash collision with divergent blob",
          {
            obligation: "adapter.cache.idempotent_conflict",
            subjectId,
            deviceId,
            failingSlice: contentHash,
          },
        );
      }
      this.staging.delete(key);
      this.opts.onTelemetry?.({
        event: "bindings.adapter.cache_put",
        outcome: "ok",
        subjectId,
        deviceId,
        contentHash,
        verified: true,
      });
      return existing;
    }

    const entry: VerifiedAdapterCacheEntry = {
      contentHash,
      blob: Buffer.from(input.blob),
      byteLength: input.blob.byteLength,
      provenanceSignature: input.provenanceSignature.trim(),
      subjectId,
      deviceId,
      verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    };

    this.verified.set(key, entry);
    this.staging.delete(key);

    while (this.verified.size > ADAPTER_CACHE_ENTRY_LIMIT) {
      const first = this.verified.keys().next().value;
      if (first === undefined) break;
      this.verified.delete(first);
    }

    this.opts.onTelemetry?.({
      event: "bindings.adapter.cache_put",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash,
      verified: true,
    });

    return entry;
  }

  /**
   * Loader-facing read — only verified complete entries. Staging is invisible.
   */
  get(contentHash: string, callerSubjectId?: string): VerifiedAdapterCacheEntry {
    const subjectId = callerSubjectId ?? this.opts.subjectId;
    if (subjectId !== this.opts.subjectId) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.cache_get",
        outcome: "fail",
        subjectId: this.opts.subjectId,
        deviceId: this.opts.deviceId,
        failureClass: "adapter.cache.subject_scope",
      });
      throw new AdapterCacheContractError(
        "cross-subject adapter cache access denied",
        {
          obligation: "adapter.cache.subject_scope",
          subjectId: this.opts.subjectId,
          deviceId: this.opts.deviceId,
          failingSlice: subjectId,
        },
      );
    }

    const hash = assertContentHash(contentHash, this.opts);
    const key = cacheKey(subjectId, hash);

    if (this.staging.has(key) && !this.verified.has(key)) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.cache_get",
        outcome: "fail",
        subjectId,
        deviceId: this.opts.deviceId,
        contentHash: hash,
        failureClass: "adapter.cache.partial_invisible",
      });
      throw new AdapterCacheContractError(
        "partial download invisible to loader — only verified artifacts are served",
        {
          obligation: "adapter.cache.partial_invisible",
          subjectId,
          deviceId: this.opts.deviceId,
          failingSlice: hash,
        },
      );
    }

    const entry = this.verified.get(key);
    if (!entry) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.cache_get",
        outcome: "fail",
        subjectId,
        deviceId: this.opts.deviceId,
        contentHash: hash,
        failureClass: "adapter.cache.not_found",
      });
      throw new AdapterCacheContractError("verified adapter not in cache", {
        obligation: "adapter.cache.not_found",
        subjectId,
        deviceId: this.opts.deviceId,
        failingSlice: hash,
      });
    }

    this.opts.onTelemetry?.({
      event: "bindings.adapter.cache_get",
      outcome: "ok",
      subjectId,
      deviceId: this.opts.deviceId,
      contentHash: hash,
      verified: true,
    });

    return entry;
  }

  hasVerified(contentHash: string): boolean {
    return this.verified.has(
      cacheKey(this.opts.subjectId, assertContentHash(contentHash, this.opts)),
    );
  }

  clear(): void {
    this.verified.clear();
    this.staging.clear();
  }
}

function assertContentHash(
  hash: string,
  meta: { subjectId?: string; deviceId?: string },
): string {
  const trimmed = typeof hash === "string" ? hash.trim() : "";
  if (!SHA256_RE.test(trimmed)) {
    throw new AdapterCacheContractError("contentHash must be sha256:<64 hex>", {
      obligation: "adapter.cache.hash_mismatch",
      ...meta,
      failingSlice: "contentHash",
    });
  }
  return trimmed;
}

function assertProvenanceSignature(
  signature: string,
  meta: { subjectId: string; deviceId: string; contentHash: string },
  onTelemetry?: (e: AdapterCacheTelemetryEvent) => void,
): string {
  if (typeof signature !== "string" || signature.trim().length < 8) {
    onTelemetry?.({
      event: "bindings.adapter.cache_put",
      outcome: "fail",
      subjectId: meta.subjectId,
      deviceId: meta.deviceId,
      contentHash: meta.contentHash,
      failureClass: "adapter.cache.unsigned",
    });
    throw new AdapterCacheContractError(
      "A-P5 provenance signature required — unsigned artifacts never load",
      {
        obligation: "adapter.cache.unsigned",
        subjectId: meta.subjectId,
        deviceId: meta.deviceId,
        failingSlice: "provenanceSignature",
      },
    );
  }
  return signature.trim();
}

function safeSubjectDir(subjectId: string): string {
  return subjectId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 128);
}

function hexId(contentHash: string): string {
  return contentHash.slice("sha256:".length);
}

/**
 * Durable resumable cache: tmp partial → checksum → atomic rename to verified.
 * Loader {@link get} only reads verified entries — never tmp/*.partial.
 */
export class ResumableDurableAdapterCache {
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly cacheRoot: string;
  private readonly onTelemetry:
    | ((e: AdapterCacheTelemetryEvent) => void)
    | undefined;
  private readonly memory = new Map<string, VerifiedAdapterCacheEntry>();

  constructor(opts: {
    subjectId: string;
    deviceId: string;
    /** Root directory for subject-scoped verified + tmp trees. */
    cacheRoot: string;
    onTelemetry?: (e: AdapterCacheTelemetryEvent) => void;
  }) {
    if (!opts.subjectId?.trim()) {
      throw new AdapterCacheContractError("subjectId required", {
        obligation: "adapter.cache.subject_scope",
      });
    }
    if (!opts.cacheRoot?.trim()) {
      throw new AdapterCacheContractError("cacheRoot required", {
        obligation: "adapter.cache.io",
        failingSlice: "cacheRoot",
      });
    }
    this.subjectId = opts.subjectId.trim();
    this.deviceId = opts.deviceId;
    this.cacheRoot = path.resolve(opts.cacheRoot);
    this.onTelemetry = opts.onTelemetry;
    mkdirSync(this.verifiedDir(), { recursive: true });
    mkdirSync(this.tmpDir(), { recursive: true });
  }

  get size(): number {
    try {
      return readdirSync(this.verifiedDir()).filter((n) =>
        n.endsWith(".bin"),
      ).length;
    } catch {
      return this.memory.size;
    }
  }

  get stagingCount(): number {
    try {
      return readdirSync(this.tmpDir()).filter((n) =>
        n.endsWith(".partial"),
      ).length;
    } catch {
      return 0;
    }
  }

  private subjectRoot(): string {
    return path.join(this.cacheRoot, safeSubjectDir(this.subjectId));
  }

  private verifiedDir(): string {
    return path.join(this.subjectRoot(), "verified");
  }

  private tmpDir(): string {
    return path.join(this.subjectRoot(), "tmp");
  }

  private partialPath(contentHash: string): string {
    return path.join(this.tmpDir(), `${hexId(contentHash)}.partial`);
  }

  private verifiedBinPath(contentHash: string): string {
    return path.join(this.verifiedDir(), `${hexId(contentHash)}.bin`);
  }

  private verifiedMetaPath(contentHash: string): string {
    return path.join(this.verifiedDir(), `${hexId(contentHash)}.meta.json`);
  }

  /**
   * Byte offset for resume. 0 when no partial or after corrupt discard.
   */
  resumeOffset(contentHash: string): number {
    const hash = assertContentHash(contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    const partial = this.partialPath(hash);
    if (!existsSync(partial)) {
      this.onTelemetry?.({
        event: "bindings.adapter.cache_resume",
        outcome: "ok",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        contentHash: hash,
        resumeOffset: 0,
        verified: false,
      });
      return 0;
    }
    const offset = statSync(partial).size;
    if (offset > ADAPTER_CACHE_BYTE_LIMIT) {
      this.discardPartial(hash);
      return 0;
    }
    this.onTelemetry?.({
      event: "bindings.adapter.cache_resume",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      contentHash: hash,
      resumeOffset: offset,
      verified: false,
    });
    return offset;
  }

  /**
   * Append chunk to tmp partial. Never visible via {@link get}.
   */
  appendPartial(input: {
    contentHash: string;
    chunk: Uint8Array;
  }): { offset: number } {
    const hash = assertContentHash(input.contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    if (!input.chunk || input.chunk.byteLength === 0) {
      throw new AdapterCacheContractError("empty chunk", {
        obligation: "adapter.cache.empty",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
      });
    }
    mkdirSync(this.tmpDir(), { recursive: true });
    const partial = this.partialPath(hash);
    const before = existsSync(partial) ? statSync(partial).size : 0;
    if (before + input.chunk.byteLength > ADAPTER_CACHE_BYTE_LIMIT) {
      throw new AdapterCacheContractError(
        `partial exceeds ${ADAPTER_CACHE_BYTE_LIMIT} bytes`,
        {
          obligation: "adapter.cache.byte_limit",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
    appendFileSync(partial, Buffer.from(input.chunk));
    const offset = before + input.chunk.byteLength;
    this.onTelemetry?.({
      event: "bindings.adapter.cache_stage",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      contentHash: hash,
      resumeOffset: offset,
      verified: false,
    });
    return { offset };
  }

  /**
   * Discard corrupt / abandoned partial and restart from offset 0.
   */
  discardPartial(contentHash: string): void {
    const hash = assertContentHash(contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    const partial = this.partialPath(hash);
    if (existsSync(partial)) {
      unlinkSync(partial);
    }
    this.onTelemetry?.({
      event: "bindings.adapter.cache_resume",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      contentHash: hash,
      resumeOffset: 0,
      verified: false,
      failureClass: "adapter.cache.resume_corrupt",
    });
  }

  stagePartial(input: {
    contentHash: string;
    bytesReceived: number;
  }): void {
    const hash = assertContentHash(input.contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    // Ensure tmp dir exists; offset is authoritative from resumeOffset/append.
    mkdirSync(this.tmpDir(), { recursive: true });
    const partial = this.partialPath(hash);
    if (!existsSync(partial) && input.bytesReceived === 0) {
      // Touch empty partial marker without making it loader-visible.
      closeSync(openSync(partial, "a"));
    }
    this.onTelemetry?.({
      event: "bindings.adapter.cache_stage",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      contentHash: hash,
      resumeOffset: input.bytesReceived,
      verified: false,
    });
  }

  /**
   * Atomic commit: checksum tmp partial → write verified bin+meta via rename.
   * On checksum mismatch, discard partial (corrupt resume → restart).
   */
  commitPartialAtomic(input: {
    contentHash: string;
    provenanceSignature: string;
    verifiedAt?: string;
  }): VerifiedAdapterCacheEntry {
    const hash = assertContentHash(input.contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    const sig = assertProvenanceSignature(
      input.provenanceSignature,
      {
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        contentHash: hash,
      },
      this.onTelemetry,
    );

    const partial = this.partialPath(hash);
    if (!existsSync(partial)) {
      throw new AdapterCacheContractError("no partial to commit", {
        obligation: "adapter.cache.empty",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        failingSlice: hash,
      });
    }

    const blob = readFileSync(partial);
    if (blob.byteLength === 0) {
      this.discardPartial(hash);
      throw new AdapterCacheContractError("partial empty", {
        obligation: "adapter.cache.empty",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
      });
    }

    const actual = contentAddress(blob);
    if (actual !== hash) {
      this.discardPartial(hash);
      this.onTelemetry?.({
        event: "bindings.adapter.cache_commit",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        contentHash: hash,
        failureClass: "adapter.cache.resume_corrupt",
      });
      throw new AdapterCacheContractError(
        "corrupt resume checksum — discarded partial; restart from scratch",
        {
          obligation: "adapter.cache.resume_corrupt",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          failingSlice: actual,
        },
      );
    }

    mkdirSync(this.verifiedDir(), { recursive: true });
    const binPath = this.verifiedBinPath(hash);
    const metaPath = this.verifiedMetaPath(hash);
    const binTmp = `${binPath}.tmp`;
    const metaTmp = `${metaPath}.tmp`;

    const entry: VerifiedAdapterCacheEntry = {
      contentHash: hash,
      blob,
      byteLength: blob.byteLength,
      provenanceSignature: sig,
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    };

    // Write temps first; only rename into verified after checksum already passed.
    writeFileSync(binTmp, blob);
    writeFileSync(
      metaTmp,
      JSON.stringify({
        schemaVersion: ADAPTER_CACHE_SCHEMA_VERSION,
        contentHash: entry.contentHash,
        provenanceSignature: entry.provenanceSignature,
        byteLength: entry.byteLength,
        subjectId: entry.subjectId,
        deviceId: entry.deviceId,
        verifiedAt: entry.verifiedAt,
      }),
      "utf8",
    );

    try {
      if (existsSync(binPath)) unlinkSync(binPath);
      if (existsSync(metaPath)) unlinkSync(metaPath);
      renameSync(binTmp, binPath);
      renameSync(metaTmp, metaPath);
    } catch (err) {
      try {
        if (existsSync(binTmp)) unlinkSync(binTmp);
        if (existsSync(metaTmp)) unlinkSync(metaTmp);
      } catch {
        /* best-effort cleanup */
      }
      throw new AdapterCacheContractError(
        err instanceof Error ? err.message : "atomic rename failed",
        {
          obligation: "adapter.cache.io",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          failingSlice: hash,
        },
      );
    }

    // Partial failure after durable verified write: still remove staging so
    // loader never sees both; idempotent on retry.
    if (existsSync(partial)) {
      unlinkSync(partial);
    }

    this.memory.set(hash, entry);
    this.onTelemetry?.({
      event: "bindings.adapter.cache_commit",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      contentHash: hash,
      verified: true,
    });
    this.onTelemetry?.({
      event: "bindings.adapter.cache_put",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      contentHash: hash,
      verified: true,
    });

    return entry;
  }

  /**
   * Full-blob put via temp → checksum → rename (same atomic path as resume).
   */
  putVerified(input: {
    contentHash: string;
    blob: Uint8Array;
    provenanceSignature: string;
    verifiedAt?: string;
  }): VerifiedAdapterCacheEntry {
    const hash = assertContentHash(input.contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    assertProvenanceSignature(
      input.provenanceSignature,
      {
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        contentHash: hash,
      },
      this.onTelemetry,
    );

    if (!input.blob || input.blob.byteLength === 0) {
      throw new AdapterCacheContractError("adapter blob empty", {
        obligation: "adapter.cache.empty",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
      });
    }
    if (input.blob.byteLength > ADAPTER_CACHE_BYTE_LIMIT) {
      throw new AdapterCacheContractError(
        `adapter blob exceeds ${ADAPTER_CACHE_BYTE_LIMIT} bytes`,
        {
          obligation: "adapter.cache.byte_limit",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
    const actual = contentAddress(input.blob);
    if (actual !== hash) {
      throw new AdapterCacheContractError(
        "contentHash mismatch — refuse cache write",
        {
          obligation: "adapter.cache.hash_mismatch",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          failingSlice: actual,
        },
      );
    }

    if (existsSync(this.verifiedBinPath(hash))) {
      const existing = this.get(hash);
      if (!existing.blob.equals(Buffer.from(input.blob))) {
        throw new AdapterCacheContractError(
          "contentHash collision with divergent blob",
          {
            obligation: "adapter.cache.idempotent_conflict",
            subjectId: this.subjectId,
            deviceId: this.deviceId,
            failingSlice: hash,
          },
        );
      }
      return existing;
    }

    this.discardPartial(hash);
    this.appendPartial({ contentHash: hash, chunk: input.blob });
    return this.commitPartialAtomic({
      contentHash: hash,
      provenanceSignature: input.provenanceSignature,
      ...(input.verifiedAt !== undefined
        ? { verifiedAt: input.verifiedAt }
        : {}),
    });
  }

  get(contentHash: string, callerSubjectId?: string): VerifiedAdapterCacheEntry {
    const subjectId = callerSubjectId ?? this.subjectId;
    if (subjectId !== this.subjectId) {
      this.onTelemetry?.({
        event: "bindings.adapter.cache_get",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        failureClass: "adapter.cache.subject_scope",
      });
      throw new AdapterCacheContractError(
        "cross-subject adapter cache access denied",
        {
          obligation: "adapter.cache.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          failingSlice: subjectId,
        },
      );
    }

    const hash = assertContentHash(contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });

    const partial = this.partialPath(hash);
    const binPath = this.verifiedBinPath(hash);
    if (existsSync(partial) && !existsSync(binPath)) {
      this.onTelemetry?.({
        event: "bindings.adapter.cache_get",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        contentHash: hash,
        failureClass: "adapter.cache.partial_invisible",
      });
      throw new AdapterCacheContractError(
        "partial download invisible to loader — only verified artifacts are served",
        {
          obligation: "adapter.cache.partial_invisible",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          failingSlice: hash,
        },
      );
    }

    if (!existsSync(binPath)) {
      this.onTelemetry?.({
        event: "bindings.adapter.cache_get",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        contentHash: hash,
        failureClass: "adapter.cache.not_found",
      });
      throw new AdapterCacheContractError("verified adapter not in cache", {
        obligation: "adapter.cache.not_found",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        failingSlice: hash,
      });
    }

    const blob = readFileSync(binPath);
    const actual = contentAddress(blob);
    if (actual !== hash) {
      throw new AdapterCacheContractError(
        "verified bin checksum mismatch — refuse load",
        {
          obligation: "adapter.cache.hash_mismatch",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          failingSlice: actual,
        },
      );
    }

    let provenanceSignature = "unknown";
    let verifiedAt = new Date(0).toISOString();
    const metaPath = this.verifiedMetaPath(hash);
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
          provenanceSignature?: string;
          verifiedAt?: string;
        };
        if (meta.provenanceSignature) {
          provenanceSignature = meta.provenanceSignature;
        }
        if (meta.verifiedAt) verifiedAt = meta.verifiedAt;
      } catch {
        /* meta optional for read path after bin checksum */
      }
    }

    const entry: VerifiedAdapterCacheEntry = {
      contentHash: hash,
      blob,
      byteLength: blob.byteLength,
      provenanceSignature,
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      verifiedAt,
    };
    this.memory.set(hash, entry);
    this.onTelemetry?.({
      event: "bindings.adapter.cache_get",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      contentHash: hash,
      verified: true,
    });
    return entry;
  }

  hasVerified(contentHash: string): boolean {
    const hash = assertContentHash(contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    return existsSync(this.verifiedBinPath(hash));
  }

  /**
   * True when a tmp partial exists without a verified bin — loader must not
   * observe these bytes (integration: interrupted download).
   */
  hasInvisiblePartial(contentHash: string): boolean {
    const hash = assertContentHash(contentHash, {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    return (
      existsSync(this.partialPath(hash)) && !existsSync(this.verifiedBinPath(hash))
    );
  }

  clear(): void {
    this.memory.clear();
    if (existsSync(this.subjectRoot())) {
      rmSync(this.subjectRoot(), { recursive: true, force: true });
    }
    mkdirSync(this.verifiedDir(), { recursive: true });
    mkdirSync(this.tmpDir(), { recursive: true });
  }
}
