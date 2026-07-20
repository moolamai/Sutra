/**
 * Prompt assembly — static / dynamic block splitter and content-addressed
 * bindings state hash for state-hash caching.
 *
 * Static block: profile charter + protocol instructions (+ prompt-affecting
 * profile meta). Identical bytes when those inputs are unchanged across turns.
 * Dynamic block: per-turn utterance, memories, and retrieval passages.
 *
 * Cache key: SHA-256 over canonical JSON of subject-scoped, prompt-affecting
 * bindings state (profile + protocol + optional binding field projections).
 * Dynamic turn content is never part of the hash. Digest is restart-stable
 * (no salts / clocks).
 *
 * In-memory static-block cache ({@link InMemoryStaticPromptCache}): keyed by
 * bindings hash; lookup before assembly; store on miss. Advisory — miss falls
 * back to full assembly. LRU + optional TTL; never serves expired/stale bytes.
 *
 * Metering wire ({@link meterCachedStaticAssembly}): on hit, record
 * `cachedInputTokens` from the static-block token estimate; on miss, count
 * those tokens as fresh. Cached vs fresh stay distinguishable on TurnMeter.
 *
 * Sovereignty: structured telemetry never echoes charter, utterance, memory,
 * or passage text — only lengths / counts, hash digests, and subject scope.
 */

import { createHash } from "node:crypto";
import { sortKeysDeep } from "@moolam/sync-protocol";
import {
  TurnMeter,
  assertTurnMeterSubjectScope,
  type RecordTurnTokensResult,
  type TurnMeterFailureClass,
} from "./metering.js";

/** Soft cap on memory items assembled into the dynamic block. */
export const PROMPT_DYNAMIC_MEMORY_LIMIT = 64;

/** Soft cap on retrieval passages in the dynamic block. */
export const PROMPT_DYNAMIC_PASSAGE_LIMIT = 64;

/** Soft cap on UTF-16 code units per text section (charter / utterance / item). */
export const PROMPT_SECTION_CHAR_LIMIT = 32_768;

/** Soft cap on optional prompt-affecting binding field keys in the hash input. */
export const PROMPT_BINDINGS_FIELD_KEY_LIMIT = 64;

/** Algorithm id embedded in telemetry / accepted results (restart-stable). */
export const PROMPT_BINDINGS_HASH_ALGORITHM = "sha256" as const;

/** Default max static-block entries per subject cache (soft NFR bound). */
export const PROMPT_STATIC_CACHE_ENTRY_LIMIT_DEFAULT = 64;

/** Hard ceiling on static-block entries — never exceed this retention. */
export const PROMPT_STATIC_CACHE_ENTRY_LIMIT_MAX = 256;

/**
 * Default TTL for static entries (ms). `0` disables TTL — LRU-only eviction.
 * Expired entries miss; they are never served as a secondary stale tier.
 */
export const PROMPT_STATIC_CACHE_TTL_MS_DEFAULT = 0;

/**
 * Deterministic char→token estimate for static prefix metering (v1).
 * Hosts may override the computed count via {@link meterCachedStaticAssembly}
 * when a provider reports exact cached tokens.
 */
export const PROMPT_STATIC_CHARS_PER_TOKEN_ESTIMATE = 4;

/** Golden corpus for prompt-assembly determinism (byte-stable static + hash). */
export const PROMPT_ASSEMBLY_DETERMINISM_FIXTURE_RELPATH =
  "fixtures/prompt-assembly-determinism" as const;

const BINDINGS_HASH_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Block boundary markers — byte-stable, never localized.
 *
 * Layout (exact delimiting strings hosts and cache layers must treat as
 * boundaries):
 *
 * ```
 * <<<SUTRA_PROMPT_STATIC>>>
 * ### charter
 * <charter text>
 * ### protocol
 * version: <protocolVersion>
 * <protocol instructions>
 * ### profile
 * <canonical JSON: domainId, languages[], refusals[]>
 * <<<END_SUTRA_PROMPT_STATIC>>>
 * <<<SUTRA_PROMPT_DYNAMIC>>>
 * ### utterance
 * <current-turn utterance — always present, may be empty for static-only>
 * ### memories
 * <0..N memory lines, host order, bounded>
 * ### passages
 * <0..N passage lines, host order, bounded>
 * <<<END_SUTRA_PROMPT_DYNAMIC>>>
 * ```
 */
export const PROMPT_BLOCK_MARKERS = Object.freeze({
  staticOpen: "<<<SUTRA_PROMPT_STATIC>>>",
  staticClose: "<<<END_SUTRA_PROMPT_STATIC>>>",
  dynamicOpen: "<<<SUTRA_PROMPT_DYNAMIC>>>",
  dynamicClose: "<<<END_SUTRA_PROMPT_DYNAMIC>>>",
  charter: "### charter",
  protocol: "### protocol",
  profile: "### profile",
  utterance: "### utterance",
  memories: "### memories",
  passages: "### passages",
} as const);

export type PromptCacheFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "invalid_profile"
  | "invalid_protocol"
  | "invalid_turn_context"
  | "invalid_bindings"
  | "invalid_cache_key"
  | "section_limit"
  | "cache_limit";

/** Miss reason markers — observability only; static bytes are never stale-served. */
export type PromptCacheMissMarker =
  | "cold"
  | "hash_changed"
  | "ttl_expired"
  | "evicted"
  | "explicit_invalidate";

/**
 * Prompt-affecting profile fields (mirrors cognitive-core AgentProfile).
 * Refusals and languages are part of the static block — they change model
 * framing when mutated.
 */
export type PromptProfile = {
  domainId: string;
  charter: string;
  refusals: readonly string[];
  languages: readonly string[];
};

/** Protocol instructions hashed/assembled with the static prefix. */
export type PromptProtocol = {
  protocolVersion: string;
  instructions: string;
};

/**
 * Serializable projection of CognitiveBindings + profile fields that affect
 * the static model prompt. Hosts map live bindings into this shape before
 * hashing — interface objects themselves are not hashable.
 *
 * Always includes profile + protocol. `bindingFields` carries extra
 * prompt-affecting scalars/arrays (e.g. model id, knowledge pack ids).
 * Never include utterance, memories, or passages.
 */
export type PromptBindingsState = {
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  profile: PromptProfile;
  protocol: PromptProtocol;
  bindingFields?: Readonly<Record<string, unknown>>;
};

export type PromptMemoryItem = {
  /** Opaque id for ordering / dedup — never learner body alone. */
  id?: string;
  text: string;
  kind?: string;
};

export type PromptPassageItem = {
  id?: string;
  text: string;
  sourceId?: string;
};

/**
 * Per-turn dynamic inputs. Utterance and retrieval slots are always assembled
 * (empty arrays / empty utterance → valid static-only turn).
 */
export type PromptTurnContext = {
  subjectId: string;
  sessionId?: string;
  deviceId?: string;
  /** Current-turn subject utterance (may be "" for static-only). */
  utterance: string;
  memories?: readonly PromptMemoryItem[];
  passages?: readonly PromptPassageItem[];
};

export type AssembledPromptBlock = {
  kind: "static" | "dynamic";
  text: string;
  byteLength: number;
  charLength: number;
  subjectId?: string;
  deviceId?: string;
  sessionId?: string;
};

export type AssembleStaticAccepted = {
  ok: true;
  block: AssembledPromptBlock;
  domainId: string;
  protocolVersion: string;
};

export type AssembleDynamicAccepted = {
  ok: true;
  block: AssembledPromptBlock;
  memoryCount: number;
  passageCount: number;
  utteranceCharLength: number;
};

