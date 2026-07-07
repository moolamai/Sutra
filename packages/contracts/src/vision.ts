/**
 * @module vision
 *
 * Vision contract - visual understanding for multimodal agents.
 *
 * A user photographs a handwritten equation; a clinician shares a chart;
 * an engineer uploads a schematic; a lawyer scans a contract page. The
 * core treats all of these as `analyze` calls with domain-specific
 * instructions. Implementations may bind local VLMs, cloud vision APIs,
 * or specialist models (OCR, DICOM viewers, CAD parsers) behind one seam.
 */

export interface VisualInput {
  /** Raw bytes; mimeType tells the implementation how to decode. */
  data: Uint8Array;
  mimeType: string; // "image/png", "image/jpeg", "application/pdf" …
}

export interface VisualAnalysisRequest {
  input: VisualInput;
  /** What to extract/understand, in natural language or a task keyword. */
  instruction: string;
  /** Ask for structured output conforming to this JSON Schema. */
  responseSchema?: Record<string, unknown>;
}

export interface VisualRegion {
  /** Normalized [0,1] coordinates: x, y, width, height. */
  bbox: [number, number, number, number];
  label: string;
  /** e.g. the OCR'd text inside the region. */
  content?: string;
}

export interface VisualAnalysisResult {
  /** Free-text or JSON (when responseSchema was provided). */
  answer: string;
  regions?: VisualRegion[];
  confidence: number;
}

/**
 * Contract requirements:
 *  1. Implementations MUST reject inputs above their declared size limits
 *     with a typed error rather than degrading silently.
 *  2. When `responseSchema` is provided, `answer` MUST be valid JSON for it.
 */
export interface VisionInterface {
  readonly maxInputBytes: number;
  analyze(request: VisualAnalysisRequest): Promise<VisualAnalysisResult>;
}
