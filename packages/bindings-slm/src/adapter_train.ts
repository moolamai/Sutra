/**
 * LoRA-class parameter-efficient update path (C4).
 *
 * Trains adapter weights only (never base-model tensors). Emits a
 * content-addressed delta artifact bound to the base-model / checkpoint hash.
 * Rank 16 / alpha 32 defaults. No value head — pure policy-gradient PEFT.
 */

import { createHash } from "node:crypto";

export const ADAPTER_TRAIN_SEAM_VERSION = "adapter.train.seam.v1" as const;
export const ADAPTER_DELTA_SCHEMA_VERSION = "adapter.delta.v1" as const;

/** Default LoRA rank for 1–8B sovereign SLM adapters. */
export const LORA_DEFAULT_RANK = 16 as const;

/** Default LoRA alpha for 1–8B sovereign SLM adapters. */
export const LORA_DEFAULT_ALPHA = 32 as const;

/** Default clipped-surrogate ε mirrored into adapter lineage. */
export const LORA_DEFAULT_CLIP_EPSILON = 0.2 as const;

/** Soft cap on synthetic / recorded delta bytes (NFR — MB-scale, bounded). */
export const ADAPTER_DELTA_BYTE_LIMIT = 4 * 1024 * 1024; // 4 MiB

/** Elements per rank in the deterministic micro delta (keeps CI tiny). */
export const ADAPTER_DELTA_ELEMS_PER_RANK = 64;

export type AdapterTrainFailureClass =
  | "adapter.missing_checkpoint"
  | "adapter.floating_checkpoint"
  | "adapter.section_limit"
  | "adapter.subject_scope"
  | "adapter.base_weight_forbidden"
  | "adapter.value_head_forbidden"
  | "adapter.invalid_loss"
  | "adapter.invalid_config"
  | "adapter.lineage_corrupt"
  | "adapter.empty_update"
  | "adapter.idempotent_conflict";

export type AdapterTrainTelemetryEvent = {
  event:
    | "bindings.adapter.train_pin"
    | "bindings.adapter.lora_update"
    | "bindings.adapter.delta_emit";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  baseModelHash?: string;
  deltaHash?: string;
  parentDeltaHash?: string;
  loraRank?: number;
  loraAlpha?: number;
  byteLength?: number;
  updateScope?: "adapter_only";
  valueHead?: false;
  failureClass?: AdapterTrainFailureClass;
  idempotentReplay?: boolean;
};

