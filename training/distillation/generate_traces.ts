/**
 * Teacher trace generation through the production runtime harness.
 *
 * Anti-cheat: teacher chunks are fed through ToolCallParser + StreamingTurnHost
 * (and sync-protocol tool-envelope validation) — the same path the student serves.
 * No parallel trace format; frames are A P6 HarnessFrame[].
 *
 * Grammar-violating candidates are dropped with counted reason codes.
 * `filterDistillationCandidates` emits a filter report (counts per violation class).
 */

import {
  THIRD_PARTY_ELIGIBLE_SHARD_CLASSES,
  allowsThirdPartyProcessing,
  assertCorpusDocumentsExactHashDecontaminated,
  loadBaselineRegistryDocumentFromFile,
  type ConsentClass,
  type CorpusShardConsentClass,
} from "@moolam/learning";
import {
  InProcessFakeToolRegistry,
  STREAMING_TURN_MAX_FRAMES,
  STREAMING_TURN_PROTOCOL_VERSION,
  StreamingTurnHost,
  ToolCallParser,
  canonicalizeFramesJson,
  createSandboxSeam,
  type HarnessFrame,
  type ParseEvent,
  type StreamingTurnTelemetryEvent,
} from "@moolam/runtime-harness";
import { parseToolCallEnvelopeJson } from "@moolam/sync-protocol";
import {
  CORPUS_MANIFEST_SCHEMA_VERSION,
  parseCorpusManifest,
  writeCorpusManifest,
} from "@moolam/training-corpus";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { STREAMING_TURN_PROTOCOL_VERSION };

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Package root whether running from source or compiled `dist/`. */
export const DISTILLATION_PACKAGE_ROOT =
  path.basename(HERE) === "dist" ? path.resolve(HERE, "..") : HERE;

/** Soft caps (NFR — bounded scans / retries). */
export const TEACHER_TRACE_BATCH_LIMIT = 64;
export const TEACHER_CHUNK_LIMIT = 128;
export const TEACHER_CHUNK_BYTES_LIMIT = 16 * 1024;

export const TEACHER_TRACE_DROP_REASONS = Object.freeze([
  "tool_envelope",
  "protocol_tag",
  "missing_required_tag",
  "missing_subject",
  "third_party_excluded",
  "subject_data_unconsented",
  "frame_emit",
  "frame_budget",
  "size",
  "config",
] as const);

export type TeacherTraceDropReason = (typeof TEACHER_TRACE_DROP_REASONS)[number];

export type TeacherTraceFailureClass =
  | TeacherTraceDropReason
  | "empty_batch"
  | "internal"
  | "contamination"
  | "consent";

export type TeacherLocality = "on-device" | "self-hosted";

/** Local = on-device / self-hosted teacher; frontier = third-party API path. */
export type TeacherMode = "local" | "frontier";

export type TeacherTraceTelemetry = {
  event: "training.teacher_trace";
  op: "generate" | "drop" | "validate" | "filter" | "export";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  failureClass?: TeacherTraceFailureClass;
  detail?: string;
  turnId?: string;
  frameCount?: number;
  protocolVersion?: string;
  dropReason?: TeacherTraceDropReason;
  scanned?: number;
  accepted?: number;
  dropped?: number;
  manifestId?: string;
};

export type TeacherConsentRecord = {
  optedIn: true;
  consentClass: ConsentClass;
  recordedAt: string;
};

export type GenerateTeacherTraceInput = {
  subjectId: string;
  sessionId: string;
  turnId: string;
  deviceId: string;
  correlationId: string;
  locality: TeacherLocality;
  consent: TeacherConsentRecord;
  /** Frontier teacher chunks (already produced); never invent a parallel format. */
  teacherChunks: readonly string[];
  /**
   * `frontier` requires consent covering third-party processing.
   * Defaults to `local` (on-device / self-hosted teacher).
   */
  teacherMode?: TeacherMode;
  /** ISO-8601 pin for SESSION_START (determinism). */
  pinnedAt?: string;
  /**
   * When true (default), invoke tools via InProcessFakeToolRegistry sandbox
   * for registered tool names — same seam as student serving.
   */
  executeTools?: boolean;
  /** Optional pre-built registry; otherwise a default `lookup` tool is used. */
  toolRegistry?: InProcessFakeToolRegistry;
  onTelemetry?: (e: TeacherTraceTelemetry) => void;
};

export type TeacherTraceAccepted = {
  ok: true;
  subjectId: string;
  deviceId: string;
  turnId: string;
  correlationId: string;
  protocolVersion: typeof STREAMING_TURN_PROTOCOL_VERSION;
  frames: HarnessFrame[];
  canonicalFramesJson: string;
  toolCallIds: string[];
  toolResults: { toolCallId: string; status: "success" | "error" }[];
};

export type TeacherTraceRejected = {
  ok: false;
  subjectId: string | null;
  deviceId: string | null;
  turnId: string | null;
  failureClass: TeacherTraceFailureClass;
  dropReason?: TeacherTraceDropReason;
  detail: string;
};

export type GenerateTeacherTraceResult =
  | TeacherTraceAccepted
  | TeacherTraceRejected;

