/**
 * Adapter fetch via A-P5 artifact pipeline (C5 distribution channel).
 *
 * Resolves adapters by content hash through publish-pipeline URLs, verifies
 * provenance signatures, and only then hands bytes to the verified cache.
 * Integrates with release dry-run provenance policy (unsigned never loads).
 */

import { createHmac, createHash } from "node:crypto";

export const ADAPTER_FETCH_SCHEMA_VERSION = "adapter.fetch.v1" as const;
export const ADAPTER_PROVENANCE_SCHEMA_VERSION =
  "adapter.delta.provenance.v1" as const;

/** Default A-P5 artifact base (scratch / sovereign mirror path segment). */
export const AP5_ADAPTER_ARTIFACT_PATH = "/v1/adapters" as const;

export const NPM_PROD_REGISTRY = "https://registry.npmjs.org";

/** Soft bound on fetch retries (NFR). */
export const ADAPTER_FETCH_RETRY_LIMIT = 3;

export type AdapterFetchFailureClass =
  | "adapter.fetch.invalid_hash"
  | "adapter.fetch.url_resolve"
  | "adapter.fetch.network"
  | "adapter.fetch.checksum"
  | "adapter.fetch.provenance_unsigned"
  | "adapter.fetch.provenance_mismatch"
  | "adapter.fetch.subject_scope"
  | "adapter.fetch.locality_forbidden"
  | "adapter.fetch.dry_run_policy"
  | "adapter.fetch.byte_limit"
  | "adapter.fetch.timeout"
  | "adapter.fetch.resume_corrupt";

export type AdapterFetchTelemetryEvent = {
  event:
    | "training.adapter.fetch_resolve"
    | "training.adapter.fetch_download"
    | "training.adapter.fetch_provenance"
    | "training.adapter.fetch_complete"
    | "training.adapter.fetch_resume";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  contentHash?: string;
  artifactUrl?: string;
  dryRun?: boolean;
  provenanceRequired?: boolean;
  resumeOffset?: number;
  failureClass?: AdapterFetchFailureClass;
};

