/**
 * Chunk-boundary fuzz for A P6 golden-turn transcripts.
 *
 * Joins parseable golden input bytes, splits at exhaustive / seeded-random
 * offsets, and asserts ParseEvent sequences match a single-chunk feed.
 * Pure: no IO, no tool execution.
 */

import { sortKeysDeep, type GoldenTurnFixture } from "@moolam/sync-protocol";
import {
  parseChunks,
  type ParseEvent,
  type ToolCallParserTelemetryEvent,
} from "./tool_call_parser.js";
import { unifiedDiff } from "./unified_diff.js";

/** Soft caps (scalability): keep CI and local fuzz bounded. */
export const CHUNK_FUZZ_MAX_EXHAUSTIVE_LEN = 256;
export const CHUNK_FUZZ_MAX_RANDOM_TRIALS = 64;
export const CHUNK_FUZZ_MAX_CUTS = 8;
/** Default seed — pinned so CI and laptop agree without lockfile-less RNG. */
export const CHUNK_FUZZ_DEFAULT_SEED = 0xb4_0f_f2_03;

const TRUNCATED_RE = /^<stream truncated>$/i;
const SEED_DRIFT_MARKER = "PARSER_CHUNK_FUZZ_SEED_DRIFT";

export type ChunkFuzzFailureClass =
  | "missing_subject"
  | "empty_stream"
  | "chunk_boundary_drift"
  | "cross_subject";

export type ChunkFuzzTelemetryEvent = {
  event: "runtime.harness.chunk_boundary_fuzz";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  turnId?: string;
  streamLen?: number;
  trials?: number;
  failureClass?: ChunkFuzzFailureClass;
  /** Split offset or trial index when drift was found — never transcript text. */
  splitAt?: number;
};

export type ChunkFuzzAccepted = {
  ok: true;
  turnId: string;
  subjectId: string;
  deviceId: string;
  streamLen: number;
  trials: number;
  canonicalJson: string;
};

export type ChunkFuzzRejected = {
  ok: false;
  failureClass: ChunkFuzzFailureClass;
  turnId: string;
  subjectId: string | null;
  deviceId: string | null;
  detail: string;
  diff: string;
};

export type ChunkFuzzResult = ChunkFuzzAccepted | ChunkFuzzRejected;

export type RunChunkBoundaryFuzzOptions = {
  /** PRNG seed (pinned default for CI reproducibility). */
  seed?: number;
  /** Cap exhaustive binary splits (streams longer than this use random only). */
  maxExhaustiveLen?: number;
  maxRandomTrials?: number;
  maxCuts?: number;
  /**
   * Inject intentional drift on the chunked path (prove red→green only).
   * Never enable in production CI paths except the prove script.
   */
  injectDrift?: boolean;
  onTelemetry?: (event: ChunkFuzzTelemetryEvent) => void;
  onParserTelemetry?: (event: ToolCallParserTelemetryEvent) => void;
};

/** Concatenate golden input, stopping before a truncation sentinel chunk. */
export function parseableGoldenStream(input: readonly string[]): string {
  const parts: string[] = [];
  for (const chunk of input) {
    if (typeof chunk !== "string") continue;
    if (TRUNCATED_RE.test(chunk)) break;
    parts.push(chunk);
  }
  return parts.join("");
}

/** Strip mode_change; keep comparable payload fields for canonical JSON. */
export function summarizeParseEvents(events: readonly ParseEvent[]): unknown[] {
  return events
    .filter((e) => e.type !== "mode_change")
    .map((e) => {
      if (
        e.type === "thought_delta" ||
        e.type === "answer_delta" ||
        e.type === "tool_buffer_delta"
      ) {
        return { type: e.type, delta: e.delta };
      }
      if (e.type === "tool_buffer") return { type: e.type, body: e.body };
      if (e.type === "violation") {
        return {
          type: e.type,
          failureClass: e.failureClass,
          discardedBytes: e.discardedBytes,
        };
      }
      return e;
    });
}

