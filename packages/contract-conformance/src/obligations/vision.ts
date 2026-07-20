/**
 * VisionInterface obligations ( / CK-06).
 *
 * CK-06.1 — Implementations MUST reject inputs above their declared size
 *           limits with a typed error rather than degrading silently.
 * CK-06.2 — When `responseSchema` is provided, `answer` MUST be valid JSON
 *           for that schema.
 */

import type {
  VisionInterface,
  VisualAnalysisRequest,
  VisualAnalysisResult,
  VisualInput,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

/**
 * Verbatim MUST sentences from `packages/contracts/src/vision.ts`.
 */
export const MUST_REJECT_OVERSIZED =
  "Implementations MUST reject inputs above their declared size limits with a typed error rather than degrading silently.";

export const MUST_SCHEMA_VALID_JSON =
  "When `responseSchema` is provided, `answer` MUST be valid JSON for it.";

export const VISION_OBLIGATION_IDS = {
  rejectOversized: "CK-06.1",
  schemaValidJson: "CK-06.2",
} as const;

/** Reference max input size for conformance probes (bytes). */
export const VISION_REFERENCE_MAX_INPUT_BYTES = 64;

/** Max schema properties / keys inspected (NFR / scalability). */
export const VISION_SCHEMA_KEY_SCAN_LIMIT = 32;

/**
 * Conformance surface for vision providers.
 * Probe only through `maxInputBytes` + `analyze`.
 */
export interface VisionConformanceHarness {
  vision: VisionInterface;
  /**
   * Count of analyze bodies that ran past the size gate (observability for
   * "reject before processing"). Reference stays at 0 on oversized probes.
   */
  processedCount(): number;
}

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

/** Subject-scoped instruction — metadata tokens only. */
export function buildVisionProbeInstruction(ctx: ObligationContext): string {
  return `probe.ck06.instruction.${subjectToken(ctx.subjectId)}`;
}

export function buildVisionProbeInput(
  byteLength: number,
  ctx: ObligationContext,
): VisualInput {
  const prefix = new TextEncoder().encode(
    `probe.ck06.img.${subjectToken(ctx.subjectId)}.`,
  );
  const data = new Uint8Array(Math.max(byteLength, 0));
  data.set(prefix.subarray(0, Math.min(prefix.length, data.length)));
  return {
    data,
    mimeType: "image/png",
  };
}

/** Minimal responseSchema used by CK-06.2 probes. */
export function buildVisionProbeResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      label: { type: "string" },
      score: { type: "number" },
    },
    required: ["label", "score"],
  };
}

/**
 * Typed size-limit errors expose kind/code/name matching size / oversized /
 * max.?bytes / input.?too.?large (case-insensitive).
 */
export function isTypedSizeLimitError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "string") {
    return /size|oversized|max.?bytes|too.?large|input.?limit/i.test(err);
  }
  if (typeof err !== "object") return false;
  const row = err as Record<string, unknown>;
  const tokens = [row.kind, row.code, row.name, row.type, row.message]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  if (/size_limit|input_too_large|oversized|max_input|VisionInputTooLarge/i.test(tokens)) {
    return true;
  }
  return /size|oversized|max.?bytes|too.?large|input.?limit/i.test(tokens);
}

export function createVisionSizeLimitError(
  maxInputBytes: number,
  actualBytes: number,
): Error {
  return Object.assign(
    new Error(
      `input exceeds maxInputBytes=${maxInputBytes} (got ${actualBytes})`,
    ),
    {
      name: "VisionInputTooLargeError",
      code: "input_too_large",
      kind: "size_limit",
      maxInputBytes,
      actualBytes,
    },
  );
}

/** Lightweight JSON Schema object validation (required + string/number types). */
export function validateAnswerAgainstSchema(
  answer: string,
  schema: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return { ok: false, message: "answer is not valid JSON" };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "answer JSON must be a non-null object" };
  }
  const obj = parsed as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      )
    : [];
  for (const key of required.slice(0, VISION_SCHEMA_KEY_SCAN_LIMIT)) {
    if (!(key in obj) || obj[key] === undefined) {
      return { ok: false, message: `missing required property '${key}'` };
    }
  }
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  for (const key of Object.keys(properties).slice(0, VISION_SCHEMA_KEY_SCAN_LIMIT)) {
    if (!(key in obj)) continue;
    const prop = properties[key];
    if (!prop || typeof prop !== "object" || Array.isArray(prop)) continue;
    const expectedType = (prop as Record<string, unknown>).type;
    if (expectedType === "string" && typeof obj[key] !== "string") {
      return { ok: false, message: `property '${key}' must be a string` };
    }
    if (expectedType === "number" && typeof obj[key] !== "number") {
      return { ok: false, message: `property '${key}' must be a number` };
    }
  }
  return { ok: true, value: obj };
}