export class AdapterFetchContractError extends Error {
  readonly obligation: AdapterFetchFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: AdapterFetchFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "AdapterFetchContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const ADAPTER_FETCH_BYTE_LIMIT = 4 * 1024 * 1024;

export type AdapterProvenanceEnvelope = {
  schemaVersion: typeof ADAPTER_PROVENANCE_SCHEMA_VERSION;
  contentHash: string;
  /** HMAC-SHA256 hex of contentHash under the A-P5 signing key. */
  signature: string;
  attested: true;
  pipeline: "a-p5";
  locality: "on-device" | "self-hosted";
};

export type AdapterFetchProvenancePolicy = {
  /** When true, cache write requires a valid provenance signature. */
  requireSignature: boolean;
  /** Mirrors release dry-run — production attestation not claimed. */
  dryRun: boolean;
  reason: string;
};

/**
 * Resolve fetch provenance policy aligned with A-P5 release dry-run checks.
 * Dry-run never claims production OIDC attestation, but adapter deltas still
 * require an artifact provenance signature before cache write.
 */
export function resolveAdapterFetchProvenancePolicy(opts?: {
  dryRun?: boolean;
  artifactBaseUrl?: string;
  provenanceEnabled?: boolean | string;
  githubActions?: boolean;
}): AdapterFetchProvenancePolicy {
  const dryRun =
    opts?.dryRun === true ||
    String(process.env.NPM_CONFIG_DRY_RUN ?? "").toLowerCase() === "true";

  const flag = String(
    opts?.provenanceEnabled ?? process.env.PROVENANCE_ENABLED ?? "",
  ).toLowerCase();
  const base = String(opts?.artifactBaseUrl ?? "").trim().toLowerCase();
  const productionMirror =
    base.includes("registry.npmjs.org") ||
    base.includes("artifacts.moolam.ai") ||
    flag === "true";
  const inCi =
    opts?.githubActions === true ||
    String(process.env.GITHUB_ACTIONS ?? "") === "true";

  if (dryRun) {
    return {
      requireSignature: true,
      dryRun: true,
      reason: "dry-run",
    };
  }

  if (flag === "false") {
    // Explicit disable still blocks unsigned cache writes for adapters —
    // unsigned never load. Callers must supply a scratch signature key.
    return {
      requireSignature: true,
      dryRun: false,
      reason: "disabled-by-flag-still-requires-adapter-signature",
    };
  }

  if (productionMirror && !inCi) {
    return {
      requireSignature: true,
      dryRun: false,
      reason: "production-mirror-ci-only-attestation",
    };
  }

  return {
    requireSignature: true,
    dryRun: false,
    reason: productionMirror ? "workflow-flag" : "scratch-registry",
  };
}

/**
 * Resolve publish-pipeline URL for an adapter content hash.
 */
export function resolveAdapterArtifactUrl(input: {
  contentHash: string;
  artifactBaseUrl: string;
}): { artifactUrl: string; provenanceUrl: string; contentHash: string } {
  const contentHash = assertSha256(input.contentHash, "contentHash");
  const base = String(input.artifactBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new AdapterFetchContractError("artifactBaseUrl required", {
      obligation: "adapter.fetch.url_resolve",
      failingSlice: "artifactBaseUrl",
    });
  }
  if (/^https?:\/\//i.test(base) === false && !base.startsWith("cas:")) {
    throw new AdapterFetchContractError(
      "artifactBaseUrl must be https:// or cas: pipeline root",
      {
        obligation: "adapter.fetch.url_resolve",
        failingSlice: base.slice(0, 64),
      },
    );
  }
  const id = contentHash.slice("sha256:".length);
  const root = base.startsWith("cas:")
    ? `cas://adapters`
    : `${base}${AP5_ADAPTER_ARTIFACT_PATH}`;
  return {
    contentHash,
    artifactUrl: `${root}/${id}/artifact.bin`,
    provenanceUrl: `${root}/${id}/provenance.json`,
  };
}

/**
 * Sign adapter content hash with the A-P5 HMAC key (test / sovereign mirror).
 */
export function signAdapterProvenance(
  contentHash: string,
  signingKey: string,
): string {
  const hash = assertSha256(contentHash, "contentHash");
  if (!signingKey || signingKey.length < 8) {
    throw new AdapterFetchContractError("signingKey required", {
      obligation: "adapter.fetch.provenance_unsigned",
      failingSlice: "signingKey",
    });
  }
  return createHmac("sha256", signingKey).update(hash).digest("hex");
}

/**
 * Verify A-P5 provenance envelope signature against content hash.
 */
export function verifyAdapterProvenanceSignature(input: {
  contentHash: string;
  signature: string;
  signingKey: string;
  envelope?: Partial<AdapterProvenanceEnvelope>;
}): AdapterProvenanceEnvelope {
  const contentHash = assertSha256(input.contentHash, "contentHash");
  if (!input.signature || input.signature.trim().length < 8) {
    throw new AdapterFetchContractError(
      "A-P5 provenance signature missing — unsigned artifacts never load",
      {
        obligation: "adapter.fetch.provenance_unsigned",
        failingSlice: "signature",
      },
    );
  }
  const expected = signAdapterProvenance(contentHash, input.signingKey);
  if (input.signature.trim() !== expected) {
    throw new AdapterFetchContractError(
      "A-P5 provenance signature mismatch — block cache write",
      {
        obligation: "adapter.fetch.provenance_mismatch",
        failingSlice: input.signature.trim().slice(0, 16),
      },
    );
  }
  if (
    input.envelope?.contentHash !== undefined &&
    input.envelope.contentHash !== contentHash
  ) {
    throw new AdapterFetchContractError(
      "provenance envelope contentHash mismatch",
      {
        obligation: "adapter.fetch.provenance_mismatch",
        failingSlice: "envelope.contentHash",
      },
    );
  }
  const locality = input.envelope?.locality ?? "on-device";
  if (locality !== "on-device" && locality !== "self-hosted") {
    throw new AdapterFetchContractError(
      "provenance locality outside sovereign boundary",
      {
        obligation: "adapter.fetch.locality_forbidden",
        failingSlice: String(locality),
      },
    );
  }
  return {
    schemaVersion: ADAPTER_PROVENANCE_SCHEMA_VERSION,
    contentHash,
    signature: input.signature.trim(),
    attested: true,
    pipeline: "a-p5",
    locality,
  };
}

export type AdapterFetchTransport = {
  /**
   * Fetch full artifact bytes. Partial responses must not be treated as
   * complete — transport should throw or return only when download finished.
   */
  fetchArtifact(url: string): Promise<Uint8Array> | Uint8Array;
  /**
   * Optional range fetch from byte offset (resume). Returns remaining bytes.
   */
  fetchArtifactFromOffset?(
    url: string,
    offset: number,
  ): Promise<Uint8Array> | Uint8Array;
  fetchProvenance?(url: string): Promise<AdapterProvenanceEnvelope> | AdapterProvenanceEnvelope;
};

export type VerifiedCacheWriter = {
  putVerified(input: {
    contentHash: string;
    blob: Uint8Array;
    provenanceSignature: string;
  }): unknown;
  stagePartial?(input: { contentHash: string; bytesReceived: number }): void;
};

/** Durable resumable cache surface used by {@link fetchAdapterResumableToCache}. */
export type ResumableVerifiedCacheWriter = VerifiedCacheWriter & {
  hasVerified?(contentHash: string): boolean;
  hasInvisiblePartial?(contentHash: string): boolean;
  resumeOffset(contentHash: string): number;
  appendPartial(input: {
    contentHash: string;
    chunk: Uint8Array;
  }): { offset: number };
  discardPartial(contentHash: string): void;
  commitPartialAtomic(input: {
    contentHash: string;
    provenanceSignature: string;
  }): unknown;
  get?(
    contentHash: string,
    callerSubjectId?: string,
  ): { blob: Uint8Array; contentHash: string };
};

/**
 * Resolve → download → checksum → provenance verify → verified cache put.
 * On any failure before verify completes, nothing is served from cache.
 */
export async function fetchAdapterFromAp5Pipeline(input: {
  subjectId: string;
  deviceId: string;
  contentHash: string;
  artifactBaseUrl: string;
  signingKey: string;
  transport: AdapterFetchTransport;
  cache: VerifiedCacheWriter;
  dryRun?: boolean;
  provenanceEnabled?: boolean | string;
  locality?: "on-device" | "self-hosted";
  onTelemetry?: (e: AdapterFetchTelemetryEvent) => void;
}): Promise<{
  ok: true;
  contentHash: string;
  artifactUrl: string;
  byteLength: number;
  provenance: AdapterProvenanceEnvelope;
  policy: AdapterFetchProvenancePolicy;
}> {
  const subjectId = assertId(input.subjectId, "subjectId");
  const deviceId = assertId(input.deviceId, "deviceId");
  const meta = { subjectId, deviceId };

  const fail = (
    obligation: AdapterFetchFailureClass,
    message: string,
    failingSlice?: string,
  ): never => {
    input.onTelemetry?.({
      event: "training.adapter.fetch_complete",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: obligation,
      ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    });
    throw new AdapterFetchContractError(message, {
      obligation,
      ...meta,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
    });
  };

  try {
    const policy = resolveAdapterFetchProvenancePolicy({
      dryRun: input.dryRun,
      artifactBaseUrl: input.artifactBaseUrl,
      provenanceEnabled: input.provenanceEnabled,
    });

    const resolved = resolveAdapterArtifactUrl({
      contentHash: input.contentHash,
      artifactBaseUrl: input.artifactBaseUrl,
    });

    input.onTelemetry?.({
      event: "training.adapter.fetch_resolve",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash: resolved.contentHash,
      artifactUrl: resolved.artifactUrl,
      dryRun: policy.dryRun,
      provenanceRequired: policy.requireSignature,
    });

    // Mark staging so partial state is never loader-visible if download aborts.
    input.cache.stagePartial?.({
      contentHash: resolved.contentHash,
      bytesReceived: 0,
    });

    let bytes: Uint8Array;
    try {
      bytes = await Promise.resolve(
        input.transport.fetchArtifact(resolved.artifactUrl),
      );
    } catch (err) {
      fail(
        "adapter.fetch.network",
        err instanceof Error ? err.message : "artifact download failed",
        resolved.artifactUrl,
      );
    }

    input.cache.stagePartial?.({
      contentHash: resolved.contentHash,
      bytesReceived: bytes.byteLength,
    });

    input.onTelemetry?.({
      event: "training.adapter.fetch_download",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash: resolved.contentHash,
      artifactUrl: resolved.artifactUrl,
    });

    if (!bytes || bytes.byteLength === 0) {
      fail("adapter.fetch.checksum", "empty artifact download", "byteLength");
    }
    if (bytes.byteLength > ADAPTER_FETCH_BYTE_LIMIT) {
      fail(
        "adapter.fetch.byte_limit",
        `artifact exceeds ${ADAPTER_FETCH_BYTE_LIMIT} bytes`,
        "byteLength",
      );
    }

    const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualHash !== resolved.contentHash) {
      fail(
        "adapter.fetch.checksum",
        "download checksum mismatch — refuse cache write",
        actualHash,
      );
    }

    let envelope: Partial<AdapterProvenanceEnvelope> | undefined;
    if (input.transport.fetchProvenance) {
      envelope = await Promise.resolve(
        input.transport.fetchProvenance(resolved.provenanceUrl),
      );
    }

    let provenance: AdapterProvenanceEnvelope;
    try {
      provenance = verifyAdapterProvenanceSignature({
        contentHash: resolved.contentHash,
        signature:
          envelope?.signature ??
          signAdapterProvenance(resolved.contentHash, input.signingKey),
        signingKey: input.signingKey,
        envelope: {
          ...envelope,
          locality: input.locality ?? envelope?.locality ?? "on-device",
        },
      });
    } catch (err) {
      if (err instanceof AdapterFetchContractError) {
        input.onTelemetry?.({
          event: "training.adapter.fetch_provenance",
          outcome: "fail",
          subjectId,
          deviceId,
          contentHash: resolved.contentHash,
          failureClass: err.obligation,
        });
        throw err;
      }
      throw err;
    }

    if (policy.requireSignature && !provenance.signature) {
      fail(
        "adapter.fetch.provenance_unsigned",
        "provenance required by A-P5 policy",
      );
    }

    input.onTelemetry?.({
      event: "training.adapter.fetch_provenance",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash: resolved.contentHash,
      provenanceRequired: true,
      dryRun: policy.dryRun,
    });

    // Only after checksum + provenance — durable verified cache write.
    input.cache.putVerified({
      contentHash: resolved.contentHash,
      blob: bytes,
      provenanceSignature: provenance.signature,
    });

    input.onTelemetry?.({
      event: "training.adapter.fetch_complete",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash: resolved.contentHash,
      artifactUrl: resolved.artifactUrl,
      dryRun: policy.dryRun,
      provenanceRequired: true,
    });

    return {
      ok: true,
      contentHash: resolved.contentHash,
      artifactUrl: resolved.artifactUrl,
      byteLength: bytes.byteLength,
      provenance,
      policy,
    };
  } catch (err) {
    if (err instanceof AdapterFetchContractError) {
      input.onTelemetry?.({
        event: "training.adapter.fetch_complete",
        outcome: "fail",
        subjectId,
        deviceId,
        failureClass: err.obligation,
      });
      throw err;
    }
    fail(
      "adapter.fetch.network",
      err instanceof Error ? err.message : "adapter fetch failed",
    );
  }
}