export type AssembleRejected = {
  ok: false;
  failureClass: PromptCacheFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type AssembleStaticResult = AssembleStaticAccepted | AssembleRejected;
export type AssembleDynamicResult = AssembleDynamicAccepted | AssembleRejected;

export type AssembledPrompt = {
  staticBlock: AssembledPromptBlock;
  dynamicBlock: AssembledPromptBlock;
  /** Static then dynamic joined with a single newline (wire-ready). */
  combined: string;
};

export type AssemblePromptAccepted = {
  ok: true;
  prompt: AssembledPrompt;
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
};

export type AssemblePromptResult = AssemblePromptAccepted | AssembleRejected;

export type HashBindingsAccepted = {
  ok: true;
  /** Full SHA-256 hex digest (64 lowercase hex chars). */
  hash: string;
  algorithm: typeof PROMPT_BINDINGS_HASH_ALGORITHM;
  /** UTF-8 byte length of the canonical JSON hashed (never the JSON itself). */
  canonicalByteLength: number;
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  domainId: string;
  protocolVersion: string;
  bindingFieldCount: number;
};

export type HashBindingsResult = HashBindingsAccepted | AssembleRejected;

export type PromptCacheTelemetryEvent = {
  event: "runtime.harness.prompt_cache";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  sessionId?: string;
  action?:
    | "assemble_static"
    | "assemble_dynamic"
    | "assemble_prompt"
    | "hash_bindings"
    | "cache_lookup"
    | "cache_store"
    | "cache_invalidate"
    | "cache_get_or_assemble"
    | "meter_cache_assembly";
  staticCharLength?: number;
  dynamicCharLength?: number;
  memoryCount?: number;
  passageCount?: number;
  utteranceCharLength?: number;
  domainId?: string;
  protocolVersion?: string;
  /** Present on successful hash_bindings — digest only, never charter body. */
  bindingsHash?: string;
  bindingsHashAlgorithm?: typeof PROMPT_BINDINGS_HASH_ALGORITHM;
  canonicalByteLength?: number;
  bindingFieldCount?: number;
  /** Cache lookup / getOrAssemble / meter wire — hit/miss without charter body. */
  cacheHit?: boolean;
  /**
   * Snake_case alias of {@link cacheHit} for hosts that key on `cache_hit`
   * (metering wire + hit-rate dashboards). Same boolean; never content.
   */
  cache_hit?: boolean;
  /** Bytes of static block reused on hit (0 on miss). */
  bytesSaved?: number;
  entryCount?: number;
  missMarker?: PromptCacheMissMarker;
  /** hit/lookups after ≥2 lookups; null until second lookup (first turn always miss). */
  hitRate?: number | null;
  /** Metered cached vs fresh deltas from {@link meterCachedStaticAssembly}. */
  cachedInputTokens?: number;
  freshInputTokens?: number;
  failureClass?: PromptCacheFailureClass | TurnMeterFailureClass;
};

export type PromptAssemblerOptions = {
  onTelemetry?: (event: PromptCacheTelemetryEvent) => void;
  memoryLimit?: number;
  passageLimit?: number;
  sectionCharLimit?: number;
  bindingFieldKeyLimit?: number;
};

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Canonical JSON for profile meta inside the static block.
 * Key order is sorted — no hash flap from object insertion order.
 */
export function canonicalizeProfileMetaJson(profile: {
  domainId: string;
  languages: readonly string[];
  refusals: readonly string[];
}): string {
  const payload = {
    domainId: profile.domainId,
    languages: [...profile.languages].map((l) => String(l)).sort(),
    refusals: [...profile.refusals].map((r) => String(r)).sort(),
  };
  return `${JSON.stringify(sortKeysDeep(payload))}`;
}

function normalizeBindingFields(
  fields: Readonly<Record<string, unknown>> | undefined,
  keyLimit: number,
):
  | { ok: true; fields: Record<string, unknown>; count: number }
  | { ok: false; detail: string } {
  if (fields === undefined) {
    return { ok: true, fields: {}, count: 0 };
  }
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return { ok: false, detail: "bindingFields must be a plain object" };
  }
  const keys = Object.keys(fields);
  if (keys.length > keyLimit) {
    return {
      ok: false,
      detail: `bindingFields exceed key limit ${keyLimit}`,
    };
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" && value.length > PROMPT_SECTION_CHAR_LIMIT) {
      return {
        ok: false,
        detail: `bindingFields.${key} exceeds ${PROMPT_SECTION_CHAR_LIMIT} characters`,
      };
    }
    out[key] = value;
  }
  return { ok: true, fields: out, count: keys.length };
}

/**
 * Canonical JSON for the content-addressed bindings cache key.
 * Sorts object keys and array order for languages/refusals — no hash flap.
 * Includes subjectId so digests are not reusable across subjects.
 */
export function canonicalizeBindingsStateJson(state: {
  subjectId: string;
  profile: PromptProfile;
  protocol: PromptProtocol;
  bindingFields?: Readonly<Record<string, unknown>>;
}): string {
  const payload = {
    subjectId: state.subjectId,
    profile: {
      domainId: state.profile.domainId,
      charter: state.profile.charter,
      languages: [...state.profile.languages].map((l) => String(l)).sort(),
      refusals: [...state.profile.refusals].map((r) => String(r)).sort(),
    },
    protocol: {
      protocolVersion: state.protocol.protocolVersion,
      instructions: state.protocol.instructions,
    },
    bindingFields: state.bindingFields ?? {},
  };
  return `${JSON.stringify(sortKeysDeep(payload))}`;
}

/**
 * Content-addressed SHA-256 over canonical bindings state + profile.
 * Stable across process restarts for identical inputs.
 */
export function hashBindingsState(
  state: PromptBindingsState,
  opts?: PromptAssemblerOptions,
): HashBindingsResult {
  const keyLimit = opts?.bindingFieldKeyLimit ?? PROMPT_BINDINGS_FIELD_KEY_LIMIT;
  const sectionLimit = opts?.sectionCharLimit ?? PROMPT_SECTION_CHAR_LIMIT;

  const subjectId = trimStr(state?.subjectId);
  if (!subjectId) {
    return rejectAssemble(
      "missing_subject",
      null,
      "bindings state subjectId required",
      opts,
      "hash_bindings",
      state,
    );
  }

  const domainId = trimStr(state.profile?.domainId);
  const charter =
    typeof state.profile?.charter === "string" ? state.profile.charter : "";
  const protocolVersion = trimStr(state.protocol?.protocolVersion);
  const instructions =
    typeof state.protocol?.instructions === "string"
      ? state.protocol.instructions
      : "";

  if (!domainId) {
    return rejectAssemble(
      "invalid_profile",
      subjectId,
      "profile.domainId required",
      opts,
      "hash_bindings",
      state,
    );
  }
  if (
    !Array.isArray(state.profile?.refusals) ||
    !Array.isArray(state.profile?.languages)
  ) {
    return rejectAssemble(
      "invalid_profile",
      subjectId,
      "profile.refusals and profile.languages must be arrays",
      opts,
      "hash_bindings",
      state,
    );
  }
  if (!protocolVersion) {
    return rejectAssemble(
      "invalid_protocol",
      subjectId,
      "protocol.protocolVersion required",
      opts,
      "hash_bindings",
      state,
    );
  }
  if (charter.length > sectionLimit || instructions.length > sectionLimit) {
    return rejectAssemble(
      "section_limit",
      subjectId,
      `hash input section exceeds ${sectionLimit} characters`,
      opts,
      "hash_bindings",
      state,
    );
  }

  const normalized = normalizeBindingFields(state.bindingFields, keyLimit);
  if (!normalized.ok) {
    const failureClass: PromptCacheFailureClass =
      normalized.detail.includes("exceed") &&
      normalized.detail.includes("key limit")
        ? "section_limit"
        : normalized.detail.includes("exceeds")
          ? "section_limit"
          : "invalid_bindings";
    return rejectAssemble(
      failureClass,
      subjectId,
      normalized.detail,
      opts,
      "hash_bindings",
      state,
    );
  }

  const profile: PromptProfile = {
    domainId,
    charter,
    refusals: state.profile.refusals,
    languages: state.profile.languages,
  };
  const protocol: PromptProtocol = {
    protocolVersion,
    instructions,
  };

  let canonical: string;
  try {
    canonical = canonicalizeBindingsStateJson({
      subjectId,
      profile,
      protocol,
      bindingFields: normalized.fields,
    });
  } catch {
    return rejectAssemble(
      "invalid_bindings",
      subjectId,
      "bindings state is not JSON-serializable",
      opts,
      "hash_bindings",
      state,
    );
  }

  const hash = createHash(PROMPT_BINDINGS_HASH_ALGORITHM)
    .update(canonical, "utf8")
    .digest("hex");
  const canonicalByteLength = utf8ByteLength(canonical);

  opts?.onTelemetry?.({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    subjectId,
    ...(state.deviceId !== undefined ? { deviceId: state.deviceId } : {}),
    ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
    action: "hash_bindings",
    bindingsHash: hash,
    bindingsHashAlgorithm: PROMPT_BINDINGS_HASH_ALGORITHM,
    canonicalByteLength,
    bindingFieldCount: normalized.count,
    domainId,
    protocolVersion,
  });

  return {
    ok: true,
    hash,
    algorithm: PROMPT_BINDINGS_HASH_ALGORITHM,
    canonicalByteLength,
    subjectId,
    ...(state.deviceId !== undefined ? { deviceId: state.deviceId } : {}),
    ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
    domainId,
    protocolVersion,
    bindingFieldCount: normalized.count,
  };
}