export function defineRejectOversizedObligation(): Obligation<VisionConformanceHarness> {
  return defineObligation({
    id: VISION_OBLIGATION_IDS.rejectOversized,
    contract: "VisionInterface",
    mustText: MUST_REJECT_OVERSIZED,
    specIds: ["CK-06"],
    async check(impl, ctx) {
      const max = impl.vision.maxInputBytes;
      if (!Number.isFinite(max) || max <= 0) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.rejectOversized,
          mustText: MUST_REJECT_OVERSIZED,
          contract: "VisionInterface",
          message: "maxInputBytes must be a positive finite number",
        });
      }

      const oversize = Math.min(max + 1, max + 16);
      // Cap oversize construction so probes stay bounded.
      const byteLength = Math.min(oversize, max + VISION_REFERENCE_MAX_INPUT_BYTES);
      const request: VisualAnalysisRequest = {
        input: buildVisionProbeInput(byteLength, ctx),
        instruction: buildVisionProbeInstruction(ctx),
      };
      if (request.input.data.byteLength <= max) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.rejectOversized,
          mustText: MUST_REJECT_OVERSIZED,
          contract: "VisionInterface",
          message: "probe construction failed to exceed maxInputBytes",
        });
      }

      const before = impl.processedCount();
      let result: VisualAnalysisResult | undefined;
      let thrown: unknown;
      try {
        result = await impl.vision.analyze(request);
      } catch (err) {
        thrown = err;
      }

      if (result !== undefined) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.rejectOversized,
          mustText: MUST_REJECT_OVERSIZED,
          contract: "VisionInterface",
          message:
            "oversized input resolved successfully (silent degradation) instead of typed rejection",
        });
      }
      if (!isTypedSizeLimitError(thrown)) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.rejectOversized,
          mustText: MUST_REJECT_OVERSIZED,
          contract: "VisionInterface",
          message: `oversized input must throw a typed size-limit error; got: ${
            thrown instanceof Error ? thrown.message : String(thrown)
          }`,
        });
      }
      if (impl.processedCount() !== before) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.rejectOversized,
          mustText: MUST_REJECT_OVERSIZED,
          contract: "VisionInterface",
          message:
            "oversized input was processed before rejection (must reject before processing)",
        });
      }
    },
  });
}