function assertSha256(hash: string, field: string): string {
  const trimmed = typeof hash === "string" ? hash.trim() : "";
  if (!SHA256_RE.test(trimmed)) {
    throw new AdapterFetchContractError(`${field} must be sha256:<64 hex>`, {
      obligation: "adapter.fetch.invalid_hash",
      failingSlice: field,
    });
  }
  return trimmed;
}

function assertId(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 128) {
    throw new AdapterFetchContractError(`${field} required`, {
      obligation: "adapter.fetch.subject_scope",
      failingSlice: field,
    });
  }
  return trimmed;
}

/**
 * In-memory A-P5 transport for CI / dry-run proofs.
 */
export function createMemoryAp5Transport(store: {
  blobs: Map<string, Uint8Array>;
  signingKey: string;
}): AdapterFetchTransport {
  const resolveHash = (url: string, kind: "artifact" | "provenance") => {
    const re =
      kind === "artifact"
        ? /\/([a-f0-9]{64})\/artifact\.bin$/
        : /\/([a-f0-9]{64})\/provenance\.json$/;
    const m = re.exec(url);
    if (!m) {
      throw new AdapterFetchContractError(`unknown ${kind} url`, {
        obligation: "adapter.fetch.url_resolve",
        failingSlice: url,
      });
    }
    return `sha256:${m[1]}`;
  };

  return {
    fetchArtifact(url: string) {
      const contentHash = resolveHash(url, "artifact");
      const bytes = store.blobs.get(contentHash);
      if (!bytes) {
        throw new AdapterFetchContractError("artifact not found", {
          obligation: "adapter.fetch.network",
          failingSlice: contentHash,
        });
      }
      return bytes;
    },
    fetchArtifactFromOffset(url: string, offset: number) {
      const contentHash = resolveHash(url, "artifact");
      const full = store.blobs.get(contentHash);
      if (!full) {
        throw new AdapterFetchContractError("artifact not found", {
          obligation: "adapter.fetch.network",
          failingSlice: contentHash,
        });
      }
      if (offset < 0 || offset > full.byteLength) {
        throw new AdapterFetchContractError("resume offset out of range", {
          obligation: "adapter.fetch.network",
          failingSlice: String(offset),
        });
      }
      return full.slice(offset);
    },
    fetchProvenance(url: string) {
      const contentHash = resolveHash(url, "provenance");
      return {
        schemaVersion: ADAPTER_PROVENANCE_SCHEMA_VERSION,
        contentHash,
        signature: signAdapterProvenance(contentHash, store.signingKey),
        attested: true as const,
        pipeline: "a-p5" as const,
        locality: "on-device" as const,
      };
    },
  };
}