/**
 * Assemble the static prompt prefix (charter + protocol + profile meta).
 * Pure over inputs — identical bytes when bindings/profile/protocol unchanged.
 */
export function assembleStatic(
  profile: PromptProfile,
  protocol: PromptProtocol,
  opts?: PromptAssemblerOptions,
): AssembleStaticResult {
  const sectionLimit = opts?.sectionCharLimit ?? PROMPT_SECTION_CHAR_LIMIT;
  const domainId = trimStr(profile?.domainId);
  const charter = typeof profile?.charter === "string" ? profile.charter : "";
  const protocolVersion = trimStr(protocol?.protocolVersion);
  const instructions =
    typeof protocol?.instructions === "string" ? protocol.instructions : "";

  if (!domainId) {
    return rejectAssemble(
      "invalid_profile",
      null,
      "profile.domainId required",
      opts,
      "assemble_static",
    );
  }
  if (!Array.isArray(profile.refusals) || !Array.isArray(profile.languages)) {
    return rejectAssemble(
      "invalid_profile",
      null,
      "profile.refusals and profile.languages must be arrays",
      opts,
      "assemble_static",
    );
  }
  if (!protocolVersion) {
    return rejectAssemble(
      "invalid_protocol",
      null,
      "protocol.protocolVersion required",
      opts,
      "assemble_static",
    );
  }
  if (charter.length > sectionLimit || instructions.length > sectionLimit) {
    return rejectAssemble(
      "section_limit",
      null,
      `static section exceeds ${sectionLimit} characters`,
      opts,
      "assemble_static",
    );
  }

  const profileJson = canonicalizeProfileMetaJson({
    domainId,
    languages: profile.languages,
    refusals: profile.refusals,
  });

  const text = [
    PROMPT_BLOCK_MARKERS.staticOpen,
    PROMPT_BLOCK_MARKERS.charter,
    charter,
    PROMPT_BLOCK_MARKERS.protocol,
    `version: ${protocolVersion}`,
    instructions,
    PROMPT_BLOCK_MARKERS.profile,
    profileJson,
    PROMPT_BLOCK_MARKERS.staticClose,
  ].join("\n");

  const block: AssembledPromptBlock = {
    kind: "static",
    text,
    byteLength: utf8ByteLength(text),
    charLength: text.length,
  };

  opts?.onTelemetry?.({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    subjectId: null,
    action: "assemble_static",
    staticCharLength: block.charLength,
    domainId,
    protocolVersion,
  });

  return { ok: true, block, domainId, protocolVersion };
}

/**
 * Assemble the dynamic per-turn block.
 * Always emits utterance / memories / passages sections (may be empty).
 */
export function assembleDynamic(
  turnContext: PromptTurnContext,
  opts?: PromptAssemblerOptions,
): AssembleDynamicResult {
  const sectionLimit = opts?.sectionCharLimit ?? PROMPT_SECTION_CHAR_LIMIT;
  const memoryLimit = opts?.memoryLimit ?? PROMPT_DYNAMIC_MEMORY_LIMIT;
  const passageLimit = opts?.passageLimit ?? PROMPT_DYNAMIC_PASSAGE_LIMIT;

  const subjectId = trimStr(turnContext?.subjectId);
  if (!subjectId) {
    return rejectAssemble(
      "missing_subject",
      null,
      "turnContext.subjectId required",
      opts,
      "assemble_dynamic",
      turnContext,
    );
  }

  if (typeof turnContext.utterance !== "string") {
    return rejectAssemble(
      "invalid_turn_context",
      subjectId,
      "turnContext.utterance must be a string",
      opts,
      "assemble_dynamic",
      turnContext,
    );
  }

  const utterance = turnContext.utterance;
  if (utterance.length > sectionLimit) {
    return rejectAssemble(
      "section_limit",
      subjectId,
      `utterance exceeds ${sectionLimit} characters`,
      opts,
      "assemble_dynamic",
      turnContext,
    );
  }

  const memoriesIn = Array.isArray(turnContext.memories)
    ? turnContext.memories
    : [];
  const passagesIn = Array.isArray(turnContext.passages)
    ? turnContext.passages
    : [];

  if (memoriesIn.length > memoryLimit) {
    return rejectAssemble(
      "section_limit",
      subjectId,
      `memories exceed limit ${memoryLimit}`,
      opts,
      "assemble_dynamic",
      turnContext,
    );
  }
  if (passagesIn.length > passageLimit) {
    return rejectAssemble(
      "section_limit",
      subjectId,
      `passages exceed limit ${passageLimit}`,
      opts,
      "assemble_dynamic",
      turnContext,
    );
  }

  const memoryLines: string[] = [];
  for (let i = 0; i < memoriesIn.length; i += 1) {
    const item = memoriesIn[i]!;
    if (typeof item?.text !== "string") {
      return rejectAssemble(
        "invalid_turn_context",
        subjectId,
        `memories[${i}].text must be a string`,
        opts,
        "assemble_dynamic",
        turnContext,
      );
    }
    if (item.text.length > sectionLimit) {
      return rejectAssemble(
        "section_limit",
        subjectId,
        `memories[${i}] exceeds ${sectionLimit} characters`,
        opts,
        "assemble_dynamic",
        turnContext,
      );
    }
    const id = trimStr(item.id) || `m${i}`;
    const kind = trimStr(item.kind);
    memoryLines.push(
      kind ? `[${id}|${kind}] ${item.text}` : `[${id}] ${item.text}`,
    );
  }

  const passageLines: string[] = [];
  for (let i = 0; i < passagesIn.length; i += 1) {
    const item = passagesIn[i]!;
    if (typeof item?.text !== "string") {
      return rejectAssemble(
        "invalid_turn_context",
        subjectId,
        `passages[${i}].text must be a string`,
        opts,
        "assemble_dynamic",
        turnContext,
      );
    }
    if (item.text.length > sectionLimit) {
      return rejectAssemble(
        "section_limit",
        subjectId,
        `passages[${i}] exceeds ${sectionLimit} characters`,
        opts,
        "assemble_dynamic",
        turnContext,
      );
    }
    const id = trimStr(item.id) || `p${i}`;
    const source = trimStr(item.sourceId);
    passageLines.push(
      source ? `[${id}|${source}] ${item.text}` : `[${id}] ${item.text}`,
    );
  }

  const text = [
    PROMPT_BLOCK_MARKERS.dynamicOpen,
    PROMPT_BLOCK_MARKERS.utterance,
    utterance,
    PROMPT_BLOCK_MARKERS.memories,
    ...memoryLines,
    PROMPT_BLOCK_MARKERS.passages,
    ...passageLines,
    PROMPT_BLOCK_MARKERS.dynamicClose,
  ].join("\n");

  const block: AssembledPromptBlock = {
    kind: "dynamic",
    text,
    byteLength: utf8ByteLength(text),
    charLength: text.length,
    subjectId,
    ...(turnContext.deviceId !== undefined
      ? { deviceId: turnContext.deviceId }
      : {}),
    ...(turnContext.sessionId !== undefined
      ? { sessionId: turnContext.sessionId }
      : {}),
  };

  opts?.onTelemetry?.({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    subjectId,
    ...(turnContext.deviceId !== undefined
      ? { deviceId: turnContext.deviceId }
      : {}),
    ...(turnContext.sessionId !== undefined
      ? { sessionId: turnContext.sessionId }
      : {}),
    action: "assemble_dynamic",
    dynamicCharLength: block.charLength,
    memoryCount: memoryLines.length,
    passageCount: passageLines.length,
    utteranceCharLength: utterance.length,
  });

  return {
    ok: true,
    block,
    memoryCount: memoryLines.length,
    passageCount: passageLines.length,
    utteranceCharLength: utterance.length,
  };
}

