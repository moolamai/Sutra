/**
 * Golden-turn fixture format — A↔B executable stream contract.
 *
 * Language-neutral JSON: raw `input` chunks in → `expectedFrames` out.
 * B4's parser must replay byte-identically. Updating goldens requires human
 * review — regeneration helpers never auto-commit.
 */

import { z } from "zod";
import { harnessFrameSchema, type HarnessFrame } from "./harness_frames.js";

/** Tags describing what a golden turn exercises (corpus coverage). */
export const GOLDEN_TURN_COVERAGE_TAGS = Object.freeze([
  "thought_delta",
  "answer_delta",
  "tool_call_fence",
  "correction_loop",
  "meter_tick",
  "harness_error",
  "advisory_attach",
  "turn_complete",
] as const);

export type GoldenTurnCoverageTag =
  (typeof GOLDEN_TURN_COVERAGE_TAGS)[number];

/**
 * One golden turn transcript.
 * Soft cap on chunks/frames keeps corpus hot-path friendly (NFR).
 */
export type GoldenTurnFixture = {
  id: string;
  subjectId: string;
  deviceId: string;
  correlationId: string;
  /** Opaque raw stream chunks (provider/model text and fences). */
  input: string[];
  /** Canonical HarnessFrame sequence after parse. */
  expectedFrames: HarnessFrame[];
  /** Declared coverage tags — corpus must include required scenarios. */
  coverage: GoldenTurnCoverageTag[];
};

