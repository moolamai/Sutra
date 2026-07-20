/**
 * Adapter delta load seam — loud-fail verify + apply for SlmRuntime (C5).
 *
 * Verifies baseModelHash, contentHash, and precisionFormat against runtime
 * pins, then applies adapter weights. Mismatch / corruption is a typed init
 * error — never silent degradation to the unadapted base. In-flight turns
 * stay pinned until TURN_COMPLETE; mid-turn load is refused. Rollback
 * restores the previous verified adapter byte-identically.
 */

import { createHash } from "node:crypto";

export const ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION =
  "adapter.delta.manifest.v1" as const;

export const ADAPTER_LOAD_SEAM_VERSION = "adapter.load.seam.v1" as const;

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

export type AdapterLoadFailureClass =
  | "adapter.load.invalid_manifest"
  | "adapter.load.base_mismatch"
  | "adapter.load.content_hash_mismatch"
  | "adapter.load.precision_mismatch"
  | "adapter.load.lineage_incomplete"
  | "adapter.load.subject_scope"
  | "adapter.load.locality_forbidden"
  | "adapter.load.truncated"
  | "adapter.load.floating_checkpoint"
  | "adapter.load.mid_turn_refuse"
  | "adapter.load.no_prior_rollback"
  | "adapter.load.idempotent_conflict"
  | "adapter.load.runtime_unloaded";

export type AdapterLoadTelemetryEvent = {
  event:
    | "bindings.adapter.load_verify"
    | "bindings.adapter.load_apply"
    | "bindings.adapter.load_rollback"
    | "bindings.adapter.turn_pin";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  baseModelHash?: string;
  contentHash?: string;
  precisionFormat?: string;
  previousContentHash?: string;
  pinnedContentHash?: string;
  sessionId?: string;
  idempotentReplay?: boolean;
  failureClass?: AdapterLoadFailureClass;
};

