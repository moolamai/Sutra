/**
 * @module tool_stage
 *
 * Act-stage tool invocation loop (`tool_stage.ts`).
 *
 * Accepts a generation result + message list. On `finishReason: "tool-call"`,
 * parse the A P6 fenced-JSON tool-call envelope (single object or array:
 * `{ toolName, arguments, callId? }`), invoke via `ToolInterface` through an
 * injectable policy hook, append structured assistant/tool messages (never
 * raw prose on the user role), then re-engage `model.generate` until a
 * terminal finish reason or the per-turn iteration cap.
 *
 * Wired into CognitiveCore.turn : first generate, then this loop,
 * then reflect. Module stays a pure stage so harness.ts remains linear.
 * Integration coverage: tests/act_stage_integration.test.mjs .
 * Every invoke goes through `invokeThroughToolPolicy`.
 * Act stage awaits audit acknowledgment before effect;
 * default in-memory sink when unset; failures short-circuit with ToolAuditError.
 * B0 CK-07.2 vs composed bindings
 *   tests/write_ahead_conformance.test.mjs
 */

import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  ModelInterface,
  ToolInterface,
  ToolInvocation,
  ToolResult,
} from "@moolam/contracts";
import {
  ToolPolicyError,
  defaultDenyToolPolicyHooks,
  invokeThroughToolPolicy,
  lookupToolDescriptor,
  resolveRiskClass,
  type ToolPolicyEvent,
  type ToolPolicyHooks,
} from "./tool_policy.js";
import {
  ToolAuditError,
  assertAuditBeforeEffect,
  createInMemoryAuditSink,
  requiresWriteAheadAudit,
  type AuditSink,
  type ToolAuditEvent,
} from "./tool_audit.js";

/** Per-turn tool/generate iteration cap (mirrors B4 MAX_CORRECTION discipline). */
export const ACT_STAGE_MAX_ITERATIONS = 8;

/** Max tool calls executed from one generation envelope. */
export const ACT_STAGE_TOOL_CALL_LIMIT = 16;

/** Default wall-clock budget passed to ToolInterface.invoke. */
export const ACT_STAGE_TOOL_DEADLINE_MS = 5_000;

/** Obligation: iteration counter must escalate, never silent unbounded loop. */
export const ACT_STAGE_OBLIGATION_MAX_ITERATIONS = "ACT.MAX_ITERATIONS";

/** Obligation: invalid tool-call envelope must not be silently skipped. */
export const ACT_STAGE_OBLIGATION_ENVELOPE = "ACT.ENVELOPE_INVALID";

/** A P6 envelope entry — consume-only shape (Zod lives in sync-protocol P6). */
export type ToolCallEnvelopeEntry = {
  toolName: string;
  arguments: Record<string, unknown>;
  callId?: string;
};

export type ToolStageOutcome =
  | "completed"
  | "tool_loop"
  | "buffer_discarded"
  | "error";

export type ToolStageEvent = {
  event: "cognitive_core.tool_stage";
  subjectId: string;
  sessionId: string;
  outcome: ToolStageOutcome;
  iteration: number;
  toolName?: string;
  toolStatus?: ToolResult["status"];
  failureClass?: "validation" | "contract" | "downstream" | "cap" | "config";
  /** Envelope parse failure code — never stack traces / arg bodies. */
  errorCode?: string;
};

export class ToolStageError extends Error {
  readonly obligationId: string | null;
  readonly failureClass: "validation" | "contract" | "downstream" | "cap" | "config";
  readonly errorCode: string | null;