/**
 * Assemble both blocks for a turn. Static precedes dynamic.
 * Dynamic subject scope is authoritative for the combined result.
 */
export function assemblePrompt(input: {
  profile: PromptProfile;
  protocol: PromptProtocol;
  turnContext: PromptTurnContext;
  options?: PromptAssemblerOptions;
}): AssemblePromptResult {
  const opts = input.options;
  const staticResult = assembleStatic(input.profile, input.protocol, opts);
  if (!staticResult.ok) return staticResult;

  const dynamicResult = assembleDynamic(input.turnContext, opts);
  if (!dynamicResult.ok) return dynamicResult;

  const combined = `${staticResult.block.text}\n${dynamicResult.block.text}`;
  opts?.onTelemetry?.({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    subjectId: dynamicResult.block.subjectId ?? null,
    ...(dynamicResult.block.deviceId !== undefined
      ? { deviceId: dynamicResult.block.deviceId }
      : {}),
    ...(dynamicResult.block.sessionId !== undefined
      ? { sessionId: dynamicResult.block.sessionId }
      : {}),
    action: "assemble_prompt",
    staticCharLength: staticResult.block.charLength,
    dynamicCharLength: dynamicResult.block.charLength,
    memoryCount: dynamicResult.memoryCount,
    passageCount: dynamicResult.passageCount,
    utteranceCharLength: dynamicResult.utteranceCharLength,
    domainId: staticResult.domainId,
    protocolVersion: staticResult.protocolVersion,
  });

  return {
    ok: true,
    subjectId: dynamicResult.block.subjectId!,
    ...(dynamicResult.block.deviceId !== undefined
      ? { deviceId: dynamicResult.block.deviceId }
      : {}),
    ...(dynamicResult.block.sessionId !== undefined
      ? { sessionId: dynamicResult.block.sessionId }
      : {}),
    prompt: {
      staticBlock: staticResult.block,
      dynamicBlock: dynamicResult.block,
      combined,
    },
  };
}

export type StaticPromptCacheEntry = {
  bindingsHash: string;
  staticBlock: string;
  byteLength: number;
  storedAtMs: number;
};

export type StaticPromptCacheStats = {
  hits: number;
  misses: number;
  lookups: number;
  stores: number;
  evictions: number;
  size: number;
  /**
   * hits/lookups when lookups ≥ 2; otherwise null (first turn always miss —
   * hit-rate undefined until a second lookup).
   */
  hitRate: number | null;
};

export type StaticPromptCacheLookupHit = {
  ok: true;
  hit: true;
  subjectId: string;
  bindingsHash: string;
  staticBlock: string;
  byteLength: number;
  bytesSaved: number;
  hitRate: number | null;
};

export type StaticPromptCacheLookupMiss = {
  ok: true;
  hit: false;
  subjectId: string;
  bindingsHash: string;
  bytesSaved: 0;
  missMarker: PromptCacheMissMarker;
  hitRate: number | null;
};

