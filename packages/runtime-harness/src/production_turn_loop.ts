/**
 * Production turn loop — ToolCallParser + StreamingTurnHost + sandbox
 * registry + correction loop. Gym and hosts share this path; no gym-local
 * parser / sandbox / correction reimplementation.
 */

import type { ToolDescriptor } from "@moolam/contracts";
import {
  parseToolCallEnvelopeJson,
  type HarnessFrame,
} from "@moolam/sync-protocol";
import {
  CORRECTION_RULE_ENVELOPE,
  CORRECTION_RULE_SANDBOX,
  StreamingTurnCorrectionLoop,
} from "./correction_loop.js";
import {
  InProcessFakeToolRegistry,
  createSandboxSeam,
  invokeSandboxAndMap,
  type SandboxSeam,
} from "./sandbox_seam.js";
import { StreamingTurnHost } from "./streaming_turn.js";
import {
  ToolCallParser,
  type ParseEvent,
} from "./tool_call_parser.js";
import {
  registerLearnedSummarizeTool,
  type RegisterLearnedSummarizeToolOptions,
} from "./learned_summarize.js";

const MAX_FRAMES = 512;
const DEFAULT_PINNED_AT = "2026-07-15T00:00:00.000Z";
const DEFAULT_PROTOCOL_ADVISORY = Object.freeze({
  code: "CLOCK_SKEW_CLAMPED",
  detail: "clamped remote physical",
});
const TRUNCATED_RE = /^<stream truncated>$/i;
const DEFAULT_TOOL_CALL_ID = "c1";
const DEFAULT_DEADLINE_MS = 5_000;

export type ProductionTurnLoopFailureClass =
  | "missing_subject"
  | "invalid_input"
  | "frame_budget_exceeded"
  | "host_reject"
  | "cross_subject"
  | "config";

export type ProductionTurnLoopTelemetry = {
  event: "runtime.harness.production_turn_loop";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  turnId?: string;
  seed?: number;
  frameCount?: number;
  toolInvocations?: number;
  failureClass?: ProductionTurnLoopFailureClass;
  detail?: string;
};

export type ProductionTurnLoopAccepted = {
  ok: true;
  frames: HarnessFrame[];
  subjectId: string;
  deviceId: string;
  turnId: string;
  toolInvocations: number;
  correctionDepth: number;
};

export type ProductionTurnLoopRejected = {
  ok: false;
  failureClass: ProductionTurnLoopFailureClass;
  detail: string;
  subjectId: string | null;
  deviceId: string | null;
  frames: HarnessFrame[];
};

export type ProductionTurnLoopResult =
  | ProductionTurnLoopAccepted
  | ProductionTurnLoopRejected;

export type ProductionTurnLoopOptions = {
  subjectId: string;
  deviceId: string;
  correlationId: string;
  turnId: string;
  chunks: string[];
  /** Bound gym / determinism seed (observability + episode bind). */
  seed?: number;
  pinnedAt?: string;
  /**
   * Tool registry for sandbox invokes. When omitted, a default in-process
   * registry with a `lookup` read tool is created.
   */
  registry?: InProcessFakeToolRegistry;
  /** Soft deadline for each sandbox invoke. */
  toolDeadlineMs?: number;
  onTelemetry?: (e: ProductionTurnLoopTelemetry) => void;
};

function lookupDescriptor(): ToolDescriptor {
  return {
    name: "lookup",
    description: "deterministic read lookup for harness / gym turns",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    riskClass: "read",
  };
}

/**
 * Default gym / harness tool registry — lookup succeeds deterministically.
 * Learned summarization is absent unless its explicit feature flag is enabled.
 */
export function createDefaultGymToolRegistry(options?: {
  learnedSummarize?: RegisterLearnedSummarizeToolOptions;
}): InProcessFakeToolRegistry {
  const registry = new InProcessFakeToolRegistry();
  registry.register({
    descriptor: lookupDescriptor(),
    effect: async (args) => ({
      ok: true,
      query: typeof args.query === "string" ? args.query : "",
    }),
  });
  if (options?.learnedSummarize !== undefined) {
    registerLearnedSummarizeTool(registry, options.learnedSummarize);
  }
  return registry;
}

function emitTel(
  onTelemetry: ((e: ProductionTurnLoopTelemetry) => void) | undefined,
  partial: Omit<ProductionTurnLoopTelemetry, "event">,
): void {
  onTelemetry?.({ event: "runtime.harness.production_turn_loop", ...partial });
}