export class AdapterLoadContractError extends Error {
  readonly obligation: AdapterLoadFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: AdapterLoadFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "AdapterLoadContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

/** Soft cap on blob bytes verified at the load boundary (MB-scale). */
export const ADAPTER_LOAD_BYTE_LIMIT = 4 * 1024 * 1024;

/** Bound on concurrent pinned sessions tracked per loader (NFR). */
export const ADAPTER_LOAD_SESSION_PIN_LIMIT = 64;

export type AdapterDeltaManifestView = {
  schemaVersion: string;
  contentHash: string;
  baseModelHash: string;
  precisionFormat: string;
  loraRank: number;
  loraAlpha: number;
  lineageRef: {
    schemaVersion: string;
    runId: string;
    checkpointHash: string;
    corpusManifestHash: string;
    criticVersions: ReadonlyArray<{
      rubricId: string;
      rubricVersion: string;
      contentHash: string;
    }>;
  };
  adapterBlobRef: string;
  subjectId: string;
  deviceId: string;
  locality: string;
};

export type AdapterLoadRuntimePins = {
  subjectId: string;
  deviceId: string;
  /** Exact base model / checkpoint currently loaded in the runtime. */
  baseModelHash: string;
  /** Runtime precisionFormat — must match manifest (QLoRA vs LoRA). */
  precisionFormat: AdapterPrecisionFormat;
};

export type AdapterLoadVerifyResult = {
  ok: true;
  seamVersion: typeof ADAPTER_LOAD_SEAM_VERSION;
  contentHash: string;
  baseModelHash: string;
  precisionFormat: AdapterPrecisionFormat;
  byteLength: number;
};

/** Applied adapter state held by the SlmRuntime load seam (content-addressed). */
export type AppliedAdapterState = {
  contentHash: string;
  baseModelHash: string;
  precisionFormat: AdapterPrecisionFormat;
  loraRank: number;
  loraAlpha: number;
  lineageRunId: string;
  /** Exact blob bytes — rollback restores these byte-identically. */
  blob: Buffer;
  byteLength: number;
  appliedAt: string;
};

export type AdapterLoadApplyResult = {
  ok: true;
  seamVersion: typeof ADAPTER_LOAD_SEAM_VERSION;
  applied: AppliedAdapterState;
  previousContentHash: string | undefined;
  idempotentReplay: boolean;
};

function assertOpaqueHash(
  hash: string,
  field: string,
  subjectId?: string,
): string {
  const trimmed = typeof hash === "string" ? hash.trim() : "";
  if (!trimmed || trimmed.length < 8 || trimmed.length > 128) {
    throw new AdapterLoadContractError(`${field} required`, {
      obligation: "adapter.load.invalid_manifest",
      ...(subjectId !== undefined ? { subjectId } : {}),
      failingSlice: field,
    });
  }
  if (trimmed.toLowerCase() === "latest") {
    throw new AdapterLoadContractError(
      `floating checkpoint 'latest' forbidden on ${field}`,
      {
        obligation: "adapter.load.floating_checkpoint",
        ...(subjectId !== undefined ? { subjectId } : {}),
        failingSlice: field,
      },
    );
  }
  return trimmed;
}

/**
 * Content-address adapter blob bytes (sha256:<64 hex>).
 */
export function contentAddressAdapterBlob(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    throw new AdapterLoadContractError("adapter blob empty / truncated", {
      obligation: "adapter.load.truncated",
      failingSlice: "byteLength",
    });
  }
  if (bytes.byteLength > ADAPTER_LOAD_BYTE_LIMIT) {
    throw new AdapterLoadContractError(
      `adapter blob exceeds ${ADAPTER_LOAD_BYTE_LIMIT} bytes`,
      {
        obligation: "adapter.load.truncated",
        failingSlice: "byteLength",
      },
    );
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Verify a packed manifest + blob pair against runtime pins (loud-fail).
 * Used after GRPO pack emit and before any weight apply.
 */
export function verifyPackedAdapterDelta(input: {
  packed: {
    manifest: AdapterDeltaManifestView;
    blob: Uint8Array;
  };
  runtime: AdapterLoadRuntimePins;
  onTelemetry?: (e: AdapterLoadTelemetryEvent) => void;
}): AdapterLoadVerifyResult {
  return verifyAdapterDeltaForLoad({
    manifest: input.packed.manifest,
    blobBytes: input.packed.blob,
    runtime: input.runtime,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
}

/**
 * Verify manifest + blob against runtime pins before any weight apply.
 * Loud-fail on base / content / precision mismatch.
 */
export function verifyAdapterDeltaForLoad(input: {
  manifest: AdapterDeltaManifestView;
  blobBytes: Uint8Array;
  runtime: AdapterLoadRuntimePins;
  onTelemetry?: (e: AdapterLoadTelemetryEvent) => void;
}): AdapterLoadVerifyResult {
  const { manifest, blobBytes, runtime } = input;
  const subjectId = runtime.subjectId;
  const deviceId = runtime.deviceId;

  const fail = (
    obligation: AdapterLoadFailureClass,
    message: string,
    failingSlice?: string,
  ): never => {
    input.onTelemetry?.({
      event: "bindings.adapter.load_verify",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: obligation,
      ...(manifest.baseModelHash
        ? { baseModelHash: manifest.baseModelHash }
        : {}),
      ...(manifest.contentHash ? { contentHash: manifest.contentHash } : {}),
      ...(manifest.precisionFormat
        ? { precisionFormat: manifest.precisionFormat }
        : {}),
    });
    throw new AdapterLoadContractError(message, {
      obligation,
      subjectId,
      deviceId,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
    });
  };

  if (manifest.schemaVersion !== ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION) {
    fail(
      "adapter.load.invalid_manifest",
      "adapter manifest schemaVersion mismatch",
      String(manifest.schemaVersion),
    );
  }

  if (manifest.subjectId !== subjectId) {
    fail(
      "adapter.load.subject_scope",
      "cross-subject adapter load denied",
      manifest.subjectId,
    );
  }

  if (
    manifest.locality !== "on-device" &&
    manifest.locality !== "self-hosted"
  ) {
    fail(
      "adapter.load.locality_forbidden",
      "adapter locality outside sovereign boundary",
      String(manifest.locality),
    );
  }

  if (
    !manifest.lineageRef ||
    manifest.lineageRef.schemaVersion !== "checkpoint.lineage.v1" ||
    !manifest.lineageRef.runId ||
    !Array.isArray(manifest.lineageRef.criticVersions) ||
    manifest.lineageRef.criticVersions.length < 1
  ) {
    fail(
      "adapter.load.lineage_incomplete",
      "lineageRef must point to a complete C4 registry row",
      "lineageRef",
    );
  }

  const expectedBase = assertOpaqueHash(
    runtime.baseModelHash,
    "runtime.baseModelHash",
    subjectId,
  );
  const manifestBase = assertOpaqueHash(
    manifest.baseModelHash,
    "manifest.baseModelHash",
    subjectId,
  );
  if (manifestBase !== expectedBase) {
    fail(
      "adapter.load.base_mismatch",
      "baseModelHash mismatch — refuse silent degradation to unadapted base",
      manifestBase,
    );
  }

  if (
    !(ADAPTER_PRECISION_FORMATS as readonly string[]).includes(
      manifest.precisionFormat,
    )
  ) {
    fail(
      "adapter.load.invalid_manifest",
      "precisionFormat invalid",
      manifest.precisionFormat,
    );
  }
  if (manifest.precisionFormat !== runtime.precisionFormat) {
    fail(
      "adapter.load.precision_mismatch",
      "precisionFormat mismatch — cross-format load rejected",
      `${manifest.precisionFormat}!=${runtime.precisionFormat}`,
    );
  }

  if (!SHA256_RE.test(manifest.contentHash)) {
    fail(
      "adapter.load.invalid_manifest",
      "contentHash must be sha256:<64 hex>",
      "contentHash",
    );
  }

  let actualHash: string;
  try {
    actualHash = contentAddressAdapterBlob(blobBytes);
  } catch (err) {
    if (err instanceof AdapterLoadContractError) {
      input.onTelemetry?.({
        event: "bindings.adapter.load_verify",
        outcome: "fail",
        subjectId,
        deviceId,
        failureClass: err.obligation,
      });
      throw err;
    }
    throw err;
  }

  if (actualHash !== manifest.contentHash) {
    fail(
      "adapter.load.content_hash_mismatch",
      "contentHash mismatch — corrupt or truncated artifact refused",
      actualHash,
    );
  }

  const result: AdapterLoadVerifyResult = {
    ok: true,
    seamVersion: ADAPTER_LOAD_SEAM_VERSION,
    contentHash: actualHash,
    baseModelHash: expectedBase,
    precisionFormat: runtime.precisionFormat,
    byteLength: blobBytes.byteLength,
  };

  input.onTelemetry?.({
    event: "bindings.adapter.load_verify",
    outcome: "ok",
    subjectId,
    deviceId,
    baseModelHash: result.baseModelHash,
    contentHash: result.contentHash,
    precisionFormat: result.precisionFormat,
  });

  return result;
}

/**
 * SlmRuntime adapter-load seam: verify hashes, apply adapter, pin turns,
 * rollback byte-identically. Never falls back to an unverified base on error.
 */
export class SlmRuntimeAdapterLoader {
  private active: AppliedAdapterState | undefined;
  private previous: AppliedAdapterState | undefined;
  /** sessionId → contentHash pinned for the in-flight turn. */
  private readonly pinnedSessions = new Map<string, string>();
  private readonly byLoadId = new Map<string, AdapterLoadApplyResult>();
  private runtimeLoaded: boolean;

  constructor(
    private readonly opts: AdapterLoadRuntimePins & {
      onTelemetry?: (e: AdapterLoadTelemetryEvent) => void;
      /** When false, load refuses with runtime_unloaded. */
      runtimeLoaded?: boolean;
    },
  ) {
    if (!opts.subjectId?.trim()) {
      throw new AdapterLoadContractError("subjectId required", {
        obligation: "adapter.load.subject_scope",
      });
    }
    assertOpaqueHash(opts.baseModelHash, "baseModelHash", opts.subjectId);
    if (
      !(ADAPTER_PRECISION_FORMATS as readonly string[]).includes(
        opts.precisionFormat,
      )
    ) {
      throw new AdapterLoadContractError("precisionFormat invalid", {
        obligation: "adapter.load.invalid_manifest",
        subjectId: opts.subjectId,
        failingSlice: "precisionFormat",
      });
    }
    this.runtimeLoaded = opts.runtimeLoaded !== false;
  }

  get activeContentHash(): string | undefined {
    return this.active?.contentHash;
  }

  get activeAdapter(): AppliedAdapterState | undefined {
    return this.active;
  }

  get hasInFlightTurn(): boolean {
    return this.pinnedSessions.size > 0;
  }

  /**
   * Pin the active adapter hash to a session at turn start.
   * Mid-turn loads are refused until TURN_COMPLETE.
   */
  beginTurn(sessionId: string): { pinnedContentHash: string | undefined } {
    const id = sessionId.trim();
    if (!id) {
      throw new AdapterLoadContractError("sessionId required", {
        obligation: "adapter.load.invalid_manifest",
        subjectId: this.opts.subjectId,
        failingSlice: "sessionId",
      });
    }
    if (
      !this.pinnedSessions.has(id) &&
      this.pinnedSessions.size >= ADAPTER_LOAD_SESSION_PIN_LIMIT
    ) {
      throw new AdapterLoadContractError("pinned session limit exceeded", {
        obligation: "adapter.load.invalid_manifest",
        subjectId: this.opts.subjectId,
        failingSlice: "sessionPinLimit",
      });
    }
    const pinned = this.active?.contentHash;
    this.pinnedSessions.set(id, pinned ?? "");
    this.opts.onTelemetry?.({
      event: "bindings.adapter.turn_pin",
      outcome: "ok",
      subjectId: this.opts.subjectId,
      deviceId: this.opts.deviceId,
      sessionId: id,
      ...(pinned !== undefined ? { pinnedContentHash: pinned } : {}),
    });
    return { pinnedContentHash: pinned };
  }

  /**
   * TURN_COMPLETE — release the session pin so a pending load may apply.
   */
  completeTurn(sessionId: string): void {
    const id = sessionId.trim();
    this.pinnedSessions.delete(id);
    this.opts.onTelemetry?.({
      event: "bindings.adapter.turn_pin",
      outcome: "ok",
      subjectId: this.opts.subjectId,
      deviceId: this.opts.deviceId,
      sessionId: id,
      ...(this.active?.contentHash !== undefined
        ? { pinnedContentHash: this.active.contentHash }
        : {}),
    });
  }

  /**
   * Verify then apply. On any verify failure the active adapter is untouched
   * (never silently falls back to the unadapted base).
   */
  loadAdapter(input: {
    manifest: AdapterDeltaManifestView;
    blobBytes: Uint8Array;
    loadId?: string;
    appliedAt?: string;
  }): AdapterLoadApplyResult {
    const subjectId = this.opts.subjectId;
    const deviceId = this.opts.deviceId;

    if (!this.runtimeLoaded) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.load_apply",
        outcome: "fail",
        subjectId,
        deviceId,
        failureClass: "adapter.load.runtime_unloaded",
      });
      throw new AdapterLoadContractError(
        "SlmRuntime not loaded — refuse adapter apply",
        {
          obligation: "adapter.load.runtime_unloaded",
          subjectId,
          deviceId,
        },
      );
    }

    if (this.pinnedSessions.size > 0) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.load_apply",
        outcome: "fail",
        subjectId,
        deviceId,
        failureClass: "adapter.load.mid_turn_refuse",
        ...(this.active?.contentHash !== undefined
          ? { pinnedContentHash: this.active.contentHash }
          : {}),
      });
      throw new AdapterLoadContractError(
        "in-flight turn pinned until TURN_COMPLETE — mid-turn load refused",
        {
          obligation: "adapter.load.mid_turn_refuse",
          subjectId,
          deviceId,
          failingSlice: "turnPin",
        },
      );
    }

    if (input.loadId !== undefined) {
      const prior = this.byLoadId.get(input.loadId);
      if (prior) {
        const nextHash = (() => {
          try {
            return contentAddressAdapterBlob(input.blobBytes);
          } catch {
            return "";
          }
        })();
        if (nextHash && nextHash !== prior.applied.contentHash) {
          throw new AdapterLoadContractError(
            "loadId replay with divergent blob — refuse double-apply",
            {
              obligation: "adapter.load.idempotent_conflict",
              subjectId,
              deviceId,
              failingSlice: input.loadId,
            },
          );
        }
        this.opts.onTelemetry?.({
          event: "bindings.adapter.load_apply",
          outcome: "ok",
          subjectId,
          deviceId,
          contentHash: prior.applied.contentHash,
          baseModelHash: prior.applied.baseModelHash,
          precisionFormat: prior.applied.precisionFormat,
          idempotentReplay: true,
        });
        return { ...prior, idempotentReplay: true };
      }
    }

    // Snapshot prior active — only commit after verify succeeds (no partial apply).
    const priorActive = this.active;

    const verified = verifyAdapterDeltaForLoad({
      manifest: input.manifest,
      blobBytes: input.blobBytes,
      runtime: {
        subjectId,
        deviceId,
        baseModelHash: this.opts.baseModelHash,
        precisionFormat: this.opts.precisionFormat,
      },
      ...(this.opts.onTelemetry !== undefined
        ? { onTelemetry: this.opts.onTelemetry }
        : {}),
    });

    if (
      this.active &&
      this.active.contentHash === verified.contentHash &&
      this.active.blob.equals(Buffer.from(input.blobBytes))
    ) {
      const replay: AdapterLoadApplyResult = {
        ok: true,
        seamVersion: ADAPTER_LOAD_SEAM_VERSION,
        applied: this.active,
        previousContentHash: this.previous?.contentHash,
        idempotentReplay: true,
      };
      if (input.loadId !== undefined) {
        this.byLoadId.set(input.loadId, replay);
      }
      this.opts.onTelemetry?.({
        event: "bindings.adapter.load_apply",
        outcome: "ok",
        subjectId,
        deviceId,
        contentHash: verified.contentHash,
        baseModelHash: verified.baseModelHash,
        precisionFormat: verified.precisionFormat,
        idempotentReplay: true,
      });
      return replay;
    }

    const blob = Buffer.from(input.blobBytes);
    const applied: AppliedAdapterState = {
      contentHash: verified.contentHash,
      baseModelHash: verified.baseModelHash,
      precisionFormat: verified.precisionFormat,
      loraRank: input.manifest.loraRank,
      loraAlpha: input.manifest.loraAlpha,
      lineageRunId: input.manifest.lineageRef.runId,
      blob,
      byteLength: blob.byteLength,
      appliedAt: input.appliedAt ?? new Date().toISOString(),
    };

    this.previous = priorActive;
    this.active = applied;

    const result: AdapterLoadApplyResult = {
      ok: true,
      seamVersion: ADAPTER_LOAD_SEAM_VERSION,
      applied,
      previousContentHash: priorActive?.contentHash,
      idempotentReplay: false,
    };

    if (input.loadId !== undefined) {
      this.byLoadId.set(input.loadId, result);
      if (this.byLoadId.size > ADAPTER_LOAD_SESSION_PIN_LIMIT) {
        const first = this.byLoadId.keys().next().value;
        if (first !== undefined) this.byLoadId.delete(first);
      }
    }

    this.opts.onTelemetry?.({
      event: "bindings.adapter.load_apply",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash: applied.contentHash,
      baseModelHash: applied.baseModelHash,
      precisionFormat: applied.precisionFormat,
      ...(priorActive !== undefined
        ? { previousContentHash: priorActive.contentHash }
        : {}),
      idempotentReplay: false,
    });

    return result;
  }

  /**
   * Restore the previous verified adapter byte-identically.
   * Refused while a turn is pinned.
   */
  rollback(): AdapterLoadApplyResult {
    const subjectId = this.opts.subjectId;
    const deviceId = this.opts.deviceId;

    if (this.pinnedSessions.size > 0) {
      throw new AdapterLoadContractError(
        "rollback refused while turn is pinned until TURN_COMPLETE",
        {
          obligation: "adapter.load.mid_turn_refuse",
          subjectId,
          deviceId,
        },
      );
    }

    if (!this.previous) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.load_rollback",
        outcome: "fail",
        subjectId,
        deviceId,
        failureClass: "adapter.load.no_prior_rollback",
      });
      throw new AdapterLoadContractError(
        "no prior verified adapter to restore",
        {
          obligation: "adapter.load.no_prior_rollback",
          subjectId,
          deviceId,
        },
      );
    }

    const restored = {
      ...this.previous,
      blob: Buffer.from(this.previous.blob),
    };
    const displaced = this.active;
    this.active = restored;
    this.previous = displaced;

    const result: AdapterLoadApplyResult = {
      ok: true,
      seamVersion: ADAPTER_LOAD_SEAM_VERSION,
      applied: restored,
      previousContentHash: displaced?.contentHash,
      idempotentReplay: false,
    };

    this.opts.onTelemetry?.({
      event: "bindings.adapter.load_rollback",
      outcome: "ok",
      subjectId,
      deviceId,
      contentHash: restored.contentHash,
      baseModelHash: restored.baseModelHash,
      precisionFormat: restored.precisionFormat,
      ...(displaced !== undefined
        ? { previousContentHash: displaced.contentHash }
        : {}),
    });

    return result;
  }
}