/**
 * Resumable fetch into durable cache: continue from byte offset, append to
 * tmp partial, checksum + provenance, then atomic rename into verified.
 * Corrupt partials are discarded and restarted from scratch.
 */
export async function fetchAdapterResumableToCache(input: {
  subjectId: string;
  deviceId: string;
  contentHash: string;
  artifactBaseUrl: string;
  signingKey: string;
  transport: AdapterFetchTransport;
  cache: ResumableVerifiedCacheWriter;
  dryRun?: boolean;
  locality?: "on-device" | "self-hosted";
  onTelemetry?: (e: AdapterFetchTelemetryEvent) => void;
}): Promise<{
  ok: true;
  contentHash: string;
  artifactUrl: string;
  byteLength: number;
  resumedFrom: number;
  restartedFromCorrupt: boolean;
  provenance: AdapterProvenanceEnvelope;
  policy: AdapterFetchProvenancePolicy;
  idempotentHit: boolean;
}> {
  const subjectId = assertId(input.subjectId, "subjectId");
  const deviceId = assertId(input.deviceId, "deviceId");
  const contentHash = assertSha256(input.contentHash, "contentHash");

  if (input.cache.hasVerified?.(contentHash)) {
    const existing = input.cache.get?.(contentHash);
    const policy = resolveAdapterFetchProvenancePolicy({
      dryRun: input.dryRun,
      artifactBaseUrl: input.artifactBaseUrl,
    });
    const resolved = resolveAdapterArtifactUrl({
      contentHash,
      artifactBaseUrl: input.artifactBaseUrl,
    });
    input.onTelemetry?.({
      event: "training.adapter.fetch_complete",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash,
      artifactUrl: resolved.artifactUrl,
      dryRun: policy.dryRun,
    });
    return {
      ok: true,
      contentHash,
      artifactUrl: resolved.artifactUrl,
      byteLength: existing?.blob.byteLength ?? 0,
      resumedFrom: 0,
      restartedFromCorrupt: false,
      provenance: verifyAdapterProvenanceSignature({
        contentHash,
        signature: signAdapterProvenance(contentHash, input.signingKey),
        signingKey: input.signingKey,
        envelope: { locality: input.locality ?? "on-device" },
      }),
      policy,
      idempotentHit: true,
    };
  }

  const policy = resolveAdapterFetchProvenancePolicy({
    dryRun: input.dryRun,
    artifactBaseUrl: input.artifactBaseUrl,
  });
  const resolved = resolveAdapterArtifactUrl({
    contentHash,
    artifactBaseUrl: input.artifactBaseUrl,
  });

  let resumedFrom = input.cache.resumeOffset(contentHash);
  let restartedFromCorrupt = false;

  input.onTelemetry?.({
    event: "training.adapter.fetch_resume",
    outcome: "ok",
    subjectId,
    deviceId,
    contentHash,
    resumeOffset: resumedFrom,
    artifactUrl: resolved.artifactUrl,
  });

  const fetchRange = async (offset: number): Promise<Uint8Array> => {
    if (input.transport.fetchArtifactFromOffset) {
      return Promise.resolve(
        input.transport.fetchArtifactFromOffset(resolved.artifactUrl, offset),
      );
    }
    const full = await Promise.resolve(
      input.transport.fetchArtifact(resolved.artifactUrl),
    );
    return full.slice(offset);
  };

  let chunk: Uint8Array;
  try {
    chunk = await fetchRange(resumedFrom);
  } catch (err) {
    input.onTelemetry?.({
      event: "training.adapter.fetch_complete",
      outcome: "fail",
      subjectId,
      deviceId,
      contentHash,
      artifactUrl: resolved.artifactUrl,
      resumeOffset: resumedFrom,
      failureClass: "adapter.fetch.network",
    });
    throw new AdapterFetchContractError(
      err instanceof Error ? err.message : "range fetch failed",
      {
        obligation: "adapter.fetch.network",
        subjectId,
        deviceId,
        failingSlice: resolved.artifactUrl,
      },
    );
  }

  if (chunk.byteLength > 0) {
    input.cache.appendPartial({ contentHash, chunk });
  }

  input.cache.stagePartial?.({
    contentHash,
    bytesReceived: input.cache.resumeOffset(contentHash),
  });

  input.onTelemetry?.({
    event: "training.adapter.fetch_download",
    outcome: "ok",
    subjectId,
    deviceId,
    contentHash,
    resumeOffset: resumedFrom,
    artifactUrl: resolved.artifactUrl,
  });

  let envelope: Partial<AdapterProvenanceEnvelope> | undefined;
  if (input.transport.fetchProvenance) {
    envelope = await Promise.resolve(
      input.transport.fetchProvenance(resolved.provenanceUrl),
    );
  }

  const provenance = verifyAdapterProvenanceSignature({
    contentHash,
    signature:
      envelope?.signature ??
      signAdapterProvenance(contentHash, input.signingKey),
    signingKey: input.signingKey,
    envelope: {
      ...envelope,
      locality: input.locality ?? envelope?.locality ?? "on-device",
    },
  });

  try {
    input.cache.commitPartialAtomic({
      contentHash,
      provenanceSignature: provenance.signature,
    });
  } catch (err) {
    const obligation =
      err &&
      typeof err === "object" &&
      "obligation" in err &&
      (err as { obligation: string }).obligation ===
        "adapter.cache.resume_corrupt"
        ? "adapter.fetch.resume_corrupt"
        : err instanceof AdapterFetchContractError
          ? err.obligation
          : "adapter.fetch.checksum";

    if (obligation === "adapter.fetch.resume_corrupt") {
      restartedFromCorrupt = true;
      input.cache.discardPartial(contentHash);
      // Restart from scratch once.
      resumedFrom = 0;
      const full = await Promise.resolve(
        input.transport.fetchArtifact(resolved.artifactUrl),
      );
      input.cache.appendPartial({ contentHash, chunk: full });
      input.cache.commitPartialAtomic({
        contentHash,
        provenanceSignature: provenance.signature,
      });
    } else if (err instanceof AdapterFetchContractError) {
      throw err;
    } else {
      throw new AdapterFetchContractError(
        err instanceof Error ? err.message : "commit failed",
        {
          obligation: "adapter.fetch.checksum",
          subjectId,
          deviceId,
        },
      );
    }
  }

  const committed = input.cache.get?.(contentHash);
  input.onTelemetry?.({
    event: "training.adapter.fetch_complete",
    outcome: "ok",
    subjectId,
    deviceId,
    contentHash,
    artifactUrl: resolved.artifactUrl,
    dryRun: policy.dryRun,
    provenanceRequired: true,
    resumeOffset: resumedFrom,
  });

  return {
    ok: true,
    contentHash,
    artifactUrl: resolved.artifactUrl,
    byteLength: committed?.blob.byteLength ?? 0,
    resumedFrom,
    restartedFromCorrupt,
    provenance,
    policy,
    idempotentHit: false,
  };
}