export function canonicalizeEventsJson(events: unknown): string {
  return `${JSON.stringify(sortKeysDeep(events), null, 2)}\n`;
}

/** Mulberry32 — deterministic, no crypto dependency. */
export function createSeededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function splitStreamAtCuts(
  stream: string,
  cuts: readonly number[],
): string[] {
  const sorted = [
    ...new Set(
      cuts.filter(
        (c) => Number.isInteger(c) && c > 0 && c < stream.length,
      ),
    ),
  ].sort((a, b) => a - b);
  if (sorted.length === 0) return [stream];
  const chunks: string[] = [];
  let prev = 0;
  for (const c of sorted) {
    chunks.push(stream.slice(prev, c));
    prev = c;
  }
  chunks.push(stream.slice(prev));
  return chunks;
}

function parseOpts(
  fixture: GoldenTurnFixture,
  opts: RunChunkBoundaryFuzzOptions,
) {
  return {
    subjectId: fixture.subjectId,
    ...(fixture.deviceId ? { deviceId: fixture.deviceId } : {}),
    ...(opts.onParserTelemetry
      ? { onTelemetry: opts.onParserTelemetry }
      : {}),
  };
}

/**
 * Property fuzz one golden: every split's event sequence equals single-chunk.
 */
export function runChunkBoundaryFuzz(
  fixture: GoldenTurnFixture,
  opts: RunChunkBoundaryFuzzOptions = {},
): ChunkFuzzResult {
  const subjectId =
    typeof fixture.subjectId === "string" ? fixture.subjectId.trim() : "";
  const deviceId =
    typeof fixture.deviceId === "string" ? fixture.deviceId.trim() : "";
  const turnId = fixture.id;

  const emitTel = (
    partial: Omit<ChunkFuzzTelemetryEvent, "event" | "subjectId"> & {
      subjectId?: string | null;
    },
  ): void => {
    if (!opts.onTelemetry) return;
    opts.onTelemetry({
      event: "runtime.harness.chunk_boundary_fuzz",
      subjectId:
        partial.subjectId !== undefined ? partial.subjectId : subjectId || null,
      outcome: partial.outcome,
      ...(deviceId ? { deviceId } : {}),
      ...(partial.turnId !== undefined ? { turnId: partial.turnId } : { turnId }),
      ...(partial.streamLen !== undefined
        ? { streamLen: partial.streamLen }
        : {}),
      ...(partial.trials !== undefined ? { trials: partial.trials } : {}),
      ...(partial.failureClass !== undefined
        ? { failureClass: partial.failureClass }
        : {}),
      ...(partial.splitAt !== undefined ? { splitAt: partial.splitAt } : {}),
    });
  };

  if (!subjectId) {
    emitTel({
      outcome: "rejected",
      subjectId: null,
      failureClass: "missing_subject",
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      turnId,
      subjectId: null,
      deviceId: deviceId || null,
      detail: "subjectId required for chunk-boundary fuzz scope",
      diff: "",
    };
  }

  const stream = parseableGoldenStream(fixture.input);
  if (stream.length === 0) {
    emitTel({ outcome: "rejected", failureClass: "empty_stream", streamLen: 0 });
    return {
      ok: false,
      failureClass: "empty_stream",
      turnId,
      subjectId,
      deviceId: deviceId || null,
      detail: `CHUNK_BOUNDARY_FUZZ_EMPTY:${turnId}`,
      diff: "",
    };
  }

  const parserOpts = parseOpts(fixture, opts);
  const baseline = summarizeParseEvents(parseChunks([stream], parserOpts));
  const baselineJson = canonicalizeEventsJson(baseline);

  const maxExhaustive =
    opts.maxExhaustiveLen ?? CHUNK_FUZZ_MAX_EXHAUSTIVE_LEN;
  const maxRandom = opts.maxRandomTrials ?? CHUNK_FUZZ_MAX_RANDOM_TRIALS;
  const maxCuts = opts.maxCuts ?? CHUNK_FUZZ_MAX_CUTS;
  const seed = opts.seed ?? CHUNK_FUZZ_DEFAULT_SEED;
  const rng = createSeededRng(seed ^ hashTurnId(turnId));

  let trials = 0;

  const checkChunks = (
    chunks: string[],
    splitAt: number,
  ): ChunkFuzzRejected | null => {
    trials += 1;
    let got = summarizeParseEvents(parseChunks(chunks, parserOpts));
    if (opts.injectDrift) {
      got = [
        ...got,
        { type: "answer_delta", delta: `${SEED_DRIFT_MARKER}:${turnId}` },
      ];
    }
    const gotJson = canonicalizeEventsJson(got);
    if (gotJson === baselineJson) return null;
    const diff = unifiedDiff(baselineJson, gotJson, {
      fromFile: `fuzz/${turnId}.single-chunk.json`,
      toFile: `fuzz/${turnId}.split.json`,
    });
    emitTel({
      outcome: "rejected",
      failureClass: "chunk_boundary_drift",
      streamLen: stream.length,
      trials,
      splitAt,
    });
    return {
      ok: false,
      failureClass: "chunk_boundary_drift",
      turnId,
      subjectId,
      deviceId: deviceId || null,
      detail: `CHUNK_BOUNDARY_FUZZ_DRIFT:${turnId}:splitAt=${splitAt}`,
      diff,
    };
  };

  if (stream.length <= maxExhaustive) {
    for (let offset = 0; offset <= stream.length; offset++) {
      const err = checkChunks(
        [stream.slice(0, offset), stream.slice(offset)],
        offset,
      );
      if (err) return err;
      // Empty-chunk insert must remain a no-op for event sequence.
      const errEmpty = checkChunks(
        [stream.slice(0, offset), "", stream.slice(offset)],
        offset,
      );
      if (errEmpty) return errEmpty;
    }
  }

  for (let i = 0; i < maxRandom; i++) {
    const cutCount = 1 + Math.floor(rng() * maxCuts);
    const cuts: number[] = [];
    for (let c = 0; c < cutCount; c++) {
      cuts.push(1 + Math.floor(rng() * (stream.length - 1)));
    }
    const err = checkChunks(splitStreamAtCuts(stream, cuts), cuts[0] ?? 0);
    if (err) return err;
  }

  // Sovereignty: parser opts subject must match fixture.
  if (parserOpts.subjectId !== subjectId) {
    emitTel({ outcome: "rejected", failureClass: "cross_subject" });
    return {
      ok: false,
      failureClass: "cross_subject",
      turnId,
      subjectId,
      deviceId: deviceId || null,
      detail: "parser subjectId mismatch",
      diff: "",
    };
  }

  emitTel({
    outcome: "ok",
    streamLen: stream.length,
    trials,
  });
  return {
    ok: true,
    turnId,
    subjectId,
    deviceId,
    streamLen: stream.length,
    trials,
    canonicalJson: baselineJson,
  };
}

/**
 * Fuzz every fixture; first drift wins with unified diff in `diff`.
 */
export function runChunkBoundaryFuzzCorpus(
  fixtures: readonly GoldenTurnFixture[],
  opts: RunChunkBoundaryFuzzOptions = {},
): {
  ok: true;
  turnCount: number;
  trials: number;
} | {
  ok: false;
  failureClass: ChunkFuzzFailureClass;
  turnId: string;
  detail: string;
  diff: string;
  subjectId: string | null;
} {
  let trials = 0;
  for (const fixture of fixtures) {
    const result = runChunkBoundaryFuzz(fixture, opts);
    if (!result.ok) {
      return {
        ok: false,
        failureClass: result.failureClass,
        turnId: result.turnId,
        detail: result.detail,
        diff: result.diff,
        subjectId: result.subjectId,
      };
    }
    trials += result.trials;
  }
  return { ok: true, turnCount: fixtures.length, trials };
}

export { SEED_DRIFT_MARKER };

function hashTurnId(turnId: string): number {
  let h = 0;
  for (let i = 0; i < turnId.length; i++) {
    h = (Math.imul(31, h) + turnId.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
