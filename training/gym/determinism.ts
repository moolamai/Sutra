/**
 * Gym determinism control — seeded clock, per-rollout RNG, retrieval order,
 * and sampling temperature injection.
 *
 * Imports production `createSeededRng` from @moolam/runtime-harness (never
 * re-implements Mulberry32). Retrieval order and sampling params derive from
 * the inject seed via dedicated streams — never Date.now / Math.random.
 *
 * ## Seed propagation contract
 *
 * {@link SEED_PROPAGATION_CONTRACT}
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSeededRng } from "@moolam/runtime-harness";

/** Soft caps (NFR — bounded draws / ticks / candidates per rollout). */
export const GYM_DETERMINISM_DRAW_LIMIT = 65_536;
export const GYM_DETERMINISM_SEED_MAX = 0xffff_ffff;
export const GYM_RETRIEVAL_CANDIDATE_LIMIT = 256;
export const GYM_SAMPLING_MAX_TOKENS = 512;
export const GYM_SAMPLING_TEMPERATURE_MAX = 1;

/** Fixed epoch so clocks never touch wall time. */
const CLOCK_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");
const CLOCK_TICK_MS = 1_000;

/** Dedicated stream salts — isolation from clock/RNG draw coupling. */
const RETRIEVAL_STREAM_SALT = 0x9e3779b9;
const SAMPLING_STREAM_SALT = 0x51a4e001;

/**
 * Seed propagation contract (binding for gym + downstream sampling/retrieval).
 *
 * 1. `GymEnv.reset(scenario, seed)` binds harness seed and creates one
 *    {@link HarnessDeterminismContext} for that rollout.
 * 2. Clock and RNG live on that context only — never shared across `GymEnv`
 *    instances or parallel rollouts (per-rollout RNG is mandatory).
 * 3. Same `(scenarioId, seed)` ⇒ identical initial clock ISO, RNG stream,
 *    retrieval connector order, and sampling params after a fresh inject.
 * 4. Retrieval order and sampling temperature MUST derive from this seed
 *    via {@link orderRetrievalBySeed} / {@link samplingParamsFromSeed} —
 *    never ambient entropy.
 * 5. Every draw / tick / order is subject-scoped; cross-subject use is a defect.
 * 6. Telemetry is metadata-only (no raw learner content).
 */
export const SEED_PROPAGATION_CONTRACT = Object.freeze({
  version: 2 as const,
  rules: Object.freeze([
    "reset binds seed + creates one per-rollout determinism context",
    "clock and RNG are never shared across GymEnv / parallel rollouts",
    "same (scenarioId, seed) yields identical clock+RNG+retrieval+sampling after fresh inject",
    "sampling/retrieval must consume this seed — never ambient entropy",
    "every draw/tick/order is subject-scoped; cross-subject is a defect",
    "telemetry is metadata-only (no raw learner content)",
  ] as const),
});

export type DeterminismFailureClass =
  | "invalid_seed"
  | "missing_subject"
  | "cross_subject"
  | "draw_budget"
  | "candidate_limit"
  | "invalid_candidate"
  | "config";

export type DeterminismTelemetry = {
  event: "training.gym.determinism";
  op: "inject" | "tick" | "draw" | "hash" | "order" | "sample";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  scenarioId?: string;
  seed?: number;
  episodeId?: string;
  failureClass?: DeterminismFailureClass;
  /** Bounded metadata — never passage/utterance bodies. */
  candidateCount?: number;
  temperature?: number;
  detail?: string;
};

export type SeededClock = {
  /** Milliseconds since Unix epoch (deterministic). */
  nowMs: () => number;
  /** ISO-8601 UTC from {@link nowMs}. */
  toIso: () => string;
  /** Advance by one tick (1s); returns new nowMs. */
  tick: () => number;
  /** Ticks since inject (observability). */
  tickCount: () => number;
};

export type PerRolloutRng = {
  /** Uniform [0, 1). Subject-bound; rejects foreign subjectId. */
  next: (subjectId: string) => number | DeterminismDrawError;
  /** Draws since inject (observability). */
  drawCount: () => number;
};

export type DeterminismDrawError = {
  ok: false;
  failureClass: DeterminismFailureClass;
  detail: string;
  subjectId: string;
};

/** Model sampling params derived solely from the inject seed. */
export type SeededSamplingParams = {
  temperature: number;
  topP: number;
  maxTokens: number;
};