export type StaticPromptCacheLookupRejected = {
  ok: false;
  failureClass: PromptCacheFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type StaticPromptCacheLookupResult =
  | StaticPromptCacheLookupHit
  | StaticPromptCacheLookupMiss
  | StaticPromptCacheLookupRejected;

export type StaticPromptCacheStoreAccepted = {
  ok: true;
  subjectId: string;
  bindingsHash: string;
  byteLength: number;
  entryCount: number;
  evicted: number;
  idempotentReplay: boolean;
};

export type StaticPromptCacheStoreResult =
  | StaticPromptCacheStoreAccepted
  | StaticPromptCacheLookupRejected;

export type StaticPromptCacheGetOrAssembleAccepted = {
  ok: true;
  subjectId: string;
  bindingsHash: string;
  staticBlock: string;
  hit: boolean;
  bytesSaved: number;
  assembled: boolean;
  missMarker?: PromptCacheMissMarker;
  hitRate: number | null;
  domainId: string;
  protocolVersion: string;
};

export type StaticPromptCacheGetOrAssembleResult =
  | StaticPromptCacheGetOrAssembleAccepted
  | StaticPromptCacheLookupRejected;

export type InMemoryStaticPromptCacheOptions = {
  subjectId: string;
  deviceId?: string;
  /** Max entries retained (clamped to {@link PROMPT_STATIC_CACHE_ENTRY_LIMIT_MAX}). */
  maxEntries?: number;
  /** Entry TTL in ms; `0` (default) disables TTL. */
  ttlMs?: number;
  now?: () => number;
  onTelemetry?: (event: PromptCacheTelemetryEvent) => void;
};

/**
 * Subject-scoped in-memory LRU (+ optional TTL) cache for static prompt bytes.
 * Keyed by content-addressed bindings hash. Lookup before assembly; store on
 * miss. Advisory — a miss never errors; hosts fall back to assembleStatic.
 */
export class InMemoryStaticPromptCache {
  readonly subjectId: string;
  readonly deviceId: string | undefined;
  readonly maxEntries: number;
  readonly ttlMs: number;

  private readonly now: () => number;
  private readonly onTelemetry:
    | ((event: PromptCacheTelemetryEvent) => void)
    | undefined;
  /** Insertion order = LRU oldest-first (Map). */
  private readonly entries = new Map<string, StaticPromptCacheEntry>();
  private hits = 0;
  private misses = 0;
  private stores = 0;
  private evictions = 0;

  constructor(options: InMemoryStaticPromptCacheOptions) {
    const subjectId = trimStr(options.subjectId);
    if (!subjectId) {
      throw new Error("InMemoryStaticPromptCache requires non-empty subjectId");
    }
    this.subjectId = subjectId;
    this.deviceId =
      options.deviceId !== undefined ? options.deviceId : undefined;
    const requested = options.maxEntries ?? PROMPT_STATIC_CACHE_ENTRY_LIMIT_DEFAULT;
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("InMemoryStaticPromptCache maxEntries must be >= 1");
    }
    this.maxEntries = Math.min(
      Math.floor(requested),
      PROMPT_STATIC_CACHE_ENTRY_LIMIT_MAX,
    );
    const ttl = options.ttlMs ?? PROMPT_STATIC_CACHE_TTL_MS_DEFAULT;
    if (!Number.isFinite(ttl) || ttl < 0) {
      throw new Error("InMemoryStaticPromptCache ttlMs must be >= 0");
    }
    this.ttlMs = Math.floor(ttl);
    this.now = options.now ?? Date.now;
    this.onTelemetry = options.onTelemetry;
  }

  get size(): number {
    return this.entries.size;
  }

  get stats(): StaticPromptCacheStats {
    const lookups = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      lookups,
      stores: this.stores,
      evictions: this.evictions,
      size: this.entries.size,
      hitRate: lookups >= 2 ? this.hits / lookups : null,
    };
  }

  /**
   * Lookup static bytes by bindings hash. Misses on cold, TTL expiry, or
   * eviction — never returns expired content.
   */
  lookup(bindingsHash: string): StaticPromptCacheLookupResult {
    const hash = normalizeBindingsHash(bindingsHash);
    if (!hash) {
      return this.rejectCache(
        "invalid_cache_key",
        "bindingsHash must be a 64-char lowercase sha256 hex digest",
        "cache_lookup",
      );
    }

    const nowMs = this.now();
    const existing = this.entries.get(hash);
    if (!existing) {
      return this.recordMiss(hash, "cold");
    }
    if (this.isExpired(existing, nowMs)) {
      this.entries.delete(hash);
      return this.recordMiss(hash, "ttl_expired");
    }

    // LRU touch
    this.entries.delete(hash);
    this.entries.set(hash, existing);
    this.hits += 1;
    const hitRate = this.stats.hitRate;
    this.emit({
      outcome: "ok",
      action: "cache_lookup",
      bindingsHash: hash,
      cacheHit: true,
      bytesSaved: existing.byteLength,
      entryCount: this.entries.size,
      hitRate,
    });
    return {
      ok: true,
      hit: true,
      subjectId: this.subjectId,
      bindingsHash: hash,
      staticBlock: existing.staticBlock,
      byteLength: existing.byteLength,
      bytesSaved: existing.byteLength,
      hitRate,
    };
  }

  /**
   * Store static block bytes under bindings hash. Idempotent when bytes match.
   * Evicts LRU entries under pressure. Does not validate hash-content binding
   * beyond hex shape — hosts must use {@link hashBindingsState} digests.
   */
  store(
    bindingsHash: string,
    staticBlock: string,
  ): StaticPromptCacheStoreResult {
    const hash = normalizeBindingsHash(bindingsHash);
    if (!hash) {
      return this.rejectCache(
        "invalid_cache_key",
        "bindingsHash must be a 64-char lowercase sha256 hex digest",
        "cache_store",
      );
    }
    if (typeof staticBlock !== "string") {
      return this.rejectCache(
        "invalid_bindings",
        "staticBlock must be a string",
        "cache_store",
      );
    }
    if (staticBlock.length > PROMPT_SECTION_CHAR_LIMIT * 4) {
      return this.rejectCache(
        "section_limit",
        `staticBlock exceeds cache section limit`,
        "cache_store",
      );
    }

    const existing = this.entries.get(hash);
    if (existing && !this.isExpired(existing, this.now())) {
      if (existing.staticBlock === staticBlock) {
        // Idempotent replay — LRU touch only.
        this.entries.delete(hash);
        this.entries.set(hash, existing);
        this.emit({
          outcome: "ok",
          action: "cache_store",
          bindingsHash: hash,
          cacheHit: true,
          bytesSaved: 0,
          entryCount: this.entries.size,
          hitRate: this.stats.hitRate,
        });
        return {
          ok: true,
          subjectId: this.subjectId,
          bindingsHash: hash,
          byteLength: existing.byteLength,
          entryCount: this.entries.size,
          evicted: 0,
          idempotentReplay: true,
        };
      }
      return this.rejectCache(
        "invalid_bindings",
        "bindingsHash already mapped to different static bytes",
        "cache_store",
      );
    }

    const entry: StaticPromptCacheEntry = {
      bindingsHash: hash,
      staticBlock,
      byteLength: utf8ByteLength(staticBlock),
      storedAtMs: this.now(),
    };
    if (existing) this.entries.delete(hash);
    this.entries.set(hash, entry);
    this.stores += 1;
    const evicted = this.evictOverflow();
    this.emit({
      outcome: "ok",
      action: "cache_store",
      bindingsHash: hash,
      cacheHit: false,
      bytesSaved: 0,
      entryCount: this.entries.size,
      hitRate: this.stats.hitRate,
      ...(evicted > 0 ? { missMarker: "evicted" as const } : {}),
    });
    return {
      ok: true,
      subjectId: this.subjectId,
      bindingsHash: hash,
      byteLength: entry.byteLength,
      entryCount: this.entries.size,
      evicted,
      idempotentReplay: false,
    };
  }

  /**
   * Drop one hash or the entire subject cache. Expired/evicted paths remain
   * misses — never stale serve.
   */
  invalidate(bindingsHash?: string): {
    ok: true;
    subjectId: string;
    removed: number;
  } {
    let removed = 0;
    if (bindingsHash === undefined) {
      removed = this.entries.size;
      this.entries.clear();
    } else {
      const hash = normalizeBindingsHash(bindingsHash);
      if (hash && this.entries.delete(hash)) removed = 1;
    }
    this.emit({
      outcome: "ok",
      action: "cache_invalidate",
      ...(bindingsHash !== undefined && normalizeBindingsHash(bindingsHash)
        ? { bindingsHash: normalizeBindingsHash(bindingsHash)! }
        : {}),
      cacheHit: false,
      bytesSaved: 0,
      entryCount: this.entries.size,
      missMarker: "explicit_invalidate",
      hitRate: this.stats.hitRate,
    });
    return { ok: true, subjectId: this.subjectId, removed };
  }

  /**
   * Hash bindings → lookup → on miss assembleStatic and store.
   * Cache is advisory: store failures still return assembled bytes.
   */
  getOrAssembleStatic(input: {
    bindingsState: PromptBindingsState;
    /** Defaults to bindingsState.profile / protocol when omitted. */
    profile?: PromptProfile;
    protocol?: PromptProtocol;
    assembleOptions?: PromptAssemblerOptions;
  }): StaticPromptCacheGetOrAssembleResult {
    const stateSubject = trimStr(input.bindingsState?.subjectId);
    if (!stateSubject) {
      return this.rejectCache(
        "missing_subject",
        "bindingsState.subjectId required",
        "cache_get_or_assemble",
      );
    }
    if (stateSubject !== this.subjectId) {
      return this.rejectCache(
        "cross_subject",
        "bindingsState.subjectId does not match cache subjectId",
        "cache_get_or_assemble",
      );
    }

    const profile = input.profile ?? input.bindingsState.profile;
    const protocol = input.protocol ?? input.bindingsState.protocol;
    const hashResult = hashBindingsState(input.bindingsState, {
      ...input.assembleOptions,
      onTelemetry: (e) => {
        input.assembleOptions?.onTelemetry?.(e);
        this.onTelemetry?.(e);
      },
    });
    if (!hashResult.ok) {
      return {
        ok: false,
        failureClass: hashResult.failureClass,
        subjectId: hashResult.subjectId,
        ...(hashResult.deviceId !== undefined
          ? { deviceId: hashResult.deviceId }
          : {}),
        detail: hashResult.detail,
      };
    }

    const looked = this.lookup(hashResult.hash);
    if (!looked.ok) return looked;
    if (looked.hit) {
      this.emit({
        outcome: "ok",
        action: "cache_get_or_assemble",
        bindingsHash: looked.bindingsHash,
        cacheHit: true,
        bytesSaved: looked.bytesSaved,
        entryCount: this.entries.size,
        hitRate: looked.hitRate,
        domainId: hashResult.domainId,
        protocolVersion: hashResult.protocolVersion,
      });
      return {
        ok: true,
        subjectId: this.subjectId,
        bindingsHash: looked.bindingsHash,
        staticBlock: looked.staticBlock,
        hit: true,
        bytesSaved: looked.bytesSaved,
        assembled: false,
        hitRate: looked.hitRate,
        domainId: hashResult.domainId,
        protocolVersion: hashResult.protocolVersion,
      };
    }

    const assembled = assembleStatic(profile, protocol, {
      ...input.assembleOptions,
      onTelemetry: (e) => {
        input.assembleOptions?.onTelemetry?.(e);
        this.onTelemetry?.(e);
      },
    });
    if (!assembled.ok) {
      return {
        ok: false,
        failureClass: assembled.failureClass,
        subjectId: assembled.subjectId,
        ...(assembled.deviceId !== undefined
          ? { deviceId: assembled.deviceId }
          : {}),
        detail: assembled.detail,
      };
    }

    // Advisory store — failure must not block assembled bytes.
    this.store(hashResult.hash, assembled.block.text);

    this.emit({
      outcome: "ok",
      action: "cache_get_or_assemble",
      bindingsHash: hashResult.hash,
      cacheHit: false,
      bytesSaved: 0,
      entryCount: this.entries.size,
      missMarker: looked.missMarker,
      hitRate: looked.hitRate,
      domainId: hashResult.domainId,
      protocolVersion: hashResult.protocolVersion,
      staticCharLength: assembled.block.charLength,
    });

    return {
      ok: true,
      subjectId: this.subjectId,
      bindingsHash: hashResult.hash,
      staticBlock: assembled.block.text,
      hit: false,
      bytesSaved: 0,
      assembled: true,
      missMarker: looked.missMarker,
      hitRate: looked.hitRate,
      domainId: hashResult.domainId,
      protocolVersion: hashResult.protocolVersion,
    };
  }

  private isExpired(entry: StaticPromptCacheEntry, nowMs: number): boolean {
    if (this.ttlMs <= 0) return false;
    return nowMs - entry.storedAtMs > this.ttlMs;
  }

  private evictOverflow(): number {
    let evicted = 0;
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      evicted += 1;
      this.evictions += 1;
    }
    return evicted;
  }

  private recordMiss(
    hash: string,
    missMarker: PromptCacheMissMarker,
  ): StaticPromptCacheLookupMiss {
    this.misses += 1;
    const hitRate = this.stats.hitRate;
    this.emit({
      outcome: "ok",
      action: "cache_lookup",
      bindingsHash: hash,
      cacheHit: false,
      bytesSaved: 0,
      entryCount: this.entries.size,
      missMarker,
      hitRate,
    });
    return {
      ok: true,
      hit: false,
      subjectId: this.subjectId,
      bindingsHash: hash,
      bytesSaved: 0,
      missMarker,
      hitRate,
    };
  }

  private rejectCache(
    failureClass: PromptCacheFailureClass,
    detail: string,
    action: NonNullable<PromptCacheTelemetryEvent["action"]>,
  ): StaticPromptCacheLookupRejected {
    this.emit({
      outcome: "rejected",
      action,
      failureClass,
      cacheHit: false,
      bytesSaved: 0,
      entryCount: this.entries.size,
      hitRate: this.stats.hitRate,
    });
    return {
      ok: false,
      failureClass,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      detail,
    };
  }

  private emit(
    partial: Omit<PromptCacheTelemetryEvent, "event" | "subjectId" | "deviceId"> & {
      subjectId?: string | null;
    },
  ): void {
    const cacheHit = partial.cacheHit;
    this.onTelemetry?.({
      event: "runtime.harness.prompt_cache",
      subjectId: partial.subjectId ?? this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      ...partial,
      ...(cacheHit !== undefined
        ? { cacheHit, cache_hit: cacheHit }
        : {}),
    });
  }
}

function normalizeBindingsHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hash = value.trim().toLowerCase();
  return BINDINGS_HASH_HEX_RE.test(hash) ? hash : null;
}

/**
 * Deterministic token estimate for a static prompt block.
 * Uses {@link PROMPT_STATIC_CHARS_PER_TOKEN_ESTIMATE}; never inspects semantics.
 */
export function estimateStaticBlockTokens(staticBlock: string): number {
  if (typeof staticBlock !== "string" || staticBlock.length === 0) return 0;
  return Math.ceil(
    staticBlock.length / PROMPT_STATIC_CHARS_PER_TOKEN_ESTIMATE,
  );
}

export type MeterCachedStaticAssemblyAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
  bindingsHash: string;
  staticBlock: string;
  cacheHit: boolean;
  /** Same as {@link cacheHit} — snake_case surface for metering hosts. */
  cache_hit: boolean;
  bytesSaved: number;
  hitRate: number | null;
  missMarker?: PromptCacheMissMarker;
  staticTokenEstimate: number;
  cachedInputTokens: number;
  freshInputTokens: number;
  assembled: boolean;
  domainId: string;
  protocolVersion: string;
  meterRecord: Extract<RecordTurnTokensResult, { ok: true }>;
  totalPromptTokens: number;
};

export type MeterCachedStaticAssemblyRejected = {
  ok: false;
  failureClass: PromptCacheFailureClass | TurnMeterFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
  cacheHit?: boolean;
  cache_hit?: boolean;
};

export type MeterCachedStaticAssemblyResult =
  | MeterCachedStaticAssemblyAccepted
  | MeterCachedStaticAssemblyRejected;

/**
 * Resolve static prefix via the subject cache, then record cached vs fresh
 * tokens on the attached {@link TurnMeter}.
 *
 * - Hit → `cachedInputTokens` = static token estimate; dynamic tokens stay fresh.
 * - Miss → static estimate counted as fresh (`cachedInputTokens` = 0).
 * Emits `cacheHit` / `cache_hit` plus byte/token counts (never charter text).
 */