  constructor(
    message: string,
    opts: {
      obligationId?: string | null;
      failureClass?: "validation" | "contract" | "downstream" | "cap" | "config";
      errorCode?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "ToolStageError";
    this.obligationId = opts.obligationId ?? null;
    this.failureClass = opts.failureClass ?? "validation";
    this.errorCode = opts.errorCode ?? null;
  }
}

/**
 * Policy seam: hosts (tool-policy-engine) wrap invoke; default is direct
 * `tools.invoke`. Act stage MUST NOT call tools.invoke except through this hook.
 */
export type ToolInvokeHook = (
  invocation: ToolInvocation,
  deadlineMs: number,
  tools: ToolInterface,
) => Promise<ToolResult>;

export const defaultToolInvokeHook: ToolInvokeHook = (
  invocation,
  deadlineMs,
  tools,
) => tools.invoke(invocation, deadlineMs);

const TERMINAL_REASONS = new Set<GenerateResult["finishReason"]>([
  "stop",
  "length",
  "deadline",
  "content-filter",
]);

const FENCE_RE =
  /```(?:tool_call|json)\s*\r?\n([\s\S]*?)\r?\n```/i;

export type ToolStageInput = {
  subjectId: string;
  sessionId: string;
  model: ModelInterface;
  tools: ToolInterface;
  /** Working transcript — copied; caller receives the extended list. */
  messages: readonly ChatMessage[];
  /** Generation that may request tools. */
  generation: GenerateResult;
  /**
   * Open stream tool buffer from a prior partial parse. When generation
   * finishes with a terminal reason while this is set, the buffer is
   * discarded and never executed (§5).
   */
  pendingStreamBuffer?: string | null;
  maxIterations?: number;
  toolDeadlineMs?: number;
  generateOptions?: GenerateOptions;
  /**
   * Risk-policy hooks . Defaults to deny-by-default: read/compute
   * auto-allow; write/critical require host approval hooks.
   */
  policyHooks?: ToolPolicyHooks;
  /** Optional device token forwarded to policy telemetry. */
  deviceId?: string;
  /**
   * Post-policy effect path. Called only after policy allow.
   * Defaults to tools.invoke.
   */
  invokeHook?: ToolInvokeHook;
  /**
   * Write-ahead audit sink .
   * - `undefined` → act stage installs a per-turn in-memory sink (by construction)
   * - `null` → intentional defect path (write/critical hard-stop without sink)
   * - concrete sink → host-injected durable / shared sink
   */
  auditSink?: AuditSink | null;
  emit?: (event: ToolStageEvent | ToolPolicyEvent | ToolAuditEvent) => void;
};

export type ToolStageResult = {
  messages: ChatMessage[];
  generation: GenerateResult;
  iterations: number;
  toolInvocations: number;
  discardedPendingBuffer: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one A P6 tool-call entry; strip unknown keys at the boundary.
 */
export function parseToolCallEntry(raw: unknown): ToolCallEnvelopeEntry {
  if (!isPlainObject(raw)) {
    throw new ToolStageError("tool call entry must be an object", {
      obligationId: ACT_STAGE_OBLIGATION_ENVELOPE,
      failureClass: "validation",
      errorCode: "ENVELOPE_SHAPE",
    });
  }
  const toolName = raw.toolName;
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    throw new ToolStageError("toolName required", {
      obligationId: ACT_STAGE_OBLIGATION_ENVELOPE,
      failureClass: "validation",
      errorCode: "ENVELOPE_TOOL_NAME",
    });
  }
  if (!isPlainObject(raw.arguments)) {
    throw new ToolStageError("arguments must be an object", {
      obligationId: ACT_STAGE_OBLIGATION_ENVELOPE,
      failureClass: "validation",
      errorCode: "ENVELOPE_ARGUMENTS",
    });
  }
  const entry: ToolCallEnvelopeEntry = {
    toolName: toolName.trim(),
    arguments: { ...raw.arguments },
  };
  if (typeof raw.callId === "string" && raw.callId.trim().length > 0) {
    entry.callId = raw.callId.trim().slice(0, 128);
  }
  return entry;
}

/**
 * Extract fenced tool-call envelope from model text (single or array form).
 * Invalid / missing fence → structured error (never silent skip).
 */
export function parseToolCallEnvelope(text: string): ToolCallEnvelopeEntry[] {
  const match = FENCE_RE.exec(text ?? "");
  if (!match) {
    throw new ToolStageError(
      "tool-call finishReason without a valid fenced envelope",
      {
        obligationId: ACT_STAGE_OBLIGATION_ENVELOPE,
        failureClass: "validation",
        errorCode: "ENVELOPE_MISSING_FENCE",
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!.trim());
  } catch {
    throw new ToolStageError("fenced tool-call JSON is not parseable", {
      obligationId: ACT_STAGE_OBLIGATION_ENVELOPE,
      failureClass: "validation",
      errorCode: "ENVELOPE_JSON",
    });
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) {
    throw new ToolStageError("tool-call envelope is empty", {
      obligationId: ACT_STAGE_OBLIGATION_ENVELOPE,
      failureClass: "validation",
      errorCode: "ENVELOPE_EMPTY",
    });
  }
  if (items.length > ACT_STAGE_TOOL_CALL_LIMIT) {
    throw new ToolStageError("tool-call envelope exceeds call limit", {
      obligationId: ACT_STAGE_OBLIGATION_ENVELOPE,
      failureClass: "validation",
      errorCode: "ENVELOPE_TOO_MANY",
    });
  }
  return items.map(parseToolCallEntry);
}

/** Build a fenced envelope string for tests / fixtures (A P6 shape). */
export function formatToolCallFence(
  calls: ToolCallEnvelopeEntry | ToolCallEnvelopeEntry[],
): string {
  const body = JSON.stringify(calls, null, 2);
  return `\`\`\`tool_call\n${body}\n\`\`\``;
}

/**
 * Run the act-stage loop after an initial generation.
 */
export async function runActStage(
  input: ToolStageInput,
): Promise<ToolStageResult> {
  const subjectId = input.subjectId.trim();
  const sessionId = input.sessionId.trim();
  if (!subjectId) {
    throw new ToolStageError("act stage requires subjectId (subject isolation)", {
      failureClass: "validation",
      errorCode: "SUBJECT_REQUIRED",
    });
  }
  if (!sessionId) {
    throw new ToolStageError("act stage requires sessionId", {
      failureClass: "validation",
      errorCode: "SESSION_REQUIRED",
    });
  }

  const maxIterations = Math.max(
    1,
    Math.min(
      input.maxIterations ?? ACT_STAGE_MAX_ITERATIONS,
      ACT_STAGE_MAX_ITERATIONS,
    ),
  );
  const toolDeadlineMs = input.toolDeadlineMs ?? ACT_STAGE_TOOL_DEADLINE_MS;
  const policyHooks = input.policyHooks ?? defaultDenyToolPolicyHooks;
  const invoke = input.invokeHook ?? defaultToolInvokeHook;
  /**
   * Every act-stage turn has an audit sink unless the host
   * explicitly passes `null` (config defect tests). Acknowledgment is awaited
   * inside `invokeThroughToolPolicy` / `recordThenInvoke` before effect.
   */
  const auditSink: AuditSink | null =
    input.auditSink === undefined ? createInMemoryAuditSink() : input.auditSink;
  const emit = input.emit;
  const messages: ChatMessage[] = input.messages.map((m) => ({ ...m }));
  let generation = input.generation;
  let iterations = 0;
  let toolInvocations = 0;
  let discardedPendingBuffer = false;
  const pending = input.pendingStreamBuffer?.trim() || null;

  try {
    // Terminal finish with an open stream buffer → discard, do not execute.
    if (
      TERMINAL_REASONS.has(generation.finishReason) &&
      pending &&
      generation.finishReason !== "tool-call"
    ) {
      discardedPendingBuffer = true;
      emit?.({
        event: "cognitive_core.tool_stage",
        subjectId,
        sessionId,
        outcome: "buffer_discarded",
        iteration: 0,
      });
      return {
        messages,
        generation,
        iterations: 0,
        toolInvocations: 0,
        discardedPendingBuffer: true,
      };
    }

    while (generation.finishReason === "tool-call") {
      iterations += 1;
      if (iterations > maxIterations) {
        throw new ToolStageError(
          `act stage exceeded maxIterations=${maxIterations}`,
          {
            obligationId: ACT_STAGE_OBLIGATION_MAX_ITERATIONS,
            failureClass: "cap",
            errorCode: "MAX_ITERATIONS",
          },
        );
      }

      const calls = parseToolCallEnvelope(generation.text);

      // Assistant message carries the fenced envelope (structured), never
      // folded into a user turn.
      messages.push({
        role: "assistant",
        content: generation.text,
      });

      for (const call of calls) {
        const invocationId =
          call.callId ??
          `inv-${subjectId.slice(0, 24)}-${toolInvocations + 1}-${crypto.randomUUID().slice(0, 8)}`;
        const invocation: ToolInvocation = {
          toolName: call.toolName,
          arguments: call.arguments,
          invocationId,
        };
        // + : policy gate, then await audit
        // acknowledgment before ToolInterface.invoke for write/critical.
        const descriptor = lookupToolDescriptor(
          input.tools,
          call.toolName,
        );
        const { riskClass } = resolveRiskClass(descriptor);
        const result = await invokeThroughToolPolicy({
          subjectId,
          sessionId,
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
          invocation,
          tools: input.tools,
          hooks: policyHooks,
          deadlineMs: toolDeadlineMs,
          invokeHook: invoke,
          auditSink,
          ...(emit
            ? {
                emit: (e: ToolPolicyEvent | ToolAuditEvent) => {
                  emit(e);
                },
              }
            : {}),
        });
        if (auditSink && requiresWriteAheadAudit(riskClass)) {
          // Short-circuits (policy deny) produce neither audit nor effect;
          // assertAuditBeforeEffect no-ops in that case.
          assertAuditBeforeEffect(
            auditSink.records(),
            invocationId,
            riskClass,
          );
        }
        toolInvocations += 1;
        messages.push({
          role: "tool",
          toolCallId: invocationId,
          content: JSON.stringify({
            status: result.status,
            // Structured tool payload only — hosts must not put utterances here.
            output: result.output ?? null,
          }),
        });
        emit?.({
          event: "cognitive_core.tool_stage",
          subjectId,
          sessionId,
          outcome: "tool_loop",
          iteration: iterations,
          toolName: call.toolName.slice(0, 64),
          toolStatus: result.status,
        });
      }

      generation = await input.model.generate(messages, input.generateOptions);
    }

    emit?.({
      event: "cognitive_core.tool_stage",
      subjectId,
      sessionId,
      outcome: "completed",
      iteration: iterations,
    });

    return {
      messages,
      generation,
      iterations,
      toolInvocations,
      discardedPendingBuffer,
    };
  } catch (err) {
    if (err instanceof ToolStageError) {
      emit?.({
        event: "cognitive_core.tool_stage",
        subjectId,
        sessionId,
        outcome: "error",
        iteration: iterations,
        failureClass: err.failureClass,
        ...(err.errorCode ? { errorCode: err.errorCode } : {}),
      });
      throw err;
    }
    if (err instanceof ToolPolicyError) {
      emit?.({
        event: "cognitive_core.tool_stage",
        subjectId,
        sessionId,
        outcome: "error",
        iteration: iterations,
        failureClass: err.failureClass,
        ...(err.errorCode ? { errorCode: err.errorCode } : {}),
      });
      throw err;
    }
    if (err instanceof ToolAuditError) {
      emit?.({
        event: "cognitive_core.tool_stage",
        subjectId,
        sessionId,
        outcome: "error",
        iteration: iterations,
        failureClass: err.failureClass,
        ...(err.errorCode ? { errorCode: err.errorCode } : {}),
      });
      throw err;
    }
    emit?.({
      event: "cognitive_core.tool_stage",
      subjectId,
      sessionId,
      outcome: "error",
      iteration: iterations,
      failureClass: "downstream",
    });
    throw err;
  }
}
