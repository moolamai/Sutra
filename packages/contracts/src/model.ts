/**
 * @module model
 *
 * Model contract - provider-agnostic inference.
 *
 * One contract for every brain the agent may use: OpenAI-compatible
 * APIs, Anthropic, local llama.cpp/ONNX SLMs (via @moolam/edge-agent's
 * runtime adapters), or fully custom in-house models. The core composes
 * capabilities; it never imports a vendor SDK.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present when role === "tool": which tool call this responds to. */
  toolCallId?: string;
}

export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  /** Hard wall-clock budget in ms; implementations MUST abort on breach. */
  deadlineMs?: number;
  /** JSON Schema the output must conform to (structured generation). */
  responseSchema?: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  finishReason: "stop" | "length" | "deadline" | "content-filter" | "tool-call";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelDescriptor {
  modelId: string;
  contextWindow: number;
  /** Where inference happens — drives data-residency policy decisions. */
  locality: "on-device" | "self-hosted" | "external-api";
  modalities: Array<"text" | "vision" | "audio">;
}

/**
 * The contract every model provider implements.
 *
 * Contract requirements:
 *  1. `embed` dimension MUST be stable per provider instance.
 *  2. Streaming MUST yield deltas, not cumulative text.
 *  3. Providers MUST surface `locality` truthfully — sovereign deployments
 *     gate which localities are permitted per data class.
 */
export interface ModelInterface {
  readonly descriptor: ModelDescriptor;
  generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult>;
  generateStream(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<string>;
  embed(text: string): Promise<Float32Array>;
}