export function meterCachedStaticAssembly(input: {
  cache: InMemoryStaticPromptCache;
  meter: TurnMeter;
  bindingsState: PromptBindingsState;
  profile?: PromptProfile;
  protocol?: PromptProtocol;
  /** Fresh tokens for the dynamic prompt slice (utterance / retrieval). */
  dynamicFreshInputTokens?: number;
  outputTokens?: number;
  /** Dedup key for TurnMeter.record — safe under replay. */
  idempotencyKey?: string;
  /**
   * Override static token estimate (e.g. provider-reported cached prefix).
   * When omitted, derived via {@link estimateStaticBlockTokens}.
   */
  staticTokenEstimate?: number;
  assembleOptions?: PromptAssemblerOptions;
  onTelemetry?: (event: PromptCacheTelemetryEvent) => void;
}): MeterCachedStaticAssemblyResult {
  const cacheSubject = input.cache.subjectId;
  const stateSubject = trimStr(input.bindingsState?.subjectId);
  if (!stateSubject) {
    const rejected: MeterCachedStaticAssemblyRejected = {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      detail: "bindingsState.subjectId required",
      cacheHit: false,
      cache_hit: false,
    };
    input.onTelemetry?.({
      event: "runtime.harness.prompt_cache",
      outcome: "rejected",
      subjectId: null,
      action: "meter_cache_assembly",
      cacheHit: false,
      cache_hit: false,
      failureClass: "missing_subject",
    });
    return rejected;
  }

  const meterScope = assertTurnMeterSubjectScope(input.meter, stateSubject);
  if (!meterScope.ok) {
    input.onTelemetry?.({
      event: "runtime.harness.prompt_cache",
      outcome: "rejected",
      subjectId: stateSubject,
      ...(input.cache.deviceId !== undefined
        ? { deviceId: input.cache.deviceId }
        : {}),
      action: "meter_cache_assembly",
      cacheHit: false,
      cache_hit: false,
      failureClass: meterScope.failureClass,
    });
    return {
      ok: false,
      failureClass: meterScope.failureClass,
      subjectId: stateSubject,
      ...(input.cache.deviceId !== undefined
        ? { deviceId: input.cache.deviceId }
        : {}),
      detail:
        meterScope.failureClass === "cross_subject"
          ? "TurnMeter subjectId does not match bindingsState.subjectId"
          : "TurnMeter subject scope missing",
      cacheHit: false,
      cache_hit: false,
    };
  }

  if (cacheSubject !== stateSubject) {
    input.onTelemetry?.({
      event: "runtime.harness.prompt_cache",
      outcome: "rejected",
      subjectId: stateSubject,
      action: "meter_cache_assembly",
      cacheHit: false,
      cache_hit: false,
      failureClass: "cross_subject",
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      subjectId: stateSubject,
      detail: "cache subjectId does not match bindingsState.subjectId",
      cacheHit: false,
      cache_hit: false,
    };
  }

  const resolved = input.cache.getOrAssembleStatic({
    bindingsState: input.bindingsState,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    assembleOptions: {
      ...input.assembleOptions,
      onTelemetry: (e) => {
        input.assembleOptions?.onTelemetry?.(e);
        input.onTelemetry?.(e);
      },
    },
  });

  if (!resolved.ok) {
    input.onTelemetry?.({
      event: "runtime.harness.prompt_cache",
      outcome: "rejected",
      subjectId: resolved.subjectId,
      ...(resolved.deviceId !== undefined
        ? { deviceId: resolved.deviceId }
        : {}),
      action: "meter_cache_assembly",
      cacheHit: false,
      cache_hit: false,
      failureClass: resolved.failureClass,
    });
    return {
      ok: false,
      failureClass: resolved.failureClass,
      subjectId: resolved.subjectId,
      ...(resolved.deviceId !== undefined
        ? { deviceId: resolved.deviceId }
        : {}),
      detail: resolved.detail,
      cacheHit: false,
      cache_hit: false,
    };
  }

  const dynamicFresh = input.dynamicFreshInputTokens ?? 0;
  if (
    !Number.isInteger(dynamicFresh) ||
    dynamicFresh < 0 ||
    (input.outputTokens !== undefined &&
      (!Number.isInteger(input.outputTokens) || input.outputTokens < 0))
  ) {
    input.onTelemetry?.({
      event: "runtime.harness.prompt_cache",
      outcome: "rejected",
      subjectId: resolved.subjectId,
      action: "meter_cache_assembly",
      cacheHit: resolved.hit,
      cache_hit: resolved.hit,
      failureClass: "invalid_tokens",
    });
    return {
      ok: false,
      failureClass: "invalid_tokens",
      subjectId: resolved.subjectId,
      detail: "dynamicFreshInputTokens / outputTokens must be non-negative integers",
      cacheHit: resolved.hit,
      cache_hit: resolved.hit,
    };
  }

  const staticTokenEstimate =
    input.staticTokenEstimate !== undefined
      ? input.staticTokenEstimate
      : estimateStaticBlockTokens(resolved.staticBlock);
  if (!Number.isInteger(staticTokenEstimate) || staticTokenEstimate < 0) {
    return {
      ok: false,
      failureClass: "invalid_tokens",
      subjectId: resolved.subjectId,
      detail: "staticTokenEstimate must be a non-negative integer",
      cacheHit: resolved.hit,
      cache_hit: resolved.hit,
    };
  }

  const cachedInputTokens = resolved.hit ? staticTokenEstimate : 0;
  const freshInputTokens = resolved.hit
    ? dynamicFresh
    : staticTokenEstimate + dynamicFresh;
  const totalPromptTokens = cachedInputTokens + freshInputTokens;

  const meterRecord = input.meter.record({
    cachedInputTokens,
    freshInputTokens,
    ...(input.outputTokens !== undefined
      ? { outputTokens: input.outputTokens }
      : {}),
    totalPromptTokens,
    ...(input.idempotencyKey !== undefined
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
  });

  if (!meterRecord.ok) {
    input.onTelemetry?.({
      event: "runtime.harness.prompt_cache",
      outcome: "rejected",
      subjectId: resolved.subjectId,
      ...(input.cache.deviceId !== undefined
        ? { deviceId: input.cache.deviceId }
        : {}),
      action: "meter_cache_assembly",
      cacheHit: resolved.hit,
      cache_hit: resolved.hit,
      bytesSaved: resolved.bytesSaved,
      cachedInputTokens,
      freshInputTokens,
      hitRate: resolved.hitRate,
      bindingsHash: resolved.bindingsHash,
      failureClass: meterRecord.failureClass,
    });
    return {
      ok: false,
      failureClass: meterRecord.failureClass,
      subjectId: resolved.subjectId,
      ...(input.cache.deviceId !== undefined
        ? { deviceId: input.cache.deviceId }
        : {}),
      detail: meterRecord.detail,
      cacheHit: resolved.hit,
      cache_hit: resolved.hit,
    };
  }

  input.onTelemetry?.({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    subjectId: resolved.subjectId,
    ...(input.cache.deviceId !== undefined
      ? { deviceId: input.cache.deviceId }
      : {}),
    action: "meter_cache_assembly",
    cacheHit: resolved.hit,
    cache_hit: resolved.hit,
    bytesSaved: resolved.bytesSaved,
    cachedInputTokens,
    freshInputTokens,
    hitRate: resolved.hitRate,
    bindingsHash: resolved.bindingsHash,
    domainId: resolved.domainId,
    protocolVersion: resolved.protocolVersion,
    ...(resolved.missMarker !== undefined
      ? { missMarker: resolved.missMarker }
      : {}),
  });

  return {
    ok: true,
    subjectId: resolved.subjectId,
    ...(input.cache.deviceId !== undefined
      ? { deviceId: input.cache.deviceId }
      : {}),
    bindingsHash: resolved.bindingsHash,
    staticBlock: resolved.staticBlock,
    cacheHit: resolved.hit,
    cache_hit: resolved.hit,
    bytesSaved: resolved.bytesSaved,
    hitRate: resolved.hitRate,
    ...(resolved.missMarker !== undefined
      ? { missMarker: resolved.missMarker }
      : {}),
    staticTokenEstimate,
    cachedInputTokens,
    freshInputTokens,
    assembled: resolved.assembled,
    domainId: resolved.domainId,
    protocolVersion: resolved.protocolVersion,
    meterRecord,
    totalPromptTokens,
  };
}

/**
 * One golden case locking prompt-assembly + bindings-hash determinism.
 * Inputs may permute object key / list insertion order; expected digests
 * and static bytes are byte-exact goldens.
 */
export type GoldenPromptAssemblyCase = {
  id: string;
  /** Spec / epic signal this golden protects (product language — not a task id). */
  specId: string;
  protects: string;
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  profile: PromptProfile;
  protocol: PromptProtocol;
  bindingFields?: Readonly<Record<string, unknown>>;
  turnContext: Omit<PromptTurnContext, "subjectId" | "deviceId" | "sessionId"> & {
    subjectId?: string;
  };
  expected: {
    outcome: "ok";
    bindingsHash: string;
    canonicalJson: string;
    staticBlock: string;
    dynamicBlock: string;
  };
};

export type GoldenPromptAssemblyCorpus = {
  description: string;
  cases: GoldenPromptAssemblyCase[];
};

export type GoldenPromptAssemblyAccepted = {
  ok: true;
  caseId: string;
  subjectId: string;
  deviceId?: string;
  bindingsHash: string;
  canonicalJson: string;
  staticBlock: string;
  dynamicBlock: string;
  /** True when unchanged hash implies unchanged static bytes (invariant). */
  staticMatchesHashInvariant: boolean;
  canonicalExpectationJson: string;
  expectedCanonicalExpectationJson: string;
  telemetry: PromptCacheTelemetryEvent[];
};

export type GoldenPromptAssemblyRejected = {
  ok: false;
  failureClass:
    | PromptCacheFailureClass
    | "canonical_drift"
    | "expectation_mismatch";
  subjectId: string | null;
  deviceId?: string;
  caseId?: string;
  detail: string;
  canonicalExpectationJson?: string;
  expectedCanonicalExpectationJson?: string;
};

export type GoldenPromptAssemblyResult =
  | GoldenPromptAssemblyAccepted
  | GoldenPromptAssemblyRejected;

/**
 * Canonical JSON of the deterministic expectation surface (hash + blocks).
 * Used for golden byte compare — not emitted as host telemetry content.
 */
export function canonicalizePromptAssemblyExpectationJson(surface: {
  bindingsHash: string;
  canonicalJson: string;
  staticBlock: string;
  dynamicBlock: string;
}): string {
  return `${JSON.stringify(
    sortKeysDeep({
      bindingsHash: surface.bindingsHash,
      canonicalJson: surface.canonicalJson,
      dynamicBlock: surface.dynamicBlock,
      staticBlock: surface.staticBlock,
    }),
    null,
    2,
  )}\n`;
}

/**
 * Replay one determinism golden: assemble static/dynamic + hash bindings,
 * then byte-compare against fixture expectations.
 */
export function replayPromptAssemblyDeterminismCase(
  fixtureCase: GoldenPromptAssemblyCase,
): GoldenPromptAssemblyResult {
  const caseId =
    typeof fixtureCase.id === "string" ? fixtureCase.id.trim() : "";
  const subjectId =
    typeof fixtureCase.subjectId === "string"
      ? fixtureCase.subjectId.trim()
      : "";
  if (!caseId) {
    return {
      ok: false,
      failureClass: "invalid_bindings",
      subjectId: subjectId || null,
      detail: "golden prompt-assembly case requires non-empty id",
    };
  }
  if (!subjectId) {
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      caseId,
      detail: "golden prompt-assembly case requires non-empty subjectId",
    };
  }

  const telemetry: PromptCacheTelemetryEvent[] = [];
  const opts: PromptAssemblerOptions = {
    onTelemetry: (e) => {
      telemetry.push(e);
    },
  };

  const turnSubject = trimStr(fixtureCase.turnContext?.subjectId) || subjectId;
  if (turnSubject !== subjectId) {
    return {
      ok: false,
      failureClass: "cross_subject",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId,
      detail: "turnContext.subjectId must match case subjectId",
    };
  }

  const hashResult = hashBindingsState(
    {
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      ...(fixtureCase.sessionId !== undefined
        ? { sessionId: fixtureCase.sessionId }
        : {}),
      profile: fixtureCase.profile,
      protocol: fixtureCase.protocol,
      ...(fixtureCase.bindingFields !== undefined
        ? { bindingFields: fixtureCase.bindingFields }
        : {}),
    },
    opts,
  );
  if (!hashResult.ok) {
    return {
      ok: false,
      failureClass: hashResult.failureClass,
      subjectId: hashResult.subjectId,
      ...(hashResult.deviceId !== undefined
        ? { deviceId: hashResult.deviceId }
        : {}),
      caseId,
      detail: hashResult.detail,
    };
  }

  const assembled = assemblePrompt({
    profile: fixtureCase.profile,
    protocol: fixtureCase.protocol,
    turnContext: {
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      ...(fixtureCase.sessionId !== undefined
        ? { sessionId: fixtureCase.sessionId }
        : {}),
      utterance: fixtureCase.turnContext.utterance,
      ...(fixtureCase.turnContext.memories !== undefined
        ? { memories: fixtureCase.turnContext.memories }
        : {}),
      ...(fixtureCase.turnContext.passages !== undefined
        ? { passages: fixtureCase.turnContext.passages }
        : {}),
    },
    options: opts,
  });
  if (!assembled.ok) {
    return {
      ok: false,
      failureClass: assembled.failureClass,
      subjectId: assembled.subjectId,
      ...(assembled.deviceId !== undefined
        ? { deviceId: assembled.deviceId }
        : {}),
      caseId,
      detail: assembled.detail,
    };
  }

  const canonicalJson = canonicalizeBindingsStateJson({
    subjectId,
    profile: {
      domainId: trimStr(fixtureCase.profile.domainId),
      charter:
        typeof fixtureCase.profile.charter === "string"
          ? fixtureCase.profile.charter
          : "",
      languages: fixtureCase.profile.languages,
      refusals: fixtureCase.profile.refusals,
    },
    protocol: {
      protocolVersion: trimStr(fixtureCase.protocol.protocolVersion),
      instructions:
        typeof fixtureCase.protocol.instructions === "string"
          ? fixtureCase.protocol.instructions
          : "",
    },
    bindingFields: fixtureCase.bindingFields ?? {},
  });

  const actualSurface = {
    bindingsHash: hashResult.hash,
    canonicalJson,
    staticBlock: assembled.prompt.staticBlock.text,
    dynamicBlock: assembled.prompt.dynamicBlock.text,
  };
  const expectedSurface = {
    bindingsHash: fixtureCase.expected.bindingsHash,
    canonicalJson: fixtureCase.expected.canonicalJson,
    staticBlock: fixtureCase.expected.staticBlock,
    dynamicBlock: fixtureCase.expected.dynamicBlock,
  };
  const canonicalExpectationJson =
    canonicalizePromptAssemblyExpectationJson(actualSurface);
  const expectedCanonicalExpectationJson =
    canonicalizePromptAssemblyExpectationJson(expectedSurface);

  if (canonicalExpectationJson !== expectedCanonicalExpectationJson) {
    return {
      ok: false,
      failureClass: "canonical_drift",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId,
      detail: "prompt-assembly golden expectation byte drift",
      canonicalExpectationJson,
      expectedCanonicalExpectationJson,
    };
  }

  // Same hash must keep static bytes identical (replayed twice).
  const hashAgain = hashBindingsState({
    subjectId,
    profile: fixtureCase.profile,
    protocol: fixtureCase.protocol,
    ...(fixtureCase.bindingFields !== undefined
      ? { bindingFields: fixtureCase.bindingFields }
      : {}),
  });
  const staticAgain = assembleStatic(
    fixtureCase.profile,
    fixtureCase.protocol,
  );
  if (!hashAgain.ok || !staticAgain.ok) {
    return {
      ok: false,
      failureClass: "expectation_mismatch",
      subjectId,
      caseId,
      detail: "idempotent re-hash / re-assemble rejected",
    };
  }
  const staticMatchesHashInvariant =
    hashAgain.hash === hashResult.hash &&
    staticAgain.block.text === assembled.prompt.staticBlock.text;

  if (!staticMatchesHashInvariant) {
    return {
      ok: false,
      failureClass: "expectation_mismatch",
      subjectId,
      caseId,
      detail: "static block / hash not idempotent under identical bindings",
    };
  }

  return {
    ok: true,
    caseId,
    subjectId,
    ...(fixtureCase.deviceId !== undefined
      ? { deviceId: fixtureCase.deviceId }
      : {}),
    bindingsHash: hashResult.hash,
    canonicalJson,
    staticBlock: assembled.prompt.staticBlock.text,
    dynamicBlock: assembled.prompt.dynamicBlock.text,
    staticMatchesHashInvariant,
    canonicalExpectationJson,
    expectedCanonicalExpectationJson,
    telemetry,
  };
}

/**
 * Split a previously combined prompt back into static/dynamic texts when
 * markers are present. Rejects unmarked or malformed assemblies.
 */
export function splitPromptBlocks(combined: string):
  | { ok: true; staticText: string; dynamicText: string }
  | { ok: false; failureClass: "invalid_turn_context"; detail: string } {
  if (typeof combined !== "string") {
    return {
      ok: false,
      failureClass: "invalid_turn_context",
      detail: "combined prompt must be a string",
    };
  }
  const { staticOpen, staticClose, dynamicOpen, dynamicClose } =
    PROMPT_BLOCK_MARKERS;
  const s0 = combined.indexOf(staticOpen);
  const s1 = combined.indexOf(staticClose);
  const d0 = combined.indexOf(dynamicOpen);
  const d1 = combined.indexOf(dynamicClose);
  if (s0 !== 0 || s1 < 0 || d0 < 0 || d1 < 0 || d0 <= s1) {
    return {
      ok: false,
      failureClass: "invalid_turn_context",
      detail: "combined prompt missing static/dynamic block markers",
    };
  }
  const staticText = combined.slice(s0, s1 + staticClose.length);
  const dynamicText = combined.slice(d0, d1 + dynamicClose.length);
  return { ok: true, staticText, dynamicText };
}

function rejectAssemble(
  failureClass: PromptCacheFailureClass,
  subjectId: string | null,
  detail: string,
  opts: PromptAssemblerOptions | undefined,
  action: PromptCacheTelemetryEvent["action"],
  scope?: { deviceId?: string; sessionId?: string },
): AssembleRejected {
  opts?.onTelemetry?.({
    event: "runtime.harness.prompt_cache",
    outcome: "rejected",
    subjectId,
    ...(scope?.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
    ...(scope?.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
    ...(action !== undefined ? { action } : {}),
    failureClass,
  });
  return {
    ok: false,
    failureClass,
    subjectId,
    ...(scope?.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
    detail,
  };
}