export type TeacherTraceDropCounts = Record<TeacherTraceDropReason, number>;

function emptyDropCounts(): TeacherTraceDropCounts {
  const counts = {} as TeacherTraceDropCounts;
  for (const r of TEACHER_TRACE_DROP_REASONS) {
    counts[r] = 0;
  }
  return counts;
}

function emit(
  onTelemetry: ((e: TeacherTraceTelemetry) => void) | undefined,
  partial: Omit<TeacherTraceTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "training.teacher_trace",
    ...partial,
  });
}

function defaultLookupRegistry(): InProcessFakeToolRegistry {
  const registry = new InProcessFakeToolRegistry();
  registry.register({
    descriptor: {
      name: "lookup",
      description: "Deterministic distillation lookup tool",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      riskClass: "read",
    },
    effect: (args) => {
      const query =
        typeof args === "object" &&
        args !== null &&
        "query" in args &&
        typeof (args as { query: unknown }).query === "string"
          ? (args as { query: string }).query
          : "";
      return { hit: query };
    },
  });
  return registry;
}

/**
 * Deterministic fake frontier teacher — hash-stable chunks, no network.
 * Used in tests / offline CI; production frontier providers plug the same
 * chunk contract into `generateTeacherTrace`.
 */
export function deterministicFakeTeacherChunks(seed: string): string[] {
  const digest = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 8);
  return [
    `<thought>distill seed ${digest}</thought>`,
    "```tool_call\n" +
      JSON.stringify({
        toolName: "lookup",
        arguments: { query: digest },
        callId: `c-${digest}`,
      }) +
      "\n```",
    `Teacher answer for ${digest}.`,
  ];
}

/**
 * Generate one teacher trace through the production harness turn loop.
 * Invalid protocol tags / tool envelopes → rejected with dropReason (never trained).
 */