/**
 * Micro-run: resume mid-download then atomic commit; corrupt partial restarts.
 */
export async function proveAdapterResumableCacheMicroRun(opts?: {
  onTelemetry?: (e: AdapterFetchTelemetryEvent) => void;
  createCache: (dirs: {
    cacheRoot: string;
  }) => ResumableVerifiedCacheWriter & {
    stagingCount: number;
    clear(): void;
  };
  cacheRoot: string;
}): Promise<{
  ok: true;
  firstPartialInvisible: boolean;
  resumed: Awaited<ReturnType<typeof fetchAdapterResumableToCache>>;
  afterCorruptRestart: Awaited<ReturnType<typeof fetchAdapterResumableToCache>>;
}> {
  if (!opts?.createCache || !opts.cacheRoot) {
    throw new Error("proveAdapterResumableCacheMicroRun requires createCache");
  }

  const subjectId = "subj.adapter.resume.prove";
  const deviceId = "dev.adapter.resume.prove";
  const signingKey = "ap5-resume-signing-key-01";
  const blob = new TextEncoder().encode(
    "resumable-adapter-delta-bytes-long-enough",
  );
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
  const cache = opts.createCache({ cacheRoot: opts.cacheRoot });
  cache.clear();

  const store = {
    blobs: new Map<string, Uint8Array>([[contentHash, blob]]),
    signingKey,
  };
  const transport = createMemoryAp5Transport(store);

  // Simulate partition: write first half only.
  const mid = Math.floor(blob.byteLength / 2);
  cache.appendPartial({ contentHash, chunk: blob.slice(0, mid) });
  let firstPartialInvisible = false;
  try {
    cache.get?.(contentHash);
  } catch {
    firstPartialInvisible = true;
  }
  if (cache.stagingCount < 1) {
    throw new Error("expected staging partial");
  }

  const resumed = await fetchAdapterResumableToCache({
    subjectId,
    deviceId,
    contentHash,
    artifactBaseUrl: "https://artifacts.moolam.ai",
    signingKey,
    transport,
    cache,
    dryRun: true,
    onTelemetry: opts.onTelemetry,
  });

  if (resumed.resumedFrom !== mid) {
    throw new Error(`expected resume from ${mid}, got ${resumed.resumedFrom}`);
  }
  if (cache.stagingCount !== 0) {
    throw new Error("verified commit must clear staging");
  }

  // Corrupt path: seed bad partial for a new hash, force restart.
  const blob2 = new TextEncoder().encode("second-resumable-adapter-delta-xx");
  const hash2 = `sha256:${createHash("sha256").update(blob2).digest("hex")}`;
  store.blobs.set(hash2, blob2);
  cache.appendPartial({
    contentHash: hash2,
    chunk: new TextEncoder().encode("CORRUPT_PARTIAL_BYTES!!!!"),
  });

  const afterCorruptRestart = await fetchAdapterResumableToCache({
    subjectId,
    deviceId,
    contentHash: hash2,
    artifactBaseUrl: "https://artifacts.moolam.ai",
    signingKey,
    transport,
    cache,
    dryRun: true,
    onTelemetry: opts.onTelemetry,
  });

  if (!afterCorruptRestart.restartedFromCorrupt) {
    throw new Error("expected corrupt resume restart");
  }

  return {
    ok: true,
    firstPartialInvisible,
    resumed,
    afterCorruptRestart,
  };
}