/**
 * Retrieval / knowledge connector candidate (ids + optional score only —
 * never passage bodies on this surface).
 */
export type RetrievalConnectorCandidate = {
  connectorId: string;
  /** Relevance in [0, 1]; omitted treated as 0. */
  score?: number;
};

export type OrderRetrievalResult =
  | {
      ok: true;
      /** Connector ids in seeded deterministic order. */
      order: string[];
      subjectId: string;
      deviceId: string;
      seed: number;
    }
  | {
      ok: false;
      failureClass: DeterminismFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    };

/** Cross-process / CI snapshot — metadata only. */
export type SeededEntropySnapshot = {
  seed: number;
  subjectId: string;
  scenarioId: string | null;
  injectFingerprint: string;
  clockIso: string;
  sampling: SeededSamplingParams;
  retrievalOrder: string[];
};

export type HarnessDeterminismContext = {
  seed: number;
  subjectId: string;
  deviceId: string;
  scenarioId: string | null;
  episodeId: string | null;
  clock: SeededClock;
  rng: PerRolloutRng;
  /** Seed-derived sampling params (no ambient temperature). */
  sampling: SeededSamplingParams;
  /** Stable fingerprint of inject inputs (no content). */
  injectFingerprint: string;
};

export type CreateDeterminismInput = {
  seed: number;
  subjectId: string;
  deviceId: string;
  scenarioId?: string;
  episodeId?: string;
  onTelemetry?: (e: DeterminismTelemetry) => void;
};

export type CreateDeterminismResult =
  | { ok: true; context: HarnessDeterminismContext }
  | {
      ok: false;
      failureClass: DeterminismFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    };

function emit(
  onTelemetry: ((e: DeterminismTelemetry) => void) | undefined,
  e: Omit<DeterminismTelemetry, "event">,
): void {
  onTelemetry?.({ event: "training.gym.determinism", ...e });
}

function validateSeed(seed: unknown): seed is number {
  return (
    typeof seed === "number" &&
    Number.isInteger(seed) &&
    seed >= 0 &&
    seed <= GYM_DETERMINISM_SEED_MAX
  );
}

function mixSeed(seed: number, scenarioId: string | undefined): number {
  if (!scenarioId) return seed >>> 0;
  const digest = createHash("sha256")
    .update(`gym.det\n${scenarioId}\n${seed}\n`, "utf8")
    .digest();
  return digest.readUInt32BE(0) >>> 0;
}

function streamSeed(
  seed: number,
  scenarioId: string | null | undefined,
  salt: number,
): number {
  return (mixSeed(seed, scenarioId ?? undefined) ^ salt) >>> 0;
}

/**
 * Derive model sampling params from seed only (quantized; no ambient state).
 */
export function samplingParamsFromSeed(
  seed: number,
  scenarioId?: string | null,
): SeededSamplingParams {
  const next = createSeededRng(streamSeed(seed, scenarioId, SAMPLING_STREAM_SALT));
  // Quantize to 0.05 steps in [0, GYM_SAMPLING_TEMPERATURE_MAX].
  const rawT = next() * GYM_SAMPLING_TEMPERATURE_MAX;
  const temperature =
    Math.round(rawT / 0.05) * 0.05;
  const topP = Math.round((0.5 + next() * 0.5) * 100) / 100;
  return {
    temperature: Number(temperature.toFixed(2)),
    topP: Number(topP.toFixed(2)),
    maxTokens: GYM_SAMPLING_MAX_TOKENS,
  };
}

/**
 * Order retrieval / knowledge connectors via seed.
 * Primary key: score desc; tie-break: seeded float; then connectorId asc.
 * Uses a dedicated stream — does not advance the per-rollout draw RNG.
 */