export async function generateTeacherTrace(
  input: GenerateTeacherTraceInput,
): Promise<GenerateTeacherTraceResult> {
  const subjectId = input.subjectId?.trim() ?? "";
  const deviceId = input.deviceId?.trim() ?? "";
  const correlationId = input.correlationId?.trim() ?? "";
  const turnId = input.turnId?.trim() ?? "";
  const teacherMode: TeacherMode = input.teacherMode ?? "local";
  const executeTools = input.executeTools !== false;
  const pinnedAt = input.pinnedAt ?? "2026-07-16T00:00:00.000Z";

  const reject = (
    failureClass: TeacherTraceFailureClass,
    detail: string,
    dropReason?: TeacherTraceDropReason,
  ): TeacherTraceRejected => {
    emit(input.onTelemetry, {
      op: "drop",
      outcome: "error",
      subjectId: subjectId || "missing",
      deviceId: deviceId || "missing",
      failureClass,
      detail,
      ...(turnId ? { turnId } : {}),
      ...(dropReason !== undefined ? { dropReason } : {}),
    });
    return {
      ok: false,
      subjectId: subjectId || null,
      deviceId: deviceId || null,
      turnId: turnId || null,
      failureClass,
      detail,
      ...(dropReason !== undefined ? { dropReason } : {}),
    };
  };

  if (!subjectId) {
    return reject("missing_subject", "subjectId required", "missing_subject");
  }
  if (!deviceId || !correlationId || !turnId) {
    return reject("config", "deviceId, correlationId, and turnId are required", "config");
  }
  if (!input.consent?.optedIn) {
    return reject("config", "consent.optedIn must be true", "config");
  }
  if (!Array.isArray(input.teacherChunks) || input.teacherChunks.length < 1) {
    return reject("config", "teacherChunks must be a non-empty string[]", "config");
  }
  if (input.teacherChunks.length > TEACHER_CHUNK_LIMIT) {
    return reject(
      "size",
      `teacherChunks exceed ${TEACHER_CHUNK_LIMIT}`,
      "size",
    );
  }
  for (const chunk of input.teacherChunks) {
    if (typeof chunk !== "string") {
      return reject("config", "teacherChunks entries must be strings", "config");
    }
    if (Buffer.byteLength(chunk, "utf8") > TEACHER_CHUNK_BYTES_LIMIT) {
      return reject(
        "size",
        `chunk exceeds ${TEACHER_CHUNK_BYTES_LIMIT} bytes`,
        "size",
      );
    }
  }

  // Sovereignty: frontier teachers require consent covering third-party processing.
  if (teacherMode === "frontier") {
    if (!allowsThirdPartyProcessing(input.consent.consentClass)) {
      return reject(
        "third_party_excluded",
        `frontier teacher blocked for consentClass=${input.consent.consentClass}`,
        "third_party_excluded",
      );
    }
    // Refuse prompts that embed subject-identifying payload markers without
    // third-party coverage — personal is already excluded above; this catches
    // accidental subject-data injection into frontier prompts.
    const joined = input.teacherChunks.join("\n");
    if (/\bSUBJECT_RAW:/.test(joined)) {
      return reject(
        "subject_data_unconsented",
        "teacher prompt must not embed SUBJECT_RAW markers for frontier path",
        "subject_data_unconsented",
      );
    }
  }

  const frames: HarnessFrame[] = [];
  const toolCallIds: string[] = [];
  const toolResults: { toolCallId: string; status: "success" | "error" }[] = [];
  let pendingToolId: string | null = null;
  let dropReason: TeacherTraceDropReason | null = null;
  let dropDetail = "";

  const hostTelemetry = (e: StreamingTurnTelemetryEvent): void => {
    if (e.outcome === "rejected") {
      emit(input.onTelemetry, {
        op: "generate",
        outcome: "error",
        subjectId,
        deviceId,
        failureClass: "frame_emit",
        detail: e.failureClass ?? "host emit error",
        turnId,
      });
    }
  };

  const host = new StreamingTurnHost({
    subjectId,
    correlationId,
    deviceId,
    protocolVersion: STREAMING_TURN_PROTOCOL_VERSION,
    onFrame: (f) => {
      frames.push(f);
    },
    onTelemetry: hostTelemetry,
  });

  const session = host.emitSessionStart(pinnedAt);
  if (!session.ok) {
    return reject(
      "frame_emit",
      session.detail ?? "SESSION_START emit failed",
      "frame_emit",
    );
  }

  const registry = input.toolRegistry ?? defaultLookupRegistry();
  const seam = executeTools
    ? createSandboxSeam({
        registry,
        subjectId,
        deviceId,
      })
    : null;

  const parser = new ToolCallParser({
    subjectId,
    deviceId,
  });

  const markDrop = (reason: TeacherTraceDropReason, detail: string): void => {
    if (dropReason === null) {
      dropReason = reason;
      dropDetail = detail;
    }
  };

  const applyEvents = async (events: ParseEvent[]): Promise<boolean> => {
    for (const ev of events) {
      if (frames.length >= STREAMING_TURN_MAX_FRAMES) {
        markDrop("frame_budget", `frame budget ${STREAMING_TURN_MAX_FRAMES}`);
        return false;
      }
      if (ev.type === "mode_change" || ev.type === "tool_buffer_delta") {
        continue;
      }
      if (ev.type === "violation") {
        markDrop(
          "protocol_tag",
          `protocol tag / fence violation: ${ev.failureClass}`,
        );
        return false;
      }
      if (ev.type === "thought_delta") {
        const r = host.emitThoughtDelta(ev.delta);
        if (!r.ok) {
          markDrop("frame_emit", r.detail ?? "THOUGHT_DELTA emit failed");
          return false;
        }
        continue;
      }
      if (ev.type === "tool_buffer") {
        const parsed = parseToolCallEnvelopeJson(ev.body);
        if (!parsed.ok) {
          markDrop(
            "tool_envelope",
            `tool envelope rejected: ${parsed.error.code}`,
          );
          return false;
        }
        const first = parsed.envelope[0];
        const toolCallId =
          typeof first?.callId === "string" && first.callId.length > 0
            ? first.callId
            : "c1";
        const toolName =
          typeof first?.toolName === "string" ? first.toolName : "lookup";
        const args =
          first && typeof first.arguments === "object" && first.arguments !== null
            ? first.arguments
            : {};

        const running = host.emitToolStatus({
          toolCallId,
          status: "running",
        });
        if (!running.ok) {
          markDrop("frame_emit", running.detail ?? "TOOL_STATUS running failed");
          return false;
        }
        toolCallIds.push(toolCallId);
        pendingToolId = toolCallId;

        if (seam) {
          const descriptor = registry.get(toolName)?.descriptor;
          if (!descriptor) {
            markDrop(
              "tool_envelope",
              `unknown toolName=${toolName} (not in production registry)`,
            );
            return false;
          }
          const invoked = await seam.invoke(descriptor, args, {
            subjectId,
            deviceId,
            invocationId: toolCallId,
            deadlineMs: 2_000,
          });
          const status = invoked.ok ? "success" : "error";
          const done = host.emitToolStatus({
            toolCallId,
            status,
            ...(invoked.ok
              ? {}
              : {
                  detail: invoked.error.message.slice(0, 256),
                }),
          });
          if (!done.ok) {
            markDrop("frame_emit", done.detail ?? "TOOL_STATUS terminal failed");
            return false;
          }
          toolResults.push({ toolCallId, status });
          pendingToolId = null;
        }
        continue;
      }
      if (ev.type === "answer_delta") {
        if (pendingToolId) {
          const flush = host.emitToolStatus({
            toolCallId: pendingToolId,
            status: "success",
          });
          if (!flush.ok) {
            markDrop("frame_emit", flush.detail ?? "TOOL_STATUS success failed");
            return false;
          }
          toolResults.push({ toolCallId: pendingToolId, status: "success" });
          pendingToolId = null;
        }
        const r = host.emitAnswerDelta(ev.delta);
        if (!r.ok) {
          markDrop("frame_emit", r.detail ?? "ANSWER_DELTA emit failed");
          return false;
        }
      }
    }
    return true;
  };

  for (const chunk of input.teacherChunks) {
    const ok = await applyEvents(parser.feed(chunk));
    if (!ok) break;
  }
  if (dropReason === null) {
    const ok = await applyEvents(parser.end());
    if (!ok) {
      /* dropReason set */
    }
  }

  if (dropReason !== null) {
    return reject(dropReason, dropDetail, dropReason);
  }

  if (pendingToolId) {
    const flush = host.emitToolStatus({
      toolCallId: pendingToolId,
      status: "success",
    });
    if (!flush.ok) {
      return reject(
        "frame_emit",
        flush.detail ?? "TOOL_STATUS success failed",
        "frame_emit",
      );
    }
    toolResults.push({ toolCallId: pendingToolId, status: "success" });
  }

  const complete = host.emitTurnComplete(turnId);
  if (!complete.ok) {
    return reject(
      "frame_emit",
      complete.detail ?? "TURN_COMPLETE emit failed",
      "frame_emit",
    );
  }

  const sessionFrame = frames.find((f) => f.type === "SESSION_START");
  if (
    !sessionFrame ||
    sessionFrame.type !== "SESSION_START" ||
    sessionFrame.protocolVersion !== STREAMING_TURN_PROTOCOL_VERSION
  ) {
    return reject(
      "protocol_tag",
      "SESSION_START missing or protocolVersion mismatch",
      "protocol_tag",
    );
  }

  const canonicalFramesJson = canonicalizeFramesJson(frames);

  emit(input.onTelemetry, {
    op: "generate",
    outcome: "ok",
    subjectId,
    deviceId,
    turnId,
    frameCount: frames.length,
    protocolVersion: STREAMING_TURN_PROTOCOL_VERSION,
  });

  return {
    ok: true,
    subjectId,
    deviceId,
    turnId,
    correlationId,
    protocolVersion: STREAMING_TURN_PROTOCOL_VERSION,
    frames,
    canonicalFramesJson,
    toolCallIds,
    toolResults,
  };
}