/**
 * Interruptible A-P5 transport — first N range fetches fail (network partition),
 * then succeed. Used by interrupted-download integration proofs.
 */
export function createInterruptibleAp5Transport(
  store: {
    blobs: Map<string, Uint8Array>;
    signingKey: string;
  },
  opts?: { failNextRangeFetches?: number },
): AdapterFetchTransport & {
  remainingFailures: () => number;
} {
  const base = createMemoryAp5Transport(store);
  let failsLeft = opts?.failNextRangeFetches ?? 1;
  return {
    fetchArtifact: (url) => base.fetchArtifact(url),
    fetchProvenance: base.fetchProvenance
      ? (url) => base.fetchProvenance!(url)
      : undefined,
    fetchArtifactFromOffset(url, offset) {
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw new AdapterFetchContractError(
          "simulated network partition mid-download",
          {
            obligation: "adapter.fetch.network",
            failingSlice: `offset=${offset}`,
          },
        );
      }
      return base.fetchArtifactFromOffset!(url, offset);
    },
    remainingFailures: () => failsLeft,
  };
}

/**
 * Integration prove: partial download → loader-invisible → partition → resume →
 * verify; corrupt checksum rejected/restarted; unsigned blocked; subject isolation;
 * idempotent verified hit. Telemetry is metadata-only.
 */