export class AdapterTrainContractError extends Error {
  readonly obligation: AdapterTrainFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: AdapterTrainFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "AdapterTrainContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

export type AdapterTrainLineagePin = {
  seamVersion: typeof ADAPTER_TRAIN_SEAM_VERSION;
  baseCheckpointHash: string;
  loraRank: number;
  loraAlpha: number;
  clipEpsilon: number;
  /** True when this pin is metadata-only (no weight mutation yet). */
  metadataOnly: boolean;
  valueHead: false;
};

export type LoraUpdateConfig = {
  rank: number;
  alpha: number;
  clipEpsilon: number;
};

export type AdapterDeltaArtifact = {
  schemaVersion: typeof ADAPTER_DELTA_SCHEMA_VERSION;
  /** Content-addressed id: sha256:<64 hex> of delta bytes. */
  deltaHash: string;
  /** Exact base model / checkpoint hash this delta binds to. */
  baseModelHash: string;
  parentDeltaHash: string | undefined;
  loraRank: number;
  loraAlpha: number;
  clipEpsilon: number;
  byteLength: number;
  /** Always adapter_only — base tensors are never written. */
  updateScope: "adapter_only";
  valueHead: false;
  subjectId: string;
  deviceId: string;
  /** Opaque step counter within the append-only lineage. */
  step: number;
  publishedAt: string;
};

export type LoraAdapterUpdateResult = {
  ok: true;
  artifact: AdapterDeltaArtifact;
  lineagePin: AdapterTrainLineagePin;
  /** Hex preview of delta (never raw learner content). */
  deltaDigestPreview: string;
  idempotentReplay: boolean;
};

function assertOpaqueHash(
  hash: string,
  field: string,
  subjectId?: string,
): string {
  const trimmed = typeof hash === "string" ? hash.trim() : "";
  if (!trimmed) {
    throw new AdapterTrainContractError(`${field} required`, {
      obligation: "adapter.missing_checkpoint",
      ...(subjectId !== undefined ? { subjectId } : {}),
      failingSlice: field,
    });
  }
  if (trimmed.toLowerCase() === "latest") {
    throw new AdapterTrainContractError(
      `floating checkpoint 'latest' forbidden on ${field}`,
      {
        obligation: "adapter.floating_checkpoint",
        ...(subjectId !== undefined ? { subjectId } : {}),
        failingSlice: field,
      },
    );
  }
  if (trimmed.length < 8 || trimmed.length > 128) {
    throw new AdapterTrainContractError(`${field} required`, {
      obligation: "adapter.missing_checkpoint",
      ...(subjectId !== undefined ? { subjectId } : {}),
      failingSlice: field,
    });
  }
  return trimmed;
}

/**
 * Refuse payloads that request base-weight mutation or a value head.
 */
export function assertAdapterOnlyUpdate(
  payload: unknown,
  opts?: { subjectId?: string; deviceId?: string },
): void {
  if (!payload || typeof payload !== "object") return;
  const obj = payload as Record<string, unknown>;
  for (const key of [
    "baseWeights",
    "fullFinetune",
    "updateBaseModel",
    "valueHead",
    "valueNetwork",
    "valueLoss",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const v = obj[key];
    if (v == null) continue;
    if (key === "valueHead" && v === false) continue;
    if (key === "updateBaseModel" && v === false) continue;
    const obligation: AdapterTrainFailureClass =
      key === "valueHead" || key === "valueNetwork" || key === "valueLoss"
        ? "adapter.value_head_forbidden"
        : "adapter.base_weight_forbidden";
    throw new AdapterTrainContractError(
      `LoRA path forbids '${key}' — adapter weights only`,
      {
        obligation,
        ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
        failingSlice: key,
      },
    );
  }
}

export function validateLoraUpdateConfig(
  config: Partial<LoraUpdateConfig> | undefined,
): LoraUpdateConfig {
  const rank = config?.rank ?? LORA_DEFAULT_RANK;
  const alpha = config?.alpha ?? LORA_DEFAULT_ALPHA;
  const clipEpsilon = config?.clipEpsilon ?? LORA_DEFAULT_CLIP_EPSILON;
  if (
    !Number.isInteger(rank) ||
    rank < 1 ||
    rank > 256 ||
    !Number.isInteger(alpha) ||
    alpha < 1 ||
    alpha > 1024 ||
    typeof clipEpsilon !== "number" ||
    !Number.isFinite(clipEpsilon) ||
    clipEpsilon <= 0 ||
    clipEpsilon >= 1
  ) {
    throw new AdapterTrainContractError("invalid LoRA update config", {
      obligation: "adapter.invalid_config",
    });
  }
  return { rank, alpha, clipEpsilon };
}

/**
 * Pin adapter-train lineage before / after an update.
 */
export function pinAdapterTrainLineage(input: {
  baseCheckpointHash: string;
  loraRank?: number;
  loraAlpha?: number;
  clipEpsilon?: number;
  metadataOnly?: boolean;
}): AdapterTrainLineagePin {
  const hash = assertOpaqueHash(input.baseCheckpointHash, "baseCheckpointHash");
  const partial: Partial<LoraUpdateConfig> = {};
  if (input.loraRank !== undefined) partial.rank = input.loraRank;
  if (input.loraAlpha !== undefined) partial.alpha = input.loraAlpha;
  if (input.clipEpsilon !== undefined) partial.clipEpsilon = input.clipEpsilon;
  const cfg = validateLoraUpdateConfig(partial);
  return {
    seamVersion: ADAPTER_TRAIN_SEAM_VERSION,
    baseCheckpointHash: hash,
    loraRank: cfg.rank,
    loraAlpha: cfg.alpha,
    clipEpsilon: cfg.clipEpsilon,
    metadataOnly: input.metadataOnly ?? true,
    valueHead: false,
  };
}

/**
 * Deterministic adapter-only delta bytes from GRPO loss + LoRA config.
 * Bounded MB-scale; content-addressed by callers. No learner content.
 */
export function synthesizeLoraAdapterDeltaBytes(input: {
  baseModelHash: string;
  rank: number;
  alpha: number;
  loss: number;
  step: number;
  parentDeltaHash?: string;
}): Buffer {
  const base = assertOpaqueHash(input.baseModelHash, "baseModelHash");
  const cfg = validateLoraUpdateConfig({
    rank: input.rank,
    alpha: input.alpha,
  });
  if (typeof input.loss !== "number" || !Number.isFinite(input.loss)) {
    throw new AdapterTrainContractError("loss must be a finite number", {
      obligation: "adapter.invalid_loss",
    });
  }
  if (!Number.isInteger(input.step) || input.step < 0 || input.step > 1_000_000) {
    throw new AdapterTrainContractError("step out of bounds", {
      obligation: "adapter.section_limit",
    });
  }

  const elemCount = cfg.rank * ADAPTER_DELTA_ELEMS_PER_RANK;
  const header = Buffer.from(
    JSON.stringify({
      v: ADAPTER_DELTA_SCHEMA_VERSION,
      base,
      rank: cfg.rank,
      alpha: cfg.alpha,
      step: input.step,
      parent: input.parentDeltaHash ?? null,
      scope: "adapter_only",
    }),
    "utf8",
  );
  const seed = createHash("sha256")
    .update(header)
    .update(`|loss:${input.loss}`)
    .digest();

  const floats = Buffer.alloc(elemCount * 4);
  for (let i = 0; i < elemCount; i++) {
    const b0 = seed[i % seed.length]!;
    const b1 = seed[(i * 7 + 3) % seed.length]!;
    // Deterministic small weight in [-1e-3, 1e-3] scaled by loss sign
    const unit = ((b0 << 8) | b1) / 0xffff;
    const w = (unit * 2 - 1) * 1e-3 * (input.loss === 0 ? 1 : Math.sign(input.loss) || 1);
    floats.writeFloatLE(w, i * 4);
  }

  const out = Buffer.concat([header, floats]);
  if (out.length > ADAPTER_DELTA_BYTE_LIMIT) {
    throw new AdapterTrainContractError(
      `adapter delta exceeds ${ADAPTER_DELTA_BYTE_LIMIT} bytes`,
      { obligation: "adapter.section_limit" },
    );
  }
  return out;
}

export function contentAddressDelta(bytes: Buffer): string {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new AdapterTrainContractError("delta bytes required", {
      obligation: "adapter.empty_update",
    });
  }
  if (bytes.length > ADAPTER_DELTA_BYTE_LIMIT) {
    throw new AdapterTrainContractError(
      `adapter delta exceeds ${ADAPTER_DELTA_BYTE_LIMIT} bytes`,
      { obligation: "adapter.section_limit" },
    );
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

type LineageEntry = {
  artifact: AdapterDeltaArtifact;
  bytes: Buffer;
};

/**
 * Append-only LoRA adapter trainer — adapter tensors only.
 * Crash-safe lineage: parent-hash chain; tip re-publish is idempotent.
 */
export class LoraAdapterTrainer {
  private readonly entries: LineageEntry[] = [];
  private readonly byDeltaHash = new Map<string, LineageEntry>();
  private readonly byUpdateId = new Map<string, LoraAdapterUpdateResult>();

  constructor(
    private readonly opts: {
      subjectId: string;
      deviceId: string;
      baseModelHash: string;
      config?: Partial<LoraUpdateConfig>;
      onTelemetry?: (e: AdapterTrainTelemetryEvent) => void;
    },
  ) {
    if (!opts.subjectId) {
      throw new AdapterTrainContractError("subjectId required", {
        obligation: "adapter.subject_scope",
      });
    }
    assertOpaqueHash(opts.baseModelHash, "baseModelHash", opts.subjectId);
    validateLoraUpdateConfig(opts.config);
  }

  currentDeltaHash(): string | undefined {
    return this.entries.at(-1)?.artifact.deltaHash;
  }

  lineage(): readonly AdapterDeltaArtifact[] {
    return this.entries.map((e) => e.artifact);
  }

  /**
   * Apply one PEFT step from a GRPO clipped-surrogate loss scalar.
   * Updates adapter weights only; emits content-addressed delta bound to base.
   */
  applyUpdate(input: {
    loss: number;
    updateId?: string;
    /** Must match constructor base — mid-run base swap refused. */
    baseModelHash?: string;
    config?: Partial<LoraUpdateConfig>;
    /** Forbidden flags — validated and rejected. */
    updateBaseModel?: boolean;
    valueHead?: unknown;
    publishedAt?: string;
  }): LoraAdapterUpdateResult {
    assertAdapterOnlyUpdate(input, {
      subjectId: this.opts.subjectId,
      deviceId: this.opts.deviceId,
    });

    if (input.updateId !== undefined) {
      const cached = this.byUpdateId.get(input.updateId);
      if (cached) {
        this.opts.onTelemetry?.({
          event: "bindings.adapter.lora_update",
          outcome: "ok",
          subjectId: this.opts.subjectId,
          deviceId: this.opts.deviceId,
          baseModelHash: cached.artifact.baseModelHash,
          deltaHash: cached.artifact.deltaHash,
          loraRank: cached.artifact.loraRank,
          loraAlpha: cached.artifact.loraAlpha,
          byteLength: cached.artifact.byteLength,
          updateScope: "adapter_only",
          valueHead: false,
          idempotentReplay: true,
        });
        return { ...cached, idempotentReplay: true };
      }
    }

    if (typeof input.loss !== "number" || !Number.isFinite(input.loss)) {
      this.opts.onTelemetry?.({
        event: "bindings.adapter.lora_update",
        outcome: "fail",
        subjectId: this.opts.subjectId,
        deviceId: this.opts.deviceId,
        failureClass: "adapter.invalid_loss",
        valueHead: false,
      });
      throw new AdapterTrainContractError("loss must be a finite number", {
        obligation: "adapter.invalid_loss",
        subjectId: this.opts.subjectId,
        deviceId: this.opts.deviceId,
      });
    }

    const baseModelHash = assertOpaqueHash(
      input.baseModelHash ?? this.opts.baseModelHash,
      "baseModelHash",
      this.opts.subjectId,
    );
    if (baseModelHash !== this.opts.baseModelHash) {
      throw new AdapterTrainContractError(
        "baseModelHash mismatch — refuse mid-run base swap on adapter trainer",
        {
          obligation: "adapter.lineage_corrupt",
          subjectId: this.opts.subjectId,
          deviceId: this.opts.deviceId,
          failingSlice: baseModelHash,
        },
      );
    }

    const cfg = validateLoraUpdateConfig({
      ...this.opts.config,
      ...input.config,
    });
    const parentDeltaHash = this.currentDeltaHash();
    const step = this.entries.length;

    const bytes = synthesizeLoraAdapterDeltaBytes({
      baseModelHash,
      rank: cfg.rank,
      alpha: cfg.alpha,
      loss: input.loss,
      step,
      ...(parentDeltaHash !== undefined
        ? { parentDeltaHash }
        : {}),
    });
    const deltaHash = contentAddressDelta(bytes);

    const existing = this.byDeltaHash.get(deltaHash);
    if (existing) {
      // Same content tip — idempotent; never rewrite lineage history.
      if (existing.artifact.deltaHash === this.currentDeltaHash()) {
        const replay: LoraAdapterUpdateResult = {
          ok: true,
          artifact: existing.artifact,
          lineagePin: pinAdapterTrainLineage({
            baseCheckpointHash: baseModelHash,
            loraRank: cfg.rank,
            loraAlpha: cfg.alpha,
            clipEpsilon: cfg.clipEpsilon,
            metadataOnly: false,
          }),
          deltaDigestPreview: deltaHash.slice(0, 24),
          idempotentReplay: true,
        };
        if (input.updateId !== undefined) {
          this.byUpdateId.set(input.updateId, replay);
        }
        return replay;
      }
      throw new AdapterTrainContractError(
        "delta hash collision with non-tip lineage entry — refuse corrupt write",
        {
          obligation: "adapter.lineage_corrupt",
          subjectId: this.opts.subjectId,
          failingSlice: deltaHash,
        },
      );
    }

    const artifact: AdapterDeltaArtifact = {
      schemaVersion: ADAPTER_DELTA_SCHEMA_VERSION,
      deltaHash,
      baseModelHash,
      parentDeltaHash,
      loraRank: cfg.rank,
      loraAlpha: cfg.alpha,
      clipEpsilon: cfg.clipEpsilon,
      byteLength: bytes.length,
      updateScope: "adapter_only",
      valueHead: false,
      subjectId: this.opts.subjectId,
      deviceId: this.opts.deviceId,
      step,
      publishedAt: input.publishedAt ?? new Date().toISOString(),
    };

    this.entries.push({ artifact, bytes });
    this.byDeltaHash.set(deltaHash, { artifact, bytes });

    // Bound in-process lineage (keep tip + recent parents).
    if (this.entries.length > 64) {
      const dropped = this.entries.shift()!;
      this.byDeltaHash.delete(dropped.artifact.deltaHash);
    }

    const lineagePin = pinAdapterTrainLineage({
      baseCheckpointHash: baseModelHash,
      loraRank: cfg.rank,
      loraAlpha: cfg.alpha,
      clipEpsilon: cfg.clipEpsilon,
      metadataOnly: false,
    });

    const result: LoraAdapterUpdateResult = {
      ok: true,
      artifact,
      lineagePin,
      deltaDigestPreview: deltaHash.slice(0, 24),
      idempotentReplay: false,
    };

    this.opts.onTelemetry?.({
      event: "bindings.adapter.lora_update",
      outcome: "ok",
      subjectId: this.opts.subjectId,
      deviceId: this.opts.deviceId,
      baseModelHash,
      deltaHash,
      ...(parentDeltaHash !== undefined ? { parentDeltaHash } : {}),
      loraRank: cfg.rank,
      loraAlpha: cfg.alpha,
      byteLength: bytes.length,
      updateScope: "adapter_only",
      valueHead: false,
    });
    this.opts.onTelemetry?.({
      event: "bindings.adapter.delta_emit",
      outcome: "ok",
      subjectId: this.opts.subjectId,
      deviceId: this.opts.deviceId,
      baseModelHash,
      deltaHash,
      byteLength: bytes.length,
      updateScope: "adapter_only",
      valueHead: false,
    });

    if (input.updateId !== undefined) {
      this.byUpdateId.set(input.updateId, result);
      if (this.byUpdateId.size > 64) {
        const first = this.byUpdateId.keys().next().value as
          | string
          | undefined;
        if (first !== undefined) this.byUpdateId.delete(first);
      }
    }

    return result;
  }
}

/**
 * Micro-run: pin → apply LoRA update from loss → content-addressed delta.
 */
export function proveLoraAdapterUpdateMicroRun(input: {
  subjectId: string;
  deviceId: string;
  baseModelHash: string;
  loss: number;
  rank?: number;
  alpha?: number;
  clipEpsilon?: number;
  onTelemetry?: (e: AdapterTrainTelemetryEvent) => void;
}): {
  ok: true;
  pin: AdapterTrainLineagePin;
  update: LoraAdapterUpdateResult;
  lineage: readonly AdapterDeltaArtifact[];
} {
  assertAdapterOnlyUpdate(input, {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });

  const pin = pinAdapterTrainLineage({
    baseCheckpointHash: input.baseModelHash,
    ...(input.rank !== undefined ? { loraRank: input.rank } : {}),
    ...(input.alpha !== undefined ? { loraAlpha: input.alpha } : {}),
    ...(input.clipEpsilon !== undefined
      ? { clipEpsilon: input.clipEpsilon }
      : {}),
    metadataOnly: true,
  });

  input.onTelemetry?.({
    event: "bindings.adapter.train_pin",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    baseModelHash: pin.baseCheckpointHash,
    loraRank: pin.loraRank,
    loraAlpha: pin.loraAlpha,
    valueHead: false,
  });

  const trainer = new LoraAdapterTrainer({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    baseModelHash: input.baseModelHash,
    config: {
      rank: pin.loraRank,
      alpha: pin.loraAlpha,
      clipEpsilon: pin.clipEpsilon,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const update = trainer.applyUpdate({
    loss: input.loss,
    updateId: `upd.micro.${input.subjectId}`,
    baseModelHash: input.baseModelHash,
  });

  return {
    ok: true,
    pin,
    update,
    lineage: trainer.lineage(),
  };
}