/**
 * Batch generate with bounded size. Dropped candidates increment dropCounts
 * (reason codes) and are never included in `accepted`.
 */
export async function generateTeacherTraces(
  jobs: readonly GenerateTeacherTraceInput[],
  options: {
    onTelemetry?: (e: TeacherTraceTelemetry) => void;
  } = {},
): Promise<
  | {
      ok: true;
      accepted: TeacherTraceAccepted[];
      dropCounts: TeacherTraceDropCounts;
    }
  | {
      ok: false;
      failureClass: TeacherTraceFailureClass;
      detail: string;
      dropCounts: TeacherTraceDropCounts;
    }
> {
  const dropCounts = emptyDropCounts();
  if (!Array.isArray(jobs) || jobs.length < 1) {
    return {
      ok: false,
      failureClass: "empty_batch",
      detail: "jobs must be a non-empty array",
      dropCounts,
    };
  }
  if (jobs.length > TEACHER_TRACE_BATCH_LIMIT) {
    return {
      ok: false,
      failureClass: "size",
      detail: `jobs exceed ${TEACHER_TRACE_BATCH_LIMIT}`,
      dropCounts,
    };
  }

  const accepted: TeacherTraceAccepted[] = [];
  for (const job of jobs) {
    const result = await generateTeacherTrace({
      ...job,
      onTelemetry: (e) => {
        options.onTelemetry?.(e);
        job.onTelemetry?.(e);
      },
    });
    if (result.ok) {
      accepted.push(result);
    } else if (result.dropReason) {
      dropCounts[result.dropReason] += 1;
    } else if (
      (TEACHER_TRACE_DROP_REASONS as readonly string[]).includes(
        result.failureClass,
      )
    ) {
      dropCounts[result.failureClass as TeacherTraceDropReason] += 1;
    }
  }

  return { ok: true, accepted, dropCounts };
}

/** Grammar filter report schema (counts per violation class). */
export const GRAMMAR_FILTER_SCHEMA_VERSION =
  "training.distillation-grammar-filter.v1" as const;

/**
 * Violation classes counted in the grammar filter report.
 * Only these are distillation grammar failures — never trained on.
 */
export const GRAMMAR_VIOLATION_CLASSES = Object.freeze([
  "protocol_tag",
  "tool_envelope",
  "missing_required_tag",
] as const);

export type GrammarViolationClass = (typeof GRAMMAR_VIOLATION_CLASSES)[number];

/** Required frame types for an includable distillation candidate. */
export const DISTILLATION_REQUIRED_FRAME_TAGS = Object.freeze([
  "SESSION_START",
  "TURN_COMPLETE",
] as const);

export type GrammarFilterDroppedEntry = {
  turnId: string;
  subjectId: string;
  violationClass: GrammarViolationClass;
  detail: string;
};

export type GrammarFilterReport = {
  schemaVersion: typeof GRAMMAR_FILTER_SCHEMA_VERSION;
  subjectId: string;
  deviceId: string;
  scanned: number;
  accepted: number;
  dropped: number;
  counts: Record<GrammarViolationClass, number>;
  droppedEntries: GrammarFilterDroppedEntry[];
};

function emptyGrammarCounts(): Record<GrammarViolationClass, number> {
  return {
    protocol_tag: 0,
    tool_envelope: 0,
    missing_required_tag: 0,
  };
}

function isGrammarViolationClass(
  value: string,
): value is GrammarViolationClass {
  return (GRAMMAR_VIOLATION_CLASSES as readonly string[]).includes(value);
}