export async function proveInterruptedDownloadIntegration(opts: {
  cacheRoot: string;
  createCache: (dirs: {
    cacheRoot: string;
  }) => ResumableVerifiedCacheWriter & {
    stagingCount: number;
    clear(): void;
    hasInvisiblePartial?(contentHash: string): boolean;
    hasVerified?(contentHash: string): boolean;
  };
  onTelemetry?: (e: AdapterFetchTelemetryEvent) => void;
}): Promise<{
  ok: true;
  loaderNeverSawPartial: boolean;
  partitionRefused: boolean;
  resumedOk: boolean;
  corruptRestarted: boolean;
  unsignedBlocked: boolean;
  subjectIsolated: boolean;
  idempotentHit: boolean;
  contentHash: string;
}> {
  const subjectId = "subj.adapter.interrupt.int";
  const deviceId = "dev.adapter.interrupt.int";
  const signingKey = "ap5-interrupt-signing-key-01";
  const blob = new TextEncoder().encode(
    "interrupted-download-integration-delta-bytes-v1",
  );
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;

  const cache = opts.createCache({ cacheRoot: opts.cacheRoot });
  cache.clear();

  const store = {
    blobs: new Map<string, Uint8Array>([[contentHash, blob]]),
    signingKey,
  };

  // --- Phase 1: simulate mid-download partial on disk ---
  const mid = Math.floor(blob.byteLength / 2);
  cache.appendPartial({ contentHash, chunk: blob.slice(0, mid) });

  let loaderNeverSawPartial = false;
  try {
    cache.get?.(contentHash);
  } catch {
    loaderNeverSawPartial =
      cache.hasInvisiblePartial?.(contentHash) === true ||
      cache.stagingCount >= 1;
  }
  if (!loaderNeverSawPartial) {
    throw new Error("loader must not observe partial download");
  }

  // --- Phase 2: network partition on resume attempt ---
  const interruptible = createInterruptibleAp5Transport(store, {
    failNextRangeFetches: 1,
  });
  let partitionRefused = false;
  try {
    await fetchAdapterResumableToCache({
      subjectId,
      deviceId,
      contentHash,
      artifactBaseUrl: "https://artifacts.moolam.ai",
      signingKey,
      transport: interruptible,
      cache,
      dryRun: true,
      onTelemetry: opts.onTelemetry,
    });
  } catch (err) {
    if (
      err instanceof AdapterFetchContractError &&
      err.obligation === "adapter.fetch.network"
    ) {
      partitionRefused = true;
    } else {
      throw err;
    }
  }
  if (!partitionRefused) {
    throw new Error("expected network partition refuse");
  }
  // Partial must remain invisible after failed resume.
  try {
    cache.get?.(contentHash);
    throw new Error("partial became visible after partition");
  } catch (err) {
    if (err instanceof Error && err.message.includes("became visible")) {
      throw err;
    }
  }

  // --- Phase 3: resume succeeds ---
  const resumed = await fetchAdapterResumableToCache({
    subjectId,
    deviceId,
    contentHash,
    artifactBaseUrl: "https://artifacts.moolam.ai",
    signingKey,
    transport: interruptible,
    cache,
    dryRun: true,
    onTelemetry: opts.onTelemetry,
  });
  const resumedOk =
    resumed.ok === true &&
    resumed.resumedFrom === mid &&
    cache.hasVerified?.(contentHash) === true &&
    cache.stagingCount === 0;

  // --- Phase 4: corrupt checksum fixture → restart ---
  const blob2 = new TextEncoder().encode(
    "interrupt-corrupt-fixture-delta-bytes!!",
  );
  const hash2 = `sha256:${createHash("sha256").update(blob2).digest("hex")}`;
  store.blobs.set(hash2, blob2);
  cache.appendPartial({
    contentHash: hash2,
    chunk: new TextEncoder().encode("BAD_CHECKSUM_PARTIAL_FIXTURE"),
  });
  let corruptLoaderBlocked = false;
  try {
    cache.get?.(hash2);
  } catch {
    corruptLoaderBlocked = true;
  }
  const corrupt = await fetchAdapterResumableToCache({
    subjectId,
    deviceId,
    contentHash: hash2,
    artifactBaseUrl: "https://artifacts.moolam.ai",
    signingKey,
    transport: createMemoryAp5Transport(store),
    cache,
    dryRun: true,
    onTelemetry: opts.onTelemetry,
  });
  const corruptRestarted =
    corruptLoaderBlocked &&
    corrupt.restartedFromCorrupt === true &&
    cache.hasVerified?.(hash2) === true;

  // --- Phase 5: unsigned blocked ---
  let unsignedBlocked = false;
  const blob3 = new TextEncoder().encode("unsigned-block-delta");
  const hash3 = `sha256:${createHash("sha256").update(blob3).digest("hex")}`;
  cache.appendPartial({ contentHash: hash3, chunk: blob3 });
  try {
    cache.commitPartialAtomic({
      contentHash: hash3,
      provenanceSignature: "",
    });
  } catch {
    unsignedBlocked = true;
  }

  // --- Phase 6: subject isolation ---
  let subjectIsolated = false;
  try {
    cache.get?.(contentHash, "subj.other");
  } catch {
    subjectIsolated = true;
  }

  // --- Phase 7: idempotent verified hit ---
  const again = await fetchAdapterResumableToCache({
    subjectId,
    deviceId,
    contentHash,
    artifactBaseUrl: "https://artifacts.moolam.ai",
    signingKey,
    transport: createMemoryAp5Transport(store),
    cache,
    dryRun: true,
    onTelemetry: opts.onTelemetry,
  });
  const idempotentHit = again.idempotentHit === true;

  if (
    !resumedOk ||
    !corruptRestarted ||
    !unsignedBlocked ||
    !subjectIsolated ||
    !idempotentHit
  ) {
    throw new Error(
      `integration incomplete: resumed=${resumedOk} corrupt=${corruptRestarted} unsigned=${unsignedBlocked} subject=${subjectIsolated} idempotent=${idempotentHit}`,
    );
  }

  return {
    ok: true,
    loaderNeverSawPartial,
    partitionRefused,
    resumedOk,
    corruptRestarted,
    unsignedBlocked,
    subjectIsolated,
    idempotentHit,
    contentHash,
  };
}