export function orderRetrievalBySeed(input: {
  context: HarnessDeterminismContext;
  subjectId: string;
  candidates: readonly RetrievalConnectorCandidate[];
  onTelemetry?: (e: DeterminismTelemetry) => void;
}): OrderRetrievalResult {
  const bound = input.context;
  const sid = input.subjectId.trim();
  const onTelemetry = input.onTelemetry;

  if (!sid) {
    emit(onTelemetry, {
      op: "order",
      outcome: "error",
      subjectId: bound.subjectId,
      deviceId: bound.deviceId,
      seed: bound.seed,
      failureClass: "missing_subject",
      detail: "subjectId required for retrieval order",
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      detail: "subjectId required for retrieval order",
      subjectId: bound.subjectId,
      deviceId: bound.deviceId,
    };
  }
  if (sid !== bound.subjectId) {
    emit(onTelemetry, {
      op: "order",
      outcome: "error",
      subjectId: bound.subjectId,
      deviceId: bound.deviceId,
      seed: bound.seed,
      failureClass: "cross_subject",
      detail: "retrieval order subjectId diverged from inject bind",
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      detail: "retrieval order subjectId diverged from inject bind",
      subjectId: bound.subjectId,
      deviceId: bound.deviceId,
    };
  }
  if (!Array.isArray(input.candidates)) {
    emit(onTelemetry, {
      op: "order",
      outcome: "error",
      subjectId: bound.subjectId,
      deviceId: bound.deviceId,
      seed: bound.seed,
      failureClass: "invalid_candidate",
      detail: "candidates must be an array",
    });
    return {
      ok: false,
      failureClass: "invalid_candidate",
      detail: "candidates must be an array",
      subjectId: bound.subjectId,
      deviceId: bound.deviceId,
    };
  }
  if (input.candidates.length > GYM_RETRIEVAL_CANDIDATE_LIMIT) {
    emit(onTelemetry, {
      op: "order",
      outcome: "error",
      subjectId: bound.subjectId,
      deviceId: bound.deviceId,
      seed: bound.seed,
      failureClass: "candidate_limit",
      candidateCount: input.candidates.length,
      detail: `candidates exceed ${GYM_RETRIEVAL_CANDIDATE_LIMIT}`,
    });
    return {
      ok: false,
      failureClass: "candidate_limit",
      detail: `candidates exceed ${GYM_RETRIEVAL_CANDIDATE_LIMIT}`,
      subjectId: bound.subjectId,
      deviceId: bound.deviceId,
    };
  }

  for (let i = 0; i < input.candidates.length; i += 1) {
    const c = input.candidates[i]!;
    if (
      !c ||
      typeof c.connectorId !== "string" ||
      !c.connectorId.trim()
    ) {
      emit(onTelemetry, {
        op: "order",
        outcome: "error",
        subjectId: bound.subjectId,
        deviceId: bound.deviceId,
        seed: bound.seed,
        failureClass: "invalid_candidate",
        detail: `candidates[${i}].connectorId must be a non-empty string`,
      });
      return {
        ok: false,
        failureClass: "invalid_candidate",
        detail: `candidates[${i}].connectorId must be a non-empty string`,
        subjectId: bound.subjectId,
        deviceId: bound.deviceId,
      };
    }
    if (
      c.score !== undefined &&
      (typeof c.score !== "number" ||
        !Number.isFinite(c.score) ||
        c.score < 0 ||
        c.score > 1)
    ) {
      emit(onTelemetry, {
        op: "order",
        outcome: "error",
        subjectId: bound.subjectId,
        deviceId: bound.deviceId,
        seed: bound.seed,
        failureClass: "invalid_candidate",
        detail: `candidates[${i}].score must be in [0, 1]`,
      });
      return {
        ok: false,
        failureClass: "invalid_candidate",
        detail: `candidates[${i}].score must be in [0, 1]`,
        subjectId: bound.subjectId,
        deviceId: bound.deviceId,
      };
    }
  }

  const next = createSeededRng(
    streamSeed(bound.seed, bound.scenarioId, RETRIEVAL_STREAM_SALT),
  );
  const decorated = input.candidates.map((c) => ({
    connectorId: c.connectorId.trim(),
    score: c.score ?? 0,
    tie: next(),
  }));
  decorated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.tie !== b.tie) return a.tie < b.tie ? -1 : 1;
    return a.connectorId.localeCompare(b.connectorId);
  });
  const order = decorated.map((d) => d.connectorId);

  emit(onTelemetry, {
    op: "order",
    outcome: "ok",
    subjectId: bound.subjectId,
    deviceId: bound.deviceId,
    seed: bound.seed,
    ...(bound.scenarioId !== null ? { scenarioId: bound.scenarioId } : {}),
    candidateCount: order.length,
    detail: "retrieval connector order seeded",
  });

  return {
    ok: true,
    order,
    subjectId: bound.subjectId,
    deviceId: bound.deviceId,
    seed: bound.seed,
  };
}

/**
 * Serializable entropy snapshot for cross-process reproducibility checks.
 */