/**
 * Canonical JSON bytes for a grammar filter report (deterministic identity).
 */
export function canonicalGrammarFilterReportBytes(
  report: GrammarFilterReport,
): Buffer {
  const normalized: GrammarFilterReport = {
    schemaVersion: report.schemaVersion,
    subjectId: report.subjectId,
    deviceId: report.deviceId,
    scanned: report.scanned,
    accepted: report.accepted,
    dropped: report.dropped,
    counts: {
      protocol_tag: report.counts.protocol_tag,
      tool_envelope: report.counts.tool_envelope,
      missing_required_tag: report.counts.missing_required_tag,
    },
    droppedEntries: [...report.droppedEntries]
      .sort((a, b) => a.turnId.localeCompare(b.turnId))
      .map((e) => ({
        turnId: e.turnId,
        subjectId: e.subjectId,
        violationClass: e.violationClass,
        detail: e.detail,
      })),
  };
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

/**
 * Post-generation grammar gate on A P6 frames (student-identical contract).
 * Missing SESSION_START / TURN_COMPLETE / protocolVersion → missing_required_tag.
 * Wrong protocolVersion → protocol_tag.
 */
export function evaluateTeacherTraceGrammar(
  frames: readonly HarnessFrame[],
  options: {
    subjectId?: string;
    expectedProtocolVersion?: string;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      violationClass: GrammarViolationClass;
      detail: string;
    } {
  const expectedProtocol =
    options.expectedProtocolVersion ?? STREAMING_TURN_PROTOCOL_VERSION;
  const subjectId = options.subjectId?.trim();

  if (!Array.isArray(frames) || frames.length < 1) {
    return {
      ok: false,
      violationClass: "missing_required_tag",
      detail: "frames empty — missing SESSION_START and TURN_COMPLETE",
    };
  }

  const session = frames.find((f) => f.type === "SESSION_START");
  if (!session || session.type !== "SESSION_START") {
    return {
      ok: false,
      violationClass: "missing_required_tag",
      detail: "missing required tag SESSION_START",
    };
  }
  if (
    typeof session.protocolVersion !== "string" ||
    session.protocolVersion.length < 1
  ) {
    return {
      ok: false,
      violationClass: "missing_required_tag",
      detail: "SESSION_START missing protocolVersion tag",
    };
  }
  if (session.protocolVersion !== expectedProtocol) {
    return {
      ok: false,
      violationClass: "protocol_tag",
      detail: `protocolVersion mismatch: got ${session.protocolVersion} want ${expectedProtocol}`,
    };
  }

  const terminal = frames.find((f) => f.type === "TURN_COMPLETE");
  if (!terminal || terminal.type !== "TURN_COMPLETE") {
    return {
      ok: false,
      violationClass: "missing_required_tag",
      detail: "missing required tag TURN_COMPLETE",
    };
  }

  const hasTeachingContent = frames.some(
    (f) =>
      f.type === "THOUGHT_DELTA" ||
      f.type === "ANSWER_DELTA" ||
      f.type === "TOOL_STATUS",
  );
  if (!hasTeachingContent) {
    return {
      ok: false,
      violationClass: "missing_required_tag",
      detail:
        "missing teaching content tags (THOUGHT_DELTA|ANSWER_DELTA|TOOL_STATUS)",
    };
  }

  if (subjectId) {
    for (const frame of frames) {
      if (frame.subjectId !== subjectId) {
        return {
          ok: false,
          violationClass: "protocol_tag",
          detail: "frame subjectId mismatch (cross-subject)",
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Filter one already-assembled candidate (frames). Does not invent a parallel format.
 */
export function filterTeacherTraceCandidate(
  input: {
    turnId: string;
    subjectId: string;
    deviceId: string;
    frames: readonly HarnessFrame[];
  },
  options: {
    onTelemetry?: (e: TeacherTraceTelemetry) => void;
  } = {},
):
  | { ok: true; turnId: string }
  | {
      ok: false;
      turnId: string;
      violationClass: GrammarViolationClass;
      detail: string;
    } {
  const subjectId = input.subjectId.trim();
  const deviceId = input.deviceId.trim();
  const turnId = input.turnId.trim();
  const evaluated = evaluateTeacherTraceGrammar(input.frames, { subjectId });
  if (!evaluated.ok) {
    emit(options.onTelemetry, {
      op: "filter",
      outcome: "error",
      subjectId: subjectId || "missing",
      deviceId: deviceId || "missing",
      failureClass: evaluated.violationClass,
      dropReason: evaluated.violationClass,
      detail: evaluated.detail,
      ...(turnId ? { turnId } : {}),
    });
    return {
      ok: false,
      turnId,
      violationClass: evaluated.violationClass,
      detail: evaluated.detail,
    };
  }
  emit(options.onTelemetry, {
    op: "filter",
    outcome: "ok",
    subjectId,
    deviceId,
    turnId,
    frameCount: input.frames.length,
    protocolVersion: STREAMING_TURN_PROTOCOL_VERSION,
  });
  return { ok: true, turnId };
}

/**
 * Generate teacher traces then apply the grammar filter.
 * Emits a filter report with counts per violation class
 * (`protocol_tag` | `tool_envelope` | `missing_required_tag`).
 * Non-grammar drops (consent, config, …) are excluded from the report counts
 * but still remove the candidate from `accepted`.
 */
export async function filterDistillationCandidates(
  jobs: readonly GenerateTeacherTraceInput[],
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: TeacherTraceTelemetry) => void;
  } = {},
): Promise<
  | {
      ok: true;
      accepted: TeacherTraceAccepted[];
      report: GrammarFilterReport;
    }
  | {
      ok: false;
      failureClass: TeacherTraceFailureClass;
      detail: string;
      report: GrammarFilterReport;
    }
> {
  const subjectId =
    options.subjectId?.trim() ||
    jobs[0]?.subjectId?.trim() ||
    "subj.distill.filter";
  const deviceId =
    options.deviceId?.trim() ||
    jobs[0]?.deviceId?.trim() ||
    "dev-distill-filter";

  const counts = emptyGrammarCounts();
  const droppedEntries: GrammarFilterDroppedEntry[] = [];
  const accepted: TeacherTraceAccepted[] = [];

  const emptyReport = (): GrammarFilterReport => ({
    schemaVersion: GRAMMAR_FILTER_SCHEMA_VERSION,
    subjectId,
    deviceId,
    scanned: 0,
    accepted: 0,
    dropped: 0,
    counts: { ...counts },
    droppedEntries: [],
  });

  if (!Array.isArray(jobs) || jobs.length < 1) {
    emit(options.onTelemetry, {
      op: "filter",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "empty_batch",
      detail: "jobs must be a non-empty array",
    });
    return {
      ok: false,
      failureClass: "empty_batch",
      detail: "jobs must be a non-empty array",
      report: emptyReport(),
    };
  }
  if (jobs.length > TEACHER_TRACE_BATCH_LIMIT) {
    return {
      ok: false,
      failureClass: "size",
      detail: `jobs exceed ${TEACHER_TRACE_BATCH_LIMIT}`,
      report: emptyReport(),
    };
  }

  emit(options.onTelemetry, {
    op: "filter",
    outcome: "ok",
    subjectId,
    deviceId,
    detail: "filter_start",
    scanned: jobs.length,
  });

  for (const job of jobs) {
    const generated = await generateTeacherTrace({
      ...job,
      onTelemetry: (e) => {
        options.onTelemetry?.(e);
        job.onTelemetry?.(e);
      },
    });

    if (!generated.ok) {
      const turnId = generated.turnId ?? job.turnId;
      const classCandidate = generated.dropReason ?? generated.failureClass;
      if (isGrammarViolationClass(classCandidate)) {
        counts[classCandidate] += 1;
        droppedEntries.push({
          turnId,
          subjectId: generated.subjectId ?? job.subjectId,
          violationClass: classCandidate,
          detail: generated.detail,
        });
        emit(options.onTelemetry, {
          op: "filter",
          outcome: "error",
          subjectId: generated.subjectId ?? subjectId,
          deviceId: generated.deviceId ?? deviceId,
          failureClass: classCandidate,
          dropReason: classCandidate,
          detail: generated.detail,
          turnId,
        });
      }
      continue;
    }

    const grammar = evaluateTeacherTraceGrammar(generated.frames, {
      subjectId: generated.subjectId,
    });
    if (!grammar.ok) {
      counts[grammar.violationClass] += 1;
      droppedEntries.push({
        turnId: generated.turnId,
        subjectId: generated.subjectId,
        violationClass: grammar.violationClass,
        detail: grammar.detail,
      });
      emit(options.onTelemetry, {
        op: "filter",
        outcome: "error",
        subjectId: generated.subjectId,
        deviceId: generated.deviceId,
        failureClass: grammar.violationClass,
        dropReason: grammar.violationClass,
        detail: grammar.detail,
        turnId: generated.turnId,
      });
      continue;
    }

    accepted.push(generated);
  }

  const report: GrammarFilterReport = {
    schemaVersion: GRAMMAR_FILTER_SCHEMA_VERSION,
    subjectId,
    deviceId,
    scanned: jobs.length,
    accepted: accepted.length,
    dropped: droppedEntries.length,
    counts,
    droppedEntries: [...droppedEntries].sort((a, b) =>
      a.turnId.localeCompare(b.turnId),
    ),
  };

  emit(options.onTelemetry, {
    op: "filter",
    outcome: "ok",
    subjectId,
    deviceId,
    detail: "filter_complete",
    scanned: report.scanned,
    accepted: report.accepted,
    dropped: report.dropped,
  });

  return { ok: true, accepted, report };
}

/** Default C0 baseline registry pin (repo-relative). */
export const DISTILLATION_BASELINE_REGISTRY_RELPATH =
  "training/eval/baseline_registry.json" as const;

export const DISTILLATION_DEFAULT_LICENSE_ID = "lic.cc-by-4.0" as const;
export const DISTILLATION_DEFAULT_LANE = "teacher" as const;

export { CORPUS_MANIFEST_SCHEMA_VERSION };

export type VersionDistillationManifestInput = {
  /** Teacher jobs — grammar-filtered before export. */
  jobs: readonly GenerateTeacherTraceInput[];
  manifestId: string;
  version: string;
  title?: string;
  /**
   * Corpus-factory consent class on the manifest (shard inclusion law).
   * Frontier / third-party teacher path forbids `government`.
   */
  consentClass: CorpusShardConsentClass;
  /** Directory to write manifest + shards (created if missing). */
  outDir: string;
  subjectId?: string;
  deviceId?: string;
  licenseId?: string;
  laneCode?: string;
  /** Repo-relative baseline registry path for decontam. */
  baselineRegistryRelpath?: string;
  /** Absolute package root (defaults to distillation package). */
  packageRoot?: string;
  /**
   * Declare third-party frontier teacher processing on the export.
   * Also inferred when any job has teacherMode === "frontier".
   */
  requiresThirdPartyProcessing?: boolean;
  /**
   * Probe hook: replace natural content hashes (test / red fixtures only).
   * Keys are turnId.
   */
  contentHashOverrides?: Readonly<Record<string, string>>;
  onTelemetry?: (e: TeacherTraceTelemetry) => void;
};

export type DistillationCorpusExportOk = {
  ok: true;
  manifestPath: string;
  manifestRelpath: string;
  manifestId: string;
  version: string;
  consentClass: CorpusShardConsentClass;
  shardCount: number;
  contentHashes: string[];
  grammarReport: GrammarFilterReport;
  decontam: {
    status: "passed";
    baselineRegistryRelpath: string;
    checkedHashCount: number;
    registryHashCount: number;
  };
  requiresThirdPartyProcessing: boolean;
};

export type DistillationCorpusExportFail = {
  ok: false;
  failureClass: TeacherTraceFailureClass;
  detail: string;
  subjectId: string;
  deviceId: string;
};

function sha256PrefixedBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function resolveDistillationRepoRoot(packageRoot: string): string {
  return path.resolve(packageRoot, "..", "..");
}

function isCorpusShardConsentClass(
  value: string,
): value is CorpusShardConsentClass {
  return (
    value === "consented" ||
    value === "public" ||
    value === "synthetic" ||
    value === "government"
  );
}

function allowsThirdPartyShardConsent(
  consentClass: CorpusShardConsentClass,
): boolean {
  return (THIRD_PARTY_ELIGIBLE_SHARD_CLASSES as readonly string[]).includes(
    consentClass,
  );
}

/**
 * Filter teacher traces, write content-addressed shards, and emit a
 * corpus-compatible versioned manifest (`training.corpus-manifest.v1`).
 * Decontaminates shard hashes against the C0 baseline registry.
 * Frontier / third-party teachers require an eligible shard consent class.
 */
export async function versionDistillationSetAsCorpusManifest(
  input: VersionDistillationManifestInput,
): Promise<DistillationCorpusExportOk | DistillationCorpusExportFail> {
  const packageRoot = input.packageRoot ?? DISTILLATION_PACKAGE_ROOT;
  const subjectId = input.subjectId?.trim() || "subj.distill.manifest";
  const deviceId = input.deviceId?.trim() || "dev-distill-manifest";
  const manifestId = input.manifestId?.trim() ?? "";
  const version = input.version?.trim() ?? "";
  const outDir = path.resolve(input.outDir);
  const licenseId = input.licenseId?.trim() || DISTILLATION_DEFAULT_LICENSE_ID;
  const laneCode = input.laneCode?.trim() || DISTILLATION_DEFAULT_LANE;
  const baselineRegistryRelpath =
    input.baselineRegistryRelpath?.trim() ||
    DISTILLATION_BASELINE_REGISTRY_RELPATH;

  const fail = (
    failureClass: TeacherTraceFailureClass,
    detail: string,
  ): DistillationCorpusExportFail => {
    emit(input.onTelemetry, {
      op: "export",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass,
      detail,
      ...(manifestId ? { manifestId } : {}),
    });
    return { ok: false, failureClass, detail, subjectId, deviceId };
  };

  if (!manifestId || !version) {
    return fail("config", "manifestId and version are required");
  }
  if (!isCorpusShardConsentClass(input.consentClass)) {
    return fail("consent", "consentClass must be a corpus shard consent class");
  }
  if (!input.outDir?.trim()) {
    return fail("config", "outDir is required");
  }

  const requiresThirdParty =
    input.requiresThirdPartyProcessing === true ||
    input.jobs.some((j) => (j.teacherMode ?? "local") === "frontier");

  if (requiresThirdParty && !allowsThirdPartyShardConsent(input.consentClass)) {
    return fail(
      "third_party_excluded",
      `third-party teacher distillation excludes consentClass=${input.consentClass}`,
    );
  }

  const filtered = await filterDistillationCandidates(input.jobs, {
    subjectId,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!filtered.ok) {
    return fail(filtered.failureClass, filtered.detail);
  }
  if (filtered.accepted.length < 1) {
    return fail(
      "config",
      "no accepted traces after grammar filter — nothing to version",
    );
  }

  mkdirSync(path.join(outDir, "shards"), { recursive: true });

  const sources: {
    sourceId: string;
    relpath: string;
    licenseId: string;
    knowledgeMode: "UND";
    laneCode: string;
    contentHash: string;
  }[] = [];
  const decontamDocs: { docId: string; contentHash: string }[] = [];
  const contentHashes: string[] = [];

  const sortedAccepted = [...filtered.accepted].sort((a, b) =>
    a.turnId.localeCompare(b.turnId),
  );

  for (const trace of sortedAccepted) {
    const naturalHash = sha256PrefixedBytes(
      Buffer.from(trace.canonicalFramesJson, "utf8"),
    );
    const contentHash =
      input.contentHashOverrides?.[trace.turnId] ?? naturalHash;
    const shardRelpath = `shards/${trace.turnId}.json`;
    const shardPath = path.join(outDir, shardRelpath);
    const shardDoc = {
      schemaVersion: "training.distillation-shard.v1",
      turnId: trace.turnId,
      subjectId: trace.subjectId,
      deviceId: trace.deviceId,
      correlationId: trace.correlationId,
      protocolVersion: trace.protocolVersion,
      contentHash,
      frameCount: trace.frames.length,
      toolCallIds: trace.toolCallIds,
      // Frames are the production harness stream (anti-cheat identity).
      frames: trace.frames,
    };
    writeFileSync(
      shardPath,
      `${JSON.stringify(shardDoc, null, 2)}\n`,
      "utf8",
    );

    const sourceId = `src.distill.${trace.turnId}`;
    sources.push({
      sourceId,
      relpath: shardRelpath,
      licenseId,
      knowledgeMode: "UND",
      laneCode,
      contentHash,
    });
    decontamDocs.push({ docId: sourceId, contentHash });
    contentHashes.push(contentHash);
  }

  const repoRoot = resolveDistillationRepoRoot(packageRoot);
  const registryPath = path.resolve(repoRoot, baselineRegistryRelpath);
  if (!existsSync(registryPath)) {
    return fail(
      "config",
      `baseline registry missing: ${baselineRegistryRelpath}`,
    );
  }

  const registry = loadBaselineRegistryDocumentFromFile(registryPath, {
    deviceId,
  });
  if (!registry.ok) {
    return fail("config", `baseline registry load failed: ${registry.detail}`);
  }

  const decontam = assertCorpusDocumentsExactHashDecontaminated(
    registry.document,
    decontamDocs,
    { deviceId },
  );
  if (!decontam.ok) {
    return fail(
      "contamination",
      `eval overlap / decontam failed: ${decontam.detail} (docs=${decontam.offendingDocIds.join(",")})`,
    );
  }

  const manifestDraft = {
    schemaVersion: CORPUS_MANIFEST_SCHEMA_VERSION,
    manifestId,
    version,
    ...(input.title !== undefined ? { title: input.title } : {}),
    consentClass: input.consentClass,
    laneCodes: [laneCode],
    knowledgeModes: ["UND"] as const,
    sources: sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    filters: [
      {
        filterId: "flt.exclude-unknown-license",
        kind: "exclude_unknown_license",
      },
      {
        filterId: "flt.exclude-eval-overlap",
        kind: "exclude_eval_overlap",
      },
    ],
    dedupReport: {
      status: "pending" as const,
      algorithm: "sha256" as const,
    },
    licenseLedger: [
      {
        licenseId,
        spdxOrLabel: "CC-BY-4.0",
        licenseClass: "open" as const,
      },
    ],
    weightTrainingPolicy: {
      excludeKnowledgeModes: ["RET"] as const,
      requireKnownLicense: true as const,
    },
    determinism: {
      canonicalSort: true as const,
      contentAddressedShards: true as const,
      forbidWallClockInShardBytes: true as const,
    },
    decontaminationProof: {
      status: "recorded" as const,
      baselineRegistryRelpath,
    },
  };

  const parsed = parseCorpusManifest(manifestDraft, {
    subjectId,
    deviceId,
  });
  if (!parsed.ok) {
    return fail("config", `corpus manifest invalid: ${parsed.message}`);
  }

  const manifestRelpath = "manifest.json";
  const manifestPath = path.join(outDir, manifestRelpath);
  const written = writeCorpusManifest(manifestPath, parsed.value, {
    subjectId,
    deviceId,
  });
  if (!written.ok) {
    return fail("config", `corpus manifest write failed: ${written.message}`);
  }

  const filterReportPath = path.join(outDir, "grammar-filter-report.json");
  writeFileSync(
    filterReportPath,
    canonicalGrammarFilterReportBytes(filtered.report),
  );

  emit(input.onTelemetry, {
    op: "export",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId,
    accepted: sortedAccepted.length,
    detail: `decontam_passed checked=${decontam.checkedHashCount}`,
  });

  return {
    ok: true,
    manifestPath,
    manifestRelpath,
    manifestId,
    version,
    consentClass: input.consentClass,
    shardCount: sortedAccepted.length,
    contentHashes: [...contentHashes].sort(),
    grammarReport: filtered.report,
    decontam: {
      status: "passed",
      baselineRegistryRelpath,
      checkedHashCount: decontam.checkedHashCount,
      registryHashCount: decontam.registryHashCount,
    },
    requiresThirdPartyProcessing: requiresThirdParty,
  };
}