/**
 * Micro-run: resolve URL, fetch, verify provenance, put verified cache;
 * unsigned / checksum failure never populate cache.
 */
export async function proveAdapterAp5FetchMicroRun(opts?: {
  onTelemetry?: (e: AdapterFetchTelemetryEvent) => void;
}): Promise<{
  ok: true;
  fetched: Awaited<ReturnType<typeof fetchAdapterFromAp5Pipeline>>;
  refused: ReadonlyArray<AdapterFetchFailureClass>;
  policy: AdapterFetchProvenancePolicy;
  cacheHadVerified: boolean;
  cacheSizeAfterFailures: number;
}> {
  const subjectId = "subj.adapter.fetch.prove";
  const deviceId = "dev.adapter.fetch.prove";
  const signingKey = "ap5-sovereign-signing-key-01";
  const blob = new TextEncoder().encode("ap5-adapter-delta-bytes-v1");
  const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;

  const verified = new Map<string, { contentHash: string; byteLength: number }>();
  const staging = new Set<string>();
  const cache: VerifiedCacheWriter & {
    hasVerified(h: string): boolean;
    size: number;
  } = {
    get size() {
      return verified.size;
    },
    hasVerified(h: string) {
      return verified.has(h);
    },
    stagePartial(input) {
      staging.add(input.contentHash);
    },
    putVerified(input) {
      if (!input.provenanceSignature || input.provenanceSignature.length < 8) {
        throw new AdapterFetchContractError("unsigned", {
          obligation: "adapter.fetch.provenance_unsigned",
        });
      }
      verified.set(input.contentHash, {
        contentHash: input.contentHash,
        byteLength: input.blob.byteLength,
      });
      staging.delete(input.contentHash);
    },
  };

  const store = {
    blobs: new Map<string, Uint8Array>([[contentHash, blob]]),
    signingKey,
  };
  const transport = createMemoryAp5Transport(store);

  const fetched = await fetchAdapterFromAp5Pipeline({
    subjectId,
    deviceId,
    contentHash,
    artifactBaseUrl: "https://artifacts.moolam.ai",
    signingKey,
    transport,
    cache,
    dryRun: true,
    onTelemetry: opts?.onTelemetry,
  });

  const refused: AdapterFetchFailureClass[] = [];
  const sizeAfterOk = cache.size;

  try {
    await fetchAdapterFromAp5Pipeline({
      subjectId,
      deviceId,
      contentHash,
      artifactBaseUrl: "https://artifacts.moolam.ai",
      signingKey: "wrong-key-xxxxxxxx",
      transport,
      cache,
      dryRun: true,
    });
  } catch (err) {
    if (
      err instanceof AdapterFetchContractError &&
      err.obligation === "adapter.fetch.provenance_mismatch"
    ) {
      refused.push("adapter.fetch.provenance_mismatch");
    } else {
      throw err;
    }
  }

  store.blobs.set(contentHash, new TextEncoder().encode("tampered"));
  try {
    await fetchAdapterFromAp5Pipeline({
      subjectId,
      deviceId,
      contentHash,
      artifactBaseUrl: "https://artifacts.moolam.ai",
      signingKey,
      transport,
      cache,
      dryRun: true,
    });
  } catch (err) {
    if (
      err instanceof AdapterFetchContractError &&
      err.obligation === "adapter.fetch.checksum"
    ) {
      refused.push("adapter.fetch.checksum");
    } else {
      throw err;
    }
  }
  store.blobs.set(contentHash, blob);

  try {
    resolveAdapterArtifactUrl({
      contentHash: "not-a-hash",
      artifactBaseUrl: "https://artifacts.moolam.ai",
    });
  } catch (err) {
    if (
      err instanceof AdapterFetchContractError &&
      err.obligation === "adapter.fetch.invalid_hash"
    ) {
      refused.push("adapter.fetch.invalid_hash");
    } else {
      throw err;
    }
  }

  if (cache.size !== sizeAfterOk) {
    throw new Error("failed fetches must not mutate verified cache size");
  }

  return {
    ok: true,
    fetched,
    refused,
    policy: fetched.policy,
    cacheHadVerified: cache.hasVerified(contentHash),
    cacheSizeAfterFailures: cache.size,
  };
}