export const goldenTurnFixtureSchema = z
  .object({
    id: z.string().min(1).max(128),
    subjectId: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(128),
    correlationId: z.string().min(1).max(128),
    input: z.array(z.string()).min(1).max(64),
    expectedFrames: z.array(harnessFrameSchema).min(1).max(64),
    coverage: z
      .array(z.enum(GOLDEN_TURN_COVERAGE_TAGS))
      .min(1)
      .max(GOLDEN_TURN_COVERAGE_TAGS.length),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    const types = new Set(fixture.expectedFrames.map((f) => f.type));
    if (!types.has("ADVISORY_ATTACH")) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedFrames"],
        message: "each golden must include ADVISORY_ATTACH",
      });
    }
    const last = fixture.expectedFrames[fixture.expectedFrames.length - 1];
    if (
      !last ||
      (last.type !== "TURN_COMPLETE" && last.type !== "HARNESS_ERROR")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedFrames"],
        message: "each golden must end with TURN_COMPLETE or HARNESS_ERROR",
      });
    }
    const hasTool =
      types.has("TOOL_STATUS") ||
      fixture.input.some((chunk) => /```tool_call/i.test(chunk));
    if (!hasTool) {
      ctx.addIssue({
        code: "custom",
        path: ["input"],
        message: "each golden must include a tool_call fence or TOOL_STATUS",
      });
    }
    for (const [i, frame] of fixture.expectedFrames.entries()) {
      if (frame.subjectId !== fixture.subjectId) {
        ctx.addIssue({
          code: "custom",
          path: ["expectedFrames", i, "subjectId"],
          message: "frame subjectId must match fixture subjectId",
        });
      }
      if (frame.correlationId !== fixture.correlationId) {
        ctx.addIssue({
          code: "custom",
          path: ["expectedFrames", i, "correlationId"],
          message: "frame correlationId must match fixture correlationId",
        });
      }
    }
  }) satisfies z.ZodType<GoldenTurnFixture>;

/** Corpus-level manifest enumerating committed golden files. */
export type GoldenTurnCorpusManifest = {
  version: string;
  description: string;
  turns: Array<{ id: string; file: string }>;
};

export const goldenTurnCorpusManifestSchema = z
  .object({
    version: z.string().min(1).max(32),
    description: z.string().min(1).max(512),
    turns: z
      .array(
        z
          .object({
            id: z.string().min(1),
            file: z.string().min(1),
          })
          .strict(),
      )
      .min(5)
      .max(64),
  })
  .strict() satisfies z.ZodType<GoldenTurnCorpusManifest>;

/** Deep-sort object keys for language-neutral canonical JSON. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeysDeep(
        (value as Record<string, unknown>)[key],
      );
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize a golden fixture to canonical JSON (sorted keys, 2-space indent,
 * trailing newline). Used for byte-identical consumer comparisons.
 */
export function canonicalizeGoldenTurn(fixture: GoldenTurnFixture): string {
  return `${JSON.stringify(sortKeysDeep(fixture), null, 2)}\n`;
}

export type GoldenCorpusValidateAccepted = {
  ok: true;
  subjectId: string | null;
  turnCount: number;
  coverage: GoldenTurnCoverageTag[];
};

export type GoldenCorpusValidateRejected = {
  ok: false;
  failureClass:
    | "insufficient_corpus"
    | "coverage_gap"
    | "schema_violation"
    | "canonical_drift"
    | "missing_subject";
  issuePath: string;
  detail: string;
};

export type GoldenCorpusValidateResult =
  | GoldenCorpusValidateAccepted
  | GoldenCorpusValidateRejected;

const REQUIRED_CORPUS_COVERAGE: readonly GoldenTurnCoverageTag[] = [
  "thought_delta",
  "answer_delta",
  "tool_call_fence",
  "correction_loop",
  "meter_tick",
  "harness_error",
];

/**
 * Validate a loaded corpus: ≥5 turns, required coverage tags, schema OK,
 * optional byte-identical check against on-disk canonical form.
 */
export function validateGoldenTurnCorpus(
  fixtures: unknown[],
  opts?: {
    subjectId?: string;
    rawFiles?: Array<{ id: string; raw: string }>;
  },
): GoldenCorpusValidateResult {
  if (!Array.isArray(fixtures) || fixtures.length < 5) {
    return {
      ok: false,
      failureClass: "insufficient_corpus",
      issuePath: "turns",
      detail: `need ≥5 goldens; got ${Array.isArray(fixtures) ? fixtures.length : 0}`,
    };
  }

  const parsed: GoldenTurnFixture[] = [];
  for (const [i, raw] of fixtures.entries()) {
    const result = goldenTurnFixtureSchema.safeParse(raw);
    if (!result.success) {
      return {
        ok: false,
        failureClass: "schema_violation",
        issuePath: `turns[${i}]`,
        detail: result.error.issues[0]?.message ?? "invalid golden",
      };
    }
    if (
      typeof opts?.subjectId === "string" &&
      opts.subjectId.length === 0
    ) {
      return {
        ok: false,
        failureClass: "missing_subject",
        issuePath: "subjectId",
        detail: "subjectId required for corpus telemetry scope",
      };
    }
    parsed.push(result.data);
  }

  const coverage = new Set<GoldenTurnCoverageTag>();
  for (const f of parsed) {
    for (const tag of f.coverage) coverage.add(tag);
  }
  for (const required of REQUIRED_CORPUS_COVERAGE) {
    if (!coverage.has(required)) {
      return {
        ok: false,
        failureClass: "coverage_gap",
        issuePath: "coverage",
        detail: `corpus missing required tag '${required}'`,
      };
    }
  }

  if (opts?.rawFiles) {
    for (const file of opts.rawFiles) {
      const fixture = parsed.find((p) => p.id === file.id);
      if (!fixture) continue;
      const canonical = canonicalizeGoldenTurn(fixture);
      if (file.raw.replace(/\r\n/g, "\n") !== canonical) {
        return {
          ok: false,
          failureClass: "canonical_drift",
          issuePath: file.id,
          detail: "on-disk golden is not canonical sorted-key JSON",
        };
      }
    }
  }

  return {
    ok: true,
    subjectId: opts?.subjectId ?? parsed[0]?.subjectId ?? null,
    turnCount: parsed.length,
    coverage: [...coverage].sort() as GoldenTurnCoverageTag[],
  };
}