/**
 * Drive one turn on the production code path:
 * ToolCallParser → (sandbox invoke via registry) → StreamingTurnHost frames,
 * with StreamingTurnCorrectionLoop on envelope failures.
 */
export async function runProductionTurnLoop(
  opts: ProductionTurnLoopOptions,
): Promise<ProductionTurnLoopResult> {
  const subjectId = opts.subjectId.trim();
  const deviceId = opts.deviceId.trim();
  const correlationId = opts.correlationId.trim();
  const turnId = opts.turnId.trim();
  const pinnedAt = opts.pinnedAt?.trim() || DEFAULT_PINNED_AT;
  const deadlineMs = opts.toolDeadlineMs ?? DEFAULT_DEADLINE_MS;

  const fail = (
    failureClass: ProductionTurnLoopFailureClass,
    detail: string,
    frames: HarnessFrame[] = [],
  ): ProductionTurnLoopRejected => {
    emitTel(opts.onTelemetry, {
      outcome: "rejected",
      subjectId: subjectId || null,
      ...(deviceId ? { deviceId } : {}),
      turnId,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      failureClass,
      detail,
      frameCount: frames.length,
    });
    return {
      ok: false,
      failureClass,
      detail,
      subjectId: subjectId || null,
      deviceId: deviceId || null,
      frames,
    };
  };

  if (!subjectId) {
    return fail("missing_subject", "subjectId required for production turn loop");
  }
  if (!correlationId || !turnId) {
    return fail("invalid_input", "correlationId and turnId required");
  }
  if (!Array.isArray(opts.chunks) || opts.chunks.length < 1) {
    return fail("invalid_input", "chunks must be a non-empty string[]");
  }
  if (opts.chunks.some((c) => typeof c !== "string")) {
    return fail("invalid_input", "chunks entries must be strings");
  }

  const frames: HarnessFrame[] = [];
  const host = new StreamingTurnHost({
    subjectId,
    correlationId,
    deviceId,
    onFrame: (f) => {
      if (frames.length < MAX_FRAMES) frames.push(f);
    },
  });

  const parser = new ToolCallParser({ subjectId, deviceId });
  const registry = opts.registry ?? createDefaultGymToolRegistry();
  const seam: SandboxSeam = createSandboxSeam({
    registry,
    subjectId,
    deviceId,
  });

  let toolInvocations = 0;
  let correctionDepth = 0;
  let truncated = false;

  const correction = new StreamingTurnCorrectionLoop({
    host,
    parser,
    turnId,
    resumeModel: async () => ({ chunks: [] }),
  });

  const session = host.emitSessionStart(pinnedAt);
  if (!session.ok) {
    return fail("host_reject", session.detail ?? "emitSessionStart failed", frames);
  }

  const applyEvents = async (
    events: ParseEvent[],
  ): Promise<ProductionTurnLoopRejected | null> => {
    for (const ev of events) {
      if (frames.length >= MAX_FRAMES) {
        return fail(
          "frame_budget_exceeded",
          `frame budget ${MAX_FRAMES} exceeded`,
          frames,
        );
      }
      if (ev.type === "mode_change" || ev.type === "tool_buffer_delta") {
        continue;
      }
      if (ev.type === "violation") {
        continue;
      }
      if (ev.type === "thought_delta") {
        const r = host.emitThoughtDelta(ev.delta);
        if (!r.ok) {
          return fail("host_reject", r.detail ?? "emitThoughtDelta failed", frames);
        }
        continue;
      }
      if (ev.type === "answer_delta") {
        const r = host.emitAnswerDelta(ev.delta);
        if (!r.ok) {
          return fail("host_reject", r.detail ?? "emitAnswerDelta failed", frames);
        }
        continue;
      }
      if (ev.type === "tool_buffer") {
        const parsed = parseToolCallEnvelopeJson(ev.body);
        if (!parsed.ok) {
          const handled = await correction.handleValidationFailure(
            {
              kind: "envelope_invalid",
              rule: CORRECTION_RULE_ENVELOPE,
              code: parsed.error.code,
              toolCallId: DEFAULT_TOOL_CALL_ID,
              message: "tool call JSON is not valid",
              requiresParserReset: true,
            },
            { subjectId },
          );
          correctionDepth = Math.max(correctionDepth, handled.depth ?? 0);
          if (!handled.ok && handled.action === "exhausted") {
            return null;
          }
          continue;
        }

        const first = parsed.envelope[0];
        const toolName =
          typeof first?.toolName === "string" ? first.toolName.trim() : "";
        const toolCallId =
          typeof first?.callId === "string" && first.callId.length > 0
            ? first.callId
            : DEFAULT_TOOL_CALL_ID;
        const args =
          first?.arguments &&
          typeof first.arguments === "object" &&
          !Array.isArray(first.arguments)
            ? (first.arguments as Record<string, unknown>)
            : {};

        const running = host.emitToolStatus({
          toolCallId,
          status: "running",
        });
        if (!running.ok) {
          return fail("host_reject", running.detail ?? "emitToolStatus failed", frames);
        }

        const spec = registry.get(toolName);
        if (!spec) {
          const errStatus = host.emitToolStatus({
            toolCallId,
            status: "error",
            detail: `unknown_tool:${toolName || "(empty)"}`,
          });
          if (!errStatus.ok) {
            return fail(
              "host_reject",
              errStatus.detail ?? "emitToolStatus failed",
              frames,
            );
          }
          toolInvocations += 1;
          continue;
        }

        toolInvocations += 1;
        const mapped = await invokeSandboxAndMap(
          seam,
          spec.descriptor,
          args,
          {
            subjectId,
            deviceId,
            invocationId: toolCallId,
            deadlineMs,
            idempotencyKey: toolCallId,
            ...(spec.descriptor.riskClass === "write" ||
            spec.descriptor.riskClass === "critical"
              ? { writeAheadRecorded: true as const }
              : {}),
          },
          {
            subjectId,
            correlationId,
            sequenceIndex: host.peekNextSequenceIndex(),
            toolCallId,
          },
        );

        const statusEmit = host.emitToolStatus({
          toolCallId: mapped.toolStatus.toolCallId,
          status: mapped.toolStatus.status,
          ...(mapped.toolStatus.detail !== undefined
            ? { detail: mapped.toolStatus.detail }
            : {}),
        });
        if (!statusEmit.ok) {
          return fail(
            "host_reject",
            statusEmit.detail ?? "emitToolStatus failed",
            frames,
          );
        }

        if (!mapped.result.ok) {
          const repaired = await correction.handleValidationFailure(
            {
              kind: "sandbox_error",
              rule: CORRECTION_RULE_SANDBOX,
              code: mapped.result.failureClass,
              toolCallId,
              message: mapped.result.error.message,
              requiresParserReset: false,
            },
            { subjectId },
          );
          correctionDepth = Math.max(correctionDepth, repaired.depth ?? 0);
          if (!repaired.ok && repaired.action === "exhausted") {
            return null;
          }
        }
      }
    }
    return null;
  };

  for (const chunk of opts.chunks) {
    if (host.isTerminated) break;
    if (TRUNCATED_RE.test(chunk)) {
      truncated = true;
      const endErr = await applyEvents(parser.end());
      if (endErr) return endErr;
      break;
    }
    const feedErr = await applyEvents(parser.feed(chunk));
    if (feedErr) return feedErr;
    if (host.isTerminated) break;
  }

  if (!truncated && !host.isTerminated) {
    const endErr = await applyEvents(parser.end());
    if (endErr) return endErr;
  }

  if (!host.isTerminated) {
    const advisory = host.emitAdvisoryAttach({ ...DEFAULT_PROTOCOL_ADVISORY });
    if (!advisory.ok) {
      return fail("host_reject", advisory.detail ?? "emitAdvisoryAttach failed", frames);
    }

    if (truncated) {
      const err = host.emitHarnessError({
        code: "STREAM_TRUNCATED",
        message: "peer closed before TURN_COMPLETE",
        recoverable: true,
      });
      if (!err.ok) {
        return fail("host_reject", err.detail ?? "emitHarnessError failed", frames);
      }
    } else {
      const done = host.emitTurnComplete(turnId);
      if (!done.ok) {
        return fail("host_reject", done.detail ?? "emitTurnComplete failed", frames);
      }
    }
  }

  for (const frame of frames) {
    if (frame.subjectId !== subjectId) {
      return fail(
        "cross_subject",
        "assembled frame subjectId mismatch",
        frames,
      );
    }
  }

  if (frames.length > MAX_FRAMES) {
    return fail(
      "frame_budget_exceeded",
      `frame budget ${MAX_FRAMES} exceeded`,
      frames,
    );
  }

  emitTel(opts.onTelemetry, {
    outcome: "ok",
    subjectId,
    deviceId,
    turnId,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    frameCount: frames.length,
    toolInvocations,
    detail: `correctionDepth=${correctionDepth}`,
  });

  return {
    ok: true,
    frames,
    subjectId,
    deviceId,
    turnId,
    toolInvocations,
    correctionDepth,
  };
}
