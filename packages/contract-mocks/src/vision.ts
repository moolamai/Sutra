/**
 * Reference VisionInterface — typed size rejection + schema-valid JSON (CK-06).
 * Ported from examples/vision with obligation-grade size/schema gates.
 *
 * @module vision
 */

import type {
  VisionInterface,
  VisualAnalysisRequest,
  VisualAnalysisResult,
} from "@moolam/contracts";

import type { ContractMockEmit } from "./events.js";

/** Matches conformance VISION_REFERENCE_MAX_INPUT_BYTES. */
export const VISION_REFERENCE_MAX_INPUT_BYTES = 64;

export const VISION_SCHEMA_KEY_SCAN_LIMIT = 32;

export type VisionMockOptions = {
  maxInputBytes?: number;
  deviceId?: string;
  subjectId?: string;
  emit?: ContractMockEmit;
};

export type VisionMockHarness = {
  vision: VisionInterface;
  processedCount(): number;
};

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

function answerForSchema(
  schema: Record<string, unknown>,
): string {
  // Produce minimal valid JSON for the common probe schema {label, score}.
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter(
        (k): k is string => typeof k === "string",
      )
    : [];
  const obj: Record<string, unknown> = {};
  for (const key of required.slice(0, VISION_SCHEMA_KEY_SCAN_LIMIT)) {
    if (key === "score") obj[key] = 0.91;
    else obj[key] = `probe.ck06.${key}`;
  }
  if (!("label" in obj)) obj.label = "probe.ck06.label";
  if (!("score" in obj)) obj.score = 0.91;
  return JSON.stringify(obj);
}

/**
 * Rejects oversized inputs with a typed error before processing.
 * When responseSchema is set, answer is schema-shaped JSON.
 */
export function createVisionMock(
  options: VisionMockOptions = {},
): VisionInterface & { processedCount(): number } {
  const maxInputBytes =
    options.maxInputBytes ?? VISION_REFERENCE_MAX_INPUT_BYTES;
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  let processed = 0;

  const vision: VisionInterface & { processedCount(): number } = {
    get maxInputBytes() {
      return maxInputBytes;
    },

    processedCount() {
      return processed;
    },

    async analyze(
      request: VisualAnalysisRequest,
    ): Promise<VisualAnalysisResult> {
      const bytes = request.input.data.byteLength;
      try {
        // Size gate BEFORE any processing (CK-06.1).
        if (bytes > maxInputBytes) {
          emit?.({
            event: "contract_mocks.vision",
            op: "analyze",
            subjectId,
            deviceId,
            outcome: "error",
            bytes,
          });
          throw createVisionSizeLimitError(maxInputBytes, bytes);
        }

        processed += 1;
        let result: VisualAnalysisResult;
        if (request.responseSchema) {
          result = {
            answer: answerForSchema(request.responseSchema),
            confidence: 0.91,
          };
        } else {
          // Examples-style OCR of attachment bytes when within limit.
          let ocr = "";
          try {
            ocr = new TextDecoder().decode(request.input.data).slice(0, 280);
          } catch {
            ocr = "probe.ck06.binary";
          }
          result = {
            answer: ocr
              ? `Handwritten content detected: "${ocr}"`
              : "probe.ck06.free-text",
            regions: [
              {
                bbox: [0.1, 0.2, 0.8, 0.3],
                label: "region",
                ...(ocr ? { content: ocr } : {}),
              },
            ],
            confidence: 0.8,
          };
        }
        emit?.({
          event: "contract_mocks.vision",
          op: "analyze",
          subjectId,
          deviceId,
          outcome: "ok",
          bytes,
        });
        return result;
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          (err as { kind?: string }).kind === "size_limit"
        ) {
          throw err;
        }
        emit?.({
          event: "contract_mocks.vision",
          op: "analyze",
          subjectId,
          deviceId,
          outcome: "error",
          bytes,
        });
        throw err;
      }
    },
  };

  return vision;
}

export function createVisionMockHarnessFactory(
  options: VisionMockOptions = {},
): () => VisionMockHarness {
  return () => {
    const vision = createVisionMock(options);
    return {
      vision,
      processedCount: () => vision.processedCount(),
    };
  };
}

export const makeVision = createVisionMock;