export function snapshotSeededEntropy(input: {
  context: HarnessDeterminismContext;
  candidates: readonly RetrievalConnectorCandidate[];
  onTelemetry?: (e: DeterminismTelemetry) => void;
}):
  | { ok: true; snapshot: SeededEntropySnapshot }
  | {
      ok: false;
      failureClass: DeterminismFailureClass;
      detail: string;
      subjectId: string;
    } {
  const ordered = orderRetrievalBySeed({
    context: input.context,
    subjectId: input.context.subjectId,
    candidates: input.candidates,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!ordered.ok) {
    return {
      ok: false,
      failureClass: ordered.failureClass,
      detail: ordered.detail,
      subjectId: ordered.subjectId,
    };
  }

  emit(input.onTelemetry, {
    op: "sample",
    outcome: "ok",
    subjectId: input.context.subjectId,
    deviceId: input.context.deviceId,
    seed: input.context.seed,
    ...(input.context.scenarioId !== null
      ? { scenarioId: input.context.scenarioId }
      : {}),
    temperature: input.context.sampling.temperature,
    detail: "sampling params from seed",
  });

  return {
    ok: true,
    snapshot: {
      seed: input.context.seed,
      subjectId: input.context.subjectId,
      scenarioId: input.context.scenarioId,
      injectFingerprint: input.context.injectFingerprint,
      clockIso: input.context.clock.toIso(),
      sampling: { ...input.context.sampling },
      retrievalOrder: ordered.order,
    },
  };
}

function injectFingerprint(input: {
  seed: number;
  subjectId: string;
  scenarioId: string | null;
}): string {
  const digest = createHash("sha256")
    .update(
      `${input.seed}\n${input.subjectId}\n${input.scenarioId ?? ""}\n`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return `det.${digest}`;
}

/**
 * Deterministic wall clock: epoch offset from seed, advanced only via tick().
 */
export function createSeededClock(seed: number): SeededClock {
  const originMs = CLOCK_EPOCH_MS + (seed % 86_400_000);
  let ticks = 0;
  return {
    nowMs: () => originMs + ticks * CLOCK_TICK_MS,
    toIso: () => new Date(originMs + ticks * CLOCK_TICK_MS).toISOString(),
    tick: () => {
      ticks += 1;
      return originMs + ticks * CLOCK_TICK_MS;
    },
    tickCount: () => ticks,
  };
}

/**
 * Per-rollout RNG wrapping production Mulberry32. Never share across rollouts.
 */
export function createPerRolloutRng(input: {
  seed: number;
  subjectId: string;
  scenarioId?: string;
  onTelemetry?: (e: DeterminismTelemetry) => void;
  deviceId: string;
}): PerRolloutRng {
  const boundSubject = input.subjectId;
  const mixed = mixSeed(input.seed, input.scenarioId);
  const nextFloat = createSeededRng(mixed);
  let draws = 0;

  return {
    drawCount: () => draws,
    next: (subjectId: string) => {
      const sid = subjectId.trim();
      if (!sid) {
        emit(input.onTelemetry, {
          op: "draw",
          outcome: "error",
          subjectId: boundSubject,
          deviceId: input.deviceId,
          seed: input.seed,
          failureClass: "missing_subject",
          detail: "subjectId required for RNG draw",
        });
        return {
          ok: false,
          failureClass: "missing_subject",
          detail: "subjectId required for RNG draw",
          subjectId: boundSubject,
        };
      }
      if (sid !== boundSubject) {
        emit(input.onTelemetry, {
          op: "draw",
          outcome: "error",
          subjectId: boundSubject,
          deviceId: input.deviceId,
          seed: input.seed,
          failureClass: "cross_subject",
          detail: "RNG draw subjectId diverged from inject bind",
        });
        return {
          ok: false,
          failureClass: "cross_subject",
          detail: "RNG draw subjectId diverged from inject bind",
          subjectId: boundSubject,
        };
      }
      if (draws >= GYM_DETERMINISM_DRAW_LIMIT) {
        emit(input.onTelemetry, {
          op: "draw",
          outcome: "error",
          subjectId: boundSubject,
          deviceId: input.deviceId,
          seed: input.seed,
          failureClass: "draw_budget",
          detail: `draw count exceeds ${GYM_DETERMINISM_DRAW_LIMIT}`,
        });
        return {
          ok: false,
          failureClass: "draw_budget",
          detail: `draw count exceeds ${GYM_DETERMINISM_DRAW_LIMIT}`,
          subjectId: boundSubject,
        };
      }
      draws += 1;
      const value = nextFloat();
      emit(input.onTelemetry, {
        op: "draw",
        outcome: "ok",
        subjectId: boundSubject,
        deviceId: input.deviceId,
        seed: input.seed,
        ...(input.scenarioId !== undefined
          ? { scenarioId: input.scenarioId }
          : {}),
        detail: "rng draw",
      });
      return value;
    },
  };
}

/**
 * Inject seeded clock + per-rollout RNG for one harness / gym rollout.
 */
export function createHarnessDeterminismContext(
  input: CreateDeterminismInput,
): CreateDeterminismResult {
  const subjectId = input.subjectId.trim();
  const deviceId = input.deviceId.trim();

  if (!subjectId) {
    emit(input.onTelemetry, {
      op: "inject",
      outcome: "error",
      subjectId: "",
      deviceId: deviceId || "dev-unknown",
      failureClass: "missing_subject",
      detail: "subjectId required for determinism inject",
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      detail: "subjectId required for determinism inject",
      subjectId: "",
      deviceId: deviceId || "dev-unknown",
    };
  }
  if (!deviceId) {
    emit(input.onTelemetry, {
      op: "inject",
      outcome: "error",
      subjectId,
      deviceId: "",
      failureClass: "config",
      detail: "deviceId required for determinism inject",
    });
    return {
      ok: false,
      failureClass: "config",
      detail: "deviceId required for determinism inject",
      subjectId,
      deviceId: "",
    };
  }
  if (!validateSeed(input.seed)) {
    emit(input.onTelemetry, {
      op: "inject",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "invalid_seed",
      detail: `seed must be integer in [0, ${GYM_DETERMINISM_SEED_MAX}]`,
    });
    return {
      ok: false,
      failureClass: "invalid_seed",
      detail: `seed must be integer in [0, ${GYM_DETERMINISM_SEED_MAX}]`,
      subjectId,
      deviceId,
    };
  }

  const scenarioId = input.scenarioId?.trim() || null;
  const episodeId = input.episodeId?.trim() || null;
  const clock = createSeededClock(input.seed);
  const rng = createPerRolloutRng({
    seed: input.seed,
    subjectId,
    deviceId,
    ...(scenarioId !== null ? { scenarioId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  const sampling = samplingParamsFromSeed(input.seed, scenarioId);

  const context: HarnessDeterminismContext = {
    seed: input.seed,
    subjectId,
    deviceId,
    scenarioId,
    episodeId,
    clock,
    rng,
    sampling,
    injectFingerprint: injectFingerprint({
      seed: input.seed,
      subjectId,
      scenarioId,
    }),
  };

  emit(input.onTelemetry, {
    op: "inject",
    outcome: "ok",
    subjectId,
    deviceId,
    seed: input.seed,
    ...(scenarioId !== null ? { scenarioId } : {}),
    ...(episodeId !== null ? { episodeId } : {}),
    temperature: sampling.temperature,
    detail: "seeded clock + RNG + sampling bound",
  });

  emit(input.onTelemetry, {
    op: "sample",
    outcome: "ok",
    subjectId,
    deviceId,
    seed: input.seed,
    ...(scenarioId !== null ? { scenarioId } : {}),
    temperature: sampling.temperature,
    detail: "sampling params from seed",
  });

  return { ok: true, context };
}

/**
 * SHA-256 of canonical harness frame sequence (production canon).
 * Same (scenario, seed, actions) ⇒ identical hash when path is deterministic.
 */
export function hashFrameSequence(frames: unknown[]): string {
  // Lazy import path via dynamic would break sync tests; use stable JSON
  // sorted by harness canonicalize when available — hash sorted-key JSON of
  // the frame array as a gym-local fallback matching frame_parity intent.
  const digest = createHash("sha256")
    .update(`${stableStringify(frames)}\n`, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeysDeep(obj[key]);
    }
    return out;
  }
  return value;
}

/**
 * Prefer production canonicalize when the harness bridge is loaded.
 * Used by tests / prove helper for frame-sequence identity.
 */
export async function hashFrameSequenceCanonical(
  frames: unknown[],
): Promise<string> {
  const { canonicalizeFramesJson } = await import("./src/harness_bridge.mjs");
  const canonical = canonicalizeFramesJson(frames);
  const digest = createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/**
 * Self-check: inject twice with same inputs ⇒ identical clock ISO + RNG prefix;
 * parallel contexts do not bleed; cross-subject draw fails.
 */
export function proveDeterminismInjection(): {
  ok: boolean;
  detail: string;
} {
  const a = createHarnessDeterminismContext({
    seed: 42,
    subjectId: "subj.prove.det",
    deviceId: "dev-prove-det",
    scenarioId: "thought-answer-basic",
  });
  const b = createHarnessDeterminismContext({
    seed: 42,
    subjectId: "subj.prove.det",
    deviceId: "dev-prove-det",
    scenarioId: "thought-answer-basic",
  });
  if (!a.ok || !b.ok) {
    return { ok: false, detail: "inject failed for prove inputs" };
  }
  if (a.context.clock.toIso() !== b.context.clock.toIso()) {
    return { ok: false, detail: "clock ISO diverged for same seed" };
  }
  const ra = a.context.rng.next("subj.prove.det");
  const rb = b.context.rng.next("subj.prove.det");
  if (typeof ra !== "number" || typeof rb !== "number" || ra !== rb) {
    return { ok: false, detail: "RNG prefix diverged for same seed" };
  }
  if (
    a.context.sampling.temperature !== b.context.sampling.temperature ||
    a.context.sampling.topP !== b.context.sampling.topP
  ) {
    return { ok: false, detail: "sampling params diverged for same seed" };
  }

  const parallel = createHarnessDeterminismContext({
    seed: 7,
    subjectId: "subj.prove.det.a",
    deviceId: "dev-prove-det",
  });
  const other = createHarnessDeterminismContext({
    seed: 7,
    subjectId: "subj.prove.det.b",
    deviceId: "dev-prove-det",
  });
  if (!parallel.ok || !other.ok) {
    return { ok: false, detail: "parallel inject failed" };
  }
  const p1 = parallel.context.rng.next("subj.prove.det.a");
  const o1 = other.context.rng.next("subj.prove.det.b");
  if (typeof p1 !== "number" || typeof o1 !== "number") {
    return { ok: false, detail: "parallel draws failed" };
  }
  // Advance parallel; other must still yield its first draw unchanged if recreated.
  parallel.context.rng.next("subj.prove.det.a");
  const otherFresh = createHarnessDeterminismContext({
    seed: 7,
    subjectId: "subj.prove.det.b",
    deviceId: "dev-prove-det",
  });
  if (!otherFresh.ok) {
    return { ok: false, detail: "otherFresh inject failed" };
  }
  const o1Again = otherFresh.context.rng.next("subj.prove.det.b");
  if (o1Again !== o1) {
    return { ok: false, detail: "parallel rollouts bled RNG state" };
  }

  const cross = parallel.context.rng.next("subj.foreign");
  if (typeof cross === "number" || cross.failureClass !== "cross_subject") {
    return { ok: false, detail: "cross-subject draw was not rejected" };
  }

  if (SEED_PROPAGATION_CONTRACT.version !== 2) {
    return { ok: false, detail: "seed contract version unexpected" };
  }

  return { ok: true, detail: "determinism inject prove passed" };
}

/** Fixed connector set for cross-process / prove snapshots (ids only). */
export const PROVE_RETRIEVAL_CANDIDATES: readonly RetrievalConnectorCandidate[] =
  Object.freeze([
    { connectorId: "pack.teacher", score: 0.8 },
    { connectorId: "pack.lawyer", score: 0.8 },
    { connectorId: "pack.doctor", score: 0.5 },
    { connectorId: "pack.generic", score: 0.5 },
    { connectorId: "pack.aux" },
  ]);

/**
 * In-process prove: same seed ⇒ identical retrieval order + sampling params;
 * parallel order calls do not bleed; cross-subject order rejected.
 */
export function proveDeterminismSampling(): {
  ok: boolean;
  detail: string;
} {
  const a = createHarnessDeterminismContext({
    seed: 42,
    subjectId: "subj.prove.sample",
    deviceId: "dev-prove-sample",
    scenarioId: "thought-answer-basic",
  });
  const b = createHarnessDeterminismContext({
    seed: 42,
    subjectId: "subj.prove.sample",
    deviceId: "dev-prove-sample",
    scenarioId: "thought-answer-basic",
  });
  if (!a.ok || !b.ok) {
    return { ok: false, detail: "sample inject failed" };
  }

  const snapA = snapshotSeededEntropy({
    context: a.context,
    candidates: PROVE_RETRIEVAL_CANDIDATES,
  });
  const snapB = snapshotSeededEntropy({
    context: b.context,
    candidates: PROVE_RETRIEVAL_CANDIDATES,
  });
  if (!snapA.ok || !snapB.ok) {
    return { ok: false, detail: "snapshot failed" };
  }
  if (stableStringify(snapA.snapshot) !== stableStringify(snapB.snapshot)) {
    return { ok: false, detail: "seeded entropy snapshot diverged in-process" };
  }

  const left = createHarnessDeterminismContext({
    seed: 99,
    subjectId: "subj.prove.sample.l",
    deviceId: "dev-prove-sample",
  });
  const right = createHarnessDeterminismContext({
    seed: 99,
    subjectId: "subj.prove.sample.r",
    deviceId: "dev-prove-sample",
  });
  if (!left.ok || !right.ok) {
    return { ok: false, detail: "parallel sample inject failed" };
  }
  const rOrder = orderRetrievalBySeed({
    context: right.context,
    subjectId: "subj.prove.sample.r",
    candidates: PROVE_RETRIEVAL_CANDIDATES,
  });
  left.context.rng.next("subj.prove.sample.l");
  orderRetrievalBySeed({
    context: left.context,
    subjectId: "subj.prove.sample.l",
    candidates: PROVE_RETRIEVAL_CANDIDATES,
  });
  const rightFresh = createHarnessDeterminismContext({
    seed: 99,
    subjectId: "subj.prove.sample.r",
    deviceId: "dev-prove-sample",
  });
  if (!rightFresh.ok || !rOrder.ok) {
    return { ok: false, detail: "parallel order setup failed" };
  }
  const rOrderAgain = orderRetrievalBySeed({
    context: rightFresh.context,
    subjectId: "subj.prove.sample.r",
    candidates: PROVE_RETRIEVAL_CANDIDATES,
  });
  if (
    !rOrderAgain.ok ||
    stableStringify(rOrder.order) !== stableStringify(rOrderAgain.order)
  ) {
    return { ok: false, detail: "parallel rollouts bled retrieval order" };
  }

  const cross = orderRetrievalBySeed({
    context: left.context,
    subjectId: "subj.foreign",
    candidates: PROVE_RETRIEVAL_CANDIDATES,
  });
  if (cross.ok || cross.failureClass !== "cross_subject") {
    return { ok: false, detail: "cross-subject order was not rejected" };
  }

  const over = orderRetrievalBySeed({
    context: left.context,
    subjectId: left.context.subjectId,
    candidates: Array.from({ length: GYM_RETRIEVAL_CANDIDATE_LIMIT + 1 }, (_, i) => ({
      connectorId: `c.${i}`,
    })),
  });
  if (over.ok || over.failureClass !== "candidate_limit") {
    return { ok: false, detail: "candidate limit was not enforced" };
  }

  return { ok: true, detail: "determinism sampling prove passed" };
}

/**
 * Spawn two child processes with the same seed inputs; require byte-identical
 * seeded entropy snapshots (retrieval order + sampling params).
 */
export function proveCrossProcessSeededEntropy(): {
  ok: boolean;
  detail: string;
} {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, "scripts", "emit-seeded-entropy.mjs");
  const args = [
    "--experimental-strip-types",
    script,
    "42",
    "subj.prove.xproc",
    "dev-prove-xproc",
    "thought-answer-basic",
  ];

  const run = () =>
    spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: process.env,
      cwd: here,
    });

  const a = run();
  const b = run();
  if (a.status !== 0 || b.status !== 0) {
    return {
      ok: false,
      detail: `child exit a=${a.status} b=${b.status} stderr=${a.stderr || b.stderr}`,
    };
  }
  const lineA = (a.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  const lineB = (b.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  if (!lineA || !lineB) {
    return { ok: false, detail: "empty child stdout" };
  }
  if (lineA !== lineB) {
    return { ok: false, detail: "cross-process seeded entropy diverged" };
  }
  try {
    const parsed = JSON.parse(lineA) as { ok?: boolean; snapshot?: unknown };
    if (parsed.ok !== true || !parsed.snapshot) {
      return { ok: false, detail: "child snapshot malformed" };
    }
  } catch {
    return { ok: false, detail: "child stdout not JSON" };
  }
  return { ok: true, detail: "cross-process seeded entropy identical" };
}