export function defineSchemaValidJsonObligation(): Obligation<VisionConformanceHarness> {
  return defineObligation({
    id: VISION_OBLIGATION_IDS.schemaValidJson,
    contract: "VisionInterface",
    mustText: MUST_SCHEMA_VALID_JSON,
    specIds: ["CK-06"],
    async check(impl, ctx) {
      const max = impl.vision.maxInputBytes;
      if (!Number.isFinite(max) || max <= 0) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.schemaValidJson,
          mustText: MUST_SCHEMA_VALID_JSON,
          contract: "VisionInterface",
          message: "maxInputBytes must be a positive finite number",
        });
      }

      const schema = buildVisionProbeResponseSchema();
      const request: VisualAnalysisRequest = {
        input: buildVisionProbeInput(Math.min(8, max), ctx),
        instruction: buildVisionProbeInstruction(ctx),
        responseSchema: schema,
      };

      let result: VisualAnalysisResult;
      try {
        result = await impl.vision.analyze(request);
      } catch (err) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.schemaValidJson,
          mustText: MUST_SCHEMA_VALID_JSON,
          contract: "VisionInterface",
          message: `analyze() threw under responseSchema: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (typeof result.answer !== "string" || result.answer.length === 0) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.schemaValidJson,
          mustText: MUST_SCHEMA_VALID_JSON,
          contract: "VisionInterface",
          message: "analyze() returned empty answer under responseSchema",
        });
      }
      const validated = validateAnswerAgainstSchema(result.answer, schema);
      if (!validated.ok) {
        throw new ObligationViolation({
          obligationId: VISION_OBLIGATION_IDS.schemaValidJson,
          mustText: MUST_SCHEMA_VALID_JSON,
          contract: "VisionInterface",
          message: `answer is not schema-valid JSON: ${validated.message}`,
        });
      }
    },
  });
}

export function registerRejectOversizedObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineRejectOversizedObligation());
  return registry;
}

export function registerSchemaValidJsonObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineSchemaValidJsonObligation());
  return registry;
}

export function registerVisionObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerRejectOversizedObligation(registry);
  registerSchemaValidJsonObligation(registry);
  return registry;
}

export function createRejectOversizedObligationRegistry(): ObligationRegistry {
  return registerRejectOversizedObligation(new ObligationRegistry());
}

export function createSchemaValidJsonObligationRegistry(): ObligationRegistry {
  return registerSchemaValidJsonObligation(new ObligationRegistry());
}

export function createVisionObligationsRegistry(): ObligationRegistry {
  return registerVisionObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories ── */

type VisionFactoryOptions = {
  maxInputBytes: number;
  /** Accept oversized without throwing (violate CK-06.1). */
  acceptOversized: boolean;
  /** Throw untyped Error on oversized (violate CK-06.1 typing). */
  untypedSizeError: boolean;
  /** Process body before rejecting oversized (violate before-processing). */
  processBeforeReject: boolean;
  /** Return non-schema JSON / free text when schema set (violate CK-06.2). */
  invalidSchemaAnswer: boolean;
};

function createVisionFactory(
  options: VisionFactoryOptions,
): () => VisionConformanceHarness {
  return () => {
    let processed = 0;
    const vision: VisionInterface = {
      get maxInputBytes() {
        return options.maxInputBytes;
      },
      async analyze(request) {
        const bytes = request.input.data.byteLength;
        if (bytes > options.maxInputBytes) {
          if (options.processBeforeReject) {
            processed += 1;
          }
          if (options.acceptOversized) {
            processed += 1;
            return {
              answer: "probe.ck06.degraded",
              confidence: 0.1,
            };
          }
          if (options.untypedSizeError) {
            throw new Error("failed");
          }
          throw createVisionSizeLimitError(options.maxInputBytes, bytes);
        }

        processed += 1;
        if (request.responseSchema) {
          if (options.invalidSchemaAnswer) {
            return {
              answer: "not-json-free-text",
              confidence: 0.5,
            };
          }
          return {
            answer: JSON.stringify({
              label: "probe.ck06.label",
              score: 0.91,
            }),
            confidence: 0.91,
          };
        }
        return {
          answer: "probe.ck06.free-text",
          confidence: 0.8,
        };
      },
    };
    return {
      vision,
      processedCount: () => processed,
    };
  };
}

/**
 * Known-good reference: typed size rejection before processing; schema-valid JSON.
 */
export function createStrictVisionHarnessFactory(): () => VisionConformanceHarness {
  return createVisionFactory({
    maxInputBytes: VISION_REFERENCE_MAX_INPUT_BYTES,
    acceptOversized: false,
    untypedSizeError: false,
    processBeforeReject: false,
    invalidSchemaAnswer: false,
  });
}

/** Violation for CK-06.1: silently accepts oversized input. */
export function createAcceptOversizedVisionHarnessFactory(): () => VisionConformanceHarness {
  return createVisionFactory({
    maxInputBytes: VISION_REFERENCE_MAX_INPUT_BYTES,
    acceptOversized: true,
    untypedSizeError: false,
    processBeforeReject: false,
    invalidSchemaAnswer: false,
  });
}

/** Violation for CK-06.1: rejects oversized with an untyped error. */
export function createUntypedSizeErrorVisionHarnessFactory(): () => VisionConformanceHarness {
  return createVisionFactory({
    maxInputBytes: VISION_REFERENCE_MAX_INPUT_BYTES,
    acceptOversized: false,
    untypedSizeError: true,
    processBeforeReject: false,
    invalidSchemaAnswer: false,
  });
}

/** Violation for CK-06.1: processes then rejects (ordering). */
export function createProcessBeforeRejectVisionHarnessFactory(): () => VisionConformanceHarness {
  return createVisionFactory({
    maxInputBytes: VISION_REFERENCE_MAX_INPUT_BYTES,
    acceptOversized: false,
    untypedSizeError: false,
    processBeforeReject: true,
    invalidSchemaAnswer: false,
  });
}

/** Violation for CK-06.2: answer is not schema-valid JSON. */
export function createInvalidSchemaAnswerVisionHarnessFactory(): () => VisionConformanceHarness {
  return createVisionFactory({
    maxInputBytes: VISION_REFERENCE_MAX_INPUT_BYTES,
    acceptOversized: false,
    untypedSizeError: false,
    processBeforeReject: false,
    invalidSchemaAnswer: true,
  });
}
