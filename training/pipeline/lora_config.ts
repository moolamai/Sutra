/**
 * LoRA-class PEFT config for GRPO trainer (C4).
 * Defaults: rank 16 / alpha 32 / clip ε=0.2. Weight updates via bindings-slm
 * adapter_train (adapter-only, content-addressed deltas).
 */
export const LORA_CONFIG_SCHEMA_VERSION = "lora.config.v1" as const;

/** Mirrors GRPO clipped-surrogate ε for lineage / hyperparameter records. */
export const LORA_LINEAGE_CLIP_EPSILON = 0.2 as const;

/** Default LoRA rank for 1–8B sovereign SLM adapters. */
export const LORA_DEFAULT_RANK = 16 as const;

/** Default LoRA alpha for 1–8B sovereign SLM adapters. */
export const LORA_DEFAULT_ALPHA = 32 as const;

export type LoraConfig = {
  schemaVersion: typeof LORA_CONFIG_SCHEMA_VERSION;
  rank: number;
  alpha: number;
  /** Policy clip ε recorded with the run — not a value-head coefficient. */
  clipEpsilon: number;
  /** Explicit — PEFT updates adapter tensors only. */
  updateScope: "adapter_only";
};

export function defaultLoraConfig(): LoraConfig {
  return {
    schemaVersion: LORA_CONFIG_SCHEMA_VERSION,
    rank: LORA_DEFAULT_RANK,
    alpha: LORA_DEFAULT_ALPHA,
    clipEpsilon: LORA_LINEAGE_CLIP_EPSILON,
    updateScope: "adapter_only",
  };
}

export function assertLoraAdapterOnlyConfig(config: LoraConfig): void {
  if (config.updateScope !== "adapter_only") {
    throw new Error(
      "LoRA config must set updateScope=adapter_only — base weights are frozen",
    );
  }
  if (config.rank !== LORA_DEFAULT_RANK && (config.rank < 1 || config.rank > 256)) {
    throw new Error("LoRA rank out of bounds");
  }
}