function fixtureManifest(input: {
  subjectId: string;
  deviceId: string;
  baseModelHash: string;
  contentHash: string;
  precisionFormat?: AdapterPrecisionFormat;
}): AdapterDeltaManifestView {
  return {
    schemaVersion: ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
    contentHash: input.contentHash,
    baseModelHash: input.baseModelHash,
    precisionFormat: input.precisionFormat ?? "int4",
    loraRank: 16,
    loraAlpha: 32,
    lineageRef: {
      schemaVersion: "checkpoint.lineage.v1",
      runId: "run.load.apply.01",
      checkpointHash: "ckpt:sha256:lineageapply0001",
      corpusManifestHash:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      criticVersions: [
        {
          rubricId: "core.format",
          rubricVersion: "1.0.0",
          contentHash:
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        },
      ],
    },
    adapterBlobRef: `cas://${input.contentHash}`,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: "on-device",
  };
}

/**
 * Micro-run: happy-path verify + named loud-fail classes.
 */
export function proveAdapterLoadVerifyMicroRun(opts?: {
  onTelemetry?: (e: AdapterLoadTelemetryEvent) => void;
}): {
  ok: true;
  verified: AdapterLoadVerifyResult;
  refused: ReadonlyArray<AdapterLoadFailureClass>;
} {
  const subjectId = "subj.adapter.load.prove";
  const deviceId = "dev.adapter.load.prove";
  const baseModelHash = "ckpt:sha256:loadbase00000001";
  const blob = new TextEncoder().encode("lora-delta-bytes-v1");
  const contentHash = contentAddressAdapterBlob(blob);

  const manifest = fixtureManifest({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash,
  });

  const verified = verifyAdapterDeltaForLoad({
    manifest,
    blobBytes: blob,
    runtime: {
      subjectId,
      deviceId,
      baseModelHash,
      precisionFormat: "int4",
    },
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  const refused: AdapterLoadFailureClass[] = [];

  const tryRefuse = (
    patch: Partial<AdapterDeltaManifestView>,
    runtimePatch: Partial<AdapterLoadRuntimePins>,
    expected: AdapterLoadFailureClass,
    bytes?: Uint8Array,
  ): void => {
    try {
      verifyAdapterDeltaForLoad({
        manifest: { ...manifest, ...patch },
        blobBytes: bytes ?? blob,
        runtime: {
          subjectId,
          deviceId,
          baseModelHash,
          precisionFormat: "int4",
          ...runtimePatch,
        },
      });
    } catch (err) {
      if (
        err instanceof AdapterLoadContractError &&
        err.obligation === expected
      ) {
        refused.push(expected);
        return;
      }
      throw err;
    }
    throw new Error(`expected refuse ${expected}`);
  };

  tryRefuse(
    { baseModelHash: "ckpt:sha256:otherbase0000001" },
    {},
    "adapter.load.base_mismatch",
  );
  tryRefuse(
    {},
    { precisionFormat: "fp16" },
    "adapter.load.precision_mismatch",
  );
  tryRefuse(
    {},
    {},
    "adapter.load.content_hash_mismatch",
    new TextEncoder().encode("truncated-or-corrupt"),
  );
  tryRefuse({ subjectId: "subj.other" }, {}, "adapter.load.subject_scope");
  tryRefuse(
    {
      lineageRef: {
        ...manifest.lineageRef,
        criticVersions: [],
      },
    },
    {},
    "adapter.load.lineage_incomplete",
  );

  return { ok: true, verified, refused };
}

/**
 * Micro-run: apply → mid-turn refuse → TURN_COMPLETE → swap → byte-identical
 * rollback; mismatch/corruption fixtures never mutate active adapter.
 */
export function proveAdapterLoadApplyMicroRun(opts?: {
  onTelemetry?: (e: AdapterLoadTelemetryEvent) => void;
}): {
  ok: true;
  applied: AdapterLoadApplyResult;
  afterRollback: AdapterLoadApplyResult;
  refused: ReadonlyArray<AdapterLoadFailureClass>;
  activeUntouchedAfterCorrupt: string;
} {
  const onTelemetry = (e: AdapterLoadTelemetryEvent) => {
    opts?.onTelemetry?.(e);
  };

  const subjectId = "subj.adapter.apply.prove";
  const deviceId = "dev.adapter.apply.prove";
  const baseModelHash = "ckpt:sha256:applybase0000001";

  const loader = new SlmRuntimeAdapterLoader({
    subjectId,
    deviceId,
    baseModelHash,
    precisionFormat: "int4",
    onTelemetry,
  });

  const blobA = new TextEncoder().encode("adapter-delta-A-bytes");
  const hashA = contentAddressAdapterBlob(blobA);
  const applied = loader.loadAdapter({
    manifest: fixtureManifest({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash: hashA,
    }),
    blobBytes: blobA,
    loadId: "load.A",
  });

  loader.beginTurn("session.1");
  const refused: AdapterLoadFailureClass[] = [];

  const blobB = new TextEncoder().encode("adapter-delta-B-bytes");
  const hashB = contentAddressAdapterBlob(blobB);
  try {
    loader.loadAdapter({
      manifest: fixtureManifest({
        subjectId,
        deviceId,
        baseModelHash,
        contentHash: hashB,
      }),
      blobBytes: blobB,
    });
  } catch (err) {
    if (
      err instanceof AdapterLoadContractError &&
      err.obligation === "adapter.load.mid_turn_refuse"
    ) {
      refused.push("adapter.load.mid_turn_refuse");
    } else {
      throw err;
    }
  }

  // Mid-turn corrupt attempt still refused by pin (active untouched).
  try {
    loader.loadAdapter({
      manifest: fixtureManifest({
        subjectId,
        deviceId,
        baseModelHash,
        contentHash: hashA,
      }),
      blobBytes: new TextEncoder().encode("corrupt"),
    });
  } catch (err) {
    if (
      !(
        err instanceof AdapterLoadContractError &&
        err.obligation === "adapter.load.mid_turn_refuse"
      )
    ) {
      throw err;
    }
  }
  const activeUntouchedAfterCorrupt = loader.activeContentHash ?? "";

  loader.completeTurn("session.1");

  // After TURN_COMPLETE, base mismatch must not apply (active stays A).
  try {
    loader.loadAdapter({
      manifest: fixtureManifest({
        subjectId,
        deviceId,
        baseModelHash: "ckpt:sha256:wrongbase0000001",
        contentHash: hashB,
      }),
      blobBytes: blobB,
    });
  } catch (err) {
    if (
      err instanceof AdapterLoadContractError &&
      err.obligation === "adapter.load.base_mismatch"
    ) {
      refused.push("adapter.load.base_mismatch");
    } else {
      throw err;
    }
  }
  if (loader.activeContentHash !== hashA) {
    throw new Error("base mismatch must not mutate active adapter");
  }

  // Corrupt checksum after unpin — refuse, active stays A.
  try {
    loader.loadAdapter({
      manifest: fixtureManifest({
        subjectId,
        deviceId,
        baseModelHash,
        contentHash: hashB,
      }),
      blobBytes: new TextEncoder().encode("truncated-corrupt"),
    });
  } catch (err) {
    if (
      err instanceof AdapterLoadContractError &&
      err.obligation === "adapter.load.content_hash_mismatch"
    ) {
      refused.push("adapter.load.content_hash_mismatch");
    } else {
      throw err;
    }
  }
  if (loader.activeContentHash !== hashA) {
    throw new Error("corrupt load must not mutate active adapter");
  }

  loader.loadAdapter({
    manifest: fixtureManifest({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash: hashB,
    }),
    blobBytes: blobB,
    loadId: "load.B",
  });

  const afterRollback = loader.rollback();
  if (afterRollback.applied.contentHash !== hashA) {
    throw new Error("rollback must restore prior adapter byte-identically");
  }
  if (!afterRollback.applied.blob.equals(Buffer.from(blobA))) {
    throw new Error("rollback blob must be byte-identical to prior");
  }

  const replay = loader.loadAdapter({
    manifest: fixtureManifest({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash: hashA,
    }),
    blobBytes: blobA,
    loadId: "load.A",
  });
  if (!replay.idempotentReplay) {
    throw new Error("expected idempotent loadId replay");
  }

  try {
    loader.loadAdapter({
      manifest: fixtureManifest({
        subjectId: "subj.other",
        deviceId,
        baseModelHash,
        contentHash: hashB,
      }),
      blobBytes: blobB,
    });
  } catch (err) {
    if (
      err instanceof AdapterLoadContractError &&
      err.obligation === "adapter.load.subject_scope"
    ) {
      refused.push("adapter.load.subject_scope");
    } else {
      throw err;
    }
  }

  return {
    ok: true,
    applied,
    afterRollback,
    refused,
    activeUntouchedAfterCorrupt,
  };
}
